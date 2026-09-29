import {CheckCircle,CircleNotch,WarningCircle,Wallet} from '@phosphor-icons/react';
import {transactionCopy} from './campaign-adapter.mjs';
/**
 * TransactionStatus (spec §12 table). Presentational: the state comes from the durable transaction store, the copy
 * from the adapter. `result` is the actual asset movement to show once confirmed; `signature` folds under Details.
 * Nothing here submits anything; the callbacks belong to the caller.
 */
export function TransactionStatus({state='idle',action='Transaction',reason=null,result=null,signature=null,explorerUrl=null,onPrimary,onSecondary,onCancel}){
 const c=transactionCopy(state,{action,reason});
 if(!c.title)return null;
 const Icon=c.tone==='ok'?CheckCircle:c.tone==='problem'?WarningCircle:state==='wallet'?Wallet:CircleNotch;
 return <div className={'pl-tx is-'+c.tone} role={c.tone==='problem'?'alert':'status'} aria-live={c.tone==='problem'?'assertive':'polite'} aria-busy={c.busy}>
  <Icon size={20} weight={c.tone==='ok'?'fill':'bold'} aria-hidden="true"/>
  <div className="pl-tx-body">
   <strong>{c.title}</strong>
   {result&&<p>{result}</p>}
   {c.note&&<p>{c.note}</p>}
   {(signature||c.primary||c.secondary)&&<div className="pl-tx-actions">
    {c.primary&&onPrimary&&<button type="button" className="pl-btn-sm" onClick={onPrimary}>{c.primary}</button>}
    {c.secondary==='Cancel'&&onCancel&&<button type="button" className="pl-btn-sm pl-quiet" onClick={onCancel}>Cancel</button>}
    {c.secondary==='View on explorer'&&explorerUrl&&<a className="pl-btn-sm" href={explorerUrl} target="_blank" rel="noreferrer noopener">View on explorer</a>}
    {c.secondary==='Details'&&signature&&<details><summary className="pl-small">Details</summary><span className="pl-mono pl-small">{signature}</span></details>}
    {c.secondary==='Details'&&!signature&&onSecondary&&<button type="button" className="pl-btn-sm pl-quiet" onClick={onSecondary}>Details</button>}
   </div>}
  </div>
 </div>;
}
