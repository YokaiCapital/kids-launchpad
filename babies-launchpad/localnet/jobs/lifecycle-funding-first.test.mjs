// The funding-first lifecycle controller over PostgreSQL with a scripted version-2 chain: scheduling needs a funding-first
// record and a grant with exactly the funding-first tags; the table job while funding is open; after the deadline a funded round
// launches, then excess refunds + accounting, the collateral return, and the fee-setup handoff only at zero liability; a failed
// round closes, refunds everything, returns the collateral and hands the reserve back; a refund-only continuation grant never
// launches; a live custody that does not verify fails permanently.
import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import pg from 'pg';import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {createFundingFirstLifecycle,LIFECYCLE_TAGS_V2,REFUND_TAGS_V2} from './lifecycle-funding-first.mjs';
import {createLifecycleController} from './lifecycle.mjs';
import {launchTable} from './handlers-funding-first.mjs';
const address=n=>new PublicKey(Buffer.alloc(32,n)).toBase58(),url=process.env.KIDS_TEST_POSTGRES_URL;
const config={mode:'localnet-rehearsal',setupHandoff:true,genesisHash:address(1),programId:address(2),payer:address(3),treasury:address(7),policy:'lifecycle-qualification',minimumReserveLamports:'100',refundAllowanceSeconds:60};
async function fixture(fn,{accountingVersion=2,total=1500n}={}){
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:5,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const id={genesisHash:config.genesisHash,programId:config.programId,campaign:address(4)},termsHash='a'.repeat(64);
  const c={accountingVersion,phase:0,termsHash,terms:{mode:0,treasury:config.treasury,dev:address(5),metadataUri:'https://gateway.pinata.cloud/ipfs/Qm'+'b'.repeat(44)},deadline:200n,launchDeadline:300n,total,soft:500n,hard:1000n,receiptCount:2n,settledCount:0n,settledAccepted:0n,refunded:0n};
  const ext={sealed:false,sealedReceipts:2,acceptedTarget:'1000',accountedCount:0,accountedAccepted:'0',collateralReturned:'0'};
  let clock=100n,verification=true,liability=0n;
  await registry.campaigns.upsert({...id,network:'localnet',mode:'standard',campaignVersion:3,registryStatus:'planned',termsHash,terms:{accountingVersion:2,feeNft:address(9)}});
  const grant=t=>registry.capabilities.grant({...id,kind:'keeper',programVersion:3,tags:t,expiresAt:new Date(Date.now()+3600000).toISOString(),limits:{maxHourlyLamports:500000}});
  const cap=await grant([...LIFECYCLE_TAGS_V2]);
  await registry.budgets.put({...id,payer:config.payer,policy:config.policy,reservedLamports:'200',spentLamports:'0',returnedLamports:'0'});
  const chain={readCampaign:async()=>({...c}),readExtension:async()=>({...ext}),chainTime:async()=>clock,verifyLaunch:async()=>({ok:verification,checks:{slot:12,liability}})};
  const controller=createFundingFirstLifecycle({registry,chain,config});
  const enable=async(capability=cap)=>{
   await controller.schedule(id,capability.capabilityId);const job=(await registry.jobs.listForCampaign(id)).find(j=>j.jobClass==='lifecycle-control');
   const lease=await registry.jobs.leaseById({jobId:job.jobId,token:0,owner:'controller',ttlMs:120000});
   const ctx={campaign:id,jobId:job.jobId,token:lease.fencingToken,owner:'controller',fenced:async(_name,fn)=>fn()};
   return {job,ctx,run:()=>controller.handler.run(job,ctx)};
  };
  const jobs=async()=>(await registry.jobs.listForCampaign(id)).map(j=>j.operationKey).sort();
  const done=async key=>{const j=(await registry.jobs.listForCampaign(id)).find(j=>j.operationKey===key);assert.ok(j,'Missing '+key);const lease=await registry.jobs.leaseById({jobId:j.jobId,token:j.fencingToken,owner:'execution',ttlMs:30000});await registry.jobs.complete({jobId:j.jobId,token:lease.fencingToken,result:{verified:true}});};
  const stage=async()=>(await registry.query('SELECT stage,setup_capability_id FROM standard_lifecycles WHERE campaign=?',[id.campaign])).rows[0];
  await fn({registry,id,c,ext,cap,grant,controller,chain,enable,jobs,done,stage,setClock:n=>clock=n,setVerification:v=>verification=v,setLiability:n=>liability=n});
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
}
test('funding-first lifecycle stays local and needs the explicit policy, setup handoff and the extension reader',()=>{
 const chain={chainTime(){},verifyLaunch(){},readExtension(){}};
 for(const patch of [{mode:'production'},{setupHandoff:false},{minimumReserveLamports:'0'},{policy:''},{refundAllowanceSeconds:59}])assert.throws(()=>createFundingFirstLifecycle({registry:{driver:'postgres'},chain,config:{...config,...patch}}));
 assert.throws(()=>createFundingFirstLifecycle({registry:{driver:'postgres'},chain:{chainTime(){},verifyLaunch(){}},config}),/extension reader/);
});
test('scheduling needs a funding-first record and a grant with exactly the funding-first tags; duplicates are idempotent',{skip:!url},()=>fixture(async f=>{
 const perReceipt=await f.grant([3,4,6]);await assert.rejects(f.controller.schedule(f.id,perReceipt.capabilityId),/funding-first lifecycle grant/);
 assert.notEqual(f.controller.descriptorHash,createLifecycleController({registry:f.registry,chain:f.chain,config}).descriptorHash,'its own descriptor, never the per-receipt one');
 const fresh=await f.grant([...LIFECYCLE_TAGS_V2]);assert.deepEqual(await f.controller.schedule(f.id,fresh.capabilityId),{scheduled:true,duplicate:false});
 assert.deepEqual(await f.controller.schedule(f.id,fresh.capabilityId),{scheduled:true,duplicate:true});
 await assert.rejects(f.controller.schedule(f.id,perReceipt.capabilityId),/binding changed/);
}));
test('a per-receipt record is refused by the funding-first scheduler',{skip:!url},()=>fixture(async f=>{
 await assert.rejects(f.controller.schedule(f.id,f.cap.capabilityId),/accounting version 2/);
},{accountingVersion:0}));
test('funded round: the table while funding is open, the launch after the deadline, then excess refunds + accounting, the collateral return, and the fee-setup handoff at zero liability',{skip:!url},()=>fixture(async f=>{
 const e=await f.enable();
 let r=await e.run();assert.equal(r.outcome,'yield');assert.equal(r.category,'funding-open');assert.deepEqual(await f.jobs(),['launch-table','lifecycle-control']);
 f.setClock(200n);r=await e.run();assert.equal(r.category,'awaiting-launch');assert.deepEqual(await f.jobs(),['launch','launch-table','lifecycle-control']);
 await f.done('launch');f.c.phase=3;f.ext.sealed=true;f.setLiability(65535n-2n);
 r=await e.run();assert.equal(r.category,'awaiting-refunds-and-accounting');assert.deepEqual(await f.jobs(),['account','launch','launch-table','lifecycle-control','refunds:excess']);
 await f.done('refunds:excess');r=await e.run();assert.equal(r.category,'awaiting-refunds-and-accounting');
 await f.done('account');f.ext.accountedCount=2;f.ext.accountedAccepted='998';
 r=await e.run();assert.equal(r.category,'awaiting-collateral-return');assert.ok((await f.jobs()).includes('collateral-return'));
 await f.done('collateral-return');f.ext.collateralReturned='65533';
 r=await e.run();assert.equal(r.category,'awaiting-zero-liability','the verifier still reads a liability');
 f.setLiability(0n);r=await e.run();assert.equal(r.outcome,'done');assert.equal(r.category,'fee-setup');
 const s=await f.stage();assert.equal(s.stage,'fee-setup');assert.equal(s.setup_capability_id,r.capabilityId);assert.ok((await f.jobs()).includes('fee-setup'));
 const setup=await f.registry.capabilities.latest(f.id);assert.equal(setup.kind,'fee-setup');assert.deepEqual(setup.tags,[20]);
 assert.equal((await e.run()).duplicate,true,'a finished lifecycle is done again without new jobs');
}));
test('a fresh round with nothing committed prepares its table during funding through the controller and the real table handler; the launch follows once funded',{skip:!url},()=>fixture(async f=>{
 const e=await f.enable();
 let r=await e.run();assert.equal(r.category,'funding-open');
 const job=(await f.registry.jobs.listForCampaign(f.id)).find(j=>j.operationKey==='launch-table');assert.equal(job.state,'queued');
 // The real handler on the real job row: total 0 while funding is open is not a failed round; the plan is allocated and built.
 const lease=await f.registry.jobs.leaseById({jobId:job.jobId,token:job.fencingToken,owner:'lifecycle-worker',ttlMs:30000});
 let plan=null;const plans={read:async()=>plan,allocate:async()=>{plan={table:'TABLE',recentSlot:5,status:'planned'};return plan;},markComplete:async(id,p)=>{assert.deepEqual(id,f.id);plan={...p,status:'complete'};}};
 const chain={...f.chain,launchTable:async(_id,{plan:p})=>({status:'confirmed',table:p.table,steps:2,signature:'table-sig'})};
 const outcome=await launchTable({chain,plans}).run(job,{campaign:f.id,jobId:job.jobId,token:lease.fencingToken,owner:'lifecycle-worker',now:()=>Date.now(),signal:null,holds:async()=>true,fenced:async(_l,fn)=>fn(),enqueue:async()=>{}});
 assert.equal(outcome.outcome,'done',JSON.stringify(outcome));assert.equal(plan.status,'complete');
 await f.registry.jobs.complete({jobId:job.jobId,token:lease.fencingToken,result:outcome});
 assert.equal((await f.registry.jobs.listForCampaign(f.id)).find(j=>j.operationKey==='launch-table').state,'done','the table job ends done, never failed, on an empty round');
 f.c.total=1500n;f.setClock(200n);r=await e.run();assert.equal(r.category,'awaiting-launch');assert.ok((await f.jobs()).includes('launch'));
},{total:0n}));
test('failed round: close, refund every commitment, return the collateral, hand the reserve back; a refund-only continuation grant never launches',{skip:!url},()=>fixture(async f=>{
 const e=await f.enable();f.setClock(200n);
 let r=await e.run();assert.equal(r.category,'awaiting-close');assert.deepEqual(await f.jobs(),['close:refund-only','lifecycle-control']);
 await f.done('close:refund-only');f.c.phase=2;r=await e.run();assert.equal(r.category,'awaiting-full-refunds');assert.ok((await f.jobs()).includes('refunds:failure'));
 await f.done('refunds:failure');r=await e.run();assert.equal(r.category,'awaiting-full-refunds','the counter must show every commitment refunded');
 f.c.refunded=f.c.total;r=await e.run();assert.equal(r.category,'awaiting-collateral-return');
 await f.done('collateral-return');r=await e.run();assert.equal(r.outcome,'done');assert.equal(r.category,'refunded');assert.equal((await f.stage()).stage,'refunded');assert.ok((await f.jobs()).includes('operating-return'));
 assert.equal((await f.jobs()).includes('launch'),false,'nothing launched');
},{total:400n}));
test('after the initial grant lapses, only a refund-only continuation grant lets a failed round finish; it never launches a funded one',{skip:!url},()=>fixture(async f=>{
 const e=await f.enable();
 await f.registry.capabilities.revoke(f.cap.capabilityId);f.setClock(200n);
 assert.equal((await e.run()).category,'lifecycle-capability-paused');
 await f.grant([...REFUND_TAGS_V2]);
 assert.equal((await e.run()).category,'lifecycle-capability-paused','a funded round waits for a full grant, never launches on a refund-only grant');
 f.c.total=400n;const r=await e.run();assert.equal(r.category,'awaiting-close');assert.deepEqual(await f.jobs(),['close:refund-only','lifecycle-control']);
}));
test('a live custody that does not verify fails the lifecycle permanently',{skip:!url},()=>fixture(async f=>{
 const e=await f.enable();f.setClock(200n);f.c.phase=3;f.setVerification(false);
 const r=await e.run();assert.equal(r.outcome,'failed-permanent');assert.match(r.reason,/did not verify/);
}));
import {closeFundingFirst,accountFundingFirst} from './handlers-funding-first.mjs';
import {recoverFailedJob} from './recover-failed.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
const realCtx=(f,job,lease)=>({campaign:f.id,jobId:job.jobId,token:lease.fencingToken,owner:'lifecycle-worker',now:()=>Date.now(),signal:null,holds:async()=>true,fenced:async(_l,fn)=>fn(),enqueue:async()=>{}});
const runReal=async(f,key,handler)=>{const job=(await f.registry.jobs.listForCampaign(f.id)).find(j=>j.operationKey===key);const lease=await f.registry.jobs.leaseById({jobId:job.jobId,token:job.fencingToken,owner:'lifecycle-worker',ttlMs:30000});const outcome=await handler.run(job,realCtx(f,job,lease));if(outcome.outcome==='done')await f.registry.jobs.complete({jobId:job.jobId,token:lease.fencingToken,result:outcome});else if(outcome.outcome==='failed-permanent')await f.registry.jobs.fail({jobId:job.jobId,token:lease.fencingToken,error:outcome.reason,result:{...outcome,attempts:1}});else await f.registry.jobs.requeue({jobId:job.jobId,token:lease.fencingToken,result:outcome,notBefore:null});return outcome;};
test('a funded round sealed closed by an earlier close job that then misses its launch window: the controller runs a refund-only close through the real handler (its own job key), then refunds and the collateral',{skip:!url},()=>fixture(async f=>{
 const e=await f.enable();f.setClock(200n);
 // An earlier close sealed the totals (phase 1) under its own key; the launch never came.
 await f.registry.jobs.enqueue({...f.id,jobClass:'launch',operationKey:'close:sealed',payload:{}});await f.done('close:sealed');f.c.phase=1;f.ext.sealed=true;
 assert.equal((await e.run()).category,'awaiting-launch');
 f.setClock(300n);
 let r=await e.run();assert.equal(r.category,'awaiting-close','after the window the round is failed: the refund-only close is its own job, the old close does not stand in');
 assert.ok((await f.jobs()).includes('close:refund-only'));
 const chain={...f.chain,closeV2:async()=>{f.c.phase=2;return {status:'confirmed',signature:'close-sig'};}};
 const closed=await runReal(f,'close:refund-only',closeFundingFirst({chain}));assert.equal(closed.outcome,'done',JSON.stringify(closed));assert.equal(closed.phase,2);
 r=await e.run();assert.equal(r.category,'awaiting-full-refunds');
 await f.done('refunds:failure');f.c.refunded=f.c.total;r=await e.run();assert.equal(r.category,'awaiting-collateral-return');
 await f.done('collateral-return');r=await e.run();assert.equal(r.outcome,'done');assert.equal(r.category,'refunded');
}));
test('a funding-first job that failed permanently on the signer policy refusal is recovered through the audited durable recovery, then completes and the controller proceeds',{skip:!url},()=>fixture(async f=>{
 const e=await f.enable();f.setClock(200n);await e.run();await f.done('launch');f.c.phase=3;f.ext.sealed=true;f.setLiability(65535n);
 await e.run();await f.done('refunds:excess');
 // The account job fails permanently as the runner would record the signer's 403 (before the policy allowed tag 46).
 const refusal='Signer refused the request (403): launch program instruction not allowed';
 const chainRefusing={...f.chain,listReceipts:async()=>({receipts:[{address:'R0',owner:'O0',committed:1000n,refunded:0n,accounted:false},{address:'R1',owner:'O1',committed:500n,refunded:0n,accounted:false}],complete:true,slot:1}),accountV2:async()=>{throw Object.assign(Error(refusal),{status:403});}};
 const job=(await f.registry.jobs.listForCampaign(f.id)).find(j=>j.operationKey==='account');
 const lease=await f.registry.jobs.leaseById({jobId:job.jobId,token:job.fencingToken,owner:'lifecycle-worker',ttlMs:30000});
 await assert.rejects(accountFundingFirst({chain:chainRefusing}).run(job,realCtx(f,job,lease)),/403/);
 const failed={outcome:'failed-permanent',category:'auth',reason:refusal,attempts:1};
 await f.registry.jobs.fail({jobId:job.jobId,token:lease.fencingToken,error:refusal,result:failed});
 assert.equal((await e.run()).category,'accounting-needs-recovery');
 // Audited recovery: the exact failed revision, the reviewed reason, a current grant covering the bookkeeping tags.
 // The exact failed revision as the operator reads it back (the registry adds the error text to the stored result).
 const before=await f.registry.jobs.get(job.jobId),failedHash=canonicalHash(before.result);assert.equal(before.result.reason,refusal);
 await assert.rejects(recoverFailedJob({registry:f.registry,identity:f.id,jobId:job.jobId,expectedToken:before.fencingToken,expectedResultHash:failedHash,recoveryId:'rec-1',actor:'owner-terminal',reason:'transient-retry-reviewed'}),{code:'RECOVERY_CONFLICT'},'the generic transient reason does not cover a policy refusal');
 const recovered=await recoverFailedJob({registry:f.registry,identity:f.id,jobId:job.jobId,expectedToken:before.fencingToken,expectedResultHash:failedHash,recoveryId:'rec-1',actor:'owner-terminal',reason:'signer-policy-tags-reviewed'});
 assert.deepEqual(recovered,{jobId:job.jobId,recoveryId:'rec-1',requeued:true});assert.equal((await f.registry.jobs.get(job.jobId)).state,'queued');
 assert.deepEqual(await recoverFailedJob({registry:f.registry,identity:f.id,jobId:job.jobId,expectedToken:before.fencingToken,expectedResultHash:failedHash,recoveryId:'rec-1',actor:'owner-terminal',reason:'signer-policy-tags-reviewed'}),{jobId:job.jobId,recoveryId:'rec-1',requeued:false},'idempotent by recovery id');
 // The deployed signer now allows the tag: the real handler accounts both receipts and the controller moves on.
 const receipts=[{address:'R0',owner:'O0',committed:1000n,refunded:0n,accounted:false},{address:'R1',owner:'O1',committed:500n,refunded:0n,accounted:false}];
 const chainAllowing={...f.chain,listReceipts:async()=>({receipts:receipts.map(r=>({...r})),complete:true,slot:1}),readExtension:async()=>({...f.ext}),accountV2:async(_id,r)=>{const row=receipts.find(x=>x.address===r.address);row.accounted=true;f.ext.accountedCount++;f.ext.accountedAccepted=String(BigInt(f.ext.accountedAccepted)+row.committed);return {status:'confirmed',signature:'account-'+r.address};}};
 const done=await runReal(f,'account',accountFundingFirst({chain:chainAllowing}));assert.equal(done.outcome,'done',JSON.stringify(done));assert.equal(done.accountedCount,2);
 assert.equal((await e.run()).category,'awaiting-collateral-return');
}));
