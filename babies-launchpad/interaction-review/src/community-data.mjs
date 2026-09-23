// Community pages (owner, 23 September 2026): the believers list and the blocked wallets. Fetch plus the pure
// helpers behind both pages, framework-free so they run under `node --test`.
// Rules: the pages never invent an entry, a count or a time; a missing file (404) is "not published yet", a failed
// read is "could not load", and both are said out loud instead of rendering an empty list as if it were true.
export const REFRESH_MINUTES=30;
export const PAGE_SIZE=100;
export const POSTS=[
 {label:'the first post',url:'https://x.com/YokaiCapital/status/2101747601494147202'},
 {label:'the ask',url:'https://x.com/YokaiCapital/status/2102035724178448627'}
];
export const FOLLOW_URL='https://x.com/kidsdotfun';
export const HOW_KINDS=['answered the ask','agreed in a reply','agreed in a quote','retweeted','liked the ask'];
const REQUEST_TIMEOUT_MS=20000;

// ---------- fetch ----------
function anySignal(signals){
 const list=signals.filter(Boolean);if(list.length===1)return list[0];
 if(typeof AbortSignal!=='undefined'&&typeof AbortSignal.any==='function')return AbortSignal.any(list);
 const controller=new AbortController();for(const s of list){if(s.aborted){controller.abort(s.reason);break;}s.addEventListener('abort',()=>controller.abort(s.reason),{once:true});}
 return controller.signal;
}
/**
 * One read of /api/community/<name>, same origin, bounded by a 20 s timeout and the caller's abort signal.
 * Never throws for a bad answer: the result says why so the page can show an honest state.
 * @returns {Promise<{ok:true,data:object}|{ok:false,reason:'not-published'|'unavailable'|'network'|'malformed'|'aborted',status:number|null}>}
 */
export async function fetchCommunity(name,{fetchImpl=globalThis.fetch,signal=null}={}){
 const url='/api/community/'+name;
 const timeout=typeof AbortSignal!=='undefined'&&typeof AbortSignal.timeout==='function'?AbortSignal.timeout(REQUEST_TIMEOUT_MS):null;
 let response;
 try{response=await fetchImpl(url,{method:'GET',credentials:'same-origin',headers:{Accept:'application/json'},signal:anySignal([signal,timeout])});}
 catch(e){return {ok:false,reason:signal?.aborted?'aborted':'network',status:null};}
 const status=response.status??null;
 if(status===404)return {ok:false,reason:'not-published',status};
 const type=(typeof response.headers?.get==='function'&&response.headers.get('content-type'))||'';
 if(!response.ok||!type.includes('application/json'))return {ok:false,reason:'unavailable',status};
 let data;try{data=await response.json();}catch{return {ok:false,reason:'malformed',status};}
 if(!data||typeof data!=='object'||Array.isArray(data))return {ok:false,reason:'malformed',status};
 return {ok:true,data};
}
/** Plain words for a failed read, shared by both pages. */
export function readFailureText(reason,what){
 if(reason==='not-published')return `The ${what} is not published yet. Check back after the next update.`;
 if(reason==='network')return `The ${what} could not be loaded. Check your connection and try again.`;
 return `The ${what} could not be loaded right now. Try again in a moment.`;
}

// ---------- time ----------
const parseMs=iso=>{const ms=typeof iso==='string'||typeof iso==='number'?Date.parse(iso):NaN;return Number.isFinite(ms)?ms:null;};
const pad=n=>String(n).padStart(2,'0');
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/** "08:00" in UTC, or null when the stamp is unreadable. */
export function utcClock(iso){const ms=parseMs(iso);if(ms==null)return null;const d=new Date(ms);return pad(d.getUTCHours())+':'+pad(d.getUTCMinutes());}
/** "21 Sep 2026" in UTC, or null. */
export function utcDay(iso){const ms=parseMs(iso);if(ms==null)return null;const d=new Date(ms);return d.getUTCDate()+' '+MONTHS[d.getUTCMonth()]+' '+d.getUTCFullYear();}
/** The next publish time: generatedAt plus the refresh period. Null when generatedAt is unreadable. */
export function nextRefreshAt(generatedAt,minutes=REFRESH_MINUTES){const ms=parseMs(generatedAt);if(ms==null)return null;const every=Number.isFinite(minutes)&&minutes>0?minutes:REFRESH_MINUTES;return new Date(ms+every*60000);}
/** The line under the counter. Every part is computed from the envelope, nothing is assumed. */
export function refreshLine(generatedAt,minutes=REFRESH_MINUTES){
 const at=utcClock(generatedAt),next=nextRefreshAt(generatedAt,minutes);
 if(!at||!next)return {refreshed:null,every:minutes,next:null,text:'Refresh time unknown'};
 const every=Number.isFinite(minutes)&&minutes>0?minutes:REFRESH_MINUTES;
 return {refreshed:at,every,next:utcClock(next.toISOString()),text:`refreshed ${at} UTC · refreshes every ${every} minutes · not here yet? next refresh at ${utcClock(next.toISOString())} UTC`};
}

