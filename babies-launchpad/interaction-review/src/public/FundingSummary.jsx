import {useEffect,useState} from 'react';
import {ArrowRight} from '@phosphor-icons/react';
import {fundingState,meter,solAmount,openingEstimate,formatCountdown,formatUtc,percentOf,acceptedForOpeningEstimate} from './campaign-adapter.mjs';
import {ExactAmount} from './ExactAmount';
import {DataFreshness} from './DataFreshness';
import {Help} from '../Help';
export const HELP={hard:'The most SOL accepted for the launch. Commitments can continue until funding closes. If the total is higher, allocations are proportional and excess SOL is refundable.',soft:'The minimum accepted SOL needed to launch. If it is not reached, commitments can be refunded.',liquidity:'The launch liquidity is locked through the linked lock program. Fee collection rights remain and are governed by the displayed policy. View the on-chain proof and program authorities.',allocation:'Your estimated share if funding ended with the totals shown, including this amount. It can change before funding closes.'};
/**
 * The cap ruler (spec §6). Fill is committed/hard clamped at 100 %; the violet tick sits at soft/hard; the real
 * percentage and any excess are text beside it. The denominator never stretches.
 */
export function CapMeter({committedLamports,softLamports,hardLamports,mini=false,label}){
 const m=meter({committedLamports,softLamports,hardLamports});
 return <div className={'pl-meter'+(mini?' is-mini':'')+(m.reachedHard?' is-full':'')} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100,Math.round(m.committedPct))} aria-valuetext={label||(m.committedPct+'% of the hard cap committed')} style={{'--fill':m.fillPct+'%','--soft':m.softPct+'%'}}>
  <i/>{m.softPct>0&&m.softPct<100&&<b aria-hidden="true"/>}
 </div>;
}
function useTick(active){const [,set]=useState(0);useEffect(()=>{if(!active)return;const id=setInterval(()=>set(n=>n+1),1000);return()=>clearInterval(id);},[active]);}
/**
 * FundingSummary (spec §5, §6): state headline, figure, cap ruler, caps line, proportional-allocation sentence,
 * opening-liquidity estimate and the compact three-step stepper. `clock` gives chain-aligned seconds.
 */
export function FundingSummary({vm,clock,onRetry,onCheckStatus}){
 const now=clock();
 const state=fundingState(vm,now);
 useTick(!!state.countdown);
 const t=vm.terms,m=meter({committedLamports:vm.totals.committedLamports,softLamports:t.softLamports,hardLamports:t.hardLamports});
 const committed=solAmount(vm.totals.committedLamports),soft=solAmount(t.softLamports),hard=solAmount(t.hardLamports),excess=solAmount(m.excessLamports);
 const acceptedForEstimate=acceptedForOpeningEstimate(vm.totals,t.hardLamports);
 const est=acceptedForEstimate==null?null:openingEstimate({acceptedLamports:acceptedForEstimate,terms:t});
 const stage=['scheduled','open-below-soft','open-soft','open-hard'].includes(state.state)?0:['closed-unresolved','settling'].includes(state.state)?1:2;
 const pill={live:'is-open',pending:'is-pending',ok:'is-live',problem:'is-problem',muted:'is-muted'}[state.tone];
 const pillText={scheduled:'Upcoming','open-below-soft':'Open','open-soft':'Open','open-hard':'Open','closed-unresolved':'Closed',settling:'Settling',launching:'Launching',live:'Live',refund:'Refunds',unavailable:'Unavailable'}[state.state];
 return <section className="pl-panel pl-funding" aria-labelledby="pl-funding-h">
  <div className="pl-funding-top">
   <span className={'pl-pill '+pill}><i aria-hidden="true"/>{pillText}</span>
   {state.countdown&&<span className="pl-countdown">{state.countdown.label} <strong>{formatCountdown(state.countdown.at-now)}</strong> · <time dateTime={new Date(state.countdown.at*1000).toISOString()}>{formatUtc(state.countdown.at)}</time></span>}
   {!state.countdown&&vm.source.fetchedAtUnix!=null&&<DataFreshness fetchedAtUnix={vm.source.fetchedAtUnix} staleAfterSeconds={90}/>}
  </div>
  <h2 id="pl-funding-h">{state.headline}</h2>
  <p className="pl-funding-sub">{state.sub}</p>
  {state.state==='unavailable'&&onRetry&&<div style={{marginTop:12}}><button type="button" onClick={onRetry}>Retry</button></div>}
  {state.state==='closed-unresolved'&&onCheckStatus&&<div style={{marginTop:12}}><button type="button" onClick={onCheckStatus}>Check status</button></div>}
  {state.state!=='unavailable'&&est&&<>
   <div className="pl-figure">
    <strong><ExactAmount amount={committed} unit={false}/><small>SOL committed</small></strong>
    <span className="pl-num">{m.committedPct}% of hard cap</span>
    {m.overHard&&<span className="pl-excess"><ExactAmount amount={excess}/> over the cap · refundable pro rata</span>}
   </div>
   <CapMeter committedLamports={vm.totals.committedLamports} softLamports={t.softLamports} hardLamports={t.hardLamports}/>
   <div className="pl-meter-caps">
    <span><strong>{soft.compact} SOL</strong> minimum<Help label="Soft cap">{HELP.soft}</Help></span>
    <span><strong>{hard.compact} SOL</strong> maximum accepted<Help label="Hard cap">{HELP.hard}</Help></span>
   </div>
   <p className="pl-funding-sub" style={{marginTop:12}}>Allocations are proportional to accepted SOL. Anything above the maximum is refundable after settlement; nothing is first come, first served.</p>
   <div className="pl-estimate">
    <div><span>Estimated opening liquidity</span><strong>{est.requiresSoft?'Launch requires the soft cap':<><ExactAmount amount={solAmount(est.nominalPoolLamports)}/> <small className="pl-muted">nominal, both sides</small></>}</strong></div>
    <div><span>Estimated opening FDV</span><strong>{est.fdvLamports&&!est.requiresSoft?<ExactAmount amount={solAmount(est.fdvLamports)}/>:'—'} {est.fdvLamports&&!est.requiresSoft&&<small className="pl-muted">at the opening price</small>}</strong></div>
   </div>
   <p className="pl-help-text">Estimates use {vm.totals.acceptedLamports!=null?'the settled':'the currently estimated'} accepted SOL ({solAmount(acceptedForEstimate).compact} SOL) and the sealed terms. No USD figure is shown without a price source and timestamp.</p>
   <div className="pl-steps" aria-label="Launch stages">
    {['Commit','Allocate','Launch & refund'].map((s,i)=><span key={s} className={i===stage?'is-now':i<stage?'is-done':''}><i>{i+1}</i>{s}{i<2&&<ArrowRight size={12} aria-hidden="true"/>}</span>)}
   </div>
  </>}
 </section>;
}
export {percentOf};
