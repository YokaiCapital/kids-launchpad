// Automatic funding-first lifecycle on the isolated ledger (RPC 19199): the creator's one approval opens the round through the
// REAL creator services (custody reserves the fee NFT and co-signs), a participant commits, then the hosted worker composition
// takes over with NO further hand-driven step: a lifecycle-lane worker (funding-first controller, table, launch with the custody
// co-signer, accounting, collateral return), a recovery-lane worker (excess refunds) and an accounting-lane worker (holds
// settled from finalized evidence), all against the signer service (capability path, real budget credited by the creator's
// reserve). The script only ticks the workers and watches: the table is built while funding is open, the launch lands after
// the sealed deadline, the round is accounted, the collateral returns and the lifecycle hands off to fee setup. Evidence:
// .runtime/funding-first-lifecycle-rehearsal.json. Loopback only; PostgreSQL in a fresh schema; test-only vanity mint keys.
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';import {randomBytes,randomUUID} from 'node:crypto';import {tmpdir} from 'node:os';import {join} from 'node:path';
import pg from 'pg';
import {Connection,Keypair,PublicKey,Transaction,VersionedTransaction,sendAndConfirmTransaction} from '@solana/web3.js';
import {key,directory} from '../setup.mjs';
import {chainTime} from '../dev-vesting.mjs';
import {SOFT_FLOOR_LAMPORTS_V2} from './client.mjs';
import {commitInstruction,decodeCampaign,AMM_CONFIG_TIERS} from '../protocol-v2/client.mjs';
import {PostgresRegistry} from '../registry/registry.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {readPresets,presetTerms,presetsHash} from '../registry/presets.mjs';
import {createOperatingSignerBudget} from '../signer/operating-budget.mjs';
import {createRegistrySignerService} from '../signer/registry-service.mjs';
import {createStandardOperatingCostReader} from '../signer/standard-cost-reader.mjs';
import {createPublicWorker} from '../jobs/service.mjs';
import {LIFECYCLE_TAGS_V2} from '../jobs/lifecycle-funding-first.mjs';
import {createCreationStore} from '../creation/store.mjs';
import {createMetadataPublisher} from '../creation/publication.mjs';
import {createLocalCreatorServices} from '../creation/services.mjs';
import {loadOperatingFundingPacket} from '../creation/operating-reserve.mjs';
import {contentHash} from '../creation/pinata.mjs';
import {PINATA_GATEWAY} from '../token-metadata.mjs';
import {createFundingFirstCustody} from '../mints/funding-first-custody.mjs';
import {SqliteVanityMintInventory} from '../../kids-mint-worker/vendor/packages/launcher-sdk/src/mint-inventory.js';
import {SqliteLaunchExecutionStore} from '../../kids-mint-worker/vendor/packages/launcher-sdk/src/sqlite-execution-store.js';
const url=process.env.KIDS_TEST_POSTGRES_URL;if(!url)throw Error('KIDS_TEST_POSTGRES_URL is required (a local PostgreSQL for the registry)');
const keyFiles=(process.env.KIDS_REHEARSAL_MINT_KEYS??'').split(',').map(s=>s.trim()).filter(Boolean);if(!keyFiles.length)throw Error('KIDS_REHEARSAL_MINT_KEYS is required (test-only vanity mint keypair files)');
const record=JSON.parse(readFileSync(directory+'/kids-launch-v3-program.json','utf8'));
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(record.rpcUrl))throw Error('loopback only');
const connection=new Connection(record.rpcUrl,'confirmed'),programId=new PublicKey(record.programId);
const admin=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(key('v2-admin').path,'utf8'))));
if(admin.publicKey.toBase58()!==record.pilotCreator)throw Error('local pilot key differs from the program record');
const treasury=new PublicKey(record.treasury),owner=admin.publicKey.toBase58();
const genesisHash=await connection.getGenesisHash();if(genesisHash!==record.genesisHash)throw Error('ledger changed');
const J=v=>JSON.stringify(v,(k,x)=>typeof x==='bigint'?x.toString():x instanceof PublicKey?x.toBase58():x instanceof Uint8Array?Buffer.from(x).toString('base64'):x);
const results=[];const ok=(name,cond,detail='')=>{results.push({name,ok:!!cond,detail:String(detail).slice(0,300)});console.log((cond?'ok  ':'FAIL')+' '+name+(cond?'':' '+String(detail).slice(0,300)));};
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),stamp=()=>new Date().toISOString();
async function fund(pub,lamports){const sig=await connection.requestAirdrop(pub,lamports);await connection.confirmTransaction(sig,'confirmed');}
const keeper=Keypair.generate(),alice=Keypair.generate();
if(await connection.getBalance(admin.publicKey)<5e9)await fund(admin.publicKey,20e9);
await fund(keeper.publicKey,2e9);await fund(alice.publicKey,2e9);
const fundingSeconds=Number(process.env.KIDS_REHEARSAL_FUNDING_SECONDS??300),watchSeconds=Number(process.env.KIDS_REHEARSAL_WATCH_SECONDS??420);
const schema='kids_rehearsal_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});await control.query(`CREATE SCHEMA ${schema}`);
const pool=new pg.Pool({connectionString:url,max:12,options:`-c search_path=${schema}`}),registry=new PostgresRegistry({pool});await registry.migrate();
const dir=mkdtempSync(join(tmpdir(),'kids-ff-lifecycle-live-'));let service=null,inventory=null;const workers=[],workerLog=[];const evidence={programId:record.programId,sha256:record.sha256,genesisHash,at:stamp(),creator:owner,keeper:keeper.publicKey.toBase58(),treasury:treasury.toBase58(),fundingSeconds};
const stamps={};
let publisher=null;
try{
 inventory=new SqliteVanityMintInventory({databasePath:join(dir,'inventory.sqlite'),executionStore:new SqliteLaunchExecutionStore(join(dir,'executions.sqlite')),keyId:'rehearsal',encryptionKey:randomBytes(32),fallbackToOrdinaryMint:false});
 for(const file of keyFiles){const kp=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file,'utf8')))),mint=kp.publicKey.toBase58();if(!mint.endsWith('kids'))throw Error('vanity key does not end in kids: '+mint);const sealed=inventory.encrypt(Buffer.from(kp.secretKey),mint);inventory.db.prepare("INSERT INTO kids_mints VALUES(?,?,?,?,'available',?,NULL)").run(mint,sealed.nonce,sealed.ciphertext,sealed.tag,stamp());}
 const manifest=readPresets(),tier=AMM_CONFIG_TIERS.find(t=>t.index===2);manifest.agreed.feePolicy={...manifest.agreed.feePolicy,ammConfig:tier.address.toBase58(),ammConfigIndex:2,tradeFeeBps:Number(tier.tradeFeeRate)/100};
 const terms={...presetTerms(manifest,{mode:'standard',capPresetId:'default'}).terms,softCapLamports:SOFT_FLOOR_LAMPORTS_V2,hardCapLamports:String(10n*1_000_000_000n),fundingDurationSeconds:fundingSeconds,launchWindowSeconds:600};
 const config={mode:'localnet-rehearsal',programVersion:3,rpcUrl:record.rpcUrl,genesisHash,programId:record.programId,pilotCreator:owner,treasury:treasury.toBase58(),policyHash:presetsHash(manifest),planHash:'b'.repeat(64),oneTransaction:true,operatingPayer:keeper.publicKey.toBase58(),operatingReserveLamports:'60000000',priorityFeeLamports:'10000',fundingFirst:true};
 const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]),sha=contentHash(bytes),receipt=input=>{const cid=input.cid??'Qm'+(input.stage==='image'?'a':'b').repeat(44);return {cid,uri:PINATA_GATEWAY+cid,inputHash:input.inputHash};};
 publisher=createMetadataPublisher({registry,config,limits:{ownerPins:40,globalPins:40,ownerBytes:100000,globalBytes:100000},loadOwnedImage:async()=>({owner,assetId:'owned-pfp',sanitized:true,sha256:sha,bytes,contentType:'image/png'}),provider:{publish:async input=>receipt(input),recover:async input=>receipt(input)}});
 const store=createCreationStore(registry),draft={name:'Funding First Auto',symbol:'FFAUTO',description:'Creator-approved text.',pfp:{assetId:'owned-pfp',sha256:sha},start:'after-creation'};
 await registry.drafts.save({creator:owner,id:'auto',revision:0,body:draft});
 const q=await store.issue({owner,draftId:'auto',revision:1,draftHash:canonicalHash(draft),descriptorHash:canonicalHash({draftId:'auto'}),requestKey:'auto',body:{genesisHash,programId:record.programId,policyHash:config.policyHash,planHash:config.planHash,terms,costs:{lines:[{item:'mint account rent',lamports:'1461600'}]},authorityFunding:{amountLamports:'500000000'},operatingReserveLamports:'60000000',fundingEnabled:false,publicationConsent:true}});
 const requestId=(await store.accept({owner,quoteId:q.id})).id,input={requestId};
 const services=createLocalCreatorServices({registry,connection,config,inventory,publisher}),flow=services.flow;
 publisher.start(); // as the hosted API does: the sealed metadata receipts are pinned in the background (scripted provider here); the launch waits for them
 // --- The creator: one approval; the services do the rest (custody co-signature, exact broadcast, evidence, registration, reserve).
 stamps.started=stamp();
 await flow.prepare(owner,input);for(let i=0;i<60&&(await flow.status(owner,input)).stage==='publication';i++)await flow.prepare(owner,input);
 const intent=await services.mintPlans.load(requestId);ok('sealed version-3 plan with the custody fee NFT',intent.version===3&&intent.fundingFirst?.feeNft===inventory.fundingFirstCustody(intent.mint)?.feeNft);
 evidence.requestId=requestId;evidence.mint=intent.mint;evidence.feeNft=intent.fundingFirst.feeNft;evidence.campaign=intent.campaign;
 const offer=await flow.prepare(owner,input);const otx=VersionedTransaction.deserialize(Buffer.from(offer.result.transactionBase64,'base64'));otx.sign([admin]);stamps.approved=stamp();
 await flow.submit(owner,{requestId,stage:'launch',offerId:offer.result.offerId,transactionBase64:Buffer.from(otx.serialize()).toString('base64')});
 let s=null;for(let i=0;i<240;i++){const r=await flow.resume(owner,input);s=await flow.status(owner,input);if(i%20===0)console.log('CREATOR',J({stage:s.stage,state:s.state,reason:r?.result?.reason??r?.reason??null}));if(s.stage==='complete'||['expired','failed'].includes(s.state))break;await sleep(1000);}
 stamps.creatorComplete=stamp();
 ok('creator flow complete and funded from one approval',s?.stage==='complete'&&s.state==='funded'&&s.operatingReserve?.lamports==='60000000',J({stage:s?.stage,state:s?.state}));
 const row=await services.mintApprovals.read(requestId);evidence.opening={signature:row.signature};evidence.creatorFlow={stage:s?.stage,state:s?.state,signatures:s?.signatures};
 const campaign=new PublicKey(intent.campaign),camp0=await connection.getAccountInfo(campaign,'finalized'),terms0=decodeCampaign(camp0.data).terms,deadline=Number(terms0.deadline);stamps.deadline=new Date(deadline*1000).toISOString();
 const id={genesisHash,programId:record.programId,campaign:intent.campaign},base={...id,payer:keeper.publicKey.toBase58(),policy:'creator-funded-v1'};
 // --- The participant commits only AFTER the worker built the table (below): a fresh round with nothing committed must prepare
 // its table during funding (nothing committed yet is not a failed round).
 let committed=null;const commit=async()=>{const commitTx=new Transaction().add(commitInstruction(programId,campaign,alice.publicKey,genesisHash,20_000_000n,0n));commitTx.feePayer=alice.publicKey;committed=await sendAndConfirmTransaction(connection,commitTx,[alice],{commitment:'confirmed'}).catch(e=>{ok('participant committed 0.02 SOL',false,e.message);return null;});if(committed){ok('participant committed 0.02 SOL after the table was built',true);stamps.committed=stamp();}evidence.commit=committed;};
 // --- The hosted composition: signer service, then three lane workers over the same registry, the custody in process.
 const reader=createStandardOperatingCostReader({connection,genesisHash,programId:id.programId,payer:base.payer,feeOperator:keeper.publicKey,treasury:treasury.toBase58()});
 const budget=createOperatingSignerBudget({registry,connection,...base,treasury:treasury.toBase58(),loadFundingPacket:loadOperatingFundingPacket(registry),loadCostIntent:reader});
 ok('keeper budget holds the creator\'s reserve',(await budget.balance(base))?.availableLamports==='60000000',J(await budget.balance(base)));
 // The operator's grant exists before the signer service starts (as hosted: grants are issued at activation, the service
 // serves the campaigns it finds); the workers are composed after both.
 const cap=await registry.capabilities.grant({...id,kind:'keeper',programVersion:3,tags:[...LIFECYCLE_TAGS_V2],expiresAt:new Date(Date.now()+3*86400000).toISOString()});
 const signerLog=[],token='rehearsal-'+randomUUID()+'-'+randomUUID();
 service=await createRegistrySignerService({admitRpc:async()=>{},registry,connection,genesisHash,programId:id.programId,programVersion:3,keypair:keeper,token,stateFile:join(dir,'state.json'),operatingBudget:{reserve:x=>budget.reserve(x),recordSignature:(...a)=>budget.recordSignature(...a)},treasury:treasury.toBase58(),log:e=>signerLog.push(e)});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const custodyAdapter=createFundingFirstCustody({inventory,registry,connection,genesisHash,programId:id.programId});
 const coSignCalls=[];const custody={coSign:async(tx,ref)=>{coSignCalls.push({attempt:ref.attempt,operationKey:ref.operationKey,fencingToken:ref.fencingToken,at:stamp()});const out=await custodyAdapter.signLaunch({mint:ref.mint,campaign:ref.campaign,keeper:ref.keeper,packet:Buffer.from(tx.serialize()).toString('base64'),lookups:ref.lookups,packetRef:{operationId:ref.operationId,attempt:ref.attempt},operationKey:ref.operationKey,fencingToken:ref.fencingToken});return VersionedTransaction.deserialize(Buffer.from(out.transactionBase64,'base64'));}};
 const lanes=['lifecycle','recovery','accounting'],admission={ratePerSecond:240,burst:240,lanes:Object.fromEntries(lanes.map(lane=>[lane,{ratePerSecond:60,burst:60}]))};
 const workerConfig=lane=>({mode:'localnet-rehearsal',lane,programVersion:3,genesisHash,programId:id.programId,rpcUrl:record.rpcUrl,concurrency:2,
  signer:lane==='accounting'?undefined:{url:'http://127.0.0.1:'+service.server.address().port,token,publicKey:keeper.publicKey.toBase58()},
  rpcAdmission:{resource:'ff-rehearsal-rpc',policy:admission},signerAdmission:lane==='accounting'?undefined:{resource:'ff-rehearsal-signer',policy:admission},
  ...(lane==='accounting'?{operating:{payer:base.payer,policy:base.policy,treasury:treasury.toBase58()}}:{}),
  ...(lane==='lifecycle'?{lifecycle:{setupHandoff:true,policy:base.policy,minimumReserveLamports:'1000000',treasury:treasury.toBase58(),fundingFirst:true}}:{})});
 const log=e=>{workerLog.push(e);if(['job-done','job-failed','job-unknown','job-retry','job-stale-runner','job-runner-error'].includes(e.event))console.log('WORKER',JSON.stringify(e));};
 const byLane={};for(const lane of lanes){byLane[lane]=await createPublicWorker({registry,config:workerConfig(lane),log,...(lane==='lifecycle'?{custody}:{})});workers.push(byLane[lane]);}
 ok('three lane workers composed (lifecycle with the custody co-signer, recovery, accounting)',workers.length===3);
 const scheduled=await byLane.lifecycle.scheduleCampaign(id,cap.capabilityId);ok('funding-first lifecycle scheduled on the lifecycle worker',scheduled?.scheduled===true&&scheduled.duplicate===false,J(scheduled));
 stamps.scheduled=stamp();
 // --- Watch only: tick the workers until the lifecycle hands off to fee setup (or the watch window ends).
 const stageOf=async()=>(await registry.query('SELECT stage FROM standard_lifecycles WHERE campaign=?',[id.campaign])).rows[0]?.stage??null;
 const jobsOf=async()=>(await registry.jobs.listForCampaign(id)).map(j=>({key:j.operationKey,jobClass:j.jobClass,state:j.state,outcome:j.result?.outcome??null,category:j.result?.category??null}));
 const seen=new Map();const note=(k,v)=>{if(seen.get(k)!==v){seen.set(k,v);stamps[k]=stamp();console.log('EVENT',k,v,stamps[k]);}};
 const until=Date.now()+(fundingSeconds+watchSeconds)*1000;let stage=null,phaseLive=null;
 while(Date.now()<until){
  for(const lane of lanes)await byLane[lane].tick().catch(e=>log({event:'tick-error',lane,message:String(e?.message)}));
  const jobs=await jobsOf();for(const j of jobs)if(j.state==='done'||j.state==='failed')note('job:'+j.key,j.state);
  if(!committed&&(jobs.find(j=>j.key==='launch-table')?.state==='done'||await chainTime(connection)>=deadline-30))await commit();
  const info=await connection.getAccountInfo(campaign,'confirmed');if(info&&info.data[840]===3&&!phaseLive){phaseLive=stamp();note('campaign-live','phase 3');}
  stage=await stageOf();if(stage)note('lifecycle-stage',stage);
  if(stage==='fee-setup'||stage==='refunded')break;
  await sleep(1000);
 }
 stamps.watchEnded=stamp();
 const jobs=await jobsOf();evidence.jobs=jobs;evidence.lifecycleStage=stage;evidence.coSignCalls=coSignCalls;
 const state=k=>jobs.find(j=>j.key===k)?.state;
 ok('table built by the worker during funding with nothing committed yet (launch-table done before the commit and the deadline)',state('launch-table')==='done'&&stamps['job:launch-table']<stamps.deadline&&(!stamps.committed||stamps['job:launch-table']<=stamps.committed),J({state:state('launch-table'),at:stamps['job:launch-table'],committed:stamps.committed??null,deadline:stamps.deadline}));
 ok('launch done by the worker with the custody co-signature (one co-sign call)',state('launch')==='done'&&coSignCalls.length===1,J({state:state('launch'),coSignCalls}));
 ok('campaign live (phase 3)',!!phaseLive,phaseLive);
 ok('excess refunds (recovery lane) and exact-once accounting (lifecycle lane) done',state('refunds:excess')==='done'&&state('account')==='done',J({refunds:state('refunds:excess'),account:state('account')}));
 ok('collateral returned to the creator by the worker',state('collateral-return')==='done',state('collateral-return'));
 ok('lifecycle handed off to fee setup (stage fee-setup, fee-setup job queued)',stage==='fee-setup'&&state('fee-setup')==='queued',J({stage,feeSetup:state('fee-setup')}));
 const custodyView=inventory.fundingFirstCustody(intent.mint);ok('custody journal: one opening and one launch signature',J(custodyView?.signatures.map(x=>x.step+':'+x.generation))===J(['launch:0','opening:0']),J(custodyView?.signatures));
 const launchRow=(await registry.query("SELECT signature,status FROM operator_packets WHERE descriptor LIKE '%launch-v2:%' ORDER BY created_at DESC LIMIT 1")).rows[0];evidence.launch=launchRow??null;
 let reply=null;if(launchRow?.signature)for(let i=0;i<60&&!reply;i++){reply=await connection.getTransaction(launchRow.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!reply)await sleep(500);}
 if(reply){stamps.launchBlockTime=reply.blockTime;evidence.launchTransaction={slot:reply.slot,blockTime:reply.blockTime,fee:reply.meta?.fee,err:reply.meta?.err,computeUnitsConsumed:reply.meta?.computeUnitsConsumed};}
 // Give the accounting lane a few more ticks to settle every hold from finalized evidence.
 for(let i=0;i<30;i++){await byLane.accounting.tick().catch(()=>{});const b=await budget.balance(base);if(b.heldLamports==='0')break;await sleep(1000);}
 const balance=await budget.balance(base);evidence.budget=balance;ok('accounting lane settled every hold (0 held)',balance.heldLamports==='0',J(balance));
 stamps.elapsedFromSealedDeadline={campaignLive:phaseLive?(Date.parse(phaseLive)-deadline*1000)/1000:null,launchJobDone:stamps['job:launch']?(Date.parse(stamps['job:launch'])-deadline*1000)/1000:null,feeSetupHandoff:stamps['lifecycle-stage']&&stage==='fee-setup'?(Date.parse(stamps['lifecycle-stage'])-deadline*1000)/1000:null,chainClockInclusion:stamps.launchBlockTime?stamps.launchBlockTime-deadline:null};
 stamps.creatorJourneySeconds={approvalToComplete:(Date.parse(stamps.creatorComplete)-Date.parse(stamps.approved))/1000};
 evidence.workerLog=workerLog.filter(e=>['job-done','job-failed','job-unknown','job-retry','job-yield','tick-error','job-stale-runner','job-runner-error'].includes(e.event)).map(e=>({event:e.event,lane:e.lane,jobClass:e.jobClass,operationKey:e.operationKey,category:e.category,checkpoint:e.checkpoint,attempts:e.attempts,delayMs:e.delayMs}));
 evidence.signerLog=signerLog.map(e=>({event:e.event,reason:e.reason,cause:e.cause,operations:e.operations,spendLamports:e.spendLamports}));
 evidence.grant=cap.capabilityId;evidence.schema=schema;
}catch(error){ok('rehearsal completed without an exception',false,error.stack||error.message);evidence.error=String(error?.stack||error);}
finally{
 await publisher?.close().catch(()=>{});
 for(const w of workers)await w.stop().catch(()=>{});
 if(service?.server?.listening)await service.close().catch(()=>{});
 try{inventory?.close();}catch{}
 await pool.end().catch(()=>{});await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(()=>{});await control.end().catch(()=>{});rmSync(dir,{recursive:true,force:true});
}
evidence.stamps=stamps;evidence.checks=results;evidence.passed=results.filter(r=>r.ok).length;evidence.failed=results.filter(r=>!r.ok).length;
writeFileSync(directory+'/funding-first-lifecycle-rehearsal.json',J(evidence)+'\n',{mode:0o600});
console.log(J({campaign:evidence.campaign,launch:evidence.launch?.signature,stage:evidence.lifecycleStage,passed:evidence.passed,failed:evidence.failed,stamps}));
if(evidence.failed)process.exitCode=1;