// ---------- supporters ----------
const validSupporter=e=>e&&typeof e==='object'&&typeof e.xId==='string'&&typeof e.username==='string'&&e.username.length>0&&parseMs(e.since)!=null;
/**
 * Rank the list: 1 is the earliest `since`, ties break on xId so two reads always agree. Entries missing an id,
 * a username or a readable `since` are dropped rather than ranked on a guess.
 */
export function rankSupporters(entries){
 const list=(Array.isArray(entries)?entries:[]).filter(validSupporter).map(e=>({...e,how:Array.isArray(e.how)?e.how.filter(h=>typeof h==='string'):[],followers:Number.isFinite(e.followers)?e.followers:null,sinceMs:parseMs(e.since)}));
 list.sort((a,b)=>a.sinceMs-b.sinceMs||(a.xId<b.xId?-1:a.xId>b.xId?1:0));
 return list.map((e,i)=>({...e,rank:i+1}));
}
/** xId → the first proved wallet (earliest provedAt wins). Bad rows are ignored. */
export function walletIndex(entries){
 const rows=(Array.isArray(entries)?entries:[]).filter(e=>e&&typeof e.xId==='string'&&typeof e.wallet==='string'&&e.wallet.length>=32);
 rows.sort((a,b)=>(parseMs(a.provedAt)??Infinity)-(parseMs(b.provedAt)??Infinity));
 const map=new Map();for(const row of rows)if(!map.has(row.xId))map.set(row.xId,{wallet:row.wallet,provedAt:row.provedAt,tweetUrl:typeof row.tweetUrl==='string'?row.tweetUrl:null});
 return map;
}
/** "AAuw…sdoE" for a badge; the full address stays in the title and the copy action. */
export function shortWallet(wallet){return typeof wallet==='string'&&wallet.length>12?wallet.slice(0,4)+'…'+wallet.slice(-4):wallet||'';}
const normalise=s=>String(s||'').trim().replace(/^@/,'').toLowerCase();
/**
 * Filter the ranked list. `query` matches the username or the display name (a leading @ is ignored), `how` is one
 * of HOW_KINDS or '' for all, `walletLinked` keeps only xIds present in the wallet index. Rank is never recomputed.
 */
export function filterSupporters(ranked,{query='',how='',walletLinked=false}={},wallets=new Map()){
 const q=normalise(query);
 return ranked.filter(e=>(!q||e.username.toLowerCase().includes(q)||String(e.name||'').toLowerCase().includes(q))&&(!how||e.how.includes(how))&&(!walletLinked||wallets.has(e.xId)));
}
/** The single exact handle match for the "are you on the list?" answer, or null. */
export function findSupporter(ranked,query){const q=normalise(query);if(!q)return null;return ranked.find(e=>e.username.toLowerCase()===q)||null;}
/** How many entries carry each `how`, plus the wallet-linked count, for the chips. */
export function howCounts(ranked,wallets=new Map()){
 const counts=Object.fromEntries(HOW_KINDS.map(k=>[k,0]));let linked=0;
 for(const e of ranked){for(const h of e.how)if(h in counts)counts[h]++;if(wallets.has(e.xId))linked++;}
 return {...counts,walletLinked:linked};
}
/** The newest `n` names, latest first. */
export function newestSupporters(ranked,n=5){return ranked.slice(-n).reverse();}
/** Count-up easing: the value shown at `progress` (0..1) of the way to `total`. Ends exactly on total. */
export function countUpValue(progress,total){const p=Math.min(1,Math.max(0,progress));return Math.round(total*(1-Math.pow(1-p,3)));}
/** 25858 → "25.9K"; null → "". */
export function compactCount(n){if(!Number.isFinite(n))return '';if(n<1000)return String(n);if(n<1e6)return (n/1e3).toFixed(n<1e4?1:0).replace(/\.0$/,'')+'K';return (n/1e6).toFixed(1).replace(/\.0$/,'')+'M';}
export const formatCount=n=>Number.isFinite(n)?n.toLocaleString('en-US'):'—';

