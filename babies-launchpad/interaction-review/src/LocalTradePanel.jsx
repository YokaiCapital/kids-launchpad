import {netLabel} from './network-label.mjs';
import {walletForOwner} from './wallet-connection.mjs';
import {useEffect,useRef,useState} from 'react';
import {ArrowsDownUp} from '@phosphor-icons/react';
import {accountApi} from './Account';
import {friendlyError} from './friendly-errors.mjs';
const units=(value,decimals)=>{
 if(!new RegExp('^\\d{1,10}(\\.\\d{1,'+decimals+'})?$').test(value))throw Error('Enter a positive amount with at most '+decimals+' decimals.');
 const [whole,fraction='']=value.split('.'),raw=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0'));
 if(raw<=0n||raw>18446744073709551615n)throw Error('Enter a valid positive amount.');return raw.toString();
};
const display=(raw,decimals)=>raw==null?'—':(Number(raw)/10**decimals).toLocaleString(undefined,{maximumFractionDigits:decimals===9?6:2});
const fmtRaw=(raw,decimals,max)=>raw==null?'—':(Number(BigInt(raw))/10**decimals).toLocaleString('en-GB',{maximumFractionDigits:max});
const rawToInput=(raw,decimals)=>{const s=BigInt(raw).toString().padStart(decimals+1,'0');const whole=s.slice(0,-decimals),frac=s.slice(-decimals).replace(/0+$/,'');return whole+(frac?'.'+frac:'');};
export function LocalTradePanel({owner,campaign,enabled,localExecution,mint,pool,programId,genesisHash,onSignIn,onTraded,wallet=null,network='localnet',tradeFeeBps=null}){
 const net=netLabel(network);
 const solBalance=wallet?.solLamports!=null?BigInt(wallet.solLamports):null,coinBalance=wallet?.coinRaw!=null?BigInt(wallet.coinRaw):null,feeReserve=BigInt(wallet?.feeReserveLamports||'10000000');
 const maxBuy=solBalance!=null?(solBalance>feeReserve?solBalance-feeReserve:0n):null;
 const [side,setSide]=useState('buy'),[amount,setAmount]=useState(''),[quote,setQuote]=useState(null),[busy,setBusy]=useState(false),[attempted,setAttempted]=useState(false),[message,setMessage]=useState(''),[now,setNow]=useState(Date.now());
 const pending=useRef(null),lock=useRef(false),identity=useRef({owner,campaign});identity.current={owner,campaign};
 useEffect(()=>{setQuote(null);setAttempted(false);setMessage('');pending.current=null;},[owner,campaign,side,amount]);
 useEffect(()=>{if(!quote)return;const id=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(id);},[quote]);
 const current=()=>identity.current.owner===owner&&identity.current.campaign===campaign;
 async function act(){
  if(lock.current)return;if(!owner){onSignIn();return;}if(!enabled)return;
  lock.current=true;setBusy(true);setMessage('');
  try{
   const session=await accountApi('state');if(session.owner!==owner||!current())throw Error('Wallet changed. Refresh before trading.');
   if(!quote){
    const next=await accountApi('postlaunch/trade/quote',{campaign,side,amountRaw:units(amount,side==='buy'?9:6),slippageBps:100,requestId:crypto.randomUUID()},session.csrf);
    if(!current())return;
    if(next.owner!==owner||next.campaign!==campaign||next.side!==side||next.inputRaw!==units(amount,side==='buy'?9:6)||next.mint!==mint||next.pool!==pool||next.programId!==programId||next.genesisHash!==genesisHash)throw Error('Quote identity mismatch.');
    setNow(Date.now());setQuote(next);
   }else{
    let result;
    if(localExecution){setAttempted(true);result=await accountApi('postlaunch/trade/execute',{intentId:quote.intentId},session.csrf);}
    else{
     const {Keypair,VersionedTransaction}=await import('@solana/web3.js');
     if(!pending.current)pending.current={intentId:quote.intentId,key:Keypair.generate()};
     const prepared=pending.current;
     if(!prepared.body){
      const next=await accountApi('postlaunch/trade/prepare',{intentId:quote.intentId,wrappedAccount:prepared.key.publicKey.toBase58()},session.csrf);
      if(!current())return;
      const {decodeApprovedTrade}=await import('./trade-signing.mjs'),{assertApprovedMessage}=await import('./escrow-signing.mjs');
      if(next.wrappedAccount!==prepared.key.publicKey.toBase58())throw Error('Temporary account changed');
      const tx=decodeApprovedTrade(Uint8Array.from(atob(next.unsignedTransactionBase64),c=>c.charCodeAt(0)),next,quote),approved=tx.message.serialize();
      const provider=await walletForOwner(owner);if(!current())return;
      tx.sign([prepared.key]);const signed=await provider.signTransaction(tx);
      if(!current()||provider.publicKey?.toString()!==owner)throw Error('Wallet changed before submission');
      const final=VersionedTransaction.deserialize(assertApprovedMessage(signed,approved));final.sign([prepared.key]);let encoded='';for(const b of final.serialize())encoded+=String.fromCharCode(b);
      prepared.body={intentId:quote.intentId,signedTransactionBase64:btoa(encoded)};
     }
     setAttempted(true);result=await accountApi('postlaunch/trade/submit',prepared.body,session.csrf);
    }
    if(!current())return;if(!result.signature)throw Error('Confirmation unavailable. Retry the same transaction.');
    pending.current=null;setQuote(null);setAttempted(false);setMessage({ok:true,title:side==='buy'?'Buy confirmed':'Sell confirmed',detail:'Confirmed '+net.on+'. Your balances update in a moment.',technical:result.signature});onTraded?.();
   }
  }catch(error){if(current()&&error.message==='Quote expired. Request a fresh quote'){pending.current=null;setQuote(null);setAttempted(false);}if(current())setMessage({ok:false,...friendlyError(error.name==='TimeoutError'?'Confirmation timed out. Retry checks the same transaction; do not start another trade.':error,{payWith:side==='buy'?'SOL':'$Shartcoin'})});}finally{lock.current=false;setBusy(false);}
 }
 const expired=quote&&now>=quote.expiresAt,editing=busy||attempted;
 return <div className="post-swap"><div className="post-swap-tabs" role="group" aria-label="Trade direction">{['buy','sell'].map(value=><button key={value} disabled={editing} aria-pressed={side===value} onClick={()=>{setSide(value);setAmount('');}}>{value==='buy'?'Buy':'Sell'}</button>)}</div>
 <label htmlFor="post-trade-amount">You pay <span>{side==='buy'?'SOL':'$Shartcoin'}</span></label><div className="post-amount"><input id="post-trade-amount" inputMode="decimal" placeholder="0.00" autoComplete="off" disabled={editing} value={amount} onChange={e=>{if(/^\d*\.?\d*$/.test(e.target.value))setAmount(e.target.value);}}/><span>{side==='buy'?'SOL':'$Shartcoin'}</span></div>
 <div className="post-balance-line"><span>{owner?'Balance':'Sign in to see your balance'}</span>{owner&&<strong>{wallet?.error?'—':side==='buy'?fmtRaw(solBalance?.toString(),9,4)+' SOL':fmtRaw(coinBalance?.toString(),6,2)+' $Shartcoin'}</strong>}</div>
 {side==='buy'&&<div className="post-quick-amounts">{['0.1','0.5','1'].map(value=><button key={value} disabled={editing} aria-pressed={amount===value} onClick={()=>setAmount(value)}>{value} SOL</button>)}<button disabled={editing||maxBuy==null||maxBuy<=0n} aria-pressed={maxBuy!=null&&amount===rawToInput(maxBuy,9)} onClick={()=>setAmount(rawToInput(maxBuy,9))} title="Everything except 0.01 SOL kept for network fees">Max</button></div>}
 {side==='sell'&&<div className="post-quick-amounts">{[25,50,75,100].map(pct=>{const value=coinBalance!=null&&coinBalance>0n?rawToInput(coinBalance*BigInt(pct)/100n,6):null;return <button key={pct} disabled={editing||value==null} aria-pressed={value!=null&&amount===value} onClick={()=>setAmount(value)}>{pct}%</button>;})}</div>}
 <ArrowsDownUp size={18} className="post-swap-arrow"/><div className="post-receive"><span>You receive</span><strong>{display(quote?.outputRaw,side==='buy'?6:9)} <small>{side==='buy'?'$Shartcoin':'SOL'}</small></strong></div><div className="post-trade-fee"><span>Pool fee / Slippage</span><strong>{tradeFeeBps?(tradeFeeBps/100)+'%':'—'} / 1%</strong></div>
 {quote&&<p>Minimum {display(quote.minOutputRaw,quote.decimalsOut)} {side==='buy'?'$Shartcoin':'SOL'} · {expired?'Quote expired':Math.max(0,Math.ceil((quote.expiresAt-now)/1000))+'s left'}</p>}
 <button className="primary" disabled={busy||!!owner&&!enabled||!!quote&&expired&&!attempted} onClick={act}>{busy?'Confirming…':!owner?(net.live?'Sign in to trade':'Sign in to test'):!enabled?'Trading unavailable':attempted?'Check / retry transaction':quote?(side==='buy'?'Buy '+net.on:'Sell '+net.on):'Get quote'}</button>
 {quote&&!attempted&&!busy&&<button className="text-button" onClick={()=>{setQuote(null);pending.current=null;}}>Refresh quote</button>}<p>{net.live?'Raydium pool. Network fees are additional.':'Local test pool only. Network fees are additional.'}</p>{message&&<div className={'trade-feedback '+(message.ok?'is-ok':'is-problem')} role="status"><strong>{message.title}</strong>{message.detail&&<p>{message.detail}</p>}{message.technical&&<details><summary>{message.ok?'Transaction signature':'Technical details'}</summary><code>{message.technical}</code></details>}</div>}
 </div>;
}
