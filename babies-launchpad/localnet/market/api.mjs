// Public market reads: summary, candles, trades. Every response is computed from the store (never from RPC) and
// cached in memory for a short window; concurrent viewers of the same key share one computation (single flight).
// Prices reach the wire as floats for the chart plus exact decimal strings; volumes as exact strings and floats.
import {INTERVALS,INTERVAL_NAMES} from './store.mjs';
import {formatScaled,scaledToNumber} from './decode.mjs';
const ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const MAX_BUCKETS=1000,STALE_AFTER_SECONDS=120;
const lamportsToSol=l=>Number(BigInt(l))/1e9,rawToCoin=(raw,decimals)=>Number(BigInt(raw))/10**decimals;
const int=(v,fallback)=>{if(v===undefined||v===null||v==='')return fallback;if(!/^\d{1,12}$/.test(v))throw Error('Invalid number: '+v);return Number(v);};
export function feedStatus(stats,cursor,summary){
 if(!stats)return 'disabled';
 if(stats.lastPollOk===false||(stats.lagSeconds!==null&&stats.lagSeconds>STALE_AFTER_SECONDS))return 'stale';
 if(stats.lastPollAt===null)return 'starting';
 if(!cursor.backfillComplete||cursor.gaps.length)return summary?.tradesTotal?'backfilling':'backfilling';
 if(!summary?.tradesTotal)return 'no-trades';
 return 'live';
}
export function shapeSwap(s){
 return {signature:s.signature,path:s.instructionPath,slot:s.slot,txIndex:s.txIndex,time:s.blockTime,side:s.side,trader:s.trader,sol:lamportsToSol(s.solLamports),coin:rawToCoin(s.coinRaw,s.coinDecimals),priceSol:scaledToNumber(s.priceScaled),exact:{solLamports:s.solLamports,coinRaw:s.coinRaw,coinDecimals:s.coinDecimals,priceSol:formatScaled(s.priceScaled)},nested:s.nested,outerProgram:s.outerProgram,commitment:s.commitment};
}
export function shapeCandle(c,coinDecimals){
 return {time:c.time,open:scaledToNumber(c.open),high:scaledToNumber(c.high),low:scaledToNumber(c.low),close:scaledToNumber(c.close),volumeSol:lamportsToSol(c.volumeSol),volumeCoin:rawToCoin(c.volumeCoin,coinDecimals),trades:c.trades,buys:c.buys,sells:c.sells,exact:{open:formatScaled(c.open),high:formatScaled(c.high),low:formatScaled(c.low),close:formatScaled(c.close),volumeSolLamports:c.volumeSol,volumeCoinRaw:c.volumeCoin}};
}
export function coverageOf(cursor,summary){
 return {oldestBlockTime:summary?.oldestBlockTime??null,newestBlockTime:summary?.newestBlockTime??null,completeToLaunch:cursor.backfillComplete,gaps:cursor.gaps.map(g=>({newerSlot:g.newerSlot,olderSlot:g.olderSlot,reason:g.reason})),updatedAt:cursor.updatedAt};
}
/**
 * feed: {identity():identity|null, store():store|null, stats():stats|null, enabled:boolean}
 * identity: {campaign, pool, mint, genesis, coinDecimals, ...}
 */