// ---------- denylist ----------
export const REASON_LABELS={
 bundler:'Bundled buys: one buyer behind many wallets',
 'fake-leaderboard':'Faked a leaderboard',
 'drained-funds':'Drained funds from holders',
 vamp:'Vamp attack: copied a launch to pull its liquidity',
 other:'Other, see the receipt'
};
export const STATUS_LABELS={active:'Blocked',appealed:'Under appeal',removed:'Removed'};
export const reasonLabel=reason=>REASON_LABELS[reason]||REASON_LABELS.other;
export const statusLabel=status=>STATUS_LABELS[status]||STATUS_LABELS.active;
/** Shape the denylist envelope defensively: unknown fields default, bad wallet rows are dropped. */
export function normaliseDenylist(data){
 const src=data&&typeof data==='object'?data:{};
 const wallets=(Array.isArray(src.wallets)?src.wallets:[]).filter(w=>w&&typeof w.wallet==='string'&&w.wallet.length>=32).map(w=>({
  wallet:w.wallet,clusterId:typeof w.clusterId==='string'?w.clusterId:'',reason:typeof w.reason==='string'?w.reason:'other',
  evidenceUrl:typeof w.evidenceUrl==='string'&&/^https?:\/\//.test(w.evidenceUrl)?w.evidenceUrl:null,addedAt:w.addedAt,addedBy:typeof w.addedBy==='string'?w.addedBy:'',
  status:['active','appealed','removed'].includes(w.status)?w.status:'active',
  history:(Array.isArray(w.history)?w.history:[]).filter(h=>h&&typeof h==='object').map(h=>({status:['active','appealed','removed'].includes(h.status)?h.status:'active',addedAt:h.addedAt,reason:typeof h.reason==='string'?h.reason:'other',evidenceUrl:typeof h.evidenceUrl==='string'&&/^https?:\/\//.test(h.evidenceUrl)?h.evidenceUrl:null}))
 }));
 const c=src.counts&&typeof src.counts==='object'?src.counts:{};
 const active=Number.isFinite(c.active)?c.active:wallets.filter(w=>w.status==='active').length;
 const e=src.enforcement&&typeof src.enforcement==='object'?src.enforcement:{};
 return {wallets,counts:{active,total:Number.isFinite(c.total)?c.total:wallets.length,addedToday:Number.isFinite(c.addedToday)?c.addedToday:0},enforcement:{site:e.site===true,program:e.program===true,note:typeof e.note==='string'?e.note:''},updatedAt:typeof src.updatedAt==='string'?src.updatedAt:null};
}
/** "3 wallets blocked · 1 added today" from the served counts, never from the rows. */
export function denylistHeadline(counts){const n=counts?.active??0,m=counts?.addedToday??0;return `${n} ${n===1?'wallet':'wallets'} blocked · ${m} added today`;}
/** The two enforcement badges, each driven by its own flag. */
export function enforcementBadges(enforcement){
 return [
  {key:'site',on:enforcement?.site===true,label:enforcement?.site===true?'enforced on kids.fun today':'not enforced on kids.fun yet'},
  {key:'program',on:enforcement?.program===true,label:enforcement?.program===true?'enforced in the program':'program enforcement: later build'}
 ];
}
/** Match the wallet or the cluster id, case-insensitive. */
export function filterDenylist(wallets,query){const q=String(query||'').trim().toLowerCase();if(!q)return wallets;return wallets.filter(w=>w.wallet.toLowerCase().includes(q)||w.clusterId.toLowerCase().includes(q));}
