import {useCallback,useEffect,useRef,useState} from 'react';
import {loadCampaigns} from './campaign-source.mjs';
import {loadPortfolioPage} from './portfolio-source.mjs';
import {accountApi} from '../Account';
const empty={status:'loading',campaigns:[],manifest:null,wallet:null,fixture:false,error:null,nextCursor:null};
/** One bounded directory page, with cancellation on scope/page change and no overlapping polling. */
export function useCampaignDirectory({creator=null,query=null,mode=null,status=null,sort='newest',portfolioOwner=null,enabled=true,onClock}){
 const scope=JSON.stringify({creator,query,mode,status,sort,portfolioOwner});
 const [paging,setPaging]=useState({scope,cursors:[null]}),[result,setResult]=useState(null);
 const cursors=paging.scope===scope?paging.cursors:[null],cursor=cursors.at(-1),key=scope+'|'+(cursor||'');
 const current=useRef(key),flight=useRef(null),clock=useRef(onClock);current.current=key;clock.current=onClock;
 const load=useCallback(async({quiet=false}={})=>{
  if(!enabled)return;
  if(flight.current?.key===key)return flight.current.promise;
  flight.current?.controller.abort();const controller=new AbortController(),entry={key,controller};flight.current=entry;
  if(!quiet)setResult(s=>({key,value:{...(s?.key===key?s.value:empty),status:'loading',error:null}}));
  entry.promise=(async()=>{
   try{const value=await (portfolioOwner?loadPortfolioPage({owner:portfolioOwner,cursor,signal:controller.signal},accountApi):loadCampaigns({...JSON.parse(scope),cursor,signal:controller.signal}));if(current.current!==key||controller.signal.aborted)return;clock.current?.(value.chainTimeUnix);setResult({key,value:{status:'ready',...value,error:null}});}
   catch(e){if(current.current!==key||controller.signal.aborted)return;setResult(s=>({key,value:{...(s?.key===key?s.value:empty),status:'error',error:e.message}}));}
   finally{if(flight.current===entry)flight.current=null;}
  })();return entry.promise;
 },[key,scope,cursor,portfolioOwner,enabled]);
 useEffect(()=>{load();const timer=setInterval(()=>{if(!document.hidden)load({quiet:true});},30000);return()=>{clearInterval(timer);flight.current?.controller.abort();flight.current=null;};},[load]);
 const value=enabled&&result?.key===key?result.value:empty;
 return {...value,retry:load,page:cursors.length,hasPrevious:cursors.length>1,
  previous:()=>setPaging({scope,cursors:cursors.slice(0,-1)}),
  next:()=>{if(value.status==='ready'&&value.nextCursor&&!cursors.includes(value.nextCursor))setPaging({scope,cursors:[...cursors,value.nextCursor]});}};
}
