import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import pg from 'pg';import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {createWorkerObserver,workerPrometheus} from './observability.mjs';
import {createJobRunner} from './runner.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const scope={genesisHash:key(1),programId:key(2),campaignVersion:3};
async function fixture(fn){
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:4,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const id={...scope,campaign:key(3)};await registry.campaigns.upsert({...id,mode:'standard',registryStatus:'active'});
  const observer=createWorkerObserver({registry,scope,minimumReserveLamports:'100'});
  await fn({registry,id,observer});
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
}
test('observations require explicit PostgreSQL version/scope and bounded resource labels',()=>{
 for(const patch of [{scope:{...scope,campaignVersion:2}},{resources:{other:'private'}},{resources:{rpc:'https://secret'}},{minimumReserveLamports:'0'}])assert.throws(()=>createWorkerObserver({registry:{driver:'postgres'},scope,...patch}));
 assert.throws(()=>workerPrometheus({}));
});
test('reads classify due work, scheduled waits, expired leases and unresolved transactions without exporting payloads',{skip:!url},()=>fixture(async({registry,id,observer})=>{
 const old=new Date(Date.now()-10000).toISOString(),future=new Date(Date.now()+3600000).toISOString();
 for(const [jobClass,operationKey,notBefore]of [['launch','launch',old],['fee-harvest','fee-harvest',future],['refunds','refunds',old],['token-burn','token-burn',future],['settlement','settlement',old]])await registry.jobs.enqueue({...id,jobClass,operationKey,notBefore,payload:{secret:'must-not-export'}});
 await registry.query("UPDATE jobs SET result_json=? WHERE operation_key='refunds'",[JSON.stringify({outcome:'unknown',reconcile:{signature:'must-not-export'}})]);
 await registry.query("UPDATE jobs SET result_json=? WHERE operation_key='token-burn'",[JSON.stringify({outcome:'yield',category:'awaiting-operating-funding'})]);
 await registry.query("UPDATE jobs SET state='leased',lease_expires_at=? WHERE operation_key='settlement'",[old]);
 const foreign={...id,campaign:key(4),programId:key(5)};await registry.campaigns.upsert({...foreign,mode:'standard',registryStatus:'active'});await registry.jobs.enqueue({...foreign,jobClass:'launch',operationKey:'outside'});
 const first=await observer.read();assert.equal(first.lanes.lifecycle.due,2);assert.equal(first.lanes.lifecycle.expiredLeases,1);assert.ok(first.lanes.lifecycle.oldestDueMs>=10000);assert.equal(first.lanes.harvest.due,0);assert.equal(first.lanes.recovery.unknownTransactions,1);assert.equal(first.lanes.economics.fundingWait,1);assert.equal(first.authority.missing,1);assert.equal(first.liveness,'not-measured');
 assert.equal(first.operating.missingBudgets,1);assert.ok(first.alerts.some(a=>a.code==='missing-operating-reserve'));
 assert.ok(first.alerts.some(a=>a.code==='queue-delay'));assert.ok(!JSON.stringify(first).includes('must-not-export'));assert.ok(!JSON.stringify(first).includes(id.campaign));
 const before=(await registry.query('SELECT * FROM jobs ORDER BY job_id')).rows;
 const text=workerPrometheus(first);assert.match(text,/kids_worker_due\{lane="lifecycle"\} 2/);assert.ok(!text.includes('must-not-export'));
 await observer.read();assert.deepEqual((await registry.query('SELECT * FROM jobs ORDER BY job_id')).rows,before,'Observation cannot mutate leases or transaction evidence');
}));
test('budget holds reduce reserve headroom and latest revoked grant never appears healthy',{skip:!url},()=>fixture(async({registry,id,observer})=>{
 await registry.jobs.enqueue({...id,jobClass:'launch',operationKey:'launch'});
 await registry.budgets.put({...id,payer:key(8),policy:'fixture',reservedLamports:'200',spentLamports:'0',returnedLamports:'0'});
 await registry.query("INSERT INTO operating_spend_holds(genesis_hash,program_id,campaign,payer,operation_id,message_hash,maximum_lamports,policy,state) VALUES(?,?,?,?,?,?,?,?,?)",[id.genesisHash,id.programId,id.campaign,key(8),'unknown','a'.repeat(64),'150','fixture','held']);
 await registry.capabilities.grant({...id,programVersion:3,kind:'keeper',tags:[3,4,6],expiresAt:new Date(Date.now()+7200000).toISOString()});
 const latest=await registry.capabilities.grant({...id,programVersion:3,kind:'keeper',tags:[3,4,6],expiresAt:new Date(Date.now()+1800000).toISOString()});await registry.capabilities.revoke(latest.capabilityId);
 const result=await observer.read();assert.equal(result.operating.lowReserves,1);assert.equal(result.operating.heldLamports,'150');assert.equal(result.authority.revoked,1);assert.equal(result.authority.expiring,1);assert.ok(result.alerts.some(a=>a.code==='authority-unavailable'));
}));
test('admission observation projects elapsed refill without spending tokens; missing evidence is unavailable',{skip:!url},()=>fixture(async({registry})=>{
 const policy={ratePerSecond:1,burst:2,lanes:{lifecycle:{ratePerSecond:.5,burst:1},harvest:{ratePerSecond:.5,burst:1}}};
 await registry.admission.consume({resource:'rpc-fixture',lane:'lifecycle',policy});
 const observer=createWorkerObserver({registry,scope,resources:{rpc:'rpc-fixture',signer:'not-yet-created'}});
 const before=(await registry.query('SELECT * FROM admission_buckets')).rows;
 const result=await observer.read();assert.equal(result.admission.rpc.status,'observed');assert.equal(result.admission.rpc.lanes.lifecycle.availableRequests,0);assert.equal(result.admission.rpc.lanes.harvest.availableRequests,1);assert.equal(result.admission.signer.status,'unavailable');assert.ok(result.alerts.some(a=>a.code==='admission-unavailable'));
 assert.deepEqual((await registry.query('SELECT * FROM admission_buckets')).rows,before);
 await registry.query('UPDATE admission_buckets SET updated_ms=updated_ms-3000');assert.equal((await observer.read()).admission.rpc.lanes.lifecycle.availableRequests,1);
 await registry.query("UPDATE admission_policies SET policy_json='invalid'");await assert.rejects(observer.read());
}));
test('aggregate observation remains bounded while 100 campaigns drain independent lanes',{skip:!url,timeout:20000},()=>fixture(async({registry,observer})=>{
 for(let n=10;n<110;n++){
  const id={...scope,campaign:key(n)};await registry.campaigns.upsert({...id,mode:'standard',registryStatus:'active'});
  for(const jobClass of ['launch','fee-harvest','refunds'])await registry.jobs.enqueue({...id,jobClass,operationKey:jobClass});
 }
 let effects=0;const runner=lane=>createJobRunner({registry,scope,lane,owner:'observe-'+lane,concurrency:4,handlers:Object.fromEntries(['launch','fee-harvest','refunds'].map(c=>[c,{async run(){effects++;return {outcome:'done'};}}]))});
 const workers=['lifecycle','harvest','recovery'].map(runner),services=workers.map(w=>w.serve({pollMs:10})),durations=[];
 try{
  for(let n=0;n<10;n++){const begin=performance.now(),snapshot=await observer.read();durations.push(performance.now()-begin);assert.equal(Object.keys(snapshot.lanes).length,9);assert.ok(JSON.stringify(snapshot).length<9000);}
  const until=Date.now()+10000;while(effects<300&&Date.now()<until)await new Promise(r=>setTimeout(r,20));assert.equal(effects,300);
 }finally{workers.forEach(w=>w.stop());await Promise.all(services);await Promise.all(workers.map(w=>w.drain()));}
 const snapshot=await observer.read();assert.equal(snapshot.lanes.lifecycle.queued,0);assert.equal(snapshot.lanes.recovery.queued,0);assert.equal(snapshot.lanes.harvest.queued,0);
 assert.ok(Math.max(...durations)<3000,'Local aggregate observation query budget');
}));

