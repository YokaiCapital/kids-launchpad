// Bound each HTTP request. Abort the actual fetch rather than abandoning a live
// request with Promise.race. Transaction ambiguity is handled by durable intents.
export function boundedRpcFetch({fetchImpl=globalThis.fetch,timeoutMs=15000}={}){
 return (url,init={})=>fetchImpl(url,{...init,signal:init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)});
}
