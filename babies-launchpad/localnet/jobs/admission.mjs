// A role binds its lane once at startup. Callers cannot pick a higher-priority lane
// per request. This controls request capacity; it NEVER raises signer spend limits.
import {validateAdmissionPolicy} from '../registry/admission.mjs';
export function createAdmissionGuard({registry,resource,lane,policy}){
 if(!registry?.admission)throw Error('Shared admission registry required');
 const pinned=validateAdmissionPolicy(policy);
 if(!Object.hasOwn(pinned.lanes,lane))throw Error('Service lane has no reserved capacity');
 return async function admit({cost=1}={}){
  const result=await registry.admission.consume({resource,lane,policy:pinned,cost});
  if(!result.allowed)throw Object.assign(Error('Reserved upstream capacity is busy'),{code:'CAPACITY_WAIT',retryAfterMs:result.retryAfterMs});
  return result;
 };
}

// Preserve Connection method binding while charging every RPC method invocation.
// Callers pass this at composition boundaries, never around a shared global.
export function admittedConnection(connection,admit){
 if(!connection||typeof admit!=='function')throw Error('Connection and shared admission required');
 return new Proxy(connection,{get(target,key){const value=Reflect.get(target,key);return typeof value==='function'?async(...args)=>{await admit({cost:1});return value.apply(target,args);}:value;}});
}
