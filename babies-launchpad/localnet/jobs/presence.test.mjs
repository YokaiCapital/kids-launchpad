import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import pg from 'pg';import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {createWorkerPresence,presencePolicy} from './presence.mjs';
import {createWorkerObserver,workerPrometheus} from './observability.mjs';
import {createJobRunner} from './runner.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58(),scope={genesisHash:key(1),programId:key(2),campaignVersion:3};
const health=()=>({active:0,dispatchAgeMs:0,oldestActiveMs:0,finished:0});
async function fixture(fn){const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;try{await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:4,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();await fn(registry);}finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}}
test('presence rejects ambiguous scopes, labels and expectations',()=>{
 for(const required of [null,[],{unknown:{minimum:1,classes:['launch']}},{harvest:{minimum:0,classes:['fee-harvest']}},{harvest:{minimum:1,classes:['refunds']}},{harvest:{minimum:1,classes:['fee-harvest','fee-harvest']}}])assert.throws(()=>presencePolicy(required));
 for(const patch of [{capacity:0},{intervalMs:1},{scope:{...scope,campaignVersion:1}},{classes:['refunds']},{bootId:'private-worker-url'}])assert.throws(()=>createWorkerPresence({registry:{driver:'postgres'},scope,lane:'harvest',classes:['fee-harvest'],capacity:2,health,...patch}));
});
test('observer detects missing, stale, wrong-class, wrong-scope and stopped processes without exporting identity',{skip:!url},()=>fixture(async registry=>{
 const requiredWorkers={harvest:{minimum:2,classes:['fee-harvest']},lifecycle:{minimum:1,classes:['launch','settlement','lifecycle-control']}},observer=createWorkerObserver({registry,scope,requiredWorkers});
 const open=(lane,classes,extra={})=>createWorkerPresence({registry,scope,lane,classes,capacity:2,health,...extra}),workers=[open('harvest',['fee-harvest']),open('harvest',['fee-harvest']),open('lifecycle',['launch','settlement']),open('harvest',['fee-harvest'],{scope:{...scope,programId:key(9)}})];
 try{
  assert.equal((await observer.read()).presence.lanes.harvest.alive,0);await Promise.all(workers.map(w=>w.start()));
  let view=await observer.read();assert.equal(view.presence.lanes.harvest.alive,2);assert.equal(view.presence.lanes.lifecycle.alive,0);assert.equal(view.liveness,'degraded');assert.ok(!JSON.stringify(view).includes(key(9)));assert.ok(!JSON.stringify(view).includes('boot_id'));
  const lifecycle=open('lifecycle',['launch','settlement','lifecycle-control']);workers.push(lifecycle);await lifecycle.start();view=await observer.read();assert.equal(view.liveness,'observed');assert.match(workerPrometheus(view),/kids_worker_presence_alive\{lane="harvest"\} 2/);
  await registry.query("UPDATE worker_presence SET observed_ms=observed_ms-30000 WHERE lane='harvest'");view=await observer.read();assert.equal(view.presence.lanes.harvest.alive,0);assert.ok(view.alerts.some(a=>a.code==='worker-missing'));
  await lifecycle.stop();assert.equal((await observer.read()).presence.lanes.lifecycle.alive,0);await assert.rejects(lifecycle.start());
 }finally{await Promise.all(workers.map(w=>w.stop()));}
}));
test('terminal process records cannot revive; unhealthy dispatch and long jobs are distinct from process death',{skip:!url},()=>fixture(async registry=>{
 const bootId=randomUUID(),config={registry,scope,lane:'harvest',classes:['fee-harvest'],capacity:2,bootId,health:()=>({active:1,dispatchAgeMs:25000,oldestActiveMs:12000,finished:7})},worker=createWorkerPresence(config);
 await worker.start();const observer=createWorkerObserver({registry,scope,requiredWorkers:{harvest:{minimum:1,classes:['fee-harvest'],maxJobMs:10000}}});
 let view=await observer.read();assert.equal(view.presence.lanes.harvest.alive,1);assert.ok(view.alerts.some(a=>a.code==='worker-dispatch-stalled'));assert.ok(view.alerts.some(a=>a.code==='worker-job-slow'));assert.ok(!view.alerts.some(a=>a.code==='worker-missing'));
 await worker.stop();const late=createWorkerPresence(config);await assert.rejects(late.start(),/generation refused/);await assert.rejects(late.stop(),/generation refused/);assert.equal((await observer.read()).presence.lanes.harvest.alive,0);
}));
test('runner reports progress without leaking campaign IDs and heartbeats stop cleanly while requests finish',{skip:!url},()=>fixture(async registry=>{
 const id={...scope,campaign:key(4)};await registry.campaigns.upsert({...id,mode:'standard',registryStatus:'active'});await registry.jobs.enqueue({...id,jobClass:'fee-harvest',operationKey:'fee-harvest'});
 let entered,release;const enteredPromise=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
 const runner=createJobRunner({registry,scope,lane:'harvest',owner:'presence-test',concurrency:1,handlers:{'fee-harvest':{async run(){entered();await hold;return {outcome:'done'};}}}});
 const worker=createWorkerPresence({registry,scope,lane:'harvest',classes:['fee-harvest'],capacity:1,health:runner.health,intervalMs:1000});await worker.start();const serve=runner.serve({pollMs:10});await enteredPromise;
 try{await new Promise(r=>setTimeout(r,1100));const row=(await registry.query('SELECT * FROM worker_presence')).rows[0];assert.ok(Number(row.sequence)>=2);assert.equal(row.active,1);assert.ok(Number(row.oldest_active_ms)>=900);assert.ok(runner.health().dispatchAgeMs<100);assert.ok(!JSON.stringify(runner.health()).includes(id.campaign));}
 finally{runner.stop();release();await serve;await runner.drain();await worker.stop();}
 const row=(await registry.query('SELECT * FROM worker_presence')).rows[0];assert.equal(row.state,'stopped');assert.equal(row.active,0);assert.equal(Number(row.finished),1);const seq=row.sequence;await new Promise(r=>setTimeout(r,1050));assert.equal((await registry.query('SELECT sequence FROM worker_presence')).rows[0].sequence,seq);
}));

