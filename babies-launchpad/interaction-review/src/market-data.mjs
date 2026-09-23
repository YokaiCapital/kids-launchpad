// Market feed helpers for the coin page (owner, 23 September 2026): fetch, cache and pure state logic for the
// summary, candle and trade endpoints. Everything here is framework-free so it runs under `node --test`.
// Rules: never invent a price or a candle; a failed read keeps the last valid data and says so. After the first real
// trade a bucket with no trades carries the previous close forward as a flagged, visibly muted bar so the price line
// reads continuously; before the first trade and inside a coverage gap nothing is drawn, so a price is never seeded.
export const INTERVALS=[
 {key:'1m',seconds:60,window:6*3600,label:'1 minute'},
 {key:'5m',seconds:300,window:24*3600,label:'5 minutes'},
 {key:'15m',seconds:900,window:3*86400,label:'15 minutes'},
 {key:'1h',seconds:3600,window:14*86400,label:'1 hour'},
 {key:'1d',seconds:86400,window:365*86400,label:'1 day'}
];
export const DEFAULT_INTERVAL='5m';
export const POLL_MS=10000;
export const STALE_AFTER_SECONDS=120;
export const MAX_SERIES_POINTS=20000;
const REQUEST_TIMEOUT_MS=20000;
export const intervalFor=key=>INTERVALS.find(i=>i.key===key)||INTERVALS.find(i=>i.key===DEFAULT_INTERVAL);

// ---------- fetch ----------
function anySignal(signals){
 const list=signals.filter(Boolean);if(list.length===1)return list[0];
 if(typeof AbortSignal!=='undefined'&&typeof AbortSignal.any==='function')return AbortSignal.any(list);
 const controller=new AbortController();for(const s of list){if(s.aborted){controller.abort(s.reason);break;}s.addEventListener('abort',()=>controller.abort(s.reason),{once:true});}
 return controller.signal;
}
/**
 * One read of /api/market/<path>. Same origin, same credentials as the account API, bounded by a 20 s timeout and the
 * caller's abort signal. Never throws for a bad answer: the result says why so the page can show an honest state.
 * @returns {Promise<{ok:true,data:object}|{ok:false,reason:'off'|'unavailable'|'network'|'malformed'|'aborted',status:number|null}>}
 */
export async function fetchMarket(path,params={},{fetchImpl=globalThis.fetch,signal=null}={}){
 const query=new URLSearchParams();for(const [k,v] of Object.entries(params))if(v!=null&&v!=='')query.set(k,String(v));
 const url='/api/market/'+path+(query.size?'?'+query.toString():'');
 const timeout=typeof AbortSignal!=='undefined'&&typeof AbortSignal.timeout==='function'?AbortSignal.timeout(REQUEST_TIMEOUT_MS):null;
 let response;
 try{response=await fetchImpl(url,{method:'GET',credentials:'same-origin',headers:{Accept:'application/json'},signal:anySignal([signal,timeout])});}
 catch(e){return {ok:false,reason:signal?.aborted?'aborted':'network',status:null};}
 const type=(typeof response.headers?.get==='function'&&response.headers.get('content-type'))||'';
 if(!type.includes('application/json'))return {ok:false,reason:'unavailable',status:response.status??null};
 let data;try{data=await response.json();}catch{return {ok:false,reason:'malformed',status:response.status??null};}
 if(data&&typeof data==='object'&&data.configured===false)return {ok:false,reason:'off',status:response.status??null};
 if(!response.ok)return {ok:false,reason:'unavailable',status:response.status??null};
 if(!data||typeof data!=='object')return {ok:false,reason:'malformed',status:response.status??null};
 if(path==='candles'&&!Array.isArray(data.candles))return {ok:false,reason:'malformed',status:response.status??null};
 if(path==='trades'&&!Array.isArray(data.trades))return {ok:false,reason:'malformed',status:response.status??null};
 return {ok:true,data:adaptMarketData(path,data)};
}
/** The served shapes (localnet/market/api.mjs) use long names and nested feed/coverage objects; the page's helpers read
 * short, flat fields. Both spellings are accepted so fixtures and the live API render the same. */
