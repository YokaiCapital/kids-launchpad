// Program activity helpers for the coin page (owner, 23 September 2026): fetch, merge and pure display logic for
// /api/market/activity. Framework-free so it runs under `node --test`.
// Rules: the feed carries executed movements only, so every amount shown here was executed on the chain; a burn is
// always written "burned", never "sent"; a failed attempt is shown as failed with nothing moved; an unknown kind is
// shown with its raw name rather than dropped; a failed read keeps the last valid page and says so.
import {fetchMarket,relativeTime} from './market-data.mjs';
export const ACTIVITY_PAGE=30;
export const ACTIVITY_STALE_SECONDS=120;
const SOL_DECIMALS=9,DUST_LAMPORTS=100000n;

// ---------- kinds ----------
/** Served kind names. The server spells the first one `campaign-init`; the brief and older records say `init`. */
export const KIND_ALIASES={init:'campaign-init'};
export const LAUNCH_KINDS=['campaign-init','commit','finalize','settle','ready','launch','configure-parents','authority-revoked'];
export const CLAIM_KINDS=['claim-participant','claim-dev','claim-parent','vault-claim-participant','vault-claim-parent','vault-claim-dev'];
export const REFUND_KINDS=['refund'];
export const FEE_KINDS=['fees-init','fees-collect','fees-sell','fees-distribute'];
export const BURN_KINDS=['buy-burn','buy-burn-routed','burn-child','vault-burn-expired','vault-sweep'];
export const VAULT_KINDS=['vault-activate','vault-claim-participant','vault-claim-parent','vault-claim-dev','vault-burn-expired','vault-sweep'];
export const ALL_KINDS=[...new Set([...LAUNCH_KINDS,...CLAIM_KINDS,...REFUND_KINDS,...FEE_KINDS,...BURN_KINDS,...VAULT_KINDS])];
/** Filter chips. `kinds` null means "ask for everything"; `failedOnly` filters client-side because the server has no status filter. */
export const FILTERS=[
 {key:'all',label:'All',kinds:null},
 {key:'launch',label:'Launch',kinds:LAUNCH_KINDS},
 {key:'claims',label:'Claims',kinds:CLAIM_KINDS},
 {key:'refunds',label:'Refunds',kinds:REFUND_KINDS},
 {key:'fees',label:'Fees',kinds:FEE_KINDS},
 {key:'burns',label:'Buybacks and burns',kinds:BURN_KINDS},
 {key:'vaults',label:'Vaults',kinds:VAULT_KINDS},
 {key:'failed',label:'Failed',kinds:null,failedOnly:true}
];
export const filterFor=key=>FILTERS.find(f=>f.key===key)||FILTERS[0];
/** The `kinds=` query value for a chip, or null for all. */
export const kindsParam=key=>{const f=filterFor(key);return f.kinds?f.kinds.join(','):null;};
/** Rows to show for a chip from what is loaded (the Failed chip is the only client-side one). */
export function applyFilter(events,key){const f=filterFor(key);if(f.failedOnly)return (events||[]).filter(e=>e.status==='failed');if(!f.kinds)return events||[];const set=new Set(f.kinds);return (events||[]).filter(e=>set.has(e.kind));}
/** Count for a chip from the served counts {total,failed,byKind}; null when the counts are not served. */
export function filterCount(counts,key){
 if(!counts||typeof counts!=='object')return null;const f=filterFor(key);
 if(f.failedOnly)return Number.isFinite(Number(counts.failed))?Number(counts.failed):null;
 if(!f.kinds)return Number.isFinite(Number(counts.total))?Number(counts.total):null;
 const byKind=counts.byKind||{};let n=0;for(const k of f.kinds)n+=Number(byKind[k]||0);return n;
}
/** "N events · M failed". Unknown totals stay unknown. */
export function countsLine(counts){
 const total=Number(counts?.total),failed=Number(counts?.failed);
 if(!Number.isFinite(total))return '';
 const head=total===1?'1 event':total.toLocaleString('en-GB')+' events';
 return Number.isFinite(failed)&&failed>0?head+' · '+failed.toLocaleString('en-GB')+' failed':head;
}

