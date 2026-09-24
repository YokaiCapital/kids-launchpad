import {formatUtc} from './launch-status.mjs';
import {netLabel} from './network-label.mjs';
import {walletForOwner} from './wallet-connection.mjs';
import {friendlyError} from './friendly-errors.mjs';
import {useEffect,useRef,useState} from 'react';
import {ArrowRight} from '@phosphor-icons/react';
import {accountApi} from './Account';
import {chainAllocation,parseCommitment,validatePrelaunchState} from './prelaunch-chain';
import {sol} from './prelaunch';
export function usePrelaunchChain(owner,endpoint='prelaunch'){
 const [snapshot,setSnapshot]=useState(null),[error,setError]=useState(''),[tick,setTick]=useState(0);
 // Polling: 15 s plus jitter so many tabs never line up, paused while the tab is hidden, one read when it comes back.
 useEffect(()=>{let active=true,timer;const delay=()=>15000+Math.floor(Math.random()*5000);
  async function read(){if(!active)return;if(typeof document!=='undefined'&&document.visibilityState==='hidden'){timer=setTimeout(read,delay());return;}try{const data=validatePrelaunchState(await accountApi(endpoint));if(active){setSnapshot({owner,data});setError('');}}catch(e){if(active)setError(e.message);}finally{if(active)timer=setTimeout(read,delay());}}
  const onVisible=()=>{if(document.visibilityState==='visible'){clearTimeout(timer);read();}};document.addEventListener?.('visibilitychange',onVisible);
  read();return()=>{active=false;clearTimeout(timer);document.removeEventListener?.('visibilitychange',onVisible);};},[owner,tick,endpoint]);
 return {data:snapshot?.owner===owner?snapshot.data:null,error,refresh:()=>setTick(n=>n+1),accept:data=>{setSnapshot({owner,data:validatePrelaunchState(data)});setError('');}};
}
const base64=bytes=>{let text='';for(const byte of bytes)text+=String.fromCharCode(byte);return btoa(text);};
export function LocalCommitPanel({chain,identity,onSignIn,endpoint='prelaunch',refundOnly=false,onOpenCoin=null}){
 const net=netLabel(chain?.data?.network);
 const [amount,setAmount]=useState('1'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[receipt,setReceipt]=useState(null),[phase,setPhase]=useState('');
 const pending=useRef(null),state=chain.data,owner=identity?.owner;
 const committed=BigInt(state.user?.committedLamports||'0'),refundable=BigInt(state.user?.refundableLamports||'0');
 let added,estimate;try{added=parseCommitment(amount);estimate=chainAllocation(state,added);}catch{}
 const open=!refundOnly&&state.phase==='open'&&Date.now()<state.deadlineUnix*1000;
 useEffect(()=>{setReceipt(null);setError('');pending.current=null;},[owner]);
 async function transact(action){
  if(busy)return;if(!owner){onSignIn();return;}
  setBusy(true);setError('');setPhase('Preparing transaction…');
  try{
   const session=await accountApi('state');if(session.owner!==owner)throw Error('Wallet account changed. Sign in again.');
   const key=JSON.stringify([owner,action,action==='commit'?added?.toString():null]);
   if(!pending.current||pending.current.key!==key)pending.current={key,requestId:crypto.randomUUID()};
   const intent=await accountApi(endpoint+'/prepare',{action,requestId:pending.current.requestId,...(action==='commit'?{amountLamports:added.toString()}: {})},session.csrf);
   if(!intent.intentId||intent.owner!==owner||intent.genesisHash!==state.genesisHash)throw Error('Escrow network or wallet changed. Refresh before signing.');
   let body={intentId:intent.intentId,local:true};
   if(!intent.local){
    setPhase('Approve in your wallet…');
    const provider=await walletForOwner(owner);
    const {decodeApprovedEscrow,assertApprovedMessage}=await import('./escrow-signing.mjs');
    const bytes=Uint8Array.from(atob(intent.unsignedTransactionBase64),c=>c.charCodeAt(0));
    const transaction=decodeApprovedEscrow(bytes,{owner,programId:state.programId,campaign:state.escrowAddress,action});
    const approved=transaction.message.serialize().slice();
    const signed=await provider.signTransaction(transaction);
    body={intentId:intent.intentId,signedTransactionBase64:base64(assertApprovedMessage(signed,approved))};
   }
   setPhase('Confirming '+net.on+'…');
   const result=await accountApi(endpoint+'/submit',body,session.csrf);
   if(!result.signature)throw Error('Transaction confirmation is unavailable. Refresh before retrying.');
   setReceipt({owner,signature:result.signature,action,amountLamports:action==='commit'?added.toString():null,at:Date.now()});pending.current=null;
   chain.accept(result.state);if(action==='commit')setAmount('');
  }catch(e){setError(e.name==='TimeoutError'?'Confirmation timed out. Refresh escrow before retrying; the transaction may have landed.':e.message);chain.refresh();}finally{setBusy(false);setPhase('');}
 }
 return <><p className="eyebrow">{net.name.toUpperCase()} ESCROW</p><h2>{refundOnly?'Earlier test escrow':open?'Commit SOL for Shartcoin':state.phase==='failed'?'Your SOL is refundable':state.phase==='awaiting-launch'?'Funding closed':'Your launch allocation'}</h2>
 <p className="small muted">{refundOnly?`Refunds follow the original close time: ${formatUtc(state.deadlineUnix)}`:open?`Closes ${formatUtc(state.deadlineUnix)}`:state.phase==='failed'?'Funding or launch requirements were not met. Full refunds are available.':state.phase==='awaiting-launch'?'Allocations are fixed. Pool launch is pending.':state.phase==='open'?'Commitments closed. Awaiting settlement.':onOpenCoin?'The pool is live. Trading and claims are on the coin page.':'Pool launched.'}</p>
 {open&&<><label>Commitment amount · SOL<input inputMode="decimal" value={amount} disabled={busy} onChange={e=>{setAmount(e.target.value);setError('');}} aria-label="Commitment amount in SOL"/></label><div className="amount-presets">{['1','5','10'].map(n=><button key={n} disabled={busy} onClick={()=>setAmount(n)}>{n} SOL</button>)}</div></>}
 <div className="your-split"><div><span>{open?'Estimated allocation':'Your allocation'}</span><small>{sol(committed)} SOL committed</small></div><div className="personal-values"><span>Into pool<strong>{Number(sol(open?(estimate||chainAllocation(state)).retained:BigInt(state.user?.acceptedLamports||'0'))).toLocaleString('en-GB',{maximumFractionDigits:4})} SOL</strong></span><span>{open?'Excess refund':'Refund available'}<strong>{Number(sol(open?(estimate||chainAllocation(state)).refund:refundable)).toLocaleString('en-GB',{maximumFractionDigits:4})} SOL</strong></span></div><small>{open?'Includes entered amount · final allocation at close':'Refunded: '+sol(BigInt(state.user?.refundedLamports||'0'))+' SOL'}</small></div>
 {onOpenCoin&&state.phase==='launched'&&<><button className="primary rail-trade" onClick={onOpenCoin}>Trade and claim <ArrowRight size={18}/></button>{!owner?<button className="text-button rail-signin" onClick={onSignIn}>Sign in to see your allocation</button>:refundable>0n?<button className="outlined rail-refund" disabled={busy||!!chain.error} onClick={()=>transact('refund')}>{busy?phase:'Claim excess refund'}</button>:<p className="small muted">{committed>0n?'Your coins are on the coin page.':'No commitment from this wallet.'}</p>}</>}
 {onOpenCoin&&state.phase==='launched'?null:!owner?<button className="primary" onClick={onSignIn}>{open?'Sign in to participate':state.phase==='failed'?'Sign in to check your refund':'Sign in to see your allocation'}</button>:open?<button className="primary" disabled={busy||!!chain.error||!estimate} onClick={()=>transact('commit')}>{busy?phase:'Commit SOL'}</button>:refundable>0n?<button className="primary" disabled={busy||!!chain.error} onClick={()=>transact('refund')}>{busy?phase:'Claim refund'}</button>:<p className="small muted">{committed===0n?'No commitment from this wallet.':state.phase==='failed'?'Refund already processed.':'No refund available.'}</p>}
 {(error||chain.error)&&(()=>{const f=friendlyError(error||chain.error,{payWith:'SOL'});return <div className="trade-feedback is-problem" role="alert"><strong>{f.title}</strong>{f.detail&&<p>{f.detail}</p>}{f.technical&&<details><summary>Technical details</summary><code>{f.technical}</code></details>}</div>;})()}
 {!!receipt&&!!owner&&receipt.owner===owner&&<div className="commit-confirmed" role="status" aria-live="polite"><strong>{receipt.action==='commit'?'Commitment confirmed':'Refund confirmed'}</strong>
  <p>{receipt.action==='commit'?`${sol(BigInt(receipt.amountLamports||'0'))} SOL is in escrow ${net.on}.`:'Your SOL is back in your wallet '+net.on+'.'}</p>
  {receipt.action==='commit'&&<p>{open?`Funding closes ${formatUtc(state.deadlineUnix)}. If the soft cap is met, the launch runs by itself and your allocation appears here.`:'Funding is closed. Settlement and launch run by themselves.'}</p>}
  <details className="escrow-receipt"><summary>Transaction signature</summary><code>{receipt.signature}</code></details></div>}
 <button className="text-button" disabled={busy} onClick={chain.refresh}>Refresh escrow</button></>;
}

export function LegacyEscrow({identity,onSignIn}){
 const chain=usePrelaunchChain(identity?.owner||null,'prelaunch-legacy');
 if(!identity?.owner||!chain.data?.configured||BigInt(chain.data.user?.committedLamports||'0')===0n)return null;
 return <details className="launch-details"><summary>Earlier local test commitments</summary><LocalCommitPanel chain={chain} identity={identity} onSignIn={onSignIn} endpoint="prelaunch-legacy" refundOnly/></details>;
}
