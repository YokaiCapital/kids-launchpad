// Campaign directory routes: shapes, filters, unknown id 404, ambiguous 409, no query on item routes, registry outage
// 503; the gateway and the gate allow exactly these GET routes. The plugin is dark: without KIDS_REGISTRY_URL it is not
// installed (404, no file), with it the routes read the registry the startup import opened, read-only.
import test from 'node:test';import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {PublicKey} from '@solana/web3.js';
import {campaignsPlugin,campaignsPluginFor,publicCampaign,CAMPAIGNS_PATH,PUBLIC_CAMPAIGN_FIELDS} from '../server/campaigns-plugin.mjs';
import {createApiServer} from '../server/runtime.mjs';
import {openRegistry} from '../../localnet/registry/registry.mjs';
import {startRegistryImport,readOnlyRegistry} from '../../localnet/registry/startup.mjs';
import {authorizeGateway,gatewayConfig,CAMPAIGNS_READ} from '../staging/gateway.mjs';
import {gate} from '../deployment/gate.mjs';
const addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const GENESIS=addr(200),PROGRAM=addr(201);
const row=(n,extra={})=>({genesisHash:GENESIS,programId:PROGRAM,campaign:addr(n),mode:n%2?'family':'standard',campaignVersion:3,registryStatus:'archived',legacyAdapterVersion:'v3-family-single',sourcePaths:['secret/path/'+n],name:'Coin '+n,softCapLamports:'1000',hardCapLamports:'5000',chainStatus:n===1?'launched':null,sourceSlot:n===1?500:null,sourceCommitment:n===1?'confirmed':null,...extra});
async function serve(plugin){
 const runtime=createApiServer({plugins:[plugin],probe:async()=>true,probeInterval:60000});
 await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));const port=runtime.server.address().port;
 const get=async(path,init={})=>{const res=await fetch('http://127.0.0.1:'+port+path,init);return {status:res.status,body:await res.json(),headers:res.headers};};
 return {get,close:()=>runtime.shutdown()};
}
test('list, filters, item and terms routes are served from the registry with public shapes',async()=>{
 const r=openRegistry();r.migrate();for(const n of [1,2,3])r.campaigns.upsert(row(n));
 const s=await serve(campaignsPlugin({authorize:()=>true,registry:r}));
 try{
  const list=await s.get('/api/campaigns');assert.equal(list.status,200);assert.equal(list.body.count,3);assert.equal(list.body.nextCursor,null);assert.equal(list.headers.get('cache-control'),'no-store');
  assert.deepEqual(list.body.campaigns.map(c=>c.campaign),[addr(3),addr(2),addr(1)],'newest first');
  const item=list.body.campaigns[2];assert.equal(item.id,GENESIS+':'+PROGRAM+':'+addr(1));assert.deepEqual(item.chain,{status:'launched',slot:500,commitment:'confirmed',state:'projected'});assert.equal(item.sourcePaths,undefined);assert.equal(item.ordinal,undefined);
  assert.deepEqual(list.body.campaigns[0].chain,{status:null,slot:null,commitment:null,state:'unknown'});
  assert.deepEqual((await s.get('/api/campaigns?mode=standard')).body.campaigns.map(c=>c.campaign),[addr(2)]);
  assert.deepEqual((await s.get('/api/campaigns?status=launched&mode=family')).body.campaigns.map(c=>c.campaign),[addr(1)]);
  assert.deepEqual((await s.get('/api/campaigns?status=unknown')).body.campaigns.map(c=>c.campaign),[addr(3),addr(2)]);
  assert.equal((await s.get('/api/campaigns?status=weird')).status,400);assert.equal((await s.get('/api/campaigns?bogus=1')).status,400);assert.equal((await s.get('/api/campaigns?cursor=!!')).status,400);
  const alphabetical=await s.get('/api/campaigns?sort=name&limit=2');assert.deepEqual(alphabetical.body.campaigns.map(c=>c.name),['Coin 1','Coin 2']);assert.ok(alphabetical.body.nextCursor);
  assert.equal((await s.get('/api/campaigns?sort=name&limit=2&cursor='+alphabetical.body.nextCursor)).body.campaigns[0].name,'Coin 3');
  assert.equal((await s.get('/api/campaigns?sort=newest&cursor='+alphabetical.body.nextCursor)).status,400);assert.equal((await s.get('/api/campaigns?sort=random')).status,400);
  const one=await s.get('/api/campaigns/'+addr(1));assert.equal(one.status,200);assert.equal(one.body.name,'Coin 1');assert.equal(one.body.live,null,'no live read configured: explicit null');
  const full=await s.get('/api/campaigns/'+GENESIS+':'+PROGRAM+':'+addr(2));assert.equal(full.status,200);assert.equal(full.body.mode,'standard');
  const terms=await s.get('/api/campaigns/'+addr(1)+'/terms');assert.equal(terms.status,200);assert.equal(terms.body.softCapLamports,'1000');assert.equal(terms.body.policy.supplySplitBps.participants,4350);assert.equal(terms.body.adapter,'v3-family-single');
  assert.equal((await s.get('/api/campaigns/'+addr(9))).status,404);assert.equal((await s.get('/api/campaigns/'+addr(9)+'/terms')).status,404);
  assert.equal((await s.get('/api/campaigns/not-an-address')).status,404);assert.equal((await s.get('/api/campaigns/'+addr(1)+'/other')).status,404);
  assert.equal((await s.get('/api/campaigns/'+addr(1)+'?x=1')).status,400);
  assert.equal((await s.get('/api/campaigns',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,405);
 }finally{await s.close();r.close();}
});
test('a live reader, when configured, is attached per campaign and its failure is explicit',async()=>{
 const r=openRegistry();r.migrate();r.campaigns.upsert(row(1));
 const s=await serve(campaignsPlugin({authorize:()=>true,registry:r,readView:async row=>{if(row.campaign!==addr(1))throw Error('x');return {available:true,phase:'launched',source:{kind:'chain',slot:501}};}}));
 try{const one=await s.get('/api/campaigns/'+addr(1));assert.equal(one.body.live.phase,'launched');assert.equal(one.body.live.source.slot,501);}finally{await s.close();r.close();}
 const r2=openRegistry();r2.migrate();r2.campaigns.upsert(row(1));
 const s2=await serve(campaignsPlugin({authorize:()=>true,registry:r2,readView:async()=>{throw Error('rpc down');}}));
 try{const one=await s2.get('/api/campaigns/'+addr(1));assert.equal(one.status,200);assert.equal(one.body.live.available,false);assert.equal(one.body.live.error.message,'Live data unavailable');}finally{await s2.close();r2.close();}
});
test('a shared address across ledgers is 409; a registry that cannot open is 503 and retried later',async()=>{
 const r=openRegistry();r.migrate();r.campaigns.upsert(row(1));r.campaigns.upsert({...row(1),genesisHash:addr(210)});
 const s=await serve(campaignsPlugin({authorize:()=>true,registry:r}));
 try{assert.equal((await s.get('/api/campaigns/'+addr(1))).status,409);assert.equal((await s.get('/api/campaigns/'+addr(210)+':'+PROGRAM+':'+addr(1))).status,200);}finally{await s.close();r.close();}
 let attempts=0;const lines=[];
 const s2=await serve(campaignsPlugin({authorize:()=>true,open:()=>{attempts++;throw Error('disk missing');},log:l=>lines.push(l)}));
 try{assert.equal((await s2.get('/api/campaigns')).status,503);assert.equal((await s2.get('/api/campaigns')).status,503);assert.equal(attempts,1,'the failed open is not retried within ten seconds');assert.equal(lines[0].event,'campaign-registry-unavailable');}finally{await s2.close();}
});
test('public shape is an explicit allow-list: internal plan fields, file paths and unknown columns never reach the JSON',async()=>{
 const p=publicCampaign({...row(4),ordinal:4,terms:{deadlineSeconds:600,feeNft:addr(30),note:'1 SOL soft',snapshotDirectory:'deployment/mainnet/snapshots/x',plannedAt:'2026-09-23T00:00:00Z',programSha256:'ab'.repeat(32)},internalOnly:'never'});
 assert.deepEqual(p.terms,{deadlineSeconds:600,feeNft:addr(30),note:'1 SOL soft'});assert.equal(p.internalOnly,undefined);assert.equal(p.sourcePaths,undefined);assert.equal(p.ordinal,undefined);
 assert.deepEqual(Object.keys(p).sort(),[...PUBLIC_CAMPAIGN_FIELDS,'terms','id','chain','view'].sort());
 assert.equal(publicCampaign(row(4)).terms,null,'no terms stored: explicit null');
 const r=openRegistry();r.migrate();r.campaigns.upsert({...row(1),terms:{deadlineSeconds:600,snapshotDirectory:'deployment/mainnet/snapshots/x',plannedAt:'2026-09-23T00:00:00Z',programSha256:'ab'.repeat(32)}});
 const s=await serve(campaignsPlugin({authorize:()=>true,registry:r}));
 try{
  for(const body of [(await s.get('/api/campaigns')).body.campaigns[0],(await s.get('/api/campaigns/'+addr(1))).body]){
   const text=JSON.stringify(body);assert.doesNotMatch(text,/snapshotDirectory|plannedAt|programSha256|sourcePaths|secret\/path|ordinal/);assert.deepEqual(body.terms,{deadlineSeconds:600});
  }
 }finally{await s.close();r.close();}
});
test('dark: without KIDS_REGISTRY_URL no plugin is installed, /api/campaigns is 404 as before the slice, and no registry file appears',async()=>{
 const neverOpen=()=>{throw Error('must not open');};
 assert.equal(campaignsPluginFor({env:{},registryImport:null}),null);
 const unset=startRegistryImport({env:{},open:neverOpen,setExtra:()=>{throw Error('statusz must stay unchanged');},log:()=>{}});
 assert.equal(campaignsPluginFor({env:{},registryImport:unset}),null);
 assert.equal(campaignsPluginFor({env:{KIDS_REGISTRY_URL:'/x.sqlite'},registryImport:unset}),null,'an import that is not configured installs nothing either');
 assert.throws(()=>campaignsPlugin({}),/never opens a registry file/);assert.throws(()=>campaignsPlugin(),/never opens a registry file/);
 const plugins=[campaignsPluginFor({env:{},registryImport:unset})].filter(Boolean);assert.equal(plugins.length,0);
 const runtime=createApiServer({plugins,probe:async()=>true,probeInterval:60000});await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));const port=runtime.server.address().port;
 try{
  for(const path of ['/api/campaigns','/api/campaigns/'+addr(1),'/api/campaigns/'+addr(1)+'/terms']){const res=await fetch('http://127.0.0.1:'+port+path);assert.equal(res.status,404,path);assert.deepEqual(await res.json(),{error:'Not found'});}
  const status=await (await fetch('http://127.0.0.1:'+port+'/_health/status')).json();assert.equal(status.registry,undefined,'statusz carries no registry block');
 }finally{await runtime.shutdown();}
 const runtimeDir=fileURLToPath(new URL('../../localnet/.runtime/',import.meta.url));
 assert.equal(existsSync(join(runtimeDir,'registry.sqlite')),false,'the old default registry file is never created');
});
test('with KIDS_REGISTRY_URL the routes read the registry the startup import opened, read-only, and no second file is created',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-campaigns-'));const file=join(dir,'registry.sqlite');const logs=[];
 const importFn=async({registry})=>{registry.campaigns.upsert(row(1));return {total:1,rows:[{inserted:true,updated:false,conflicts:[]}],skipped:[]};};
 const registryImport=startRegistryImport({env:{KIDS_REGISTRY_URL:file},importFn,setExtra:()=>{},schedule:()=>({unref(){}}),unschedule:()=>{},log:l=>logs.push(l)});
 const plugin=campaignsPluginFor({authorize:()=>true,env:{KIDS_REGISTRY_URL:file},registryImport,log:l=>logs.push(l)});assert.ok(plugin,'installed when configured');
 const s=await serve(plugin);
 try{
  await new Promise(r=>setTimeout(r,20));
  const list=await s.get('/api/campaigns');assert.equal(list.status,200);assert.equal(list.body.count,1);assert.equal(list.body.campaigns[0].campaign,addr(1));
  assert.equal((await s.get('/api/campaigns/'+addr(1))).status,200);
  assert.deepEqual(readdirSync(dir).filter(n=>!n.startsWith('registry.sqlite')),[],'one registry file (plus its journal), nothing else');
  const view=readOnlyRegistry(registryImport.registry);assert.equal(view.readOnly,true);assert.equal(view.campaigns.upsert,undefined);assert.equal(view.migrate,undefined);assert.equal(typeof view.campaigns.get,'function');assert.throws(()=>readOnlyRegistry(null),/open registry/);
  plugin.close();assert.equal(registryImport.registry.campaigns.get(addr(1)).campaign,addr(1),'closing the plugin never closes the import\'s connection');
 }finally{await s.close();registryImport.stop();}
});
test('public shape and path matcher',()=>{
 const p=publicCampaign({...row(4),ordinal:4});assert.equal(p.sourcePaths,undefined);assert.equal(p.ordinal,undefined);assert.equal(p.id,GENESIS+':'+PROGRAM+':'+addr(4));assert.equal(p.chain.state,'unknown');
 assert.ok(CAMPAIGNS_PATH.test('/api/campaigns'));assert.ok(CAMPAIGNS_PATH.test('/api/campaigns/'+addr(1)));assert.ok(CAMPAIGNS_PATH.test('/api/campaigns/'+addr(1)+'/terms'));assert.ok(CAMPAIGNS_PATH.test('/api/campaigns/'+GENESIS+':'+PROGRAM+':'+addr(1)+'/terms'));
 for(const bad of ['/api/campaigns/','/api/campaigns/x','/api/campaigns/'+addr(1)+'/','/api/campaigns/'+addr(1)+':'+addr(2),'/api/campaignsx'])assert.equal(CAMPAIGNS_PATH.test(bad),false,bad);
});
test('gateway: campaign reads pass as viewer GETs with a bounded query on the list only',()=>{
 const env={KIDS_BACKEND_TOKEN:'s'.repeat(40),KIDS_OPERATOR_BACKEND_TOKEN:'o'.repeat(40),KIDS_GATEWAY_INTERNAL_TOKEN:'i'.repeat(40),KIDS_GATEWAY_HOST:'api.test'};
 const cfg=gatewayConfig(env);const req=(url,method='GET',headers={})=>({url,method,headers:{host:'api.test',origin:'https://kids.fun',authorization:'Bearer '+cfg.service,...headers}});
 for(const ok of ['/api/account/launches/campaigns','/api/account/launches/campaigns?status=open','/api/account/launches/campaigns/'+addr(1)+'/terms','/api/campaigns','/api/campaigns?status=open&mode=family','/api/campaigns?cursor=eyJvIjo0fQ','/api/campaigns/'+addr(1),'/api/campaigns/'+addr(1)+'/terms','/api/campaigns/'+GENESIS+':'+PROGRAM+':'+addr(1)])assert.equal(authorizeGateway(req(ok),cfg).role,'viewer',ok);
 for(const bad of ['/api/account/launches/campaigns/'+addr(1)+'?x=1','/api/account/launches/campaigns/','/api/campaigns/','/api/campaigns/'+addr(1)+'?x=1','/api/campaigns?'+'a'.repeat(601),'/api/campaigns?q=<script>','/api/campaigns/'+addr(1)+'/claim','/api/campaignsx'])assert.equal(authorizeGateway(req(bad),cfg).status,404,bad);
 assert.equal(authorizeGateway(req('/api/campaigns','POST',{'content-type':'application/json'}),cfg).status,404);
 assert.equal(authorizeGateway({...req('/api/campaigns'),headers:{host:'api.test',origin:'https://kids.fun'}},cfg).status,401,'still needs the service credential');
 assert.ok(CAMPAIGNS_READ.test('/api/campaigns?status=open'));assert.equal(CAMPAIGNS_READ.test('/api/campaigns/'+addr(1)+'?status=open'),false);
});
test('gate: campaign reads pass as public reads, the list query is forwarded, item routes take no query',async()=>{
 const env={KIDS_ACCESS_PASSWORD:'test-password-long-enough',KIDS_ACCESS_SECRET:'test-secret-at-least-32-characters-long',KIDS_ACCESS_OPENS_AT:'2026-09-23T00:00:00Z',KIDS_BACKEND_ORIGIN:'https://kids-test.up.railway.app',KIDS_BACKEND_TOKEN:'t'.repeat(32)};
 const req=(p,init={})=>new Request('https://kids.fun'+p,init);const seen=[];
 const realFetch=globalThis.fetch;globalThis.fetch=async(url)=>{seen.push(String(url));return new Response(JSON.stringify({ok:true}),{status:200,headers:{'content-type':'application/json'}});};
 try{
  assert.equal((await gate(req('/api/campaigns?status=open&mode=family'),env,1800000000)).status,200);assert.equal(seen.pop(),'https://kids-test.up.railway.app/api/campaigns?status=open&mode=family');
  assert.equal((await gate(req('/api/campaigns'),env,1800000000)).status,200);assert.equal(seen.pop(),'https://kids-test.up.railway.app/api/campaigns');
  assert.equal((await gate(req('/api/campaigns/'+addr(1)),env,1800000000)).status,200);assert.equal((await gate(req('/api/campaigns/'+addr(1)+'/terms'),env,1800000000)).status,200);
  assert.equal((await gate(req('/api/campaigns/'+GENESIS+':'+PROGRAM+':'+addr(1)+'/terms'),env,1800000000)).status,200);
  assert.equal((await gate(req('/api/campaigns/'+addr(1)+'?x=1'),env,1800000000)).status,404);assert.equal((await gate(req('/api/campaigns/'+addr(1)+'/claim'),env,1800000000)).status,404);
  assert.equal((await gate(req('/api/campaigns?'+'a'.repeat(601)),env,1800000000)).status,404);
  assert.equal((await gate(req('/api/campaigns',{method:'POST',headers:{origin:'https://kids.fun','content-type':'application/json'},body:'{}'}),env,1800000000)).status,404);
  assert.equal(seen.length,3,'refused requests never reach the backend');
  for(const suffix of ['', '?status=open&cursor=eyJvIjo0fQ', '/'+addr(1)+'/terms']){const path='/api/account/launches/campaigns'+suffix;assert.equal((await gate(req(path),env,1800000000)).status,200);assert.equal(seen.pop(),'https://kids-test.up.railway.app'+path);}
  assert.equal((await gate(req('/api/account/launches/campaigns/'+addr(1)+'?x=1'),env,1800000000)).status,404);
 }finally{globalThis.fetch=realFetch;}
});
test('bounded directory pages find older creator launches and search across pages',async()=>{
 const r=openRegistry();r.migrate();for(let n=1;n<=65;n++)r.campaigns.upsert(row(n,{creator:n%2?addr(90):addr(91),name:n===1?'Early %_! coin':'Coin '+n,symbol:'C'+n}));
 const s=await serve(campaignsPlugin({authorize:()=>true,registry:r}));
 try{
  const first=await s.get('/api/campaigns?creator='+addr(90)+'&limit=20');assert.equal(first.status,200);assert.equal(first.body.campaigns.length,20);assert.ok(first.body.campaigns.every(c=>c.creator===addr(90)));assert.ok(first.body.nextCursor);
  const second=await s.get('/api/campaigns?creator='+addr(90)+'&limit=20&cursor='+first.body.nextCursor);assert.equal(second.body.campaigns.length,13);assert.equal(second.body.nextCursor,null);assert.equal(second.body.campaigns.at(-1).campaign,addr(1));assert.equal(new Set([...first.body.campaigns,...second.body.campaigns].map(c=>c.id)).size,33);
  for(const q of ['Early %_! coin','C1',addr(1)]){const result=await s.get('/api/campaigns?'+new URLSearchParams({q,limit:'20'}));assert.equal(result.status,200);assert.ok(result.body.campaigns.some(c=>c.campaign===addr(1)));}
  assert.equal((await s.get('/api/campaigns?'+new URLSearchParams({q:'%_!'}))).body.campaigns.length,1,'wildcards are literal');
  for(const q of ['creator=invalid','limit=1000','limit=0','limit=20&limit=20','q='+ 'x'.repeat(101)])assert.equal((await s.get('/api/campaigns?'+q)).status,400);
 }finally{await s.close();r.close();}
});

