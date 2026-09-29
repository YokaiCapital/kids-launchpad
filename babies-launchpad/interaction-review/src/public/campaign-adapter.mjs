// Versioned data adapter for public launches (UI spec §6, §7, §13; plan §5, §8).
// Pure functions only: a campaign record from GET /api/campaigns/:id goes in, view models come out.
// Every amount is a decimal string of base units (lamports, token base units); maths is BigInt, never floats.
import {formatCountdown,formatUtc} from '../launch-status.mjs';
import {safeMediaUrl} from './media-hosts.mjs';
export {formatCountdown,formatUtc,safeMediaUrl};

export const ADAPTER_VERSION=1;
const LAMPORTS=1000000000n;
const big=v=>{if(typeof v==='bigint')return v;if(v==null||v==='')return 0n;const s=String(v).trim();if(!/^-?\d+$/.test(s))throw new TypeError('amount must be an integer decimal string, got '+JSON.stringify(v));return BigInt(s);};
const str=v=>v==null?null:String(v);
const num=v=>{if(v==null||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;};
const pow10=d=>10n**BigInt(d);
const minBig=(a,b)=>a<b?a:b;
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* ---------- formatters: one canonical set (spec §13) ---------- */
/** Whole-unit decimal string from base units, trailing zeros trimmed: 143200000000 lamports -> '143.2'. Exact, no rounding. */
export function exactDecimal(baseUnits,decimals=9){
 const n=big(baseUnits),neg=n<0n,abs=neg?-n:n,scale=pow10(decimals);
 const whole=abs/scale,frac=abs%scale;
 const fracText=decimals===0?'':String(frac).padStart(decimals,'0').replace(/0+$/,'');
 return (neg?'-':'')+groupThousands(String(whole))+(fracText?'.'+fracText:'');
}
function groupThousands(digits){return digits.replace(/\B(?=(\d{3})+(?!\d))/g,',');}
/** Compact figure for a decimal string of whole units: 12345678.9 -> '12.3M'; 1234.5 -> '1,234.5'; 0.00004 -> '<0.0001'. */
const COMPACT=new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1});
export function compactDecimal(decimalText,{maxFraction=2}={}){
 const text=String(decimalText).replace(/,/g,'');
 const neg=text.startsWith('-'),[wholeRaw='0',fracRaw='']=text.replace('-','').split('.');
 const whole=wholeRaw.replace(/^0+(?=\d)/,'')||'0';
 if(whole==='0'&&/^0*$/.test(fracRaw))return '0';
 const sign=neg?'-':'';
 // 10,000 and up: K/M/B/T with one decimal (three significant digits is enough for a glance; `exact` keeps the rest).
 if(whole.length>=5)return sign+COMPACT.format(Number(whole+'.'+(fracRaw||'0')));
 // Under 1: four decimals, and a bounded "<0.0001" rather than a misleading 0.
 if(whole==='0'){
  const scaled=roundedScaled(whole,fracRaw,4);
  if(scaled===0n)return sign+'<0.0001';
  return sign+'0.'+String(scaled).padStart(4,'0').replace(/0+$/,'');
 }
 const scaled=roundedScaled(whole,fracRaw,maxFraction),unit=10n**BigInt(maxFraction);
 const w=String(scaled/unit),f=maxFraction?String(scaled%unit).padStart(maxFraction,'0').replace(/0+$/,''):'';
 return sign+groupThousands(w)+(f?'.'+f:'');
}
/** whole.frac rounded half-up to `places` decimals, as an integer scaled by 10^places. */
function roundedScaled(whole,frac,places){
 const digits=(frac+'0'.repeat(places+1)).slice(0,places+1);
 return (BigInt(whole+digits)+5n)/10n;
}
/** SOL amount view: {compact:'143.2', exact:'143.2', unit:'SOL'}; compact keeps 4 decimals under 1 SOL, 2 above. */
export function solAmount(lamports){
 const exact=exactDecimal(lamports,9);const n=big(lamports);
 const compact=compactDecimal(exact,{maxFraction:(n<0n?-n:n)<LAMPORTS?4:2});
 return {compact,exact,unit:'SOL',lamports:String(n)};
}
/** Token amount view from base units and the mint's decimals. */
export function tokenAmount(baseUnits,decimals,symbol=''){
 const exact=exactDecimal(baseUnits,decimals);
 return {compact:compactDecimal(exact),exact,unit:symbol,baseUnits:String(big(baseUnits))};
}
/** Basis points to a percent string: 4750 -> '47.5%', 500 -> '5%'. */
export function percentOfBps(bps){if(bps==null||bps==='')return '—';const n=Number(bps);if(!Number.isFinite(n))return '—';const t=(n/100).toFixed(2).replace(/\.?0+$/,'');return t+'%';}
/** Percent from a ratio of two base amounts, one decimal, never NaN: (143200000000, 100000000000) -> 143.2 */
export function percentOf(part,whole){const p=big(part),w=big(whole);if(w<=0n)return 0;return Number(p*1000n/w)/10;}
/** Local-time secondary label for a UTC time: '24 Sep 2026, 18:00 (local)'. The UTC label stays primary. */
export function formatLocal(unix){
 const d=new Date(unix*1000);if(Number.isNaN(d.getTime()))return '';
 return d.getDate()+' '+MONTHS[d.getMonth()]+' '+d.getFullYear()+', '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+' local';
}
/** Short address for labels: 'FiXtu…1111'. Full value belongs in ExactAmount or Details, never lost. */
export function shortAddress(v,head=5,tail=4){const s=str(v);if(!s)return '';return s.length<=head+tail+1?s:s.slice(0,head)+'…'+s.slice(-tail);}