// ---------- normalise and merge ----------
const finite=v=>{if(v==null||v==='')return null;const n=typeof v==='number'?v:Number(String(v).trim());return Number.isFinite(n)?n:null;};
const U64=/^\d{1,20}$/;
export const eventKey=e=>e.signature+'|'+(e.path??'');
/** Chain order inside a slot: top-level index, then inner index. */
const ordinalOf=path=>{const [a,b]=String(path||'0').split('.').map(Number);return (a||0)*100000+(b===undefined||Number.isNaN(b)?0:b+1);};
/** A served event becomes a row, or null when it cannot be trusted (no signature, no kind, unreadable asset). */
export function normaliseEvent(e){
 if(!e||typeof e!=='object'||typeof e.signature!=='string'||!e.signature||typeof e.kind!=='string'||!e.kind)return null;
 const kind=KIND_ALIASES[e.kind]||e.kind;
 const path=e.path??e.instructionPath??'0';
 const status=e.status==='failed'?'failed':e.status==='confirmed'?'confirmed':'finalized';
 const assets=[];
 for(const a of Array.isArray(e.assets)?e.assets:[]){
  if(!a||typeof a!=='object'||typeof a.mint!=='string'||!U64.test(String(a.amountRaw??'')))return null;
  const decimals=Number.isInteger(a.decimals)?a.decimals:a.mint==='SOL'?SOL_DECIMALS:null;if(decimals==null)return null;
  const direction=a.direction==='in'||a.direction==='out'||a.direction==='burn'?a.direction:null;if(!direction)return null;
  assets.push({mint:a.mint,amountRaw:String(a.amountRaw),decimals,direction,role:typeof a.role==='string'?a.role:null,account:typeof a.account==='string'?a.account:null});
 }
 const slot=finite(e.slot),time=finite(e.time??e.blockTimeUnix);
 return {signature:e.signature,path:String(path),slot:slot==null?null:Math.floor(slot),time:time==null?null:Math.floor(time),program:typeof e.program==='string'?e.program:null,kind,actor:typeof e.actor==='string'?e.actor:null,assets,status,nested:e.nested===true,detail:typeof e.detail==='string'?e.detail:null};
}
/** Newest first in chain order (slot, then instruction), one row per signature and instruction path; an incoming row replaces the one it shares a key with (confirming → finalized). */
export function mergeEvents(existing,incoming){
 const map=new Map();for(const e of existing||[])if(e)map.set(eventKey(e),e);
 for(const raw of incoming||[]){const e=raw&&Array.isArray(raw.assets)&&typeof raw.status==='string'&&'path' in raw?raw:normaliseEvent(raw);if(e)map.set(eventKey(e),e);}
 return [...map.values()].sort((a,b)=>(b.slot??0)-(a.slot??0)||(a.signature<b.signature?1:a.signature>b.signature?-1:0)||ordinalOf(b.path)-ordinalOf(a.path));
}

// ---------- fetch ----------
/** One page of activity. Uses the market fetch path (same origin, timeout, honest failure reasons) and checks the shape. */
export async function fetchActivity({campaign,cursor=null,limit=ACTIVITY_PAGE,kinds=null},options={}){
 const result=await fetchMarket('activity',{campaign,cursor,limit,kinds},options);
 if(!result.ok)return result;
 if(!Array.isArray(result.data.events))return {ok:false,reason:'malformed',status:200};
 return result;
}

// ---------- state ----------
/**
 * One word for what the list shows. `events` = rows held (last valid page), `result` = last fetch result, `loading` = first read in flight.
 * @returns {'loading'|'off'|'unavailable'|'empty'|'ready'}
 */
