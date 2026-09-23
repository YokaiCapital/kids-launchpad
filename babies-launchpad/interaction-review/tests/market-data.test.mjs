import test from 'node:test';import assert from 'node:assert/strict';
import {adaptiveDecimals,formatPrice,formatSolVolume,formatChange,relativeTime,utcStamp,normaliseCandle,mergeCandles,mergeGaps,seriesData,diffForUpdate,pricePrecision,candleRange,normaliseTrade,mergeTrades,deriveMarketState,freshnessHint,poolLiquidity,formatSol,fetchMarket,startPolling,STALE_AFTER_SECONDS} from '../src/market-data.mjs';

test('price keeps four significant digits however small, and never invents one',()=>{
 assert.equal(adaptiveDecimals(0.000012345),8);assert.equal(adaptiveDecimals(2.5),4);assert.equal(adaptiveDecimals(1234.5),2);assert.equal(adaptiveDecimals(0),0);
 assert.deepEqual(formatPrice('0.000012345'),{text:'0.00001235',exact:'0.000012345'});
 assert.deepEqual(formatPrice('0.5'),{text:'0.5',exact:'0.5'});
 assert.deepEqual(formatPrice('1234.56789'),{text:'1,234.57',exact:'1234.56789'});
 assert.deepEqual(formatPrice('0'),{text:'0',exact:'0'});
 assert.deepEqual(formatPrice(null),{text:'—',exact:null});assert.deepEqual(formatPrice('abc'),{text:'—',exact:null});assert.deepEqual(formatPrice('-1'),{text:'—',exact:null});
});
test('volume is compact above a thousand SOL and a dash when unknown',()=>{
 assert.deepEqual(formatSolVolume('12345.6'),{text:'12.35K',exact:'12345.6'});
 assert.deepEqual(formatSolVolume('12.3456'),{text:'12.35',exact:'12.3456'});
 assert.deepEqual(formatSolVolume('0.12345'),{text:'0.1235',exact:'0.12345'});
 assert.deepEqual(formatSolVolume(undefined),{text:'—',exact:null});
});
test('24h change is signed with a tone, unknown is a dash not zero',()=>{
 assert.deepEqual(formatChange(4.2),{text:'+4.20%',tone:'up'});
 assert.deepEqual(formatChange(-1.339),{text:'−1.34%',tone:'down'});
 assert.deepEqual(formatChange(0),{text:'0.00%',tone:'flat'});
 assert.deepEqual(formatChange(null),{text:'—',tone:'none'});
});
test('relative and exact UTC time',()=>{
 assert.equal(relativeTime(1000,1003),'just now');assert.equal(relativeTime(1000,1042),'42 s ago');assert.equal(relativeTime(1000,1000+7*60),'7 min ago');
 assert.equal(relativeTime(1000,1000+5*3600),'5 h ago');assert.equal(relativeTime(1000,1000+3*86400),'3 d ago');assert.equal(relativeTime(null,5),'');
 assert.equal(utcStamp(1790172202),'23 Sep 2026, 14:03:22 UTC');assert.equal(utcStamp('x'),'');
});
test('candles are validated, merged in time order and a provisional bar is replaced',()=>{
 assert.equal(normaliseCandle({t:60,o:'1',h:'0.5',l:'0.4',c:'0.45'}),null);// high below open
 assert.equal(normaliseCandle({t:60,o:'x',h:'1',l:'1',c:'1'}),null);
 const first=mergeCandles([],[{t:120,o:'1',h:'2',l:'1',c:'2',v:'5',n:2},{t:60,o:'1',h:'1',l:'1',c:'1',v:'1',n:1,provisional:true}]);
 assert.deepEqual(first.map(b=>b.time),[60,120]);assert.equal(first[0].provisional,true);
 const merged=mergeCandles(first,[{t:60,o:'1',h:'1.5',l:'0.9',c:'1.2',v:'3',n:4},{t:180,o:'2',h:'2',l:'2',c:'2',v:'0',n:1}]);
 assert.deepEqual(merged.map(b=>[b.time,b.close,b.provisional]),[[60,1.2,false],[120,2,false],[180,2,false]]);
 assert.deepEqual(mergeGaps([{fromUnix:10,toUnix:20}],[{fromUnix:10,toUnix:20},{fromUnix:5,toUnix:2},{fromUnix:30,toUnix:40}]),[{fromUnix:10,toUnix:20},{fromUnix:30,toUnix:40}]);
});
test('series data: whitespace before the first trade, carried bars between real bars, whitespace inside coverage gaps',()=>{
 const candles=mergeCandles([],[{t:120,o:'1',h:'1.5',l:'1',c:'1.5'},{t:300,o:'1',h:'1',l:'1',c:'1'}]);
 const {points,filled,carried}=seriesData(candles,{intervalSeconds:60,fromUnix:0,toUnix:420});
 assert.equal(filled,true);assert.deepEqual(points.map(p=>p.time),[0,60,120,180,240,300,360,420]);
 assert.deepEqual(points[0],{time:0});assert.deepEqual(points[1],{time:60});// nothing before the first trade: no seeded price
 assert.equal(points[2].carried,undefined);assert.equal(points[2].close,1.5);
 assert.deepEqual(points[3],{time:180,open:1.5,high:1.5,low:1.5,close:1.5,volume:0,trades:0,carried:true});// previous close carried
 assert.deepEqual(points[4],{time:240,open:1.5,high:1.5,low:1.5,close:1.5,volume:0,trades:0,carried:true});
 assert.equal(points[5].close,1);assert.equal(points[5].carried,undefined);
 assert.equal(points[6].carried,true);assert.equal(points[6].close,1);assert.equal(points[7].carried,true);// carried up to now
 assert.equal(carried,4);
 // a coverage gap stays whitespace and carrying only resumes at the next real bar
 const gapped=seriesData(candles,{intervalSeconds:60,fromUnix:0,toUnix:420,gaps:[{fromUnix:180,toUnix:250}]});
 assert.deepEqual(gapped.points[3],{time:180});assert.deepEqual(gapped.points[4],{time:240});
 assert.equal(gapped.points[5].close,1);assert.equal(gapped.points[6].carried,true);assert.equal(gapped.carried,2);
 const tail=seriesData(mergeCandles([],[{t:60,o:'1',h:'1',l:'1',c:'1'}]),{intervalSeconds:60,fromUnix:60,toUnix:300,gaps:[{fromUnix:200,toUnix:600}]});
 assert.deepEqual(tail.points.map(p=>p.carried?'c':'open' in p?'r':'w'),['r','c','w','w','w']);// nothing is drawn past a gap without a new trade
 // a real bar inside a listed gap is still drawn
 const inside=seriesData(candles,{intervalSeconds:60,fromUnix:0,toUnix:300,gaps:[{fromUnix:100,toUnix:400}]});
 assert.equal(inside.points[2].close,1.5);assert.equal(inside.points[5].close,1);assert.deepEqual(inside.points[3],{time:180});
 assert.deepEqual(seriesData([],{intervalSeconds:60}),{points:[],filled:true,carried:0});
 const wide=seriesData(candles,{intervalSeconds:1,fromUnix:0,toUnix:10**6});assert.equal(wide.filled,false);assert.equal(wide.points.length,2);assert.equal(wide.carried,0);
});
test('chart updates append or replace in place and only reset when the series start moved',()=>{
 const a=[{time:60,open:1,high:1,low:1,close:1},{time:120}];
 const carriedBar={time:60,open:1,high:1,low:1,close:1,volume:0,trades:0,carried:true};assert.equal(diffForUpdate([carriedBar,{time:120}],a).updates.length,1);// carried → real repaints even at the same price
 const same={reset:false,updates:[]};assert.deepEqual(diffForUpdate(a,a.map(p=>({...p}))),same);
 const next=[{time:60,open:1,high:1,low:1,close:1},{time:120,open:1,high:2,low:1,close:2},{time:180}];
 assert.deepEqual(diffForUpdate(a,next),{reset:false,updates:[{point:next[1],historical:false},{point:next[2],historical:false}]});
 const hist=[{time:60,open:1,high:3,low:1,close:3},{time:120}];
 assert.deepEqual(diffForUpdate(a,hist),{reset:false,updates:[{point:hist[0],historical:true}]});
 assert.equal(diffForUpdate(a,[{time:120}]).reset,true);assert.equal(diffForUpdate([],a).reset,true);assert.equal(diffForUpdate(a,[a[0]]).reset,true);
 assert.equal(pricePrecision([{close:0.00042},{close:0.0005}]),7);assert.equal(pricePrecision([]),4);
 assert.deepEqual(candleRange('1m',[],1000000),{from:1000000-6*3600,to:1000000});
 assert.deepEqual(candleRange('1m',[{time:999900}],1000000),{from:999840,to:1000000});
});
test('trades are newest first, one per signature, confirming rows replaced by confirmed ones',()=>{
 assert.equal(normaliseTrade({signature:'a',side:'hold'}),null);assert.equal(normaliseTrade({side:'buy'}),null);
 const rows=mergeTrades([],[{signature:'a',slot:10,blockTimeUnix:100,side:'buy',solRaw:'1',coinRaw:'2',priceSol:'0.5',nested:false,provisional:true,wallet:null},{signature:'b',slot:12,blockTimeUnix:105,side:'sell',solRaw:'1',coinRaw:'2',priceSol:'0.5',nested:true,provisional:false,wallet:'W'}]);
 assert.deepEqual(rows.map(r=>r.signature),['b','a']);assert.equal(rows[1].provisional,true);
 const again=mergeTrades(rows,[{signature:'a',slot:10,blockTimeUnix:100,side:'buy',solRaw:'1',coinRaw:'2',priceSol:'0.5',nested:false,provisional:false},{signature:'c',slot:9,blockTimeUnix:100,side:'buy',solRaw:'1',coinRaw:'1',priceSol:'1'}]);
 assert.deepEqual(again.map(r=>[r.signature,r.provisional]),[['b',false],['a',false],['c',false]]);
});
test('market state comes from the summary and the last read, never from guesses',()=>{
 const now=2000;
 assert.equal(deriveMarketState({summary:null,result:null,nowUnix:now}),'loading');
 assert.equal(deriveMarketState({summary:null,result:{ok:false,reason:'off'},nowUnix:now}),'off');
 assert.equal(deriveMarketState({summary:{freshness:'live'},result:{ok:false,reason:'unavailable',status:503},nowUnix:now}),'unavailable');
 const live={configured:true,priceSol:'0.1',trades24h:4,lastTradeUnix:1990,lagSeconds:3,freshness:'live'};
 assert.equal(deriveMarketState({summary:live,result:{ok:true,data:live},nowUnix:now}),'live');
 assert.equal(deriveMarketState({summary:{...live,lagSeconds:STALE_AFTER_SECONDS+1},result:{ok:true,data:live},nowUnix:now}),'stale');
 assert.equal(deriveMarketState({summary:{...live,freshness:'stale'},result:{ok:true,data:live},nowUnix:now}),'stale');
 assert.equal(deriveMarketState({summary:{...live,freshness:'backfilling'},result:{ok:true,data:live},nowUnix:now}),'backfilling');
 assert.equal(deriveMarketState({summary:{configured:true,priceSol:null,trades24h:0,lastTradeUnix:null,lagSeconds:null,freshness:'live'},result:{ok:true,data:{}},nowUnix:now}),'no-trades');
 assert.equal(deriveMarketState({summary:{configured:false},result:{ok:true,data:{}},nowUnix:now}),'off');
 assert.deepEqual(freshnessHint({state:'live',summary:live,lastReadUnix:1990,nowUnix:now}),{text:'Updated 10 s ago',tone:'live'});
 assert.deepEqual(freshnessHint({state:'stale',summary:{...live,lagSeconds:300},lastReadUnix:1990,nowUnix:now}),{text:'Stale · feed 5 min behind',tone:'stale'});
 assert.deepEqual(freshnessHint({state:'unavailable',summary:live,lastReadUnix:1700,nowUnix:now}),{text:'Feed unavailable · last read 5 min ago',tone:'off'});
 assert.deepEqual(freshnessHint({state:'off',summary:null,lastReadUnix:null,nowUnix:now}),{text:'Market feed not connected',tone:'off'});
});
test('two-sided liquidity values the coin side at the last price and stays honest without one',()=>{
 const full=poolLiquidity({quoteReserveLamports:'612345678901',baseReserveRaw:'434999123456789',decimals:6,priceSol:'0.0000014'});
 assert.equal(full.solSide,612.345678901);assert.ok(Math.abs(full.coinSideSol-608.99877)<0.001);assert.ok(Math.abs(full.total-1221.3445)<0.001);
 const none=poolLiquidity({quoteReserveLamports:'612345678901',baseReserveRaw:'434999123456789',decimals:6,priceSol:null});
 assert.equal(none.total,null);assert.equal(none.coinSideSol,null);assert.equal(none.solSide,612.345678901);
 assert.equal(formatSol(1221.34456),'1,221.34');assert.equal(formatSol(0.5),'0.5');assert.equal(formatSol(null),'—');
});
test('fetchMarket classifies 503, HTML fallbacks, configured:false, bad JSON and network errors without throwing',async()=>{
 const json=(status,body,type='application/json')=>async()=>({ok:status<400,status,headers:{get:h=>h==='content-type'?type:null},json:async()=>{if(typeof body==='string')throw Error('bad');return body;}});
 assert.deepEqual(await fetchMarket('summary',{campaign:'c'},{fetchImpl:json(503,{error:'down'})}),{ok:false,reason:'unavailable',status:503});
 assert.deepEqual(await fetchMarket('summary',{campaign:'c'},{fetchImpl:json(200,{},'text/html')}),{ok:false,reason:'unavailable',status:200});
 assert.deepEqual(await fetchMarket('summary',{campaign:'c'},{fetchImpl:json(200,{configured:false})}),{ok:false,reason:'off',status:200});
 assert.deepEqual(await fetchMarket('candles',{campaign:'c'},{fetchImpl:json(200,'nope')}),{ok:false,reason:'malformed',status:200});
 assert.deepEqual(await fetchMarket('candles',{campaign:'c'},{fetchImpl:json(200,{interval:'1m'})}),{ok:false,reason:'malformed',status:200});
 assert.deepEqual(await fetchMarket('trades',{campaign:'c'},{fetchImpl:async()=>{throw Error('offline');}}),{ok:false,reason:'network',status:null});
 let seen='';const ok=await fetchMarket('candles',{campaign:'c',interval:'5m',from:1,to:2},{fetchImpl:async url=>{seen=url;return json(200,{interval:'5m',candles:[],gaps:[]})();}});
 assert.equal(seen,'/api/market/candles?campaign=c&interval=5m&from=1&to=2');assert.equal(ok.ok,true);
});
test('polling runs now, every tick while visible, pauses when hidden and resumes on return',()=>{
 const listeners={};const doc={visibilityState:'visible',addEventListener:(n,f)=>{listeners[n]=f;},removeEventListener:n=>{delete listeners[n];}};
 let runs=0,timers=[],cleared=0;const si=(fn,ms)=>{timers.push(fn);return timers.length;},ci=()=>{cleared++;};
 const stop=startPolling(()=>runs++,10,{doc,setInterval:si,clearInterval:ci});
 assert.equal(runs,1);assert.equal(timers.length,1);timers[0]();assert.equal(runs,2);
 doc.visibilityState='hidden';listeners.visibilitychange();assert.equal(cleared,1);timers[0]();assert.equal(runs,2);
 doc.visibilityState='visible';listeners.visibilitychange();assert.equal(runs,3);assert.equal(timers.length,2);
 stop();assert.equal(cleared,2);assert.equal(listeners.visibilitychange,undefined);timers[1]();assert.equal(runs,3);
});
test('the served shapes (long names, nested feed and coverage, exact amounts) adapt to the page fields',async()=>{
 const {adaptMarketData,normaliseCandle,normaliseTrade}=await import('../src/market-data.mjs');
 const s=adaptMarketData('summary',{priceSol:1.268622982e-9,change24hPercent:-75.02,volume24hSol:1.871113175,trades24h:47,status:'live',lastTrade:{time:1790144972},feed:{lagSeconds:8},coverage:{oldestBlockTime:1790129330,newestBlockTime:1790144972,gaps:[]}});
 assert.equal(s.priceChange24hPct,-75.02);assert.equal(s.lastTradeUnix,1790144972);assert.equal(s.lagSeconds,8);assert.equal(s.freshness,'live');assert.equal(s.coverage.fromUnix,1790129330);assert.deepEqual(s.coverage.gaps,[]);
 const c=normaliseCandle({time:1790129100,open:5.079091885e-9,high:5.507515437e-9,low:4.707834734e-9,close:4.939845235e-9,volumeSol:0.411343482,trades:11});assert.equal(c.time,1790129100);assert.equal(c.volume,0.411343482);assert.equal(c.trades,11);
 const t=normaliseTrade({signature:'4ePp',path:'5.0',slot:449622084,time:1790144972,side:'buy',trader:'xEMq',sol:0.005620729,coin:4430574.786107,priceSol:1.268622982e-9,exact:{solLamports:'5620729',coinRaw:'4430574786107',priceSol:'0.000000001268622982'},nested:true,commitment:'finalized'});
 assert.equal(t.blockTimeUnix,1790144972);assert.equal(t.solRaw,'5620729');assert.equal(t.coinRaw,'4430574786107');assert.equal(t.priceSol,'0.000000001268622982');assert.equal(t.wallet,'xEMq');assert.equal(t.provisional,false);assert.equal(normaliseTrade({signature:'x',side:'sell',time:1,commitment:'confirmed'}).provisional,true);
});
test('served trade and candle rows are always normalised when merged (the live list showed Pending and dashes)',async()=>{
 const {mergeTrades,mergeCandles}=await import('../src/market-data.mjs');
 const [t]=mergeTrades([],[{signature:'4ePp',slot:449622084,time:1790144972,side:'buy',trader:'xEMq',priceSol:1.268622982e-9,exact:{solLamports:'5620729',coinRaw:'4430574786107',priceSol:'0.000000001268622982'},nested:true,commitment:'finalized'}]);
 assert.equal(t.blockTimeUnix,1790144972);assert.equal(t.solRaw,'5620729');assert.equal(t.provisional,false);
 const [c]=mergeCandles([],[{time:1790129100,open:1,high:2,low:0.5,close:1.5,volumeSol:0.4,trades:3}]);assert.equal(c.volume,0.4);assert.equal(c.trades,3);
});
test('two swaps in one transaction are two rows (keyed by signature and instruction path)',async()=>{
 const {mergeTrades}=await import('../src/market-data.mjs');
 const rows=mergeTrades([],[{signature:'S',path:'1',time:5,side:'buy',exact:{solLamports:'1',coinRaw:'2'},nested:true},{signature:'S',path:'3.0',time:5,side:'sell',exact:{solLamports:'3',coinRaw:'4'},nested:true}]);
 assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.key).sort(),['S:1','S:3.0']);
 const again=mergeTrades(rows,[{signature:'S',path:'1',time:5,side:'buy',exact:{solLamports:'1',coinRaw:'2'},nested:true,commitment:'finalized'}]);assert.equal(again.length,2);
});