/* ---------- normalisation (plan §8: identity is genesis hash + program + campaign) ---------- */
const PHASES=new Set(['draft','scheduled','open','closed','settling','launching','live','refund']);
/** One campaign record (API shape, plan §8) -> a stable view model. Unknown phases become 'unavailable', never a guess. */
export function normalizeCampaign(record){
 if(!record||typeof record!=='object')throw new TypeError('campaign record required');
 const identity={genesisHash:str(record.identity?.genesisHash),programId:str(record.identity?.programId),campaign:str(record.identity?.campaign)};
 if(!identity.campaign)throw new TypeError('campaign identity.campaign required');
 const id=[identity.genesisHash,identity.programId,identity.campaign].map(v=>v||'').join(':');
 const terms=record.terms||{},supply=terms.supply||{},vesting=terms.vesting||{},fee=terms.fee||{},totals=record.totals||{};
 const mode=record.mode==='family'?'family':'standard';
 const parents=mode==='family'?(record.parents||[]).map(p=>({mint:str(p.mint),name:str(p.name)||shortAddress(p.mint),symbol:str(p.symbol)||'',logo:safeMediaUrl(p.logo),verified:p.verified===true,reserveBps:num(p.reserveBps),thresholdBps:num(p.thresholdBps),snapshotSlot:str(p.snapshotSlot),claimExpiryUnix:num(p.claimExpiryUnix)})):[];
 const phase=PHASES.has(record.phase)?record.phase:'unavailable';
 return {
  adapterVersion:ADAPTER_VERSION,id,identity,slug:str(record.slug),legacyVersion:str(record.legacyVersion),
  mode,name:str(record.name)||'',symbol:str(record.symbol)||'',description:str(record.description)||'',
  media:{pfp:safeMediaUrl(record.media?.pfp),banner:safeMediaUrl(record.media?.banner),video:safeMediaUrl(record.media?.video,{kind:'video'}),videoCaption:str(record.media?.videoCaption),poster:safeMediaUrl(record.media?.poster)},
  links:{x:safeHttps(record.links?.x),website:safeHttps(record.links?.website)},
  creator:str(record.creator),devBeneficiary:str(record.devBeneficiary)||str(record.creator),treasury:str(record.treasury),
  parents,
  phase,
  terms:{
   version:str(terms.version),hash:str(terms.hash),presetId:str(terms.presetId),
   softLamports:String(big(terms.softLamports)),hardLamports:String(big(terms.hardLamports)),
   opensAtUnix:num(terms.opensAtUnix),deadlineUnix:num(terms.deadlineUnix),launchDeadlineUnix:num(terms.launchDeadlineUnix),
   supply:{totalBaseUnits:String(big(supply.totalBaseUnits)),decimals:num(supply.decimals)??0,participantsBps:num(supply.participantsBps)??0,liquidityBps:num(supply.liquidityBps)??0,parentsBps:num(supply.parentsBps)??0,devBps:num(supply.devBps)??0},
   vesting:{immediateBps:num(vesting.immediateBps)??0,vestedBps:num(vesting.vestedBps)??0,months:num(vesting.months)??0},
   fee:{totalBps:num(fee.totalBps),creatorFeeEnabled:fee.creatorFeeEnabled==null?null:fee.creatorFeeEnabled===true,tokenSide:str(fee.tokenSide)||'burn',solRouting:fee.solRouting||null,poolConfig:str(fee.poolConfig)},
   lock:{program:str(terms.lock?.program),model:str(terms.lock?.model)},
   upgradeAuthority:str(terms.upgradeAuthority),
  },
  totals:{committedLamports:totals.committedLamports==null?null:String(big(totals.committedLamports)),acceptedLamports:totals.acceptedLamports==null?null:String(big(totals.acceptedLamports)),refundableLamports:totals.refundableLamports==null?null:String(big(totals.refundableLamports)),receiptCount:totals.receiptCount==null?null:String(big(totals.receiptCount)),settledReceiptCount:totals.settledReceiptCount==null?null:String(big(totals.settledReceiptCount))},
  chain:{mint:str(record.chain?.mint),pool:str(record.chain?.pool),escrow:str(record.chain?.escrow),lock:str(record.chain?.lock),explorerUrl:safeHttps(record.chain?.explorerUrl)},
  market:record.market?normalizeMarket(record.market):null,
  createdAtUnix:num(record.createdAtUnix),
  source:{slot:str(record.source?.slot),commitment:str(record.source?.commitment),fetchedAtUnix:num(record.source?.fetchedAtUnix)},
 };
}
function normalizeMarket(m){
 return {priceLamportsPerToken:m.priceLamportsPerToken==null?null:String(big(m.priceLamportsPerToken)),fdvLamports:m.fdvLamports==null?null:String(big(m.fdvLamports)),liquidityLamports:m.liquidityLamports==null?null:String(big(m.liquidityLamports)),volume24hLamports:m.volume24hLamports==null?null:String(big(m.volume24hLamports)),tradeCount:m.tradeCount==null?null:String(big(m.tradeCount)),lastTradeUnix:num(m.lastTradeUnix),asOfUnix:num(m.asOfUnix)};
}
function safeHttps(url){const s=str(url);if(!s)return null;try{const u=new URL(s);return u.protocol==='https:'?u.href:null;}catch{return null;}}
/** The served preset manifest with its parent logos passed through the media rule (the launch wizard renders them). */
export function normalizeManifest(manifest){
 if(!manifest||typeof manifest!=='object')return null;
 const parents=Array.isArray(manifest.parents)?manifest.parents.map(p=>p&&typeof p==='object'?{...p,logo:safeMediaUrl(p.logo)}:p):manifest.parents;
 return {...manifest,parents};
}

