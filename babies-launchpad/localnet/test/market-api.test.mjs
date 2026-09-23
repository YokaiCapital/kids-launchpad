// API shaping with a fake store: campaign binding, bounded candle windows, cursor pagination, explicit status and
// coverage, exact strings beside floats, and a shared 2 s cache with single flight (viewers never multiply work).
import test from 'node:test';import assert from 'node:assert/strict';
import {createMarketApi,MAX_BUCKETS} from '../market/api.mjs';
import {priceScaled} from '../market/decode.mjs';
const CAMPAIGN='Campaign1111111111111111111111111111111111',POOL='FAThun8yCqyatCAmcUAfqdmD83zHN3RZieEk6FkB5Zcn';
const SOL='So11111111111111111111111111111111111111112',COIN='8P47V2fj1yfg1C76YAZEXJBVzDJBFfURUUTeJjVJq5bz';
const sig=n=>('sig'+n).replace(/0/g,'o').padEnd(64,'x').slice(0,64)+'ZZZZ';
const swap=(n,lamports,coin,side='buy')=>({signature:sig(n),instructionPath:'0',slot:100+n,txIndex:null,blockTime:1790129340+n,side,trader:'AXA2k9FKgTyUaaQSAvB7qVHUsnRJJST2rsmF6EFDZBHZ',inputMint:SOL,inputAmount:String(lamports),outputMint:COIN,outputAmount:String(coin),solLamports:String(lamports),coinRaw:String(coin),coinDecimals:6,priceScaled:priceScaled(String(lamports),String(coin),6),nested:false,outerProgram:null,kind:'swap_base_input',commitment:'confirmed'});
function fakeStore(){
 const calls={summary:0,candles:0,trades:0};
 return {calls,
  summary(scope,nowUnix){calls.summary++;return {last:swap(2,40000,3632394060),open24h:priceScaled('20000','3632394060',6),volume24hSol:'60000',volume24hCoin:'7264788120',trades24h:2,buys24h:2,sells24h:0,tradesTotal:2,oldestBlockTime:1790129341,newestBlockTime:1790129342};},
  getCursor(){return {backfillComplete:true,gaps:[{newerSlot:9,olderSlot:5,reason:'page budget'}],updatedAt:1};},
  candles(scope,interval,from,to,limit){calls.candles++;return [{interval,time:from,open:'5506010545',high:'11012021091',low:'5506010545',close:'11012021091',volumeSol:'60000',volumeCoin:'7264788120',trades:2,buys:2,sells:0,firstSlot:1,lastSlot:2}];},
  trades(scope,{cursor,limit}){calls.trades++;return {trades:[swap(2,40000,3632394060),swap(1,20000,3632394060)].slice(0,limit),nextCursor:cursor?null:'next'};},
  stats(){return {swaps:2,provisional:1,missingBlockTime:0,candles:5};},
 };
}
function fakeFeed({enabled=true,identity=true,store=fakeStore(),stats={connected:true,lagSeconds:3,lastPollAt:1790129400000,lastPollOk:true,lastTradeAgeSeconds:60,backfillComplete:true,openGaps:1,decodeFailures:0,store:{provisional:1},ws:{connected:false}}}={}){
 return {enabled,identity:()=>identity?{campaign:CAMPAIGN,pool:POOL,mint:COIN,genesis:'g',coinDecimals:6}:null,store:()=>store,stats:()=>stats,_store:store};
}
async function get(api,url){
 let status=null,body=null;const res={writableEnded:false,writeHead(s){status=s;},end(b){body=JSON.parse(b);this.writableEnded=true;}};
 const handled=await api.handle({method:'GET',url},res);return {handled,status,body};
}
test('summary: price, change, volumes, counts, status, feed and coverage; floats beside exact strings',async()=>{
 const feed=fakeFeed(),api=createMarketApi({feed,now:()=>1790129400000});
 const r=await get(api,'/api/market/summary?campaign='+CAMPAIGN);
 assert.equal(r.status,200);const b=r.body;
 assert.equal(b.priceSol,1.1012021091e-8);assert.equal(b.priceSolExact,'0.000000011012021091');
 assert.equal(b.change24hPercent,100,'40000 lamports vs 20000 for the same coin amount');
 assert.equal(b.volume24hSol,0.00006);assert.equal(b.volume24hSolExact,'60000');assert.equal(b.volume24hCoin,7264.78812);
 assert.equal(b.trades24h,2);assert.equal(b.tradesTotal,2);assert.equal(b.lastTrade.signature,sig(2));assert.equal(b.lastTrade.exact.priceSol,'0.000000011012021091');
 assert.equal(b.status,'backfilling','an open gap is never presented as complete');assert.equal(b.feed.lagSeconds,3);assert.equal(b.feed.openGaps,1);
 assert.deepEqual(b.coverage,{oldestBlockTime:1790129341,newestBlockTime:1790129342,completeToLaunch:true,gaps:[{newerSlot:9,olderSlot:5,reason:'page budget'}],updatedAt:1});
 const stale=createMarketApi({feed:fakeFeed({stats:{...feed.stats(),lagSeconds:500}}),now:()=>1790129400000});
 assert.equal((await get(stale,'/api/market/summary?campaign='+CAMPAIGN)).body.status,'stale');
 const off=createMarketApi({feed:fakeFeed({stats:null}),now:()=>1790129400000});assert.equal((await get(off,'/api/market/summary?campaign='+CAMPAIGN)).body.status,'disabled');
});
test('campaign binding: wrong campaign 404, missing 400, no launched campaign 503, kill switch 503, unknown route 404, POST 405, non-market path not handled',async()=>{
 const api=createMarketApi({feed:fakeFeed(),now:()=>1});
 assert.equal((await get(api,'/api/market/summary?campaign=Campaign2222222222222222222222222222222222')).status,404);
 assert.equal((await get(api,'/api/market/summary')).status,400);
 assert.equal((await get(api,'/api/market/nope?campaign='+CAMPAIGN)).status,404);
 assert.equal((await get(api,'/api/account/state')).handled,false);
 let status;const res={writableEnded:false,writeHead(s){status=s;},end(){}};await api.handle({method:'POST',url:'/api/market/summary'},res);assert.equal(status,405);
 assert.equal((await get(createMarketApi({feed:fakeFeed({identity:false}),now:()=>1}),'/api/market/summary?campaign='+CAMPAIGN)).body.status,'not-launched');
 assert.equal((await get(createMarketApi({feed:fakeFeed({enabled:false}),now:()=>1}),'/api/market/summary?campaign='+CAMPAIGN)).status,503);
});
test('candles: interval validation, default window, bounded to 1000 buckets, shaped bars with exact values',async()=>{
 const feed=fakeFeed(),api=createMarketApi({feed,now:()=>1790129400000});
 const r=await get(api,'/api/market/candles?campaign='+CAMPAIGN+'&interval=5m');
 assert.equal(r.status,200);assert.equal(r.body.interval,'5m');assert.equal(r.body.to,1790129400+300);assert.equal(r.body.from,r.body.to-300*300);
 const c=r.body.candles[0];assert.equal(c.open,5.506010545e-9);assert.equal(c.high,1.1012021091e-8);assert.equal(c.exact.high,'0.000000011012021091');assert.equal(c.volumeSol,0.00006);assert.equal(c.exact.volumeSolLamports,'60000');assert.equal(c.trades,2);
 assert.equal(r.body.status,'backfilling');assert.equal(r.body.coverage.gaps.length,1);
 const wide=await get(api,'/api/market/candles?campaign='+CAMPAIGN+'&interval=1m&from=1&to=1790129400');
 assert.equal(wide.body.to-wide.body.from,60*MAX_BUCKETS,'window clipped to the newest 1000 buckets');
 assert.equal((await get(api,'/api/market/candles?campaign='+CAMPAIGN+'&interval=2m')).status,400);
 assert.equal((await get(api,'/api/market/candles?campaign='+CAMPAIGN+'&from=10&to=5')).status,400);
 assert.equal((await get(api,'/api/market/candles?campaign='+CAMPAIGN+'&from=abc')).status,400);
});
test('trades: newest first, cursor passed through, limit bounded',async()=>{
 const feed=fakeFeed(),api=createMarketApi({feed,now:()=>1790129400000});
 const r=await get(api,'/api/market/trades?campaign='+CAMPAIGN+'&limit=2');
 assert.equal(r.body.trades.length,2);assert.equal(r.body.nextCursor,'next');assert.equal(r.body.trades[0].sol,0.00004);assert.equal(r.body.trades[0].coin,3632.39406);assert.equal(r.body.trades[0].exact.coinRaw,'3632394060');
 const n=await get(api,'/api/market/trades?campaign='+CAMPAIGN+'&cursor=next&limit=1');assert.equal(n.body.trades.length,1);assert.equal(n.body.nextCursor,null);
 assert.equal((await get(api,'/api/market/trades?campaign='+CAMPAIGN+'&limit=0')).status,400);assert.equal((await get(api,'/api/market/trades?campaign='+CAMPAIGN+'&limit=999')).status,400);
});
test('cache: 50 concurrent viewers of the same key compute once; a different key computes separately; the entry expires after 2 s; a failure is not cached',async()=>{
 let t=1790129400000;const feed=fakeFeed(),api=createMarketApi({feed,now:()=>t});
 await Promise.all(Array.from({length:50},()=>get(api,'/api/market/summary?campaign='+CAMPAIGN)));
 assert.equal(feed._store.calls.summary,1);
 await get(api,'/api/market/trades?campaign='+CAMPAIGN+'&limit=5');await get(api,'/api/market/trades?campaign='+CAMPAIGN+'&limit=5');assert.equal(feed._store.calls.trades,1);
 t+=1999;await get(api,'/api/market/summary?campaign='+CAMPAIGN);assert.equal(feed._store.calls.summary,1);
 t+=2;await get(api,'/api/market/summary?campaign='+CAMPAIGN);assert.equal(feed._store.calls.summary,2);
 feed._store.trades=()=>{throw Error('boom');};t+=5000;assert.equal((await get(api,'/api/market/trades?campaign='+CAMPAIGN+'&limit=5')).status,400);
 feed._store.trades=()=>({trades:[],nextCursor:null});assert.equal((await get(api,'/api/market/trades?campaign='+CAMPAIGN+'&limit=5')).status,200,'the failed computation was not cached');
});
