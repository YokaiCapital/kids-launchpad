import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {gatewayConfig,authorizeGateway,upstreamHeaders,identityOf,createGateway,uploadPolicy,requestLimitBytes,MEDIA_READ} from './gateway.mjs';
const env={KIDS_BACKEND_TOKEN:'service-test-'.repeat(4),KIDS_OPERATOR_BACKEND_TOKEN:'operator-test-'.repeat(4),KIDS_GATEWAY_INTERNAL_TOKEN:'internal-test-'.repeat(4),KIDS_GATEWAY_HOST:'gateway.example.test'};
const cfg=gatewayConfig(env),origin='https://kids.fun';
const req=(path,method='GET',headers={})=>({url:path,method,headers:{host:cfg.host,origin,authorization:'Bearer '+cfg.service,...headers},socket:{remoteAddress:'203.0.113.9'}});
const json={'content-type':'application/json'};
test('hosted creator routes are allowed by exact path; unknown sub-paths and traversal stay refused',()=>{
 const posts=['launches/creation/quote','launches/creation/accept','launches/creation/prepare','launches/creation/status','launches/creation/flow/prepare','launches/creation/flow/submit','launches/creation/flow/status','launches/creation/flow/resume','launches/creation/flow/recover','launches/creation/flow/report','launches/creation/setup/prepare','launches/creation/setup/submit','launches/creation/setup/status','launches/creation/setup/resume','launches/creation/setup/recover','launches/trade/prepare','launches/trade/submit','launches/trade/status','launches/trade/cancel','launches/trade/resume','launches/operations/read','launches/portfolio/read','launches/activity/read','launches/market/read'];
 for(const p of posts)assert.equal(authorizeGateway(req('/api/account/'+p,'POST',json),cfg).role,'viewer',p);
 for(const p of ['/api/account/launches/creation/flow/delete','/api/account/launches/creation/','/api/account/launches/trade/execute','/api/account/launches/creation/quote?x=1','/api/account/launches/artwork/../x'])assert.equal(authorizeGateway(req(p,'POST',json),cfg).status,404,p);
 for(const p of ['/api/account/launches/artwork/a1:b.c-d','/api/account/launches/video/asset_9','/api/account/launches/video/asset_9/poster'])assert.equal(authorizeGateway(req(p,'GET'),cfg).role,'viewer',p);
 for(const p of ['/api/account/launches/artwork/','/api/account/launches/artwork/a b','/api/account/launches/video/x/frame','/api/account/launches/artwork/'+'a'.repeat(129)])assert.equal(authorizeGateway(req(p,'GET'),cfg).status,404,p);
 assert.equal(MEDIA_READ.test('/api/account/launches/video/x/poster'),true);
});
test('binary uploads: only the two routes, only their types, their headers checked, their own size caps',()=>{
 const art='/api/account/launches/artwork/upload',video='/api/account/launches/video/upload';
 assert.equal(authorizeGateway(req(art,'POST',{'content-type':'image/png','x-kids-upload-id':'up:1','x-kids-artwork-kind':'pfp','content-length':String(5*1024*1024)}),cfg).role,'viewer');
 assert.equal(authorizeGateway(req(art,'POST',{'content-type':'image/jpeg','x-kids-upload-id':'up:1','x-kids-artwork-kind':'banner'}),cfg).role,'viewer');
 assert.equal(authorizeGateway(req(art,'POST',{'content-type':'application/json','x-kids-upload-id':'up:1','x-kids-artwork-kind':'pfp'}),cfg).status,415,'JSON is not an image');
 assert.equal(authorizeGateway(req(art,'POST',{'content-type':'image/gif','x-kids-upload-id':'up:1','x-kids-artwork-kind':'pfp'}),cfg).status,415);
 assert.equal(authorizeGateway(req(art,'POST',{'content-type':'image/png','x-kids-upload-id':'up:1'}),cfg).status,400,'artwork kind required');
 assert.equal(authorizeGateway(req(art,'POST',{'content-type':'image/png','x-kids-upload-id':'bad id','x-kids-artwork-kind':'pfp'}),cfg).status,400);
 assert.equal(authorizeGateway(req(art,'POST',{'content-type':'image/png','x-kids-upload-id':'up:1','x-kids-artwork-kind':'pfp','content-length':String(5*1024*1024+1)}),cfg).status,413);
 assert.equal(authorizeGateway(req(video,'POST',{'content-type':'video/mp4','x-kids-upload-id':'v1','content-length':String(100*1024*1024)}),cfg).role,'viewer');
 assert.equal(authorizeGateway(req(video,'POST',{'content-type':'video/mp4','x-kids-upload-id':'v1','content-length':String(100*1024*1024+1)}),cfg).status,413);
 assert.equal(authorizeGateway(req(video,'POST',{'content-type':'video/mp4'}),cfg).status,400,'upload id required');
 assert.equal(authorizeGateway(req('/api/account/launches/drafts/save','POST',{'content-type':'image/png'}),cfg).status,415,'images only on the upload routes');
 assert.equal(uploadPolicy('POST','/api/account/launches/drafts/save'),null);assert.equal(requestLimitBytes('POST','/api/account/launches/drafts/save'),2000000);
 assert.equal(requestLimitBytes('POST',video),100*1024*1024);assert.equal(requestLimitBytes('GET',video),2000000);
});
test('upstream headers: upload type and its checked headers pass, everything else is rebuilt; range only on media reads',()=>{
 const up=upstreamHeaders(req('/api/account/launches/artwork/upload','POST',{'content-type':'image/png; charset=binary','x-kids-upload-id':'up:1','x-kids-artwork-kind':'pfp','x-kids-other':'no','range':'bytes=0-1','x-kids-csrf':'a'.repeat(48)}),cfg,'viewer',10);
 assert.equal(up['content-type'],'image/png');assert.equal(up['x-kids-upload-id'],'up:1');assert.equal(up['x-kids-artwork-kind'],'pfp');assert.equal('x-kids-other' in up,false);assert.equal('range' in up,false);assert.equal(up['x-kids-csrf'],'a'.repeat(48));
 const bad=upstreamHeaders(req('/api/account/launches/artwork/upload','POST',{'content-type':'image/png','x-kids-upload-id':'up:1','x-kids-artwork-kind':'evil'}),cfg,'viewer',10);assert.equal('x-kids-artwork-kind' in bad,false);
 const media=upstreamHeaders(req('/api/account/launches/video/asset_1','GET',{range:'bytes=0-31'}),cfg,'viewer',0);assert.equal(media.range,'bytes=0-31');assert.equal(media['content-type'],'application/json');
 assert.equal('range' in upstreamHeaders(req('/api/account/launches/video/asset_1','GET',{range:'bytes=0-31, 40-50'}),cfg,'viewer',0),false);
 assert.equal('range' in upstreamHeaders(req('/api/account/state','GET',{range:'bytes=0-31'}),cfg,'viewer',0),false);
 const replica=upstreamHeaders(req('/api/account/state','GET',{'x-kids-csrf':'1700000000000.'+'b'.repeat(64)}),cfg,'viewer',0);assert.equal(replica['x-kids-csrf'],'1700000000000.'+'b'.repeat(64),'replica CSRF token format passes');
 assert.equal('x-kids-csrf' in upstreamHeaders(req('/api/account/state','GET',{'x-kids-csrf':'nope'}),cfg,'viewer',0),false);
});
test('identity: session, then client hash, then the peer address; never a shared anonymous bucket for a real peer',()=>{
 assert.equal(identityOf({},'203.0.113.9').startsWith('p:'),true);assert.notEqual(identityOf({},'203.0.113.9'),identityOf({},'203.0.113.10'));
 assert.equal(identityOf({}),'anon');assert.equal(identityOf({'x-kids-client':'abcdef12'},'203.0.113.9'),'c:abcdef12');
 assert.equal(identityOf({cookie:'kids_session=abc'},'203.0.113.9').startsWith('s:'),true);
});
function call(server,{path,method='GET',headers={},body=null}){
 return new Promise(resolve=>{const request=new PassThrough();Object.assign(request,req(path,method,headers));const response=new EventEmitter();const chunks=[];response.headersSent=false;response.writableEnded=false;response.destroyed=false;
  response.writeHead=(status,h)=>{response.statusCode=status;response.headers=h;response.headersSent=true;};response.end=data=>{if(data)chunks.push(Buffer.from(data));response.writableEnded=true;resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)});};
  server.emit('request',request,response);if(body)request.end(body);else request.end();});
}
const upstream=answer=>({requestUpstream(options,callback){const outgoing=new EventEmitter();let sent=[];outgoing.write=c=>sent.push(c);outgoing.destroy=()=>{};outgoing.end=data=>{if(data)sent.push(data);setTimeout(()=>{const a=answer(options,Buffer.concat(sent.map(x=>Buffer.from(x))));const response=new PassThrough();response.headers=a.headers;response.statusCode=a.status;callback(response);response.end(a.body);},2);};return outgoing;}});
test('media reads pass the sanitized PNG and ranged MP4 through with their own headers; JSON errors stay JSON; nothing else binary',async()=>{
 const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(40,7)]);
 const server=createGateway(cfg,upstream((options,body)=>{
  if(options.path==='/api/account/launches/artwork/asset_1')return {status:200,headers:{'content-type':'image/png','content-length':String(png.length)},body:png};
  if(options.path==='/api/account/launches/video/asset_2')return options.headers.range?{status:206,headers:{'content-type':'video/mp4','content-range':'bytes 0-3/100','accept-ranges':'bytes'},body:Buffer.from('ftyp')}:{status:200,headers:{'content-type':'video/mp4'},body:Buffer.alloc(100,1)};
  if(options.path==='/api/account/launches/video/asset_3')return {status:416,headers:{'content-range':'bytes */100','content-type':'video/mp4'},body:Buffer.alloc(0)};
  if(options.path==='/api/account/launches/artwork/asset_9')return {status:401,headers:{'content-type':'application/json'},body:JSON.stringify({error:'Sign in with a wallet first'})};
  if(options.path==='/api/account/state')return {status:200,headers:{'content-type':'image/png'},body:png};
  if(options.path==='/api/account/launches/artwork/upload')return {status:200,headers:{'content-type':'application/json'},body:JSON.stringify({received:body.length,type:options.headers['content-type'],kind:options.headers['x-kids-artwork-kind']})};
  return {status:404,headers:{'content-type':'application/json'},body:JSON.stringify({error:'no'})};
 }));
 try{
  const a=await call(server,{path:'/api/account/launches/artwork/asset_1'});assert.equal(a.status,200);assert.equal(a.headers['Content-Type'],'image/png');assert.deepEqual(a.body,png);assert.equal(a.headers['Cache-Control'],'private, no-store');assert.match(a.headers['Content-Security-Policy'],/sandbox/);
  const r=await call(server,{path:'/api/account/launches/video/asset_2',headers:{range:'bytes=0-3'}});assert.equal(r.status,206);assert.equal(r.headers['content-range'],'bytes 0-3/100');assert.equal(r.headers['accept-ranges'],'bytes');assert.equal(r.body.toString(),'ftyp');
  const whole=await call(server,{path:'/api/account/launches/video/asset_2'});assert.equal(whole.status,200);assert.equal(whole.body.length,100);
  const bad=await call(server,{path:'/api/account/launches/video/asset_3',headers:{range:'bytes=500-'}});assert.equal(bad.status,416);assert.equal(bad.headers['Content-Range'],'bytes */100');
  const denied=await call(server,{path:'/api/account/launches/artwork/asset_9'});assert.equal(denied.status,401);assert.equal(JSON.parse(denied.body).error,'Sign in with a wallet first');
  const notMedia=await call(server,{path:'/api/account/state'});assert.equal(notMedia.status,502,'binary bodies pass only on media routes');
  const up=await call(server,{path:'/api/account/launches/artwork/upload',method:'POST',headers:{'content-type':'image/png','x-kids-upload-id':'up:1','x-kids-artwork-kind':'banner','content-length':String(png.length)},body:png});
  assert.equal(up.status,200);assert.deepEqual(JSON.parse(up.body),{received:png.length,type:'image/png',kind:'banner'});
 }finally{server.close();}
});
test('/statusz serves the trimmed public body: no paths, no error text, no keys',async()=>{
 const server=createGateway(cfg,{statusFetch:async()=>JSON.stringify({status:'ready',at:'T',writesOpen:true,keepers:{active:{lastAt:1,ms:2,status:'ok',error:'postgres://user:pw@host',ageSeconds:3}},signer:{configured:true,ok:true,publicKey:'AAuwkFNvXRimHyvdQfh7Zik9baw8W2ufSbc5cyBqsdoE',ageSeconds:5},disk:{path:'/data/localnet',totalBytes:1,freeBytes:1,freePercent:50},registry:{configured:true,driver:'postgres',campaigns:1,lastError:{category:'connect',message:'ECONNREFUSED postgres.railway.internal:5432',at:'T'}},release:{configured:true,network:'mainnet',programId:'P',checks:{program:'ok'}},publicLaunch:{status:'observed',alerts:[]}})});
 try{
  const r=await call(server,{path:'/statusz',headers:{}});assert.equal(r.status,200);const body=JSON.parse(r.body);
  assert.deepEqual(body.disk,{freePercent:50});assert.deepEqual(body.registry.lastError,{category:'connect',at:'T'});assert.equal('publicKey' in body.signer,false);assert.equal('error' in body.keepers.active,false);
  assert.equal(body.keepers.active.ageSeconds,3);assert.equal(body.release.programId,'P');assert.deepEqual(body.publicLaunch,{status:'observed',alerts:[]});
  const text=r.body.toString();for(const leak of ['/data','postgres://','railway.internal','AAuwkFNv'])assert.equal(text.includes(leak),false,leak);
 }finally{server.close();}
 const broken=createGateway(cfg,{statusFetch:async()=>'not json'});
 try{const r=await call(broken,{path:'/statusz',headers:{}});assert.equal(r.status,503);}finally{broken.close();}
});
