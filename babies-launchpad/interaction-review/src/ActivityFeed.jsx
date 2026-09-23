// Program activity on the coin page: every executed instruction of the launch, claims-vault and token programs for
// this campaign, newest first, with the asset that moved, when, by whom, its status and the explorer link. Data comes
// from /api/market/activity through activity-data.mjs, polled every 10 s while the document is visible; a failed read
// keeps the last valid page and says so. Nothing here is a plan or a budget: the feed carries executed amounts only.
import {useEffect,useRef,useState} from 'react';
import {explorerTx} from './network-label.mjs';
import {POLL_MS,cacheKey,isoStamp,readCache,relativeTime,startPolling,utcStamp,writeCache} from './market-data.mjs';
import {ACTIVITY_COPY,ACTIVITY_PAGE,FILTERS,activityChip,applyFilter,countsLine,deriveActivityState,describeAssets,eventKey,fetchActivity,filterCount,filterFor,kindsParam,labelFor,mergeEvents,normaliseEvent,shortAddress,tagsFor} from './activity-data.mjs';
import './activity.css';
const nowUnix=()=>Math.floor(Date.now()/1000);
const shortSig=v=>v?v.slice(0,6)+'…'+v.slice(-6):'';

/** Pages of activity for one chip. Page one is polled; deeper pages are appended with the cursor and kept across polls. */
function useActivity(campaign,filter,enabled,retry){
 const kinds=kindsParam(filter);
 const initial=()=>{const cached=campaign?readCache(cacheKey(campaign,'activity',filter)):null;return {events:cached?.events||[],nextCursor:cached?.nextCursor??null,counts:cached?.counts||null,status:cached?.status||null,pages:1,result:null,readAt:cached?.readAt||null,loading:true,more:false,moreResult:null};};
 const [state,setState]=useState(initial);
 const held=useRef(state);held.current=state;
 useEffect(()=>{
  if(!campaign||!enabled){setState(s=>({...s,loading:false}));return;}
  const key=cacheKey(campaign,'activity',filter);const cached=readCache(key);
  setState({events:cached?.events||[],nextCursor:cached?.nextCursor??null,counts:cached?.counts||null,status:cached?.status||null,pages:1,result:null,readAt:cached?.readAt||null,loading:true,more:false,moreResult:null});
  let controller=null,alive=true;
  const stop=startPolling(async()=>{
   controller?.abort();controller=new AbortController();const signal=controller.signal;
   const result=await fetchActivity({campaign,limit:ACTIVITY_PAGE,kinds},{signal});
   if(!alive||signal.aborted)return;
   setState(s=>{if(!result.ok)return {...s,result,loading:false};
    const events=mergeEvents(s.events,result.data.events.map(normaliseEvent).filter(Boolean));
    const nextCursor=s.pages>1?s.nextCursor:(result.data.nextCursor??null);// a deeper page's cursor wins over page one's
    const next={events,nextCursor,counts:result.data.counts||s.counts,status:typeof result.data.status==='string'?result.data.status:s.status,readAt:nowUnix()};
    writeCache(key,next);return {...s,...next,result,loading:false};});
  },POLL_MS);
  return()=>{alive=false;stop();controller?.abort();};
 },[campaign,filter,kinds,enabled,retry]);
 async function loadMore(){
  const cursor=held.current.nextCursor;if(!cursor||held.current.more)return;setState(s=>({...s,more:true,moreResult:null}));
  const result=await fetchActivity({campaign,cursor,limit:ACTIVITY_PAGE,kinds});
  setState(s=>{if(!result.ok)return {...s,more:false,moreResult:result};
   const events=mergeEvents(s.events,result.data.events.map(normaliseEvent).filter(Boolean));const nextCursor=result.data.nextCursor??null;
   const next={events,nextCursor,counts:result.data.counts||s.counts,status:typeof result.data.status==='string'?result.data.status:s.status,readAt:s.readAt};
   writeCache(cacheKey(campaign,'activity',filter),next);return {...s,...next,pages:s.pages+1,more:false,moreResult:result};});
 }
 return {...state,loadMore};
}