test('separate per-lane RPC and signer evidence budgets remain visible without quota mutation',{skip:!url},()=>fixture(async({registry})=>{
 for(const [resource,lane]of [['life-rpc','lifecycle'],['fees-rpc','harvest'],['signer-reads','signer']])await registry.admission.consume({resource,lane,policy:{ratePerSecond:1,burst:1,lanes:{[lane]:{ratePerSecond:1,burst:1}}}});
 const resources={rpc:{lifecycle:'life-rpc',harvest:'fees-rpc'},signerRpc:'signer-reads'};
 const observer=createWorkerObserver({registry,scope,resources});
 const before=(await registry.query('SELECT * FROM admission_buckets ORDER BY resource,lane')).rows;
 const result=await observer.read();assert.equal(result.admission.rpc.status,'observed');assert.deepEqual(Object.keys(result.admission.rpc.lanes).sort(),['harvest','lifecycle']);assert.equal(result.admission.signerRpc.status,'observed');assert.equal(result.admission.signerRpc.lanes.signer.availableRequests,0);
 assert.match(workerPrometheus(result),/resource="signerRpc",lane="signer"/);
 assert.deepEqual((await registry.query('SELECT * FROM admission_buckets ORDER BY resource,lane')).rows,before);
 const wrong=createWorkerObserver({registry,scope,resources:{rpc:{recovery:'fees-rpc'}}});assert.equal((await wrong.read()).admission.rpc.status,'unavailable','Existing resource without the expected lane is not healthy');
 assert.throws(()=>createWorkerObserver({registry,scope,resources:{rpc:{secret:'life-rpc'}}}),/bounded/);
 assert.throws(()=>createWorkerObserver({registry,scope,resources:{signerRpc:{signer:'signer-reads'}}}),/bounded/);
}));

