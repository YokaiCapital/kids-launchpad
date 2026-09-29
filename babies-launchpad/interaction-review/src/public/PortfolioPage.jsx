import {DirectoryPager} from './DirectoryPager';
import {useState} from 'react';
import {solAmount,tokenAmount,claimGroups,statusBucket,formatUtc} from './campaign-adapter.mjs';
import {Pfp} from './CoinMedia';
import {ExactAmount} from './ExactAmount';
const TABS=['Positions','Claims & refunds','History'];
const LIFECYCLE={scheduled:'Upcoming',open:'Open',closed:'Closed',settling:'Settling',launching:'Launching',live:'Live',refund:'Refunds',unavailable:'Unavailable'};
/**
 * PortfolioPage (spec §11): every campaign for the connected wallet, actionable positions first. Unlike token
 * quantities are never summed; one failed campaign never blanks the others; nothing renders for the previous wallet.
 */
export function PortfolioPage({source,wallet,positions,go,coinHref,onConnect,onPreviewWallet,reading=false,accountError=null}){
 const [tab,setTab]=useState('Positions');
 if(!wallet)return <section className="pl" aria-labelledby="pl-portfolio-h">
  <div className="pl-head"><div><h1 id="pl-portfolio-h">Portfolio</h1><p>Your commitments, allocations and refunds across launches.</p></div></div>
  <div className="pl-panel pl-state"><h2>Connect a wallet</h2><p>Positions are read from the chain for the connected wallet only.</p><div style={{display:'flex',gap:8,flexWrap:'wrap',justifyContent:'center'}}><button type="button" className="primary" onClick={onConnect}>Connect wallet</button>{source.fixture&&onPreviewWallet&&<button type="button" onClick={onPreviewWallet}>Preview with the fixture wallet</button>}</div></div>
 </section>;
 if(source.status==='error')return <section className="pl"><h1>Portfolio</h1><div className="pl-panel pl-state is-error" role="alert"><h2>Launch directory unavailable</h2><p>Your holdings have not been assumed to be empty.</p><button type="button" onClick={source.retry}>Retry</button></div></section>;
 if(positions===undefined)return <section className="pl" aria-labelledby="pl-portfolio-h">
  <div className="pl-head"><div><h1 id="pl-portfolio-h">Portfolio</h1><p>Your commitments, allocations and refunds across launches.</p></div></div>
  <div className="pl-wallet-bar"><span>Wallet <span className="pl-mono">{wallet.address.slice(0,4)}…{wallet.address.slice(-4)}</span></span></div>
  <div className="pl-panel pl-state is-error" role="alert"><h2>{reading?'Reading your positions…':'Positions could not be read'}</h2><p>{reading?'Checking this page of launches.':accountError||'Position data is unavailable. Nothing is assumed until it is verified.'}</p><button type="button" onClick={source.retry}>Retry</button></div>
 </section>;
 const items=(source.campaigns||[]).map(vm=>{const p=positions?.[vm.id]??positions?.[vm.identity.campaign];if(p===undefined)return null;const groups=claimGroups(vm,p||{commitLamports:'0',parents:[]});return {vm,p,groups,actionable:groups.filter(g=>g.action).length};}).filter(Boolean).filter(x=>x.p&&x.p.eligibility!=='unknown'&&(BigInt(x.p.commitLamports||'0')>0n||BigInt(x.p.walletTokensBaseUnits||'0')>0n||x.p.dev||x.p.setup||x.p.parents?.length));
 const unknown=source.campaigns.filter(vm=>{const p=positions?.[vm.id]??positions?.[vm.identity.campaign];return p===undefined||p?.eligibility==='unknown'||vm.phase==='live'&&p&&p.walletTokensBaseUnits==null;}).length;
 const ordered=[...items].sort((a,b)=>b.actionable-a.actionable||(b.vm.createdAtUnix??0)-(a.vm.createdAtUnix??0)||(a.vm.id<b.vm.id?-1:1));
 const shown=tab==='History'?ordered.filter(x=>['live','refund'].includes(x.vm.phase)):tab==='Claims & refunds'?ordered.filter(x=>x.actionable>0):ordered;
 return <section className="pl" aria-labelledby="pl-portfolio-h">
  <div className="pl-head"><div><h1 id="pl-portfolio-h">Portfolio</h1><p>Your commitments, allocations and refunds across launches.</p></div></div>
  <div className="pl-wallet-bar"><span>Wallet <span className="pl-mono">{wallet.address.slice(0,4)}…{wallet.address.slice(-4)}</span>{wallet.fixture&&<> <span className="pl-tag is-fixture">Fixture wallet</span></>}</span><span>{items.length} campaign{items.length===1?'':'s'} · fiat value not shown without a fresh price source</span></div>
  {!wallet.fixture&&<p className="pl-coverage">{source.indexedPortfolio?<>Launch allocations found from finalized receipts and creator roles. {source.coverage?.complete?'All registered Standard launches were checked recently.':`Discovery is incomplete: ${source.coverage?.fresh??0} of ${source.coverage?.campaigns??0} launches checked recently. Missing entries are not zero balances.`} Tokens received only by transfer or bought elsewhere are not included in this allocation index.</>:<>Checking launch directory page {source.page||1}. {source.nextCursor||source.hasPrevious?'Use Previous and Next launches to check other campaigns.':'All listed campaigns are on this page.'}</>} {unknown>0?`${unknown} position${unknown===1?'':'s'} could not be verified; these are not zero balances.`:''}</p>}

  {source.failures?.length>0&&<p className="pl-error" role="alert">Some campaign records could not be read. The list may be incomplete.</p>}
  <div className="pl-tabs" role="tablist" aria-label="Portfolio sections">{TABS.map(t=><button key={t} type="button" role="tab" aria-selected={tab===t} onClick={()=>setTab(t)}>{t}</button>)}</div>
  {shown.length===0&&<div className="pl-panel pl-state"><h2>{tab==='Positions'?'No positions found on this page':tab==='History'?'No finished launches yet':'No verified claims on this page'}</h2><p>{tab==='Positions'?'Commit to an open launch and it appears here.':'Check back after settlement.'}</p>{tab==='Positions'&&<button type="button" onClick={()=>go('Explore')}>Explore launches</button>}</div>}
  <div className="pl-plist">
   {shown.map(({vm,p,groups,actionable})=>{
    const d=vm.terms.supply.decimals,next=groups.find(g=>g.action);
    return <article className="pl-pitem" key={vm.id}>
     <Pfp src={vm.media.pfp} name={vm.name} size={48}/>
     <div className="pl-pitem-text">
      <a href={coinHref(vm.id)} onClick={e=>{e.preventDefault();go('Coin',vm.id);}}>{vm.name} <span className="pl-muted">{vm.symbol?'$'+vm.symbol:''}</span> <span className={'pl-pill '+({open:'is-open',live:'is-live',upcoming:'is-pending',ended:'is-problem',launching:'is-pending'}[statusBucket(vm.phase)]||'is-muted')} style={{marginLeft:6}}>{LIFECYCLE[vm.phase]}</span></a>
      <div className="pl-pitem-facts">
       <span>Committed <strong><ExactAmount amount={solAmount(p.commitLamports||0)}/></strong></span>
       {p.acceptedLamports!=null&&<span>Accepted <strong><ExactAmount amount={solAmount(p.acceptedLamports)}/></strong></span>}
       {p.walletTokensBaseUnits!=null&&<span>Wallet <strong><ExactAmount amount={tokenAmount(p.walletTokensBaseUnits,d,vm.symbol)}/></strong></span>}
       {groups.filter(g=>g.action).map(g=><span key={g.key}>{g.title.replace('Your ','')}: <strong>{g.rows[0]?<ExactAmount amount={g.rows[0].amount}/>:'available'}</strong></span>)}
       {vm.phase==='open'&&vm.terms.deadlineUnix!=null&&<span>Closes {formatUtc(vm.terms.deadlineUnix)}</span>}
      </div>
     </div>
     <button type="button" className={(actionable?'primary ':'')+'pl-btn-sm pl-pitem-action'} onClick={()=>go('Coin',vm.id)}>{next?next.action:vm.phase==='open'?'Commit more':'View'}</button>
    </article>;
   })}
  </div>
  <DirectoryPager source={source}/>
 </section>;
}
