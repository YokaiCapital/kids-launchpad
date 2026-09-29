import {createSignerRpcChannel} from '../signer/rpc-admission.mjs';
// Actual remote signer/HTTP/outbox/cost-ledger qualification, on owned localnet
// only. Initializes one test campaign's fees and qualifies private activation;
// hosted workers and production policy remain disabled.
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {Connection,Keypair,PublicKey} from '@solana/web3.js';
import pg from 'pg';
import {PostgresRegistry} from '../registry/registry.mjs';
import {buildOperatingFundingPacket} from './operating-proofs.mjs';
import {createOperatingSignerBudget} from '../signer/operating-budget.mjs';
import {createStandardOperatingCostReader} from '../signer/standard-cost-reader.mjs';
import {createPublicWorker} from '../jobs/service.mjs';
import {feeSetupInstructions} from './operating-costs.mjs';
import {createRegistrySignerService} from '../signer/registry-service.mjs';
import {createRemoteSigner} from '../operator-signer.mjs';
import {createDurableSender} from '../protocol-v2/durable-send.mjs';
import {decodeCampaign,decodeFeeState,feeStateAddress} from '../protocol-v2/client.mjs';
import {encodeBase58} from '../../shared/solana.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export async function qualifyOperatingSigner({postgresUrl,campaign}){
 if(!postgresUrl||!campaign)throw Error('Explicit local database and owned test campaign required');
 const m=JSON.parse(readFileSync(new URL('../.runtime/kids-launch-v3-program.json',import.meta.url),'utf8'));
 if(m.network!=='localnet'||m.programVersion!==3||m.rpcUrl!=='http://127.0.0.1:19199')throw Error('Owned isolated v3 validator required');
 const c=new Connection(m.rpcUrl,'finalized');assert.equal(await c.getGenesisHash(),m.genesisHash);
 const program=await c.getAccountInfo(new PublicKey(m.programId),'finalized');assert.equal(program.executable,true);assert.equal(program.data.readUInt32LE(0),2);
 const binary=await c.getAccountInfo(new PublicKey(program.data.subarray(4,36)),'finalized');assert.equal(createHash('sha256').update(binary.data.subarray(45,45+m.binarySize)).digest('hex'),m.sha256);
 const campaignAccount=await c.getAccountInfo(new PublicKey(campaign),'finalized');assert.equal(String(campaignAccount.owner),m.programId);const campaignState=decodeCampaign(campaignAccount.data);assert.equal(campaignState.state.phase,3);assert.equal(String(campaignState.terms.creator),m.pilotCreator);assert.equal(String(campaignState.terms.treasury),m.treasury);
 const feeAddress=feeStateAddress(m.programId,campaign);assert.equal(await c.getAccountInfo(feeAddress,'finalized'),null,'Owned fixture fee state must be uninitialized');
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:postgresUrl,max:1}),directory=mkdtempSync(join(tmpdir(),'kids-operating-signer-'));let pool,creator,payer,service,accounting,provisioning;const feeWorkers=[];
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:postgresUrl,max:4,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  creator=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(m.adminKeyFile,'utf8'))));payer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(m.treasuryKeyFile,'utf8'))));assert.equal(String(creator.publicKey),m.pilotCreator);assert.equal(String(payer.publicKey),m.treasury);
  const base={genesisHash:m.genesisHash,programId:m.programId,campaign,payer:m.treasury,policy:'local-signer-funding-qualification'};await registry.campaigns.upsert({...base,mode:'standard',campaignVersion:3,registryStatus:'planned',network:'localnet',termsHash:campaignState.state.termsHash});
  const block=await c.getLatestBlockhash('confirmed'),fundingIntent={...base,creator:m.pilotCreator,lamports:'12000000'},fundingTx=buildOperatingFundingPacket(fundingIntent,block);fundingTx.sign([creator]);
  const funding={binding:fundingIntent,block,signature:encodeBase58(fundingTx.signatures[0]),transactionBase64:Buffer.from(fundingTx.serialize()).toString('base64')},rent=await c.getMinimumBalanceForRentExemption(160,'finalized');
  writeFileSync(join(directory,'funding-packet.json'),JSON.stringify(funding),{mode:0o600,flag:'wx'});
  const setupIxs=feeSetupInstructions({programId:m.programId,campaign,payer:m.treasury,operator:m.pilotCreator,terms:campaignState.terms});
  const ataRent=await c.getMinimumBalanceForRentExemption(165,'finalized'),setupAccounts=await c.getMultipleAccountsInfo(setupIxs.slice(0,-1).map(ix=>ix.keys[1].pubkey),'finalized');
  const expectedRent=rent+setupAccounts.filter(x=>x===null).length*ataRent,maximumRent=rent+(setupIxs.length-1)*ataRent;
  const signerRpc=createSignerRpcChannel({registry,connection:c,resource:'qualification-signer-rpc',ratePerSecond:30,burst:30});
  const openBudget=()=>createOperatingSignerBudget({registry,connection:signerRpc.connection,...base,loadFundingPacket:async()=>funding,loadCostIntent:createStandardOperatingCostReader({connection:signerRpc.connection,...base,feeOperator:m.pilotCreator})});
  let budget=openBudget();
  const token=randomBytes(32).toString('hex');service=await createRegistrySignerService({registry,connection:c,admitRpc:signerRpc.admit,...base,programVersion:3,keypair:payer,token,stateFile:join(directory,'signer-state.json'),operatingBudget:{reserve:x=>budget.reserve(x),recordSignature:(...x)=>budget.recordSignature(...x)}});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  const keeper=createRemoteSigner({url:'http://127.0.0.1:'+service.server.address().port,token,publicKey:payer.publicKey});
  await registry.capabilities.grant({...base,programVersion:3,kind:'fee-setup',recipients:[...new Set([m.treasury,String(campaignState.terms.dev)])],tags:[20],expiresAt:new Date(Date.now()+600000).toISOString()});
  const job=(await registry.jobs.enqueue({...base,jobClass:'fee-harvest',operationKey:'fee-init'})).job;await registry.jobs.leaseById({jobId:job.jobId,token:0,owner:'local-qualification',ttlMs:180000});
  let interrupted=false;const calls={sent:0,confirmed:0,unknown:0};
  const makeSender=checkpoint=>createDurableSender({connection:c,keeper,journal:registry.operatorPackets,genesisHash:m.genesisHash,programId:m.programId,commitment:'finalized',calls,checkpoint});
  const ix=setupIxs,options={operationId:'qualified-fee-state',campaign,operationKey:'fee-init',fencingToken:1,computeUnits:400000};
  await assert.rejects(makeSender()(ix,options),/operating budget not available/);assert.equal(calls.sent,0);
  await c.sendRawTransaction(fundingTx.serialize(),{maxRetries:2,preflightCommitment:'confirmed'});
  const until=Date.now()+120000;while(Date.now()<until){const s=(await c.getSignatureStatuses([funding.signature],{searchTransactionHistory:true})).value[0];if(s?.confirmationStatus==='finalized'){assert.equal(s.err,null);break;}await pause(400);}
  await budget.credit({...base,signature:funding.signature});
  await assert.rejects(makeSender(async stage=>{if(stage==='signed'){interrupted=true;throw Error('local interruption after durable signature');}})(ix,options),/local interruption/);assert.equal(interrupted,true);assert.equal(calls.sent,0);
  budget=openBudget();const signed=(await registry.query("SELECT descriptor FROM operator_packets WHERE signed_base64 IS NOT NULL")).rows.map(r=>JSON.parse(r.descriptor)).find(x=>x.binding?.policy===base.policy);assert.ok(signed);
  const accountingConfig={mode:'localnet-rehearsal',lane:'accounting',programVersion:3,genesisHash:m.genesisHash,programId:m.programId,rpcUrl:m.rpcUrl,concurrency:2,operating:{payer:base.payer,policy:base.policy},rpcAdmission:{resource:'qualification-rpc',policy:{ratePerSecond:100,burst:100,lanes:{accounting:{ratePerSecond:100,burst:100}}}}};
  accounting=await createPublicWorker({registry,config:accountingConfig});assert.equal((await accounting.tick()).leased,1);
  const queued=(await registry.jobs.listForCampaign(base)).find(x=>x.jobClass==='operating-reconcile');assert.equal(queued.result.category,'operating-awaiting-finality');
  await accounting.stop();accounting=null;const hold=await budget.balance(base);assert.equal(hold.heldLamports,String(maximumRent+5000));
  const resumed=await makeSender()(ix,options);assert.equal(resumed.status,'confirmed');assert.equal(calls.sent,1);
  accounting=await createPublicWorker({registry,config:accountingConfig});
  const reconcileUntil=Date.now()+30000;while(Date.now()<reconcileUntil){await accounting.tick();if((await budget.balance(base)).heldLamports==='0')break;await pause(250);}
  const completed=(await registry.jobs.listForCampaign(base)).find(x=>x.jobClass==='operating-reconcile');assert.equal(completed.state,'done');assert.equal(completed.result.actualLamports,String(expectedRent+5000));assert.equal((await accounting.tick()).leased,0);
  assert.equal((await makeSender()(ix,options)).signature,resumed.signature);assert.equal(calls.sent,1,'Completed duplicate cannot rebroadcast');
  const state=decodeFeeState((await c.getAccountInfo(feeAddress,'finalized')).data,campaign);assert.equal(String(state.operator),m.pilotCreator);
  const setupJob=(await registry.jobs.enqueue({...base,jobClass:'fee-setup',operationKey:'fee-setup'})).job;
  const provisioningPolicy={ratePerSecond:100,burst:100,lanes:{provisioning:{ratePerSecond:100,burst:100}}};
  provisioning=await createPublicWorker({registry,config:{mode:'localnet-rehearsal',lane:'provisioning',programVersion:3,genesisHash:m.genesisHash,programId:m.programId,rpcUrl:m.rpcUrl,concurrency:1,feeOperator:m.pilotCreator,feeActivation:{policy:base.policy,minimumReserveLamports:'100000'},signer:{url:'http://127.0.0.1:'+service.server.address().port,token,publicKey:m.treasury},rpcAdmission:{resource:'qualification-provisioning-rpc',policy:provisioningPolicy},signerAdmission:{resource:'qualification-provisioning-signer',policy:provisioningPolicy}}});
  assert.equal((await provisioning.tick()).leased,1);const setupResult=await registry.jobs.get(setupJob.jobId);assert.equal(setupResult.state,'done',JSON.stringify(setupResult.result));assert.equal(setupResult.result.verified,true);assert.equal(setupResult.result.accounts,setupIxs.length-1);assert.equal(calls.sent,1);
  assert.equal((await provisioning.tick()).leased,1);
  const activation=(await registry.jobs.listForCampaign(base)).find(x=>x.jobClass==='fee-activate');assert.equal(activation.state,'done',JSON.stringify(activation.result));
  const activeGrant=await registry.capabilities.latest(base);assert.deepEqual(activeGrant.tags,[3,21,23,26]);assert.equal(activeGrant.kind,'keeper');
  const initialFeeJobs=(await registry.jobs.listForCampaign(base)).filter(x=>['fee-harvest','distribution','token-burn'].includes(x.jobClass)&&x.operationKey===x.jobClass+':0');assert.equal(initialFeeJobs.length,3);assert.ok(initialFeeJobs.every(x=>x.state==='queued'));
  assert.equal((await provisioning.tick()).leased,0,'Provisioning cannot execute fee chains');
  const workerPolicy={ratePerSecond:100,burst:100,lanes:{harvest:{ratePerSecond:30,burst:30},economics:{ratePerSecond:40,burst:40},recovery:{ratePerSecond:30,burst:30}}};
  const makeWorker=async lane=>{const worker=await createPublicWorker({registry,config:{mode:'localnet-rehearsal',lane,programVersion:3,genesisHash:m.genesisHash,programId:m.programId,rpcUrl:m.rpcUrl,concurrency:2,signer:{url:'http://127.0.0.1:'+service.server.address().port,token,publicKey:m.treasury},rpcAdmission:{resource:'qualification-active-rpc',policy:workerPolicy},signerAdmission:{resource:'qualification-active-signer',policy:workerPolicy}}});feeWorkers.push(worker);return worker;};
  const harvest=await makeWorker('harvest'),economics=await makeWorker('economics');
  await Promise.all([harvest.tick(),economics.tick()]);
  for(const initial of initialFeeJobs){const done=await registry.jobs.get(initial.jobId);assert.equal(done.state,'done',JSON.stringify(done.result));assert.equal(done.result.status,'deferred','Fresh pool fees should accumulate without dust transactions');}
  const refundJob=(await registry.jobs.enqueue({...base,jobClass:'refunds',operationKey:'refunds'})).job;
  const recovery=await makeWorker('recovery');await recovery.tick();
  const refunded=await registry.jobs.get(refundJob.jobId);assert.equal(refunded.state,'done',JSON.stringify(refunded.result));
  const refundUntil=Date.now()+60000;while(Date.now()<refundUntil){await accounting.tick();if((await budget.balance(base)).heldLamports==='0')break;await pause(500);}
  const afterRefund=decodeCampaign((await c.getAccountInfo(new PublicKey(campaign),'finalized')).data);
  assert.equal(afterRefund.state.refunded,1000000000n,'Excess SOL delivered to the original participant after fee activation');

  const balance=await budget.balance(base);assert.equal(balance.spentLamports,String(expectedRent+10000));assert.equal(balance.heldLamports,'0');assert.equal(balance.availableLamports,String(12000000-expectedRent-10000));
  const report={network:'localnet',campaign,fundingSignature:funding.signature,spendSignature:resumed.signature,unfundedRefused:true,signatureSavedBeforeResponse:true,postSignatureRecovery:true,sentOnce:true,chainDerivedCostTemplate:true,feeSetupAccounts:setupIxs.length-1,provisioningWorkerVerified:true,automaticFeeActivation:true,independentFeeJobsSeeded:3,activationPreservesRefunds:true,feeWorkersExecuted:true,dustSendsAvoided:true,refundedLamports:String(afterRefund.state.refunded),automaticReconciliation:true,accountingRestartRecovery:true,accountingNeedsSigner:false,...balance,workerActivation:false,directory};writeFileSync(join(directory,'report.json'),JSON.stringify(report),{mode:0o600,flag:'wx'});return report;
 }finally{await Promise.all(feeWorkers.map(worker=>worker.stop()));await provisioning?.stop();await accounting?.stop();if(service?.server.listening)await service.close();creator?.secretKey.fill(0);payer?.secretKey.fill(0);if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)qualifyOperatingSigner({postgresUrl:process.env.KIDS_TEST_POSTGRES_URL,campaign:process.env.KIDS_TEST_SIGNER_CAMPAIGN}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.stack);process.exitCode=1;});
