import test from 'node:test';import assert from 'node:assert/strict';import {gate} from './gate.mjs';
const env={KIDS_ACCESS_PASSWORD:'test-password-long-enough',KIDS_ACCESS_SECRET:'test-secret-at-least-32-characters-long',KIDS_ACCESS_OPENS_AT:'never'};
const req=(p='/',init={})=>new Request('https://kids.fun'+p,init);
async function session(){const r=await gate(req('/__access',{method:'POST',headers:{origin:'https://kids.fun','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password:env.KIDS_ACCESS_PASSWORD})}),env,1800000000);assert.equal(r.status,303);return r.headers.get('set-cookie').split(';')[0];}
test('missing configuration fails closed',async()=>assert.equal((await gate(req(),{})).status,503));
test('all anonymous assets are gated',async()=>{for(const p of ['/','/assets/video.mp4','/api/admin','/index.html'])assert.match(await(await gate(req(p),env)).text(),/Private access/);});
test('cross-origin login is forbidden',async()=>assert.equal((await gate(req('/__access',{method:'POST',headers:{origin:'https://bad.example'}}),env)).status,403));
test('session is secure and APIs remain disabled',async()=>{const cookie=await session();assert.equal((await gate(req('/assets/logo.png',{headers:{cookie}}),env,1800000001)).headers.get('x-middleware-next'),'1');assert.equal((await gate(req('/api/admin',{headers:{cookie}}),env,1800000001)).status,503);assert.equal((await gate(req('/',{headers:{cookie}}),env,1800030000)).headers.get('x-middleware-next'),null);});
test('forged cookie rejected',async()=>assert.equal((await gate(req('/',{headers:{cookie:'__Host-kids_access=1800000100.'+'0'.repeat(64)}}),env,1800000000)).headers.get('x-middleware-next'),null));
test('oversized login rejected',async()=>assert.equal((await gate(req('/__access',{method:'POST',headers:{origin:'https://kids.fun','content-type':'application/x-www-form-urlencoded'},body:'x'.repeat(1025)}),env)).status,413));
test('100 concurrent authenticated requests keep isolation',async()=>{const cookie=await session();const responses=await Promise.all(Array.from({length:100},(_,i)=>gate(req(i%2?'/assets/app.js':'/api/admin',{headers:{cookie}}),env,1800000001)));assert.equal(responses.filter(r=>r.status===503).length,50);assert.equal(responses.filter(r=>r.headers.get('x-middleware-next')==='1').length,50);});
test('operator access is separate and restricted to a site session',async()=>{
 const cfg={...env,KIDS_OPERATOR_PASSWORD:'operator-password-long-enough',KIDS_BACKEND_ORIGIN:'https://kids-test.up.railway.app',KIDS_BACKEND_TOKEN:'backend-test-token'};
 const cookie=await session();
 assert.equal((await gate(req('/api/admin/state',{headers:{cookie}}),cfg,1800000001)).status,404,'admin routes are never bridged');
 const response=await gate(req('/__operator',{method:'POST',headers:{cookie,origin:'https://kids.fun','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password:cfg.KIDS_OPERATOR_PASSWORD})}),cfg,1800000001);
 assert.equal(response.status,303);assert.match(response.headers.get('set-cookie'),/^__Host-kids_operator=/);
 assert.equal(response.headers.get('location'),'/');
 assert.equal((await gate(req('/api/account/state?url=https://evil.example',{headers:{cookie}}),cfg,1800000001)).status,404);
 assert.equal((await gate(req('/api/account/local',{method:'POST',headers:{cookie,origin:'https://kids.fun','content-type':'application/json'},body:'{}'}),cfg,1800000001)).status,401);
});
test('proxy strips browser credentials and forwards only authorized session',async()=>{
 const cookie=await session(),original=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{assert.equal(String(url),'https://kids-test.up.railway.app/api/account/state');assert.equal(options.headers.get('authorization'),'Bearer secret-backend-token');assert.equal(options.headers.get('cookie'),'kids_session=abc123');assert.equal(options.headers.get('x-kids-operator-token'),null);assert.equal(options.headers.get('origin'),'https://kids.fun');return Response.json({ok:true});};
 try{const response=await gate(req('/api/account/state',{headers:{cookie:cookie+'; kids_session=abc123; malicious=1',authorization:'Bearer user-spoof','x-kids-operator-token':'spoof'}}),{...env,KIDS_BACKEND_ORIGIN:'https://kids-test.up.railway.app',KIDS_BACKEND_TOKEN:'secret-backend-token'},1800000001);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.deepEqual(await response.json(),{ok:true});}finally{globalThis.fetch=original;}
});

test("login page preserves same-origin form origin without disclosing cross-origin referrers",async()=>{const r=await gate(req(),env);assert.equal(r.headers.get("referrer-policy"),"same-origin");assert.equal((await gate(req("/__access",{method:"POST",headers:{origin:"null","content-type":"application/x-www-form-urlencoded"},body:"password=x"}),env)).status,403);});
test('active and explicit preview endpoints proxy separately without a query override',async()=>{
 const cookie=await session(),original=globalThis.fetch,cfg={...env,KIDS_BACKEND_ORIGIN:'https://kids-test.up.railway.app',KIDS_BACKEND_TOKEN:'secret-backend-token'},seen=[];
 globalThis.fetch=async url=>{seen.push(new URL(url).pathname);return Response.json({ok:true});};
 try{for(const path of ['/api/account/postlaunch','/api/account/postlaunch-preview'])assert.equal((await gate(req(path,{headers:{cookie}}),cfg,1800000001)).status,200);assert.deepEqual(seen,['/api/account/postlaunch','/api/account/postlaunch-preview']);assert.equal((await gate(req('/api/account/postlaunch?preview=true',{headers:{cookie}}),cfg,1800000001)).status,404);}finally{globalThis.fetch=original;}
});

test('the password never ends by itself: only KIDS_ACCESS_OPENS_AT opens the site, from its UTC time',async()=>{
 const {publicFrom}=await import('./gate.mjs');const unset={...env};delete unset.KIDS_ACCESS_OPENS_AT;const at=Date.parse('2026-09-23T20:00:00Z')/1000;
 assert.equal(publicFrom(unset),null);assert.equal(publicFrom(env),null);assert.equal(publicFrom({...env,KIDS_ACCESS_OPENS_AT:'2026-09-23T20:00:00Z'}),at);
 assert.match(await(await gate(req('/'),unset,at+86400*365)).text(),/Private access/);
 const open={...env,KIDS_ACCESS_OPENS_AT:'2026-09-23T20:00:00Z'};
 assert.match(await(await gate(req('/'),open,at-1)).text(),/Private access/);
 assert.equal((await gate(req('/'),open,at)).headers.get('x-middleware-next'),'1');
 assert.equal((await gate(req('/api/admin'),open,at+1)).status,503,'the API allowlist still applies to the public');
});

test('analytics script and beacons pass the gate without a session; everything else stays gated',async()=>{
 for(const p of ['/_vercel/insights/script.js','/_vercel/insights/view'])assert.equal((await gate(req(p),env,1800000000)).headers.get('x-middleware-next'),'1',p);
 assert.equal((await gate(req('/_vercel/insights/other'),env,1800000000)).headers.get('x-middleware-next'),null);
 assert.match(await(await gate(req('/'),env,1800000000)).text(),/_vercel\/insights\/script\.js/,'the password page carries the script');
});
