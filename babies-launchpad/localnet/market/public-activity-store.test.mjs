import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';import {createPublicActivityStore} from './public-activity-store.mjs';import {createPublicActivityReader} from './public-activity-reader.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const id={genesisHash:key(1),programId:key(2),campaign:key(3)},identity={genesisHash:key(1),launchProgram:key(2),campaign:key(3),mint:key(4),coinDecimals:6,programVersion:3,mode:'standard'};
const event=(n,kind='burn-child',assets=[{mint:key(4),amountRaw:'1',decimals:6,direction:'burn',account:null,role:null}],failed=false)=>({signature:String(n).repeat(88),instructionPath:'0',slot:n,blockTimeUnix:100,decoderVersion:3,campaign:id.campaign,program:'launch',kind,actor:key(5),assets,detail:null,failed,nested:false});
test('activity pages preserve exact burns, isolate scopes, filter noise and publish atomically',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:4,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();await registry.campaigns.upsert({...id,campaignVersion:3,mode:'standard',registryStatus:'planned'});
  const store=createPublicActivityStore(registry),queued=(await registry.jobs.enqueue({...id,jobClass:'activity-index',operationKey:'activity-live:0'})).job,job=await registry.jobs.leaseById({jobId:queued.jobId,token:queued.fencingToken,owner:'test',ttlMs:30000});
  const commit=(events,revision=0,extra={})=>store.commit({identity,stream:'live',expectedRevision:revision,body:{sequence:'0',creationVerified:true,providerHead:{slot:3,time:Math.floor(Date.now()/1000)}},events,job,...extra});
  await commit([event(2),event(3,'settle',[]),event(4,'claim-participant',[],true)]);
  assert.deepEqual((await store.page(id)).events.map(e=>e.kind),['burn-child']);assert.equal((await store.page(id)).events[0].assets[0].amountRaw,'1');
  assert.equal((await store.page(id,{filter:'failed'})).events[0].failed,true);const first=await store.page(id,{filter:'all',limit:2});assert.equal(first.events.length,2);assert.ok(first.nextCursor);assert.equal((await store.page(id,{filter:'all',before:first.nextCursor,limit:2})).events.length,1);
  assert.equal((await store.page({...id,programId:key(9)})).events.length,0);
  await assert.rejects(commit([] ,1,{identity:{...identity,launchProgram:key(9)},job:{...job,programId:key(9)}}),{code:'STALE_LEASE'});
  await commit([event(2)],1);await assert.rejects(commit([event(2,'fees-collect')],2),/changed/);assert.equal((await store.cursor(id,'live')).revision,2);
  await assert.rejects(commit([event(5)],2,{identity:{...identity,mint:key(9)}}),/identity changed/);
  await assert.rejects(commit([event(5)],2,{followups:[{operationKey:'!',jobClass:'activity-index'}]}));assert.equal((await store.page(id,{filter:'all'})).events.length,3);
  const reader=createPublicActivityReader({store,...id});let count=0;const status=store.status;store.status=async i=>{count++;return status(i);};const reads=await Promise.all(Array.from({length:100},()=>reader.read({campaign:id.campaign})));assert.equal(count,1);assert.ok(reads.every(r=>r.events.length===1&&r.coverage.complete));
  await registry.query('UPDATE jobs SET lease_expires_at=? WHERE job_id=?',[new Date(Date.now()-1000).toISOString(),job.jobId]);await assert.rejects(commit([event(5)],2),{code:'STALE_LEASE'});assert.equal((await store.page(id)).events.length,1);
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
