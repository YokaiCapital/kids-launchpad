import {useState} from 'react';
import {Play} from '@phosphor-icons/react';
import {PfpPreview} from '../CoinPfp';
/**
 * Coin picture. A missing image is a quiet initial-letter placeholder, never the platform mascot (spec §4, §5).
 * With `preview` the picture opens the site's larger portalled copy on hover, focus or tap.
 */
export function Pfp({src,name,size=56,preview=false,className=''}){
 const [failed,setFailed]=useState(false);
 const letter=(name||'?').trim().charAt(0).toUpperCase()||'?';
 if(!src||failed)return <span className={('pl-pfp pl-pfp-letter '+className).trim()} style={{width:size,height:size,fontSize:Math.round(size*.4)}} role="img" aria-label={name?name+' has no picture yet':'No picture yet'}>{letter}</span>;
 const img=<img className={('pl-pfp '+className).trim()} src={src} alt={name?name+' picture':''} width={size} height={size} decoding="async" loading="lazy" onError={()=>setFailed(true)}/>;
 return preview?<span className="pl-pfp-btn-wrap"><PfpPreview src={src} name={name||'coin'}>{img}</PfpPreview></span>:img;
}
/**
 * CoinMedia (spec §5): optional 16:9 video (click to play, no autoplay, no autoplay audio) and the short introduction.
 * A missing video removes the slot entirely; an empty description says so instead of showing sample text. The poster is
 * an <img> (never a string-built CSS url()); every media URL was validated by the adapter (media-hosts.mjs).
 */
export function CoinMedia({vm}){
 const [playing,setPlaying]=useState(false);
 const video=vm.media.video;
 return <div className="pl-media">
  {video&&<div>
   <div className="pl-video">
    {playing?<video src={video} controls autoPlay playsInline aria-label={vm.name+' video'}/>:
     <button type="button" className="pl-video-play" onClick={()=>setPlaying(true)} aria-label={'Play the '+vm.name+' video'} style={{all:'unset',position:'absolute',inset:0,cursor:'pointer',display:'grid',placeItems:'center',background:'#0f0a16'}}>
      {vm.media.poster&&<img className="pl-video-poster" src={vm.media.poster} alt="" decoding="async" loading="lazy"/>}
      <span style={{position:'relative',display:'inline-grid',placeItems:'center',width:64,height:64,borderRadius:'50%',background:'rgba(255,119,206,.92)',color:'#250d2a'}}><Play size={30} weight="fill" aria-hidden="true"/></span>
     </button>}
   </div>
   {vm.media.videoCaption&&<p className="pl-video-caption">{vm.media.videoCaption}</p>}
  </div>}
  <p className={'pl-about'+(vm.description?'':' is-empty')}>{vm.description||'The creator has not written an introduction yet.'}</p>
 </div>;
}