export function adaptGaps(gaps){return Array.isArray(gaps)?gaps.map(g=>({fromUnix:g?.fromUnix??g?.olderBlockTime??g?.from??null,toUnix:g?.toUnix??g?.newerBlockTime??g?.to??null})):[];}
export function adaptMarketData(path,data){
 if(!data||typeof data!=='object')return data;
 if(path==='summary'){const s=data;const status=s.freshness??(s.status==='live'||s.status==='stale'||s.status==='backfilling'?s.status:s.status?'unavailable':undefined);
  return {...s,priceChange24hPct:s.priceChange24hPct??s.change24hPercent??null,lastTradeUnix:s.lastTradeUnix??s.lastTrade?.time??null,lagSeconds:s.lagSeconds??s.feed?.lagSeconds??null,freshness:status,
   coverage:{fromUnix:s.coverage?.fromUnix??s.coverage?.oldestBlockTime??null,toUnix:s.coverage?.toUnix??s.coverage?.newestBlockTime??null,gaps:adaptGaps(s.coverage?.gaps)}};}
 if(path==='candles')return {...data,gaps:adaptGaps(data.gaps??data.coverage?.gaps)};
 return data;
}

// ---------- cache (last valid data only; a failure is never cached) ----------
const cache=new Map();
export const cacheKey=(campaign,kind,extra='')=>[campaign||'',kind,extra].join('|');
export function readCache(key){return cache.get(key)||null;}
export function writeCache(key,value){if(value==null)return;cache.set(key,{...value,cachedAt:Date.now()});}
export function clearCache(){cache.clear();}

// ---------- numbers ----------
const finite=v=>{if(v==null||v==='')return null;const n=typeof v==='number'?v:Number(String(v).trim());return Number.isFinite(n)?n:null;};
const groupWhole=whole=>whole.replace(/\B(?=(\d{3})+(?!\d))/g,',');
function fixed(n,places){const text=n.toFixed(places);const [whole,frac='']=text.split('.');const trimmed=frac.replace(/0+$/,'');return groupWhole(whole)+(trimmed?'.'+trimmed:'');}
/** Served amounts are decimal strings: round them half-up with integer maths so "0.000012345" shows 0.00001235, not the float's 0.00001234. */
function fixedDecimal(value,places){
 const m=/^(-)?(\d+)(?:\.(\d+))?$/.exec(String(value).trim());if(!m)return fixed(Number(value),places);
 const digits=BigInt(m[2]+(m[3]||'').padEnd(places+1,'0').slice(0,places+1));const rounded=((digits+5n)/10n).toString().padStart(places+1,'0');
 const whole=rounded.slice(0,rounded.length-places),frac=(places?rounded.slice(rounded.length-places):'').replace(/0+$/,'');
 return (m[1]||'')+groupWhole(whole)+(frac?'.'+frac:'');
}
/** Decimal places that show four significant digits of a small number: 0.000012345 → 8. Capped at 12. */
export function adaptiveDecimals(n){const a=Math.abs(n);if(a===0)return 0;if(a>=1000)return 2;if(a>=1)return 4;const zeros=Math.max(0,-Math.floor(Math.log10(a))-1);return Math.min(12,zeros+4);}
/** SOL per coin. Small prices keep four significant digits; the exact served string stays in `exact`. */
export function formatPrice(value){
 const n=finite(value);if(n==null||n<0)return {text:'—',exact:null};
 return {text:fixedDecimal(value,adaptiveDecimals(n)),exact:String(value).trim()};
}
/** SOL volume for a tile: compact above 1,000, otherwise two to four places. */
export function formatSolVolume(value){
 const n=finite(value);if(n==null||n<0)return {text:'—',exact:null};
 const exact=String(value).trim();
 if(n>=1000)return {text:n.toLocaleString('en-US',{notation:'compact',maximumFractionDigits:2}),exact};
 if(n>=1)return {text:fixedDecimal(value,2),exact};
 return {text:fixedDecimal(value,4),exact};
}
/** 24h change: signed, two places, with a tone the tile can colour. Unknown is a dash, never 0 %. */
export function formatChange(pct){
 const n=finite(pct);if(n==null)return {text:'—',tone:'none'};
 const rounded=Math.round(n*100)/100;if(rounded===0)return {text:'0.00%',tone:'flat'};
 return {text:(rounded>0?'+':'−')+Math.abs(rounded).toFixed(2)+'%',tone:rounded>0?'up':'down'};
}
export function formatCount(n){const v=finite(n);return v==null?'—':Math.round(v).toLocaleString('en-GB');}

