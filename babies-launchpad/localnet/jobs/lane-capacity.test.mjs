// Scheduling/isolation evidence on real PostgreSQL, not a mainnet TPS benchmark.
// Chain calls are deliberately blocked synthetic handlers so the test can prove
// refunds and fees progress even when every lifecycle slot is occupied.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {createJobRunner} from './runner.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL;
const key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function bounded(promise) {
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Lane isolation test timed out')),30000);})]);}
 finally {clearTimeout(timer);}
}

test('100 simultaneous closes cannot block fee harvesting or refunds behind 2000 history jobs', {skip:!url,timeout:45000}, async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1}),pools=[],workers=[],services=[];
 const unblock=deferred(),entered=deferred(),paid=deferred(),closed=deferred();
 let busy=0;const counts={launch:0,'fee-harvest':0,refunds:0};
 try {
  await control.query(`CREATE SCHEMA ${schema}`);
  const make=()=>{const pool=new pg.Pool({connectionString:url,max:4,options:`-c search_path=${schema}`,statement_timeout:10000});pools.push(pool);return new PostgresRegistry({pool});};
  const registry=make();await registry.migrate();
  await registry.query('CREATE TABLE synthetic_effects(job_id TEXT PRIMARY KEY,job_class TEXT NOT NULL,campaign TEXT NOT NULL)');
  const scope={genesisHash:key(250),programId:key(251),campaignVersion:3};
  for(let n=1;n<=100;n++){
   const id={genesisHash:scope.genesisHash,programId:scope.programId,campaign:key(n)};
   await registry.campaigns.upsert({...id,campaignVersion:3,mode:'standard',registryStatus:'active'});
   for(const jobClass of Object.keys(counts))await registry.jobs.enqueue({...id,jobClass,operationKey:jobClass+':once'});
   for(let page=0;page<20;page++)await registry.jobs.enqueue({...id,jobClass:'market-backfill',operationKey:'history:'+page});
   // Scheduling retries must not duplicate a fee entitlement/job.
   await registry.jobs.enqueue({...id,jobClass:'fee-harvest',operationKey:'fee-harvest:once'});
  }
  const start=performance.now();
  const launchDb=make(),harvestDb=make(),recoveryDb=make();
  for(const [lane,db]of [['lifecycle',launchDb],['harvest',harvestDb],['recovery',recoveryDb]]){
   const handler={async run(job,ctx){
    if(job.jobClass==='launch'&&busy<4){busy++;if(busy===4)entered.resolve();await unblock.promise;}
    await ctx.fenced('synthetic-effect',()=>db.query('INSERT INTO synthetic_effects(job_id,job_class,campaign) VALUES(?,?,?) ON CONFLICT(job_id) DO NOTHING',[job.jobId,job.jobClass,job.campaign]));
    counts[job.jobClass]++;
    if(counts['fee-harvest']===100&&counts.refunds===100)paid.resolve();
    if(counts.launch===100)closed.resolve();
    return {outcome:'done',synthetic:true};
   }};
   const runner=createJobRunner({registry:db,owner:'capacity-'+lane,lane,scope,concurrency:4,handlers:{launch:handler,'fee-harvest':handler,refunds:handler}});
   workers.push(runner);services.push(runner.serve({pollMs:10}));
  }
  await bounded(entered.promise);await bounded(paid.promise);
  const independentMs=performance.now()-start;
  assert.equal(counts.launch,0,'all lifecycle slots remain blocked');
  assert.equal(counts['fee-harvest'],100);assert.equal(counts.refunds,100);
  unblock.resolve();await bounded(closed.promise);
  for(const w of workers)w.stop();await Promise.all(services);await Promise.all(workers.map(w=>w.drain()));
  const rows=(await registry.query('SELECT job_class,state,COUNT(*) n FROM jobs GROUP BY job_class,state')).rows;
  for(const jobClass of Object.keys(counts))assert.deepEqual(rows.filter(r=>r.job_class===jobClass).map(r=>[r.state,Number(r.n)]),[['done',100]]);
  assert.deepEqual(rows.filter(r=>r.job_class==='market-backfill').map(r=>[r.state,Number(r.n)]),[['queued',2000]]);
  assert.equal(Number((await registry.query('SELECT COUNT(*) n FROM synthetic_effects')).rows[0].n),300);
  t.diagnostic(JSON.stringify({campaigns:100,independentFeeJobs:100,independentRefundJobs:100,blockedLifecycleSlots:4,backfillBacklog:2000,independentLanesMs:Math.round(independentMs),totalMs:Math.round(performance.now()-start),chain:'synthetic; no network capacity claim'}));
 } finally {
  unblock.resolve();for(const w of workers)w.stop();await Promise.allSettled(services);await Promise.allSettled(workers.map(w=>w.drain()));
  await Promise.all(pools.map(p=>p.end()));await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();
 }
});
