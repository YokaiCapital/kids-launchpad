import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {Question} from '@phosphor-icons/react';
import './help.css';
const EDGE=12,GAP=8;
const hoverPointer=()=>typeof window!=='undefined'&&typeof window.matchMedia==='function'&&window.matchMedia('(hover:hover) and (pointer:fine)').matches;
const keyboardFocus=el=>{try{return el.matches(':focus-visible');}catch{return true;}};
/**
 * Shared open/close and placement for the small popovers (Help and Exact). Hover or keyboard focus opens on a desktop
 * pointer; a tap toggles it on touch. Escape, an outside click or leaving the trigger closes it. The panel is placed
 * below the trigger, flipped above when there is no room, and shifted sideways to stay on screen.
 */
function usePopover(content){
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
 },[open,content]);
 const rootProps={ref:root,onPointerEnter:e=>{if(e.pointerType==='mouse'&&hoverPointer())setOpen(true);},onPointerLeave:e=>{if(e.pointerType==='mouse'&&!pinned)setOpen(false);}};
 const buttonProps={ref:button,type:'button','aria-expanded':open,onFocus:e=>{if(keyboardFocus(e.currentTarget))setOpen(true);},onBlur:()=>{close();},onClick:()=>{if(open&&pinned){close();return;}setOpen(true);setPinned(true);}};
 return {id,open,place,panel,rootProps,buttonProps};
}
/**
 * A small "?" beside a term. The panel is a polite live region (toggletip pattern), so a screen reader hears the text
 * when it opens; the button's name says which term it explains.
 * The explanation is never the only place a number lives: the figure stays in the page, this only says what it means.
 */
export function Help({label,children,className=''}){
 const p=usePopover(children);
 return <span {...p.rootProps} className={'help'+(className?' '+className:'')}>
  <button {...p.buttonProps} className="help-button" aria-label={`What does '${label}' mean?`} aria-controls={p.id}>
   <Question size={18} weight="bold" aria-hidden="true"/>
  </button>
  <span id={p.id} role="status" aria-live="polite" className="help-live" onMouseDown={e=>e.preventDefault()}>
   {p.open&&<span ref={p.panel} className={'help-panel'+(p.place.above?' is-above':' is-below')} style={{left:p.place.left,'--help-arrow':p.place.arrow+'px'}}><b>{label}</b>{children}</span>}
  </span>
 </span>;
}
/**
 * The exact value behind a rounded one. The visible text is the rounded figure (or a short signature, a relative time,
 * a one-word tag); a tap, keyboard focus or hover reveals `detail` in the same panel Help uses. The detail is also the
 * button's description, so a screen reader hears it without opening anything. Nothing lives only in a title attribute.
 * Without a detail the children render as plain text.
 */
export function Exact({detail,label,children,className=''}){
 const p=usePopover(detail);
 if(detail==null||detail==='')return <>{children}</>;
 return <span {...p.rootProps} className={'exact'+(className?' '+className:'')}>
  <button {...p.buttonProps} className="exact-button" aria-describedby={p.id+'-d'}>{children}</button>
  <span id={p.id+'-d'} className="help-sr">{label?label+': ':'Exactly: '}{detail}</span>
  <span className="help-live" aria-hidden="true" onMouseDown={e=>e.preventDefault()}>
   {p.open&&<span ref={p.panel} className={'help-panel is-exact'+(p.place.above?' is-above':' is-below')} style={{left:p.place.left,'--help-arrow':p.place.arrow+'px'}}>{label&&<b>{label}</b>}{detail}</span>}
  </span>
 </span>;
}