test('concurrent pages larger than the coin cache coalesce enrichment without hiding directory updates',async()=>{
 const registry=openRegistry();registry.migrate();for(let n=1;n<=220;n++)registry.campaigns.upsert(row(n));
 const paths=[];let cursor=null;do{paths.push('/api/campaigns?limit=20'+(cursor?'&cursor='+encodeURIComponent(cursor):''));cursor=registry.campaigns.list({limit:20,cursor}).nextCursor;}while(cursor);
 let reads=0;const s=await serve(campaignsPlugin({registry,authorize:()=>true,readView:async()=>{reads++;await new Promise(r=>setTimeout(r,10));return {available:false,reason:'Indexing'};}}));
 try{const responses=await Promise.all(Array.from({length:110},(_,i)=>s.get(paths[i%paths.length])));assert.ok(responses.every(r=>r.status===200&&r.body.count===20));assert.equal(reads,220,'Each shared projection read once despite more coins than cache slots');
  registry.campaigns.upsert({...row(220),name:'Updated name'});const latest=await s.get(paths[0]);assert.equal(latest.body.campaigns[0].name,'Updated name','Fresh registry rows must not be concealed by page coalescing');
 }finally{await s.close();registry.close();}
});

test('registry diagnostics never expose driver messages in responses or logs',async()=>{
 const marker='synthetic-private-driver-detail',logs=[];
 const failed=await serve(campaignsPlugin({authorize:()=>true,open:()=>{throw Error(marker);},log:e=>logs.push(e)}));
 try{const r=await failed.get('/api/campaigns');assert.equal(r.status,503);assert.ok(!JSON.stringify([r.body,logs]).includes(marker));}finally{await failed.close();}
 const listed=await serve(campaignsPlugin({authorize:()=>true,registry:{campaigns:{list:async()=>{throw Error(marker);}}}}));
 try{const r=await listed.get('/api/campaigns');assert.equal(r.status,503);assert.ok(!JSON.stringify(r.body).includes(marker));}finally{await listed.close();}
});

