import {useEffect,useState} from 'react';
import {CoinSkeleton} from './CoinSkeleton';
import {ArrowRight,Copy,Check} from '@phosphor-icons/react';
import {describeLaunch,formatCountdown} from './launch-status.mjs';
function Address({label,value}){
 const [copied,setCopied]=useState(false);
 return <div className="launch-address"><span>{label}</span><code>{value}</code><button type="button" aria-label={'Copy '+label} onClick={async()=>{try{await navigator.clipboard.writeText(value);setCopied(true);setTimeout(()=>setCopied(false),1500);}catch{}}}>{copied?<Check size={15}/>:<Copy size={15}/>}{copied?'Copied':'Copy'}</button></div>;
}
/** Big status card at the top of the launch page. `data` is the live readActive() payload, {configured:false} or null while loading. */
export function LaunchStatus({data,go,onRefresh}){
 const [skew,setSkew]=useState(0),[now,setNow]=useState(Date.now());
 useEffect(()=>{if(data?.configured===true&&Number.isFinite(data.chainTimeUnix))setSkew(data.chainTimeUnix*1000-Date.now());},[data]);
 useEffect(()=>{const id=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(id);},[]);
 const nowUnix=Math.floor((now+skew)/1000),d=describeLaunch(data,nowUnix);
 // When a countdown hits zero the phase changes on the ledger; ask for a fresh read once.
 useEffect(()=>{if(d.countdown&&d.countdown.seconds<=0&&onRefresh){const id=setTimeout(onRefresh,1500);return()=>clearTimeout(id);}},[d.countdown&&d.countdown.seconds<=0,d.phase]);
 if(!data)return <section className="launch-status"><CoinSkeleton variant="status"/></section>;
 return <section className={'launch-status tone-'+d.tone} aria-live="polite">
  <div className="launch-status-head"><span className="launch-pill">{d.pill}</span>{d.countdown&&<span className="launch-when">{d.countdown.label.replace(' in','')} {new Date(d.countdown.at*1000).toLocaleString()}</span>}</div>
  <h2>{d.headline}</h2>
  {d.countdown&&<div className="launch-countdown"><span>{d.countdown.label}</span><strong>{formatCountdown(d.countdown.seconds)}</strong></div>}
  <p>{d.sub}</p>
  {d.progress&&<div className="launch-progress" role="img" aria-label={d.progress.raised+' SOL raised, soft cap '+d.progress.soft+' SOL, hard cap '+d.progress.hard+' SOL'}><div className="launch-bar"><div style={{width:d.progress.pct+'%'}}/><i style={{left:d.progress.softPct+'%'}}/></div><div className="launch-progress-labels"><span><strong>{d.progress.raised} SOL</strong> raised</span><span>Soft cap {d.progress.soft} SOL{d.progress.reached?' ✓':''}</span><span>Hard cap {d.progress.hard} SOL</span></div></div>}
  {d.addresses&&<div className="launch-addresses">{d.addresses.map(a=><Address key={a.label} {...a}/>)}<small>{d.explorerUrl?<a href={d.explorerUrl+'/token/'+(data?.mint||'')+(data?.explorerCluster||'')} target="_blank" rel="noreferrer">View the coin on the explorer</a>:'Private test ledger: these addresses do not appear on public explorers or trading terminals.'}</small></div>}
  {d.phase==='launched'&&go&&<button className="primary launch-cta" onClick={()=>go('PostLaunch')}>Open the coin page: claim and trade <ArrowRight size={20}/></button>}
 </section>;
}
/** Ticking countdown for the disabled commit box: "Opens in 02:14:09" above the greyed controls. */
export function OpensIn({data}){
 const [skew,setSkew]=useState(0),[now,setNow]=useState(Date.now());
 useEffect(()=>{if(Number.isFinite(data?.chainTimeUnix))setSkew(data.chainTimeUnix*1000-Date.now());},[data]);
 useEffect(()=>{const id=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(id);},[]);
 const at=data?.next?.opensAtUnix;if(!at)return <div className="opens-in is-tba"><span>Opens</span><strong>Date to be announced</strong></div>;
 const seconds=at-Math.floor((now+skew)/1000);
 return <div className="opens-in"><span>{seconds>0?'Opens in':'Opening now'}</span><strong>{formatCountdown(seconds)}</strong><small>{new Date(at*1000).toLocaleString()}</small></div>;
}
