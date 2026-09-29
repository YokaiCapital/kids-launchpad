import {claimGroups,formatUtc} from './campaign-adapter.mjs';
import {ExactAmount} from './ExactAmount';
import {FeePayoutRepair} from './FeePayoutRepair';
/**
 * ClaimsSummary (spec §8): separate entitlements, one group each, explicit eligibility reasons. "Could not verify
 * eligibility" is never rendered as "Not eligible". `onClaim(groupKey)` is optional and never signs here.
 */
export function ClaimsSummary({vm,position,connected=false,onClaim,busy=false}){
 if(!connected)return <section className="pl-panel" aria-label="Claims"><h3 className="pl-label">Claims</h3><p className="pl-small pl-muted">Connect a wallet to see your allocation, refund and any parent rewards.</p></section>;
 const groups=claimGroups(vm,position===undefined?{eligibility:'unknown'}:position||{commitLamports:'0',parents:[]});
 const actionable=groups.filter(g=>g.action).length;
 return <section className="pl-panel pl-claims" aria-label="Claims">
  <div className="pl-panel-head"><h3 className="pl-label" style={{margin:0}}>Claims</h3>{actionable>0&&<span className="pl-pill is-open">{actionable} available</span>}</div>
  {groups.map(g=><div className="pl-claim-group" key={g.key}>
   <div className="pl-claim-head"><h3>{g.parent?.logo&&<img src={g.parent.logo} alt="" loading="lazy"/>}{g.title}</h3>{g.action&&onClaim&&<button type="button" className="pl-btn-sm primary" disabled={busy} onClick={()=>onClaim(g.key)}>{g.action}</button>}</div>
   {g.reason&&<p className="pl-claim-reason">{g.reason}</p>}
   {g.rows.length>0&&<div className="pl-rows">{g.rows.map(r=><div className="pl-row" key={r.label}><span>{r.label}</span><span><ExactAmount amount={r.amount}/></span></div>)}</div>}
   {g.expiryUnix&&<p className="pl-claim-reason">Claim by {formatUtc(g.expiryUnix)}</p>}
  </div>)}
  <FeePayoutRepair payout={position?.feePayout} busy={busy} onRestore={onClaim?()=>onClaim('fee-account'):null}/>
 </section>;
}
