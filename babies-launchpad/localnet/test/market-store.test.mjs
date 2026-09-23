// Store gates (plan section 5): deterministic candles under out-of-order delivery, duplicates and provisional
// removal; late block time; keyset pagination; 24 h summary; cursor and gap persistence.
import test from 'node:test';import assert from 'node:assert/strict';
import {openMarketStore,compareSwapOrder,bucketStart,INTERVAL_NAMES,decodeCursor} from '../market/store.mjs';
import {priceScaled} from '../market/decode.mjs';
const SCOPE={genesis:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',pool:'FAThun8yCqyatCAmcUAfqdmD83zHN3RZieEk6FkB5Zcn'};
const SOL='So11111111111111111111111111111111111111112',COIN='8P47V2fj1yfg1C76YAZEXJBVzDJBFfURUUTeJjVJq5bz';
const sig=n=>('sig'+n).padEnd(64,'x').replace(/[^1-9A-HJ-NP-Za-km-z]/g,'a').slice(0,64)+'ZZZZ';
let counter=0;
function swap({slot,blockTime,lamports,coin,side='buy',path='0',signature,txIndex=null}){
 counter++;const s=signature||sig(counter);
 return {signature:s,instructionPath:path,slot,txIndex,blockTime,side,trader:'AXA2k9FKgTyUaaQSAvB7qVHUsnRJJST2rsmF6EFDZBHZ',inputMint:side==='buy'?SOL:COIN,inputAmount:side==='buy'?String(lamports):String(coin),outputMint:side==='buy'?COIN:SOL,outputAmount:side==='buy'?String(coin):String(lamports),solLamports:String(lamports),coinRaw:String(coin),coinDecimals:6,priceScaled:priceScaled(String(lamports),String(coin),6),nested:false,outerProgram:null,kind:'swap_base_input',decoderVersion:1};
}
const T0=1790129340;// bucket-aligned for 1m (multiple of 60)
function sampleSwaps(){
 return [
  swap({slot:100,blockTime:T0+5,lamports:20000,coin:3632394060,side:'buy',signature:sig(1)}),
  swap({slot:101,blockTime:T0+20,lamports:1679349,coin:1383367409292,side:'sell',signature:sig(2)}),
  swap({slot:101,blockTime:T0+20,lamports:5404,coin:4459366261,side:'sell',signature:sig(3)}),
  swap({slot:101,blockTime:T0+20,lamports:40000,coin:3000000000,side:'buy',signature:sig(3),path:'2'}),
  swap({slot:150,blockTime:T0+59,lamports:1000000,coin:100000000000,side:'buy',signature:sig(4)}),
  swap({slot:400,blockTime:T0+61,lamports:1000000,coin:200000000000,side:'sell',signature:sig(5)}),
  swap({slot:9000,blockTime:T0+86400,lamports:7,coin:1000000,side:'buy',signature:sig(6)}),
 ];
}
const allCandles=store=>Object.fromEntries(INTERVAL_NAMES.map(i=>[i,store.candles(SCOPE,i,0,4102444800)]));

test('candles are computed from the swaps of the bucket in chain order, with exact BigInt sums',()=>{
 const store=openMarketStore();const r=store.insertSwaps(SCOPE,sampleSwaps());
 assert.deepEqual(r,{inserted:7,updated:0,buckets:12});// 1m 3 + 5m 3 + 15m 2 + 1h 2 + 1d 2
 const m1=store.candles(SCOPE,'1m',0,4102444800);
 assert.equal(m1.length,3);
 const first=m1[0];
 assert.equal(first.time,T0);assert.equal(first.trades,5);assert.equal(first.buys,3);assert.equal(first.sells,2);
 assert.equal(first.open,priceScaled('20000','3632394060',6),'open = first fill by slot order');
 assert.equal(first.close,priceScaled('1000000','100000000000',6),'close = last fill (slot 150)');
 assert.equal(first.volumeSol,String(20000+1679349+5404+40000+1000000));
 assert.equal(first.volumeCoin,String(3632394060n+1383367409292n+4459366261n+3000000000n+100000000000n));
 const prices=[priceScaled('20000','3632394060',6),priceScaled('1679349','1383367409292',6),priceScaled('5404','4459366261',6),priceScaled('40000','3000000000',6),priceScaled('1000000','100000000000',6)].map(BigInt);
 assert.equal(first.high,prices.reduce((a,b)=>a>b?a:b).toString());assert.equal(first.low,prices.reduce((a,b)=>a<b?a:b).toString());
 assert.equal(m1[1].time,T0+60);assert.equal(m1[1].trades,1);
 const d1=store.candles(SCOPE,'1d',0,4102444800);assert.equal(d1.length,2);assert.equal(d1[0].trades,6);assert.equal(d1[0].open,first.open);assert.equal(d1[0].close,priceScaled('1000000','200000000000',6));
 store.close();
});

test('determinism: shuffled arrival, duplicates and a re-insert with finalized commitment give the same candles and the same trade list',()=>{
 const ordered=openMarketStore();ordered.insertSwaps(SCOPE,sampleSwaps());
 const shuffled=openMarketStore();const swaps=sampleSwaps();
 const order=[6,2,5,1,3,0,4].map(i=>swaps[i]);
 for(const s of order)shuffled.insertSwaps(SCOPE,[s]);
 shuffled.insertSwaps(SCOPE,order.slice(0,3));// duplicates
 const r=shuffled.insertSwaps(SCOPE,[swaps[1]],{commitment:'finalized'});assert.deepEqual(r,{inserted:0,updated:1,buckets:0});
 assert.deepEqual(allCandles(shuffled),allCandles(ordered));
 assert.deepEqual(shuffled.trades(SCOPE,{limit:50}).trades.map(t=>t.signature+':'+t.instructionPath),ordered.trades(SCOPE,{limit:50}).trades.map(t=>t.signature+':'+t.instructionPath));
 assert.equal(shuffled.swapsOf(SCOPE,swaps[1].signature)[0].commitment,'finalized');
 assert.equal(ordered.stats(SCOPE).swaps,7);assert.equal(shuffled.stats(SCOPE).provisional,6);
 ordered.close();shuffled.close();
});

test('removing a provisional signature (dropped or failed at finalization) rebuilds candles to exactly the set without it',()=>{
 const without=openMarketStore();const swaps=sampleSwaps();without.insertSwaps(SCOPE,swaps.filter(s=>s.signature!==sig(3)));
 const withAll=openMarketStore();withAll.insertSwaps(SCOPE,swaps);
 assert.notDeepEqual(allCandles(withAll),allCandles(without));
 assert.equal(withAll.removeSwaps(SCOPE,[sig(3)]),2,'both records of the transaction go');
 assert.deepEqual(allCandles(withAll),allCandles(without));
 assert.equal(withAll.provisional(SCOPE).length,5);
 assert.equal(withAll.finalizeSwaps(SCOPE,[sig(1),sig(2)]),2);assert.equal(withAll.provisional(SCOPE).length,3);
 // a bucket whose only swap is removed disappears (whitespace, no fabricated bar)
 assert.equal(withAll.removeSwaps(SCOPE,[sig(6)]),1);assert.equal(withAll.candles(SCOPE,'1d',0,4102444800).length,1);
 without.close();withAll.close();
});

test('a swap without block time is stored but bucketed only when the chain time arrives',()=>{
 const store=openMarketStore();
 store.insertSwaps(SCOPE,[swap({slot:5,blockTime:null,lamports:100,coin:1000000,signature:sig(50)})]);
 assert.equal(store.stats(SCOPE).missingBlockTime,1);assert.deepEqual(store.candles(SCOPE,'1m',0,4102444800),[]);
 assert.deepEqual(store.missingBlockTime(SCOPE),[{signature:sig(50),slot:5}]);
 assert.equal(store.setBlockTime(SCOPE,sig(50),T0+1),1);
 assert.equal(store.candles(SCOPE,'1m',0,4102444800).length,1);assert.equal(store.stats(SCOPE).missingBlockTime,0);
 // a later duplicate delivery carrying the block time also fills it in
 const other=openMarketStore();other.insertSwaps(SCOPE,[swap({slot:5,blockTime:null,lamports:100,coin:1000000,signature:sig(51)})]);
 const r=other.insertSwaps(SCOPE,[swap({slot:5,blockTime:T0+2,lamports:100,coin:1000000,signature:sig(51)})]);
 assert.deepEqual(r,{inserted:0,updated:1,buckets:5});assert.equal(other.candles(SCOPE,'1m',0,4102444800).length,1);
 store.close();other.close();
});

test('trades page newest first with a keyset cursor; equal-slot records follow transaction index then instruction order',()=>{
 const store=openMarketStore();store.insertSwaps(SCOPE,sampleSwaps());
 const p1=store.trades(SCOPE,{limit:3});assert.equal(p1.trades.length,3);assert.ok(p1.nextCursor);
 assert.deepEqual(p1.trades.map(t=>t.slot),[9000,400,150]);
 const p2=store.trades(SCOPE,{cursor:p1.nextCursor,limit:3});assert.deepEqual(p2.trades.map(t=>t.slot),[101,101,101]);
 const p3=store.trades(SCOPE,{cursor:p2.nextCursor,limit:3});assert.deepEqual(p3.trades.map(t=>t.slot),[100]);assert.equal(p3.nextCursor,null);
 const all=[...p1.trades,...p2.trades,...p3.trades];assert.equal(new Set(all.map(t=>t.signature+t.instructionPath)).size,7,'no overlap, no loss');
 assert.throws(()=>store.trades(SCOPE,{cursor:'nope'}),/Invalid trades cursor/);assert.equal(decodeCursor('x'),null);
 assert.equal(compareSwapOrder({slot:1,txIndex:2,signature:'a',instructionPath:'0'},{slot:1,txIndex:null,signature:'a',instructionPath:'0'})<0,true,'unknown index sorts last');
 assert.equal(compareSwapOrder({slot:1,txIndex:0,signature:'a',instructionPath:'10'},{slot:1,txIndex:0,signature:'a',instructionPath:'4'})>0,true,'paths compare numerically');
 store.close();
});

test('summary: last fill, 24 h window from 1m candles, totals and coverage times',()=>{
 const store=openMarketStore();store.insertSwaps(SCOPE,sampleSwaps());
 const s=store.summary(SCOPE,T0+3600);
 assert.equal(s.last.slot,9000,'last fill is the newest stored fill, whatever the window');assert.equal(s.trades24h,6);assert.equal(s.buys24h,3);assert.equal(s.sells24h,3);
 assert.equal(s.volume24hSol,String(20000+1679349+5404+40000+1000000+1000000));assert.equal(s.open24h,priceScaled('20000','3632394060',6));
 assert.equal(s.tradesTotal,7);assert.equal(s.oldestBlockTime,T0+5);assert.equal(s.newestBlockTime,T0+86400);
 const edge=store.summary(SCOPE,T0+86400+30);assert.equal(edge.trades24h,7,'the window is whole 1m buckets: the bucket 24 h ago is still in');const later=store.summary(SCOPE,T0+86400+120);assert.equal(later.trades24h,1,'window slides');assert.equal(later.last.slot,9000);
 assert.equal(openMarketStore().summary(SCOPE,T0).last,null);
 store.close();
});

test('cursor: persisted with gaps, validated, defaults when absent',()=>{
 const store=openMarketStore();
 assert.deepEqual(store.getCursor(SCOPE).gaps,[]);assert.equal(store.getCursor(SCOPE).backfillComplete,false);
 store.setCursor(SCOPE,{newestSignature:sig(9),newestSlot:9,newestBlockTime:T0,oldestSignature:sig(1),oldestSlot:1,oldestBlockTime:T0-100,backfillComplete:true,gaps:[{newerSignature:sig(5),olderSignature:sig(3),newerSlot:5,olderSlot:3,reason:'page budget'}]},1234);
 const c=store.getCursor(SCOPE);assert.equal(c.newestSignature,sig(9));assert.equal(c.backfillComplete,true);assert.equal(c.gaps[0].reason,'page budget');assert.equal(c.updatedAt,1234);
 assert.throws(()=>store.setCursor(SCOPE,{gaps:[{newerSignature:'bad'}]}),/gap needs/);
 assert.throws(()=>store.insertSwaps({genesis:'',pool:SCOPE.pool},[]),/scope/);
 assert.throws(()=>store.insertSwaps(SCOPE,[{...sampleSwaps()[0],priceScaled:'-1'}]),/Invalid swap amount/);
 assert.equal(bucketStart(T0+59,'1m'),T0);
 store.close();
});
