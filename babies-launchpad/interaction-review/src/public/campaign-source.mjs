// Campaign data source for the public pages. Tries the API (plan §8); with no API it renders local fixtures only when
// the build explicitly asked for them (VITE_KIDS_PUBLIC_LAUNCHES_FIXTURES='1'). A production build never bundles them.
import {normalizeCampaign,normalizeManifest} from './campaign-adapter.mjs';
const FIXTURES=import.meta.env?.VITE_KIDS_PUBLIC_LAUNCHES_FIXTURES==='1';
const TIMEOUT_MS=8000;
/** Chain-aligned clock: the served chain time plus the seconds elapsed locally since it was read. */
export function makeClock(chainTimeUnix){const at=Date.now();const base=chainTimeUnix??Math.floor(at/1000);return()=>base+Math.floor((Date.now()-at)/1000);}
async function readApi(signal,{cursor=null,creator=null,query=null,mode=null,status=null,sort='newest'}={}){
 const params=new URLSearchParams({limit:'20'});for(const [key,value] of Object.entries({cursor,creator,q:query,mode,status,sort}))if(value)params.set(key,value);
 const res=await fetch('/api/account/launches/campaigns?'+params,{signal,headers:{accept:'application/json'}});
 if(!res.ok)throw new Error('The campaign API answered '+res.status+'.');
 const type=res.headers.get('content-type')||'';if(!type.includes('json'))throw new Error('The campaign API did not answer with JSON.');
 const body=await res.json();
 if(!body||!Array.isArray(body.campaigns)||body.campaigns.length>20||body.nextCursor!=null&&(typeof body.nextCursor!=='string'||body.nextCursor.length>200))throw new Error('The campaign API answer was malformed.');
 return {...body,fixture:false};
}
async function readFixtures(){
 const mod=await import('../../fixtures/public-launches.json');
 return {...(mod.default||mod),fixture:true};
}
/** Resolves to {campaigns:[vm], manifest, wallet, chainTimeUnix, fixture, fetchedAtUnix}. Rejects with a plain message. */
export async function loadCampaigns({signal=null,...filters}={}){
 const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),TIMEOUT_MS);
 const cancel=()=>ctrl.abort(signal?.reason);signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
 let raw;
 try{raw=await readApi(ctrl.signal,filters);}
 catch(e){
  if(signal?.aborted)throw e;
  if(!FIXTURES)throw new Error(e.name==='AbortError'?'The campaign API did not answer in time.':e.message||'The campaign API is unavailable.');
  raw=await readFixtures();
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
 const campaigns=[];const failures=[];
 for(const record of raw.campaigns||[]){try{campaigns.push(normalizeCampaign(record.view||record));}catch(e){failures.push(e.message);}}
 if((raw.campaigns||[]).length&&campaigns.length===0)throw new Error('Campaign data could not be read. Please retry.');
 return {nextCursor:raw.nextCursor||null,campaigns,manifest:normalizeManifest(raw.manifest)||null,wallet:raw.wallet||null,chainTimeUnix:raw.clock?.chainTimeUnix??raw.chainTimeUnix??null,fixture:raw.fixture===true,fetchedAtUnix:Math.floor(Date.now()/1000),failures};
}

export async function loadCampaign(id,{signal=null}={}){
 if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}(?::[1-9A-HJ-NP-Za-km-z]{32,44}:[1-9A-HJ-NP-Za-km-z]{32,44})?$/.test(id||''))return null;
 const response=await fetch('/api/account/launches/campaigns/'+id,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(TIMEOUT_MS)]):AbortSignal.timeout(TIMEOUT_MS),headers:{accept:'application/json'}});
 if(response.status===404)return null;if(!response.ok)throw Error('Launch status could not be loaded');
 const record=await response.json(),vm=normalizeCampaign(record.view||record);if(vm.id!==id&&vm.identity.campaign!==id)throw Error('Launch identity did not match the requested address');return vm;
}
