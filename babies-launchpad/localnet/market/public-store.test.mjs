import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';
import {randomUUID} from 'node:crypto';import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';import {createPublicMarketStore} from './public-store.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const id={genesisHash:key(1),programId:key(2),campaign:key(3)},scope={genesis:key(1),pool:key(4)};
const market={genesis:scope.genesis,pool:scope.pool,programId:id.programId,campaign:id.campaign,mint:key(7),coinDecimals:6,launchTime:1790000000,openingPriceScaled:'1000000000',verifiedSlot:1};
const swap=(n,price,slot=n)=>({signature:String(n).repeat(64),instructionPath:'0',slot,txIndex:null,blockTime:1790000040,side:'buy',trader:key(5),inputMint:key(6),outputMint:key(7),inputAmount:'100',outputAmount:'1000',solLamports:'100',coinRaw:'1000',coinDecimals:6,priceScaled:String(price),priceSol:Number(price)/1e18,nested:false,outerProgram:null,kind:'swap_base_input',decoderVersion:1});
test('shared market pages are atomic, replay-safe, fenced and incrementally ordered',{skip:!url},async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:4,options:`-c search_path=${schema}`});
  const registry=new PostgresRegistry({pool});await registry.migrate();await registry.campaigns.upsert({...id,mode:'standard',campaignVersion:2,registryStatus:'active'});
  const store=createPublicMarketStore(registry);
  async function job(operationKey){const j=(await registry.jobs.enqueue({...id,operationKey,jobClass:'market-index'})).job;return registry.jobs.leaseById({jobId:j.jobId,token:j.fencingToken,owner:'test',ttlMs:30000});}
  const live=await job('market-live:0'),history=await job('market-backfill:initial');
  const commit=(job,stream,revision,swaps,body={head:'test'},followups=[])=>store.commitPage({scope,stream,expectedRevision:revision,swaps,body,job,followups,market:{...market,programId:job.programId,campaign:job.campaign}});
  await t.test('live and history duplicates converge with exact candle totals',async()=>{
   await Promise.all([commit(live,'live',0,[swap(3,30),swap(2,20)]),commit(history,'history',0,[swap(2,20),swap(1,10)])]);
   const rows=await store.candles(scope,{from:1790000000,to:1790000200});
   assert.equal(rows.length,1);assert.deepEqual({...rows[0],time:0},{time:0,open:'10',high:'30',low:'10',close:'30',volumeSol:'300',volumeCoin:'3000',trades:3,buys:3,sells:0});
   const first=await store.trades(scope,{limit:2});assert.deepEqual(first.trades.map(s=>s.slot),[3,2]);assert.ok(first.nextCursor);
   const next=await store.trades(scope,{limit:2,before:first.nextCursor});assert.deepEqual(next.trades.map(s=>s.slot),[1]);assert.equal(next.nextCursor,null);
   const replay=await commit(live,'live',1,[swap(3,30),swap(2,20)]);assert.equal(replay.inserted,0);
   assert.equal((await store.candles(scope,{from:1790000000,to:1790000200}))[0].volumeSol,'300');
  });
  await t.test('CAS and finality conflicts cannot publish data or advance cursor',async()=>{
   await assert.rejects(commit(live,'live',0,[swap(4,40)]),{code:'MARKET_CURSOR_CONFLICT'});
   await assert.rejects(commit(live,'live',2,[swap(4,40),swap(3,999)]),/Finalized trade data mismatch/);
   assert.equal((await store.cursor(scope,'live')).revision,2);assert.equal((await store.trades(scope)).trades.length,3);
  });
  await t.test('followup jobs commit with cursor; invalid enqueue rolls all writes back',async()=>{
   await assert.rejects(commit(live,'live',2,[swap(4,40)],{head:'four'},[{operationKey:'!',jobClass:'market-backfill'}]),/Invalid operation/);
   assert.equal((await store.cursor(scope,'live')).revision,2);assert.equal((await store.trades(scope)).trades.length,3);
   await commit(live,'live',2,[swap(4,40)],{head:'four'},[{operationKey:'market-backfill:atomic',jobClass:'market-backfill'}]);
   const linked=await registry.jobs.enqueue({...id,operationKey:'market-backfill:atomic',jobClass:'market-backfill'});assert.equal(linked.created,false);
  });
  await t.test('expired and foreign leases cannot publish market state',async()=>{
   await registry.query('UPDATE jobs SET lease_expires_at=? WHERE job_id=?',[new Date(Date.now()-1000).toISOString(),live.jobId]);
   await assert.rejects(commit(live,'live',3,[swap(5,50)]),{code:'STALE_LEASE'});
   await assert.rejects(commit({...history,campaign:key(90)},'history',1,[swap(5,50)]),{code:'STALE_LEASE'});
   assert.equal((await store.trades(scope)).trades.length,4);
  });
  await t.test('reads enforce bounded pagination and range',async()=>{
   await assert.rejects(store.trades(scope,{limit:101}),/Invalid/);
   await assert.rejects(store.candles(scope,{from:0,to:10,limit:1001}),/Invalid/);
   assert.equal((await store.trades({genesis:key(90),pool:scope.pool})).trades.length,0);
   assert.deepEqual(await store.marketFor(id),market);assert.equal(await store.marketFor({...id,programId:key(90)}),null);
   const coverage=await store.coverage(id);assert.ok(coverage.lastPollAt>0);assert.equal(coverage.pendingBackfills,1);
  });
  await t.test('verified pool identity cannot be silently changed by later pages',async()=>{
   const running=await job('market-live:identity');
   await assert.rejects(store.commitPage({scope,stream:'identity',expectedRevision:0,swaps:[],body:{},job:running,market:{...market,coinDecimals:9}}),/identity changed/);
   assert.equal((await store.cursor(scope,'identity')).revision,0);
  });
  await t.test('fee snapshots are scoped, ordered, replay-safe and roll back with the page',async()=>{
   const running=await job('market-live:fees');
   const publish=(fees,revision,swaps=[])=>store.commitPage({scope,stream:'fees',expectedRevision:revision,swaps,body:{},job:running,market:{...market,verifiedSlot:fees.slot},fees});
   await publish({status:'awaiting-setup',slot:20},0);
   assert.equal((await store.feeSnapshot(id)).slot,20);assert.equal(await store.feeSnapshot({...id,programId:key(99)}),null);
   await publish({status:'awaiting-setup',slot:19},1);assert.equal((await store.feeSnapshot(id)).slot,20);
   await publish({status:'awaiting-setup',slot:20},2);
   await assert.rejects(publish({status:'unavailable',slot:20},3),/changed within a slot/);
   await assert.rejects(publish({status:'unavailable',slot:21},3,[swap(3,999)]),/Finalized trade data mismatch/);
   assert.equal((await store.feeSnapshot(id)).slot,20);assert.equal((await store.cursor(scope,'fees')).revision,3);
   await registry.query('UPDATE jobs SET lease_expires_at=? WHERE job_id=?',[new Date(Date.now()-1000).toISOString(),running.jobId]);
   await assert.rejects(publish({status:'unavailable',slot:21},3),{code:'STALE_LEASE'});
   assert.equal((await store.feeSnapshot(id)).slot,20);
  });
  await t.test('expiry during a database page rolls back trades, cursor and successor',async()=>{
   const running=await job('market-live:expiry'),enqueue=registry.jobs.enqueue;let reached=false;
   await registry.query('UPDATE jobs SET lease_expires_at=? WHERE job_id=?',[new Date(Date.now()+200).toISOString(),running.jobId]);
   registry.jobs.enqueue=async input=>{const result=await enqueue(input);reached=true;await registry.query('SELECT pg_sleep(0.3)');return result;};
   try{await assert.rejects(commit(running,'expiring',0,[swap(5,50)],{head:'five'},[{operationKey:'market-backfill:expiry',jobClass:'market-backfill'}]),{code:'STALE_LEASE'});}
   finally{registry.jobs.enqueue=enqueue;}
   assert.equal(reached,true);assert.equal((await store.cursor(scope,'expiring')).revision,0);assert.equal((await store.trades(scope)).trades.length,4);
   assert.equal((await registry.query('SELECT job_id FROM jobs WHERE operation_key=?',['market-backfill:expiry'])).rows.length,0);
  });
 }finally{if(pool)await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