test('identical concurrent directory queries share work but never authorization or settled results',async()=>{
 const r=openRegistry();r.migrate();r.campaigns.upsert(row(1));
 let release,queries=0,authChecks=0,revision=1;
 const blocked=new Promise(resolve=>{release=resolve;});
 const registry={campaigns:{list:async filters=>{queries++;await blocked;return r.campaigns.list(filters);}}};
 const s=await serve(campaignsPlugin({registry,authorize:req=>{authChecks++;return req.headers['x-test-access']==='yes';},manifest:()=>({revision})}));
 try{
  const work=Promise.all(Array.from({length:10},()=>s.get('/api/campaigns',{headers:{'x-test-access':'yes'}})));
  const denied=await s.get('/api/campaigns');assert.equal(denied.status,403);
  const until=Date.now()+3000;while(authChecks<11&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(authChecks,11);assert.equal(queries,1);release();
  assert.ok((await work).every(x=>x.status===200&&x.body.manifest.revision===1));
  revision=2;r.campaigns.upsert({...row(1),name:'Changed'});
  const next=await s.get('/api/campaigns',{headers:{'x-test-access':'yes'}});
  assert.equal(queries,2);assert.equal(next.body.campaigns[0].name,'Changed');assert.equal(next.body.manifest.revision,2);
 }finally{release();await s.close();r.close();}
});
