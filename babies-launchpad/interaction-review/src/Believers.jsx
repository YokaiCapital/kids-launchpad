import {useEffect,useMemo,useRef,useState} from 'react';
import {MagnifyingGlass,ArrowUpRight,Wallet,XLogo} from '@phosphor-icons/react';
import {fetchCommunity,rankSupporters,walletIndex,filterSupporters,findSupporter,howCounts,newestSupporters,refreshLine,utcDay,shortWallet,countUpValue,compactCount,formatCount,readFailureText,HOW_KINDS,POSTS,FOLLOW_URL,PAGE_SIZE} from './community-data.mjs';
import './community.css';
// The believers page (owner, 23 September 2026): a public roll call of the X accounts that stood up for KIDS.
// Everything on it comes from /api/community/supporters and /api/community/supporter-wallets; when a file is
// missing or unreadable the page says so and keeps the "how to get on the list" block in view.
const reducedMotion=()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
const COUNT_UP_MS=1400;
function useCommunityFile(name,attempt){
 const [state,setState]=useState({status:'loading',data:null,reason:null});
 useEffect(()=>{const controller=new AbortController();setState(s=>s.status==='ready'?s:{status:'loading',data:null,reason:null});
  fetchCommunity(name,{signal:controller.signal}).then(result=>{if(controller.signal.aborted)return;setState(result.ok?{status:'ready',data:result.data,reason:null}:{status:'failed',data:null,reason:result.reason});});
  return()=>controller.abort();},[name,attempt]);
 return state;
}
function CountUp({total}){
 const [shown,setShown]=useState(()=>reducedMotion()?total:0);
 useEffect(()=>{if(reducedMotion()){setShown(total);return;}let frame=0;const start=performance.now();
  const tick=now=>{const p=(now-start)/COUNT_UP_MS;setShown(countUpValue(p,total));if(p<1)frame=requestAnimationFrame(tick);};
  frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);},[total]);
 return <><span className="kc-count" aria-hidden="true">{formatCount(shown)}</span><span className="kc-visually-hidden">{formatCount(total)}</span></>;
}
const xProfile=username=>'https://x.com/'+encodeURIComponent(username);
function Row({entry,wallet}){
 return <li className="kc-row">
  <span className="kc-rank"><span aria-hidden="true">#</span>{entry.rank}</span>
  <span className="kc-who"><a href={xProfile(entry.username)} target="_blank" rel="noopener noreferrer">@{entry.username}</a>{entry.name&&entry.name!==entry.username&&<span className="kc-name">{entry.name}</span>}</span>
  <span className="kc-how">{entry.how.join(' · ')||'—'}</span>
  <span className="kc-since"><time dateTime={entry.since}>{utcDay(entry.since)}</time></span>
  <span className="kc-meta">{entry.followers!=null&&<span className="kc-followers" title={formatCount(entry.followers)+' followers'}>{compactCount(entry.followers)}</span>}
   {wallet&&(wallet.tweetUrl?<a className="kc-badge" href={wallet.tweetUrl} target="_blank" rel="noopener noreferrer" title={wallet.wallet}><Wallet size={13} aria-hidden="true"/>wallet linked <code>{shortWallet(wallet.wallet)}</code></a>:<span className="kc-badge" title={wallet.wallet}><Wallet size={13} aria-hidden="true"/>wallet linked <code>{shortWallet(wallet.wallet)}</code></span>)}</span>
 </li>;
}
export function Believers(){
 const [attempt,setAttempt]=useState(0);
 const supporters=useCommunityFile('supporters',attempt),proofs=useCommunityFile('supporter-wallets',attempt);
 const [query,setQuery]=useState(''),[how,setHow]=useState(''),[walletOnly,setWalletOnly]=useState(false),[shown,setShown]=useState(PAGE_SIZE);
 const heading=useRef(null);
 useEffect(()=>{heading.current?.focus({preventScroll:true});},[]);
 const ranked=useMemo(()=>rankSupporters(supporters.data?.entries),[supporters.data]);
 const wallets=useMemo(()=>walletIndex(proofs.data?.entries),[proofs.data]);
 const counts=useMemo(()=>howCounts(ranked,wallets),[ranked,wallets]);
 const visible=useMemo(()=>filterSupporters(ranked,{query,how,walletLinked:walletOnly},wallets),[ranked,query,how,walletOnly,wallets]);
 const exact=findSupporter(ranked,query),newest=newestSupporters(ranked,5);
 useEffect(()=>{setShown(PAGE_SIZE);},[query,how,walletOnly]);
 const refresh=refreshLine(supporters.data?.generatedAt,supporters.data?.refreshEveryMinutes),total=supporters.data?.count??ranked.length;
 const filtering=query.trim()||how||walletOnly,page=visible.slice(0,shown);
 return <div className="kc-page kc-believers">
  <section className="kc-hero">
   <p className="kc-eyebrow">kids.fun · the people who stood up</p>
   <h1 ref={heading} tabIndex={-1}>we see you. <em>every single one.</em></h1>
   <p className="kc-lede">two posts, one idea: the trenches can be fair again. these are the accounts that said it out loud, in public, before there was anything to gain.</p>
   <p className="kc-lede kc-allocation">everyone on this list is eligible for the initial KIDS allocation, whenever that happens.</p>
   <div className="kc-counter" aria-busy={supporters.status==='loading'}>
    {supporters.status==='ready'?<><CountUp total={total}/><span className="kc-count-label">believers on the list</span><p className="kc-refresh"><span>refreshed {refresh.refreshed??'—'} UTC</span><span>refreshes every {refresh.every} minutes</span><span>not here yet? next refresh at {refresh.next??'—'} UTC</span></p></>
    :supporters.status==='loading'?<><span className="kc-count kc-count-placeholder" aria-hidden="true">—</span><span className="kc-count-label">counting the list…</span></>
    :<div className="kc-state" role="status"><strong>{supporters.reason==='not-published'?'Not published yet':'Could not load the list'}</strong><p>{readFailureText(supporters.reason,'believers list')}</p>{supporters.reason!=='not-published'&&<button type="button" onClick={()=>setAttempt(n=>n+1)}>Try again</button>}</div>}
   </div>
  </section>
  {supporters.status==='ready'&&<section className="kc-check" aria-labelledby="kc-check-title">
   <h2 id="kc-check-title">are you on the list?</h2><label className="kc-hint" htmlFor="kc-search">type your @ or your name</label>
   <div className="kc-search"><MagnifyingGlass size={22} aria-hidden="true"/><input id="kc-search" type="search" value={query} autoComplete="off" spellCheck="false" placeholder="@yourhandle" onChange={e=>setQuery(e.target.value)}/>{query&&<button type="button" className="kc-clear" onClick={()=>setQuery('')}>Clear</button>}</div>
   <div className="kc-answer" role="status" aria-live="polite">
    {exact?<div className="kc-found"><strong>@{exact.username} is on it.</strong><span className="kc-found-rank">#{exact.rank}</span><span>since <time dateTime={exact.since}>{utcDay(exact.since)}</time> UTC · {exact.how.join(' · ')||'on the list'}</span>{wallets.has(exact.xId)?<span className="kc-badge"><Wallet size={13} aria-hidden="true"/>wallet linked <code>{shortWallet(wallets.get(exact.xId).wallet)}</code></span>:<span className="kc-found-next">no wallet linked yet. <a href="#kc-howto">Link one</a></span>}</div>
    :query.trim()&&!visible.length?<div className="kc-missing"><strong>“{query.trim()}” is not on the list yet.</strong><span>reply to a post below, then check again after {refresh.next??'the next refresh'} UTC.</span><a className="kc-mini" href="#kc-howto">How to get on the list</a></div>
    :query.trim()?<span className="kc-answer-count">{visible.length} {visible.length===1?'match':'matches'} for “{query.trim()}”</span>:null}
   </div>
   {newest.length>0&&<p className="kc-newest"><span>latest to stand up</span>{newest.map(e=><a key={e.xId} href={xProfile(e.username)} target="_blank" rel="noopener noreferrer">@{e.username}</a>)}</p>}
  </section>}
  <section className="kc-howto" id="kc-howto" aria-labelledby="kc-howto-title">
   <h2 id="kc-howto-title">how to get on the list</h2>
   <ol className="kc-steps">
    <li><strong>reply, quote or repost one of the two posts</strong><span>say something real: what you would build, what you would ban, what would make you commit SOL again.</span><span className="kc-links">{POSTS.map(post=><a key={post.url} href={post.url} target="_blank" rel="noopener noreferrer">{post.label}<ArrowUpRight size={14} aria-hidden="true"/></a>)}</span></li>
    <li><strong>nothing else to do now</strong><span>when the allocation happens, you sign in with X on kids.fun and link your wallet then. do not post your wallet address anywhere; nobody from kids.fun will ask for it.</span></li>
    <li><strong>follow @kidsdotfun</strong><span>the list is rebuilt every {refresh.every} minutes from public replies, quotes, reposts and likes. your “since” date is set once and never moves.</span><a className="kc-follow" href={FOLLOW_URL} target="_blank" rel="noopener noreferrer"><XLogo size={18} aria-hidden="true"/>Follow @kidsdotfun</a></li>
   </ol>
  </section>
  {supporters.status==='ready'&&<section className="kc-list" aria-labelledby="kc-list-title">
   <div className="kc-tools">
    <h2 id="kc-list-title">the list</h2>
    <div className="kc-chips" role="group" aria-label="Filter by how they showed up">
     <button type="button" className="kc-chip" aria-pressed={!how&&!walletOnly} onClick={()=>{setHow('');setWalletOnly(false);}}>all <b>{formatCount(ranked.length)}</b></button>
     {HOW_KINDS.map(kind=><button key={kind} type="button" className="kc-chip" aria-pressed={how===kind} onClick={()=>setHow(how===kind?'':kind)}>{kind} <b>{formatCount(counts[kind])}</b></button>)}
     <button type="button" className="kc-chip kc-chip-wallet" aria-pressed={walletOnly} disabled={proofs.status==='ready'&&!counts.walletLinked} onClick={()=>setWalletOnly(v=>!v)}><Wallet size={14} aria-hidden="true"/>wallet linked <b>{proofs.status==='ready'?formatCount(counts.walletLinked):'…'}</b></button>
    </div>
    <p className="kc-count-line" role="status">{filtering?`${formatCount(visible.length)} of ${formatCount(ranked.length)} believers`:`${formatCount(ranked.length)} believers, earliest first`}{proofs.status==='failed'&&proofs.reason!=='not-published'&&<span className="kc-warn"> · wallet links could not be loaded</span>}{proofs.status==='ready'&&!counts.walletLinked&&<span className="kc-warn"> · no wallets linked yet</span>}</p>
   </div>
   <div className="kc-roll-head" aria-hidden="true"><span>rank</span><span>account</span><span>how they showed up</span><span>since</span><span>followers · wallet</span></div>
   {page.length?<ol className="kc-roll">{page.map(entry=><Row key={entry.xId} entry={entry} wallet={wallets.get(entry.xId)}/>)}</ol>
   :<p className="kc-empty">nobody matches that filter. <button type="button" className="text-button" onClick={()=>{setQuery('');setHow('');setWalletOnly(false);}}>Show everyone</button></p>}
   {visible.length>shown&&<div className="kc-more"><button type="button" onClick={()=>setShown(n=>n+PAGE_SIZE)}>Show more<span className="kc-more-hint">{formatCount(Math.min(PAGE_SIZE,visible.length-shown))} of {formatCount(visible.length-shown)} left</span></button></div>}
  </section>}
  <footer className="kc-foot">
   <p>usernames are public X handles taken from public replies, quotes, reposts and likes on the two posts. if you are here and do not want to be, reply to a post and you come off the list. if you should be here and are not, say so with the link to what you posted.</p>
   <p className="kc-foot-links">{POSTS.map(post=><a key={post.url} href={post.url} target="_blank" rel="noopener noreferrer">{post.label}</a>)}<a href="#blocked">blocked wallets</a></p>
  </footer>
 </div>;
}
