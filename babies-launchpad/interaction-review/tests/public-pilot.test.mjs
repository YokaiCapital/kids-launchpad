import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeypair,signWithSeed} from '../../shared/solana.mjs';
import {createPublicLaunchAccess} from '../server/public-launch-access.mjs';
import {createPublicLaunchAccount} from '../server/public-launch-account.mjs';
import {accountPlugin} from '../server/account-plugin.mjs';
import {campaignsPluginFor} from '../server/campaigns-plugin.mjs';
import {createApiServer} from '../server/runtime.mjs';
import {openRegistry} from '../../localnet/registry/registry.mjs';
import {initialDraft} from '../src/public/launch-draft.mjs';

const chosen=generateKeypair().address;
test('pilot access is exact, server-configured, closed if missing, and malformed configuration refuses startup',()=>{
 const access=createPublicLaunchAccess({KIDS_PUBLIC_PILOT_WALLET:chosen});
 assert.equal(access.allows(chosen),true);
 for(const owner of [null,undefined,'',chosen.toLowerCase(),{owner:chosen}])assert.equal(access.allows(owner),false);
 assert.equal(createPublicLaunchAccess({}).allows(chosen),false);
 for(const wallet of ['*','any',chosen+' ',chosen+','+chosen])assert.throws(()=>createPublicLaunchAccess({KIDS_PUBLIC_PILOT_WALLET:wallet}),/canonical/);
});
test('all pilot account actions reject another wallet before touching registry or transaction workers',async()=>{
 const owner=generateKeypair().address;
 const api=createPublicLaunchAccount({registry:()=>{throw Error('must not access');},access:createPublicLaunchAccess({KIDS_PUBLIC_PILOT_WALLET:chosen})});
 for(const [method,route] of [['GET','drafts'],['GET','positions'],['GET','artwork/owned-pfp'],...['drafts/save','artwork/upload','positions','prepare','submit','status','cancel','creation/quote','creation/accept','creation/status','creation/setup/prepare','creation/setup/submit','creation/setup/status','creation/setup/resume','creation/setup/recover',...['prepare','submit','status','resume','recover'].map(x=>'creation/flow/'+x),'market/read'].map(x=>['POST',x])]){
  const result=await api.handle({method,path:'/api/account/launches/'+route,owner,input:{owner:chosen,wallet:chosen}});
  assert.equal(result.status,403,route);
 }
 assert.equal((await api.handle({method:'GET',path:'/api/account/launches/drafts',owner:null})).status,401);
});
test('real signed session gates directory and drafts; spoofing and logout cannot reuse pilot access',async()=>{
 const a=generateKeypair(),b=generateKeypair(),dir=mkdtempSync(join(tmpdir(),'kids-pilot-'));
 const registry=openRegistry();registry.migrate();
 const env={KIDS_REGISTRY_URL:join(dir,'registry.sqlite'),KIDS_PUBLIC_PILOT_WALLET:a.address};
 let uploads=0,artReads=0;const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]),asset={assetId:'owned-pfp',sha256:'a'.repeat(64),status:'ready',kind:'pfp'};
 const artwork={upload:async(owner,input)=>{assert.equal(owner,a.address);assert.ok(input.bytes.equals(png));assert.equal(input.kind,'pfp');uploads++;return asset;},status:async(owner,id)=>owner===a.address&&id===asset.assetId?asset:null,loadOwnedImage:async({owner,assetId})=>{assert.equal(owner,a.address);assert.equal(assetId,asset.assetId);artReads++;return {bytes:png};}};
 const setupCalls=[];const provisioning=Object.fromEntries(['prepare','submit','status','resume','recover'].map(action=>[action,async(owner,input)=>{setupCalls.push({action,owner,input});return {action,requestId:input.requestId};}]));
 const service=createPublicLaunchAccount({registry,artwork,provisioning,creatorFlow:provisioning,access:createPublicLaunchAccess(env)});
 const writesGate={open:true};
 const runtime=createApiServer({writesGate,plugins:[accountPlugin({publicLaunchService:service,accountFilename:join(dir,'accounts.sqlite')}),campaignsPluginFor({env,registryImport:{configured:true,registry}})],probe:async()=>true,probeInterval:60000});
 await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+runtime.server.address().port;
 async function request(path,{cookie='',body,csrf,headers={}}={}){
  const res=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{origin,cookie,...(body!==undefined?{'content-type':'application/json','x-kids-csrf':csrf}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:res.status,body:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
 }
 async function login(wallet,csrf){const ch=await request('/api/account/challenge',{csrf,body:{owner:wallet.address}});assert.equal(ch.status,200);const signature=signWithSeed(wallet.seed,Buffer.from(ch.body.message)).toString('base64');return request('/api/account/verify',{csrf,body:{id:ch.body.id,signature}});}
 try{
  const state=await request('/api/account/state');assert.equal(state.status,200);const csrf=state.body.csrf;
  assert.equal(state.body.publicLaunches.allowed,false);
  const prefix='/api/account/launches/campaigns';
  assert.equal((await request(prefix)).status,401);
  assert.equal((await request('/api/campaigns',{headers:{'x-wallet':a.address,'x-kids-owner':a.address}})).status,403);
  const other=await login(b,csrf);assert.equal(other.body.publicLaunches.allowed,false);
  assert.equal((await request(prefix,{cookie:other.cookie})).status,403);
  const approved=await login(a,csrf);assert.equal(approved.body.publicLaunches.allowed,true);assert.ok(approved.cookie);
  const list=await request(prefix,{cookie:approved.cookie});assert.equal(list.status,200);assert.deepEqual(list.body.campaigns,[]);
  assert.equal((await request('/api/campaigns',{cookie:approved.cookie})).status,403,'old URL has no authenticated context');
  const draft=initialDraft(null,{creator:a.address});draft.name='Private pilot';
  const saved=await request('/api/account/launches/drafts/save',{cookie:approved.cookie,csrf,body:{id:'private-draft',revision:0,draft}});assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.equal((await request('/api/account/launches/drafts/save',{cookie:other.cookie,csrf,body:{owner:a.address,id:'private-draft',revision:1,draft}})).status,403);
  assert.equal((await request('/api/account/launches/drafts/save',{cookie:approved.cookie,csrf:'bad',body:{id:'private-draft',revision:1,draft}})).status,403);
  const uploadPath='/api/account/launches/artwork/upload',imagePath='/api/account/launches/artwork/'+asset.assetId;
  const upload=(cookie,token)=>fetch(origin+uploadPath,{method:'POST',headers:{origin,cookie,'x-kids-csrf':token,'content-type':'image/png','x-kids-upload-id':'upload-one','x-kids-artwork-kind':'pfp'},body:png});
  assert.equal((await upload('',csrf)).status,401);assert.equal((await upload(other.cookie,csrf)).status,403);assert.equal((await upload(approved.cookie,'bad')).status,403);assert.equal(uploads,0);
  assert.equal((await upload(approved.cookie,csrf)).status,200);assert.equal(uploads,1);
  assert.equal((await request(imagePath)).status,401);assert.equal((await request(imagePath,{cookie:other.cookie})).status,403);assert.equal(artReads,0);
  const image=await fetch(origin+imagePath,{headers:{origin,cookie:approved.cookie}});assert.equal(image.status,200);assert.equal(image.headers.get('cache-control'),'private, no-store');assert.equal(image.headers.get('vary'),'Cookie');assert.equal(image.headers.get('cross-origin-resource-policy'),'same-origin');assert.equal(image.headers.get('content-type'),'image/png');assert.ok(Buffer.from(await image.arrayBuffer()).equals(png));assert.equal(artReads,1);
  const ownedDraft={...draft,pfp:{...asset,url:'https://attacker.example/ignored.png',sanitized:true}};
  const artSaved=await request('/api/account/launches/drafts/save',{cookie:approved.cookie,csrf,body:{id:'private-art-draft',revision:0,draft:ownedDraft}});assert.equal(artSaved.status,200);assert.equal(artSaved.body.draft.body.pfp.url,imagePath);assert.equal(artSaved.body.draft.body.pfp.sanitized,undefined);
  assert.equal((await request('/api/account/launches/drafts/save',{cookie:approved.cookie,csrf,body:{id:'bad-art',revision:0,draft:{...ownedDraft,pfp:{assetId:'not-owned',sha256:asset.sha256}}}})).status,400);
  for(const group of ['setup','flow'])for(const action of ['prepare','submit','status','resume','recover']){
   const path='/api/account/launches/creation/'+group+'/'+action,body={requestId:'one',owner:b.address};
   assert.equal((await request(path,{csrf,body})).status,401);
   assert.equal((await request(path,{cookie:other.cookie,csrf,body})).status,403);
   assert.equal((await request(path,{cookie:approved.cookie,csrf:'bad',body})).status,403);
   assert.equal((await request(path,{cookie:approved.cookie,csrf,body,headers:{origin:'https://attacker.invalid'}})).status,403);
   const before=setupCalls.length;assert.equal((await request(path,{cookie:approved.cookie,csrf,body})).status,200);assert.equal(setupCalls.length,before+1);assert.equal(setupCalls.at(-1).owner,a.address);
   writesGate.open=false;
   assert.equal((await request(path,{cookie:approved.cookie,csrf,body})).status,action==='status'?200:503);
   assert.equal(setupCalls.length,before+(action==='status'?2:1));writesGate.open=true;
  }
  const signedOut=await request('/api/account/logout',{cookie:approved.cookie,csrf,body:{}});assert.equal(signedOut.body.publicLaunches.allowed,false);
  assert.equal((await request(prefix,{cookie:approved.cookie})).status,401);
  assert.equal((await request(imagePath,{cookie:approved.cookie})).status,401);
  assert.equal((await request('/api/account/state',{cookie:other.cookie})).body.owner,b.address,'other wallets still sign in to the legacy site');
 }finally{await runtime.shutdown();registry.close();rmSync(dir,{recursive:true,force:true});}
});