test('prewarming counts queued schedules in bounded horizons without treating them as due',{skip:!url},()=>fixture(async({registry,id,observer})=>{
 const base=Number((await registry.query('SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) ms')).rows[0].ms);
 for(const seconds of [30,120,400,900])await registry.jobs.enqueue({...id,jobClass:'launch',operationKey:'close-'+seconds,notBefore:new Date(base+seconds*1000).toISOString()});
 const snap=await observer.read();assert.equal(snap.lanes.lifecycle.due,0);assert.deepEqual(snap.lanes.lifecycle.scheduled,{within60s:1,within300s:2,within600s:3});
}));

test('capacity demand isolates expired and unfunded campaigns without hiding their alerts',{skip:!url},()=>fixture(async({registry,id,observer})=>{
 const healthy={...id,campaign:key(90)},unfunded={...id,campaign:key(91)};
 for(const campaign of [healthy,unfunded]){
  await registry.campaigns.upsert({...campaign,mode:'standard',registryStatus:'active'});
  await registry.capabilities.grant({...campaign,programVersion:3,kind:'keeper',tags:[3,4,6],expiresAt:new Date(Date.now()+7200000).toISOString()});
 }
 await registry.capabilities.grant({...id,programVersion:3,kind:'keeper',tags:[3,4,6],expiresAt:new Date(Date.now()+7200000).toISOString()});
 await registry.query('UPDATE signer_capabilities SET expires_at=? WHERE campaign=?',[new Date(Date.now()-10000).toISOString(),id.campaign]);
 for(const campaign of [id,healthy,unfunded])await registry.jobs.enqueue({...campaign,jobClass:'launch',operationKey:'launch'});
 await registry.query('UPDATE jobs SET result_json=? WHERE campaign=?',[JSON.stringify({outcome:'yield',category:'awaiting-operating-funding'}),unfunded.campaign]);
 await registry.jobs.enqueue({...healthy,jobClass:'launch',operationKey:'scheduled',notBefore:new Date(Date.now()+120000).toISOString()});
 const snap=await observer.read();assert.equal(snap.authority.expired,1);assert.equal(snap.lanes.lifecycle.fundingWait,1);assert.equal(snap.lanes.lifecycle.due,3);
 assert.deepEqual(snap.lanes.lifecycle.scaleDemand,{due:1,blockedFunding:1,blockedAuthority:1,scheduled:{within60s:0,within300s:1,within600s:1}});
 assert.ok(snap.alerts.some(a=>a.code==='authority-unavailable'));assert.ok(snap.alerts.some(a=>a.code==='operating-funding'));
 assert.ok(!JSON.stringify(snap).includes(healthy.campaign));
}));

test('hourly signing budget waits have a separate private alert and metric',{skip:!url},()=>fixture(async({registry,id,observer})=>{
 await registry.jobs.enqueue({...id,jobClass:'fee-setup',operationKey:'setup'});
 await registry.query('UPDATE jobs SET result_json=?',[JSON.stringify({outcome:'yield',category:'capacity',capacityKind:'hourly-spend'})]);
 const s=await observer.read();assert.equal(s.lanes.provisioning.signerSpendWait,1);assert.equal(s.lanes.provisioning.capacityWait,1);assert.equal(s.lanes.provisioning.fundingWait,0);
 assert.ok(s.alerts.some(a=>a.code==='signer-spend-limit'&&a.lane==='provisioning'));
 assert.match(workerPrometheus(s),/kids_worker_signer_spend_wait\{lane="provisioning"\} 1/);
}));
test('a funded campaign that nobody scheduled becomes an alert after the grace period; scheduling clears it',{skip:!url},()=>fixture(async({registry,id})=>{
 const observer=createWorkerObserver({registry,scope,minimumReserveLamports:'100',unscheduledGraceMs:60000});
 await registry.budgets.put({...id,payer:key(9),policy:'creator-funded-v1',reservedLamports:'100000000',spentLamports:'0',returnedLamports:'0'});
 let r=await observer.read();assert.equal(r.operating.unscheduledFunded,0,'inside the grace period nothing fires');assert.ok(!r.alerts.some(a=>a.code==='unscheduled-funded-campaign'));
 await registry.query('UPDATE campaigns SET created_at=?',[new Date(Date.now()-120000).toISOString()]);
 r=await observer.read();assert.equal(r.operating.unscheduledFunded,1);assert.ok(r.alerts.some(a=>a.code==='unscheduled-funded-campaign'&&a.lane==='lifecycle'));
 await registry.query("INSERT INTO standard_lifecycles(genesis_hash,program_id,campaign,descriptor_hash,initial_capability_id,terms_hash,stage,updated_at) VALUES(?,?,?,?,?,?,'scheduled',?)",[id.genesisHash,id.programId,id.campaign,'d'.repeat(64),'cap','a'.repeat(64),new Date().toISOString()]);
 r=await observer.read();assert.equal(r.operating.unscheduledFunded,0);assert.ok(!r.alerts.some(a=>a.code==='unscheduled-funded-campaign'));
 assert.equal(createWorkerObserver({registry,scope}).read.length,0);
}));