// ---------- time ----------
export function relativeTime(unix,nowUnix){
 const t=finite(unix),now=finite(nowUnix);if(t==null||now==null)return '';
 const d=Math.max(0,Math.floor(now-t));
 if(d<5)return 'just now';if(d<60)return d+' s ago';if(d<3600)return Math.floor(d/60)+' min ago';if(d<86400)return Math.floor(d/3600)+' h ago';return Math.floor(d/86400)+' d ago';
}
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/** '23 Sep 2026, 14:03:22 UTC'. Never the viewer's zone. */
export function utcStamp(unix){
 const t=finite(unix);if(t==null)return '';const d=new Date(t*1000);if(Number.isNaN(d.getTime()))return '';const two=n=>String(n).padStart(2,'0');
 return d.getUTCDate()+' '+MONTHS[d.getUTCMonth()]+' '+d.getUTCFullYear()+', '+two(d.getUTCHours())+':'+two(d.getUTCMinutes())+':'+two(d.getUTCSeconds())+' UTC';
}
export function isoStamp(unix){const t=finite(unix);return t==null?'':new Date(t*1000).toISOString();}

// ---------- candles ----------
/** A served candle becomes a chart bar, or null when any field is not a finite number or the range is impossible. */
export function normaliseCandle(c){
 if(!c||typeof c!=='object')return null;
 const time=finite(c.t??c.time),open=finite(c.o??c.open),high=finite(c.h??c.high),low=finite(c.l??c.low),close=finite(c.c??c.close);
 if([time,open,high,low,close].some(v=>v==null||v<0))return null;
 if(high<low||high<Math.max(open,close)||low>Math.min(open,close))return null;
 const volume=finite(c.v??c.volumeSol),trades=finite(c.n??c.trades);
 return {time:Math.floor(time),open,high,low,close,volume:volume==null?null:volume,trades:trades==null?null:Math.round(trades),provisional:c.provisional===true};
}
/** Ascending by time, one bar per bucket; an incoming bar replaces the bar it shares a bucket with (this is how a provisional bar is replaced). */
export function mergeCandles(existing,incoming){
 const map=new Map();for(const bar of existing||[])if(bar)map.set(bar.time,bar);
 for(const raw of incoming||[]){const bar=normaliseCandle(raw);if(bar)map.set(bar.time,bar);}// always normalised (served bars use volumeSol/trades)
 return [...map.values()].sort((a,b)=>a.time-b.time);
}
/** Union of coverage gaps, deduplicated and sorted; invalid entries dropped. */
export function mergeGaps(existing,incoming){
 const map=new Map();for(const g of [...(existing||[]),...(incoming||[])]){const from=finite(g?.fromUnix),to=finite(g?.toUnix);if(from==null||to==null||to<from)continue;map.set(from+'-'+to,{fromUnix:from,toUnix:to});}
 return [...map.values()].sort((a,b)=>a.fromUnix-b.fromUnix);
}
export const alignDown=(unix,seconds)=>Math.floor(unix/seconds)*seconds;
/**
 * Chart data: real bars plus one point per bucket between the first bar (or `fromUnix`) and `toUnix`.
 * Before the first real bar every bucket is whitespace (no price exists yet). After it, a bucket without a trade
 * becomes a carried bar (open = high = low = close = previous close, volume 0, trades 0, `carried: true`) so the line
 * reads continuously; the chart draws these muted. Buckets inside a coverage gap stay whitespace, and carrying only
 * resumes at the next real bar after the gap: the feed does not know what traded there, so nothing is drawn.
 * When the range would exceed MAX_SERIES_POINTS the fill is skipped and `filled` is false (the axis becomes index-based).
 * @returns {{points:object[],filled:boolean,carried:number}}  carried = how many carried bars were drawn
 */
