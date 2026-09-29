import {createSignerRpcChannel} from '../signer/rpc-admission.mjs';
// Joined local-chain lifecycle qualification. Own validator, disposable DB, local
// test wallets only. No hosted configuration or production program is touched.
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';import pg from 'pg';
import {Connection,PublicKey,Keypair,Transaction,SystemProgram,SYSVAR_CLOCK_PUBKEY,sendAndConfirmTransaction} from '@solana/web3.js';
import {createMint,getOrCreateAssociatedTokenAccount,NATIVE_MINT,mintTo,setAuthority,AuthorityType,createBurnInstruction,createSyncNativeInstruction,getAccount} from '@solana/spl-token';
import {returnSetupInstruction} from '../protocol-v3/client.mjs';
import * as client from '../protocol-v2/client.mjs';import * as policy from '../protocol-v2/policy.mjs';
import {PostgresRegistry} from '../registry/registry.mjs';
import {createPublicWorker} from '../jobs/service.mjs';
import {createRegistrySignerService} from '../signer/registry-service.mjs';
import {createOperatingSignerBudget} from '../signer/operating-budget.mjs';
import {createStandardOperatingCostReader} from '../signer/standard-cost-reader.mjs';
import {buildOperatingFundingPacket} from './operating-proofs.mjs';
import {encodeBase58} from '../../shared/solana.mjs';
import {createChainAdapter} from '../protocol-v2/chain-adapter.mjs';
import {withLiveVerification} from '../protocol-v3/live-verification.mjs';
import {poolAddresses,swapInstruction} from '../cpmm.mjs';
import {createPublicMarketWorker} from '../market/public-service.mjs';
import {createPublicMarketReader} from '../market/public-reader.mjs';
import {createPublicActivityStore} from '../market/public-activity-store.mjs';
import {createPublicActivityReader} from '../market/public-activity-reader.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export async function qualifyLifecycle({postgresUrl,log=()=>{},scale=false}){
 if(!postgresUrl)throw Error('Explicit local test database required');
 const m=JSON.parse(readFileSync(new URL(scale?'../.runtime/kids-scale-v3-program.json':'../.runtime/kids-launch-v3-program.json',import.meta.url),'utf8'));
 if(m.network!=='localnet'||m.programVersion!==3||m.rpcUrl!==(scale?'http://127.0.0.1:19499':'http://127.0.0.1:19199')||scale&&m.scaleQualification!==true)throw Error('Owned isolated v3 validator required');
 const c=new Connection(m.rpcUrl,'finalized');assert.equal(await c.getGenesisHash(),m.genesisHash);
 const program=await c.getAccountInfo(new PublicKey(m.programId),'finalized');assert.equal(program.executable,true);assert.equal(program.data.readUInt32LE(0),2);
 const binary=await c.getAccountInfo(new PublicKey(program.data.subarray(4,36)),'finalized');assert.equal(createHash('sha256').update(binary.data.subarray(45,45+m.binarySize)).digest('hex'),m.sha256);
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:postgresUrl,max:1}),directory=mkdtempSync(join(tmpdir(),'kids-lifecycle-'));let pool,creator,payer,service;const workers=[];
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:postgresUrl,max:8,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  creator=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(m.adminKeyFile,'utf8'))));payer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(m.treasuryKeyFile,'utf8'))));
  assert.equal(String(creator.publicKey),m.pilotCreator);assert.equal(String(payer.publicKey),m.treasury);
  const send=instructions=>sendAndConfirmTransaction(c,new Transaction().add(...instructions),[creator],{commitment:'finalized'});
  // Scheduling uses the current confirmed chain clock; finalized clock can lag
  // beyond the program's opening tolerance on a loaded local validator.
  const time=async()=> (await c.getAccountInfo(SYSVAR_CLOCK_PUBKEY,'confirmed')).data.readBigInt64LE(32);
  const nonce=randomBytes(8).readBigUInt64LE(),campaign=client.campaignAddress(m.programId,creator.publicKey,nonce),authority=client.launchAuthority(m.programId,campaign);
  assert.equal(await c.getAccountInfo(campaign),null);
  const mint=await createMint(c,creator,creator.publicKey,creator.publicKey,6),custody=await getOrCreateAssociatedTokenAccount(c,creator,mint,authority,true);
  await getOrCreateAssociatedTokenAccount(c,creator,NATIVE_MINT,authority,true);
  const supply=1000000000000000n;await mintTo(c,creator,mint,custody.address,creator,supply);
  await setAuthority(c,creator,mint,creator,AuthorityType.MintTokens,authority);await setAuthority(c,creator,mint,creator,AuthorityType.FreezeAccount,authority);
  const now=await time(),tier=client.AMM_CONFIG_TIERS[scale?1:0],terms={layoutVersion:2,mode:0,decimals:6,splitPolicy:policy.SPLIT_POLICY_STANDARD_V3,vestingRule:policy.VESTING_RULE_STANDARD_V3,feeRoutingVersion:1,creatorFeeEnabled:0,genesis:new PublicKey(m.genesisHash),creator:creator.publicKey,nonce,dev:creator.publicKey,treasury:payer.publicKey,childMint:mint,supply,
   opensAt:now-1n,deadline:now+180n,launchDeadline:now+3750n,soft:500000000n,hard:1000000000n,ammProgram:client.RAYDIUM_CPMM,ammConfig:tier.address,ammTradeFeeRate:tier.tradeFeeRate,ammConfigIndex:tier.index,feeWeights:policy.FEE_WEIGHTS_STANDARD,splitBps:policy.SPLIT_STANDARD_V3,vesting:policy.VESTING_STANDARD_V3,buybackMaxSlippageBps:0,lockProgram:client.RAYDIUM_LOCK,distributionProgram:PublicKey.default,
   parentMint:[PublicKey.default,PublicKey.default],parentProgram:[PublicKey.default,PublicKey.default],parentSlot:[0,0],parentRoot:['00'.repeat(32),'00'.repeat(32)],parentSupply:[0,0],parentEligible:[0,0],parentExpirySeconds:0,metadataHash:createHash('sha256').update('local-lock-cost:'+nonce).digest(),metadataUri:'https://kids.fun/rehearsal/'+mint+'.json',parentReferenceConfig:[0,0]};
  await send([client.createInstruction(m.programId,terms).instruction,SystemProgram.transfer({fromPubkey:creator.publicKey,toPubkey:authority,lamports:300000000n})]);
  await send([client.commitInstruction(m.programId,campaign,creator.publicKey,m.genesisHash,2000000000n,0n)]);

  const base={genesisHash:m.genesisHash,programId:m.programId,campaign:String(campaign),payer:m.treasury,policy:'local-lifecycle-qualification'};
  const created=client.decodeCampaign((await c.getAccountInfo(campaign,'finalized')).data);
  await registry.campaigns.upsert({...base,network:'localnet',mode:'standard',campaignVersion:3,registryStatus:'planned',termsHash:created.state.termsHash});
  const block=await c.getLatestBlockhash('confirmed'),fundingIntent={...base,creator:m.pilotCreator,lamports:'40000000'},tx=buildOperatingFundingPacket(fundingIntent,block);tx.sign([creator]);
  const funding={binding:fundingIntent,block,signature:encodeBase58(tx.signatures[0]),transactionBase64:Buffer.from(tx.serialize()).toString('base64')};
  writeFileSync(join(directory,'funding-packet.json'),JSON.stringify(funding),{mode:0o600,flag:'wx'});
  await c.sendRawTransaction(tx.serialize(),{maxRetries:2,preflightCommitment:'confirmed'});
  const confirmation=await c.confirmTransaction({...block,signature:funding.signature},'finalized');assert.equal(confirmation.value.err,null);
  const signerRpc=createSignerRpcChannel({registry,connection:c,resource:'qualification-signer-rpc',ratePerSecond:30,burst:30});
  const budget=createOperatingSignerBudget({registry,connection:signerRpc.connection,...base,loadFundingPacket:async()=>funding,loadCostIntent:createStandardOperatingCostReader({connection:signerRpc.connection,...base,feeOperator:m.pilotCreator})});await budget.credit({...base,signature:funding.signature});
  const token=randomBytes(32).toString('hex'),signerArgs={registry,connection:c,admitRpc:signerRpc.admit,...base,programVersion:3,keypair:payer,token,stateFile:join(directory,'signer-state.json'),operatingBudget:{reserve:x=>budget.reserve(x),recordSignature:(...x)=>budget.recordSignature(...x)}};
  service=await createRegistrySignerService(signerArgs);await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  // The grant covers the sealed launch window (3,750 s from creation) plus the controller's one-day refund allowance.
  const cap=await registry.capabilities.grant({...base,programVersion:3,kind:'keeper',tags:[3,4,6],expiresAt:new Date(Date.now()+(3750+86400)*1000).toISOString()});
  const lanes=['lifecycle','recovery','provisioning','accounting','harvest','economics'],admission={ratePerSecond:240,burst:240,lanes:Object.fromEntries([...lanes,'indexing','backfill'].map(lane=>[lane,{ratePerSecond:30,burst:30}]))};
  const config=lane=>({mode:'localnet-rehearsal',lane,programVersion:3,genesisHash:m.genesisHash,programId:m.programId,rpcUrl:m.rpcUrl,concurrency:2,
   signer:lane==='accounting'?undefined:{url:'http://127.0.0.1:'+service.server.address().port,token,publicKey:m.treasury},
   rpcAdmission:{resource:'joined-lifecycle-rpc',policy:admission},signerAdmission:lane==='accounting'?undefined:{resource:'joined-lifecycle-signer',policy:admission},
   ...(lane==='accounting'?{operating:{payer:m.treasury,policy:base.policy}}:{}),
   ...(lane==='lifecycle'?{receiptBatchSize:8,lifecycle:{setupHandoff:true,policy:base.policy,minimumReserveLamports:'1000000'}}:{}),
   ...(lane==='provisioning'?{feeOperator:m.pilotCreator,feeActivation:{policy:base.policy,minimumReserveLamports:'1000000'}}:{})});
  for(const lane of lanes)workers.push(await createPublicWorker({registry,config:config(lane)}));
  const marketWorkers=[];
  for(const lane of ['indexing','backfill']){const worker=await createPublicMarketWorker({registry,config:{...config(lane),signer:undefined,signerAdmission:undefined}});marketWorkers.push(worker);workers.push(worker);}
  const marketReader=createPublicMarketReader({store:marketWorkers[0].store,...base,cacheMs:0});
  const activityReader=createPublicActivityReader({store:createPublicActivityStore(registry),...base,cacheMs:0});let marketScheduled=false;
  let lifecycle=workers[0];await lifecycle.scheduleCampaign(base,cap.capabilityId);await lifecycle.tick();
  // Restart the controlling process with the same database and original grant.
  await lifecycle.stop();lifecycle=await createPublicWorker({registry,config:config('lifecycle')});workers[0]=lifecycle;assert.equal((await lifecycle.scheduleCampaign(base,cap.capabilityId)).duplicate,true);
  log({event:'lifecycle-qualification-scheduled',campaign:String(campaign)});
  let complete=false,finalJobs;const until=Date.now()+360000;
  while(Date.now()<until){
   await Promise.all(workers.map(w=>w.tick()));finalJobs=await registry.jobs.listForCampaign(base);
   if(!marketScheduled&&finalJobs.some(j=>j.jobClass==='launch'&&j.state==='done')){await registry.jobs.enqueue({...base,jobClass:'market-index',operationKey:'market-live:0'});await registry.jobs.enqueue({...base,jobClass:'activity-index',operationKey:'activity-live:0'});marketScheduled=true;}
   const failure=finalJobs.find(j=>j.state==='failed');if(failure)throw Error(JSON.stringify({operation:failure.operationKey,result:failure.result}));
   const active=finalJobs.find(j=>j.jobClass==='fee-activate'&&j.state==='done'),feeJobs=finalJobs.filter(j=>['fee-harvest:0','distribution:0','token-burn:0'].includes(j.operationKey));
   if(active&&feeJobs.length===3&&feeJobs.every(j=>j.state==='done')&&(await budget.balance(base)).heldLamports==='0'&&(await marketReader.read({campaign:String(campaign)})).coverage?.complete){complete=true;break;}
   await pause(400);
  }
  assert.ok(complete,'Lifecycle did not finish: '+JSON.stringify(finalJobs.map(j=>({key:j.operationKey,state:j.state,result:j.result}))));
  await Promise.all(workers.slice(0,lanes.length).map(w=>w.stop()));
  // Indexing keeps serving while wallet transactions wait for finality; it must
  // not depend on the lifecycle controller making another tick.
  for(const worker of marketWorkers)worker.start();
  // Reopening the signer must reconcile disk approvals/fences with PostgreSQL.
  // No packet or grant is regenerated to make a restart pass.
  await service.close();service=await createRegistrySignerService(signerArgs);await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  const live=client.decodeCampaign((await c.getAccountInfo(campaign,'finalized')).data);assert.equal(live.state.phase,3);assert.equal(live.state.refunded,1000000000n);assert.equal(live.state.settledAccepted,1000000000n);
  assert.deepEqual((await registry.capabilities.latest(base)).tags,[3,21,23,26]);
  const readonly=createChainAdapter({connection:c,programId:m.programId,genesisHash:m.genesisHash,commitment:'finalized',signer:{publicKey:payer.publicKey,sign(){throw Error('Read-only verifier');}}});
  const verifier=withLiveVerification(readonly,{connection:c,programVersion:3});assert.equal((await verifier.verifyLaunch(base)).ok,true);
  const child=await getOrCreateAssociatedTokenAccount(c,creator,mint,creator.publicKey);
  const setupReturned=await send([returnSetupInstruction(m.programId,campaign,creator.publicKey,m.genesisHash)]);
  const claims=await send([client.claimParticipantInstruction(m.programId,campaign,mint,creator.publicKey),client.claimDevInstruction(m.programId,campaign,mint,creator.publicKey)]);
  const burn=await send([createBurnInstruction(child.address,mint,creator.publicKey,1000000n)]);
  const wsol=await getOrCreateAssociatedTokenAccount(c,creator,NATIVE_MINT,creator.publicKey);await send([SystemProgram.transfer({fromPubkey:creator.publicKey,toPubkey:wsol.address,lamports:10000000n}),createSyncNativeInstruction(wsol.address)]);
  const cpmm={programId:terms.ammProgram,ammConfig:terms.ammConfig},p=poolAddresses(cpmm.programId,cpmm.ammConfig,mint,NATIVE_MINT);
  const coin=(await getAccount(c,p.mint0.equals(mint)?p.vault0:p.vault1)).amount,sol=(await getAccount(c,p.mint0.equals(NATIVE_MINT)?p.vault0:p.vault1)).amount,input=10000000n,effective=input*(1000000n-terms.ammTradeFeeRate)/1000000n,minOut=coin*effective/(sol+effective)*99n/100n;
  assert.ok(minOut>0n);const buy=await send([swapInstruction(cpmm,p,creator.publicKey,NATIVE_MINT,input,minOut)]);
  let market;const indexDeadline=Date.now()+45000;
  do{market=await marketReader.read({campaign:String(campaign)});const failed=(await registry.jobs.listForCampaign(base)).find(j=>j.state==='failed');if(failed)throw Error(JSON.stringify({operation:failed.operationKey,result:failed.result}));if(market.trades?.some(t=>t.signature===buy))break;await pause(500);}while(Date.now()<indexDeadline);
  assert.equal(market.status,'live');assert.equal(market.coverage.openingVerified,true);assert.ok(market.trades.some(t=>t.signature===buy));
  const to=Math.ceil(Date.now()/60000)*60,from=Math.floor(Number(live.state.launchTime)/60)*60;
  const candles=await marketReader.read({campaign:String(campaign),kind:'candles',interval:'1m',from,to});assert.ok(candles.candles.length>0);
  let activity;const activityDeadline=Date.now()+45000;
  do{activity=await activityReader.read({campaign:String(campaign),filter:'all',limit:50});if(activity.status==='live'&&activity.coverage?.complete&&activity.events?.some(e=>e.signature===claims&&e.kind==='claim-participant'))break;await pause(500);}while(Date.now()<activityDeadline);
  assert.equal(activity.coverage?.complete,true,'Activity must cover the actual campaign initialization');assert.equal(activity.status,'live',JSON.stringify({freshness:activity.freshness,jobs:(await registry.jobs.listForCampaign(base)).filter(j=>j.jobClass==='activity-index').slice(-4).map(j=>({key:j.operationKey,state:j.state,result:j.result}))}));
  for(const kind of ['campaign-init','commit','refund','launch','claim-participant','claim-dev','fees-init','setup-return'])assert.ok(activity.events.some(e=>e.kind===kind&&!e.failed),'Missing finalized activity '+kind);
  const refundEvent=activity.events.find(e=>e.kind==='refund');assert.equal(refundEvent.assets.find(a=>a.mint==='SOL').amountRaw,'1000000000');
  const claimEvent=activity.events.find(e=>e.kind==='claim-participant');assert.equal(claimEvent.signature,claims);assert.equal(claimEvent.assets.find(a=>a.mint===String(mint)).amountRaw,String(supply*4850n/10000n));
  const after=await verifier.verifyLaunch(base);assert.equal(after.ok,true,after.failures.join('; '));
  const balance=await budget.balance(base);assert.equal(balance.heldLamports,'0');
  const report={network:'localnet',tradeFeeBps:Number(terms.ammTradeFeeRate)/100,campaign:String(campaign),mint:String(mint),fundingSignature:funding.signature,controllerRestart:true,signerJournalRestart:true,automaticSettlement:true,automaticLaunch:true,automaticRefunds:true,automaticFeeSetup:true,automaticFeeActivation:true,independentFeeJobsExecuted:3,marketOpeningVerified:true,marketTradeIndexed:true,activityHistoryComplete:true,activityEvents:activity.events.length,activityExactRefund:true,activityExactParticipantClaim:true,setupReturnSignature:setupReturned,candles:candles.candles.length,claimsSignature:claims,burnSignature:burn,buySignature:buy,currentCustodyVerifiedAfterActivity:true,refundedLamports:String(live.state.refunded),...balance,hostedActivation:false,directory};
  writeFileSync(join(directory,'report.json'),JSON.stringify(report),{mode:0o600,flag:'wx'});return report;
 }finally{await Promise.all(workers.map(w=>w.stop()));if(service?.server.listening)await service.close();creator?.secretKey.fill(0);payer?.secretKey.fill(0);if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)qualifyLifecycle({postgresUrl:process.env.KIDS_TEST_POSTGRES_URL,scale:process.env.KIDS_QUALIFY_SCALE==='1',log:e=>console.log(JSON.stringify(e))}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.stack);process.exitCode=1;});
