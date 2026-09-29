import {useEffect,useMemo,useState} from 'react';
import {ArrowUpRight} from '@phosphor-icons/react';
import {exploreRow,filterRows,sortRows,defaultSortFor} from './campaign-adapter.mjs';
import {DirectoryPager} from './DirectoryPager';
import {ExploreFilters} from './ExploreFilters';
import {CoinListRow,CoinListRowSkeleton} from './CoinListRow';
const PAGE=20;
/**
 * ExplorePage (spec §3): compact introduction, then the launch directory. Loading, error, empty and no-results are
 * four distinct states. Default sort for Open is closing soon; Live and Ended default to newest (documented in the
 * sort control, never called trending).
 */
export function ExplorePage({source,clock,go,coinHref,onFilters}){
 const [query,setQuery]=useState(''),[mode,setMode]=useState('all'),[status,setStatus]=useState('all'),[sortChoice,setSortChoice]=useState(null),[limit,setLimit]=useState(PAGE);
 const sort=sortChoice||defaultSortFor(status);
 useEffect(()=>{const timer=setTimeout(()=>onFilters?.({sort,query:query.trim()||null,mode:mode==='all'?null:mode,status:({open:'open',upcoming:'scheduled',live:'launched',ended:'failed'})[status]||null}),250);return()=>clearTimeout(timer);},[query,mode,status,sort,onFilters]);
 const now=clock();
 const rows=useMemo(()=>(source.campaigns||[]).map(vm=>exploreRow(vm,now)),[source.campaigns,Math.floor(now/30)]);
 const counts=useMemo(()=>{const c={all:rows.length};for(const r of rows)c[r.bucket]=(c[r.bucket]||0)+1;return c;},[rows]);
 const visible=useMemo(()=>source.fixture?sortRows(filterRows(rows,{status,mode,query}),sort):filterRows(rows,{status,mode,query}),[rows,status,mode,query,sort,source.fixture]);
 const filtered=query.trim()!==''||mode!=='all'||status!=='all';
 return <section className="pl" aria-labelledby="pl-explore-h">
  <div className="pl-head">
   <div><h1 id="pl-explore-h">Launch together.</h1><p>Timed commitments. Proportional allocations. Locked liquidity.</p></div>
   <button type="button" className="primary" onClick={()=>go('LaunchNew')}>Launch a coin <ArrowUpRight size={18} weight="bold" aria-hidden="true"/></button>
  </div>
  <ExploreFilters query={query} onQuery={v=>{setQuery(v);setLimit(PAGE);}} mode={mode} onMode={v=>{setMode(v);setLimit(PAGE);}} status={status} onStatus={v=>{setStatus(v);setSortChoice(null);setLimit(PAGE);}} sort={sort} onSort={setSortChoice} counts={source.fixture&&source.status==='ready'?counts:{}}/>
  {!source.fixture&&<p className="pl-coverage">Search and sorting cover all launches.</p>}
  <div className="pl-list" aria-busy={source.status==='loading'}>
   <div className="pl-list-head" aria-hidden="true"><span/><span>Coin / ticker</span><span>Type</span><span>Funding / market</span><span>Status</span><span/></div>
   {source.status==='loading'&&<div role="status" aria-label="Loading launches"><CoinListRowSkeleton/><CoinListRowSkeleton/><CoinListRowSkeleton/></div>}
   {source.status==='error'&&<div className="pl-state is-error" role="alert"><h2>Launches could not be loaded</h2><p>{source.error||'The launch directory did not answer.'}</p><button type="button" onClick={source.retry}>Retry</button></div>}
   {source.status==='ready'&&rows.length===0&&<div className="pl-state"><h2>No open launches yet.</h2><p>Be the first. A launch is one click and one wallet approval; its terms are sealed on creation.</p><button type="button" className="primary" onClick={()=>go('LaunchNew')}>Launch a coin</button></div>}
   {source.status==='ready'&&rows.length>0&&visible.length===0&&<div className="pl-state"><h2>No launches match</h2><p>{filtered?'Try another search or clear the filters.':'Nothing to show.'}</p><button type="button" onClick={()=>{setQuery('');setMode('all');setStatus('all');}}>Clear filters</button></div>}
   {source.status==='ready'&&visible.slice(0,limit).map(row=><CoinListRow key={row.id} row={row} clock={clock} href={coinHref(row.id)} onOpen={()=>go('Coin',row.id)}/>)}
   {source.status==='ready'&&visible.length>limit&&<div className="pl-more"><button type="button" onClick={()=>setLimit(n=>n+PAGE)}>Load more ({visible.length-limit} more)</button></div>}
  </div>
  {source.failures?.length>0&&<p className="pl-error" role="alert">Some launch records could not be read. Retry to refresh the directory.</p>}
  <DirectoryPager source={source}/>
  {source.fixture&&<p className="pl-help-text" style={{marginTop:10}}><span className="pl-tag is-fixture">Fixture data</span> This build renders local development fixtures because no campaign API is configured.</p>}
 </section>;
}
