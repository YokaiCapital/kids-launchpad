import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {X} from '@phosphor-icons/react';
import './coin-pfp.css';
export const SHART_PFP='/assets/shart-pfp.png';
const MAX=280,EDGE=12,GAP=12,LEAVE_MS=140;
const hoverPointer=()=>typeof window!=='undefined'&&typeof window.matchMedia==='function'&&window.matchMedia('(hover:hover) and (pointer:fine)').matches;
const keyboardFocus=el=>{try{return el.matches(':focus-visible');}catch{return true;}};
/**
 * Shartcoin profile picture. Falls back to the typographic S! mark when the image cannot load, so the slot never goes blank.
 * With `preview` the picture becomes a button: hover or keyboard focus opens a larger, sharp copy beside it (tap on touch),
 * rendered in a portal so no card clips it and nothing in the page moves.
 */
export function CoinPfp({src=SHART_PFP,alt='Shartcoin',className='',size=68,preview=false,name='Shartcoin'}){
 const [failed,setFailed]=useState(false);
 if(failed)return <span className={('shart-mark coin-pfp-fallback '+className).trim()} aria-hidden="true">S!</span>;
 const img=<img className={('coin-pfp '+className).trim()} src={src} alt={alt} width={size} height={size} decoding="async" onError={()=>setFailed(true)}/>;
 return preview?<PfpPreview src={src} name={name}>{img}</PfpPreview>:img;
}
/**
 * The larger preview. Placement: to the right of the avatar, else to the left, else below or above; always top-aligned
 * with the avatar when beside it and clamped inside the viewport. The box takes the image's real aspect ratio, sized
 * from the avatar's already-loaded natural dimensions, so it opens at its final size with no reflow.
 * Pointer: opens on enter, survives the move into the panel, closes 140 ms after leaving both. Click or tap pins it;
 * Escape, the close button or an outside tap closes it. Keyboard: focus opens, Escape closes and returns focus.
 */
function PfpPreview({src,name,children}){
 const id=useId(),trigger=useRef(null),panel=useRef(null),leave=useRef(null),pinnedRef=useRef(false);
 const [open,setOpen]=useState(false),[pinned,setPinnedState]=useState(false),[box,setBox]=useState(null);
 const setPinned=v=>{pinnedRef.current=v;setPinnedState(v);};
 const close=()=>{clearTimeout(leave.current);setOpen(false);setPinned(false);};
 const show=()=>{clearTimeout(leave.current);setOpen(true);};
 const scheduleLeave=()=>{clearTimeout(leave.current);leave.current=setTimeout(()=>{if(!pinnedRef.current)setOpen(false);},LEAVE_MS);};
 useEffect(()=>()=>clearTimeout(leave.current),[]);
 useEffect(()=>{
  if(!open)return;
  const onKey=e=>{if(e.key==='Escape'){e.stopPropagation();close();trigger.current?.focus({preventScroll:true});}};
  const onDown=e=>{if(!trigger.current?.contains(e.target)&&!panel.current?.contains(e.target))close();};
  document.addEventListener('keydown',onKey,true);document.addEventListener('pointerdown',onDown,true);
  return()=>{document.removeEventListener('keydown',onKey,true);document.removeEventListener('pointerdown',onDown,true);};
 },[open]);
 useLayoutEffect(()=>{
  if(!open){setBox(null);return;}
  const measure=()=>{
   const t=trigger.current;if(!t)return;
   const r=t.getBoundingClientRect(),vw=document.documentElement.clientWidth,vh=window.innerHeight;
   const img=t.querySelector('img');const nw=img?.naturalWidth||1,nh=img?.naturalHeight||1;
   const limit=Math.max(96,Math.min(MAX,vw-2*EDGE,vh-2*EDGE));
   const scale=Math.min(limit/nw,limit/nh);const w=Math.round(nw*scale),h=Math.round(nh*scale);
   let side='right',left=r.right+GAP,top=r.top;
   if(left+w>vw-EDGE){
    if(r.left-GAP-w>=EDGE){side='left';left=r.left-GAP-w;}
    else{left=Math.max(EDGE,Math.min(r.left,vw-EDGE-w));side=r.bottom+GAP+h<=vh-EDGE||r.top-GAP-h<EDGE?'below':'above';top=side==='below'?r.bottom+GAP:r.top-GAP-h;}
   }
   top=Math.max(EDGE,Math.min(top,vh-EDGE-h));
   setBox({left,top,w,h,side});
  };
  measure();window.addEventListener('resize',measure);window.addEventListener('scroll',measure,true);
  return()=>{window.removeEventListener('resize',measure);window.removeEventListener('scroll',measure,true);};
 },[open]);
 const panelHasFocus=target=>!!target&&!!panel.current?.contains(target);
 return <>
  <button ref={trigger} type="button" className="coin-pfp-trigger" aria-label={'Show a larger '+name+' picture'} aria-haspopup="dialog" aria-expanded={open} aria-controls={open?id:undefined}
   onPointerEnter={e=>{if(e.pointerType==='mouse'&&hoverPointer())show();}} onPointerLeave={e=>{if(e.pointerType==='mouse')scheduleLeave();}}
   onFocus={e=>{if(keyboardFocus(e.currentTarget))show();}} onBlur={e=>{if(!panelHasFocus(e.relatedTarget))close();}}
   onClick={()=>{if(open&&pinned){close();return;}show();setPinned(true);}}>{children}</button>
  {open&&createPortal(
   <div ref={panel} id={id} role="dialog" aria-label={name+' picture, larger'} className={'coin-pfp-preview is-'+(box?.side||'right')} style={box?{left:box.left,top:box.top,width:box.w,height:box.h}:{visibility:'hidden',left:0,top:0}}
    onPointerEnter={e=>{if(e.pointerType==='mouse')show();}} onPointerLeave={e=>{if(e.pointerType==='mouse')scheduleLeave();}}>
    <img src={src} alt="" width={box?.w||MAX} height={box?.h||MAX} decoding="async" draggable="false"/>
    <button type="button" className="coin-pfp-close" aria-label="Close picture" onClick={()=>{close();trigger.current?.focus({preventScroll:true});}} onBlur={e=>{if(e.relatedTarget!==trigger.current&&!panelHasFocus(e.relatedTarget))close();}}><X size={15} weight="bold" aria-hidden="true"/></button>
   </div>,document.body)}
 </>;
}
