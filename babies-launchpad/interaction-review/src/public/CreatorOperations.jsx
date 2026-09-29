import {useEffect,useRef,useState} from 'react';
import {solAmount} from './campaign-adapter.mjs';
import {ExactAmount} from './ExactAmount';
import {DataFreshness} from './DataFreshness';
const STATES={
 'not-scheduled':['Automation not scheduled','Setup is registered. Launch automation still needs its operating-funding and activation checks.'],
 reconciling:['Checking a transaction','A submitted transaction is unresolved. Its reserve stays held while the worker checks the chain. Do not submit a replacement.'],
 'needs-attention':['Operations need attention','A background task needs review. This does not mean your coins or participant funds are lost.'],
 'funding-needed':['Operating reserve needs funding','A background task is waiting for its operating reserve. Participant commitments are not used to pay it.'],
 'funding-low':['Operating reserve is low','The available reserve is below the floor. Background work still runs, but it needs a refill or a top-up before it runs out. Pending refills are not available yet.'],
 working:['Operations running','Background work is in progress.'],
 scheduled:['Operations scheduled','Background work is queued. Some tasks intentionally wait until their next scheduled time.'],
 idle:['No pending operations','No pending background tasks were recorded at this check. This is not a guarantee of future worker availability.']
};
export function CreatorOperations({campaignId,owner,onRead}){
 const [open,setOpen]=useState(false),[data,setData]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(null);const generation=useRef(0);
 useEffect(()=>{generation.current++;setOpen(false);setData(null);setError(null);setBusy(false);return()=>{generation.current++;};},[campaignId,owner]);
 async function read(){const run=++generation.current;setBusy(true);setError(null);try{const result=await onRead(campaignId);if(run!==generation.current)return;if(result.owner!==owner||result.campaignId!==campaignId||result.readOnly!==true||!STATES[result.status])throw Error('Launch operations identity changed');setData(result);}catch{if(run===generation.current){setData(null);setError('Operations could not be checked. Try again.');}}finally{if(run===generation.current)setBusy(false);}}
 const state=data&&STATES[data.status];
 return <details className="pl-launch-operations" open={open} onToggle={e=>{const next=e.currentTarget.open;if(next===open)return;setOpen(next);if(next&&!data&&!busy)read();}}>
  <summary>Launch operations</summary>
  <div className="pl-operation-body">
   <div className="pl-row"><strong>{busy?'Checking operations…':state?.[0]||'Operations'}</strong><button type="button" className="pl-btn-sm" disabled={busy} onClick={read}>Refresh</button></div>
   {error&&<p className="pl-error" role="alert">{error}</p>}
   {data&&<><p className="pl-small pl-muted">{state[1]}</p><DataFreshness fetchedAtUnix={Date.parse(data.observedAt)/1000} staleAfterSeconds={60}/>
    <dl className="pl-operation-funds">{[['Available now','availableLamports'],['Reserved for pending transactions','heldLamports'],['Spent on operations','spentLamports'],['Floor','floorLamports']].map(([name,key])=><div key={key}><dt>{name}</dt><dd><ExactAmount amount={solAmount(data.operating[key])}/></dd></div>)}</dl>
    {data.refills&&<dl className="pl-operation-funds"><div><dt>Pending refills (not paid yet)</dt><dd><ExactAmount amount={solAmount(data.refills.pendingLamports)}/></dd></div>{BigInt(data.refills.awaitingTransferLamports||'0')>0n&&<div><dt>Of which prepared for the treasury transfer</dt><dd><ExactAmount amount={solAmount(data.refills.awaitingTransferLamports)}/></dd></div>}<div><dt>Refilled so far</dt><dd><ExactAmount amount={solAmount(data.refills.fundedLamports)}/></dd></div></dl>}
    <p className="pl-small pl-muted">{data.operating.recorded?'Operating costs only. Available is the actual reserve; pending refills are booked from this coin’s fee share and arrive only after the treasury’s owner sends the prepared transfer. Separate from commitments, claimable tokens, refunds and dev earnings.':'No operating funding has been recorded for this launch.'}</p>
   </>}
  </div>
 </details>;
}
