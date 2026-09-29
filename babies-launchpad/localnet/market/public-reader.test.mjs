import test from 'node:test';import assert from 'node:assert/strict';import {PublicKey} from '@solana/web3.js';
import {createPublicMarketReader} from './public-reader.mjs';
const key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
function fixture(options={}){
 let now=100000,calls=0,coverage={lastPollAt:99000,openingVerified:true,pendingBackfills:0,failedJobs:0,lastIndexedTransactionSlot:10,providerHead:{slot:10,time:99}};
 const market={pool:key(4),mint:key(5),coinDecimals:6,launchTime:90,openingPriceScaled:'1000000000'};
 const store={marketFor:async id=>{calls++;assert.equal(id.genesisHash,key(1));assert.equal(id.programId,key(2));return id.campaign===key(3)?market:null;},coverage:async()=>coverage,trades:async()=>({trades:[],nextCursor:null}),candles:async()=>[]};
 const reader=createPublicMarketReader({store,genesisHash:key(1),programId:key(2),now:()=>now,...options});
 return {reader,store,request:{campaign:key(3)},setNow:n=>now=n,setCoverage:c=>coverage={...coverage,...c},calls:()=>calls};
}
test('idle pool exposes opening reference without manufacturing trades or volume',async()=>{
 const f=fixture(),r=await f.reader.read(f.request);
 assert.equal(r.status,'no-trades');assert.deepEqual(r.trades,[]);assert.equal(r.commitment,'finalized');assert.equal(r.openingReference.isTrade,false);assert.equal(r.openingReference.source,'pool-opening');assert.equal(r.freshness.ageMs,1000);assert.equal(r.coverage.complete,true);
 assert.equal(r.genesisHash,key(1));assert.equal(r.programId,key(2));
 assert.deepEqual((await f.reader.read({...f.request,kind:'candles',from:60,to:180})).candles,[]);
 const partial=await f.reader.read({...f.request,kind:'candles',from:61,to:119});assert.equal(partial.from,60);assert.equal(partial.to,120);
 assert.equal((await f.reader.read({campaign:key(9)})).status,'not-indexed');
});
test('history gaps, failures and stale polling are explicit, never reported as healthy',async()=>{
 const f=fixture({cacheMs:0});f.setCoverage({pendingBackfills:1});let r=await f.reader.read(f.request);assert.equal(r.status,'backfilling');assert.equal(r.coverage.complete,false);
 f.setCoverage({pendingBackfills:0,openingVerified:false});r=await f.reader.read(f.request);assert.equal(r.status,'backfilling');assert.equal(r.coverage.complete,false);f.setCoverage({openingVerified:true});
 f.setCoverage({failedJobs:1});assert.equal((await f.reader.read(f.request)).status,'indexing-error');
 f.setCoverage({failedJobs:0,pendingBackfills:0});f.setNow(200000);r=await f.reader.read(f.request);assert.equal(r.status,'stale');assert.equal(r.freshness.stale,true);
 f.setCoverage({lastPollAt:null});assert.equal((await f.reader.read(f.request)).status,'starting');
});
test('100 concurrent viewers share one read; distinct active queries are bounded',async()=>{
 const f=fixture({maxCacheEntries:1});let release;
 const wait=new Promise(r=>{release=r;}),original=f.store.marketFor;f.store.marketFor=async id=>{await wait;return original(id);};
 const requests=Array.from({length:100},()=>f.reader.read(f.request));
 await assert.rejects(f.reader.read({...f.request,limit:1}),{code:'CAPACITY_WAIT'});
 release();const rows=await Promise.all(requests);assert.ok(rows.every(r=>r.status==='no-trades'));assert.equal(f.calls(),1);assert.equal(f.reader.cacheSize(),1);
 f.setNow(103000);await f.reader.read(f.request);assert.equal(f.calls(),2);
});
test('invalid ranges and pages stop before storage; failures are not cached',async()=>{
 const f=fixture();
 for(const request of [{campaign:'no'},{...f.request,limit:101},{...f.request,cursor:'!'}, {...f.request,kind:'candles',from:0,to:1000000},{...f.request,kind:'candles',from:0,to:60,interval:'__proto__'}])await assert.rejects(f.reader.read(request));
 assert.equal(f.calls(),0);const original=f.store.marketFor;f.store.marketFor=async()=>{throw Error('Database unavailable');};
 await assert.rejects(f.reader.read(f.request),/unavailable/);assert.equal(f.reader.cacheSize(),0);
 f.store.marketFor=original;assert.equal((await f.reader.read(f.request)).status,'no-trades');
});
test('fresh polling cannot disguise an old, missing or future chain head',async()=>{
 const f=fixture({cacheMs:0});f.setNow(300000);f.setCoverage({lastPollAt:299999,providerHead:{slot:12,time:100}});
 let r=await f.reader.read(f.request);assert.equal(r.status,'stale');assert.equal(r.freshness.ageMs,1);assert.equal(r.freshness.provider.ageMs,200000);assert.equal(r.freshness.stale,true);
 for(const providerHead of [null,{slot:12,time:340},{slot:12,time:null}]){
  f.setCoverage({providerHead});r=await f.reader.read(f.request);assert.equal(r.status,'stale');assert.equal(r.freshness.stale,true);
 }
 f.setCoverage({providerHead:{slot:13,time:290}});r=await f.reader.read(f.request);assert.equal(r.status,'no-trades');assert.equal(r.freshness.provider.stale,false);
 assert.deepEqual(r.trades,[]);assert.equal(r.openingReference.isTrade,false);
});

test('fee reads are scoped, single-flight and do not query trade history; stale chain heads stay stale',async()=>{
 const f=fixture({cacheMs:0});let feeReads=0;
 f.store.feeSnapshot=async id=>{assert.equal(id.campaign,key(3));feeReads++;return {status:'awaiting-setup',slot:10,chainTime:99,updatedAt:99000};};
 f.store.trades=async()=>{throw Error('Fee reads must not query trades');};f.store.candles=f.store.trades;
 const rows=await Promise.all(Array.from({length:100},()=>f.reader.read({...f.request,kind:'fees'})));
 assert.equal(feeReads,1);assert.ok(rows.every(r=>r.fees.status==='awaiting-setup'&&!r.freshness.stale));
 f.setNow(300000);assert.equal((await f.reader.read({...f.request,kind:'fees'})).freshness.stale,true);
 f.store.feeSnapshot=async()=>null;assert.equal((await f.reader.read({...f.request,kind:'fees'})).fees,null);
});