/* ---------- funding meter (spec §6): base is committed/hard, fill clamps at 100 %, soft tick at soft/hard ---------- */
export function meter({committedLamports,softLamports,hardLamports}){
 const committed=big(committedLamports),soft=big(softLamports),hard=big(hardLamports);
 const committedPct=percentOf(committed,hard),softPct=hard>0n?Math.min(100,percentOf(soft,hard)):0;
 const excess=committed>hard?committed-hard:0n;
 return {fillPct:Math.min(100,committedPct),committedPct,softPct,excessLamports:String(excess),reachedSoft:soft>0n&&committed>=soft,reachedHard:hard>0n&&committed>=hard,overHard:committed>hard};
}

/* ---------- funding state headline table (spec §6) ---------- */
/**
 * Verified lifecycle first, cap totals second. `nowUnix` is chain-aligned time.
 * Returns {state, headline, sub, action, countdown, tone}. `action` names the primary control, `sub` is the visible explanation.
 */
export function fundingState(vm,nowUnix){
 if(!vm||vm.phase==='unavailable')return {state:'unavailable',tone:'muted',headline:'Status temporarily unavailable',sub:vm?.source?.fetchedAtUnix?'Showing the last data we have.':'Nothing loaded yet.',action:'retry',countdown:null};
 const t=vm.terms,m=meter({committedLamports:vm.totals.committedLamports,softLamports:t.softLamports,hardLamports:t.hardLamports});
 const soft=solAmount(t.softLamports).compact,hard=solAmount(t.hardLamports).compact;
 if(vm.phase==='scheduled'){
  const opensIn=t.opensAtUnix!=null?t.opensAtUnix-nowUnix:null;
  return {state:'scheduled',tone:'pending',headline:opensIn==null?'Opening date to be announced':opensIn>0?'Opens in '+formatCountdown(opensIn):'Opening now. Checking the chain.',sub:t.opensAtUnix!=null?'Commitments open at '+formatUtc(t.opensAtUnix)+'. Minimum '+soft+' SOL, maximum accepted '+hard+' SOL.':'Terms are sealed; the opening time is not set.',action:'disabled-commit',countdown:opensIn!=null&&opensIn>0?{label:'Opens in',seconds:opensIn,at:t.opensAtUnix}:null};
 }
 if(vm.phase==='open'&&vm.totals.committedLamports==null)return {state:'unavailable',tone:'muted',headline:'Funding totals unavailable',sub:'Please refresh before committing.',action:'retry',countdown:null};
 if(vm.phase==='open'){
  const closeIn=t.deadlineUnix!=null?t.deadlineUnix-nowUnix:null;
  if(closeIn!=null&&closeIn<=0)return {state:'closed-unresolved',tone:'pending',headline:'Funding closed. Checking final totals.',sub:'The chain clock has passed the deadline. Commitments are disabled while the final totals are read.',action:'check-status',countdown:null};
  const countdown=closeIn!=null?{label:'Closes in',seconds:closeIn,at:t.deadlineUnix}:null;
  if(m.reachedHard)return {state:'open-hard',tone:'live',headline:'Hard cap reached. You can still commit.',sub:'The most SOL accepted is '+hard+' SOL. Because the total is higher, every wallet gets a proportional allocation and its excess SOL back after settlement.',action:'commit',countdown};
  if(m.reachedSoft)return {state:'open-soft',tone:'live',headline:'Soft cap reached. Still open.',sub:'Commitments up to the '+hard+' SOL maximum join the pool at launch. Anything above it is refundable.',action:'commit',countdown};
  return {state:'open-below-soft',tone:'live',headline:'Open for commitments',sub:'This launch needs '+soft+' SOL to happen. Below that, every commitment is refundable in full.',action:'commit',countdown};
 }
 if(vm.phase==='closed')return {state:'closed-unresolved',tone:'pending',headline:'Funding closed. Checking final totals.',sub:'Commitments are closed by the chain clock. The final totals are being read.',action:'check-status',countdown:null};
 if(vm.phase==='settling'){
  const total=vm.totals.receiptCount,settled=vm.totals.settledReceiptCount;
  return {state:'settling',tone:'pending',headline:'Finalizing allocations',sub:total!=null&&settled!=null?Number(settled).toLocaleString('en-GB')+' of '+Number(total).toLocaleString('en-GB')+' commitments settled.':'Each commitment is being settled on chain.',action:'none',countdown:null};
 }
 if(vm.phase==='launching')return {state:'launching',tone:'pending',headline:'Preparing the launch',sub:'The pool is being created and locked. This shows the real stage, not a timer.',action:'none',countdown:null};
 if(vm.phase==='live')return {state:'live',tone:'ok',headline:(vm.name||'This coin')+' is live',sub:'Trading and claims are open.',action:'trade',countdown:null};
 if(vm.phase==='refund')return {state:'refund',tone:'problem',headline:'Refund available',sub:m.reachedSoft?'The launch did not complete inside its window. Every commitment is refundable in full.':'Only '+solAmount(vm.totals.committedLamports).compact+' of the '+soft+' SOL minimum was committed. Every commitment is refundable in full.',action:'refund',countdown:null};
 return {state:'unavailable',tone:'muted',headline:'Status temporarily unavailable',sub:'Unknown lifecycle: '+vm.phase,action:'retry',countdown:null};
}

