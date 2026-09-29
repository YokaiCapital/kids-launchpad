import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import pg from 'pg';import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {recoverFailedJob} from './recover-failed.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const identity={genesisHash:addr(1),programId:addr(2),campaign:addr(3)};
test('failed job recovery preserves a private audit and cannot discard pending financial evidence',{skip:!url},async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:6,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  await registry.campaigns.upsert({...identity,mode:'standard',campaignVersion:3,registryStatus:'planned'});
  async function failed(extra={}){
   const key='refund:'+randomUUID(),j=(await registry.jobs.enqueue({...identity,operationKey:key,jobClass:'refunds',...extra})).job;
   const lease=await registry.jobs.leaseById({jobId:j.jobId,token:0,owner:'fixture'});
   const result={outcome:'failed-permanent',category:'retries-exhausted',attempts:15,lastCategory:'refund-failed',reason:'Unsigned packet expired; re-read chain before rebuilding'};
   const after=await registry.jobs.fail({jobId:j.jobId,token:lease.fencingToken,error:result.reason,result});
   return {job:after,input:{registry,identity,jobId:j.jobId,expectedToken:after.fencingToken,expectedResultHash:canonicalHash(after.result),recoveryId:randomUUID(),actor:'qualification-operator',reason:'reconciliation-budget-correction'}};
  }
  await t.test('concurrent replay queues once with higher fence and exact old result',async()=>{
   const {job,input}=await failed(),results=await Promise.all(Array.from({length:6},()=>recoverFailedJob(input)));
   assert.equal(results.filter(r=>r.requeued).length,1);const next=await registry.jobs.get(job.jobId);assert.equal(next.state,'queued');assert.equal(next.fencingToken,job.fencingToken+1);assert.equal(next.result.retryAttempts,0);
   const audit=(await registry.query('SELECT * FROM job_recoveries WHERE job_id=?',[job.jobId])).rows;assert.equal(audit.length,1);assert.equal(audit[0].prior_result_hash,canonicalHash(job.result));assert.deepEqual(JSON.parse(audit[0].prior_result_json),job.result);
   await assert.rejects(registry.jobs.complete({jobId:job.jobId,token:job.fencingToken}),{code:'STALE_LEASE'});
   await assert.rejects(recoverFailedJob({...input,actor:'other'}),{code:'RECOVERY_CONFLICT'});
   await assert.rejects(recoverFailedJob({...input,recoveryId:randomUUID()}),{code:'RECOVERY_CONFLICT'});
  });
  await t.test('a job that failed permanently on the minimum-context-slot lag is requeued only by its own reviewed reason',async()=>{
   const seed=async(cls,result)=>{const j=(await registry.jobs.enqueue({...identity,operationKey:cls+':'+randomUUID(),jobClass:cls})).job;const lease=await registry.jobs.leaseById({jobId:j.jobId,token:0,owner:'fixture'});const after=await registry.jobs.fail({jobId:j.jobId,token:lease.fencingToken,error:result.reason,result});return {job:after,input:{registry,identity,jobId:j.jobId,expectedToken:after.fencingToken,expectedResultHash:canonicalHash(after.result),recoveryId:randomUUID(),actor:'operator-session',reason:'rpc-context-slot-reviewed'}};};
   const lag={outcome:'failed-permanent',category:'unknown',attempts:1,error:'failed to simulate transaction: Minimum context slot has not been reached',reason:'failed to simulate transaction: Minimum context slot has not been reached'};
   const {job,input}=await seed('fee-harvest',lag);
   assert.deepEqual(await recoverFailedJob(input),{jobId:job.jobId,recoveryId:input.recoveryId,requeued:true});assert.equal((await registry.jobs.get(job.jobId)).state,'queued');
   await assert.rejects(recoverFailedJob((await seed('fee-harvest',{...lag,reason:'failed to simulate transaction: something else',error:'x'})).input),{code:'RECOVERY_CONFLICT'},'another message');
   await assert.rejects(recoverFailedJob((await seed('fee-harvest',{...lag,category:'upstream'})).input),{code:'RECOVERY_CONFLICT'},'another category');
   await assert.rejects(recoverFailedJob((await seed('fee-harvest',{...lag,attempts:3})).input),{code:'RECOVERY_CONFLICT'},'not a first-attempt failure');
   await assert.rejects(recoverFailedJob({...(await seed('fee-harvest',lag)).input,reason:'transient-retry-reviewed'}),{code:'RECOVERY_CONFLICT'},'the generic reason still refuses it');
   await assert.rejects(recoverFailedJob((await seed('settlement',lag)).input),{code:'RECOVERY_CONFLICT'},'another job class');
  });
  await t.test('review scope, hash, deadline and permission failures remain closed',async()=>{
   const {job,input}=await failed();
   for(const change of [{expectedResultHash:'0'.repeat(64)},{expectedToken:99},{identity:{...identity,campaign:addr(4)}},{reason:'transient-retry-reviewed'}])await assert.rejects(recoverFailedJob({...input,...change}),{code:'RECOVERY_CONFLICT'});
   assert.equal((await registry.jobs.get(job.jobId)).state,'failed');
   const late=await failed({deadlineAt:new Date(Date.now()-1000).toISOString()});await assert.rejects(recoverFailedJob(late.input),{code:'RECOVERY_CONFLICT'});
   await registry.query('UPDATE jobs SET result_json=? WHERE job_id=?',[canonicalJson({...job.result,lastCategory:'auth',reason:'Signer refused'}),job.jobId]);const revised=await registry.jobs.get(job.jobId);
   await assert.rejects(recoverFailedJob({...input,expectedResultHash:canonicalHash(revised.result)}),{code:'RECOVERY_CONFLICT'});
  });
  await t.test('a job that failed only because no grant was served is recoverable once a current keeper grant exists, and nothing else is',async()=>{
   const key='fee-harvest:'+randomUUID(),j=(await registry.jobs.enqueue({...identity,operationKey:key,jobClass:'fee-harvest'})).job;
   const lease=await registry.jobs.leaseById({jobId:j.jobId,token:0,owner:'fixture'});
   const result={outcome:'failed-permanent',category:'auth',attempts:1,reason:'Signer refused the request (403): campaign not served by any capability'};
   const after=await registry.jobs.fail({jobId:j.jobId,token:lease.fencingToken,error:result.reason,result});
   const input={registry,identity,jobId:j.jobId,expectedToken:after.fencingToken,expectedResultHash:canonicalHash(after.result),recoveryId:randomUUID(),actor:'qualification-operator',reason:'expired-grant-regranted'};
   await assert.rejects(recoverFailedJob(input),{code:'RECOVERY_CONFLICT'},'no current grant: stays failed');
   const expired=await registry.capabilities.grant({...identity,kind:'keeper',programVersion:3,tags:[3,21,23,26],expiresAt:new Date(Date.now()-1000).toISOString()});
   assert.ok(expired.capabilityId);await assert.rejects(recoverFailedJob(input),{code:'RECOVERY_CONFLICT'},'an expired grant does not count');
   await registry.capabilities.grant({...identity,kind:'keeper',programVersion:3,tags:[3,21,23,26],expiresAt:new Date(Date.now()+3600000).toISOString()});
   const out=await recoverFailedJob(input);assert.equal(out.requeued,true);
   const next=await registry.jobs.get(j.jobId);assert.equal(next.state,'queued');assert.equal(next.result.category,'operator-recovery');assert.equal(next.fencingToken,after.fencingToken+1);
   assert.equal((await registry.query('SELECT reason FROM job_recoveries WHERE job_id=?',[j.jobId])).rows[0].reason,'expired-grant-regranted');
   // A genuine authorization refusal is never recoverable under this reason.
   const k2='fee-harvest:'+randomUUID(),j2=(await registry.jobs.enqueue({...identity,operationKey:k2,jobClass:'fee-harvest'})).job;
   const lease2=await registry.jobs.leaseById({jobId:j2.jobId,token:0,owner:'fixture'});
   const denied={outcome:'failed-permanent',category:'auth',attempts:1,reason:'Signer refused the request (403): tag 25 outside capability'};
   const after2=await registry.jobs.fail({jobId:j2.jobId,token:lease2.fencingToken,error:denied.reason,result:denied});
   await assert.rejects(recoverFailedJob({...input,jobId:j2.jobId,expectedToken:after2.fencingToken,expectedResultHash:canonicalHash(after2.result),recoveryId:randomUUID()}),{code:'RECOVERY_CONFLICT'});
   assert.equal((await registry.jobs.get(j2.jobId)).state,'failed');
  });
  await t.test('the reviewed decoder fix makes exactly the activity-index decoder failure recoverable once; everything else stays closed',async()=>{
   const decoder={outcome:'failed-permanent',category:'unknown',attempts:1,error:'Activity decoder requires supported finalized data',reason:'Activity decoder requires supported finalized data'};
   async function seed(jobClass,result=decoder,scope=identity){const key=jobClass+':'+randomUUID(),j=(await registry.jobs.enqueue({...scope,operationKey:key,jobClass})).job;const lease=await registry.jobs.leaseById({jobId:j.jobId,token:0,owner:'fixture'});const after=await registry.jobs.fail({jobId:j.jobId,token:lease.fencingToken,error:result.reason,result});return {job:after,input:{registry,identity:scope,jobId:j.jobId,expectedToken:after.fencingToken,expectedResultHash:canonicalHash(after.result),recoveryId:randomUUID(),actor:'operator-session-wp0',reason:'activity-decoder-fix-reviewed'}};}
   const {job,input}=await seed('activity-index');
   assert.deepEqual(await recoverFailedJob(input),{jobId:job.jobId,recoveryId:input.recoveryId,requeued:true});
   const requeued=await registry.jobs.get(job.jobId);assert.equal(requeued.state,'queued');assert.equal(requeued.fencingToken,job.fencingToken+1);assert.equal(requeued.result.category,'operator-recovery');assert.equal(requeued.result.recoveryId,input.recoveryId);
   const audit=(await registry.query('SELECT prior_result_json,prior_token,reason,actor FROM job_recoveries WHERE recovery_id=?',[input.recoveryId])).rows[0];assert.deepEqual(JSON.parse(audit.prior_result_json),decoder);assert.equal(Number(audit.prior_token),job.fencingToken);assert.equal(audit.reason,'activity-decoder-fix-reviewed');assert.equal(audit.actor,'operator-session-wp0');
   assert.deepEqual(await recoverFailedJob(input),{jobId:job.jobId,recoveryId:input.recoveryId,requeued:false},'the same recovery id is a no-op');
   // Refused: financial job classes with the same stored result, another message or category, a stale token or hash, an expired
   // deadline, a pending signed packet, a version-2 campaign.
   for(const cls of ['launch','refunds','settlement','fee-setup','operating-return'])await assert.rejects(recoverFailedJob((await seed(cls)).input),{code:'RECOVERY_CONFLICT'},cls);
   await assert.rejects(recoverFailedJob((await seed('activity-index',{...decoder,reason:'Another decoder message',error:'Another decoder message'})).input),{code:'RECOVERY_CONFLICT'});
   await assert.rejects(recoverFailedJob((await seed('activity-index',{...decoder,category:'retries-exhausted'})).input),{code:'RECOVERY_CONFLICT'});
   await assert.rejects(recoverFailedJob({...(await seed('activity-index')).input,reason:'transient-retry-reviewed'}),{code:'RECOVERY_CONFLICT'},'the generic reasons still refuse it');
   const fresh=await seed('activity-index');await assert.rejects(recoverFailedJob({...fresh.input,expectedToken:fresh.input.expectedToken+1}),{code:'RECOVERY_CONFLICT'});await assert.rejects(recoverFailedJob({...fresh.input,expectedResultHash:'0'.repeat(64)}),{code:'RECOVERY_CONFLICT'});
   const expired=await seed('activity-index');await registry.query('UPDATE jobs SET deadline_at=? WHERE job_id=?',['2020-01-01T00:00:00.000Z',expired.job.jobId]);await assert.rejects(recoverFailedJob(expired.input),{code:'RECOVERY_CONFLICT'});
   const pending=await seed('activity-index'),pendingOperation=canonicalHash({jobId:pending.job.jobId}),pendingDescriptor=canonicalJson({...identity,operationKey:pending.job.operationKey});await registry.operatorPackets.prepare({operationId:pendingOperation,descriptor:pendingDescriptor,prepared:{synthetic:true}});await registry.operatorPackets.sign({operationId:pendingOperation,attempt:1,signedBase64:'dGVzdA==',signature:'6'.repeat(64)});await assert.rejects(recoverFailedJob(pending.input),{code:'RECOVERY_CONFLICT'});
   const legacy={...identity,campaign:addr(6)};await registry.campaigns.upsert({...legacy,mode:'standard',campaignVersion:2,registryStatus:'planned'});await assert.rejects(recoverFailedJob((await seed('activity-index',decoder,legacy)).input),{code:'RECOVERY_CONFLICT'},'a version-2 campaign is out of scope');
   assert.equal((await registry.jobs.get(fresh.job.jobId)).state,'failed','a refused recovery leaves the row failed');
  });
  await t.test('a pending packet must be reconciled, never deleted by retry',async()=>{
   const {job,input}=await failed(),operationId=canonicalHash({jobId:job.jobId}),descriptor=canonicalJson({...identity,operationKey:job.operationKey});
   await registry.operatorPackets.prepare({operationId,descriptor,prepared:{synthetic:true}});
   await registry.operatorPackets.sign({operationId,attempt:1,signedBase64:'dGVzdA==',signature:'5'.repeat(64)});
   await assert.rejects(recoverFailedJob(input),{code:'RECOVERY_CONFLICT'});assert.equal((await registry.operatorPackets.latest(operationId)).status,'signed');
   assert.equal((await registry.jobs.get(job.jobId)).state,'failed');
  });
 }finally{if(pool)await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
