import {useId,useState,useEffect} from 'react';
import {ExactAmount} from './ExactAmount';
import {solAmount,tokenAmount,exactDecimal} from './campaign-adapter.mjs';
import {Help} from '../Help';
import {parseTradeAmount} from './trade-form.mjs';
export function TradeForm({vm,clock=()=>Date.now()/1000,wallet,position,onConnect,trade}){
 const id=useId(),[draftSide,setSide]=useState('buy'),[amount,setAmount]=useState(''),[slippage,setSlippage]=useState('10');
 const quote=trade?.quote?.campaignId===vm.id?trade.quote:null,side=quote?.side??draftSide,decimals=vm.terms.supply.decimals,raw=parseTradeAmount(amount,side==='buy'?9:decimals),bps=parseTradeAmount(slippage,2);
 const slipValid=bps!=null&&BigInt(bps)<=5000n,expired=quote&&clock()*1000>=quote.expiresAt,working=trade?.working===true,locked=working||!!quote||trade?.blocked;
 const [,refresh]=useState(0);useEffect(()=>{if(!quote)return;const timer=setInterval(()=>refresh(n=>n+1),1000);return()=>clearInterval(timer);},[quote?.intentId]);
 const pay=side==='buy'?'SOL':'$'+vm.symbol,receive=side==='buy'?'$'+vm.symbol:'SOL',balance=side==='buy'?wallet?.balanceLamports:position?.walletTokensBaseUnits;
 const format=(value,output=false)=>((output?side==='sell':side==='buy')?solAmount(value):tokenAmount(value,decimals,vm.symbol));
 const enabled=!!trade?.prepare;
 return <section className="pl-panel pl-trade" aria-labelledby={id+'-h'} aria-busy={working}>
  <div className="pl-panel-head"><h3 className="pl-label" id={id+'-h'}>Trade {vm.name}</h3><div className="pl-trade-switch" role="group" aria-label="Trade direction">{['buy','sell'].map(s=><button key={s} type="button" aria-pressed={side===s} disabled={locked} onClick={()=>{setSide(s);setAmount('');}}>{s==='buy'?'Buy':'Sell'}</button>)}</div></div>
  <div className="pl-balance"><label htmlFor={id+'-amount'}>You pay</label><span>Balance {balance!=null?<ExactAmount amount={format(balance)}/>:<span>—</span>}</span></div>
  <div className="pl-amount"><input id={id+'-amount'} value={quote?exactDecimal(quote.inputRaw,quote.decimalsIn).replaceAll(',',''):amount} inputMode="decimal" autoComplete="off" placeholder="0.00" disabled={locked||!enabled} onChange={e=>setAmount(e.target.value)} aria-invalid={!!amount&&!raw||undefined}/><span>{pay}</span></div>
  {side==='buy'&&<div className="pl-trade-presets">{['0.1','0.5','1'].map(v=><button type="button" key={v} disabled={locked||!enabled} onClick={()=>setAmount(v)}>{v} SOL</button>)}</div>}
  <div className="pl-row pl-trade-settings"><label htmlFor={id+'-slippage'}>Slippage<Help label="Slippage">The maximum price movement you accept between quote and execution. The transaction enforces a minimum receive amount. Higher settings can produce worse execution.</Help></label><span><input id={id+'-slippage'} aria-label="Slippage percent" inputMode="decimal" value={quote?String(quote.slippageBps/100):slippage} onChange={e=>setSlippage(e.target.value)} disabled={locked} aria-invalid={!slipValid||undefined}/>%</span></div>
  {!slipValid&&<p className="pl-error">Choose slippage between 0.01% and 50%.</p>}
  {quote&&<div className="pl-trade-quote" aria-live="polite"><div className="pl-row"><span>Estimated receive</span><strong><ExactAmount amount={format(quote.outputRaw,true)}/></strong></div><div className="pl-row"><span>Minimum receive<Help label="Minimum receive">The swap fails if it cannot deliver this amount. Network fees may still apply to a failed transaction.</Help></span><span><ExactAmount amount={format(quote.minOutputRaw,true)}/></span></div><div className="pl-row"><span>Pool fee · included</span><span>{Number(quote.tradeFeeRate)/10000}%</span></div><p className="pl-help-text" aria-live="off">{expired?'Quote expired. Get a fresh quote before signing.':'Quote expires in '+Math.max(0,Math.ceil((quote.expiresAt-clock()*1000)/1000))+'s. Network fees are additional.'}</p></div>}
  {!wallet?<button className="primary pl-commit-btn" type="button" onClick={onConnect}>Connect wallet</button>:quote?<><button className="primary pl-commit-btn" type="button" disabled={working||expired} onClick={trade.sign}>{working?'Awaiting transaction':side==='buy'?'Confirm buy':'Confirm sell'}</button><button className="pl-btn-sm pl-trade-cancel" type="button" disabled={working} onClick={trade.cancel}>{expired?'Discard expired quote':'Edit trade'}</button></>:<button className="primary pl-commit-btn" type="button" disabled={!enabled||!raw||!slipValid||locked} onClick={()=>trade.prepare({side,amountRaw:raw,slippageBps:Number(bps)})}>{working?'Getting quote':'Get quote'}</button>}
  {!enabled&&<p className="pl-help-text">Trading is not enabled on this service.</p>}{trade?.blocked&&!quote&&<p className="pl-help-text">Finish checking your pending transaction before starting another.</p>}{!quote&&enabled&&<p className="pl-help-text">Review the amount of {receive} and fees before approving in your wallet.</p>}
 </section>;
}
