// Private server-to-server gateway. Never serves a Vite frontend or validator RPC.
import http from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {gatewayHeaders} from '../../shared/trusted-gateway.mjs';
import {publicStatusBody} from '../../shared/service-status.mjs';
const origin='https://kids.fun';
const accountGets=['launches/campaigns','launches/drafts','launches/positions','state','prelaunch','prelaunch-legacy','postlaunch','postlaunch-preview','dev-vesting','rounds'];
// Hosted creator flow (pilot, 28 September 2026): the creation, trade, operations and media routes the site calls; explicit paths only.
const creatorPosts=['launches/artwork/upload','launches/video/upload','launches/operations/read','launches/portfolio/read','launches/activity/read','launches/market/read',...['prepare','submit','status','cancel','resume'].map(p=>'launches/trade/'+p),...['quote','accept','prepare','status'].map(p=>'launches/creation/'+p),...['prepare','submit','status','resume','recover'].flatMap(p=>['launches/creation/flow/'+p,'launches/creation/setup/'+p]),'launches/creation/flow/report'];
const accountPosts=[...creatorPosts,'launches/drafts/save','launches/positions','launches/prepare','launches/submit','launches/status','launches/cancel','challenge','verify','logout','local','prelaunch/prepare','prelaunch/submit','prelaunch-legacy/prepare','prelaunch-legacy/submit','postlaunch/claim','postlaunch/claim/prepare','postlaunch/claim/submit','postlaunch/trade/quote','postlaunch/trade/prepare','postlaunch/trade/submit','postlaunch/trade/execute','dev-vesting/claim'];
// Admin routes are never served by the gateway (owner rule, 22 September 2026): the admin plugin stays loopback-only inside the container.
const routes=new Set(['GET /api/demo','GET /api/community/supporters','GET /api/community/supporter-wallets','GET /api/community/denylist',...accountGets.map(p=>'GET /api/account/'+p),...accountPosts.map(p=>'POST /api/account/'+p)]);
export const requiresOperator=path=>['/api/account/local','/api/account/postlaunch/claim','/api/account/postlaunch/trade/execute','/api/account/dev-vesting/claim'].includes(path);
const equal=(a,b)=>timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
export function gatewayConfig(env=process.env){
 const service=env.KIDS_BACKEND_TOKEN,operator=env.KIDS_OPERATOR_BACKEND_TOKEN,internal=env.KIDS_GATEWAY_INTERNAL_TOKEN,host=env.KIDS_GATEWAY_HOST;
 if([service,operator,internal].some(s=>typeof s!=='string'||s.length<32)||new Set([service,operator,internal]).size!==3||typeof host!=='string'||!/^[a-z0-9.-]+(?::\d{1,5})?$/.test(host))throw Error('Private gateway credentials and exact host must be configured');
 const community=typeof env.KIDS_COMMUNITY_TOKEN==='string'&&env.KIDS_COMMUNITY_TOKEN.length>=32?env.KIDS_COMMUNITY_TOKEN:null;
 return {service,operator,internal,host,community};
}
export const COMMUNITY_FILES=['supporters','supporter-wallets'];
const communityPost=path=>{const m=/^\/api\/community\/(supporters|supporter-wallets)$/.exec(path||'');return m?m[1]:null;};
/** Campaign directory reads (public, served from the registry): the list with a bounded query, one campaign by address or genesis:program:campaign, and its terms. */
/** The two binary upload routes: allowed types, the server's own size caps and the exact headers forwarded after the same checks the server applies. */
const uploads=Object.freeze({
 '/api/account/launches/artwork/upload':Object.freeze({types:['image/png','image/jpeg'],maxBytes:5*1024*1024,headers:{'x-kids-upload-id':/^[A-Za-z0-9_.:-]{1,128}$/,'x-kids-artwork-kind':/^(?:pfp|banner)$/}}),
 '/api/account/launches/video/upload':Object.freeze({types:['video/mp4','video/webm'],maxBytes:100*1024*1024,headers:{'x-kids-upload-id':/^[A-Za-z0-9_.:-]{1,128}$/}}),
});
export const uploadPolicy=(method,path)=>method==='POST'&&Object.hasOwn(uploads,path)?uploads[path]:null;
export const requestLimitBytes=(method,path)=>uploadPolicy(method,path)?.maxBytes??2000000;
/** Private media reads of the hosted creator flow: the creator's own sanitized artwork (PNG) and video (MP4, ranged) or its poster. */
export const MEDIA_READ=/^\/api\/account\/launches\/(?:artwork\/[A-Za-z0-9_.:-]{1,128}|video\/[A-Za-z0-9_.:-]{1,128}(?:\/poster)?)$/;
export const CSRF_TOKEN=/^(?:[a-f0-9]{48}|\d{13}\.[a-f0-9]{64})$/;
export const CAMPAIGNS_READ=/^\/api\/(?:account\/launches\/)?campaigns(?:\?[A-Za-z0-9=&_.%,+~-]{1,600}|\/[1-9A-HJ-NP-Za-km-z]{32,44}(?::[1-9A-HJ-NP-Za-km-z]{32,44}:[1-9A-HJ-NP-Za-km-z]{32,44})?(?:\/terms)?)?$/;
export function authorizeGateway(req,config){
 const h=req.headers||{},path=req.url;
 // Community uploads (the believers worker): their own token, no site origin, JSON up to 2 MB, role 'community'.
 if(req.method==='POST'&&communityPost(path)){
  if(!config.community)return {status:404,error:'Route unavailable'};
  const t=h['x-kids-community-token'];if(typeof t!=='string'||t.length>600||!equal(t,config.community))return {status:401,error:'Community authentication required'};
  if(!/^application\/json(?:\s*;.*)?$/i.test(h['content-type']||''))return {status:415,error:'JSON required'};
  if(h['content-encoding']||h['transfer-encoding']&&h['content-length'])return {status:400,error:'Unsupported request framing'};
  const size=h['content-length'];if(size===undefined||!/^\d+$/.test(size)||Number(size)>2000000)return {status:413,error:'Request too large (2 MB) or length missing'};
  return {role:'community'};
 }
 if(h.host!==config.host||h.origin!==origin)return {status:403,error:'Gateway origin or host rejected'};
 if(typeof path!=='string'||!(routes.has(req.method+' '+path)||(req.method==='GET'&&/^\/api\/market\/(summary|candles|trades|activity)\?[A-Za-z0-9=&_.%,-]{1,600}$/.test(path))||(req.method==='GET'&&CAMPAIGNS_READ.test(path))||(req.method==='GET'&&MEDIA_READ.test(path))))return {status:404,error:'Route unavailable'};// market reads (public, cached upstream) carry a query string
 if(typeof h.authorization!=='string'||h.authorization.length>600||!h.authorization.startsWith('Bearer ')||!equal(h.authorization.slice(7),config.service))return {status:401,error:'Service authentication required'};
 const isOperator=typeof h['x-kids-operator-token']==='string'&&h['x-kids-operator-token'].length<600&&equal(h['x-kids-operator-token'],config.operator);
 if(requiresOperator(path)&&!isOperator)return {status:403,error:'Operator authentication required'};
 const upload=uploadPolicy(req.method,path);
 if(req.method==='POST'&&!upload&&!/^application\/json(?:\s*;.*)?$/i.test(h['content-type']||''))return {status:415,error:'JSON required'};
 if(upload){
  const type=String(h['content-type']||'').toLowerCase().split(';')[0].trim();if(!upload.types.includes(type))return {status:415,error:'Upload type not allowed'};
  for(const [name,rule] of Object.entries(upload.headers))if(typeof h[name]!=='string'||!rule.test(h[name]))return {status:400,error:'Upload headers invalid'};
 }
 if(h['content-encoding']||h['transfer-encoding']&&h['content-length'])return {status:400,error:'Unsupported request framing'};
 const size=h['content-length'],limit=requestLimitBytes(req.method,path);if(size!==undefined&&(!/^\d+$/.test(size)||Number(size)>limit))return {status:413,error:'Request too large'};
 return {role:isOperator?'operator':'viewer'};
}
export function upstreamHeaders(req,config,role,length){
 const upload=uploadPolicy(req.method,req.url);
 const headers={host:'127.0.0.1:4175',origin,'content-type':upload?String(req.headers['content-type']||'').toLowerCase().split(';')[0].trim():'application/json','content-length':String(length),...gatewayHeaders(req.method,req.url,role,config.internal)};
 if(typeof req.headers['x-kids-csrf']==='string'&&CSRF_TOKEN.test(req.headers['x-kids-csrf']))headers['x-kids-csrf']=req.headers['x-kids-csrf'];
 if(upload)for(const [name,rule] of Object.entries(upload.headers)){const value=req.headers[name];if(typeof value==='string'&&rule.test(value))headers[name]=value;}
 if(req.method==='GET'&&MEDIA_READ.test(req.url)&&typeof req.headers.range==='string'&&/^bytes=\d*-\d*$/.test(req.headers.range))headers.range=req.headers.range;
 const cookies=String(req.headers.cookie||'').split(';').map(s=>s.trim()),session=cookies.find(s=>/^kids_session=[a-zA-Z0-9_-]{1,256}$/.test(s));if(session)headers.cookie=session;
 return headers;
}
// Admission (architecture audit item 4): reads and writes never share one pool. Public reads, wallet reads, sign-in,
// preparation and submission each have their own budget; writes have reserved active capacity and a short queue so
// eight slow reads cannot turn a commit into a 429; every refusal carries a Retry-After; refusals do not consume
// budget; each identity (session, else client hash) gets a fair share so one client cannot exhaust a class.
export function classifyRequest(method,path,headers={}){
 const hasSession=/(?:^|;\s*)kids_session=[a-zA-Z0-9_-]{1,256}/.test(String(headers.cookie||''));
 if(method==='GET')return hasSession?'wallet-read':'public-read';
 if(/\/api\/account\/(challenge|verify|logout|local)$/.test(path))return 'auth';
 if(/\/(prepare|quote)$/.test(path))return 'prepare';
 return 'submit';
}
export function identityOf(headers={},peer=null){
 const session=/(?:^|;\s*)kids_session=([a-zA-Z0-9_-]{1,256})/.exec(String(headers.cookie||''));if(session)return 's:'+createHash('sha256').update(session[1]).digest('hex').slice(0,16);
 const client=String(headers['x-kids-client']||'');if(/^[a-f0-9]{8,64}$/.test(client))return 'c:'+client;
 // A caller with neither a session nor a client hash still gets an identity from its peer address, so the per-client
 // caps apply to everyone (sign-in denial of service, application review of 28 September 2026).
 if(typeof peer==='string'&&peer)return 'p:'+createHash('sha256').update(peer).digest('hex').slice(0,16);
 return 'anon';
}
export const ADMISSION_DEFAULTS={reads:{active:10,queue:128,waitMs:8000},writes:{active:6,queue:32,waitMs:3000},budgets:{'public-read':9000,'wallet-read':6000,auth:600,prepare:900,submit:900,operator:120},perIdentity:{'public-read':240,'wallet-read':240,auth:30,prepare:60,submit:60,operator:120}};
export function createAdmission(options={}){
 const legacy='activeLimit' in options||'queueLimit' in options;
 const cfg={reads:{...ADMISSION_DEFAULTS.reads,...(legacy?{active:options.activeLimit??10,queue:options.queueLimit??128}:{}),...(options.reads||{})},writes:{...ADMISSION_DEFAULTS.writes,...(legacy?{active:options.writeLimit??ADMISSION_DEFAULTS.writes.active,queue:options.writeQueue??ADMISSION_DEFAULTS.writes.queue}:{}),...(options.writes||{})},budgets:{...ADMISSION_DEFAULTS.budgets,...(options.budgets||{})},perIdentity:{...ADMISSION_DEFAULTS.perIdentity,...(options.perIdentity||{})}};
 if(options.waitMs){cfg.reads.waitMs=options.waitMs;cfg.writes.waitMs=Math.min(options.waitMs,cfg.writes.waitMs);}
 const now=options.now||Date.now;
 const pools={reads:{active:0,queue:[],limit:cfg.reads.active,queueLimit:cfg.reads.queue,waitMs:cfg.reads.waitMs},writes:{active:0,queue:[],limit:cfg.writes.active,queueLimit:cfg.writes.queue,waitMs:cfg.writes.waitMs}};
 let windowStart=now();const used={},perIdentity=new Map();
 const reject=(status,message,retryAfter)=>Promise.reject(Object.assign(Error(message),{status,retryAfter}));
 const release=pool=>()=>{pool.active--;while(pool.queue.length){const job=pool.queue.shift();clearTimeout(job.timer);job.signal?.removeEventListener('abort',job.cancel);if(job.signal?.aborted)continue;pool.active++;job.resolve(release(pool));break;}};
 return {acquire(a,b,c,d){
  // legacy form acquire(method, role, signal) or acquire({method,path,role,identity,signal})
  const req=typeof a==='string'?{method:a,role:b,signal:c,path:d||'/api/account/state',identity:'anon'}:a;
  const {method,role='viewer',signal,path='/api/account/state',identity='anon',headers}=req;
  const cls=role==='operator'&&method==='POST'?'operator':(req.class||classifyRequest(method,path,headers||{}));
  const t=now();if(t-windowStart>=60000){windowStart=t;for(const k of Object.keys(used))used[k]=0;perIdentity.clear();}
  const remaining=Math.max(1,Math.ceil((60000-(t-windowStart))/1000));
  if((used[cls]||0)>=cfg.budgets[cls])return reject(429,'Gateway request limit reached for '+cls,remaining);
  const idKey=identity+'|'+cls,mine=perIdentity.get(idKey)||0;if(identity!=='anon'&&mine>=cfg.perIdentity[cls])return reject(429,'Too many '+cls+' requests from this client',remaining);
  if(signal?.aborted)return reject(499,'Request disconnected',0);
  const pool=method==='GET'?pools.reads:pools.writes;
  const admit=()=>{used[cls]=(used[cls]||0)+1;perIdentity.set(idKey,mine+1);};
  if(pool.active<pool.limit){pool.active++;admit();return Promise.resolve(release(pool));}
  if(pool.queue.length>=pool.queueLimit)return reject(429,'Gateway is busy',method==='GET'?2:3);
  return new Promise((resolve,rej)=>{
   const job={resolve:r=>{admit();resolve(r);},signal,timer:null,cancel:null};
   const remove=(status,message)=>{const index=pool.queue.indexOf(job);if(index<0)return;pool.queue.splice(index,1);clearTimeout(job.timer);signal?.removeEventListener('abort',job.cancel);rej(Object.assign(Error(message),{status,retryAfter:method==='GET'?2:3}));};
   job.cancel=()=>remove(499,'Request disconnected');job.timer=setTimeout(()=>remove(503,'Gateway queue timed out'),pool.waitMs);job.timer.unref?.();pool.queue.push(job);signal?.addEventListener('abort',job.cancel,{once:true});
  });
 },stats(){return {reads:{active:pools.reads.active,queued:pools.reads.queue.length},writes:{active:pools.writes.active,queued:pools.writes.queue.length},used:{...used}};}};
}
export function createGateway(config,{requestUpstream=http.request,readiness=()=>false,statusFetch=null}={}){
 const admission=createAdmission();let statusCache={at:0,body:null},uploadsActive=0;
 const fetchStatus=statusFetch||(async()=>{const r=await fetch('http://127.0.0.1:4175/_health/status',{signal:AbortSignal.timeout(3000)});return r.ok?await r.text():null;});
 const server=http.createServer(async(req,res)=>{
  const send=(status,error,retryAfter)=>{if(res.writableEnded||res.destroyed)return;if(!res.headersSent)res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(retryAfter?{'Retry-After':String(retryAfter)}:{})});res.end(JSON.stringify({error,...(retryAfter?{retryAfter}:{})}));};
  // A shared liveness quota lets anonymous callers exhaust the platform probe budget.
  // Keep this constant-cost endpoint independent from authenticated API admission.
  if(req.method==='GET'&&req.url==='/healthz'){req.resume();res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({status:'alive'}));}
  if(req.method==='GET'&&req.url==='/statusz'){req.resume();if(Date.now()-statusCache.at>5000){try{const raw=await fetchStatus();statusCache={at:Date.now(),body:raw?JSON.stringify(publicStatusBody(JSON.parse(raw))):null};}catch{statusCache={at:Date.now(),body:null};}}res.writeHead(statusCache.body?200:503,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(statusCache.body||JSON.stringify({status:'unavailable'}));}
  if(req.method==='GET'&&req.url==='/readyz'){req.resume();const ready=readiness();res.writeHead(ready?200:503,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({status:ready?'ready':'unavailable'}));}
  const auth=authorizeGateway(req,config);if(auth.status){req.resume();return send(auth.status,auth.error);}
  // At most two buffered uploads at a time: the server admits one video at a time anyway, and memory stays bounded.
  const upload=uploadPolicy(req.method,req.url),media=req.method==='GET'&&MEDIA_READ.test(req.url);
  if(upload&&uploadsActive>=2){req.resume();return send(503,'Upload capacity busy; retry shortly',3);}
  if(upload)uploadsActive++;
  const controller=new AbortController();const disconnected=()=>{if(!res.writableEnded)controller.abort();};res.on('close',disconnected);
  let release;try{release=await admission.acquire({method:req.method,path:req.url,role:auth.role,identity:identityOf(req.headers,req.socket?.remoteAddress),headers:req.headers,signal:controller.signal});}catch(error){if(upload)uploadsActive--;res.off('close',disconnected);req.resume();return send(error.status||503,error.message,error.retryAfter);}
  let upstream,timer;
  try{
   timer=setTimeout(()=>{upstream?.destroy();send(504,'Gateway request timed out');req.destroy();},25000);timer.unref();
   const chunks=[];let size=0;const limit=requestLimitBytes(req.method,req.url);for await(const chunk of req){size+=chunk.length;if(size>limit){send(413,'Request too large');req.destroy();return;}chunks.push(chunk);}
   if(req.method==='GET'&&size){return send(400,'GET body not allowed');}
   const body=Buffer.concat(chunks);
   await new Promise(resolve=>{
    upstream=requestUpstream({hostname:'127.0.0.1',port:4175,path:req.url,method:req.method,headers:upstreamHeaders(req,config,auth.role,body.length),timeout:22000},incoming=>{
     const chunks=[];let length=0;
     incoming.on('data',chunk=>{length+=chunk.length;if(length>(media?34000000:4000000)){upstream.destroy();send(502,'Backend response too large');resolve();return;}chunks.push(chunk);});
     incoming.on('error',()=>{send(502,'Backend unavailable');resolve();});
     incoming.on('end',()=>{if(res.writableEnded)return resolve();const type=String(incoming.headers['content-type']||'');
      // Private media of the creator flow: the sanitized PNG or MP4 (whole or ranged) passes through with its own headers.
      if(media&&/^(?:image\/png|video\/mp4)$/.test(type)&&[200,206].includes(incoming.statusCode)){const headers={'Content-Type':type,'Content-Length':String(length),'Cache-Control':'private, no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"default-src 'none'; sandbox"};for(const name of ['content-range','accept-ranges'])if(incoming.headers[name])headers[name]=String(incoming.headers[name]);res.writeHead(incoming.statusCode,headers);res.end(Buffer.concat(chunks));return resolve();}
      if(media&&incoming.statusCode===416){res.writeHead(416,{'Content-Range':String(incoming.headers['content-range']||''),'Content-Length':'0','Cache-Control':'private, no-store'});res.end();return resolve();}
      if(!type.includes('application/json')){send(502,'Unexpected backend response');return resolve();}
      const headers={'Content-Type':'application/json','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
      const cookies=(incoming.headers['set-cookie']||[]).filter(value=>/^kids_session=(?:[a-zA-Z0-9_-]{1,256})?;/.test(value));if(cookies.length)headers['Set-Cookie']=cookies.map(value=>/;\s*Secure(?:;|$)/i.test(value)?value:value+'; Secure');
      if(incoming.statusCode===503){const ra=Number(incoming.headers['retry-after'])||3;send(503,'Backend busy; retry with the same request',ra);return resolve();}
      if((incoming.statusCode||500)>=500){send(502,'Backend unavailable');return resolve();}res.writeHead(incoming.statusCode||502,headers);res.end(Buffer.concat(chunks));resolve();
     });
    });
    upstream.on('timeout',()=>upstream.destroy());upstream.on('error',()=>{send(502,'Backend unavailable');resolve();});upstream.end(body);
   });
  }catch{if(!res.writableEnded)send(400,'Invalid gateway request');}finally{clearTimeout(timer);res.off('close',disconnected);release();if(upload)uploadsActive--;}
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
