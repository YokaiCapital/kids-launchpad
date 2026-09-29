import {isAddress} from '../registry/registry.mjs';import {providerFreshness} from './freshness.mjs';import {ACTIVITY_FILTERS} from '../../shared/public-activity.mjs';
export function createPublicActivityReader({store,genesisHash,programId,now=Date.now,cacheMs=2000,maxEntries=500}){
 if(!isAddress(genesisHash)||!isAddress(programId)||!store?.status||!store?.page||!Number.isInteger(cacheMs)||cacheMs<0||cacheMs>5000||!Number.isInteger(maxEntries)||maxEntries<1||maxEntries>2000)throw Error('Scoped shared activity reader required');const cache=new Map();
 async function read({campaign,filter='movements',cursor=null,limit=8}={}){
  if(!isAddress(campaign)||!ACTIVITY_FILTERS.includes(filter)||!Number.isInteger(limit)||limit<1||limit>50||cursor!==null&&(typeof cursor!=='string'||cursor.length>150||!/^[0-9A-Za-z:.]+$/.test(cursor)))throw Error('Invalid activity read');
  const id={genesisHash,programId,campaign},key=JSON.stringify([campaign,filter,cursor,limit]),hit=cache.get(key);if(hit&&(hit.pending||hit.until>now()))return hit.promise;
  if(cache.size>=maxEntries)for(const [k,v]of cache)if(!v.pending){cache.delete(k);break;}
  if(cache.size>=maxEntries)throw Object.assign(Error('Activity reader capacity'),{code:'CAPACITY_WAIT'});
  const entry={pending:true,until:0,promise:null};cache.set(key,entry);
  entry.promise=Promise.resolve().then(async()=>{
   const state=await store.status(id),at=now();if(!state)return {...id,available:false,commitment:'finalized',status:'not-indexed'};
   const page=await store.page(id,{filter,before:cursor,limit}),provider=providerFreshness(state.providerHead,at),age=state.updatedAt==null?null:Math.max(0,at-state.updatedAt),stale=provider.stale||age===null||age>30000||state.updatedAt>at+5000;
   return {...id,available:true,mint:state.identity.mint,coinDecimals:state.identity.coinDecimals,commitment:'finalized',filter,...page,status:state.failed?'indexing-error':stale?'stale':state.complete&&!state.historyUnavailable?'live':'partial',freshness:{updatedAt:state.updatedAt,stale,provider},coverage:{complete:state.complete&&!state.failed&&!state.historyUnavailable,historyUnavailable:state.historyUnavailable},at};
  }).then(result=>{entry.pending=false;entry.until=now()+cacheMs;return result;},error=>{cache.delete(key);throw error;});return entry.promise;
 }
 return {read};
}
