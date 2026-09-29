// Bound admission and HTTP in one request deadline. Short capacity waits retain
// progress within an active job; they never borrow another lane's quota or retry
// an RPC broadcast. Long congestion still yields through the durable scheduler.
import {setTimeout as pause} from 'node:timers/promises';
export function boundedRpcFetch({fetchImpl=globalThis.fetch,timeoutMs=15000,admit=null,admissionWaitMs=0}={}){
 if(!Number.isInteger(admissionWaitMs)||admissionWaitMs<0||admissionWaitMs>5000)throw Error('Invalid RPC admission wait');
 return async(url,init={})=>{
  init.signal?.throwIfAborted();
  const signal=init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
  if(admit)await waitForRpcAdmission(admit,{waitMs:admissionWaitMs,signal});
  signal.throwIfAborted();
  return fetchImpl(url,{...init,signal});
 };
}

// Shared with the JSON-RPC indexer, which owns its HTTP deadline separately.
export async function waitForRpcAdmission(admit,{waitMs=0,signal}={}){
 if(!Number.isInteger(waitMs)||waitMs<0||waitMs>5000)throw Error('Invalid RPC admission wait');
 const until=performance.now()+waitMs;
 for(;;){
  signal?.throwIfAborted();
  try{return await admit({cost:1});}
  catch(e){
   const left=until-performance.now();
   if(e?.code!=='CAPACITY_WAIT'||left<=0||waitMs===0)throw e;
   await pause(Math.min(left,Math.max(10,Math.min(1000,Number(e.retryAfterMs)||100))),undefined,{signal});
  }
 }
}
