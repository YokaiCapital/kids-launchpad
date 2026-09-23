import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {Question} from '@phosphor-icons/react';
import './help.css';
const EDGE=12,GAP=8;
const hoverPointer=()=>typeof window!=='undefined'&&typeof window.matchMedia==='function'&&window.matchMedia('(hover:hover) and (pointer:fine)').matches;
const keyboardFocus=el=>{try{return el.matches(':focus-visible');}catch{return true;}};
/**
 * A small "?" beside a term. Hover or keyboard focus opens it on a desktop pointer; a tap toggles it on touch.
 * Escape, an outside click or leaving the button closes it. The panel is a polite live region (toggletip pattern),
 * so a screen reader hears the text when it opens; the button's name says which term it explains.
 * The explanation is never the only place a number lives: the figure stays in the page, this only says what it means.
 */
export function Help({label,children,className=''}){
 const id=useId(),root=useRef(null),button=useRef(null),panel=useRef(null);
 const [open,setOpen]=useState(false),[pinned,setPinned]=useState(false),[place,setPlace]=useState({left:0,above:false,arrow:0});
 const close=()=>{setOpen(false);setPinned(false);};
 useEffect(()=>{
  if(!open)return;
  const onKey=e=>{if(e.key==='Escape'){e.stopPropagation();close();button.current?.focus({preventScroll:true});}};
  const onDown=e=>{if(root.current&&!root.current.contains(e.target))close();};
  document.addEventListener('keydown',onKey,true);document.addEventListener('pointerdown',onDown,true);
  return()=>{document.removeEventListener('keydown',onKey,true);document.removeEventListener('pointerdown',onDown,true);};
 },[open]);
 // Viewport-aware placement: below the icon, flipped above when there is no room; shifted sideways to stay on screen.
 useLayoutEffect(()=>{
  if(!open||!button.current||!panel.current)return;
  const measure=()=>{
   const b=button.current.getBoundingClientRect(),p=panel.current.getBoundingClientRect(),vw=document.documentElement.clientWidth,vh=window.innerHeight;
   const centre=b.left+b.width/2;let left=centre-p.width/2;left=Math.max(EDGE,Math.min(left,vw-EDGE-p.width));
   const above=b.bottom+GAP+p.height>vh-EDGE&&b.top-GAP-p.height>EDGE;
   setPlace({left:left-b.left,above,arrow:centre-left});
  };
  measure();window.addEventListener('resize',measure);window.addEventListener('scroll',measure,true);
  return()=>{window.removeEventListener('resize',measure);window.removeEventListener('scroll',measure,true);};
 },[open,children]);
 return <span ref={root} className={'help'+(className?' '+className:'')} onPointerEnter={e=>{if(e.pointerType==='mouse'&&hoverPointer())setOpen(true);}} onPointerLeave={e=>{if(e.pointerType==='mouse'&&!pinned)setOpen(false);}}>
  <button ref={button} type="button" className="help-button" aria-label={`What does '${label}' mean?`} aria-expanded={open} aria-controls={id}
   onFocus={e=>{if(keyboardFocus(e.currentTarget))setOpen(true);}} onBlur={()=>{close();}}
   onClick={()=>{if(open&&pinned){close();return;}setOpen(true);setPinned(true);}}>
   <Question size={18} weight="bold" aria-hidden="true"/>
  </button>
  <span id={id} role="status" aria-live="polite" className="help-live" onMouseDown={e=>e.preventDefault()}>
   {open&&<span ref={panel} className={'help-panel'+(place.above?' is-above':' is-below')} style={{left:place.left,'--help-arrow':place.arrow+'px'}}><b>{label}</b>{children}</span>}
  </span>
 </span>;
}
