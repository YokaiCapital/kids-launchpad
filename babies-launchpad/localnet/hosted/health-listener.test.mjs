import test from 'node:test';import assert from 'node:assert/strict';
import {createHealthListener,healthPort} from './health-listener.mjs';
test('health listener: alive always, ready only once the role started, nothing else served',async()=>{
 let ready=false;const h=createHealthListener({role:'worker-lifecycle',ready:()=>ready});
 const address=await h.listen(0,'127.0.0.1');const base='http://127.0.0.1:'+address.port;
 try{
  const alive=await fetch(base+'/healthz');assert.equal(alive.status,200);assert.deepEqual(await alive.json(),{status:'alive',role:'worker-lifecycle'});
  const starting=await fetch(base+'/readyz');assert.equal(starting.status,503);assert.equal((await starting.json()).status,'starting');
  ready=true;const ok=await fetch(base+'/readyz');assert.equal(ok.status,200);assert.equal((await ok.json()).status,'ready');
  assert.equal(ok.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(base+'/readyz',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/anything')).status,404);
  assert.equal((await fetch(base+'/')).status,404);
 }finally{await h.close();}
 await assert.rejects(fetch(base+'/healthz'),'closed listener answers nothing');
});
test('health listener validation and PORT parsing',()=>{
 assert.throws(()=>createHealthListener({role:'Bad Role'}));assert.throws(()=>createHealthListener({role:'x',ready:1}));
 assert.equal(healthPort({}),null);assert.equal(healthPort({PORT:''}),null);assert.equal(healthPort({PORT:'8080'}),8080);
 for(const bad of ['0','65536','abc','80.5'])assert.throws(()=>healthPort({PORT:bad}));
});