export function createMarketApi({feed,now=Date.now,cacheMs=2000,maxCacheEntries=500}){
 const cache=new Map();
 function cached(key,compute){
  const t=now();const hit=cache.get(key);
  if(hit&&(hit.pending||hit.expires>t))return hit.promise;
  const entry={pending:true,expires:t+cacheMs,promise:null};
  entry.promise=Promise.resolve().then(compute).then(value=>{entry.pending=false;entry.expires=now()+cacheMs;return value;},error=>{cache.delete(key);throw error;});
  if(cache.size>=maxCacheEntries)cache.delete(cache.keys().next().value);
  cache.set(key,entry);return entry.promise;
 }
 function context(params){
  if(!feed.enabled)return {error:{status:503,body:{error:'Market data is switched off',status:'disabled'}}};
  const identity=feed.identity(),store=feed.store();
  if(!identity||!store)return {error:{status:503,body:{error:'Market data is not available until the campaign has launched',status:'not-launched'}}};
  const campaign=params.get('campaign');
  if(typeof campaign!=='string'||!ADDRESS.test(campaign))return {error:{status:400,body:{error:'campaign is required'}}};
  if(campaign!==identity.campaign)return {error:{status:404,body:{error:'Campaign is not a registered launched pool'}}};
  return {identity,store,scope:{genesis:identity.genesis,pool:identity.pool}};
 }
 const summary=(ctx)=>{
  const nowUnix=Math.floor(now()/1000),s=ctx.store.summary(ctx.scope,nowUnix),cursor=ctx.store.getCursor(ctx.scope),stats=feed.stats();
  const change=s.last&&s.open24h&&BigInt(s.open24h)>0n?Number(((BigInt(s.last.priceScaled)-BigInt(s.open24h))*10000n/BigInt(s.open24h)))/100:null;
  return {campaign:ctx.identity.campaign,pool:ctx.identity.pool,mint:ctx.identity.mint,quote:'SOL',coinDecimals:ctx.identity.coinDecimals,
   priceSol:s.last?scaledToNumber(s.last.priceScaled):null,priceSolExact:s.last?formatScaled(s.last.priceScaled):null,
   lastTrade:s.last?shapeSwap(s.last):null,change24hPercent:change,
   volume24hSol:lamportsToSol(s.volume24hSol),volume24hSolExact:s.volume24hSol,volume24hCoin:rawToCoin(s.volume24hCoin,ctx.identity.coinDecimals),
   trades24h:s.trades24h,buys24h:s.buys24h,sells24h:s.sells24h,tradesTotal:s.tradesTotal,
   status:feedStatus(stats,cursor,s),
   feed:stats?{connected:stats.connected,lagSeconds:stats.lagSeconds,lastPollAt:stats.lastPollAt,lastTradeAgeSeconds:stats.lastTradeAgeSeconds,backfillComplete:stats.backfillComplete,openGaps:stats.openGaps,decodeFailures:stats.decodeFailures,unsupportedTransactions:stats.unsupportedRecorded??0,provisional:stats.store?.provisional??null,websocket:stats.ws?.connected??false}:null,
   coverage:coverageOf(cursor,s),at:new Date(now()).toISOString()};
 };
 const candles=(ctx,params)=>{
  const interval=params.get('interval')||'1m';if(!INTERVALS[interval])throw Error('interval must be one of '+INTERVAL_NAMES.join(', '));
  const size=INTERVALS[interval],nowUnix=Math.floor(now()/1000);
  let to=int(params.get('to'),nowUnix+size),from=int(params.get('from'),null);
  if(from===null)from=to-size*300;
  if(from>=to)throw Error('from must be before to');
  if((to-from)/size>MAX_BUCKETS){from=to-size*MAX_BUCKETS;}
  const rows=ctx.store.candles(ctx.scope,interval,from,to,MAX_BUCKETS),cursor=ctx.store.getCursor(ctx.scope),s=ctx.store.summary(ctx.scope,nowUnix);
  return {campaign:ctx.identity.campaign,interval,from,to,candles:rows.map(c=>shapeCandle(c,ctx.identity.coinDecimals)),coverage:coverageOf(cursor,s),status:feedStatus(feed.stats(),cursor,s),at:new Date(now()).toISOString()};
 };
 const trades=(ctx,params)=>{
  const limit=int(params.get('limit'),50);if(limit<1||limit>200)throw Error('limit must be between 1 and 200');
  const page=ctx.store.trades(ctx.scope,{cursor:params.get('cursor')||null,limit});
  return {campaign:ctx.identity.campaign,trades:page.trades.map(shapeSwap),nextCursor:page.nextCursor,at:new Date(now()).toISOString()};
 };
 async function handle(req,res){
  const url=new URL(req.url,'http://localhost'),path=url.pathname;
  if(!path.startsWith('/api/market/'))return false;
  const send=(code,data)=>{if(res.writableEnded)return;res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'public, max-age=2','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
  if(req.method!=='GET'){send(405,{error:'Method not allowed'});return true;}
  const route={'/api/market/summary':summary,'/api/market/candles':candles,'/api/market/trades':trades}[path];
  if(!route){send(404,{error:'Not found'});return true;}
  const ctx=context(url.searchParams);if(ctx.error){send(ctx.error.status,ctx.error.body);return true;}
  const key=path+'?'+[...url.searchParams.entries()].filter(([k])=>['campaign','interval','from','to','cursor','limit'].includes(k)).sort().map(([k,v])=>k+'='+v).join('&');
  try{send(200,await cached(key,()=>route(ctx,url.searchParams)));}
  catch(error){send(400,{error:String(error.message||error).slice(0,200)});}
  return true;
 }
 return {handle,middleware:(req,res,next)=>{handle(req,res).then(handled=>{if(!handled)next();},next);},cacheSize:()=>cache.size};
}
