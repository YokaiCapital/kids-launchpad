import {useEffect,useRef,useState} from 'react';
import {accountApi} from '../Account';
import {walletForOwner} from '../wallet-connection.mjs';
import {createCreatorController} from './creator-controller.mjs';
import {Pfp} from './CoinMedia';
import {solAmount,formatUtc} from './campaign-adapter.mjs';
const labels={launch:'Create your coin',reservation:'Reserve your coin address',publication:'Publish approved artwork and metadata',mint:'Create your token', 'setup-plan':'Prepare the reviewed launch terms','native-custody':'Prepare SOL custody','create-campaign':'Create your campaign',registration:'Verify and register your campaign','operating-reserve':'Fund the operating reserve',complete:'Campaign registered'};
export function CreatorJourney({owner,request,onBack,onOpenCoin}){
 const [state,setState]=useState({busy:true}),[refreshing,setRefreshing]=useState(false),[auto,setAuto]=useState(true),controller=useRef(null),current=useRef(owner);current.current=owner;
 useEffect(()=>{
  let active=true;const c=createCreatorController({owner,request,api:accountApi,wallet:walletForOwner,currentOwner:()=>current.current,onChange:s=>{if(active)setState(s);},network:import.meta.env.VITE_KIDS_NETWORK||'localnet',release:import.meta.env.VITE_KIDS_RELEASE_PROGRAM_ID?{programId:import.meta.env.VITE_KIDS_RELEASE_PROGRAM_ID,genesisHash:import.meta.env.VITE_KIDS_RELEASE_GENESIS_HASH,treasury:import.meta.env.VITE_KIDS_RELEASE_TREASURY}:null});controller.current=c;c.refresh().catch(()=>{});
  const timer=setInterval(()=>{if(!document.hidden&&!c.getState().busy&&!c.getState().offer&&c.getState().snapshot?.result?.action!=='review-schedule')c.refresh({background:true}).catch(()=>{});},1000);
  return()=>{active=false;clearInterval(timer);c.dispose();controller.current=null;};
 },[owner,request.id]);
 const act=async name=>{setRefreshing(true);try{await controller.current?.[name]();}catch{/* Controller keeps an explicit pending/error state. */}finally{setRefreshing(false);}};
 // One click (owner, 28 September 2026): the journey runs itself, server stages and wallet approvals in turn, and stops
 // only for an error, a delayed response, a recovery decision or operator support. Continue resumes it.
 useEffect(()=>{
  const c=controller.current;if(!auto||!c||state.busy||refreshing||state.error||c.hasHeldApproval())return;
  // A slow answer without a held approval is not a stop: the status is re-read after a moment and the run goes on.
  if(state.uncertain){const t=setTimeout(()=>act('refresh'),3000);return()=>clearTimeout(t);}
  const s=state.snapshot,o=state.offer;
  if(!s||s.action==='support'||s.action==='recover'||s.result?.action==='review-schedule')return;
  if(o){act('approve');return;}
  if(s.serverManaged&&s.serverWork!=='wallet')return;
  if(['prepare','resume'].includes(s.action)){
   if(s.stage==='publication'&&s.result?.status==='pending'){const timer=setTimeout(()=>act('advance'),1000);return()=>clearTimeout(timer);}
   act('advance');
  }
 },[auto,state.updatedAt,state.busy,state.error,state.uncertain,refreshing]);
 const s=state.snapshot,o=state.offer,stage=o?.stage||s?.stage,busy=state.busy||refreshing,held=controller.current?.hasHeldApproval(),needsRecovery=s?.action==='recover'||s?.result?.action==='review-schedule';
 const one=s?.creationMode==='single'||stage==='launch'||Object.hasOwn(s?.signatures||{},'launch');
 // Keep internal provisioning steps out of the creator experience.
 const approvals=one?['launch']:['mint','native-custody','create-campaign','operating-reserve'],approved=approvals.filter(k=>s?.signatures?.[k]).length,finished=stage==='complete'||s?.action==='none'&&approved===approvals.length;
 // On the one-transaction path the coin exists once that transaction is confirmed (seconds after the approval); the
 // finality wait, the registration and the reserve record are bookkeeping the creator no longer has to watch.
 const created=one&&!finished&&(['registration','operating-reserve'].includes(s?.stage)||s?.stage==='launch'&&(['confirmed','finalized'].includes(s?.state)||s?.result?.reason==='awaiting-finality'||s?.confirmation?.commitment==='confirmed'));
 const headline=(state.error||s?.serverWork==='paused'&&!s?.activationReady)?'Launch needs attention.':finished&&s?.activationReady?'Your coin is ready.':finished?'Your coin is created.':state.uncertain?'Waiting for the network…':o?'Approve in your wallet.':created?'Your coin is created. Finishing the records…':'Launching…';
 return <section className="pl pl-creator" aria-labelledby="creator-heading">
  <div className="pl-head"><div><span className="pl-pill is-muted">{import.meta.env.VITE_KIDS_NETWORK==='localnet'?'Private localnet setup':'Creating your coin'}</span><h1 id="creator-heading">{request.body.draft.name}</h1><p>{finished?(s?.activationReady?'Your launch is scheduled. Open your coin to follow funding.':'Your coin is confirmed. Preparing funding automatically.'):one?'One wallet approval creates your coin.':'Preparing your coin for wallet approval.'}</p></div><button type="button" className="pl-quiet" onClick={onBack}>My launches</button></div>
  <div className="pl-creator-layout">
   <div className="pl-panel pl-creator-main" aria-busy={busy}>
    {(created||finished)&&<div className="pl-created-identity"><Pfp src={request.body.draft.pfp?.url} name={request.body.draft.name} size={72}/><div><span className="pl-pill">Created</span><h2>{request.body.draft.name} <span className="pl-muted">${request.body.draft.symbol}</span></h2></div></div>}
    <h2 role="status">{headline}</h2>
    {(created||finished)&&<><p>{request.body.draft.description}</p><p className="pl-help-text">Your transaction is confirmed. You can leave this page; setup continues automatically.</p><div className="pl-creator-addresses"><span>Coin address</span><code>{s.mint}</code></div>{finished&&<button className="primary" type="button" onClick={()=>onOpenCoin?.(s.campaign)}>Open your coin</button>}</>}
    {!state.error&&!state.uncertain&&!finished&&<p className="pl-lead">{created?'Recording your launch…':o?'Confirm the launch in your wallet.':stage==='publication'?'Preparing your artwork…':'Preparing your launch…'}</p>}
    {(state.error||state.uncertain||s?.serverWork==='paused'&&!s?.activationReady)&&<p role="alert" className="pl-creator-warning">{stage==='publication'?'Artwork is taking longer than expected. No wallet approval has been requested.':held?'Your approval is saved. Retry to check and send the same transaction.':'We could not finish this request. Retry to check your saved launch.'}</p>}
    {o&&<details aria-label="Wallet approval details" className="pl-rows"><summary>Launch details</summary>
     <div className="pl-row"><span>Approval</span><strong>{labels[o.stage]}</strong></div>
     <div className="pl-row"><span>Coin</span><strong>{request.body.draft.name} · ${request.body.draft.symbol}</strong></div>
     {(o.stage==='mint'||o.stage==='launch')&&<><div className="pl-row"><span>Supply</span><strong>1,000,000,000 · 6 decimals</strong></div><div className="pl-row"><span>Mint and freeze authority</span><strong>Revoked</strong></div></>}
     {o.stage==='launch'&&<><div className="pl-row"><span>Caps</span><strong>{solAmount(o.verification.launch.policy.softCapLamports).exact} / {solAmount(o.verification.launch.policy.hardCapLamports).exact} SOL</strong></div><div className="pl-row"><span>Funding opens</span><strong>{o.verification.launch.opensAt==='0'?'As soon as it is created':formatUtc(Number(o.verification.launch.opensAt))+' UTC'}</strong></div><div className="pl-row"><span>Setup budget for the pool</span><strong>{solAmount(o.verification.launch.authorityBudgetLamports).exact} SOL</strong></div><div className="pl-row"><span>Operating reserve</span><strong>{solAmount(o.verification.launch.reserve.lamports).exact} SOL</strong></div></>}
     {o.stage==='create-campaign'&&<><div className="pl-row"><span>Caps</span><strong>{solAmount(o.scope.softCapLamports).exact} / {solAmount(o.scope.hardCapLamports).exact} SOL</strong></div><div className="pl-row"><span>Funding opens (UTC)</span><strong>{formatUtc(Number(o.scope.opensAt))}</strong></div><div className="pl-row"><span>Pool-initialization reserve</span><strong>{solAmount(o.scope.authorityBudgetLamports).exact} SOL</strong></div><p className="pl-help-text">This reserve excludes ongoing keeper operations. Creation does not enable participant funding.</p></>}
     {o.stage==='operating-reserve'&&<><div className="pl-row"><span>Operating reserve</span><strong>{solAmount(o.verification.lamports).exact} SOL</strong></div><div className="pl-row"><span>Keeper wallet</span><code>{o.verification.payer}</code></div><p className="pl-help-text">One transfer from your wallet to the keeper wallet, bound to this campaign by a memo. It pays settlement, launch, refunds and fee cycles; after launch the coin’s own treasury fee share refills it. Unused reserve returns to you if the launch ends in refunds.</p></>}
     <details className="pl-creator-addresses"><summary>Addresses and permanent metadata</summary>{[['Mint',s.mint],['Campaign',s.campaign],['Program',o.scope.programId],['Treasury',o.scope.treasury],...(o.stage==='operating-reserve'?[]:[['Metadata',(o.stage==='mint'||o.stage==='launch'?o.verification:o.verification.mint).metadata.uri]])].map(([label,value])=><div key={label}><span>{label}</span><code>{value}</code></div>)}</details>
     <p className="pl-help-text">Wallet rent and network fees are additional. Review the wallet simulation before signing.</p>
    </details>}
    {s?.signatures&&Object.entries(s.signatures).some(([,v])=>v)&&<details className="pl-creator-addresses"><summary>Recorded transactions</summary>{Object.entries(s.signatures).filter(([,v])=>v).map(([k,v])=><div key={k}><span>{labels[k]}</span><code>{v}</code></div>)}</details>}
    <div className="pl-creator-actions">
     {(state.error||state.uncertain||needsRecovery||s?.serverWork==='paused'&&!s?.activationReady)&&<button type="button" className="primary" disabled={busy} onClick={()=>{setAuto(true);act(held?'resubmit':needsRecovery?'recover':s?.serverWork==='paused'&&!s?.activationReady?'advance':'refresh');}}>{busy?'Checking…':'Try again'}</button>}
    </div>
    {s?.action==='support'&&<p className="pl-creator-warning">This request needs operator review. Its mint and approvals are preserved; do not create a replacement launch.</p>}
    <details className="pl-creator-addresses"><summary>Support details</summary><p className="pl-help-text">Request {request.id}</p>{state.error&&<p className="pl-help-text">{state.error}</p>}</details>
   </div>
  </div>
 </section>;
}
