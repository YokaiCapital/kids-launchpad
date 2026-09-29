import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import pg from 'pg';import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {createLifecycleController} from './lifecycle.mjs';
const address=n=>new PublicKey(Buffer.alloc(32,n)).toBase58(),url=process.env.KIDS_TEST_POSTGRES_URL;
// Separate identities as on mainnet: the keeper pays (payer), the sealed platform treasury is another key.
const config={mode:'localnet-rehearsal',setupHandoff:true,genesisHash:address(1),programId:address(2),payer:address(3),treasury:address(7),policy:'lifecycle-qualification',minimumReserveLamports:'100',refundAllowanceSeconds:60};
async function fixture(fn){
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:5,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const id={genesisHash:config.genesisHash,programId:config.programId,campaign:address(4)},termsHash='a'.repeat(64);
  const c={phase:0,termsHash,terms:{mode:0,treasury:config.treasury,dev:address(5)},deadline:200n,launchDeadline:300n,total:1500n,soft:500n,hard:1000n,receiptCount:2n,settledCount:0n,settledAccepted:0n,refunded:0n};let clock=100n,verification=true;
  await registry.campaigns.upsert({...id,network:'localnet',mode:'standard',campaignVersion:3,registryStatus:'planned',termsHash});
  const cap=await registry.capabilities.grant({...id,kind:'keeper',programVersion:3,tags:[3,4,6],expiresAt:new Date(Date.now()+3600000).toISOString(),limits:{maxHourlyLamports:500000}});
  await registry.budgets.put({...id,payer:config.payer,policy:config.policy,reservedLamports:'200',spentLamports:'0',returnedLamports:'0'});
  const chain={readCampaign:async()=>({...c}),chainTime:async()=>clock,verifyLaunch:async()=>({ok:verification,checks:{slot:12,liability:c.total-c.settledAccepted-c.refunded}})};
  const controller=createLifecycleController({registry,chain,config});
  // A campaign sealed to another treasury (here: the keeper's own key) is refused before any registry write.
  await assert.rejects(createLifecycleController({registry,chain:{...chain,readCampaign:async()=>({...c,terms:{...c.terms,treasury:config.payer}})},config}).schedule(id,cap.capabilityId),/treasury/);
  const enable=async()=>{
   await controller.schedule(id,cap.capabilityId);const job=(await registry.jobs.listForCampaign(id)).find(j=>j.jobClass==='lifecycle-control');
   const lease=await registry.jobs.leaseById({jobId:job.jobId,token:0,owner:'controller',ttlMs:120000});
   const ctx={campaign:id,jobId:job.jobId,token:lease.fencingToken,owner:'controller',fenced:async(_name,fn)=>fn()};
   return {job,ctx,run:()=>controller.handler.run(job,ctx)};
  };
  const done=async key=>{const j=(await registry.jobs.listForCampaign(id)).find(j=>j.operationKey===key);assert.ok(j,'Missing '+key);const lease=await registry.jobs.leaseById({jobId:j.jobId,token:j.fencingToken,owner:'execution',ttlMs:30000});await registry.jobs.complete({jobId:j.jobId,token:lease.fencingToken,result:{verified:true}});};
  await fn({registry,id,c,cap,controller,chain,enable,done,setClock:n=>clock=n,setVerification:v=>verification=v});
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
}
test('lifecycle remains local and needs explicit economic policy, reserve and setup handoff',()=>{
 for(const patch of [{mode:'production'},{setupHandoff:false},{minimumReserveLamports:'0'},{policy:''},{refundAllowanceSeconds:59},{refundAllowanceSeconds:2592001},{refundAllowanceSeconds:'86400'}])assert.throws(()=>createLifecycleController({registry:{driver:'postgres'},chain:{chainTime(){},verifyLaunch(){}},config:{...config,...patch}}));
});
test('scheduling refuses a grant that expires before the launch window closes plus the refund allowance',{skip:!url},()=>fixture(async f=>{
 // Chain clock 100, launch window closes at 300, allowance 60: the grant must live at least 260 s of wall time.
 const short=await f.registry.capabilities.grant({...f.id,kind:'keeper',programVersion:3,tags:[3,4,6],expiresAt:new Date(Date.now()+200000).toISOString()});
 await assert.rejects(f.controller.schedule(f.id,short.capabilityId),/expires before the launch window/);
 assert.equal((await f.registry.jobs.listForCampaign(f.id)).length,0);
 const long=await f.registry.capabilities.grant({...f.id,kind:'keeper',programVersion:3,tags:[3,4,6],expiresAt:new Date(Date.now()+300000).toISOString()});
 assert.deepEqual(await f.controller.schedule(f.id,long.capabilityId),{scheduled:true,duplicate:false});
}));
test('a superseded initial grant pauses the lifecycle; a refund-only continuation delivers full refunds after the window and nothing else',{skip:!url},()=>fixture(async f=>{
 const {run}=await f.enable();
 // The operator issues a later keeper grant: the initial grant is no longer the latest, so everything pauses.
 await f.registry.capabilities.grant({...f.id,kind:'keeper',programVersion:3,tags:[3,4,6],expiresAt:new Date(Date.now()+3600000).toISOString()});
 f.setClock(200n);assert.equal((await run()).category,'lifecycle-capability-paused');
 // A refund-only grant does not resume settlement or launch while the launch window is still open.
 const refundOnly=await f.registry.capabilities.grant({...f.id,kind:'keeper',programVersion:3,tags:[3],expiresAt:new Date(Date.now()+3600000).toISOString()});
 assert.equal((await run()).category,'lifecycle-capability-paused');
 assert.deepEqual((await f.registry.jobs.listForCampaign(f.id)).map(j=>j.jobClass),['lifecycle-control'],'no settlement or launch work was created on a refund-only grant');
 // Once the window closed without a launch, refunds proceed under the continuation and the lifecycle ends as refunded.
 f.setClock(301n);assert.equal((await run()).category,'awaiting-full-refunds');
 assert.deepEqual((await f.registry.jobs.listForCampaign(f.id)).map(j=>j.jobClass).sort(),['lifecycle-control','refunds']);
 f.c.phase=2;f.c.refunded=1500n;await f.done('refunds:failure');
 const result=await run();assert.equal(result.category,'refunded');assert.equal(result.continuation,refundOnly.capabilityId);
 assert.equal((await f.registry.query('SELECT stage FROM standard_lifecycles')).rows[0].stage,'refunded');
 // Option 1: the refunded stage queues the return of the unused operating reserve for the recovery lane.
 assert.ok((await f.registry.jobs.listForCampaign(f.id)).some(j=>j.jobClass==='operating-return'&&j.operationKey==='operating-return'),'operating-return job queued after refunds');
 // A wider or recipient-bearing later grant is not a continuation.
 const g=await f.registry.capabilities.grant({...f.id,kind:'keeper',programVersion:3,tags:[3,4],expiresAt:new Date(Date.now()+3600000).toISOString()});
 assert.ok(g.capabilityId);assert.equal((await run()).duplicate,true,'a finished lifecycle stays finished');
}));
test('lifecycle progresses separate lanes and hands off only after verified launch AND refunds',{skip:!url},()=>fixture(async f=>{
 const {run,job,ctx}=await f.enable();
 assert.equal((await run()).category,'funding-open');assert.equal((await f.registry.jobs.listForCampaign(f.id)).length,1);
 f.setClock(200n);assert.equal((await run()).category,'awaiting-settlement');await f.done('settlement');f.c.settledCount=2n;f.c.settledAccepted=1000n;
 assert.equal((await run()).category,'awaiting-launch');assert.deepEqual((await f.registry.jobs.listForCampaign(f.id)).map(j=>j.jobClass).sort(),['launch','lifecycle-control','refunds','settlement']);
 f.c.phase=3;await f.done('launch');assert.equal((await run()).category,'awaiting-excess-refunds');assert.equal((await f.registry.capabilities.latest(f.id)).capabilityId,f.cap.capabilityId);
 f.c.refunded=500n;await f.done('refunds:excess');f.setVerification(false);assert.equal((await run()).outcome,'failed-permanent');f.setVerification(true);
 await assert.rejects(f.controller.handler.run(job,{...ctx,token:ctx.token+1}),{code:'STALE_LEASE'});
 const enqueue=f.registry.jobs.enqueue;f.registry.jobs.enqueue=async input=>{const result=await enqueue(input);if(input.jobClass==='fee-setup')throw Error('injected queue outage');return result;};
 await assert.rejects(run(),/queue outage/);assert.equal((await f.registry.capabilities.latest(f.id)).capabilityId,f.cap.capabilityId);assert.equal((await f.registry.query('SELECT stage FROM standard_lifecycles')).rows[0].stage,'scheduled');
 f.registry.jobs.enqueue=enqueue;
 const result=await run();assert.equal(result.category,'fee-setup');const setup=await f.registry.capabilities.latest(f.id);assert.deepEqual(setup.tags,[20]);assert.deepEqual(setup.recipients,[config.treasury,address(5)].sort(),'fee-setup recipients are the sealed treasury and dev, never the payer');assert.equal(setup.expiresAt,f.cap.expiresAt);assert.deepEqual(setup.limits,f.cap.limits);
 const restarted=createLifecycleController({registry:f.registry,chain:f.chain,config});assert.equal((await restarted.handler.run(job,ctx)).duplicate,true);assert.equal((await f.registry.capabilities.list({includeExpired:true})).length,2);
 await f.registry.capabilities.revoke(setup.capabilityId);await restarted.schedule(f.id,f.cap.capabilityId);assert.equal((await f.registry.capabilities.list({includeExpired:true})).length,2,'Restart cannot undo operator revocation');
}));
test('failed campaigns get full refunds and excess-refund completion cannot stand in for failure recovery',{skip:!url},()=>fixture(async f=>{
 const {run}=await f.enable();f.setClock(200n);await run();await f.done('settlement');f.c.settledCount=2n;f.c.settledAccepted=1000n;await run();await f.done('refunds:excess');f.c.refunded=500n;
 f.setClock(301n);assert.equal((await run()).category,'awaiting-full-refunds');
 const jobs=await f.registry.jobs.listForCampaign(f.id);assert.ok(jobs.find(j=>j.operationKey==='refunds:failure'));assert.ok(!jobs.some(j=>j.jobClass==='fee-setup'));
 f.c.phase=2;f.c.refunded=1500n;await f.done('refunds:failure');assert.equal((await run()).category,'refunded');assert.equal((await f.registry.capabilities.list({includeExpired:true})).length,1);
}));
test('soft-cap failure skips settlement and launch; paused rights do not regenerate',{skip:!url},()=>fixture(async f=>{
 const {run}=await f.enable();f.c.total=100n;f.setClock(200n);assert.equal((await run()).category,'awaiting-full-refunds');
 assert.deepEqual((await f.registry.jobs.listForCampaign(f.id)).map(j=>j.jobClass).sort(),['lifecycle-control','refunds']);
 await f.registry.capabilities.revoke(f.cap.capabilityId);assert.equal((await run()).category,'lifecycle-capability-paused');assert.equal((await f.registry.capabilities.list({includeExpired:true})).length,1);
}));
test('enablement is funded, bound and idempotent under simultaneous calls',{skip:!url},()=>fixture(async f=>{
 await f.registry.budgets.put({...f.id,payer:config.payer,policy:config.policy,reservedLamports:'0',spentLamports:'0',returnedLamports:'0'});
 await assert.rejects(f.controller.schedule(f.id,f.cap.capabilityId),/reserve required/);assert.equal((await f.registry.jobs.listForCampaign(f.id)).length,0);
 await f.registry.budgets.put({...f.id,payer:config.payer,policy:config.policy,reservedLamports:'200',spentLamports:'0',returnedLamports:'0'});
 const results=await Promise.all([f.controller.schedule(f.id,f.cap.capabilityId),f.controller.schedule(f.id,f.cap.capabilityId)]);assert.equal(results.filter(r=>!r.duplicate).length,1);assert.equal((await f.registry.jobs.listForCampaign(f.id)).length,1);
 await assert.rejects(f.controller.schedule(f.id,'another-grant'),/binding changed/);
 f.c.termsHash='b'.repeat(64);await assert.rejects(f.controller.schedule(f.id,f.cap.capabilityId),/registered terms/);
}));
