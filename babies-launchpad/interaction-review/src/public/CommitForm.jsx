import {useId,useState} from 'react';
import {estimatePosition,solAmount,tokenAmount,fundingState,formatUtc} from './campaign-adapter.mjs';
import {ExactAmount} from './ExactAmount';
import {Help} from '../Help';
import {HELP} from './FundingSummary';
const PRESETS=['0.5','1','5'];
/** '1.25' -> lamports string; empty or malformed -> null. Up to nine decimals, integer maths. */
export function parseSolInput(text){
 const m=/^\s*(\d+)?(?:\.(\d{0,9}))?\s*$/.exec(String(text||''));if(!m||(!m[1]&&!m[2]))return null;
 const n=BigInt(m[1]||'0')*1000000000n+BigInt((m[2]||'').padEnd(9,'0'));return n<=(1n<<64n)-1n?String(n):null;
}
/**
 * CommitForm (spec §7): one amount field, spendable balance, presets, primary action. Before an amount is entered
 * there is no empty "You receive" panel. After input, the projection counts the amount in both the wallet total and
 * the campaign total. No signing lives here: `onCommit(lamports)` is optional and absent in this scaffold.
 */
export function CommitForm({vm,clock,connected=false,balanceLamports=null,existingLamports='0',minimumLamports=null,onCommit,onConnect,busy=false}){
 const id=useId();
 const [text,setText]=useState('');
 const state=fundingState(vm,clock());
 const lamports=parseSolInput(text);
 const invalid=text.trim()!==''&&lamports==null;
 const canCommit=state.action==='commit';
 const t=vm.terms,d=t.supply.decimals;
 const est=canCommit&&vm.totals.committedLamports!=null&&lamports&&BigInt(lamports)>0n?estimatePosition({existingLamports,addLamports:lamports,totalCommittedLamports:vm.totals.committedLamports,terms:t}):null;
 const already=BigInt(existingLamports||'0')>0n;
 // The manifest's minimum applies to a wallet's first commitment only; a top-up on an existing receipt may be smaller.
 const minimum=minimumLamports!=null&&!already&&/^\d+$/.test(String(minimumLamports))?BigInt(minimumLamports):0n;
 const tooLittle=lamports!=null&&BigInt(lamports)>0n&&BigInt(lamports)<minimum;
 const tooMuch=balanceLamports!=null&&lamports!=null&&BigInt(lamports)>BigInt(balanceLamports);
 const disabledReason=busy?'Checking your transaction. Do not submit again.':!canCommit?(state.state==='scheduled'?'Commitments open at '+(t.opensAtUnix!=null?formatUtc(t.opensAtUnix):'the announced time')+'.':'Commitments are closed.'):!connected?'Connect a wallet to commit.':!onCommit?'Commitments are unavailable on this service.':lamports==null||BigInt(lamports)<=0n?'Enter an amount.':tooLittle?'The first commitment is at least '+solAmount(String(minimum)).compact+' SOL.':tooMuch?'That is more than your wallet balance. Keep SOL for fees and account rent.':null;
 return <form className="pl-panel pl-commit" onSubmit={e=>{e.preventDefault();if(!disabledReason&&onCommit)onCommit(lamports);}} aria-labelledby={id+'-h'}>
  <h3 id={id+'-h'} className="pl-label">Commit SOL</h3>
  <div className="pl-amount"><label htmlFor={id+'-amt'} className="pl-sr">Amount in SOL</label><input id={id+'-amt'} inputMode="decimal" autoComplete="off" placeholder="e.g. 2.5" value={text} onChange={e=>setText(e.target.value)} aria-invalid={invalid||undefined} aria-describedby={id+'-hint'} disabled={!canCommit}/><span aria-hidden="true">SOL</span></div>
  <div className="pl-balance">
   <span>{connected?balanceLamports!=null?<>Balance <strong className="pl-num">{solAmount(balanceLamports).compact} SOL</strong></>:'Balance not read':'No wallet connected'}</span>
   <div className="pl-presets" role="group" aria-label="Quick amounts">{PRESETS.map(p=><button key={p} type="button" onClick={()=>setText(p)} disabled={!canCommit}>{p}</button>)}{balanceLamports!=null&&<button type="button" onClick={()=>setText(solAmount(balanceLamports).exact.replace(/,/g,''))} disabled={!canCommit}>Max</button>}</div>
  </div>
  {invalid&&<p className="pl-error" id={id+'-hint'}>Enter a SOL amount with up to nine decimals.</p>}
  {est&&!invalid&&<div className="pl-projection" id={id+'-hint'}>
   {already&&<div className="pl-row"><span>Already committed</span><span><ExactAmount amount={solAmount(existingLamports)}/></span></div>}
   <div className="pl-row"><span>Estimated tokens<Help label="Allocation estimate">{HELP.allocation}</Help></span><span><ExactAmount amount={tokenAmount(est.tokensBaseUnits,d,vm.symbol)}/></span></div>
   <div className="pl-row"><span>Estimated accepted SOL</span><span><ExactAmount amount={solAmount(est.acceptedLamports)}/></span></div>
   <div className="pl-row"><span>Estimated excess refundable</span><span><ExactAmount amount={solAmount(est.excessLamports)}/></span></div>
   <p className="pl-note">{already?'For your total of '+solAmount(est.commitLamports).compact+' SOL including this amount. ':''}Provisional: the share follows accepted SOL at settlement, with {solAmount(est.campaignTotalLamports).compact} SOL committed in total after yours.</p>
  </div>}
  {!est&&!invalid&&<p className="pl-help-text" id={id+'-hint'}>{minimum>0n?'The first commitment is at least '+solAmount(String(minimum)).compact+' SOL. ':''}Your estimated allocation appears once you enter an amount.</p>}
  {connected||!canCommit?<button type="submit" className="primary pl-commit-btn" disabled={!!disabledReason} aria-describedby={disabledReason?id+'-why':undefined}>Commit SOL</button>:<button type="button" className="primary pl-commit-btn" onClick={onConnect}>Connect wallet</button>}
  {disabledReason&&(connected||!canCommit)&&<p className="pl-help-text" id={id+'-why'}>{disabledReason}</p>}
 </form>;
}