test('lifecycle and market service starts publish exact served classes and stop after draining',{skip:!url},()=>fixture(async registry=>{
 const {createPublicWorker}=await import('./service.mjs'),{createPublicMarketWorker}=await import('../market/public-service.mjs');
 const policy={ratePerSecond:100,burst:100,lanes:{accounting:{ratePerSecond:50,burst:50},indexing:{ratePerSecond:50,burst:50}}};
 const base={mode:'localnet-rehearsal',genesisHash:scope.genesisHash,programId:scope.programId,programVersion:3,rpcUrl:'http://127.0.0.1:19199',concurrency:2,rpcAdmission:{resource:'presence-service',policy}};
 const fetchImpl=async(_url,init)=>{const p=JSON.parse(init.body),result=p.method==='getGenesisHash'?scope.genesisHash:{context:{slot:1},value:{data:['','base64'],executable:true,lamports:1,owner:key(5),rentEpoch:0}};return new Response(JSON.stringify({jsonrpc:'2.0',id:p.id,result}),{headers:{'content-type':'application/json'}});};
 const workers=[await createPublicWorker({registry,config:{...base,lane:'accounting',operating:{payer:key(3),policy:'fixture'}},fetchImpl,reconciliationFactory:()=>({reconcile:async()=>{throw Error('unexpected');}})}),await createPublicMarketWorker({registry,config:{...base,lane:'indexing'},fetchImpl})],runs=workers.map(w=>w.start());
 const observer=createWorkerObserver({registry,scope,requiredWorkers:{accounting:{minimum:1,classes:['operating-reconcile']},indexing:{minimum:1,classes:['campaign-index','market-index','fee-index','activity-index','position-index']}}});
 try{let ready=false;for(let n=0;n<100;n++){if((await observer.read()).liveness==='observed'){ready=true;break;}await new Promise(r=>setTimeout(r,10));}assert.equal(ready,true);}
 finally{await Promise.all(workers.map(w=>w.stop()));await Promise.all(runs);}
 const rows=(await registry.query('SELECT state,active FROM worker_presence')).rows;assert.equal(rows.length,2);assert.ok(rows.every(r=>r.state==='stopped'&&r.active===0));assert.equal((await observer.read()).liveness,'degraded');
}));

test('100 process identities remain bounded and independent during concurrent startup and shutdown',{skip:!url,timeout:20000},()=>fixture(async registry=>{
 const workers=Array.from({length:100},()=>createWorkerPresence({registry,scope,lane:'harvest',classes:['fee-harvest'],capacity:2,health}));
 const observer=createWorkerObserver({registry,scope,requiredWorkers:{harvest:{minimum:100,classes:['fee-harvest']}}});
 try{await Promise.all(workers.map(w=>w.start()));const view=await observer.read();assert.equal(view.presence.lanes.harvest.alive,100);assert.equal(view.presence.lanes.harvest.capacity,200);assert.equal(view.liveness,'observed');assert.ok(JSON.stringify(view).length<10000);}
 finally{await Promise.all(workers.map(w=>w.stop()));}
 assert.equal((await observer.read()).presence.lanes.harvest.alive,0);
}));