/* ---------- opening liquidity estimate (plan §3): FDV = A / L, nominal pool = 2A ---------- */
export function openingEstimate({acceptedLamports,terms}){
 const accepted=big(acceptedLamports),supply=terms.supply,liquidityBps=BigInt(supply.liquidityBps||0),soft=big(terms.softLamports);
 const liquidityTokens=liquidityBps>0n?big(supply.totalBaseUnits)*liquidityBps/10000n:0n;
 const requiresSoft=accepted<soft;
 if(liquidityBps<=0n||accepted<=0n)return {acceptedLamports:String(accepted),liquidityTokens:String(liquidityTokens),fdvLamports:null,nominalPoolLamports:String(accepted*2n),spotSolPerToken:null,requiresSoft,provisional:true};
 const fdv=accepted*10000n/liquidityBps;
 // spot price in SOL per whole token, 12 decimal places, from integer maths: A × 10^decimals / liquidityTokens lamports per token
 const spotLamportsE12=liquidityTokens>0n?accepted*pow10(supply.decimals||0)*pow10(12)/liquidityTokens:0n;
 return {acceptedLamports:String(accepted),liquidityTokens:String(liquidityTokens),fdvLamports:String(fdv),nominalPoolLamports:String(accepted*2n),spotSolPerToken:exactDecimal(spotLamportsE12,21),requiresSoft,provisional:true};
}

