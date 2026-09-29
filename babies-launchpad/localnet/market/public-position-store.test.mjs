import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';import {randomUUID} from 'node:crypto';import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';import {createPublicPositionStore} from './public-position-store.mjs';
const key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58(),id={genesisHash:key(200),programId:key(201),campaign:key(202)},owner=key(203),url=process.env.KIDS_TEST_POSTGRES_URL;
test('indexed launch discovery is complete-or-explicitly-partial, paged, restart-safe and fenced',{skip:!url},async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url,max:1});let pool;
 try{await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:4,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();const store=createPublicPositionStore(registry);
  const row=x=>({...x,campaignVersion:3,mode:'standard',registryStatus:'planned'});await registry.campaigns.upsert(row(id));const second={...id,campaign:key(204)};await registry.campaigns.upsert({...row(second),creator:owner});
  async function job(i=0){const j=(await registry.jobs.enqueue({...id,jobClass:'position-index',operationKey:'positions:'+i})).job;return registry.jobs.leaseById({jobId:j.jobId,token:j.fencingToken,owner:'test',ttlMs:30000});}
  const active=await job();const body={count:1,slot:10,chainTime:1790000000,sequence:'0'},receipts=[{owner,receipt:key(205)}];const publish=(args={})=>store.commit({id,body,expectedRevision:0,receipts,job:active,followup:{jobClass:'position-index',operationKey:'positions:1'},...args});
  await t.test('a creator is discoverable before indexing, but coverage is partial',async()=>{const p=await store.discover({...id,owner});assert.equal(p.campaignIds.length,1);assert.equal(p.coverage.complete,false);assert.equal(p.coverage.indexed,0);});
  await t.test('publish records receipts and successor atomically; no historical signature required',async()=>{await publish();assert.equal((await store.snapshot(id)).revision,1);const a=await store.discover({...id,owner,limit:1});assert.equal(a.campaignIds.length,1);assert.ok(a.nextCursor);const b=await createPublicPositionStore(registry).discover({...id,owner,limit:1,before:a.nextCursor});assert.deepEqual(b.campaignIds,[Object.values(id).join(':')]);assert.equal(b.nextCursor,null);assert.equal(b.coverage.indexed,1);assert.equal(b.coverage.complete,false);assert.equal(b.coverage.tokenHoldingsIndexed,false);});
  await t.test('unknown owners and ledgers cannot acquire another wallet’s campaigns',async()=>{for(const change of [{owner:key(206)},{genesisHash:key(207)},{programId:key(208)}])assert.deepEqual((await store.discover({...id,owner,...change})).campaignIds,[]);});
  await t.test('stale revisions, duplicate receipts and incomplete enumerations cannot publish',async()=>{
   await assert.rejects(publish(),{code:'POSITION_CURSOR_CONFLICT'});await assert.rejects(publish({body:{...body,count:2},receipts:[receipts[0],receipts[0]]}),/enumeration/);
   await assert.rejects(publish({expectedRevision:1,body:{...body,slot:11,count:0},receipts:[]}),/regressed/);
   await assert.rejects(publish({expectedRevision:1,body:{...body,slot:11},receipts:[{owner:key(209),receipt:key(210)}]}),/drop known/);assert.equal((await store.snapshot(id)).revision,1);
   await assert.rejects(publish({expectedRevision:1,receipts:[{owner,receipt:key(210)}]}),/identity changed/);
  });
  await t.test('quiet campaigns refresh evidence without re-enumerating; expiry prevents publication',async()=>{
   const next=await job(1);await publish({job:next,expectedRevision:1,receipts:null,body:{...body,sequence:'1',slot:11},followup:{jobClass:'position-index',operationKey:'positions:2'}});assert.equal((await store.snapshot(id)).revision,2);
   await registry.query('UPDATE jobs SET lease_expires_at=? WHERE job_id=?',[new Date(Date.now()-1000).toISOString(),next.jobId]);await assert.rejects(publish({job:next,expectedRevision:2,receipts:null,body:{...body,sequence:'2',slot:12},followup:{jobClass:'position-index',operationKey:'positions:3'}}),{code:'STALE_LEASE'});
   await registry.query('UPDATE public_position_snapshots SET updated_at=0');assert.equal((await store.discover({...id,owner})).coverage.fresh,0);
  });
 }finally{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
