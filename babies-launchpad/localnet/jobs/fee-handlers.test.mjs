import test from 'node:test';import assert from 'node:assert/strict';
import {feeHandler,seedFeeJobs,FEE_CLASSES} from './fee-handlers.mjs';
import {PostgresRegistry} from '../registry/registry.mjs';
import pg from 'pg';import {randomUUID} from 'node:crypto';
import {createJobRunner} from './runner.mjs';
import {PublicKey} from '@solana/web3.js';
const id={genesisHash:'ledger',programId:'program',campaign:'coin'};
function fixture(status='confirmed'){
 const calls=[],enqueued=[];const result={status,signature:'sig',blockhash:'hash',lastValidBlockHeight:100};
 const chain={async runFeeOperation(...args){calls.push(args);return result;},async signatureStatus(){return {status:'unresolved'};}};
 const registry={jobs:{get:async()=>null}};
 const ctx={jobId:"job",campaign:id,token:9,holds:()=>true,signal:new AbortController().signal,now:()=>1000000,fenced:(_label,fn)=>fn(),enqueue:async j=>{enqueued.push(j);}};
 return {calls,enqueued,result,chain,ctx,registry};
}
test('each fee class has its own recurring chain and lease-bound operation identity',async()=>{
 for(const kind of FEE_CLASSES){const f=fixture();const handler=feeHandler({chain:f.chain,registry:f.registry,kind});
  const r=await handler.run({operationKey:kind+':0',jobClass:kind},f.ctx);
  assert.equal(r.outcome,'done');assert.equal(f.enqueued.length,1);
  assert.deepEqual(f.enqueued[0],{operationKey:kind+':1',jobClass:kind,payload:{predecessorJobId:'job'},notBefore:new Date(1300000).toISOString()});
  assert.deepEqual(f.calls[0].slice(0,2),[id,kind]);assert.equal(f.calls[0][2].fencingToken,9);assert.equal(f.calls[0][2].operationId,kind+':0');
 }
});
test('unknown fees retain original packet and do not schedule a successor',async()=>{
 const f=fixture('unknown'),h=feeHandler({chain:f.chain,registry:f.registry,kind:'fee-harvest'});
 const r=await h.run({operationKey:'fee-harvest:0',jobClass:'fee-harvest'},f.ctx);
 assert.equal(r.outcome,'unknown');assert.equal(r.reconcile.signature,'sig');assert.equal(f.enqueued.length,0);
 assert.equal((await h.reconcile({result:r})).status,'unresolved');
});
test('deferred dust schedules later; a failed send must reconcile/retry, never schedule later',async()=>{
 for(const status of ['deferred','failed']){const f=fixture(status),h=feeHandler({chain:f.chain,registry:f.registry,kind:'token-burn'});
  const r=await h.run({operationKey:'token-burn:0',jobClass:'token-burn'},f.ctx);
  assert.equal(r.outcome,status==='deferred'?'done':'retry');assert.equal(f.enqueued.length,status==='deferred'?1:0);
 }
});
test('payout repair remains discoverable while the next independent check is scheduled',async()=>{
 const f=fixture('deferred'),recovery={action:'restore-wsol-account',accounts:[{owner:'dev',address:'ata',mint:'wsol'}]};
 Object.assign(f.result,{reason:'Payout account needs owner-funded restoration',recovery});
 const result=await feeHandler({chain:f.chain,registry:f.registry,kind:'distribution'}).run({operationKey:'distribution:0',jobClass:'distribution'},f.ctx);
 assert.equal(result.outcome,'done');assert.deepEqual(result.recovery,recovery);assert.equal(f.enqueued.length,1);
});
test('failed successor publication leaves the same stable operation available for replay',async()=>{
 const f=fixture(),h=feeHandler({chain:f.chain,registry:f.registry,kind:'distribution'}),j={operationKey:'distribution:0',jobClass:'distribution'};
 f.ctx.enqueue=async()=>{throw Error('database unavailable');};await assert.rejects(h.run(j,f.ctx),/database unavailable/);
 f.ctx.enqueue=async j=>f.enqueued.push(j);await h.run(j,f.ctx);
 assert.equal(f.calls[0][2].operationId,f.calls[1][2].operationId);assert.equal(f.enqueued[0].operationKey,'distribution:1');
});
test('fee seeding is deterministic and malformed/misclassified sequences cannot send',async()=>{
 const seeded=[];await seedFeeJobs({jobs:{enqueue:async j=>seeded.push(j)}},id);
 assert.deepEqual(seeded.map(j=>j.operationKey),FEE_CLASSES.map(k=>k+':0'));
 const f=fixture(),h=feeHandler({chain:f.chain,registry:f.registry,kind:'distribution'});
 for(const j of [{operationKey:'distribution:01',jobClass:'distribution'},{operationKey:'distribution:0',jobClass:'fee-harvest'}])assert.equal((await h.run(j,f.ctx)).outcome,'failed-permanent');
 assert.equal(f.calls.length,0);
});