function ActivityRow({event,data,names,now}){
 const label=labelFor(event,names),tags=tagsFor(event),assets=describeAssets(event,names),link=explorerTx(data,event.signature);
 const burned=assets.some(a=>a.tone==='burn');
 const outcome=event.status==='failed'?'failed':event.status==='confirmed'?'confirming':burned?'burn':'done';
 return <li className={`act-row is-${outcome}`}>
  <i className="act-dot" aria-hidden="true"/>
  <time className="act-when" dateTime={isoStamp(event.time)||undefined} title={event.time!=null?utcStamp(event.time):event.slot!=null?'Block time not served · slot '+event.slot.toLocaleString('en-GB'):undefined}>{event.time!=null?relativeTime(event.time,now):event.slot!=null?'Slot '+event.slot.toLocaleString('en-GB'):'Time unknown'}</time>
  <div className="act-what"><span className="act-label">{label}</span>{tags.length>0&&<span className="act-tags">{tags.map(t=><em key={t.key} className={`is-${t.key}`} title={t.title}>{t.text}</em>)}</span>}</div>
  <div className="act-assets">{event.status==='failed'?<span className="act-none">Nothing moved</span>:assets.length===0?<span className="act-none">No asset movement</span>:assets.map((a,i)=><span key={i} className={`act-asset is-${a.tone}`} title={a.exact||undefined}>{a.text}</span>)}</div>
  <span className="act-actor" title={event.actor?'Signed by '+event.actor:undefined}>{event.actor?<code>{shortAddress(event.actor)}</code>:<span className="act-none">—</span>}</span>
  <span className="act-sig">{link?<a href={link} target="_blank" rel="noopener noreferrer" title={event.signature}>{shortSig(event.signature)}</a>:<code title={event.signature}>{shortSig(event.signature)}</code>}</span>
 </li>;
}

/**
 * The Activity section. `names` = {coin: child mint, parentMints: [mintA, mintB], parents: ['Fartcoin','Buttcoin']}.
 * `data` is the post-launch record (explorer URL). Rendered only when the page has a verified campaign.
 */
export function ActivityFeed({campaign,data,names,enabled}){
 const [filter,setFilter]=useState('all'),[retry,setRetry]=useState(0),[now,setNow]=useState(nowUnix);
 const feed=useActivity(campaign,filter,enabled,retry);
 useEffect(()=>{const stop=startPolling(()=>setNow(nowUnix()),POLL_MS);return stop;},[]);
 const rows=applyFilter(feed.events,filter);
 const state=deriveActivityState({events:rows,result:feed.result,loading:feed.loading,enabled});
 const chip=enabled?activityChip({status:feed.status,result:feed.result,lastReadUnix:feed.readAt,nowUnix:now}):{text:'Feed not connected',tone:'off'};
 const current=filterFor(filter),failedView=current.failedOnly;
 const counts=countsLine(feed.counts);
 const heldEvents=feed.events.length;
 return <section className="act" aria-labelledby="act-heading">
  <div className="act-head"><div><h3 id="act-heading">Activity</h3><span className="act-counts">{counts||(state==='loading'?'Loading…':'')}</span></div><span className={`market-fresh is-${chip.tone}`} role="status"><i aria-hidden="true"/>{chip.text}</span></div>
  <div className="act-filters" role="group" aria-label="Filter activity">{FILTERS.map(f=>{const n=filterCount(feed.counts,f.key);return <button key={f.key} type="button" aria-pressed={filter===f.key} onClick={()=>setFilter(f.key)}>{f.label}{n!=null&&n>0&&<b>{n.toLocaleString('en-GB')}</b>}</button>;})}</div>
  {state==='ready'&&<ol className="act-list">{rows.map(e=><ActivityRow key={eventKey(e)} event={e} data={data} names={names} now={now}/>)}</ol>}
  {state==='loading'&&<p className="act-empty" aria-busy="true">{ACTIVITY_COPY.loading}</p>}
  {state==='off'&&<p className="act-empty">{ACTIVITY_COPY.off}</p>}
  {state==='unavailable'&&<p className="act-empty" role="status">{ACTIVITY_COPY.unavailable}<button type="button" className="text-button" onClick={()=>setRetry(n=>n+1)}>Try again now</button></p>}
  {state==='empty'&&<p className="act-empty">{failedView?(heldEvents?'No failed attempts among the '+heldEvents.toLocaleString('en-GB')+' loaded events.':'No failed attempts recorded.'):filter==='all'?ACTIVITY_COPY.empty:'No '+current.label.toLowerCase()+' events recorded yet.'}</p>}
  {enabled&&(state==='ready'||state==='empty')&&<div className="act-foot">
   {feed.nextCursor?<button type="button" className="outlined act-more" disabled={feed.more} aria-busy={feed.more||undefined} onClick={feed.loadMore}>{feed.more?'Loading…':'Load more'}</button>:heldEvents>0?<span>No older events in the feed.</span>:null}
   {failedView&&feed.nextCursor&&<span>Failed attempts are picked out of the loaded events; load more to search older ones.</span>}
   {feed.result&&!feed.result.ok&&heldEvents>0&&<span role="status">Feed unavailable · list may be missing new events.</span>}
   {feed.moreResult&&!feed.moreResult.ok&&<span role="status">Older events could not be read. Try again.</span>}
   <span className="act-note">{data?.explorerUrl?'Times in UTC on hover · signatures open on the explorer.':'Times in UTC on hover · private test ledger: signatures are real on this ledger but not on public explorers.'}</span>
  </div>}
 </section>;
}