export function deriveActivityState({events,result,loading,enabled=true}){
 if(!enabled)return 'off';
 if(events?.length)return 'ready';
 if(loading&&!result)return 'loading';
 if(result&&!result.ok)return result.reason==='off'?'off':'unavailable';
 return 'empty';
}
export const ACTIVITY_COPY={
 loading:'Reading program activity…',
 off:'Program activity appears here when the activity feed is connected.',
 unavailable:'The activity feed is unavailable right now. It retries every 10 seconds.',
 empty:'No program activity recorded yet. The first event appears here as soon as it lands.'
};
/** The small chip beside the heading: feed health from the served `status`, or the last read when the feed cannot be reached. */
export function activityChip({status,result,lastReadUnix,nowUnix}){
 if(result&&!result.ok){if(result.reason==='off')return {text:'Feed not connected',tone:'off'};return {text:lastReadUnix?'Feed unavailable · last read '+relativeTime(lastReadUnix,nowUnix):'Feed unavailable',tone:'off'};}
 if(!result)return {text:'Loading…',tone:'wait'};
 if(status==='stale')return {text:'Stale · feed behind the chain',tone:'stale'};
 if(status==='backfilling')return {text:'Backfilling history',tone:'wait'};
 if(status==='starting')return {text:'Feed starting',tone:'wait'};
 if(status==='disabled')return {text:'Feed switched off',tone:'off'};
 if(status==='no-activity')return {text:'No activity yet',tone:'wait'};
 return {text:'Updated '+relativeTime(lastReadUnix??nowUnix,nowUnix),tone:'live'};
}

// ---------- labels ----------
const PARENT_NAMES=['Fartcoin','Buttcoin'];
const parentIndex=detail=>{const m=/^parent-(\d+)$/.exec(detail||'');return m?Number(m[1]):null;};
const parentName=(detail,names)=>{const i=parentIndex(detail);return i==null?null:(names?.parents?.[i]||PARENT_NAMES[i]||'parent '+i);};
const STATIC_LABELS={
 'campaign-init':'Campaign created',commit:'Commitment',finalize:'Funding closed',settle:'Settled',ready:'Ready to launch',
 launch:'Launched: pool funded and LP locked','configure-parents':'Parents configured',
 'claim-participant':'Claim: participant','claim-dev':'Claim: dev','vault-claim-participant':'Claim: participant','vault-claim-dev':'Claim: dev',
 refund:'Refund','fees-init':'Fee routing set up','fees-collect':'Fee harvest','fees-sell':'Fee coins sold, retired step','fees-distribute':'Fees distributed: treasury / dev',
 'burn-child':'Coin-side fees burned','vault-activate':'Vault opened: unclaimed coins moved','vault-sweep':'Vault swept and burned'
};
/** Plain-word label per kind. `names.parents` = ['Fartcoin','Buttcoin'] by parent index; unknown kinds keep their raw name. */
export function labelFor(event,names={}){
 const {kind,detail}=event;
 if(kind==='buy-burn'||kind==='buy-burn-routed'){const p=parentName(detail,names);return 'Buyback and burn'+(p?': '+p:'');}
 if(kind==='claim-parent'||kind==='vault-claim-parent'){const p=parentName(detail,names);return 'Claim: '+(p?p+' holder':'parent holder');}
 if(kind==='vault-burn-expired'){const p=parentName(detail,names);return p?'Expired '+p+' claims burned':'Expired claims burned';}
 if(kind==='authority-revoked')return detail==='freezeAccount'?'Freeze authority revoked':detail==='mintTokens'?'Mint authority revoked':'Authority revoked';
 return STATIC_LABELS[kind]||kind.replace(/-/g,' ').replace(/^./,c=>c.toUpperCase());
}
/** Small tags beside the label: vault rail, routed buyback, nested call, and the status when it is not final. */
export function tagsFor(event){
 const tags=[];
 if(VAULT_KINDS.includes(event.kind))tags.push({key:'vault',text:'vault',title:'Handled by the claims vault program'});
 if(event.kind==='buy-burn-routed')tags.push({key:'routed',text:'routed',title:'Bought through a router, then burned'});
 if(event.kind==='fees-sell')tags.push({key:'retired',text:'retired',title:'This step no longer exists in the program; it appears only in history'});
 if(event.nested)tags.push({key:'nested',text:'nested',title:'Called inside another program’s transaction'});
 if(event.status==='failed')tags.push({key:'failed',text:'failed',title:'The transaction failed; nothing moved'});
 else if(event.status==='confirmed')tags.push({key:'confirming',text:'confirming',title:'Seen but not yet finalised on the chain'});
 return tags;
}

