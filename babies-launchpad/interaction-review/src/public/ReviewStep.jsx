import {Warning} from '@phosphor-icons/react';
import {reviewModel} from './launch-draft.mjs';
import {solAmount} from './campaign-adapter.mjs';
import {SupplySplit} from './SupplySplit';
import {ParentPair} from './CoinIdentity';
import {ExactAmount} from './ExactAmount';
import {TransactionStatus} from './TransactionStatus';
/**
 * Step 4 (spec §4): identity, mode, parents, exact caps and times, supply, fee policy, addresses, itemised cost
 * quote in three kinds, the sealing sentence and one primary action. The action only calls `onCreate`; nothing signs.
 */
export function ReviewStep({draft,manifest,clock,onCreate,creating,notice,onPublicationConsent,rehearsal=false}){
 const r=reviewModel(draft,manifest,clock());
 // Why the button is off, in plain words (the pilot's first review showed a dead button with no reason).
 const blockers=[];
 if(!r.caps)blockers.push('Choose a cap preset.');
 if(!draft.publicationConsent)blockers.push('Tick the publication approval above.');
 if(!rehearsal&&!manifest.capabilities?.create)blockers.push('New launch creation is not enabled on this server.');
 if(!rehearsal&&manifest.capabilities?.create&&!manifest.costQuote)blockers.push('The cost quote has not loaded yet. Reload the page.');
 if(!onCreate)blockers.push(rehearsal?'The local rehearsal is off.':'Connect and sign in with the pilot wallet to create.');
 const terms=r.caps?{softLamports:draft&&manifest.presets.find(p=>p.id===draft.presetId)?.softLamports,hardLamports:manifest.presets.find(p=>p.id===draft.presetId)?.hardLamports,supply:{...(manifest.supply[draft.mode]||manifest.supply.standard),totalBaseUnits:manifest.supply.totalBaseUnits,decimals:manifest.supply.decimals},vesting:manifest.vesting}:null;
 return <div className="pl-step pl-review">
  <h2>Review your launch.</h2>
  <p className="pl-lead">Check every line. The program seals financial terms at creation. Program upgrade permissions are disclosed separately.</p>
  <section className="pl-panel" aria-label="Identity"><h3 className="pl-label">Identity</h3><div className="pl-rows">
   <div className="pl-row"><span>Name</span><span>{r.identity.name}</span></div>
   <div className="pl-row"><span>Ticker</span><span>${r.identity.symbol}</span></div>
   <div className="pl-row"><span>Type</span><span>{r.identity.mode==='family'?'Family':'Standard'}</span></div>
   {r.identity.parents.length>0&&<div className="pl-row"><span>Parents</span><span><ParentPair parents={r.identity.parents}/></span></div>}
  </div></section>
  {r.caps&&<section className="pl-panel" aria-label="Caps and times"><h3 className="pl-label">Caps and times</h3><div className="pl-rows">
   <div className="pl-row"><span>Preset</span><span>{r.caps.label}</span></div>
   <div className="pl-row"><span>Minimum accepted</span><span><ExactAmount amount={r.caps.soft}/></span></div>
   <div className="pl-row"><span>Maximum accepted</span><span><ExactAmount amount={r.caps.hard}/></span></div>
   <div className="pl-row"><span>Funding opens</span><span>{r.schedule.startLabel}</span></div>
   <div className="pl-row"><span>Funding closes</span><span>{r.schedule.estimated?'2 h after opening':r.schedule.closeUtc}</span></div>
   <div className="pl-row"><span>Launch deadline</span><span>{r.schedule.launchWindowSeconds/3600} h after close</span></div>
  </div></section>}
  {terms&&<section className="pl-panel" aria-label="Supply and vesting"><h3 className="pl-label">Supply and vesting</h3><SupplySplit terms={terms}/></section>}
  <section className="pl-panel" aria-label="Fees and addresses"><h3 className="pl-label">Fees and addresses</h3><div className="pl-rows">
   {r.fee&&<div className="pl-row"><span>Trading fee</span><span>{r.fee.label}</span></div>}
   {r.fee&&<div className="pl-row"><span>Coin-side fees</span><span>{r.fee.tokenSide==='burn'?'Burned':r.fee.tokenSide}</span></div>}
   <div className="pl-row"><span>Creator</span><span className="pl-mono pl-small">{r.addresses.creator||'Not connected'}</span></div>
   <div className="pl-row"><span>Dev beneficiary</span><span className="pl-mono pl-small">{r.addresses.devBeneficiary||'Creator wallet'}</span></div>
   <div className="pl-row"><span>Treasury</span><span className="pl-mono pl-small">{r.addresses.treasury||'Per manifest'}</span></div>
  </div></section>
  <section className="pl-panel pl-review-quote" aria-label="Cost quote"><div className="pl-panel-head"><h3 className="pl-label" style={{margin:0}}>What you pay to create it</h3>{r.quote.validForSeconds!=null&&<span className="pl-small pl-muted">Quote valid {Math.round(r.quote.validForSeconds/60)} min</span>}</div><div className="pl-rows">
   {r.quote.items.map(i=><div className="pl-row" key={i.key}><span>{i.label} <span className="pl-tag">{{refundable:'refundable if unspent',consumed:'consumed',charge:'platform charge'}[i.kind]||i.kind}</span>{i.note&&<><br/><small className="pl-muted">{i.note}</small></>}</span><span><strong><ExactAmount amount={solAmount(i.lamports||'0')}/></strong></span></div>)}
   {manifest.costQuote?<div className="pl-row"><span><strong>Total to fund now</strong><br/><small className="pl-muted">{r.quote.refundable.compact} SOL refundable · {r.quote.consumed.compact} SOL consumed · {r.quote.charge.compact} SOL platform charge</small></span><span><strong><ExactAmount amount={r.quote.total}/></strong></span></div>:<p className="pl-muted">Creation cost quote unavailable. No transaction can be signed yet.</p>}
  </div><p className="pl-help-text">Nothing is deducted from participants' committed SOL. If the quote changes before you sign, you review it again.</p></section>
  <p className="pl-seal"><Warning size={18} weight="bold" aria-hidden="true"/><span>{r.sealingSentence}</span></p>
  <label className="pl-publication-consent"><input type="checkbox" checked={draft.publicationConsent===true} disabled={creating||!onPublicationConsent} onChange={e=>onPublicationConsent?.(e.target.checked)}/><span>I approve publishing this coin's name, ticker, description and artwork permanently. Public copies cannot be made private again.</span></label>
  {notice&&<TransactionStatus {...notice}/>}
  <div className="pl-review-actions">
   <button type="button" className="primary" disabled={creating||blockers.length>0} onClick={()=>onCreate&&onCreate(draft,r)}>{creating?'Preparing review…':rehearsal?'Review local setup':'Create launch'}</button>
   {!creating&&blockers.length>0&&<ul className="pl-small pl-muted pl-review-blockers" aria-live="polite">{blockers.map(b=><li key={b}>{b}</li>)}</ul>}
   <p className="pl-help-text" style={{textAlign:'center'}}>{rehearsal?'Private localnet rehearsal. Review a fresh setup quote before any wallet approval.':manifest.capabilities?.create?'Your wallet will ask you to confirm.':'New launch creation is not enabled. You can save your draft and return later.'}</p>
  </div>
 </div>;
}
