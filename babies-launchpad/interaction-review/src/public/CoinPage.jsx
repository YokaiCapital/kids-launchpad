import {useEffect,useRef,useState} from 'react';
import {ArrowLeft,ShareNetwork,Check} from '@phosphor-icons/react';
import {solAmount,tokenAmount,exactDecimal,formatUtc} from './campaign-adapter.mjs';
import {CoinIdentity} from './CoinIdentity';
import {CoinMedia} from './CoinMedia';
import {FundingSummary} from './FundingSummary';
import {CommitForm} from './CommitForm';
import {PersonalPosition} from './PersonalPosition';
import {ClaimsSummary} from './ClaimsSummary';
import {CampaignTerms} from './CampaignTerms';
import {ExactAmount,CopyButton} from './ExactAmount';
import {TransactionStatus} from './TransactionStatus';
import {DataFreshness} from './DataFreshness';
import {TradeForm} from './TradeForm';
import {CampaignActivity} from './CampaignActivity';
import {CampaignMarket} from './CampaignMarket';
const TABS=['Overview','Updates','Activity','Details'];
function ShareButton({url,name}){
 const [done,setDone]=useState(false);
 useEffect(()=>{if(!done)return;const id=setTimeout(()=>setDone(false),1500);return()=>clearTimeout(id);},[done]);
 return <button type="button" className="pl-btn-sm" aria-label={'Share '+name} onClick={async()=>{try{if(navigator.share)await navigator.share({title:name,url});else{await navigator.clipboard.writeText(url);setDone(true);}}catch{}}}>{done?<Check size={16} weight="bold" aria-hidden="true"/>:<ShareNetwork size={16} aria-hidden="true"/>} {done?'Link copied':'Share'}</button>;
}
/** Live metrics (spec §8): price, FDV, liquidity, volume with one freshness label; quiet pool is not an outage. */
function LiveMetrics({vm}){
 const m=vm.market,d=vm.terms.supply.decimals;
 if(!m)return <section className="pl-panel" aria-label="Market"><h3 className="pl-label">Market</h3><p className="pl-small pl-muted">Market data unavailable. The pool may be fine; the market route did not answer.</p></section>;
 const noTrades=m.tradeCount!=null&&BigInt(m.tradeCount)===0n;
 return <section className="pl-panel" aria-label="Market">
  <div className="pl-panel-head"><h3 className="pl-label" style={{margin:0}}>Market</h3>{m.asOfUnix!=null&&<DataFreshness fetchedAtUnix={m.asOfUnix} staleAfterSeconds={120}/>}</div>
  <div className="pl-metrics">
   <div><span>Price</span><strong>{m.priceLamportsPerToken!=null?<><ExactAmount amount={{compact:exactDecimal(m.priceLamportsPerToken,9),exact:exactDecimal(m.priceLamportsPerToken,9),unit:'SOL'}} unit={false}/><small>SOL</small></>:'—'}</strong></div>
   <div><span>FDV</span><strong>{m.fdvLamports!=null?<><ExactAmount amount={solAmount(m.fdvLamports)} unit={false}/><small>SOL</small></>:'—'}</strong></div>
   <div><span>Liquidity</span><strong>{m.liquidityLamports!=null?<><ExactAmount amount={solAmount(m.liquidityLamports)} unit={false}/><small>SOL</small></>:'—'}</strong></div>
   <div><span>Volume 24h</span><strong>{m.volume24hLamports!=null?<><ExactAmount amount={solAmount(m.volume24hLamports)} unit={false}/><small>SOL</small></>:'—'}</strong></div>
  </div>
  <p className="pl-help-text">{noTrades?'No trades yet. The price shown is the opening reference price.':m.lastTradeUnix!=null?'Last trade '+formatUtc(m.lastTradeUnix)+'.':''}{m.tradeCount!=null&&!noTrades?' '+Number(m.tradeCount).toLocaleString('en-GB')+' trades.':''}</p>
 </section>;
}
/**
 * CoinPage (spec §5, §8): one canonical URL per campaign. Main column: funding (or market when live), media, tabs.
 * Rail: identity, commit form (or trade/claims when live), personal position. Under 1180 px the two containers
 * dissolve (display: contents) so the mobile order is identity → funding → form → position → media → tabs.
 */
