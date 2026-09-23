const encoder = new TextEncoder();
const cookieName = '__Host-kids_access';
const ttl = 8 * 60 * 60;
const headers = { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY' };
async function digest(value) { return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
async function equal(a, b) { const [x,y] = await Promise.all([digest(a),digest(b)]); let diff=0; for(let i=0;i<x.length;i++) diff |= x[i]^y[i]; return diff===0; }
async function signature(value, secret) { const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']); return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(value))),x=>x.toString(16).padStart(2,'0')).join(''); }
function page(error=false, operator=false) { return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script>window.va=window.va||function(){(window.vaq=window.vaq||[]).push(arguments)}</script><script defer src="/_vercel/insights/script.js"></script><meta name="color-scheme" content="dark"><title>KIDS · Private access</title><style>
:root{--bg:#130d1b;--card:#1b1128;--line:#4a3358;--fg:#fff4fc;--muted:#c9b6d8;--pink:#ff77ce;--pink-hover:#ff9bdc;--pink-shadow:#973f8c;--lilac:#a88aff;--ice:#8cecff;--ink:#250d2a;--error:#ffb3d4;color-scheme:dark}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;position:relative;overflow-x:hidden}
body::before{content:"";position:fixed;inset:-20vmax;pointer-events:none;background:radial-gradient(38vmax 30vmax at 22% 24%,rgba(255,119,206,.22),transparent 60%),radial-gradient(34vmax 30vmax at 78% 76%,rgba(168,138,255,.22),transparent 60%)}
body::after{content:"";position:fixed;inset:0;pointer-events:none;opacity:.5;background-image:radial-gradient(rgba(255,255,255,.05) .6px,transparent .7px);background-size:3px 3px;mix-blend-mode:screen}
main{position:relative;width:min(380px,100%);padding:30px 28px 28px;border:1px solid var(--line);border-radius:22px;background:var(--card);box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.02) inset,0 0 60px rgba(255,119,206,.08)}
.mark{display:block;width:118px;height:36px;margin:0 0 22px}
h1{font-size:44px;line-height:1;letter-spacing:-1.6px;font-weight:800;margin:0 0 8px}
.sub{margin:0 0 24px;color:var(--muted);font-size:15px}
label{display:block;font-size:13px;font-weight:600;color:var(--muted);margin:0 0 6px}
input{display:block;width:100%;min-height:50px;padding:12px 14px;border-radius:12px;border:1px solid #6a4d80;background:#120c1a;color:var(--fg);font:inherit;font-size:17px;letter-spacing:.12em;transition:border-color .15s,box-shadow .15s}
input::placeholder{color:#7c6690;letter-spacing:0}
input:hover{border-color:#8a68a6}
input:focus{outline:none;border-color:var(--ice)}
input:focus-visible{outline:2px solid var(--ice);outline-offset:2px}
input[aria-invalid=true]{border-color:var(--error)}
.err{display:flex;align-items:center;gap:8px;margin:10px 0 0;font-size:14px;font-weight:600;color:var(--error)}
.err svg{flex-shrink:0}
button{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:52px;margin-top:16px;padding:12px 18px;border:1px solid var(--pink);border-radius:12px;background:var(--pink);color:var(--ink);font:inherit;font-size:17px;font-weight:700;cursor:pointer;box-shadow:0 4px 0 var(--pink-shadow);transition:background .15s,border-color .15s,transform .08s,box-shadow .08s;touch-action:manipulation}
button:hover{background:var(--pink-hover);border-color:var(--pink-hover)}
button:active{transform:translateY(2px);box-shadow:0 2px 0 var(--pink-shadow)}
button:focus-visible{outline:3px solid var(--ice);outline-offset:3px;box-shadow:0 4px 0 var(--pink-shadow),0 0 0 6px rgba(140,236,255,.2)}
.foot{margin:18px 0 0;font-size:12px;color:#9d88ad;text-align:center}
@media(max-width:400px){main{padding:24px 20px 22px;border-radius:18px}h1{font-size:38px}}
@media(prefers-reduced-motion:reduce){input,button{transition:none}button:active{transform:none}}
</style><main>
<svg class="mark" viewBox="0 0 118 36" role="img" aria-label="kids.fun"><text x="0" y="29" font-family="system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" font-size="32" font-weight="900" font-style="italic" letter-spacing="-1.5" fill="#fff4fc">kids<tspan fill="#ff77ce">.</tspan>fun</text></svg>
<h1>${operator?'Operator.':'Not yet.'}</h1>
<p class="sub">${operator?'Second door. Site session first, then the operator password.':'If you know, you know.'}</p>
<form method="post" action="/${operator?'__operator':'__access'}" novalidate>
<label for="password">${operator?'Operator password':'Password'}</label>
<input id="password" type="password" name="password" autocomplete="current-password" maxlength="256" required autofocus placeholder="Enter password"${error?' aria-invalid="true" aria-describedby="err"':''}>
${error?'<p class="err" id="err" role="alert"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5v4M8 11.2v.3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>That’s not it.</p>':''}
<button type="submit">Enter<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
</form>
<p class="foot">Private access</p>
</main></html>`, {status:error?401:200,headers:{...headers,'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}}); }

async function validCookie(request,name,secret,now){
 const cookie=request.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)||'';
 const [expiry,signed,...extra]=cookie.split('.');
 return !extra.length&&/^\d{10}$/.test(expiry||'')&&Number(expiry)>now&&Number(expiry)<=now+ttl&&/^[a-f0-9]{64}$/.test(signed||'')&&await equal(signed,await signature(expiry,secret));
}
const accountGets=['state','prelaunch','prelaunch-legacy','postlaunch','postlaunch-preview','dev-vesting','rounds'];
const accountPosts=['challenge','verify','logout','local','prelaunch/prepare','prelaunch/submit','prelaunch-legacy/prepare','prelaunch-legacy/submit','postlaunch/claim','postlaunch/claim/prepare','postlaunch/claim/submit','postlaunch/trade/quote','postlaunch/trade/prepare','postlaunch/trade/submit','postlaunch/trade/execute','dev-vesting/claim'];
// Admin routes are never bridged (owner rule, 22 September 2026): admin functions exist only on the local machine.
const routes=new Set(['GET /api/community/supporters','GET /api/community/supporter-wallets','GET /api/community/denylist',...accountGets.map(p=>'GET /api/account/'+p),...accountPosts.map(p=>'POST /api/account/'+p)]);
async function proxyApi(request,env,operator){
 const json=(status,error)=>Response.json({error},{status,headers});
 if(!env.KIDS_BACKEND_ORIGIN||!env.KIDS_BACKEND_TOKEN)return json(503,'Online transactions are not enabled. This service is restricted to the local test environment.');
 const url=new URL(request.url);
 // Market and activity reads carry a bounded query (campaign, interval, cursor, kinds); every other route takes none.
 const marketRead=request.method==='GET'&&/^\/api\/market\/(summary|candles|trades|activity)$/.test(url.pathname)&&/^\?[A-Za-z0-9=&_.%,-]{1,600}$/.test(url.search);
 if(!marketRead&&(url.search||!routes.has(request.method+' '+url.pathname)))return json(404,'Route unavailable');
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
  const response=await fetch(new URL(url.pathname+(marketRead?url.search:''),upstream),{method:request.method,headers:outgoing,body,redirect:'error',signal:AbortSignal.timeout(40000)});
  if(!response.headers.get('content-type')?.includes('application/json'))return json(502,'Backend unavailable');
  const resultHeaders=new Headers({...headers,'content-type':'application/json'});
  const cookie=response.headers.get('set-cookie');if(cookie&&/^kids_session=(?:[a-zA-Z0-9_-]{1,256})?;/.test(cookie)&&!cookie.includes(','))resultHeaders.set('set-cookie',/;\s*Secure(?:;|$)/i.test(cookie)?cookie:cookie+'; Secure');
  return new Response(response.body,{status:response.status,headers:resultHeaders});
 }catch{return json(502,'Backend unavailable');}
}

/** The password stays until the owner says otherwise (owner, 23 Sep 2026: never automatic). KIDS_ACCESS_OPENS_AT, an ISO
 * UTC time, opens the site from that moment; unset or 'never' keeps the password. Only the password page goes away; the
 * operator login, the route allowlist and the API forwarding are unchanged. */
export function publicFrom(env){const raw=env.KIDS_ACCESS_OPENS_AT;if(!raw||raw==='never')return null;const at=Date.parse(raw);if(Number.isNaN(at))return null;return Math.floor(at/1000);}
export async function gate(request, env, now=Math.floor(Date.now()/1000)) {
  const password=env.KIDS_ACCESS_PASSWORD, secret=env.KIDS_ACCESS_SECRET;
  if (!password || password.length<20 || !secret || secret.length<32) return new Response('Private access is not configured.',{status:503,headers});
  const opensAt=publicFrom(env),isPublic=opensAt!==null&&now>=opensAt;
  const url=new URL(request.url);
  // Vercel Web Analytics (cookieless): its script and beacons pass the gate so visits to the locked page count too.
  if(url.pathname==='/_vercel/insights/script.js'||url.pathname==='/_vercel/insights/view'||url.pathname==='/_vercel/insights/event')return new Response(null,{headers:{...headers,'x-middleware-next':'1'}});
  const isOperator=await validCookie(request,'__Host-kids_operator',secret+':operator',now);
  const operatorLogin=url.pathname==='/__operator';
  const siteValid=isPublic||await validCookie(request,cookieName,secret,now);
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