// ---------- amounts ----------
function toBig(value){try{const n=BigInt(value);return n<0n?null:n;}catch{return null;}}
function exact(raw,decimals){const n=toBig(raw);if(n==null)return null;const s=n.toString().padStart(decimals+1,'0');const whole=s.slice(0,s.length-decimals),frac=s.slice(s.length-decimals).replace(/0+$/,'');return whole+(frac?'.'+frac:'');}
const groupWhole=whole=>whole.replace(/\B(?=(\d{3})+(?!\d))/g,',');
const group=(text,maxFraction)=>{const [whole,frac='']=text.split('.');const f=frac.slice(0,maxFraction);return groupWhole(whole)+(f?'.'+f:'');};
/**
 * Adaptive precision for a row amount: SOL keeps four places and never rounds a real amount to zero ("<0.0001 SOL");
 * coins show two places, four significant digits below one, and a compact figure above a million. `exact` is the full value.
 */
export function formatAssetAmount(raw,decimals,symbol){
 const n=toBig(raw);if(n==null)return {text:'—',exact:null};
 const full=exact(n,decimals),exactText=group(full,decimals)+' '+symbol;
 if(n===0n)return {text:'0 '+symbol,exact:exactText};
 if(symbol==='SOL'){if(n<DUST_LAMPORTS)return {text:'<0.0001 SOL',exact:exactText};return {text:group(full,4)+' SOL',exact:exactText};}
 const value=Number(full);
 if(value>=1e6)return {text:value.toLocaleString('en-US',{notation:'compact',maximumFractionDigits:2})+' '+symbol,exact:exactText};
 if(value>=1)return {text:group(full,2)+' '+symbol,exact:exactText};
 const zeros=Math.max(0,-Math.floor(Math.log10(value))-1);
 return {text:group(full,Math.min(decimals,zeros+4))+' '+symbol,exact:exactText};
}
export const shortAddress=(v,n=4)=>typeof v==='string'&&v.length>n*2+1?v.slice(0,n)+'…'+v.slice(-n):(v||'');
/** Symbol for a mint: SOL, the child coin, a parent by served mint, else the short mint. */
export function symbolFor(mint,names={}){
 if(mint==='SOL')return 'SOL';
 if(names.coin&&mint===names.coin)return '$Shartcoin';
 const parentMints=names.parentMints||[];const i=parentMints.indexOf(mint);
 if(i>=0)return names.parents?.[i]||PARENT_NAMES[i]||'parent '+i;
 return shortAddress(mint);
}
const ROLE_WORDS={pool:'to the pool',lock:'to the LP lock',vault:'to the vault',treasury:'to KIDS treasury',dev:'to dev'};
/**
 * One line per asset movement: "1.5 SOL in", "0.2 SOL to KIDS treasury", "12,400 Fartcoin burned". A burned asset in a
 * buyback is named after the parent the program named in the instruction when the mint is not otherwise known.
 * @returns {{text:string,exact:string|null,tone:'in'|'out'|'burn',role:string|null}[]}
 */
export function describeAssets(event,names={}){
 const p=parentName(event.detail,names);
 return (event.assets||[]).map(a=>{
  let symbol=symbolFor(a.mint,names);
  if(p&&a.direction==='burn'&&a.mint!=='SOL'&&symbol===shortAddress(a.mint))symbol=p;
  const amount=formatAssetAmount(a.amountRaw,a.decimals,symbol);
  const verb=a.direction==='burn'?'burned':a.direction==='in'?'in':(ROLE_WORDS[a.role]||'out');
  return {text:amount.text+' '+verb,exact:amount.exact?amount.exact+' '+verb:null,tone:a.direction,role:a.role||null};
 });
}
