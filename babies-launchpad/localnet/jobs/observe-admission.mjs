import {WORKER_LANES} from './lanes.mjs';
import {validateAdmissionPolicy,admissionDecision} from '../registry/admission.mjs';
export const ADMISSION_KINDS=Object.freeze(['rpc','signer','signerRpc']);
const label=x=>typeof x==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(x);
export function observationResources(resources={}){
 if(!resources||typeof resources!=='object'||Array.isArray(resources)||Object.keys(resources).some(k=>!ADMISSION_KINDS.includes(k)))throw Error('Explicit RPC/signer resources required');
 for(const [kind,value]of Object.entries(resources)){
  if(label(value))continue;
  if(kind==='signerRpc'||!value||typeof value!=='object'||Array.isArray(value)||!Object.keys(value).length||Object.entries(value).some(([lane,name])=>!Object.hasOwn(WORKER_LANES,lane)||!label(name)))throw Error('Invalid bounded admission observation map');
 }
 return structuredClone(resources);
}
export async function observeAdmission(registry,resources,at){
 const admission={},alerts=[],cache=new Map();
 async function resource(name){
  if(cache.has(name))return cache.get(name);
  const row=(await registry.query('SELECT policy_json FROM admission_policies WHERE resource=?',[name])).rows[0];
  if(!row){cache.set(name,null);return null;}
  const result={policy:validateAdmissionPolicy(JSON.parse(row.policy_json)),buckets:(await registry.query('SELECT lane,tokens_micro,updated_ms FROM admission_buckets WHERE resource=?',[name])).rows};
  cache.set(name,result);return result;
 }
 for(const kind of ADMISSION_KINDS){
  const configured=resources[kind];if(!configured){admission[kind]={status:'not-configured'};continue;}
  const mapped=typeof configured!=='string',entries=mapped?Object.entries(configured):[[null,configured]],headroom={};let missing=false;
  for(const [selected,name]of entries){
   const data=await resource(name);if(!data){missing=true;continue;}
   const allowed=kind==='signerRpc'?['signer']:Object.keys(WORKER_LANES);
   const lanes=selected?[selected]:Object.keys(data.policy.lanes).filter(l=>allowed.includes(l));
   if(!lanes.length)missing=true;
   for(const lane of lanes){
    const limit=data.policy.lanes[lane];if(!limit){missing=true;continue;}
    const d=admissionDecision({bucket:data.buckets.find(b=>b.lane===lane),limit,cost:1,now:at});
    headroom[lane]={availableRequests:d.result.remaining+(d.result.allowed?1:0),retryAfterMs:d.result.retryAfterMs,ratePerSecond:limit.ratePerSecond,burst:limit.burst};
   }
  }
  admission[kind]={status:missing?'unavailable':'observed',lanes:headroom};
  if(missing)alerts.push({code:'admission-unavailable',lane:kind});
 }
 return {admission,alerts};
}