/* ---------- settlement maths (plan §5), integer only ---------- */
/** accepted_i = floor(commit_i × min(T, H) / T); excess_i = commit_i − accepted_i. T = 0 handled without division. */
export function settleReceipt({commitLamports,totalCommittedLamports,hardLamports}){
 const commit=big(commitLamports),total=big(totalCommittedLamports),hard=big(hardLamports);
 if(total<=0n||commit<=0n)return {acceptedLamports:'0',excessLamports:String(commit<0n?0n:commit)};
 const accepted=commit*minBig(total,hard)/total;
 return {acceptedLamports:String(accepted),excessLamports:String(commit-accepted)};
}
/** participant_tokens_i = floor(reserve × accepted_i / A); A = 0 handled without division. */
export function participantTokens({acceptedLamports,totalAcceptedLamports,participantReserveBaseUnits}){
 const a=big(acceptedLamports),A=big(totalAcceptedLamports),reserve=big(participantReserveBaseUnits);
 if(A<=0n||a<=0n)return '0';
 return String(reserve*a/A);
}
export function participantReserve(supply){return String(big(supply.totalBaseUnits)*BigInt(supply.participantsBps||0)/10000n);}
/**
 * Projected position for a wallet that adds `addLamports` to an existing commitment while funding is open (spec §7).
 * The added amount counts in both the wallet total and the campaign total. A is estimated as min(T′, H); the real A
 * is a sum of floors and can be dust below that, so the result is provisional until settlement.
 */
export function estimatePosition({existingLamports='0',addLamports='0',totalCommittedLamports,terms}){
 const existing=big(existingLamports),add=big(addLamports),total=big(totalCommittedLamports)+add,hard=big(terms.hardLamports);
 const commit=existing+add;
 const {acceptedLamports,excessLamports}=settleReceipt({commitLamports:commit,totalCommittedLamports:total,hardLamports:hard});
 const estimatedA=minBig(total,hard);
 const tokens=participantTokens({acceptedLamports,totalAcceptedLamports:estimatedA,participantReserveBaseUnits:participantReserve(terms.supply)});
 return {commitLamports:String(commit),addLamports:String(add),existingLamports:String(existing),acceptedLamports,excessLamports,tokensBaseUnits:tokens,campaignTotalLamports:String(total),estimatedAcceptedTotalLamports:String(estimatedA),provisional:true};
}
/** Final position after settlement from the chain's own figures (never re-derived when the chain has spoken). */
export function settledPosition({commitLamports,acceptedLamports,claimedTokensBaseUnits='0',refundedLamports='0',totalAcceptedLamports,terms}){
 const commit=big(commitLamports),accepted=big(acceptedLamports);
 const tokens=participantTokens({acceptedLamports:accepted,totalAcceptedLamports,participantReserveBaseUnits:participantReserve(terms.supply)});
 return {commitLamports:String(commit),acceptedLamports:String(accepted),excessLamports:String(commit-accepted),refundedLamports:String(big(refundedLamports)),refundRemainingLamports:String(commit-accepted-big(refundedLamports)),tokensBaseUnits:tokens,claimedTokensBaseUnits:String(big(claimedTokensBaseUnits)),tokensRemainingBaseUnits:String(big(tokens)-big(claimedTokensBaseUnits)),provisional:false};
}

