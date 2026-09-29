// Pure helpers for the launched coin page and the "My allocations" modal (owner review, 23 September 2026).
// Every amount arrives as a raw integer string; unknown stays null and is never shown as zero.
import {formatUnits,formatSolAmount} from './flywheel-format.mjs';
import {formatUtc} from './launch-status.mjs';
function big(value){if(value==null)return null;try{const n=BigInt(value);return n<0n?null:n;}catch{return null;}}
/** Remaining to claim: total minus claimed, never below zero; null when either side is unknown. */
export function remainingRaw(total,claimed){const t=big(total),c=big(claimed);if(t==null||c==null)return null;return (t>c?t-c:0n).toString();}
/** True when something was claimed and nothing is left. */
export function claimedAll(total,claimed){const t=big(total),c=big(claimed);return t!=null&&c!=null&&c>0n&&c>=t;}
/** Lifecycle badge from the served phase. null (not read yet) is "Checking status", never "Prelaunch". */
export function lifecycleLabel(phase){
 if(phase==null)return 'Checking status';
 return {launched:'Live',failed:'Not launched',settled:'Launching','awaiting-launch':'Launching',open:'Prelaunch'}[phase]||phase;
}
/** Where the coin link should open: the live page after launch, the funding page before. */
export function coinDestination(phase){return phase==='launched'?'PostLaunch':'Shart';}
/**
 * One parent reward row. `row` is claims.parents[i]; `vault` is claims.vault (null on the legacy rail, which has no expiry).
 * States: unknown (snapshot not served), ineligible (below the 0.05 % threshold), claimed, expired, open.
 */
export function parentState(row,vault=null,decimals=6){
 if(!row||row.eligible==null)return {state:'unknown',remainingRaw:null,remainingText:'—',expiresAtUnix:null,deadlineText:'',note:'Unknown: the snapshot for this parent is not served yet.',button:'Unavailable'};
 if(row.eligible===false)return {state:'ineligible',remainingRaw:'0',remainingText:'0',expiresAtUnix:null,deadlineText:'',note:'Not eligible: this wallet was below the 0.05 % threshold at the snapshot.',button:'Not eligible'};
 const remaining=remainingRaw(row.allocationRaw,row.claimedRaw),expiresAtUnix=vault?.parentExpiryUnix??row.expiresAtUnix??null,deadlineText=expiresAtUnix?formatUtc(expiresAtUnix):'';
 const text=formatUnits(remaining,decimals,2);
 if(claimedAll(row.allocationRaw,row.claimedRaw))return {state:'claimed',remainingRaw:'0',remainingText:'0',expiresAtUnix,deadlineText,note:'Claimed: these coins are in your wallet.',button:'Claimed'};
 const expired=row.expired===true||(vault?vault.parentExpired===true||vault.parentWindowOpen===false:row.windowOpen===false);
 if(expired)return {state:'expired',remainingRaw:remaining,remainingText:text,expiresAtUnix,deadlineText,note:'Closed: the claim window ended'+(deadlineText?' on '+deadlineText:'')+'. Unclaimed parent rewards were burned.',button:'Closed'};
 return {state:'open',remainingRaw:remaining,remainingText:text,expiresAtUnix,deadlineText,note:'Eligible: '+text+' remaining'+(deadlineText?' · claim by '+deadlineText:''),button:'Claim'};
}
/**
 * The parent claim window as served: `claims.parentWindow` (build 6 launch-program rail: launch time + 30 days, with
 * tag 11's burn record) or the vault's expiry. Null when the live build has no window (rewards never expire).
 */
