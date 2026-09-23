import {useEffect,useMemo,useRef,useState} from 'react';
import {Copy,Check,ArrowUpRight,XLogo,ShieldCheck,ShieldWarning} from '@phosphor-icons/react';
import {fetchCommunity,normaliseDenylist,denylistHeadline,enforcementBadges,filterDenylist,reasonLabel,statusLabel,shortWallet,utcDay,utcClock,readFailureText,REASON_LABELS,FOLLOW_URL} from './community-data.mjs';
import './community.css';
// The blocked wallets page (owner, 23 September 2026): every wallet the site refuses, with the receipt that put it
// there. Counts and enforcement flags come from /api/community/denylist; nothing here is computed from a guess.
function HistoryRow({item}){
 return <li><span className={`kc-status kc-status-${item.status}`}>{statusLabel(item.status)}</span><time dateTime={item.addedAt}>{utcDay(item.addedAt)??'date unknown'} UTC</time><span>{reasonLabel(item.reason)}</span>{item.evidenceUrl&&<a href={item.evidenceUrl} target="_blank" rel="noopener noreferrer">receipt<ArrowUpRight size={12} aria-hidden="true"/></a>}</li>;
}
function WalletRow({entry,copied,onCopy}){
 const isCopied=copied===entry.wallet;
 return <li className="kc-block-row" data-status={entry.status}>
  <div className="kc-block-top">
   <code className="kc-wallet">{entry.wallet}</code>
   <button type="button" className="kc-copy" aria-label={(isCopied?'Copied wallet ':'Copy wallet ')+shortWallet(entry.wallet)} onClick={()=>onCopy(entry.wallet)}>{isCopied?<Check size={15} aria-hidden="true"/>:<Copy size={15} aria-hidden="true"/>}<span>{isCopied?'Copied':'Copy'}</span></button>
   <span className={`kc-status kc-status-${entry.status}`}>{statusLabel(entry.status)}</span>
  </div>
  <dl className="kc-facts">
   <div><dt>reason</dt><dd>{reasonLabel(entry.reason)}</dd></div>
   <div><dt>cluster</dt><dd><code>{entry.clusterId||'—'}</code></dd></div>
   <div><dt>added</dt><dd><time dateTime={entry.addedAt}>{utcDay(entry.addedAt)??'date unknown'} UTC</time>{entry.addedBy&&<span className="kc-by"> by {entry.addedBy}</span>}</dd></div>
   <div><dt>receipt</dt><dd>{entry.evidenceUrl?<a href={entry.evidenceUrl} target="_blank" rel="noopener noreferrer">open the receipt<ArrowUpRight size={13} aria-hidden="true"/></a>:<span className="kc-warn">none attached</span>}</dd></div>
  </dl>
  {entry.history.length>0&&<details className="kc-history"><summary>history · {entry.history.length} {entry.history.length===1?'change':'changes'}</summary><ol>{entry.history.map((item,i)=><HistoryRow key={i} item={item}/>)}</ol></details>}
 </li>;
}
export function Blocked(){
 const [attempt,setAttempt]=useState(0),[state,setState]=useState({status:'loading',data:null,reason:null});
 const [query,setQuery]=useState(''),[copied,setCopied]=useState(null),[note,setNote]=useState('');
 const heading=useRef(null);
 useEffect(()=>{heading.current?.focus({preventScroll:true});},[]);
 useEffect(()=>{const controller=new AbortController();setState(s=>s.status==='ready'?s:{status:'loading',data:null,reason:null});
  fetchCommunity('denylist',{signal:controller.signal}).then(result=>{if(controller.signal.aborted)return;setState(result.ok?{status:'ready',data:normaliseDenylist(result.data),reason:null}:{status:'failed',data:null,reason:result.reason});});
  return()=>controller.abort();},[attempt]);
 const list=state.data,visible=useMemo(()=>filterDenylist(list?.wallets||[],query),[list,query]);
 async function copy(wallet){try{await navigator.clipboard.writeText(wallet);setCopied(wallet);setNote('Wallet copied: '+shortWallet(wallet));}catch{setNote('Could not copy. Select the address and copy it by hand.');}}
 const badges=enforcementBadges(list?.enforcement);
 return <div className="kc-page kc-blocked">
  <section className="kc-hero">
   <p className="kc-eyebrow">kids.fun · blocked wallets</p>
   <h1 ref={heading} tabIndex={-1}>{state.status==='ready'?denylistHeadline(list.counts):'blocked wallets'}</h1>
   {state.status==='ready'&&<>
    {list.enforcement.note&&<p className="kc-lede">{list.enforcement.note}</p>}
    <ul className="kc-badges" aria-label="Where the list is enforced">{badges.map(b=><li key={b.key} data-on={b.on}>{b.on?<ShieldCheck size={16} aria-hidden="true"/>:<ShieldWarning size={16} aria-hidden="true"/>}{b.label}</li>)}</ul>
    {list.updatedAt&&<p className="kc-refresh"><span>list read {utcClock(list.updatedAt)} UTC</span><span>{list.counts.total} {list.counts.total===1?'entry':'entries'} in total</span></p>}
   </>}
   {state.status==='loading'&&<p className="kc-lede" aria-busy="true">Reading the list…</p>}
   {state.status==='failed'&&<div className="kc-state" role="status"><strong>{state.reason==='not-published'?'Not published yet':'Could not load the list'}</strong><p>{readFailureText(state.reason,'blocked list')}</p>{state.reason!=='not-published'&&<button type="button" onClick={()=>setAttempt(n=>n+1)}>Try again</button>}</div>}
  </section>
  {state.status==='ready'&&<section className="kc-list" aria-labelledby="kc-block-title">
   {list.wallets.length>0?<>
    <div className="kc-tools">
     <h2 id="kc-block-title">the list</h2>
     <label className="kc-find" htmlFor="kc-block-search"><span>find a wallet or a cluster</span><input id="kc-block-search" type="search" value={query} autoComplete="off" spellCheck="false" placeholder="paste an address or a cluster id" onChange={e=>setQuery(e.target.value)}/></label>
     <p className="kc-count-line" role="status">{query.trim()?`${visible.length} of ${list.wallets.length} wallets`:`${list.wallets.length} ${list.wallets.length===1?'wallet':'wallets'}, newest first`}</p>
    </div>
    {visible.length?<ul className="kc-block-list">{visible.map(entry=><WalletRow key={entry.wallet} entry={entry} copied={copied} onCopy={copy}/>)}</ul>
    :<p className="kc-empty">no wallet or cluster matches “{query.trim()}”. <button type="button" className="text-button" onClick={()=>setQuery('')}>Show all</button></p>}
    <span className="kc-visually-hidden" role="status" aria-live="polite">{note}</span>
   </>:<><h2 id="kc-block-title">the list</h2><p className="kc-empty kc-empty-block">No wallets listed yet. The list grows as wallets are documented with proof.</p></>}
  </section>}
  <section className="kc-send" aria-labelledby="kc-send-title">
   <h2 id="kc-send-title">send us wallets with proof</h2>
   <p>a receipt is a link anyone can check: the transaction, the cluster, the post. no receipt, no listing.</p>
   <a className="kc-follow" href={FOLLOW_URL} target="_blank" rel="noopener noreferrer"><XLogo size={18} aria-hidden="true"/>reply to @kidsdotfun with the wallet, the reason and the receipt</a>
  </section>
  <section className="kc-legend-wrap" aria-labelledby="kc-legend-title">
   <h2 id="kc-legend-title">what the reasons mean</h2>
   <dl className="kc-legend">{Object.entries(REASON_LABELS).map(([key,label])=><div key={key}><dt><code>{key}</code></dt><dd>{label}</dd></div>)}</dl>
   <dl className="kc-legend"><div><dt><span className="kc-status kc-status-active">Blocked</span></dt><dd>the site refuses this wallet today.</dd></div><div><dt><span className="kc-status kc-status-appealed">Under appeal</span></dt><dd>the owner disputed it; still refused until the appeal is settled.</dd></div><div><dt><span className="kc-status kc-status-removed">Removed</span></dt><dd>taken off the list; kept here so the history stays public.</dd></div></dl>
  </section>
  <footer className="kc-foot"><p className="kc-foot-links"><a href="#believers">the believers list</a><a href={FOLLOW_URL} target="_blank" rel="noopener noreferrer">@kidsdotfun on X</a></p></footer>
 </div>;
}