/* ---------- supply strip and terms rows (spec §4 step 3, §9) ---------- */
export function supplySplit(terms){
 const s=terms.supply,v=terms.vesting;
 const segments=[{key:'participants',label:'Participants',bps:s.participantsBps},{key:'liquidity',label:'Locked liquidity',bps:s.liquidityBps},{key:'parents',label:'Parents',bps:s.parentsBps},{key:'dev',label:'Dev',bps:s.devBps}].filter(seg=>seg.bps>0).map(seg=>({...seg,percent:percentOfBps(seg.bps)}));
 const totalBps=segments.reduce((n,seg)=>n+seg.bps,0);
 return {segments,totalBps,sumsToWhole:totalBps===10000,devLine:'Dev: '+percentOfBps(v.immediateBps)+' at launch · '+percentOfBps(v.vestedBps)+' linear over '+v.months+' calendar month'+(v.months===1?'':'s')};
}
export function termsRows(vm){
 const t=vm.terms,fee=t.fee,routing=fee.solRouting?.[vm.mode]||fee.solRouting||null;
 const routeText=routing&&routing.of?Object.entries(routing).filter(([k])=>k!=='of').map(([k,v])=>k+' '+v+'/'+routing.of).join(' · '):null;
 return [
  {key:'fee',label:'Trading fee',value:fee.totalBps!=null?'Trading fee: '+percentOfBps(fee.totalBps)+' total · network fees extra':'Not published',detail:fee.creatorFeeEnabled==null?'Current creator-fee status could not be verified.':fee.creatorFeeEnabled?'An additional creator fee is enabled on this pool.':'No additional creator fee on this pool.'+(fee.poolConfig?' Pool config '+fee.poolConfig:'')},
  {key:'collected',label:'Collected fees',value:(fee.tokenSide==='burn'?'Coin-side fees are burned':'Coin-side fees: '+fee.tokenSide)+'; SOL-side fees route by policy',detail:routeText?'SOL routing: '+routeText:'SOL routing policy not published'},
  {key:'dev',label:'Dev destination',value:vm.devBeneficiary?shortAddress(vm.devBeneficiary):'Creator wallet',detail:vm.devBeneficiary||null},
  {key:'treasury',label:'Treasury destination',value:vm.treasury?shortAddress(vm.treasury):'Not published',detail:vm.treasury||null},
  {key:'lock',label:'Locked liquidity',value:t.lock.model||'Liquidity principal locked at launch',detail:t.lock.program?'Lock program '+t.lock.program:null},
  {key:'upgrade',label:'Upgradeability',value:t.upgradeAuthority?'Program upgrade authority: '+shortAddress(t.upgradeAuthority):'Program upgrade authority not published',detail:t.upgradeAuthority||null},
  {key:'claims',label:'Claims and refunds',value:'Participant claims and refunds never expire',detail:vm.mode==='family'?'Parent reward claims follow each parent\'s sealed policy.':null},
  {key:'version',label:'Policy version',value:t.version||'—',detail:t.hash?'Terms hash '+t.hash:null},
 ];
}

/* ---------- explore rows, filters, sort (spec §3) ---------- */
export const STATUS_BUCKETS=['open','upcoming','live','ended'];
export function statusBucket(phase){return {scheduled:'upcoming',open:'open',closed:'launching',settling:'launching',launching:'launching',live:'live',refund:'ended'}[phase]||'unknown';}
export function exploreRow(vm,nowUnix){
 const state=fundingState(vm,nowUnix),bucket=statusBucket(vm.phase),t=vm.terms;
 const statusLabel={open:'Open',upcoming:'Upcoming',live:'Live',ended:vm.phase==='refund'?'Refunds':'Ended',launching:'Launching',unknown:'Unavailable'}[bucket];
 let funding;
 if(bucket==='upcoming')funding={kind:'countdown',opensAtUnix:t.opensAtUnix,seconds:t.opensAtUnix!=null?Math.max(0,t.opensAtUnix-nowUnix):null};
 else if(bucket==='live')funding={kind:'market',market:vm.market};
 else if(bucket==='ended')funding={kind:'ended',committedLamports:vm.totals.committedLamports,softLamports:t.softLamports,reachedSoft:big(vm.totals.committedLamports)>=big(t.softLamports)};
 else funding={kind:'meter',committedLamports:vm.totals.committedLamports,softLamports:t.softLamports,hardLamports:t.hardLamports,meter:meter({committedLamports:vm.totals.committedLamports,softLamports:t.softLamports,hardLamports:t.hardLamports}),stillOpen:state.state.startsWith('open-'),deadlineUnix:t.deadlineUnix};
 const action={open:'Commit',upcoming:'View',live:'Trade',ended:vm.phase==='refund'?'Refund':'View',launching:'View',unknown:'View'}[bucket];
 return {id:vm.id,campaign:vm.identity.campaign,name:vm.name,symbol:vm.symbol,mode:vm.mode,pfp:vm.media.pfp,parents:vm.parents,bucket,statusLabel,state:state.state,funding,action,createdAtUnix:vm.createdAtUnix,deadlineUnix:t.deadlineUnix,opensAtUnix:t.opensAtUnix};
}
export function filterRows(rows,{status='all',mode='all',query=''}={}){
 const q=query.trim().toLowerCase();
 return rows.filter(r=>(status==='all'||r.bucket===status)&&(mode==='all'||r.mode===mode)&&(!q||r.name.toLowerCase().includes(q)||r.symbol.toLowerCase().includes(q)||r.campaign.toLowerCase().startsWith(q)));
}
/** Sort keys: 'closing' (soonest deadline first; rows without a deadline last), 'newest', 'name'. Ties break on id, always. */
export function sortRows(rows,key='closing'){
 const byId=(a,b)=>a.id<b.id?-1:a.id>b.id?1:0;
 const cmp={
  closing:(a,b)=>{const da=a.deadlineUnix??Infinity,db=b.deadlineUnix??Infinity;return da-db||byId(a,b);},
  newest:(a,b)=>{const ca=a.createdAtUnix??-Infinity,cb=b.createdAtUnix??-Infinity;return cb-ca||byId(a,b);},
  name:(a,b)=>a.name.localeCompare(b.name,'en')||byId(a,b),
 }[key]||((a,b)=>byId(a,b));
 return [...rows].sort(cmp);
}
export function defaultSortFor(status){return status==='live'?'newest':status==='ended'?'newest':'closing';}

