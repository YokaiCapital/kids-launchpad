import {useCallback,useEffect,useRef,useState} from 'react';
import {loadCampaign} from './campaign-source.mjs';
export function useCampaignDetail(id){
 const [result,setResult]=useState(null),flight=useRef(null),current=useRef(id);current.current=id;
 const load=useCallback(()=>{
  if(!id)return Promise.resolve();if(flight.current?.id===id)return flight.current.promise;
  flight.current?.controller.abort();const controller=new AbortController(),entry={id,controller};flight.current=entry;
  entry.promise=(async()=>{try{const vm=await loadCampaign(id,{signal:controller.signal});if(!controller.signal.aborted&&current.current===id)setResult({key:id,vm,error:null});}catch(e){if(!controller.signal.aborted&&current.current===id)setResult({key:id,vm:null,error:e.message});}finally{if(flight.current===entry)flight.current=null;}})();return entry.promise;
 },[id]);
 useEffect(()=>{load();const timer=setInterval(()=>{if(!document.hidden)load();},30000);return()=>{clearInterval(timer);flight.current?.controller.abort();flight.current=null;};},[load]);
 return {detail:result?.key===id?result:null,load};
}
