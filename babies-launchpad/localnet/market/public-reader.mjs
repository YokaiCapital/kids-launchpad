// Database-only campaign market reads. Authentication/admission belong to the
// account gateway. Never falls back to RPC when the shared projection is missing.
import {isAddress} from '../registry/registry.mjs';
import {INTERVALS} from './store.mjs';import {shapeSwap,shapeCandle} from './api.mjs';
import {scaledToNumber,formatScaled} from './decode.mjs';
import {providerFreshness} from './freshness.mjs';
export function createPublicMarketReader({store,genesisHash,programId,now=Date.now,cacheMs=2000,maxCacheEntries=500,staleAfterMs=30000}){
 if(!isAddress(genesisHash)||!isAddress(programId)||!store?.marketFor||!store?.coverage)throw Error('Scoped shared market store required');
 if(!Number.isInteger(maxCacheEntries)||maxCacheEntries<1||maxCacheEntries>2000||!Number.isInteger(cacheMs)||cacheMs<0||cacheMs>5000||!Number.isInteger(staleAfterMs)||staleAfterMs<1000||staleAfterMs>120000)throw Error('Invalid market read bounds');
 const cache=new Map();
 async function read(input){
  const {campaign,kind='trades'}=input||{};
  if(!isAddress(campaign)||!['trades','candles','fees'].includes(kind))throw Error('Invalid market request');
  const id={genesisHash,programId,campaign};let params;
  if(kind==='trades'){
   const {limit=20,cursor=null}=input;
   if(!Number.isInteger(limit)||limit<1||limit>100||cursor!==null&&(typeof cursor!=='string'||cursor.length>160||!/^[0-9A-Za-z:.]+$/.test(cursor)))throw Error('Invalid trade page');
   params={limit,before:cursor};
  }else if(kind==='candles'){
   const {interval='1m',from,to}=input;
   if(!Object.hasOwn(INTERVALS,interval)||!Number.isSafeInteger(from)||from<0||!Number.isSafeInteger(to)||to<=from||Math.ceil(to/INTERVALS[interval])-Math.floor(from/INTERVALS[interval])>1000)throw Error('Request at most 1000 candle buckets');
   params={interval,from:Math.floor(from/INTERVALS[interval])*INTERVALS[interval],to:Math.ceil(to/INTERVALS[interval])*INTERVALS[interval],limit:1000};
  }
  const key=JSON.stringify([campaign,kind,params]),hit=cache.get(key);
  if(hit&&(hit.pending||hit.until>now()))return hit.promise;
  // Keep active work resident so another identical request cannot bypass single
  // flight. Under excessive distinct queries, refuse before starting extra reads.
  if(cache.size>=maxCacheEntries){for(const [k,v]of cache){if(!v.pending){cache.delete(k);break;}}}
  if(cache.size>=maxCacheEntries)throw Object.assign(Error('Market reader at capacity'),{code:'CAPACITY_WAIT'});
  const entry={pending:true,until:0,promise:null};cache.set(key,entry);
  entry.promise=Promise.resolve().then(async()=>{
   const market=await store.marketFor(id);
   if(!market)return {available:false,status:'not-indexed',genesisHash,programId,campaign,commitment:'finalized'};
   const scope={genesis:genesisHash,pool:market.pool};
   const [coverage,page,last]=await Promise.all([store.coverage(id),kind==='trades'?store.trades(scope,params):kind==='fees'?store.feeSnapshot(id):store.candles(scope,params),kind==='fees'?Promise.resolve({trades:[]}):store.trades(scope,{limit:1})]);
   const at=now(),updatedAt=kind==='fees'?page?.updatedAt??null:coverage?.lastPollAt??null,age=updatedAt==null?null:Math.max(0,at-updatedAt);
   const provider=providerFreshness(kind==='fees'?{slot:page?.slot,time:page?.chainTime}:coverage?.providerHead,at),stale=age===null||age>staleAfterMs||updatedAt>at+5000||provider.stale;
   const status=coverage?.failedJobs?'indexing-error':age===null?'starting':stale?'stale':coverage.pendingBackfills>0||coverage.openingVerified!==true?'backfilling':last.trades.length?'live':'no-trades';
   return {available:true,genesisHash,programId,campaign,pool:market.pool,mint:market.mint,coinDecimals:market.coinDecimals,quote:'SOL',commitment:'finalized',status,
    freshness:{updatedAt,ageMs:age,stale,provider},coverage:{...coverage,complete:coverage?.lastPollAt!=null&&coverage.openingVerified===true&&!coverage.failedJobs&&!coverage.pendingBackfills},
    openingReference:{time:market.launchTime,priceSol:scaledToNumber(market.openingPriceScaled),priceSolExact:formatScaled(market.openingPriceScaled),source:'pool-opening',isTrade:false},
    ...(kind==='fees'?{fees:page}:kind==='trades'?{trades:page.trades.map(shapeSwap),nextCursor:page.nextCursor}:{interval:params.interval,from:params.from,to:params.to,candles:page.map(c=>shapeCandle(c,market.coinDecimals))}),at};
  }).then(value=>{entry.pending=false;entry.until=now()+cacheMs;return value;},error=>{if(cache.get(key)===entry)cache.delete(key);throw error;});
  return entry.promise;
 }
 return {read,cacheSize:()=>cache.size};
}
