import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import pg from 'pg';import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from './registry.mjs';
import {createJobRunner} from '../jobs/runner.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const id={genesisHash:addr(1),programId:addr(2),campaign:addr(3)};
async function fixture(fn){const schema='kids_test_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url,max:1}),pools=[];
 try{await admin.query(`CREATE SCHEMA ${schema}`);const make=skew=>{const pool=new pg.Pool({connectionString:url,max:4,options:`-c search_path=${schema}`,statement_timeout:10000});pools.push(pool);return new PostgresRegistry({pool,now:()=>Date.now()+skew});};
  const slow=make(-86400000),fast=make(86400000);await slow.migrate();await slow.campaigns.upsert({...id,mode:'standard',campaignVersion:3,registryStatus:'planned'});await fn(slow,fast);
 }finally{await Promise.all(pools.map(p=>p.end()));await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}}
const expire=(r,j)=>r.query("UPDATE jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE job_id=?",[j.jobId]);
test('all PostgreSQL job lease APIs ignore fast and slow host clocks',{skip:!url},()=>fixture(async(slow,fast)=>{
 const enqueue=async(key,extra={})=>(await slow.jobs.enqueue({...id,operationKey:key,jobClass:key,...extra})).job;
 for(const mode of ['lease','leaseById','leaseNext']){
  const j=await enqueue(mode),started=Date.now();
  const args={jobId:j.jobId,token:0,owner:'worker',ttlMs:5000,jobClass:mode,jobClasses:[mode]};
  const active=await fast.jobs[mode](args);assert.equal(active.jobId,j.jobId);
  assert.ok(Date.parse(active.leaseExpiresAt)>=started+4900&&Date.parse(active.leaseExpiresAt)<=Date.now()+5100);
  assert.equal(await slow.jobs.holds({...args,token:active.fencingToken}),true);
  assert.equal(await slow.jobs.renew({...args,token:active.fencingToken}),true);
  const renewed=await fast.jobs.get(j.jobId);assert.ok(Math.abs(Date.parse(renewed.leaseExpiresAt)-Date.now()-5000)<500);
  await expire(fast,j);assert.equal(await slow.jobs.holds({...args,token:active.fencingToken}),false);
  assert.equal(await slow.jobs.renew({...args,token:active.fencingToken}),false);
  for(const action of ['complete','fail','requeue'])await assert.rejects(slow.jobs[action]({jobId:j.jobId,token:active.fencingToken,error:'test'}),{code:'STALE_LEASE'});
  const reclaimed=await slow.jobs.leaseNext({owner:'replacement',jobClasses:[mode]});assert.equal(reclaimed.fencingToken,active.fencingToken+1);
  await fast.jobs.complete({jobId:j.jobId,token:reclaimed.fencingToken});
 }
 const future=await enqueue('future',{notBefore:new Date(Date.now()+3600000).toISOString()});
 assert.equal(await fast.jobs.leaseNext({owner:'fast',jobClasses:['future']}),null);
 assert.equal((await fast.jobs.due()).some(j=>j.jobId===future.jobId),false);
 assert.equal((await slow.jobs.due()).some(j=>j.jobId===future.jobId),false);
 assert.ok(Math.abs(Date.parse(future.createdAt)-Date.now())<1000);
}));
test('waiting for a database row lock cannot publish after lease expiry',{skip:!url},()=>fixture(async(slow,fast)=>{
 const j=(await slow.jobs.enqueue({...id,operationKey:'blocked',jobClass:'launch'})).job;
 const active=await fast.jobs.leaseNext({owner:'worker',jobClasses:['launch'],ttlMs:1000});
 const blocker=await slow.pool.connect();let pending;
 try{await blocker.query('BEGIN');await blocker.query('SELECT job_id FROM jobs WHERE job_id=$1 FOR UPDATE',[j.jobId]);
  pending=slow.jobs.complete({jobId:j.jobId,token:active.fencingToken}).then(()=>({success:true}),error=>({error}));
  await blocker.query('SELECT pg_sleep(1.1)');await blocker.query('COMMIT');
  const result=await pending;assert.equal(result.error?.code,'STALE_LEASE');assert.equal((await fast.jobs.get(j.jobId)).state,'leased');
 }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;}
}));

test('skewed worker deadlines and retry scheduling use its database lease baseline',{skip:!url},()=>fixture(async(slow,fast)=>{
 const j=(await slow.jobs.enqueue({...id,operationKey:'yield',jobClass:'settlement',deadlineAt:new Date(Date.now()+60000).toISOString()})).job;
 const runner=createJobRunner({registry:fast,owner:'skewed-runner',lane:'lifecycle',now:()=>Date.now()+86400000,handlers:{settlement:{async run(job,ctx){assert.ok(Math.abs(ctx.now()-Date.now())<1000);return {outcome:'yield',delayMs:5000};}}}});
 try{await runner.tick();const after=await slow.jobs.get(j.jobId);assert.equal(after.state,'queued');assert.equal(after.result.outcome,'yield');assert.ok(Math.abs(Date.parse(after.notBefore)-Date.now()-5000)<1000);}
 finally{runner.stop();await runner.drain();}
}));
