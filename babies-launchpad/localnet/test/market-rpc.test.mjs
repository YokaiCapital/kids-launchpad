// Reliability rules: transient failures retry with backoff and jitter under a deadline; invalid, auth and malformed
// fail at once; 429 honours Retry-After; the URL never appears in an error.
import test from 'node:test';import assert from 'node:assert/strict';
import {createRpcClient,classifyFailure,isTransient} from '../market/rpc.mjs';
const URL='https://rpc.example/?api-key=SECRET-KEY';
const reply=(status,body,headers={})=>({ok:status>=200&&status<300,status,headers:{get:k=>headers[k.toLowerCase()]??null},json:async()=>{if(body==='broken')throw new SyntaxError('bad json');return body;}});
function client(script,overrides={}){
 let i=0;const calls=[],sleeps=[];
 const fetchImpl=async(url,init)=>{calls.push(JSON.parse(init.body).method);const step=script[Math.min(i,script.length-1)];i++;if(step instanceof Error)throw step;if(typeof step==='function')return step();return step;};
 const rpc=createRpcClient({url:URL,fetchImpl,sleep:async ms=>{sleeps.push(ms);},random:()=>0.5,baseDelayMs:100,maxDelayMs:5000,...overrides});
 return {rpc,calls,sleeps};
}
test('classification',()=>{
 assert.equal(classifyFailure({error:Object.assign(Error('x'),{name:'TimeoutError'})}),'timeout');
 assert.equal(classifyFailure({error:new TypeError('fetch failed')}),'network');
 assert.equal(classifyFailure({status:429}),'rate-limited');assert.equal(classifyFailure({status:503}),'upstream');assert.equal(classifyFailure({status:401}),'auth');assert.equal(classifyFailure({status:400}),'invalid');
 assert.equal(classifyFailure({rpcError:{code:-32005}}),'node-behind');assert.equal(classifyFailure({rpcError:{code:-32602}}),'invalid');assert.equal(classifyFailure({rpcError:{code:-32015}}),'unsupported-version');assert.equal(isTransient('unsupported-version'),false);
 assert.deepEqual(['timeout','network','rate-limited','upstream','node-behind'].map(isTransient),[true,true,true,true,true]);assert.equal(isTransient('invalid'),false);
});
test('transient then success: timeout, 503, node-behind, then the result; backoff grows with jitter',async()=>{
 const {rpc,sleeps}=client([Object.assign(Error('t'),{name:'TimeoutError'}),reply(503,null),reply(200,{jsonrpc:'2.0',id:1,error:{code:-32005,message:'Node is behind'}}),reply(200,{jsonrpc:'2.0',id:1,result:{ok:1}})]);
 assert.deepEqual(await rpc.call('getHealth'),{ok:1});
 assert.deepEqual(sleeps,[150,250,450]);assert.equal(rpc.stats().retries,3);assert.equal(rpc.stats().failures,0);
});
test('429 waits for Retry-After and stays unresolved after the attempt budget (never an empty success)',async()=>{
 const {rpc,sleeps}=client([reply(429,null,{'retry-after':'2'})],{maxAttempts:3});
 await assert.rejects(rpc.call('getSignaturesForAddress',[]),e=>e.name==='RpcError'&&e.category==='exhausted'&&e.attempts===3&&e.status===429);
 assert.deepEqual(sleeps,[2000,2000]);assert.equal(rpc.stats().byCategory.exhausted,1);
});
test('permanent failures do not retry: invalid request, auth, malformed body, malformed envelope',async()=>{
 for(const [step,category] of [[reply(400,null),'invalid'],[reply(403,null),'auth'],[reply(200,'broken'),'malformed'],[reply(200,{jsonrpc:'2.0'}),'malformed'],[reply(200,{jsonrpc:'2.0',error:{code:-32602,message:'Invalid params'}}),'invalid']]){
  const {rpc,calls}=client([step]);await assert.rejects(rpc.call('getTransaction',['x']),e=>e.category===category);assert.equal(calls.length,1,category+' made exactly one call');
 }
});
test('the operation deadline stops retries even when attempts remain; errors never carry the URL or key',async()=>{
 let t=0;const {rpc}=client([reply(503,null)],{maxAttempts:10,deadlineMs:1000,now:()=>{t+=600;return t;}});
 await assert.rejects(rpc.call('getBlockTime',[1]),e=>e.category==='exhausted'&&e.attempts===2&&!/SECRET|rpc\.example/.test(e.message));
 assert.ok(!JSON.stringify(rpc.stats()).includes('SECRET'));
});
test('a null result is returned as null (the caller decides it is unresolved, not empty)',async()=>{
 const {rpc}=client([reply(200,{jsonrpc:'2.0',id:1,result:null})]);assert.equal(await rpc.call('getTransaction',['x']),null);
});