/* ---------- claims groups (spec §8) ---------- */
export const ELIGIBILITY_COPY={'not-participant':'Not a participant','no-launch':'No launch, so no allocation','below-threshold':'Below the 0.05% snapshot threshold',claimed:'Already claimed',pending:'Snapshot verification pending','after-launch':'Claims open after launch',ended:'Claim period ended',unknown:'Could not verify eligibility'};
/**
 * position: {commitLamports, acceptedLamports, refundedLamports, tokensBaseUnits, claimedTokensBaseUnits, parents:[{mint, eligibility, amountBaseUnits, claimed, expiryUnix}], dev:{...}|null, eligibility}
 */
export function claimGroups(vm,position){
 if(!position)return [];
 const t=vm.terms,sym=vm.symbol,d=t.supply.decimals,groups=[];
 const live=vm.phase==='live';
 if(position.eligibility==='unknown')groups.push({key:'allocation',title:'Your launch allocation',reason:ELIGIBILITY_COPY.unknown,rows:[],action:null});
 else if(big(position.commitLamports||0)>0n){
  const tokens=big(position.tokensBaseUnits||0),claimed=big(position.claimedTokensBaseUnits||0),remaining=tokens-claimed;
  groups.push({key:'allocation',title:'Your launch allocation',reason:vm.phase==='refund'?ELIGIBILITY_COPY['no-launch']:live?remaining<=0n&&tokens>0n?ELIGIBILITY_COPY.claimed:null:ELIGIBILITY_COPY['after-launch'],rows:[{label:'Allocation',amount:tokenAmount(tokens,d,sym)},{label:'Claimed',amount:tokenAmount(claimed,d,sym)},{label:'Remaining',amount:tokenAmount(remaining,d,sym)}],action:live&&remaining>0n?'Claim':null});
  const refund=big(position.commitLamports)-big(position.acceptedLamports||0)-big(position.refundedLamports||0);
  if(vm.phase==='refund'||big(position.commitLamports)>big(position.acceptedLamports||0))groups.push({key:'refund',title:'Your refund',reason:refund<=0n&&big(position.refundedLamports||0)>0n?ELIGIBILITY_COPY.claimed:null,rows:[{label:vm.phase==='refund'?'Full refund':'Excess SOL',amount:solAmount(refund>0n?refund:0n)},{label:'Refunded',amount:solAmount(position.refundedLamports||0)}],action:refund>0n&&(vm.phase==='refund'||live)?'Claim refund':null});
 } else groups.push({key:'allocation',title:'Your launch allocation',reason:ELIGIBILITY_COPY['not-participant'],rows:[],action:null});
 if(vm.mode==='family'){
  for(const parent of vm.parents){
   const p=(position.parents||[]).find(x=>x.mint===parent.mint)||{eligibility:'unknown'};
   const reason=p.eligibility==='eligible'?(p.claimed?ELIGIBILITY_COPY.claimed:live?null:ELIGIBILITY_COPY['after-launch']):ELIGIBILITY_COPY[p.eligibility]||ELIGIBILITY_COPY.unknown;
   groups.push({key:'parent:'+parent.mint,title:'Parent rewards · '+parent.name,parent,reason,rows:p.eligibility==='eligible'?[{label:'Allocation',amount:tokenAmount(p.amountBaseUnits||0,d,sym)}]:[],action:p.eligibility==='eligible'&&!p.claimed&&live?'Claim':null,expiryUnix:p.expiryUnix??parent.claimExpiryUnix??null});
  }
 }
 if(position.dev)groups.push({key:'dev',title:'Dev allocation',reason:null,rows:[{label:'Reserved',amount:tokenAmount(position.dev.reservedBaseUnits||0,d,sym)},{label:'Available now',amount:tokenAmount(position.dev.availableBaseUnits||0,d,sym)},{label:'Claimed',amount:tokenAmount(position.dev.claimedBaseUnits||0,d,sym)}],action:big(position.dev.availableBaseUnits||0)>0n?'Claim':null});
 if(vm.terms.version==='3'&&position.setup){
  const setup=position.setup,verified=setup.eligibility==='verified',available=verified?big(setup.availableLamports||0):0n;
  groups.push({key:'setup',title:'Unused setup SOL',reason:!verified?'Could not verify the setup balance':!setup.terminal?'Available after launch or finalized failure':available>0n?'Returns to your creator wallet. Spent rent and fees are not refundable.':'No unused setup SOL',rows:verified?[{label:'Available',amount:solAmount(available)}]:[],action:verified&&setup.terminal&&available>0n?'Return SOL':null});
 }
 return groups;
}