test('successor waits for predecessor completion and refuses foreign dependencies',async()=>{
 const f=fixture();let prev={...id,operationKey:'token-burn:0',jobClass:'token-burn',state:'queued'};
 f.registry.jobs.get=async()=>prev;
 const h=feeHandler({chain:f.chain,registry:f.registry,kind:'token-burn'}),j={operationKey:'token-burn:1',jobClass:'token-burn',payload:{predecessorJobId:'old'}};
 assert.equal((await h.run(j,f.ctx)).outcome,'yield');assert.equal(f.calls.length,0);
 prev.state='done';assert.equal((await h.run(j,f.ctx)).outcome,'done');
 prev.campaign='foreign';assert.equal((await h.run(j,f.ctx)).outcome,'failed-permanent');assert.equal(f.calls.length,1);
});
test('blocked economics cannot occupy harvest, launch or refund worker slots',{skip:!process.env.KIDS_TEST_POSTGRES_URL},async t=>{
 const key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
 const identity={genesisHash:key(1),programId:key(2),campaign:key(3)};
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:process.env.KIDS_TEST_POSTGRES_URL,max:1});
 await control.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString:process.env.KIDS_TEST_POSTGRES_URL,max:4,options:`-c search_path=${schema}`});
 t.after(async()=>{await pool.end();await control.query(`DROP SCHEMA ${schema} CASCADE`);await control.end();});
 const registry=new PostgresRegistry({pool});await registry.migrate();await registry.campaigns.upsert({...identity,mode:'standard',campaignVersion:2,registryStatus:'planned'});
 let release,entered;const blocked=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const chain={async runFeeOperation(_id,kind){if(kind==='distribution'){entered();await blocked;}return {status:'deferred'};}};
 const scope={genesisHash:identity.genesisHash,programId:identity.programId,campaignVersion:2};
 const make=(lane,handlers,servedClasses)=>createJobRunner({registry,owner:lane,scope,lane,servedClasses,concurrency:1,handlers});
 const economic=make('economics',{distribution:feeHandler({registry,chain,kind:'distribution'})},['distribution']);
 const harvest=make('harvest',{'fee-harvest':feeHandler({registry,chain,kind:'fee-harvest'})},['fee-harvest']);
 const launch=make('lifecycle',{launch:{run:async()=>({outcome:'done'})}},['launch']);
 const refund=make('recovery',{refunds:{run:async()=>({outcome:'done'})}},['refunds']);
 const jobs=[];
 for(const [jobClass,operationKey]of [['distribution','distribution:0'],['fee-harvest','fee-harvest:0'],['launch','launch'],['refunds','refunds']])jobs.push((await registry.jobs.enqueue({...identity,jobClass,operationKey})).job);
 const pending=economic.tick();
 try{
  await started;await Promise.all([harvest.tick(),launch.tick(),refund.tick()]);
  assert.equal((await registry.jobs.get(jobs[0].jobId)).state,'leased');
  for(const job of jobs.slice(1))assert.equal((await registry.jobs.get(job.jobId)).state,'done');
 }finally{release();await pending;}
});
