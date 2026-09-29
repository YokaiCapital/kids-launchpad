import {MagnifyingGlass} from '@phosphor-icons/react';
import {STATUS_BUCKETS} from './campaign-adapter.mjs';
const CHIPS=[['all','All'],['open','Open'],['upcoming','Upcoming'],['live','Live'],['ended','Ended']];
const SORTS={closing:'Closing soon',newest:'Newest',name:'Name A to Z'};
/**
 * ExploreFilters (spec §3): search by name, ticker or address; type; status chips; sort. Every control is labelled,
 * the active chip is aria-pressed, and the sort names its real basis (no "trending").
 */
export function ExploreFilters({query,onQuery,mode,onMode,status,onStatus,sort,onSort,counts={}}){
 return <div className="pl-filters-wrap">
  <div className="pl-filters">
   <div className="pl-search"><MagnifyingGlass size={18} aria-hidden="true"/><label htmlFor="pl-search" className="pl-sr">Search launches</label><input id="pl-search" type="search" value={query} onChange={e=>onQuery(e.target.value)} placeholder="Search name, ticker or address" autoComplete="off" spellCheck="false"/></div>
   <div><label htmlFor="pl-mode" className="pl-sr">Launch type</label><select id="pl-mode" value={mode} onChange={e=>onMode(e.target.value)}><option value="all">All types</option><option value="standard">Standard</option><option value="family">Family</option></select></div>
   <div><label htmlFor="pl-sort" className="pl-sr">Sort</label><select id="pl-sort" value={sort} onChange={e=>onSort(e.target.value)}>{Object.entries(SORTS).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></div>
  </div>
  <div className="pl-chips" role="group" aria-label="Status">
   {CHIPS.map(([k,label])=><button key={k} type="button" aria-pressed={status===k} onClick={()=>onStatus(k)}>{label}{counts[k]!=null&&<span className="pl-count-chip">{counts[k]}</span>}</button>)}
  </div>
 </div>;
}
export {STATUS_BUCKETS};