export function seriesData(candles,{intervalSeconds,fromUnix=null,toUnix=null,gaps=[]}){
 const bars=(candles||[]).slice().sort((a,b)=>a.time-b.time);
 if(!bars.length)return {points:[],filled:true,carried:0};
 const start=alignDown(Math.min(bars[0].time,fromUnix==null?bars[0].time:fromUnix),intervalSeconds);
 const end=alignDown(Math.max(bars[bars.length-1].time,toUnix==null?bars[bars.length-1].time:toUnix),intervalSeconds);
 const count=Math.floor((end-start)/intervalSeconds)+1;
 if(count>MAX_SERIES_POINTS)return {points:bars.map(b=>toPoint(b)),filled:false,carried:0};
 const byTime=new Map(bars.map(b=>[alignDown(b.time,intervalSeconds),b]));
 const ranges=(gaps||[]).map(g=>[Number(g?.fromUnix),Number(g?.toUnix)]).filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>=a);
 const inGap=t=>ranges.some(([a,b])=>t<b&&t+intervalSeconds>a);// the bucket overlaps a coverage gap
 const points=[];let carry=null,carried=0;
 for(let t=start;t<=end;t+=intervalSeconds){
  const bar=byTime.get(t);
  if(bar){points.push(toPoint(bar,t));carry=bar.close;continue;}
  if(inGap(t)){points.push({time:t});carry=null;continue;}
  if(carry==null){points.push({time:t});continue;}
  points.push({time:t,open:carry,high:carry,low:carry,close:carry,volume:0,trades:0,carried:true});carried++;
 }
 return {points,filled:true,carried};
}
const toPoint=(bar,time=bar.time)=>({time,open:bar.open,high:bar.high,low:bar.low,close:bar.close});
const samePoint=(a,b)=>a.time===b.time&&a.open===b.open&&a.high===b.high&&a.low===b.low&&a.close===b.close&&!!a.carried===!!b.carried;// a carried bar that becomes a real one must repaint
/**
 * How to move the chart from `applied` points to `next` without losing the reader's zoom: append or update bars in place
 * (historical updates for older buckets), or reset when the series start moved or shrank.
 * @returns {{reset:boolean,updates:{point:object,historical:boolean}[]}}
 */
export function diffForUpdate(applied,next){
 if(!applied?.length||!next?.length||applied[0].time!==next[0].time||next.length<applied.length)return {reset:true,updates:[]};
 const updates=[];const last=applied.length-1;
 for(let i=0;i<applied.length;i++){if(applied[i].time!==next[i].time)return {reset:true,updates:[]};if(!samePoint(applied[i],next[i]))updates.push({point:next[i],historical:i<last});}
 for(let i=applied.length;i<next.length;i++)updates.push({point:next[i],historical:false});
 return {reset:false,updates};
}
/** Chart price precision from the bars on screen (four significant digits of the smallest close). */
export function pricePrecision(candles){
 let min=null;for(const b of candles||[]){if(b.close>0&&(min==null||b.close<min))min=b.close;}
 return min==null?4:Math.max(2,adaptiveDecimals(min));
}
/** The fetch window for one interval: the whole window when nothing is held, else from one bucket before the last bar. */
export function candleRange(intervalKey,candles,nowUnix){
 const {seconds,window}=intervalFor(intervalKey);const to=Math.floor(nowUnix);
 const last=candles?.length?candles[candles.length-1].time:null;
 return {from:last==null?to-window:Math.max(to-window,last-seconds),to};
}

