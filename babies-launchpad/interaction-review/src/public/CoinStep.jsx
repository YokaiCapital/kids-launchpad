import {useId,useState} from 'react';
import {Check,Warning} from '@phosphor-icons/react';
import {LIMITS,utf8Bytes} from './launch-draft.mjs';
import {shortAddress} from './campaign-adapter.mjs';
function ParentPicker({index,value,parents,exclude,onPick,error}){
 const id=useId();const [q,setQ]=useState('');
 const results=q.trim()?parents.filter(p=>(p.name+' '+p.symbol+' '+p.mint).toLowerCase().includes(q.trim().toLowerCase())):parents;
 return <div className="pl-field pl-parent-pick">
  <label htmlFor={id}>Parent {index+1}</label>
  {value?<div className="pl-parent-chosen">{value.logo?<img src={value.logo} alt=""/>:<span className="pl-parent-mark" aria-hidden="true">{value.name.charAt(0)}</span>}<span className="pl-pr-text"><strong>{value.name} <span className="pl-muted">${value.symbol}</span></strong><small><details style={{display:'inline'}}><summary style={{display:'inline',cursor:'pointer'}}>{shortAddress(value.mint)}</summary> {value.mint}</details></small></span><button type="button" className="pl-btn-sm pl-quiet" onClick={()=>onPick(null)}>Change</button></div>:
  <>
   <input id={id} type="search" value={q} onChange={e=>setQ(e.target.value)} placeholder="Search by name, ticker or mint" autoComplete="off" aria-describedby={id+'-h'}/>
   <div className="pl-parent-results" role="listbox" aria-label={'Parent '+(index+1)+' results'}>
    {results.length===0&&<p className="pl-help-text" style={{padding:'8px 12px'}}>No verified community mint matches. Paste the exact mint address; nothing is selected by name alone.</p>}
    {results.map(p=>{const dup=exclude&&exclude.mint===p.mint,blocked=!p.verified||p.unsupportedReason||dup;return <button key={p.mint} type="button" role="option" aria-selected={false} disabled={!!blocked} onClick={()=>onPick(p)}>{p.logo?<img src={p.logo} alt=""/>:<span className="pl-parent-mark" aria-hidden="true">{p.name.charAt(0)}</span>}<span className="pl-pr-text"><strong>{p.name} <span className="pl-muted">${p.symbol}</span></strong><small>{shortAddress(p.mint)}</small></span>{dup?<span className="pl-pr-why">Already chosen</span>:!p.verified?<span className="pl-pr-why">Not verified</span>:p.unsupportedReason?<span className="pl-pr-why">{p.unsupportedReason}</span>:<Check size={16} aria-hidden="true"/>}</button>;})}
   </div>
   <p className="pl-help-text" id={id+'-h'}>Only verified, resolved mints can be chosen. Choosing parents does not publish any eligibility root.</p>
  </>}
  {error&&<p className="pl-error"><Warning size={14} aria-hidden="true"/>{error}</p>}
 </div>;
}
/** Step 1 (spec §4): Standard or Family, name and ticker with live byte counts, Family parent pickers. */
export function CoinStep({draft,dispatch,errors,parents,show,familyEnabled=false}){
 const id=useId();
 const nameBytes=utf8Bytes(draft.name),symBytes=utf8Bytes(draft.symbol);
 return <div className="pl-step">
  <h2>What are you launching?</h2>
  <p className="pl-lead">Standard is the default. Family adds two parent communities and their reward reserve.</p>
  <div className="pl-cards" role="radiogroup" aria-label="Launch type">
   <button type="button" className="pl-card" role="radio" aria-checked={draft.mode==='standard'} onClick={()=>dispatch({type:'mode',value:'standard'})}><strong>Standard {draft.mode==='standard'&&<Check size={18} weight="bold" aria-hidden="true"/>}</strong><span>Your coin, backed by its community.</span><span className="pl-card-terms"><small>No parent inputs. No parent reward reserve.</small></span></button>
   <button type="button" className="pl-card" role="radio" disabled={!familyEnabled} aria-checked={draft.mode==='family'} onClick={()=>dispatch({type:'mode',value:'family'})}><strong>Family {draft.mode==='family'&&<Check size={18} weight="bold" aria-hidden="true"/>}</strong><span>{familyEnabled?'Two parent communities. One new coin.':'New Family launches are not enabled yet.'}</span><span className="pl-card-terms"><small>Needs two verified parent mints, a holder snapshot for each, and 10% of supply reserved for their holders.</small></span></button>
  </div>
  <div className="pl-two">
   <div className="pl-field"><div className="pl-field-row"><label htmlFor={id+'-name'}>Coin name</label><span className={'pl-count'+(nameBytes>LIMITS.nameBytes?' is-over':'')}>{nameBytes} / {LIMITS.nameBytes} bytes</span></div><input id={id+'-name'} value={draft.name} maxLength={64} onChange={e=>dispatch({type:'set',field:'name',value:e.target.value})} placeholder="e.g. Pebble" aria-invalid={show&&!!errors.name||undefined} aria-describedby={id+'-name-h'} autoComplete="off"/>{show&&errors.name?<p className="pl-error" id={id+'-name-h'}><Warning size={14} aria-hidden="true"/>{errors.name}</p>:<p className="pl-help-text" id={id+'-name-h'}>Shown exactly as typed. Names are not unique; the mint is the identity.</p>}</div>
   <div className="pl-field"><div className="pl-field-row"><label htmlFor={id+'-sym'}>Ticker</label><span className={'pl-count'+(symBytes>LIMITS.symbolBytes?' is-over':'')}>{symBytes} / {LIMITS.symbolBytes} bytes</span></div><input id={id+'-sym'} value={draft.symbol} maxLength={20} onChange={e=>dispatch({type:'set',field:'symbol',value:e.target.value})} placeholder="e.g. PEBL" aria-invalid={show&&!!errors.symbol||undefined} aria-describedby={id+'-sym-h'} autoComplete="off" spellCheck="false"/>{show&&errors.symbol?<p className="pl-error" id={id+'-sym-h'}><Warning size={14} aria-hidden="true"/>{errors.symbol}</p>:<p className="pl-help-text" id={id+'-sym-h'}>No spaces. Case is kept.</p>}</div>
  </div>
  {draft.mode==='family'&&<div className="pl-two">
   <ParentPicker index={0} value={draft.parents[0]} exclude={draft.parents[1]} parents={parents} onPick={v=>dispatch({type:'parent',index:0,value:v})} error={show&&!draft.parents[0]?errors.parents:null}/>
   <ParentPicker index={1} value={draft.parents[1]} exclude={draft.parents[0]} parents={parents} onPick={v=>dispatch({type:'parent',index:1,value:v})} error={show&&draft.parents[0]?errors.parents:null}/>
  </div>}
  <div className="pl-field"><span className="pl-label">Creator wallet</span><p className="pl-small">{draft.creator?<span className="pl-mono">{draft.creator}</span>:<span className="pl-muted">Not connected. You can prepare the draft; creating the launch needs the creator wallet.</span>}</p><p className="pl-help-text">Fixed to the signed-in account. Switching accounts pauses the draft instead of moving it.</p></div>
 </div>;
}