export function CoinPage({vm,clock,go,wallet,position,source,onConnect,onCommit,onClaim,transaction,busy=false,onCheck,accountError,trade}){
 const [tab,setTab]=useState('Overview');
 const marketRef=useRef(null),claimsRef=useRef(null),tradeRef=useRef(null);
 const railRef=useRef(null);const [tall,setTall]=useState(false);
 useEffect(()=>{const el=railRef.current;if(!el)return;const check=()=>setTall(el.scrollHeight>window.innerHeight-32);check();const observer=typeof ResizeObserver==='function'?new ResizeObserver(check):null;observer?.observe(el);window.addEventListener('resize',check);return()=>{observer?.disconnect();window.removeEventListener('resize',check);};},[vm.id]);
 const live=vm.phase==='live',connected=!!wallet;
 const url=typeof location!=='undefined'?location.origin+location.pathname+'#coin/'+encodeURIComponent(vm.id):'';
 return <section className="pl pl-wide" aria-labelledby="pl-coin-h">
  <button type="button" className="pl-crumb" onClick={()=>go('Explore')}><ArrowLeft size={16} aria-hidden="true"/> Explore</button>
  <div className="pl-coin-head"><h1 id="pl-coin-h">{vm.name}<span>{vm.symbol?'$'+vm.symbol:''}</span></h1><ShareButton url={url} name={vm.name}/></div>
  <div className="pl-coin">
   <div className="pl-coin-main">
    <div className="pl-o-funding" ref={marketRef}>{live?<><CampaignMarket vm={vm} owner={!wallet?.fixture?wallet?.address:null} enabled={source?.manifest?.capabilities?.marketRead===true} onConnect={onConnect}/>{vm.market&&<LiveMetrics vm={vm}/>}</>:<FundingSummary vm={vm} clock={clock} onRetry={source?.retry} onCheckStatus={source?.retry}/>}</div>
    <section className="pl-panel pl-o-media" aria-label="About"><h3 className="pl-label">About</h3><CoinMedia vm={vm}/></section>
    <div className="pl-o-tabs">
     <div className="pl-tabs" role="tablist" aria-label="Coin sections">{TABS.map(t=><button key={t} type="button" role="tab" aria-selected={tab===t} id={'pl-tab-'+t} aria-controls="pl-tabpanel" onClick={()=>setTab(t)}>{t}</button>)}</div>
     <div id="pl-tabpanel" role="tabpanel" aria-labelledby={'pl-tab-'+tab} className="pl-panel">
      {tab==='Overview'&&<>
       {live&&<div className="pl-rows">
        <div className="pl-row"><span>Committed at close</span><span><ExactAmount amount={solAmount(vm.totals.committedLamports)}/></span></div>
        <div className="pl-row"><span>Accepted into the pool</span><span>{vm.totals.acceptedLamports!=null?<ExactAmount amount={solAmount(vm.totals.acceptedLamports)}/>:'—'}</span></div>
        <div className="pl-row"><span>Refundable excess</span><span>{vm.totals.refundableLamports!=null?<ExactAmount amount={solAmount(vm.totals.refundableLamports)}/>:'—'}</span></div>
        <div className="pl-row"><span>Commitments</span><span>{vm.totals.receiptCount!=null?Number(vm.totals.receiptCount).toLocaleString('en-GB'):'—'}</span></div>
       </div>}
       {!live&&<p className="pl-small pl-muted">Funding status and terms are above. Creator updates appear under Updates once they are published.</p>}
       {vm.mode==='family'&&<div style={{marginTop:14}}><h3 className="pl-label">Parent rewards</h3><p className="pl-small pl-muted">{vm.parents.map(p=>p.name).join(' and ')} holders above each parent's snapshot threshold can claim from a reserve sized in the terms. Eligibility is checked per wallet on the Claims panel.</p></div>}
      </>}
      {tab==='Updates'&&<p className="pl-small pl-muted">No updates yet.</p>}
      {tab==='Activity'&&<CampaignActivity vm={vm} owner={!wallet?.fixture?wallet?.address:null} enabled={source?.manifest?.capabilities?.activityRead===true} onConnect={onConnect}/>}
      {tab==='Details'&&<>
       <CampaignTerms vm={vm}/>
       <h3 className="pl-label" style={{marginTop:18}}>Addresses</h3>
       <div className="pl-terms">
        {[['Campaign',vm.identity.campaign],['Program',vm.identity.programId],['Coin address',vm.chain.mint],['Pool',vm.chain.pool],['Escrow',vm.chain.escrow],['Lock',vm.chain.lock]].filter(([,v])=>v).map(([k,v])=><div className="pl-row-static" key={k}><span>{k}</span><span className="pl-mono pl-small" style={{display:'inline-flex',alignItems:'center',gap:4}}>{v}<CopyButton value={v} label={k}/></span></div>)}
        <div className="pl-row-static"><span>Network</span><span className="pl-mono pl-small">{vm.identity.genesisHash}</span></div>
        {vm.source.slot&&<div className="pl-row-static"><span>Read at slot</span><span className="pl-mono pl-small">{vm.source.slot} · {vm.source.commitment}</span></div>}
       </div>
      </>}
     </div>
    </div>
   </div>
   <aside className={'pl-coin-rail'+(tall?' is-tall':'')} ref={railRef} aria-label="Coin actions">
    <section className="pl-panel pl-o-identity"><CoinIdentity vm={vm}/></section>
    <div className="pl-o-form"><div ref={tradeRef}>{live&&<TradeForm vm={vm} clock={clock} wallet={wallet} position={position} onConnect={onConnect} trade={trade}/>}</div><div ref={claimsRef}>{live?<ClaimsSummary vm={vm} position={position} connected={connected} onClaim={onClaim} busy={busy}/>:vm.phase==='refund'?<ClaimsSummary vm={vm} position={position} connected={connected} onClaim={onClaim} busy={busy}/>:<CommitForm vm={vm} clock={clock} connected={connected} balanceLamports={wallet?.balanceLamports??null} existingLamports={position?.commitLamports||'0'} minimumLamports={source?.manifest?.minimumCommitmentLamports??null} onConnect={onConnect} onCommit={onCommit} busy={busy}/>}</div></div>
    <div className="pl-o-position">{transaction&&<TransactionStatus {...transaction} onPrimary={onCheck}/>} {accountError&&<p role="alert" className="pl-error">{accountError}</p>}{transaction?.action==='trade'&&!transaction.signature&&trade?.cancel&&!trade?.working&&<button className="pl-btn-sm" onClick={trade.cancel}>Cancel unsigned trade</button>}<PersonalPosition vm={vm} position={position} connected={connected}/></div>
   </aside>
  </div>
  {live&&<nav className="pl-coin-mobile-actions" aria-label="Coin shortcuts"><button type="button" onClick={()=>marketRef.current?.scrollIntoView({block:'start'})}>Market</button><button type="button" onClick={()=>tradeRef.current?.scrollIntoView({block:'start'})}>Trade</button><button type="button" onClick={()=>claimsRef.current?.scrollIntoView({block:'start'})}>Claims</button></nav>}
 </section>;
}
export {tokenAmount};
