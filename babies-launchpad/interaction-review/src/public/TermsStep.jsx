import {useId} from 'react';
import {Check,Warning} from '@phosphor-icons/react';
import {solAmount,percentOfBps,formatLocal,formatUtc} from './campaign-adapter.mjs';
import {schedule,draftTerms} from './launch-draft.mjs';
import {SupplySplit} from './SupplySplit';
/** Step 3 (spec §4): presets from the manifest (status shown), fixed two-hour duration, UTC start, supply strip, terms rows. */
export function TermsStep({draft,dispatch,errors,manifest,clock,show}){
 const id=useId();
 const sched=schedule(draft,manifest,clock()),terms=draftTerms(draft,manifest);
 const fee=manifest.fee,routing=fee.solRouting?.[draft.mode]||null;
 const routeText=routing?Object.entries(routing).filter(([k])=>k!=='of').map(([k,v])=>k+' '+v+'/'+routing.of).join(' · '):null;
 return <div className="pl-step">
  <h2>Choose your launch size.</h2>
  <p className="pl-lead">Presets come from the <span className="pl-tag">{manifest.version} · {manifest.status}</span> manifest. Commitments stay open until the timer ends. If commitments exceed the maximum, everyone receives a proportional allocation and can reclaim their excess SOL.</p>
  <div className="pl-cards" role="radiogroup" aria-label="Launch size">
   {manifest.presets.map(p=><button key={p.id} type="button" className="pl-card" role="radio" aria-checked={draft.presetId===p.id} onClick={()=>dispatch({type:'set',field:'presetId',value:p.id})}><strong>{p.label} {draft.presetId===p.id&&<Check size={18} weight="bold" aria-hidden="true"/>}</strong><span className="pl-card-terms"><span><b className="pl-num">{solAmount(p.softLamports).compact} SOL</b> minimum</span><span><b className="pl-num">{solAmount(p.hardLamports).compact} SOL</b> maximum accepted</span>{p.note&&<small>{p.note}</small>}</span></button>)}
  </div>
  {show&&errors.preset&&<p className="pl-error"><Warning size={14} aria-hidden="true"/>{errors.preset}</p>}
  <div className="pl-field">
   <span className="pl-label" id={id+'-start-l'}>Funding start</span>
   <div className="pl-radio" role="radiogroup" aria-labelledby={id+'-start-l'}>
    <label><input type="radio" name={id+'-start'} checked={draft.start==='after-creation'} onChange={()=>dispatch({type:'set',field:'start',value:'after-creation'})}/>Open as soon as creation confirms</label>
    <label><input type="radio" name={id+'-start'} checked={draft.start==='scheduled'} onChange={()=>dispatch({type:'set',field:'start',value:'scheduled'})}/>Open at a set time (UTC)</label>
   </div>
   {draft.start==='scheduled'&&<div style={{marginTop:10}}><label htmlFor={id+'-utc'}>Opening time, UTC</label><input id={id+'-utc'} type="datetime-local" value={draft.startUtc} onChange={e=>dispatch({type:'set',field:'startUtc',value:e.target.value})} aria-invalid={show&&!!errors.startUtc||undefined} aria-describedby={id+'-utc-h'}/>{show&&errors.startUtc?<p className="pl-error" id={id+'-utc-h'}><Warning size={14} aria-hidden="true"/>{errors.startUtc}</p>:<p className="pl-help-text" id={id+'-utc-h'}>Entered as UTC, not your local time.{sched.opensAtUnix?' That is '+formatLocal(sched.opensAtUnix)+'.':''}</p>}</div>}
  </div>
  <div className="pl-terms" style={{marginBottom:20}}>
   <div className="pl-row-static"><span>Funding duration</span><span>{sched.fundingSeconds/3600} hours · fixed for this manifest</span></div>
   <div className="pl-row-static"><span>Funding closes</span><span>{sched.estimated?'2 h after creation confirms':<><time>{sched.closeUtc}</time><br/><small className="pl-muted">{sched.closeLocal}</small></>}</span></div>
   <div className="pl-row-static"><span>Launch-processing deadline</span><span>{sched.launchWindowSeconds/3600} h after close{sched.opensAtUnix?<><br/><small className="pl-muted">{formatUtc(sched.launchDeadlineUnix)}</small></>:null}<br/><small className="pl-muted">Launch happens inside this window, not at the instant of close. If it cannot, every commitment is refundable.</small></span></div>
  </div>
  {terms&&<div className="pl-field"><span className="pl-label">Supply</span><SupplySplit terms={terms}/>{draft.mode==='family'&&<p className="pl-help-text">Each parent community gets a {percentOfBps(terms.supply.parentsBps/2)} reserve. Threshold {percentOfBps(manifest.parentPolicy?.thresholdBps??0)} of the parent supply at its snapshot; snapshot {manifest.parentPolicy?.snapshot?.toLowerCase()||'policy per manifest'}; free-claim expiry: {manifest.parentPolicy?.freeClaimExpiry||'per manifest'}.</p>}</div>}
  <div className="pl-terms">
   <div className="pl-row-static"><span>Trading fee</span><span>Trading fee: {percentOfBps(fee.totalBps)} total · network fees extra{fee.creatorFeeEnabled?' · creator fee enabled':''}</span></div>
   <div className="pl-row-static"><span>Collected fees</span><span>Coin-side fees {fee.tokenSide==='burn'?'are burned':fee.tokenSide}{routeText?<><br/><small className="pl-muted">SOL-side routing: {routeText}</small></>:null}</span></div>
   <div className="pl-row-static"><span>Dev beneficiary</span><span className="pl-mono pl-small">{draft.devBeneficiary||draft.creator||'Creator wallet (fixed at creation)'}</span></div>
   <div className="pl-row-static"><span>Treasury destination</span><span className="pl-mono pl-small">{manifest.treasury||'Per manifest'}</span></div>
   <div className="pl-row-static"><span>Locked liquidity</span><span>{manifest.lock?.model||'Liquidity principal locked at launch'}</span></div>
   <div className="pl-row-static"><span>Upgradeability</span><span className="pl-mono pl-small">{manifest.upgradeAuthority?'Upgrade authority '+manifest.upgradeAuthority:'Not published'}</span></div>
   <div className="pl-row-static"><span>Claims and refunds</span><span>Participant claims and refunds never expire</span></div>
  </div>
 </div>;
}
