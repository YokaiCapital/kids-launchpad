import test from 'node:test';
import assert from 'node:assert/strict';
import {gatewayConfig,authorizeGateway,upstreamHeaders} from './gateway.mjs';
import {gatewayHeaders,trustedGatewayContext} from '../../shared/trusted-gateway.mjs';
import {guardLocalRequest} from '../../shared/local-http.mjs';
import {AccountStore} from '../server/account-store.mjs';
const env={KIDS_BACKEND_TOKEN:'service-test-'.repeat(4),KIDS_OPERATOR_BACKEND_TOKEN:'operator-test-'.repeat(4),KIDS_GATEWAY_INTERNAL_TOKEN:'internal-test-'.repeat(4),KIDS_GATEWAY_HOST:'gateway.example.test'};
const cfg=gatewayConfig(env),origin='https://kids.fun';
const req=(path='/api/account/state',method='GET',headers={})=>({url:path,method,headers:{host:cfg.host,origin,authorization:'Bearer '+cfg.service,...headers}});
const internal=(path='/api/account/state',role='viewer',secret=cfg.internal)=>({url:path,method:'GET',socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:4175',origin,...gatewayHeaders('GET',path,role,secret)}});
test('configuration fails closed without distinct long secrets',()=>{assert.throws(()=>gatewayConfig({}));assert.throws(()=>gatewayConfig({...env,KIDS_OPERATOR_BACKEND_TOKEN:env.KIDS_BACKEND_TOKEN}));});
test('service authentication plus exact host and origin required',()=>{assert.equal(authorizeGateway(req(),cfg).role,'viewer');for(const headers of [{authorization:''},{host:'attacker.test'},{origin:'https://attacker.test'},{origin:undefined}])assert.ok(authorizeGateway(req(undefined,undefined,headers),cfg).status>=400);});
test('admin routes are never served, even with the operator credential',()=>{for(const h of [{},{'x-kids-operator-token':cfg.operator}])assert.equal(authorizeGateway(req('/api/admin/state','GET',{'content-type':'application/json',...h}),cfg).status,404);});
test('local test identities require the independent operator credential',()=>{for(const [path,method] of [['/api/account/local','POST']]){assert.equal(authorizeGateway(req(path,method,{'content-type':'application/json'}),cfg).status,403);assert.equal(authorizeGateway(req(path,method,{'content-type':'application/json','x-kids-operator-token':cfg.operator}),cfg).role,'operator');}});
test('deny unknown paths, query strings, encoded traversal and demo writes',()=>{for(const path of ['/','/api/account/state?x=1','/api/account/%2e%2e/admin/state','/api/account/action','/api/admin/unknown'])assert.equal(authorizeGateway(req(path),cfg).status,404);assert.equal(authorizeGateway(req('/api/demo','POST',{'content-type':'application/json'}),cfg).status,404);});
test('content type, size and conflicting framing rejected',()=>{for(const headers of [{'content-type':'text/plain'},{'content-type':'application/json','content-length':'2000001'},{'content-type':'application/json','content-length':'1','transfer-encoding':'chunked'},{'content-type':'application/json','content-encoding':'gzip'}])assert.ok(authorizeGateway(req('/api/account/challenge','POST',headers),cfg).status>=400);});
test('upstream strips untrusted credentials and preserves only wallet session and CSRF',()=>{const r=req('/api/account/state','GET',{cookie:'unrelated=private; kids_session=abc123; __Host-kids_access=secret','x-kids-csrf':'a'.repeat(48),'x-kids-gateway-role':'operator','x-forwarded-host':'attacker'});const h=upstreamHeaders(r,cfg,'viewer',0);assert.equal(h.cookie,'kids_session=abc123');assert.equal(h.authorization,undefined);assert.equal(h['x-forwarded-host'],undefined);assert.equal(h['x-kids-gateway-role'],'viewer');assert.equal(h.origin,origin);assert.equal(h['x-kids-csrf'],'a'.repeat(48));});
test('signed context requires loopback and cannot be forged or replayed',()=>{const r=internal();assert.equal(trustedGatewayContext(r,{secret:cfg.internal}).origin,origin);assert.equal(trustedGatewayContext(r,{secret:cfg.internal}).operator,false);assert.equal(trustedGatewayContext({...r,headers:{...r.headers}},{secret:cfg.internal}),null);const remote=internal();remote.socket.remoteAddress='203.0.113.1';assert.equal(trustedGatewayContext(remote,{secret:cfg.internal}),null);const tampered=internal();tampered.headers['x-kids-gateway-role']='operator';assert.equal(trustedGatewayContext(tampered,{secret:cfg.internal}),null);});
test('signed context binds method, path, origin and expiration',()=>{for(const change of [{method:'POST'},{url:'/api/admin/state'},{headers:{origin:'https://other.test'}}]){const r=internal();const candidate={...r,...change,headers:{...r.headers,...change.headers}};assert.equal(trustedGatewayContext(candidate,{secret:cfg.internal}),null);}const r=internal();assert.equal(trustedGatewayContext(r,{secret:cfg.internal,now:Date.now()+16000}),null);});
test('local guard remains strict unless explicitly opted in',()=>{const prior=process.env.KIDS_GATEWAY_INTERNAL_TOKEN;process.env.KIDS_GATEWAY_INTERNAL_TOKEN=cfg.internal;try{const r=internal();assert.equal(guardLocalRequest(r,{port:4175}).body.error,'bad-origin');assert.equal(guardLocalRequest(r,{port:4175,allowGateway:true}),null);}finally{if(prior===undefined)delete process.env.KIDS_GATEWAY_INTERNAL_TOKEN;else process.env.KIDS_GATEWAY_INTERNAL_TOKEN=prior;}});
test('wallet challenge uses verified public application origin',()=>{const context=trustedGatewayContext(internal(),{secret:cfg.internal}),store=new AccountStore({origin:context.origin});try{const challenge=store.challenge('11111111111111111111111111111111');assert.match(challenge.message,/kids.fun wants you to sign in/);assert.match(challenge.message,/URI: https:\/\/kids.fun\n/);assert.doesNotMatch(challenge.message,/localhost/);}finally{store.close();}});

test('100 mixed authenticated reads queue with eight upstream requests and preserve private sessions',async()=>{
 const {createGateway}=await import('./gateway.mjs');const {PassThrough}=await import('node:stream');const {EventEmitter}=await import('node:events');let active=0,peak=0;
 const server=createGateway(cfg,{requestUpstream(options,callback){const outgoing=new EventEmitter();outgoing.destroy=()=>outgoing.emit('error',Error('closed'));outgoing.end=()=>{active++;peak=Math.max(peak,active);setTimeout(()=>{const response=new PassThrough();response.headers={'content-type':'application/json'};response.statusCode=200;callback(response);active--;response.end(JSON.stringify({path:options.path,session:options.headers.cookie}));},3);};return outgoing;}});
 const paths=['/api/demo','/api/account/state','/api/account/prelaunch','/api/account/postlaunch'];
 const results=await Promise.all(Array.from({length:100},(_,i)=>new Promise(resolve=>{const request=new PassThrough();Object.assign(request,req(paths[i%paths.length],'GET',{cookie:'kids_session=user'+i}));const response=new EventEmitter();response.headersSent=false;response.writableEnded=false;response.destroyed=false;response.writeHead=(status,headers)=>{response.statusCode=status;response.headers=headers;response.headersSent=true;};response.end=body=>{response.writableEnded=true;resolve({status:response.statusCode,body:JSON.parse(body)});};server.emit('request',request,response);request.end();})));
 assert.equal(peak,8);assert.equal(results.filter(result=>result.status===200).length,100);results.forEach((result,i)=>{assert.equal(result.body.path,paths[i%paths.length]);assert.equal(result.body.session,'kids_session=user'+i);});server.close();
});
test('bounded admission limits queued reads, write bursts, disconnections and rate windows',async()=>{
 const {createAdmission}=await import('./gateway.mjs');let time=0;const admission=createAdmission({activeLimit:1,queueLimit:1,now:()=>time});const release=await admission.acquire('GET','viewer');const abort=new AbortController();const queued=admission.acquire('GET','viewer',abort.signal);await assert.rejects(admission.acquire('GET','viewer'),{status:429});await assert.rejects(admission.acquire('POST','operator'),{status:429});abort.abort();await assert.rejects(queued,{status:499});release();
 for(let i=0;i<119;i++)(await admission.acquire('POST','operator'))();await assert.rejects(admission.acquire('POST','operator'),{status:429});time=60001;(await admission.acquire('POST','operator'))();
 const reads=createAdmission();for(let i=0;i<6000;i++)(await reads.acquire('GET','viewer'))();await assert.rejects(reads.acquire('GET','viewer'),{status:429});
});

test('expired operator role cannot reuse a test wallet session for financial mutations',async()=>{
 const {gatewayFinancialDenied}=await import('../../shared/trusted-gateway.mjs');const wallets={alice:'alice-owner',bob:'bob-owner'};
 for(const path of ['/api/account/prelaunch/prepare','/api/account/prelaunch/submit','/api/account/prelaunch-legacy/prepare','/api/account/prelaunch-legacy/submit','/api/account/postlaunch/trade/quote']){
  assert.equal(gatewayFinancialDenied({operator:false},path,wallets.alice,wallets),true);
  assert.equal(gatewayFinancialDenied({operator:false},path,'external-owner',wallets),false);
  assert.equal(gatewayFinancialDenied({operator:true},path,wallets.alice,wallets),false);
  assert.equal(gatewayFinancialDenied(null,path,wallets.alice,wallets),false);
 }
 for(const path of ['/api/account/postlaunch/claim','/api/account/postlaunch/trade/execute','/api/account/dev-vesting/claim']){
  assert.equal(authorizeGateway(req(path,'POST',{'content-type':'application/json'}),cfg).status,403);
  assert.equal(gatewayFinancialDenied({operator:false},path,'external-owner',wallets),true);
 }
 assert.equal(gatewayFinancialDenied({operator:false},'/api/account/logout',wallets.alice,wallets),false);
});
test('anonymous health traffic cannot exhaust platform liveness probes or proxy requests',async()=>{
 const {createGateway}=await import('./gateway.mjs');const {PassThrough}=await import('node:stream');const {EventEmitter}=await import('node:events');let called=0;const server=createGateway(cfg,{requestUpstream(){called++;throw Error('unexpected');}});
 const invoke=(url,method='GET')=>new Promise(resolve=>{const request=new PassThrough();Object.assign(request,{url,method,headers:{}});const response=new EventEmitter();response.writeHead=status=>response.statusCode=status;response.end=body=>resolve({status:response.statusCode,body:JSON.parse(body)});server.emit('request',request,response);request.end();});
 assert.deepEqual(await invoke('/healthz'),{status:200,body:{status:'alive'}});for(let i=0;i<1000;i++)assert.equal((await invoke('/healthz')).status,200);assert.deepEqual(await invoke('/healthz'),{status:200,body:{status:'alive'}});assert.notEqual((await invoke('/healthz?x=1')).status,200);assert.notEqual((await invoke('/healthz','POST')).status,200);assert.equal(called,0);server.close();
});

test('readiness is cached, fails closed, and is separate from liveness',async()=>{const {createGateway}=await import('./gateway.mjs');let ready=false;const server=createGateway(cfg,{readiness:()=>ready});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;try{assert.equal((await fetch(url+'/readyz')).status,503);assert.equal((await fetch(url+'/healthz')).status,200);ready=true;assert.equal((await fetch(url+'/readyz')).status,200);ready=false;assert.equal((await fetch(url+'/readyz')).status,503);}finally{server.close();server.closeAllConnections();}});
test('wallet-signed claim intent routes allow authenticated viewers without local signing privileges',()=>{
 for(const path of ['/api/account/postlaunch/claim/prepare','/api/account/postlaunch/claim/submit','/api/account/postlaunch/trade/prepare','/api/account/postlaunch/trade/submit'])assert.equal(authorizeGateway(req(path,'POST',{'content-type':'application/json'}),cfg).role,'viewer');
 assert.equal(authorizeGateway(req('/api/account/postlaunch/claim','POST',{'content-type':'application/json'}),cfg).status,403);
});
test('active and explicit rehearsal read routes are separately allowlisted',()=>{
 assert.equal(authorizeGateway(req('/api/account/postlaunch'),cfg).role,'viewer');assert.equal(authorizeGateway(req('/api/account/postlaunch-preview'),cfg).role,'viewer');assert.equal(authorizeGateway(req('/api/account/postlaunch?preview=true'),cfg).status,404);
});
