const encoder = new TextEncoder();
const cookieName = '__Host-kids_access';
const ttl = 8 * 60 * 60;
const headers = { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY' };
async function digest(value) { return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
async function equal(a, b) { const [x,y] = await Promise.all([digest(a),digest(b)]); let diff=0; for(let i=0;i<x.length;i++) diff |= x[i]^y[i]; return diff===0; }
async function signature(value, secret) { const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']); return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(value))),x=>x.toString(16).padStart(2,'0')).join(''); }
function page(error=false, operator=false) { return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KIDS · Private access</title><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#140e1d;color:#fff1fb;font:16px system-ui}main{width:min(340px,80vw);padding:32px;border:1px solid #49324f;border-radius:20px;background:#20152c}h1{font-size:36px;margin:0 0 8px}p{color:#bcaac7}input,button{box-sizing:border-box;width:100%;font:inherit;padding:14px;border-radius:10px;margin-top:12px}input{background:#140e1d;border:1px solid #6c507c;color:white}button{background:#ff72d2;border:0;font-weight:700;color:#211025}</style><main><h1>kids.fun</h1><p>Private access. Enter the ${operator?'operator':'site'} password.</p>${error?'<p role="alert">Password not recognised.</p>':''}<form method="post" action="/${operator?'__operator':'__access'}"><input type="password" name="password" autocomplete="current-password" aria-label="Site password" maxlength="256" required><button>Enter</button></form></main></html>`, {status:error?401:200,headers:{...headers,'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}}); }

async function validCookie(request,name,secret,now){
 const cookie=request.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)||'';
 const [expiry,signed,...extra]=cookie.split('.');
 return !extra.length&&/^\d{10}$/.test(expiry||'')&&Number(expiry)>now&&Number(expiry)<=now+ttl&&/^[a-f0-9]{64}$/.test(signed||'')&&await equal(signed,await signature(expiry,secret));
}
const accountGets=['state','prelaunch','prelaunch-legacy','postlaunch','postlaunch-preview','dev-vesting','rounds'];
const accountPosts=['challenge','verify','logout','local','prelaunch/prepare','prelaunch/submit','prelaunch-legacy/prepare','prelaunch-legacy/submit','postlaunch/claim','postlaunch/claim/prepare','postlaunch/claim/submit','postlaunch/trade/quote','postlaunch/trade/prepare','postlaunch/trade/submit','postlaunch/trade/execute','dev-vesting/claim'];
// Admin routes are never bridged (owner rule, 22 September 2026): admin functions exist only on the local machine.
const routes=new Set(['GET /api/demo',...accountGets.map(p=>'GET /api/account/'+p),...accountPosts.map(p=>'POST /api/account/'+p)]);
async function proxyApi(request,env,operator){
 const json=(status,error)=>Response.json({error},{status,headers});
 if(!env.KIDS_BACKEND_ORIGIN||!env.KIDS_BACKEND_TOKEN)return json(503,'Online transactions are not enabled. This service is restricted to the local test environment.');
 const url=new URL(request.url);
 if(url.search||!routes.has(request.method+' '+url.pathname))return json(404,'Route unavailable');
 if((['/api/account/local','/api/account/postlaunch/claim','/api/account/postlaunch/trade/execute','/api/account/dev-vesting/claim'].includes(url.pathname))&&!operator)return json(401,'Operator access required. Open /__operator to sign in.');
 if(request.method==='POST'&&request.headers.get('origin')!==url.origin)return json(403,'Forbidden');
 let upstream;try{upstream=new URL(env.KIDS_BACKEND_ORIGIN);}catch{return json(503,'Backend unavailable');}
 if(upstream.protocol!=='https:'||upstream.username||upstream.password||upstream.pathname!=='/'||upstream.search||upstream.hash||!upstream.hostname.endsWith('.up.railway.app'))return json(503,'Backend unavailable');
 const outgoing=new Headers({'authorization':'Bearer '+env.KIDS_BACKEND_TOKEN,'origin':'https://kids.fun','content-type':'application/json'});
 const ip=(request.headers.get('x-forwarded-for')||request.headers.get('x-real-ip')||'').split(',')[0].trim();if(ip){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(ip));outgoing.set('x-kids-client',[...new Uint8Array(digest)].slice(0,12).map(b=>b.toString(16).padStart(2,'0')).join(''));}
 if(operator&&env.KIDS_OPERATOR_BACKEND_TOKEN)outgoing.set('x-kids-operator-token',env.KIDS_OPERATOR_BACKEND_TOKEN);
 const session=request.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>/^kids_session=[a-zA-Z0-9_-]{1,256}$/.test(x));if(session)outgoing.set('cookie',session);
 const csrf=request.headers.get('x-kids-csrf');if(csrf&&/^[a-f0-9]{48}$/.test(csrf))outgoing.set('x-kids-csrf',csrf);
 let body;
 if(request.method==='POST'){
  if(!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get('content-type')||''))return json(415,'JSON required');
  if(Number(request.headers.get('content-length'))>2000000)return json(413,'Request too large');
  const chunks=[];let size=0;const reader=request.body?.getReader();if(reader)while(true){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>2000000){await reader.cancel();return json(413,'Request too large');}chunks.push(item.value);}
  body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.length;}
 }
 try{
  const response=await fetch(new URL(url.pathname,upstream),{method:request.method,headers:outgoing,body,redirect:'error',signal:AbortSignal.timeout(40000)});
  if(!response.headers.get('content-type')?.includes('application/json'))return json(502,'Backend unavailable');
  const resultHeaders=new Headers({...headers,'content-type':'application/json'});
  const cookie=response.headers.get('set-cookie');if(cookie&&/^kids_session=(?:[a-zA-Z0-9_-]{1,256})?;/.test(cookie)&&!cookie.includes(','))resultHeaders.set('set-cookie',/;\s*Secure(?:;|$)/i.test(cookie)?cookie:cookie+'; Secure');
  return new Response(response.body,{status:response.status,headers:resultHeaders});
 }catch{return json(502,'Backend unavailable');}
}