export function parentWindowFor(claims){
 const w=claims?.parentWindow;
 if(w&&Number.isFinite(w.expiresAtUnix)){const expired=w.expired===true||w.windowOpen===false;return {expiresAtUnix:w.expiresAtUnix,windowOpen:!expired,expired,burnedRaw:Array.isArray(w.burnedRaw)?w.burnedRaw.map(String):null,burnedAtUnix:Number.isFinite(w.burnedAtUnix)?w.burnedAtUnix:null};}
 const v=claims?.vault;
 if(v&&Number.isFinite(v.parentExpiryUnix)){const expired=v.parentExpired===true||v.parentWindowOpen===false;return {expiresAtUnix:v.parentExpiryUnix,windowOpen:!expired,expired,burnedRaw:null,burnedAtUnix:null};}
 return null;
}
/** The one-line note above the parent rows: "Claim by …" while open, the closed state (with the burn once recorded) after. */
export function parentWindowNote(window,decimals=6){
 if(!window)return null;const when=formatUtc(window.expiresAtUnix);
 if(!window.expired)return {closed:false,title:'Claim by '+when,detail:'Unclaimed parent rewards are burned after this deadline.',expiresAtUnix:window.expiresAtUnix};
 let burned=null;if(window.burnedRaw){burned=0n;for(const v of window.burnedRaw){const n=big(v);if(n!=null)burned+=n;}}
 const recorded=window.burnedAtUnix!=null||(burned!=null&&burned>0n);
 const detail=!recorded?'Unclaimed rewards are burned. The burn is not recorded on chain yet.':burned>0n?'Unclaimed rewards burned: '+formatUnits(burned.toString(),decimals,0)+' $Shartcoin.':'Nothing was left to burn: every reward was claimed.';
 return {closed:true,title:'Parent claims closed on '+when,detail,expiresAtUnix:window.expiresAtUnix,burnedRaw:burned==null?null:burned.toString()};
}
/**
 * Dev vesting facts. Public numbers come from the served distribution account when the coin is on the vault rail;
 * otherwise claimed and remaining are known only to the dev wallet (claims.dev) and stay null for everyone else.
 */
export function devSchedule(claims,data){
 const dist=data?.distribution||null,dev=claims?.dev||null,isDev=dev?.isDev===true;
 const totalRaw=dev?.totalRaw??dist?.allocationRaw?.[3]??null;
 const claimedRaw=dist?.claimedRaw?.[3]??(isDev?dev?.claimedRaw??null:null);
 const remaining=dist?.remainingRaw?.[3]??(isDev&&totalRaw!=null&&claimedRaw!=null?remainingRaw(totalRaw,claimedRaw):null);
 return {isDev,startUnix:dist?.devStartUnix??data?.launchedAt??null,endUnix:dist?.devEndUnix??dev?.endUnix??null,totalRaw,claimedRaw,remainingRaw:remaining,claimableRaw:isDev?dev?.claimableRaw??null:null,publicCounters:!!dist,beneficiary:claims?.dev?.wallet??data?.devWallet??(isDev?claims.owner:null)};
}
/** Items a signed-in wallet can claim right now, for the strip under the heading and the modal. */
export function claimableItems(claims,decimals=6){
 if(!claims)return [];
 const items=[];
 const participant=remainingRaw(claims.participant?.allocatedRaw,claims.participant?.claimedRaw);
 if(participant&&big(participant)>0n)items.push({key:'participant',label:'$Shartcoin',text:formatUnits(participant,decimals,2)+' $Shartcoin'});
 const refund=big(claims.refund?.claimableLamports);
 if(refund&&refund>0n)items.push({key:'refund',label:'SOL refund',text:formatSolAmount(refund).text+' refund'});
 (claims.parents||[]).forEach((row,index)=>{const p=parentState(row,claims.vault,decimals);if(p.state==='open'&&big(p.remainingRaw)>0n)items.push({key:index?'parentB':'parentA',label:row.name||(index?'Buttcoin':'Fartcoin'),text:p.remainingText+' from '+(row.name||(index?'Buttcoin':'Fartcoin'))});});
 const dev=big(claims.dev?.isDev?claims.dev.claimableRaw:null);
 if(dev&&dev>0n)items.push({key:'dev',label:'Dev vesting',text:formatUnits(dev,decimals,2)+' vested'});
 return items;
}
/** Plain-word network row for token details. */
export function networkFact(network,preview=false){
 const base={localnet:'Localnet · private test ledger',devnet:'Devnet · test network',mainnet:'Solana mainnet'}[network]||'Not served';
 return preview?base+' · rehearsal pool':base;
}
/** Custody facts from what the API served; anything missing reads "Not served" rather than a reassurance. */
export function custodyFacts(data){
 const flag=(value,yes,no)=>value===true?yes:value===false?no:'Not served';
 const short=v=>typeof v==='string'&&v.length>12?v.slice(0,5)+'…'+v.slice(-5):v;
 return [
  ['Mint authority',flag(data?.mintAuthorityRevoked,'Revoked','Still active')],
  ['Freeze authority',flag(data?.freezeAuthorityRevoked,'Revoked','Still active')],
  ['Liquidity',data?.liquidityLocked===true?'Locked · verified on this read':data?.liquidityLockQualified===true?'Lock verified at launch · not re-checked on this read':'Lock not verified'],
  ['Program upgrades',data?.upgradeAuthority===null?'Upgrade authority removed':typeof data?.upgradeAuthority==='string'?'Upgradeable by '+short(data.upgradeAuthority):'Not served'],
 ];
}
