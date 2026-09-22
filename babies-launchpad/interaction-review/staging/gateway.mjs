// Private server-to-server gateway. Never serves a Vite frontend or validator RPC.
import http from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {gatewayHeaders} from '../../shared/trusted-gateway.mjs';
const origin='https://kids.fun';
const accountGets=['state','prelaunch','prelaunch-legacy','postlaunch','postlaunch-preview','dev-vesting','rounds'];
const accountPosts=['challenge','verify','logout','local','prelaunch/prepare','prelaunch/submit','prelaunch-legacy/prepare','prelaunch-legacy/submit','postlaunch/claim','postlaunch/claim/prepare','postlaunch/claim/submit','postlaunch/trade/quote','postlaunch/trade/prepare','postlaunch/trade/submit','postlaunch/trade/execute','dev-vesting/claim'];
// Admin routes are never served by the gateway (owner rule, 22 September 2026): the admin plugin stays loopback-only inside the container.
const routes=new Set(['GET /api/demo',...accountGets.map(p=>'GET /api/account/'+p),...accountPosts.map(p=>'POST /api/account/'+p)]);
export const requiresOperator=path=>['/api/account/local','/api/account/postlaunch/claim','/api/account/postlaunch/trade/execute','/api/account/dev-vesting/claim'].includes(path);
const equal=(a,b)=>timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
export function gatewayConfig(env=process.env){
 const service=env.KIDS_BACKEND_TOKEN,operator=env.KIDS_OPERATOR_BACKEND_TOKEN,internal=env.KIDS_GATEWAY_INTERNAL_TOKEN,host=env.KIDS_GATEWAY_HOST;
 if([service,operator,internal].some(s=>typeof s!=='string'||s.length<32)||new Set([service,operator,internal]).size!==3||typeof host!=='string'||!/^[a-z0-9.-]+(?::\d{1,5})?$/.test(host))throw Error('Private gateway credentials and exact host must be configured');
 return {service,operator,internal,host};
}
export function authorizeGateway(req,config){
 const h=req.headers||{},path=req.url;
 if(h.host!==config.host||h.origin!==origin)return {status:403,error:'Gateway origin or host rejected'};
 if(typeof path!=='string'||!routes.has(req.method+' '+path))return {status:404,error:'Route unavailable'};
 if(typeof h.authorization!=='string'||h.authorization.length>600||!h.authorization.startsWith('Bearer ')||!equal(h.authorization.slice(7),config.service))return {status:401,error:'Service authentication required'};
 const isOperator=typeof h['x-kids-operator-token']==='string'&&h['x-kids-operator-token'].length<600&&equal(h['x-kids-operator-token'],config.operator);
 if(requiresOperator(path)&&!isOperator)return {status:403,error:'Operator authentication required'};
 if(req.method==='POST'&&!/^application\/json(?:\s*;.*)?$/i.test(h['content-type']||''))return {status:415,error:'JSON required'};
 if(h['content-encoding']||h['transfer-encoding']&&h['content-length'])return {status:400,error:'Unsupported request framing'};
 const size=h['content-length'];if(size!==undefined&&(!/^\d+$/.test(size)||Number(size)>2000000))return {status:413,error:'Request too large'};
 return {role:isOperator?'operator':'viewer'};
}
export function upstreamHeaders(req,config,role,length){
 const headers={host:'127.0.0.1:4175',origin,'content-type':'application/json','content-length':String(length),...gatewayHeaders(req.method,req.url,role,config.internal)};
 if(typeof req.headers['x-kids-csrf']==='string'&&/^[a-f0-9]{48}$/.test(req.headers['x-kids-csrf']))headers['x-kids-csrf']=req.headers['x-kids-csrf'];
 const cookies=String(req.headers.cookie||'').split(';').map(s=>s.trim()),session=cookies.find(s=>/^kids_session=[a-zA-Z0-9_-]{1,256}$/.test(s));if(session)headers.cookie=session;
 return headers;
}
// Queue only authenticated reads; writes cannot accumulate behind a slow backend.
export function createAdmission({activeLimit=8,queueLimit=128,waitMs=12000,now=Date.now}={}){
 let active=0,start=now(),reads=0;const writes={viewer:0,operator:0},queue=[];
 const release=()=>{active--;while(queue.length){const job=queue.shift();clearTimeout(job.timer);job.signal?.removeEventListener('abort',job.cancel);if(job.signal?.aborted)continue;active++;job.resolve(release);break;}};
 return {acquire(method,role,signal){
  if(now()-start>=60000){start=now();reads=0;writes.viewer=0;writes.operator=0;}
  if(method==='GET'?++reads>6000:++writes[role]>(role==='operator'?120:240))return Promise.reject(Object.assign(Error('Gateway request limit reached'),{status:429}));
  if(signal?.aborted)return Promise.reject(Object.assign(Error('Request disconnected'),{status:499}));
  if(active<activeLimit){active++;return Promise.resolve(release);}
  if(method!=='GET'||queue.length>=queueLimit)return Promise.reject(Object.assign(Error('Gateway is busy'),{status:429}));
  return new Promise((resolve,reject)=>{
   const job={resolve,signal,timer:null,cancel:null};
   const remove=(status,message)=>{const index=queue.indexOf(job);if(index<0)return;queue.splice(index,1);clearTimeout(job.timer);signal?.removeEventListener('abort',job.cancel);reject(Object.assign(Error(message),{status}));};
   job.cancel=()=>remove(499,'Request disconnected');job.timer=setTimeout(()=>remove(503,'Gateway queue timed out'),waitMs);job.timer.unref?.();queue.push(job);signal?.addEventListener('abort',job.cancel,{once:true});
  });
 }};
}
export function createGateway(config,{requestUpstream=http.request,readiness=()=>false}={}){
 const admission=createAdmission();
 const server=http.createServer(async(req,res)=>{
  const send=(status,error)=>{if(res.writableEnded||res.destroyed)return;if(!res.headersSent)res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify({error}));};
  // A shared liveness quota lets anonymous callers exhaust the platform probe budget.
  // Keep this constant-cost endpoint independent from authenticated API admission.
  if(req.method==='GET'&&req.url==='/healthz'){req.resume();res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({status:'alive'}));}
  if(req.method==='GET'&&req.url==='/readyz'){req.resume();const ready=readiness();res.writeHead(ready?200:503,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({status:ready?'ready':'unavailable'}));}
  const auth=authorizeGateway(req,config);if(auth.status){req.resume();return send(auth.status,auth.error);}
  const controller=new AbortController();const disconnected=()=>{if(!res.writableEnded)controller.abort();};res.on('close',disconnected);
  let release;try{release=await admission.acquire(req.method,auth.role,controller.signal);}catch(error){res.off('close',disconnected);req.resume();return send(error.status||503,error.message);}
  let upstream,timer;
  try{
   timer=setTimeout(()=>{upstream?.destroy();send(504,'Gateway request timed out');req.destroy();},25000);timer.unref();
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>2000000){send(413,'Request too large');req.destroy();return;}chunks.push(chunk);}
   if(req.method==='GET'&&size){return send(400,'GET body not allowed');}
   const body=Buffer.concat(chunks);
   await new Promise(resolve=>{
    upstream=requestUpstream({hostname:'127.0.0.1',port:4175,path:req.url,method:req.method,headers:upstreamHeaders(req,config,auth.role,body.length),timeout:22000},incoming=>{
     const chunks=[];let length=0;
     incoming.on('data',chunk=>{length+=chunk.length;if(length>4000000){upstream.destroy();send(502,'Backend response too large');resolve();return;}chunks.push(chunk);});
     incoming.on('error',()=>{send(502,'Backend unavailable');resolve();});
     incoming.on('end',()=>{if(res.writableEnded)return resolve();if(!String(incoming.headers['content-type']).includes('application/json')){send(502,'Unexpected backend response');return resolve();}
      const headers={'Content-Type':'application/json','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
      const cookies=(incoming.headers['set-cookie']||[]).filter(value=>/^kids_session=(?:[a-zA-Z0-9_-]{1,256})?;/.test(value));if(cookies.length)headers['Set-Cookie']=cookies.map(value=>/;\s*Secure(?:;|$)/i.test(value)?value:value+'; Secure');
      if((incoming.statusCode||500)>=500){send(502,'Backend unavailable');return resolve();}res.writeHead(incoming.statusCode||502,headers);res.end(Buffer.concat(chunks));resolve();
     });
    });
    upstream.on('timeout',()=>upstream.destroy());upstream.on('error',()=>{send(502,'Backend unavailable');resolve();});upstream.end(body);
   });
  }catch{if(!res.writableEnded)send(400,'Invalid gateway request');}finally{clearTimeout(timer);res.off('close',disconnected);release();}
 });
 server.headersTimeout=10000;server.requestTimeout=30000;server.keepAliveTimeout=5000;server.maxHeadersCount=40;return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 let ready=false,checkedAt=0,busy=false;
 const check=async()=>{if(busy)return;busy=true;try{ready=(await fetch('http://127.0.0.1:4175/_health/ready',{signal:AbortSignal.timeout(2000)})).ok;}catch{ready=false;}finally{checkedAt=Date.now();busy=false;}};
 const server=createGateway(gatewayConfig(),{readiness:()=>ready&&Date.now()-checkedAt<15000});
 const timer=setInterval(check,5000);timer.unref();await check();server.once('close',()=>clearInterval(timer));
 const port=Number(process.env.PORT||8080);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid gateway port');server.listen(port,'0.0.0.0');
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{ready=false;clearInterval(timer);server.close(()=>process.exit(0));server.closeIdleConnections();setTimeout(()=>{server.closeAllConnections();process.exit(0);},25000).unref();});
}
