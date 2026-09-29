import test from 'node:test';
import assert from 'node:assert/strict';
import {cropRect} from '../src/public/artwork-crop.mjs';
import {uploadPrivateArtwork} from '../src/public/artwork-upload.mjs';
import {initialDraft,reduceDraft} from '../src/public/launch-draft.mjs';
test('crop geometry has exact 1:1/3:1 output and cannot exceed source at any pan',()=>{
 for(const [width,height] of [[1200,800],[600,1200],[2000,2000]])for(const kind of ['pfp','banner'])for(const zoom of [1,1.5,3])for(const x of [0,0.5,1])for(const y of [0,0.5,1]){
  const r=cropRect({width,height,kind,zoom,x,y});assert.equal(r.outWidth/r.outHeight,kind==='pfp'?1:3);assert.ok(r.left>=0&&r.top>=0&&r.left+r.width<=width+1e-9&&r.top+r.height<=height+1e-9);assert.ok(Number.isInteger(r.outWidth)&&Number.isInteger(r.outHeight));
 }
 assert.throws(()=>cropRect({width:8192,height:8192,kind:'pfp'}));assert.throws(()=>cropRect({width:64,height:64,kind:'pfp',zoom:3}));
});
test('artwork upload preserves idempotency and accepts only bounded matching server receipts',async()=>{
 const blob=new Blob([Buffer.alloc(100)],{type:'image/png'}),args={blob,kind:'pfp',requestId:'one',csrf:'csrf'},asset={assetId:'one',status:'ready',kind:'pfp',sha256:'a'.repeat(64),size:100,contentType:'image/png'};
 let calls=0;const fetchImpl=async(path,options)=>{calls++;assert.equal(path,'/api/account/launches/artwork/upload');assert.equal(options.headers['x-kids-upload-id'],'one');assert.equal(options.credentials,'same-origin');assert.equal(options.headers['x-kids-csrf'],'csrf');assert.equal(options.body,blob);return Response.json({artwork:asset});};
 const result=await uploadPrivateArtwork({...args,fetchImpl});assert.equal(result.url,'/api/account/launches/artwork/one');await uploadPrivateArtwork({...args,fetchImpl});assert.equal(calls,2);
 for(const patch of [{status:'processing'},{kind:'banner'},{assetId:'../bad'},{sha256:'bad'},{size:3000000}])await assert.rejects(uploadPrivateArtwork({...args,fetchImpl:async()=>Response.json({artwork:{...asset,...patch}})}));
 await assert.rejects(uploadPrivateArtwork({...args,fetchImpl:async()=>new Response('x'.repeat(20000))}),/response unavailable/);
 await assert.rejects(uploadPrivateArtwork({...args,fetchImpl:async()=>Response.json({error:'Uploads are busy'},{status:503})}),/Uploads are busy/);
});
test('publication consent is explicit and resets whenever published content changes',()=>{
 const initial=initialDraft(null);assert.equal(initial.publicationConsent,false);const approved=reduceDraft(initial,{type:'set',field:'publicationConsent',value:true});assert.equal(approved.publicationConsent,true);
 for(const field of ['name','symbol','description','pfp','banner','video','xUrl','websiteUrl'])assert.equal(reduceDraft(approved,{type:'set',field,value:'changed'}).publicationConsent,false);
 assert.equal(reduceDraft(approved,{type:'set',field:'presetId',value:'larger'}).publicationConsent,true);
});