/* ---------- shared transaction copy (spec §12) ---------- */
export const TRANSACTION_STATES=['idle','prepared','wallet','submitting','submitted','unknown','delayed','confirmed','rejected','failed','blocked'];
export function transactionCopy(state,{action='Transaction',reason=null}={}){
 const table={
  blocked:{title:reason||'Transaction was not submitted',note:'Nothing was sent. Your entry is kept.',primary:null,secondary:null,tone:'problem',busy:false},
  idle:{title:'',note:'',primary:null,secondary:null,tone:'muted',busy:false},
  prepared:{title:'Unsubmitted approval',note:'No signed transaction has been received. Discard an unused quote before preparing another.',primary:'Check status',secondary:null,tone:'muted',busy:false},
  wallet:{title:'Confirm in your wallet',note:'Nothing has been submitted yet.',primary:null,secondary:'Cancel',tone:'pending',busy:true},
  submitting:{title:'Submitting transaction',note:'Do not submit again.',primary:null,secondary:null,tone:'pending',busy:true},
  submitted:{title:'Transaction submitted',note:'A signature alone does not prove the network accepted it. Waiting for confirmation.',primary:null,secondary:'View on explorer',tone:'pending',busy:true},
  unknown:{title:'Submission status unknown. Checking this transaction.',note:'The same signature is being checked before any retry.',primary:null,secondary:null,tone:'pending',busy:true},
  delayed:{title:'Still checking confirmation',note:'Do not submit again. The signature is still being checked.',primary:'Check status',secondary:null,tone:'pending',busy:true},
  confirmed:{title:(action==='setup'?'Setup SOL return':action==='fee-account'?'Payout account restoration':action)+' confirmed',note:'',primary:null,secondary:'Details',tone:'ok',busy:false},
  rejected:{title:'Cancelled in wallet',note:'Nothing was sent. Your entry is kept.',primary:'Try again',secondary:null,tone:'muted',busy:false},
  failed:{title:reason||'Transaction failed on chain',note:'Network fees may still apply.',primary:'Try again',secondary:'Details',tone:'problem',busy:false},
 };
 return table[state]||table.idle;
}

/* ---------- data freshness (spec §12) ---------- */
export function freshness({fetchedAtUnix,nowUnix,staleAfterSeconds=60}){
 if(fetchedAtUnix==null)return {ageSeconds:null,stale:false,unknown:true,label:'Not updated yet'};
 const age=Math.max(0,Math.floor(nowUnix-fetchedAtUnix));
 const ago=age<60?age+'s ago':age<3600?Math.floor(age/60)+' min ago':age<86400?Math.floor(age/3600)+' h ago':Math.floor(age/86400)+' d ago';
 const stale=age>staleAfterSeconds;
 return {ageSeconds:age,stale,unknown:false,label:stale?'Stale · updated '+ago:'Updated '+ago};
}

/** Unknown funding must stay unknown; never feed null into BigInt or invent a zero balance. */
export function acceptedForOpeningEstimate(totals,hardLamports){
 if(totals.acceptedLamports!=null)return totals.acceptedLamports;
 if(totals.committedLamports==null)return null;
 return String(BigInt(totals.committedLamports)<BigInt(hardLamports)?totals.committedLamports:hardLamports);
}
