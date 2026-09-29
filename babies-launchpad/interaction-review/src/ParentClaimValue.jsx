import {useId,useState} from 'react';
import {claimValueCents,displayValue,estimateSol,launchSupplyRaw,countText} from './valuation.mjs';
import {formatUnits} from './flywheel-format.mjs';
import {formatSol} from './market-data.mjs';
import {formatUtc} from './launch-status.mjs';
import {Help} from './Help';
import './parent-claim-value.css';
const iso=value=>{const t=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(t)?Math.floor(t/1000):null;};
/**
 * One parent's reward card, under its claim row (reviewed draft, integrated 23 September 2026).
 * `stats` is the served parentStats entry (null when not served; every null field reads "unknown", never 0),
 * `row` is claims.parents[i] for the signed-in wallet, `state` is parentState(row). The SOL figure is an estimate at
 * the last trade price; the collapsed calculator is a hypothetical at a chosen valuation. Neither is a promise.
 * Callers remount this when the wallet, mint or campaign changes.
 */
export function ParentClaimValue({name,stats,row,state,decimals=6,priceSol=null,data=null}){
 const snapshotUnix=iso(stats?.snapshotAt),deadline=stats?.expiresAtUnix??state?.expiresAtUnix??null;
 const remainingPool=stats?.remainingRaw==null?'unknown':formatUnits(stats.remainingRaw,decimals,0);
 const mine=state?.state==='open'||state?.state==='expired'?state.remainingRaw:null;
 const minePositive=typeof mine==='string'&&/^\d+$/.test(mine)&&BigInt(mine)>0n;
 const sol=minePositive?estimateSol(mine,decimals,priceSol):null;
 const supply=launchSupplyRaw(stats,data);
 return <div className="parent-claim">
  <dl className="parent-claim-stats">
   <div><dt>Eligible wallets</dt><dd>{countText(stats?.eligibleOwners)}</dd></div>
   <div><dt>Claimed</dt><dd>{countText(stats?.claimedCount)}{stats?.claimedCount!=null&&<small className="is-inline">wallets</small>}{stats?.claimedRaw!=null&&<small>{formatUnits(stats.claimedRaw,decimals,0)} coins</small>}</dd></div>
   <div><dt>Left in the pool</dt><dd>{remainingPool}{stats?.remainingRaw!=null&&<small>$Shartcoin</small>}</dd></div>
  </dl>
  <p className="parent-claim-facts">
   {stats?snapshotUnix?<>Snapshot {formatUtc(snapshotUnix)}{stats.snapshotSlot!=null&&<> · slot {Number(stats.snapshotSlot).toLocaleString('en-GB')}</>}</>:stats.snapshotSlot!=null?<>Snapshot slot {Number(stats.snapshotSlot).toLocaleString('en-GB')} · time unknown</>:'Snapshot time unknown':'Snapshot not served yet'}
   {stats&&stats.rootVerified===false&&<> · <span className="parent-claim-unverified">snapshot not verified on chain</span></>}
   {deadline?<> · Deadline {formatUtc(deadline)}</>:<> · Deadline not served</>}
  </p>
  {minePositive&&<div className="parent-claim-mine">
   <span>Yours{state.state==='expired'?' (closed)':''}</span>
   <strong>{sol!=null?formatSol(sol)+' SOL':'—'}</strong>
   <small>{sol!=null?'estimate at the last trade price':'no trade price read yet'}<Help label="Estimate at the last trade price">{formatUnits(mine,decimals,2)} $Shartcoin times the price of the last trade. Selling moves the price, so it is not a sale amount.</Help></small>
  </div>}
  {minePositive&&state.state==='open'&&<Calculator claimableRaw={mine} supply={supply} decimals={decimals}/>}
 </div>;
}
/** Hypothetical value at a chosen fully diluted valuation: the wallet's fixed token amount over the launch supply. */
function Calculator({claimableRaw,supply,decimals}){
 const id=useId();
 const [fdv,setFdv]=useState('1000000');
 const verified=supply.raw!=null;
 const value=verified?claimValueCents(claimableRaw,supply.raw,fdv):null;
 const positive=/^\d{1,40}$/.test(claimableRaw)&&BigInt(claimableRaw)>0n;
 return <details className="parent-claim-value">
  <summary>Value at different valuations</summary>
  <div className="parent-claim-value__presets" role="group" aria-label="Hypothetical fully diluted valuation">
   {[['100000','$100K'],['1000000','$1M'],['10000000','$10M']].map(([amount,label])=><button type="button" key={amount} aria-pressed={fdv===amount} onClick={()=>setFdv(amount)}>{label}</button>)}
  </div>
  <label htmlFor={id}>Custom FDV · USD</label>
  <input id={id} inputMode="decimal" autoComplete="off" maxLength={18} value={fdv} onChange={event=>setFdv(event.target.value)} aria-describedby={`${id}-note`}/>
  <p className="parent-claim-value__result" role="status">Estimated unclaimed value <strong>{displayValue(value,positive)}</strong></p>
  <p id={`${id}-note`}>{!verified?'The supply is not served yet, so no estimate. ':value==null?'Enter a positive USD valuation with up to two decimal places. ':''}FDV uses the {supply.source==='current'?'current':'launch'} supply of {supply.raw!=null?formatUnits(supply.raw,decimals,0):'unknown'} $Shartcoin. Your token amount stays fixed. Estimated value, not guaranteed sale proceeds; fees and price impact apply.</p>
 </details>;
}
