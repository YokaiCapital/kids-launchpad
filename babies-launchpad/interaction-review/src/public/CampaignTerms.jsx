import {CaretDown} from '@phosphor-icons/react';
import {formatUtc,formatLocal,solAmount,termsRows,percentOfBps} from './campaign-adapter.mjs';
import {SupplySplit} from './SupplySplit';
import {ExactAmount} from './ExactAmount';
/**
 * CampaignTerms (spec §4 step 3, §9): the sealed terms of one campaign, plain-language essentials visible, exact
 * addresses and policy version behind expandable rows. Driven by the adapter; nothing is hard-coded here.
 */
export function CampaignTerms({vm,showSchedule=true}){
 const t=vm.terms,rows=termsRows(vm);
 return <div className="pl-terms">
  <h3 className="pl-label">Supply</h3>
  <SupplySplit terms={t}/>
  {vm.mode==='family'&&vm.parents.length>0&&<div className="pl-rows" style={{marginTop:12}}>
   {vm.parents.map(p=><div className="pl-row" key={p.mint}><span>{p.name} reserve</span><span>{p.reserveBps!=null?percentOfBps(p.reserveBps):'—'}{p.thresholdBps!=null?' · hold ≥ '+percentOfBps(p.thresholdBps)+' at snapshot':''}{p.snapshotSlot?' · slot '+p.snapshotSlot:''}{p.claimExpiryUnix?' · claims until '+formatUtc(p.claimExpiryUnix):' · no claim expiry'}</span></div>)}
  </div>}
  <h3 className="pl-label" style={{marginTop:18}}>Caps and timing</h3>
  <div className="pl-row-static"><span>Minimum accepted (soft cap)</span><span><ExactAmount amount={solAmount(t.softLamports)} label="Soft cap"/></span></div>
  <div className="pl-row-static"><span>Maximum accepted (hard cap)</span><span><ExactAmount amount={solAmount(t.hardLamports)} label="Hard cap"/></span></div>
  {showSchedule&&<>
   <div className="pl-row-static"><span>Funding opens</span><span>{t.opensAtUnix!=null?<><time dateTime={new Date(t.opensAtUnix*1000).toISOString()}>{formatUtc(t.opensAtUnix)}</time><br/><small className="pl-muted">{formatLocal(t.opensAtUnix)}</small></>:'Not set'}</span></div>
   <div className="pl-row-static"><span>Funding closes</span><span>{t.deadlineUnix!=null?<><time dateTime={new Date(t.deadlineUnix*1000).toISOString()}>{formatUtc(t.deadlineUnix)}</time><br/><small className="pl-muted">{formatLocal(t.deadlineUnix)}</small></>:'Not set'}</span></div>
   <div className="pl-row-static"><span>Launch deadline</span><span>{t.launchDeadlineUnix!=null?formatUtc(t.launchDeadlineUnix):'Not set'}<br/><small className="pl-muted">If the launch is not complete by then, every commitment is refundable.</small></span></div>
  </>}
  <h3 className="pl-label" style={{marginTop:18}}>Fees, custody and policy</h3>
  {rows.map(r=>r.detail?<details key={r.key}><summary><span>{r.label}</span><span>{r.value}<CaretDown size={14} aria-hidden="true"/></span></summary><div className="pl-detail">{r.detail}</div></details>:<div className="pl-row-static" key={r.key}><span>{r.label}</span><span>{r.value}</span></div>)}
 </div>;
}
