// Ingest gates (plan section 5): replay more than 200 signatures; the cursor never advances over an unresolved
// range; page budgets leave explicit gaps that close later; provisional rollback; restart at a persistence
// boundary; websocket wake-up only triggers the poll.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openMarketStore} from '../market/store.mjs';
import {createMarketIngest,txIndexes,deriveWsUrl} from '../market/ingest.mjs';
import {RpcError} from '../market/rpc.mjs';
const POOL=JSON.parse(readFileSync(new URL('./fixtures/market/pool.json',import.meta.url),'utf8'));
const IDENTITY={...POOL,genesis:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',campaign:'Campaign1111111111111111111111111111111111',mint:POOL.mint1,coinDecimals:6};
const TEMPLATE=JSON.parse(readFileSync(new URL('./fixtures/market/swap-direct-buy.json',import.meta.url),'utf8'));
const FEE=JSON.parse(readFileSync(new URL('./fixtures/market/fee-collect-withdraw.json',import.meta.url),'utf8'));
const sig=n=>('s'+n).replace(/0/g,'o').padEnd(64,'q').slice(0,64)+'ZZZZ';// base58 only: no zero
/** A fake chain: n signatures numbered from `start` (oldest first), one per slot; every 10th is a fee collection, not a trade. */
function chain(n,{start=1000,time=1790129340}={}){
 const entries=[];
 for(let i=0;i<n;i++){const s=sig(start+i);const trade=i%10!==9;const tx=structuredClone(trade?TEMPLATE:FEE);tx.slot=start+i;tx.blockTime=time+i*7;tx.transaction.signatures[0]=s;entries.push({signature:s,slot:tx.slot,blockTime:tx.blockTime,err:null,confirmationStatus:i<n-3?'finalized':'confirmed',tx,trade});}
 return entries;
}
function fakeRpc(entries,{failing=new Map(),statuses=null}={}){
 const calls=[];
 const newestFirst=()=>[...entries].reverse();
 return {calls,entries,failing,
  async call(method,params){
   calls.push(method);
   if(method==='getSignaturesForAddress'){
    const {before,until,limit}=params[1];let list=newestFirst();
    if(before){const i=list.findIndex(e=>e.signature===before);list=i<0?[]:list.slice(i+1);}
    if(until){const i=list.findIndex(e=>e.signature===until);if(i>=0)list=list.slice(0,i);}
    return list.slice(0,limit).map(({signature,slot,blockTime,err,confirmationStatus})=>({signature,slot,blockTime,err,confirmationStatus,memo:null}));
   }
   if(method==='getTransaction'){
    const s=params[0];const f=failing.get(s);
    if(f){if(f==='null')return null;if(f==='transient'){throw new RpcError('getTransaction: HTTP 429',{category:'exhausted',method,status:429});}if(f==='version'){throw new RpcError('getTransaction: rpc -32015 Transaction version (2) is not supported',{category:'unsupported-version',method,code:-32015});}}
    assert.equal(params[1].maxSupportedTransactionVersion,1,'the worker asks for the highest verified version');
    return entries.find(e=>e.signature===s)?.tx??null;
   }
   if(method==='getSignatureStatuses')return {value:params[0].map(s=>statuses?statuses(s):{confirmationStatus:'finalized',err:null})};
   if(method==='getBlockTime')return entries.find(e=>e.slot===params[0])?.blockTime??null;
   throw Error('unexpected '+method);
  },
  stats:()=>({calls:calls.length})};
}
const ingestFor=(rpc,store,options={},extra={})=>createMarketIngest({identity:IDENTITY,rpc,store,now:()=>1790200000000,options:{pageLimit:100,maxPagesPerTick:3,concurrency:3,finalizeBatch:100,provisionalMinAgeMs:0,...options},...extra});
const scope={genesis:IDENTITY.genesis,pool:IDENTITY.pool};

test('cold start replays more than 200 signatures back to the launch: first page live, then bounded backfill pages, cursor complete, no gaps',async()=>{
 const entries=chain(450),rpc=fakeRpc(entries),store=openMarketStore(),ingest=ingestFor(rpc,store);
 await ingest.tick();
 let c=store.getCursor(scope);assert.equal(c.newestSignature,sig(1449));assert.equal(c.backfillComplete,false,'450 signatures need more than one tick: one live page plus three backfill pages');
 assert.equal(store.stats(scope).swaps,400-40,'first live page 100 + 3 backfill pages of 100, minus one fee collection in ten');
 await ingest.tick();
 c=store.getCursor(scope);assert.equal(c.backfillComplete,true);assert.deepEqual(c.gaps,[]);assert.equal(c.oldestSignature,sig(1000));
 const expected=entries.filter(e=>e.trade).length;
 assert.equal(store.stats(scope).swaps,expected);assert.equal(store.stats(scope).provisional,0,'the newest three were confirmed only and the finalization pass marked them');assert.equal(ingest.stats().finalized,2,'two of the three newest are trades (the third is a fee collection)');
 const s=ingest.stats();assert.equal(s.transactionsFetched,450);assert.equal(s.decodeFailures,0);assert.equal(s.openGaps,0);assert.equal(s.backfillComplete,true);assert.equal(s.lastBlockTime,entries[448].blockTime,'the newest trade; entry 449 is a fee collection');
 // a third tick finds nothing new and fetches nothing
 const before=rpc.calls.length;await ingest.tick();assert.equal(rpc.calls.filter((m,i)=>i>=before&&m==='getTransaction').length,0);
 store.close();
});

test('an unresolved transaction (null or exhausted 429) leaves the whole page uncommitted; the cursor does not move until it resolves',async()=>{
 const entries=chain(50),failing=new Map([[sig(1040),'null']]),rpc=fakeRpc(entries,{failing}),store=openMarketStore(),ingest=ingestFor(rpc,store);
 await ingest.tick();
 assert.equal(store.getCursor(scope).newestSignature,null);assert.equal(store.stats(scope).swaps,0);
 assert.match(ingest.stats().lastError,/not returned yet/);assert.equal(ingest.stats().lastPollOk,false);
 failing.set(sig(1040),'transient');await ingest.tick();assert.equal(store.stats(scope).swaps,0);assert.match(ingest.stats().lastError,/429/);assert.equal(ingest.stats().rpcErrors,1);
 failing.clear();await ingest.tick();
 assert.equal(store.getCursor(scope).newestSignature,sig(1049));assert.equal(store.stats(scope).swaps,entries.filter(e=>e.trade).length);assert.equal(ingest.stats().lastPollOk,true);
 store.close();
});

test('live catch-up beyond the page budget records an explicit gap and closes it on later ticks; nothing is lost or duplicated',async()=>{
 const entries=chain(20),rpc=fakeRpc(entries),store=openMarketStore(),ingest=ingestFor(rpc,store,{maxPagesPerTick:2});
 await ingest.tick();assert.equal(store.getCursor(scope).backfillComplete,true);
 // 450 new signatures arrive while the worker was away
 for(const e of chain(450,{start:5000,time:1790300000}))entries.push(e);
 await ingest.tick();
 let c=store.getCursor(scope);
 assert.equal(c.newestSignature,entries[entries.length-1].signature,'the watermark moved to the newest');
 assert.equal(c.gaps.length,1);assert.equal(c.gaps[0].reason,'page budget');assert.equal(c.gaps[0].olderSignature,sig(1019));
 assert.equal(ingest.stats().openGaps,1);
 // the same tick already worked two gap pages (250 left -> 50 left); the next tick closes it
 await ingest.tick();c=store.getCursor(scope);assert.deepEqual(c.gaps,[]);
 assert.equal(store.stats(scope).swaps,entries.filter(e=>e.trade).length);assert.equal(ingest.stats().transactionsFetched,470);
 store.close();
});

test('a failure in the middle of a live catch-up keeps the pages already covered and turns the rest into a gap',async()=>{
 const entries=chain(10),rpc=fakeRpc(entries),store=openMarketStore(),ingest=ingestFor(rpc,store);
 await ingest.tick();
 const fresh=chain(250,{start:7000,time:1790400000});for(const e of fresh)entries.push(e);
 rpc.failing.set(fresh[30].signature,'null');// inside the third page (newest first: page 1 = 249..150, page 2 = 149..50, page 3 = 49..0)
 await ingest.tick();
 const c=store.getCursor(scope);assert.equal(c.newestSignature,fresh[249].signature);assert.equal(c.gaps.length,1);assert.match(c.gaps[0].reason,/unresolved/);
 assert.equal(c.gaps[0].newerSignature,fresh[50].signature,'pages 1 and 2 are covered');assert.equal(c.gaps[0].olderSignature,sig(1009));assert.equal(store.stats(scope).swaps,entries.filter(e=>e.trade).length-45,'the failed page (50 entries, 45 trades) is not stored');
 rpc.failing.clear();await ingest.tick();
 assert.deepEqual(store.getCursor(scope).gaps,[]);assert.equal(store.stats(scope).swaps,entries.filter(e=>e.trade).length);
 store.close();
});

test('finalization: finalized rows are marked, failed or vanished provisional rows are removed and their candles rebuilt',async()=>{
 const entries=chain(12),store=openMarketStore();
 const statuses=s=>s===sig(1011)?null:s===sig(1010)?{confirmationStatus:'finalized',err:{InstructionError:[0,'Custom']}}:{confirmationStatus:'finalized',err:null};
 const rpc=fakeRpc(entries,{statuses}),ingest=ingestFor(rpc,store);
 await ingest.tick();
 assert.equal(store.stats(scope).provisional,0);assert.equal(ingest.stats().removed,2);assert.equal(ingest.stats().finalized,0,'the only provisional trades were the two removed ones');
 assert.equal(store.swapsOf(scope,sig(1011)).length,0);assert.equal(store.swapsOf(scope,sig(1010)).length,0);assert.equal(store.swapsOf(scope,sig(1008))[0].commitment,'finalized');
 const clean=openMarketStore(),rpc2=fakeRpc(chain(10)),ingest2=ingestFor(rpc2,clean);await ingest2.tick();
 assert.deepEqual(store.candles(scope,'1m',0,4102444800),clean.candles(scope,'1m',0,4102444800),'candles equal the chain without the two removed transactions');
 store.close();clean.close();
});

test('restart at a persistence boundary: a new worker on the same store continues from the cursor and fetches only what is new',async()=>{
 const entries=chain(150),rpc=fakeRpc(entries),store=openMarketStore(),first=ingestFor(rpc,store);
 await first.tick();await first.tick();assert.equal(store.getCursor(scope).backfillComplete,true);
 for(const e of chain(5,{start:9000,time:1790500000}))entries.push(e);
 const second=ingestFor(rpc,store);const before=rpc.calls.length;await second.tick();
 assert.equal(rpc.calls.slice(before).filter(m=>m==='getTransaction').length,5);
 assert.equal(store.stats(scope).swaps,entries.filter(e=>e.trade).length);
 store.close();
});

test('a transaction of an unsupported version is recorded and alerted, the page still commits, and it is never fetched again',async()=>{
 const entries=chain(30),rpc=fakeRpc(entries),store=openMarketStore(),logs=[];
 rpc.failing.set(sig(1012),'version');entries[15].tx.version=2;// one refused by the RPC, one returned with a version the decoder does not know
 const ingest=ingestFor(rpc,store,{},{log:l=>logs.push(l)});
 await ingest.tick();
 const c=store.getCursor(scope);assert.equal(c.newestSignature,sig(1029),'the page committed');assert.deepEqual(c.gaps,[]);
 assert.deepEqual(c.unsupported.map(u=>u.signature).sort(),[sig(1012),sig(1015)].sort());assert.equal(c.unsupported.find(u=>u.signature===sig(1015)).version,2);
 assert.equal(store.stats(scope).swaps,entries.filter(e=>e.trade).length-2);
 assert.equal(logs.filter(l=>l.event==='market-unsupported-transaction').length,2);assert.equal(ingest.stats().unsupported,2);assert.equal(ingest.stats().unsupportedRecorded,2);
 const before=rpc.calls.length;await ingest.tick();assert.equal(rpc.calls.slice(before).filter(m=>m==='getTransaction').length,0,'not re-fetched every tick');
 assert.equal(store.getCursor(scope).unsupported.length,2,'the list survives later cursor writes');
 store.close();
});
test('transaction ordinals inside a slot come from the listing order, only for slots fully inside the page',()=>{
 const page=[{signature:'a',slot:10},{signature:'b',slot:9},{signature:'c',slot:9},{signature:'d',slot:8}];
 const idx=txIndexes(page);assert.equal(idx.get('a'),undefined);assert.equal(idx.get('d'),undefined);assert.equal(idx.get('b'),1);assert.equal(idx.get('c'),0);
 const all=txIndexes(page,{complete:true});assert.equal(all.get('a'),0);assert.equal(all.get('d'),0);
});

test('websocket wake-up: a logs notification schedules a poll; a dropped socket reconnects; the URL is derived from the https endpoint',async()=>{
 assert.equal(deriveWsUrl({KIDS_HELIUS_RPC_URL:'https://rpc.example/?api-key=k'}),'wss://rpc.example/?api-key=k');
 assert.equal(deriveWsUrl({KIDS_HELIUS_WS_URL:'wss://ws.example',KIDS_HELIUS_RPC_URL:'https://rpc.example'}),'wss://ws.example');
 assert.equal(deriveWsUrl({}),null);
 const sockets=[];const factory=url=>{const ws={url,sent:[],send(m){ws.sent.push(JSON.parse(m));},close(){ws.onclose?.();}};sockets.push(ws);return ws;};
 const entries=chain(3),rpc=fakeRpc(entries),store=openMarketStore(),ingest=ingestFor(rpc,store,{pollIntervalMs:100000,wsReconnectMaxMs:1},{webSocketFactory:factory});
 ingest.start({wsUrl:'wss://ws.example'});await new Promise(r=>setTimeout(r,20));
 assert.equal(sockets.length,1);sockets[0].onopen();assert.equal(sockets[0].sent[0].method,'logsSubscribe');assert.deepEqual(sockets[0].sent[0].params[0],{mentions:[IDENTITY.pool]});
 assert.equal(ingest.stats().ws.connected,true);
 entries.push(...chain(2,{start:20,time:1790600000}));
 const calls=rpc.calls.length;sockets[0].onmessage({data:JSON.stringify({jsonrpc:'2.0',method:'logsNotification',params:{}})});
 await new Promise(r=>setTimeout(r,700));assert.ok(rpc.calls.length>calls,'the notification woke a poll');assert.equal(store.stats(scope).swaps,5);
 sockets[0].close();await new Promise(r=>setTimeout(r,1200));assert.ok(sockets.length>=2,'reconnected');assert.equal(ingest.stats().ws.connected,false);
 await ingest.stop();store.close();
});
