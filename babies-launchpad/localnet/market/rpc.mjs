// Bounded JSON-RPC client for the market worker (reliability rules, 20 September 2026): classify every failure,
// retry only transient ones (network, timeout, 429 with Retry-After, 5xx, node-behind RPC codes) with exponential
// backoff plus jitter, a real per-request abort and an operation deadline; invalid requests, auth failures and
// malformed responses fail at once. The endpoint URL is never part of any error message or log line.
// Block not available, node unhealthy, slot skipped, minimum context slot not reached: the node is behind, not the request.
export const TRANSIENT_RPC_CODES=new Set([-32004,-32005,-32014,-32016]);
export class RpcError extends Error{
 constructor(message,{category,method,status=null,code=null,retryAfterMs=null,attempts=1}){super(message);this.name='RpcError';this.category=category;this.method=method;this.status=status;this.code=code;this.retryAfterMs=retryAfterMs;this.attempts=attempts;}
}
export function classifyFailure({error=null,status=null,rpcError=null}){
 if(error){if(error.name==='AbortError'||error.name==='TimeoutError')return 'timeout';if(error.name==='SyntaxError')return 'malformed';return 'network';}
 if(status!==null){if(status===429)return 'rate-limited';if(status>=500)return 'upstream';if(status===401||status===403)return 'auth';return 'invalid';}
 if(rpcError){if(rpcError.code===-32015)return 'unsupported-version';return TRANSIENT_RPC_CODES.has(rpcError.code)?'node-behind':'invalid';}
 return 'unknown';
}
export const isTransient=category=>['timeout','network','rate-limited','upstream','node-behind'].includes(category);
export function createRpcClient({url,fetchImpl=globalThis.fetch,timeoutMs=15000,maxAttempts=4,baseDelayMs=400,maxDelayMs=8000,deadlineMs=60000,random=Math.random,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}={}){
 if(typeof url!=='string'||!/^https?:\/\//.test(url))throw Error('RPC URL is required');
 const stats={calls:0,retries:0,failures:0,byCategory:{},lastError:null,lastErrorAt:null};
 let id=0;
 async function call(method,params=[]){
  const started=now();let lastCategory='unknown',lastMessage='';
  for(let attempt=1;attempt<=maxAttempts;attempt++){
   stats.calls++;
   let response,body;
   try{
    response=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:AbortSignal.timeout(timeoutMs)});
   }catch(error){lastCategory=classifyFailure({error});lastMessage=method+': '+lastCategory;}
   if(response){
    if(!response.ok){
     lastCategory=classifyFailure({status:response.status});lastMessage=method+': HTTP '+response.status;
     const retryAfter=Number(response.headers?.get?.('retry-after'));
     if(!isTransient(lastCategory))return fail(method,lastCategory,lastMessage,response.status,null,attempt);
     if(attempt<maxAttempts&&now()-started<deadlineMs){stats.retries++;await sleep(Math.min(maxDelayMs,retryAfter>0?retryAfter*1000:backoff(attempt)));continue;}
     return fail(method,'exhausted',lastMessage,response.status,null,attempt);
    }
    try{body=await response.json();}catch(error){return fail(method,'malformed',method+': malformed response body',response.status,null,attempt);}
    if(body&&typeof body==='object'&&body.error){
     lastCategory=classifyFailure({rpcError:body.error});lastMessage=method+': rpc '+body.error.code+' '+String(body.error.message||'').slice(0,120);
     if(!isTransient(lastCategory))return fail(method,lastCategory,lastMessage,200,body.error.code,attempt);
    }else if(body&&typeof body==='object'&&'result' in body)return body.result;
    else return fail(method,'malformed',method+': malformed JSON-RPC envelope',200,null,attempt);
   }
   if(attempt<maxAttempts&&now()-started<deadlineMs){stats.retries++;await sleep(backoff(attempt));continue;}
   return fail(method,'exhausted',lastMessage,response?.status??null,null,attempt);
  }
  return fail(method,'exhausted',lastMessage,null,null,maxAttempts);
 }
 function backoff(attempt){return Math.min(maxDelayMs,baseDelayMs*2**(attempt-1)+Math.floor(random()*baseDelayMs));}
 function fail(method,category,message,status,code,attempts){
  stats.failures++;stats.byCategory[category]=(stats.byCategory[category]||0)+1;stats.lastError=message.replace(/api[-_]?key=[^&\s"')]+/gi,'api-key=<redacted>');stats.lastErrorAt=now();
  throw new RpcError(stats.lastError,{category,method,status,code,attempts});
 }
 return {call,stats:()=>({...stats,byCategory:{...stats.byCategory}})};
}
