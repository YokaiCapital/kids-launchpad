import test from 'node:test';import assert from 'node:assert/strict';
import {marketWindow,validateMarket,marketState,marketSeries,readCampaignMarket,marketExplorer} from '../src/public/campaign-market.mjs';
const vm={identity:{genesisHash:'genesis',programId:'program',campaign:'campaign'},chain:{pool:'pool',mint:'mint'},terms:{supply:{decimals:6}}};
const raw=(extra={})=>({available:true,...vm.identity,pool:'pool',mint:'mint',coinDecimals:6,quote:'SOL',commitment:'finalized',at:300000,status:'no-trades',freshness:{updatedAt:300000,stale:false},coverage:{complete:true},openingReference:{time:60,priceSol:0.00001,priceSolExact:'0.00001',source:'pool-opening',isTrade:false},interval:'1m',from:60,to:360,candles:[],trades:[],nextCursor:null,...extra});
const bar=(time=60)=>({time,open:1,high:1,low:1,close:1,trades:1});
test('explorer links never send a local or unknown ledger signature to mainnet',()=>{
 const s='2'.repeat(88);assert.equal(marketExplorer('local',s),null);assert.equal(marketExplorer('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d','https://bad.invalid'),null);
 assert.equal(marketExplorer('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',s),'https://solscan.io/tx/'+s);
 assert.ok(marketExplorer('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',s).endsWith('?cluster=devnet'));
});
test('market windows share bucket-aligned requests and stay below 1000 buckets',()=>{
 for(const [i,s]of [['1m',60],['5m',300],['15m',900],['1h',3600],['1d',86400]]){const w=marketWindow(i,3000000);assert.equal(w.from%s,0);assert.equal(w.to%s,0);assert.ok((w.to-w.from)/s<1000);assert.deepEqual(w,marketWindow(i,3000001));}
});
test('foreign chain, program, campaign, pool, mint, decimals and provisional data are refused',()=>{
 for(const field of ['genesisHash','programId','campaign','pool','mint','coinDecimals','commitment'])assert.throws(()=>validateMarket(raw({[field]:'different'}),vm,'candles'),/verified/);
 assert.equal(validateMarket(raw(),vm,'candles').available,true);
 assert.equal(validateMarket({available:false,...vm.identity,status:'not-indexed',commitment:'finalized'},vm,'trades').available,false);
 for(const candle of [bar(61),bar(360),{...bar(),low:2},{...bar(),trades:0}])assert.throws(()=>validateMarket(raw({candles:[candle]}),vm,'candles'));
 assert.throws(()=>validateMarket(raw({candles:[bar(),bar()]}),vm,'candles'));
});
test('empty trades are quiet only with complete fresh coverage; opening reference is never a candle',()=>{
 const d=raw();assert.equal(marketState(d,{now:300100}).quiet,true);assert.deepEqual(marketSeries(d,300100).points,[]);
 assert.equal(marketState(d,{now:340000}).status,'stale');assert.equal(marketState(d,{now:300100,error:true}).quiet,false);
 assert.equal(marketState(raw({coverage:{complete:false},status:'backfilling'}),{now:300100}).quiet,false);
 assert.equal(marketState(raw({freshness:{stale:false,updatedAt:400000}}),{now:300100}).status,'stale');
});
test('real candles carry quiet intervals only when history and freshness support it',()=>{
 const d=raw({status:'live',candles:[bar()]});assert.equal(marketSeries(d,300100).carried,4);
 for(const status of ['stale','backfilling','indexing-error','starting'])assert.equal(marketSeries({...d,status},300100).carried,0);
 assert.equal(marketSeries({...d,coverage:{complete:false}},300100).carried,0);
 assert.equal(marketSeries(d,340000).carried,0);
});
test('trade amounts, instruction identity and finalized status are required',()=>{
 const t={signature:'2'.repeat(88),path:'1.2',slot:3,time:120,side:'buy',exact:{coinRaw:'10000000',solLamports:'1',priceSol:'0.0000001'},commitment:'finalized'};
 assert.equal(validateMarket(raw({trades:[t]}),vm,'trades').trades.length,1);
 for(const bad of [{...t,signature:'bad'},{...t,path:'unknown'},{...t,commitment:'confirmed'},{...t,exact:{...t.exact,coinRaw:'1.2'}},{...t,time:null}])assert.throws(()=>validateMarket(raw({trades:[bad]}),vm,'trades'));
});
test('transport authenticates owner and never falls back to legacy market or browser RPC',async()=>{
 const calls=[],api=async(path,body,csrf)=>{calls.push({path,body,csrf});return path==='state'?{owner:'owner',csrf:'csrf'}:raw();};
 const params={interval:'1m',from:60,to:360};await readCampaignMarket({api,owner:'owner',vm,kind:'candles',params});
 assert.equal(calls[1].path,'launches/market/read');assert.equal(calls[1].body.campaign,'campaign');assert.equal(calls[1].csrf,'csrf');
 await assert.rejects(readCampaignMarket({api,owner:'other',vm,kind:'candles',params}),/changed/);assert.equal(calls.length,3);
 await assert.rejects(readCampaignMarket({api,owner:'owner',vm,kind:'candles',params:{...params,to:420}}),/window/);
});

test('fee payloads require exact coin identity, conservation and an observation timestamp',()=>{
 const fees={status:'verified',slot:1,updatedAt:300000,source:'program-fee-state',feeState:'2'.repeat(32),poolTradeFeeRate:'25000',solCollectedLamports:'169',solPendingLamports:'59',solDustLamports:'1',treasuryPaidLamports:'100',devPaidLamports:'10',treasuryAccruedLamports:'148',devAccruedLamports:'20',coinCollectedBaseUnits:'5',coinPendingBaseUnits:'2',coinBurnedBaseUnits:'3'};
 assert.equal(validateMarket(raw({fees}),vm,'fees').fees.coinBurnedBaseUnits,'3');
 assert.equal(validateMarket(raw({fees:null}),vm,'fees').fees,null);
 for(const patch of [{solPendingLamports:'0'},{coinBurnedBaseUnits:'5'},{updatedAt:299000},{poolTradeFeeRate:'0'}])assert.throws(()=>validateMarket(raw({fees:{...fees,...patch}}),vm,'fees'));
 assert.throws(()=>validateMarket(raw({fees,pool:'other'}),vm,'fees'));
});
