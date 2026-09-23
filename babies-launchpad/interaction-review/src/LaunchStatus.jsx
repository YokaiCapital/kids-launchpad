import {useEffect,useState} from 'react';
import {CoinSkeleton} from './CoinSkeleton';
import {CoinPfp} from './CoinPfp';
import {explorerAccount,netLabel} from './network-label.mjs';
import {ArrowRight,ArrowSquareOut,CaretRight,Copy,Check} from '@phosphor-icons/react';
import {describeLaunch,formatCountdown,formatUtc} from './launch-status';
function useCopy(){
 const [copied,setCopied]=useState(false);
 useEffect(()=>{if(!copied)return;const id=setTimeout(()=>setCopied(false),1500);return()=>clearTimeout(id);},[copied]);
 return [copied,async value=>{try{await navigator.clipboard.writeText(value);setCopied(true);}catch{}}];
}
function CopyButton({label,value}){
 const [copied,copy]=useCopy();
 return <button type="button" className={'launch-copy'+(copied?' is-copied':'')} aria-label={'Copy '+label} onClick={()=>copy(value)}>{copied?<Check size={14}/>:<Copy size={14}/>}{copied?'Copied':'Copy'}</button>;
}
function Address({label,value,explorer}){
 return <div className="launch-address"><span>{label}</span><code>{value}</code><div className="launch-address-actions"><CopyButton label={label} value={value}/>{explorer&&<a className="launch-explorer" href={explorer} target="_blank" rel="noreferrer" aria-label={label+' on the explorer'}>Explorer <ArrowSquareOut size={14}/></a>}</div></div>;
}
const shortAddress=v=>v?v.slice(0,5)+'…'+v.slice(-4):'';
/** Compact card for a launched coin: identity row, completed-launch stats, coin address, and the contract details folded away. */
function LaunchedCard({d,data,go}){
 const mintExplorer=data?.mintExplorerUrl||(d.explorerUrl?d.explorerUrl.replace(/\/$/,'')+'/token/'+(data?.mint||'')+(data?.explorerCluster||''):null);
 const rows=[...d.addresses.map(a=>({...a,explorer:a.label==='Coin address'?mintExplorer:explorerAccount(data,a.value)})),data?.programId&&{label:'Program',value:data.programId,explorer:explorerAccount(data,data.programId)}].filter(Boolean);
 return <section className="launch-status is-launched tone-ok" aria-live="polite" aria-label="Shartcoin is live">
  <div className="launch-live-head">
   <CoinPfp className="launch-live-pfp" alt="" size={44}/>
   <div className="launch-live-title"><div><h2>Shartcoin</h2><span className="live-badge"><i aria-hidden="true"/>Live</span></div><p className="launch-live-sub">{d.sub}</p></div>
   {go&&<button className="primary launch-view" onClick={()=>go('PostLaunch')}>View coin <ArrowRight size={18}/></button>}
  </div>
  {d.stats?.length>0&&<ul className="launch-stats" aria-label="Launch results">{d.stats.map(s=><li key={s.label}><span>{s.label}</span><strong>{s.value}{s.unit&&<small>{s.unit}</small>}</strong></li>)}</ul>}
  {data?.mint&&<div className="launch-address-row"><span>Coin address</span><code title={data.mint}>{shortAddress(data.mint)}</code><CopyButton label="coin address" value={data.mint}/></div>}
  <details className="launch-contract">
   <summary><CaretRight size={14} aria-hidden="true"/>Contract details</summary>
   <div className="launch-addresses">{rows.map(a=><Address key={a.label} {...a}/>)}<small>{mintExplorer?<a href={mintExplorer} target="_blank" rel="noreferrer">View the coin on the explorer</a>:'Private test ledger ('+netLabel(data?.network).name+'): these addresses do not appear on public explorers or trading terminals.'}</small></div>
  </details>
 </section>;
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
 if(d.phase==='launched')return <LaunchedCard d={d} data={data} go={go}/>;
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
 // The announced time is one canonical UTC value. Reaching it changes only this label: the campaign opens when the
 // service creates it on chain, and the live status above decides whether commitments are possible.
 return <div className={'opens-in'+(seconds<=0?' is-due':'')}><span>{seconds>0?'Opens in':'Opening'}</span><strong>{seconds>0?formatCountdown(seconds):'waiting for the campaign to open on chain'}</strong><small>{formatUtc(at)}</small></div>;
}