// ---------- trades ----------
export function normaliseTrade(t){
 if(!t||typeof t!=='object'||typeof t.signature!=='string'||!t.signature)return null;
 const side=t.side==='buy'||t.side==='sell'?t.side:null;if(!side)return null;
 const blockTimeUnix=finite(t.blockTimeUnix??t.time),slot=finite(t.slot);const solRaw=t.solRaw??t.exact?.solLamports??null,coinRaw=t.coinRaw??t.exact?.coinRaw??null,priceSol=t.exact?.priceSol??t.priceSol??null;
const path=typeof t.path==='string'?t.path:typeof t.instructionPath==='string'?t.instructionPath:'';
 return {signature:t.signature,path,key:t.signature+':'+path,slot:slot==null?null:Math.floor(slot),blockTimeUnix:blockTimeUnix==null?null:Math.floor(blockTimeUnix),side,solRaw:solRaw==null?null:String(solRaw),coinRaw:coinRaw==null?null:String(coinRaw),priceSol:priceSol==null?null:String(priceSol),nested:t.nested===true,provisional:t.provisional===true||(typeof t.commitment==='string'&&t.commitment!=='finalized'),wallet:typeof t.wallet==='string'?t.wallet:typeof t.trader==='string'?t.trader:null};
}
/** Newest first, one row per signature; an incoming row replaces the row it shares a signature with (confirming → confirmed). */
export function mergeTrades(existing,incoming){
 const map=new Map();for(const t of existing||[])if(t)map.set(t.key||t.signature,t);
 for(const raw of incoming||[]){const t=normaliseTrade(raw);if(t)map.set(t.key,t);}// one row per swap instruction: a transaction with two swaps on our pool is two rows// always normalised: served rows carry `time` and `exact` amounts, not the page's field names
 return [...map.values()].sort((a,b)=>(b.blockTimeUnix??0)-(a.blockTimeUnix??0)||(b.slot??0)-(a.slot??0)||(a.signature<b.signature?-1:1));
}

// ---------- state ----------
/**
 * One word for what the market feed is doing, from the newest summary read.
 * @param {{summary:object|null,result:object|null,nowUnix:number}} input  summary = last valid summary, result = last fetch result
 * @returns {'loading'|'off'|'unavailable'|'no-trades'|'backfilling'|'stale'|'live'}
 */
export function deriveMarketState({summary,result,nowUnix}){
 if(!result)return summary?stateFromSummary(summary,nowUnix):'loading';
 if(!result.ok)return result.reason==='off'?'off':'unavailable';
 return stateFromSummary(summary||result.data,nowUnix);
}
function stateFromSummary(s,nowUnix){
 if(!s||s.configured===false)return 'off';
 if(s.freshness==='unavailable')return 'unavailable';
 if(s.freshness==='backfilling')return 'backfilling';
 const lag=finite(s.lagSeconds);const trades=finite(s.trades24h);const last=finite(s.lastTradeUnix);
 if(last==null&&(trades==null||trades===0)&&finite(s.priceSol)==null)return 'no-trades';
 if(s.freshness==='stale'||(lag!=null&&lag>STALE_AFTER_SECONDS))return 'stale';
 if(s.freshness==='live')return 'live';
 return lag==null?'live':'live';
}
export const STATE_COPY={
 loading:{chip:'Loading…',title:'Loading the chart…',body:'Reading the last trades from the feed.'},
 off:{chip:'Feed not connected',title:'A home for every move.',body:'The price chart appears here when the market feed is connected.'},
 unavailable:{chip:'Feed unavailable',title:'The market feed is unavailable.',body:'The pool is fine; the site cannot reach the trade feed right now. It retries every 10 seconds.'},
 'no-trades':{chip:'No trades yet',title:'No trades yet.',body:'The first candle appears with the first trade.'},
 backfilling:{chip:'Backfilling',title:'Filling in trade history…',body:'The feed is reading older trades. Prices shown so far are real; the history is still incomplete.'},
 stale:{chip:'Stale',title:'',body:''},
 live:{chip:'Live',title:'',body:''}
};
/** Chip tone for CSS: live, stale, wait (loading, backfilling, no trades), off (unavailable, not connected). */
export const stateTone=state=>state==='live'?'live':state==='stale'?'stale':state==='unavailable'||state==='off'?'off':'wait';
/**
 * The small line under a market figure: how fresh the number is. `lastReadUnix` is when the page last read the feed
 * successfully; `lagSeconds` is how far the feed itself is behind the chain.
 */
