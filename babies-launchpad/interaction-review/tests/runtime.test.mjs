import test from 'node:test';import assert from 'node:assert/strict';import {createApiServer,FINANCIAL_WRITE_PATHS} from '../server/runtime.mjs';
async function fixture(probe){const app=createApiServer({probe,plugins:[{configurePreviewServer({middlewares}){middlewares.use(async(req,res,next)=>{if(req.url==='/api/check'){res.setHeader('Content-Type','application/json');res.end('{"ok":true}');}else if(req.url==='/api/error')throw Error('private detail');else next();});}}]});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));return {...app,url:'http://127.0.0.1:'+app.server.address().port};}
test('standalone runtime routes APIs and fails closed when readiness fails',async()=>{let ready=false;const app=await fixture(async()=>ready);try{await app.check();assert.equal((await fetch(app.url+'/_health/ready')).status,503);ready=true;await app.check();assert.equal((await fetch(app.url+'/_health/ready')).status,200);assert.deepEqual(await(await fetch(app.url+'/api/check')).json(),{ok:true});assert.equal((await fetch(app.url+'/src/main.jsx')).status,404);assert.equal((await fetch(app.url+'/api/missing')).status,404);const error=await fetch(app.url+'/api/error');assert.equal(error.status,500);assert.doesNotMatch(await error.text(),/private detail/);ready=false;await app.check();assert.equal((await fetch(app.url+'/_health/ready')).status,503);}finally{await app.shutdown();}});

test('financial writes stay closed until the startup reconciliation gate opens while readiness follows the ledger probe; reads and other routes still work',async()=>{
 const gate={open:false,report:{complete:false,unresolvedSigned:2,at:'t0'}};
 const app=createApiServer({probe:async()=>true,writesGate:gate,plugins:[{configurePreviewServer({middlewares}){middlewares.use(async(req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({route:req.url,method:req.method}));});}}]});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+app.server.address().port;
 try{
  await app.check();
  // Readiness follows the ledger probe; the write gate is reported separately and keeps money routes closed.
  let r=await fetch(url+'/_health/ready');assert.equal(r.status,200);let body=await r.json();assert.equal(body.writesOpen,false);assert.deepEqual(body.reconciliation,{complete:false,unresolvedSigned:2,at:'t0'});
  r=await fetch(url+'/api/account/prelaunch/submit',{method:'POST'});assert.equal(r.status,503);assert.match((await r.json()).error,/reconciled/);
  for(const path of ['/api/account/postlaunch/claim/prepare','/api/account/postlaunch/trade/execute','/api/account/prelaunch-legacy/submit'])assert.equal((await fetch(url+path,{method:'POST'})).status,503,path);
  assert.equal((await fetch(url+'/api/account/prelaunch',{method:'GET'})).status,200,'reads pass');
  assert.equal((await fetch(url+'/api/account/logout',{method:'POST'})).status,200,'non-financial writes pass');
  assert.ok(FINANCIAL_WRITE_PATHS.test('/api/account/postlaunch/claim')&&!FINANCIAL_WRITE_PATHS.test('/api/account/postlaunch'));
  gate.open=true;gate.report={complete:true,unresolvedSigned:0,at:'t1'};
  r=await fetch(url+'/_health/ready');assert.equal(r.status,200);r=await fetch(url+'/api/account/prelaunch/submit',{method:'POST'});assert.equal(r.status,200);
 }finally{await app.shutdown();}
});