export async function gate(request, env, now=Math.floor(Date.now()/1000)) {
  const password=env.KIDS_ACCESS_PASSWORD, secret=env.KIDS_ACCESS_SECRET;
  if (!password || password.length<20 || !secret || secret.length<32) return new Response('Private access is not configured.',{status:503,headers});
  const url=new URL(request.url);
  const isOperator=await validCookie(request,'__Host-kids_operator',secret+':operator',now);
  const operatorLogin=url.pathname==='/__operator';
  const siteValid=await validCookie(request,cookieName,secret,now);
  if(operatorLogin&&!siteValid)return page();
  if(operatorLogin&&request.method==='GET')return page(false,true);
  if((url.pathname==='/__access'||operatorLogin) && request.method==='POST') {
    if(request.headers.get('origin')!==url.origin) return new Response('Forbidden',{status:403,headers});
    if(!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return new Response('Unsupported request',{status:415,headers});
    if(Number(request.headers.get('content-length'))>1024) return new Response('Request too large',{status:413,headers});
    const reader=request.body?.getReader(); let chunks=[],size=0;
    if(reader) { while(true) { const item=await reader.read(); if(item.done)break; size+=item.value.length; if(size>1024){await reader.cancel();return new Response('Request too large',{status:413,headers});} chunks.push(item.value); } }
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const provided=new URLSearchParams(new TextDecoder().decode(bytes)).get('password')||'';
    const expected=operatorLogin?env.KIDS_OPERATOR_PASSWORD:password;
    if(!expected||expected.length<20||(operatorLogin&&await equal(expected,password)))return new Response('Operator access unavailable',{status:503,headers});
    if(!await equal(provided,expected)) return page(true,operatorLogin);
    const expiry=String(now+ttl), signed=await signature(expiry,operatorLogin?secret+':operator':secret);
    return new Response(null,{status:303,headers:{...headers,location:'/', 'set-cookie':`${operatorLogin?'__Host-kids_operator':cookieName}=${expiry}.${signed}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${ttl}`}});
  }
  if(!siteValid) return request.method==='GET'||request.method==='HEAD'?page():new Response('Authentication required',{status:401,headers});
  if(url.pathname==='/api'||url.pathname.startsWith('/api/')) return proxyApi(request,env,isOperator);
  if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405,headers});
  return new Response(null,{headers:{...headers,'x-middleware-next':'1'}});
}
export default function middleware(request) { return gate(request,process.env); }