export function freshnessHint({state,summary,lastReadUnix,nowUnix}){
 if(state==='loading')return {text:'Reading the feed…',tone:'wait'};
 if(state==='off')return {text:'Market feed not connected',tone:'off'};
 if(state==='unavailable')return {text:lastReadUnix?'Feed unavailable · last read '+relativeTime(lastReadUnix,nowUnix):'Feed unavailable',tone:'off'};
 if(state==='backfilling')return {text:'Backfilling'+(lastReadUnix?' · read '+relativeTime(lastReadUnix,nowUnix):''),tone:'wait'};
 if(state==='no-trades')return {text:'No trades yet',tone:'wait'};
 const lag=finite(summary?.lagSeconds);
 if(state==='stale')return {text:'Stale'+(lag!=null?' · feed '+relativeTime(nowUnix-lag,nowUnix).replace(' ago',' behind'):''),tone:'stale'};
 return {text:'Updated '+relativeTime(lastReadUnix??nowUnix,nowUnix),tone:'live'};
}
/**
 * Two-sided pool value in SOL: the SOL side as served plus the coin side valued at the last price. Without a price only the
 * SOL side is known and `total` is null; nothing is guessed.
 */
export function poolLiquidity({quoteReserveLamports,baseReserveRaw,decimals=6,priceSol}){
 let sol=null,coins=null;
 try{if(quoteReserveLamports!=null)sol=Number(BigInt(quoteReserveLamports))/1e9;}catch{sol=null;}
 try{if(baseReserveRaw!=null)coins=Number(BigInt(baseReserveRaw))/10**decimals;}catch{coins=null;}
 const price=finite(priceSol);
 const coinSideSol=coins!=null&&price!=null?coins*price:null;
 return {solSide:sol,coins,coinSideSol,total:sol!=null&&coinSideSol!=null?sol+coinSideSol:null};
}
export function formatSol(n,places=null){const v=finite(n);if(v==null)return '—';return fixed(v,places??(v>=1000?2:v>=1?4:v===0?0:adaptiveDecimals(v)));}

// ---------- polling (visibility-aware, framework-free) ----------
/**
 * Calls `run` now and every `ms` while the document is visible; pauses when hidden and runs again on return.
 * Returns a stop function. `run` receives nothing; the caller owns its own abort handling.
 */
export function startPolling(run,ms,{doc=globalThis.document,setInterval:si=globalThis.setInterval,clearInterval:ci=globalThis.clearInterval}={}){
 let timer=null,stopped=false;
 const visible=()=>!doc||doc.visibilityState!=='hidden';
 const tick=()=>{if(!stopped&&visible())run();};
 const arm=()=>{if(timer==null&&visible()&&!stopped)timer=si(tick,ms);};
 const disarm=()=>{if(timer!=null){ci(timer);timer=null;}};
 const onVisibility=()=>{if(visible()){tick();arm();}else disarm();};
 doc?.addEventListener?.('visibilitychange',onVisibility);
 tick();arm();
 return ()=>{stopped=true;disarm();doc?.removeEventListener?.('visibilitychange',onVisibility);};
}
