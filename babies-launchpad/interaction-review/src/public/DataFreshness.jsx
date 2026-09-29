import {useEffect,useState} from 'react';
import {freshness} from './campaign-adapter.mjs';
/**
 * DataFreshness (spec §12): a quiet "Updated 8s ago" that becomes a clear stale label after the source's threshold.
 * Re-renders every 10 s, not every second, and is not a live region, so nothing ticks or announces.
 */
export function DataFreshness({fetchedAtUnix,staleAfterSeconds=60,className=''}){
 const [now,setNow]=useState(()=>Math.floor(Date.now()/1000));
 useEffect(()=>{const id=setInterval(()=>setNow(Math.floor(Date.now()/1000)),10000);return()=>clearInterval(id);},[]);
 const f=freshness({fetchedAtUnix,nowUnix:now,staleAfterSeconds});
 return <span className={'pl-fresh'+(f.stale?' is-stale':'')+(className?' '+className:'')}><i aria-hidden="true"/>{f.label}</span>;
}
