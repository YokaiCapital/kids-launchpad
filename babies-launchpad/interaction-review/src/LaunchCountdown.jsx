import {useEffect,useState} from 'react';
import {RocketLaunch} from '@phosphor-icons/react';
import schedule from './public-launch.json';
import './launch-countdown.css';
const opensAt=Date.parse(schedule.opensAt);
export function LaunchCountdown(){
 const [now,setNow]=useState(Date.now);
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 const remaining=Math.max(0,Math.ceil((opensAt-now)/1000));
 const units=[['Hours',Math.floor(remaining/3600)],['Minutes',Math.floor(remaining/60)%60],['Seconds',remaining%60]];
 return <section className="public-launch"><div className="launch-emblem"><RocketLaunch size={36}/></div><p className="eyebrow">YOUR PARENTS. YOUR COIN.</p><h1>{remaining?`Public launches open in ${Math.ceil(remaining/3600)} ${Math.ceil(remaining/3600)===1?'hr':'hrs'}.`:'Public launches opening soon.'}</h1><p className="launch-subtitle">Two communities. Your next kid.</p><div className="launch-countdown" role="timer" aria-label="Time until public launches">{units.map(([label,value])=><div key={label}><strong>{String(value).padStart(2,'0')}</strong><span>{label}</span></div>)}</div><p className="launch-opens">{remaining?'Opens':'Scheduled opening'} <time dateTime={schedule.opensAt}>{new Date(opensAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'})}</time></p></section>;
}
