import test from 'node:test';
import assert from 'node:assert/strict';
import {createPinataProvider,contentHash} from './pinata.mjs';
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {cidV0} from './ipfs-cid.mjs';
import {PINATA_GATEWAY} from '../token-metadata.mjs';
const cid='Qm'+'a'.repeat(44),jwt='synthetic-test-credential-not-a-secret';
const image=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const stage={stage:'image',operationId:'b'.repeat(64),inputHash:contentHash(image),bytes:image,contentType:'image/png'};
test('Pinata image publication preserves bare CID and verifies exact content without credential leakage',async()=>{
 const calls=[];const provider=createPinataProvider({jwt,fetchImpl:async(url,options)=>{
  calls.push(url);assert.equal(options.redirect,'error');assert.ok(options.signal);
  if(url.endsWith('/pinning/pinFileToIPFS')){assert.equal(options.headers.authorization,'Bearer '+jwt);assert.equal(options.body.get('file').name,'coin.png');assert.equal(JSON.parse(options.body.get('pinataMetadata')).keyvalues.kidsOperation,stage.operationId);return json({IpfsHash:cid});}
  assert.equal(url,PINATA_GATEWAY+cid);assert.equal(options.headers,undefined);return new Response(image);
 }});
 const result=await provider.publish(stage);assert.equal(result.uri,PINATA_GATEWAY+cid);assert.equal(result.inputHash,stage.inputHash);assert.equal(calls.length,2);
});
test('Pinata document publication pins the exact canonical bytes as a file; verification tolerates property order, not changed values',async()=>{
 const doc={name:'Coin',symbol:'Coin',image:PINATA_GATEWAY+cid},bytes=Buffer.from(canonicalJson(doc)),input={stage:'document',operationId:'d'.repeat(64),inputHash:canonicalHash(doc),document:doc,bytes};
 let changed=false,posted=null;
 const provider=createPinataProvider({jwt,fetchImpl:async(url,options)=>{
  if(url.endsWith('/pinning/pinFileToIPFS')){const file=options.body.get('file');posted=Buffer.from(await file.arrayBuffer());assert.equal(file.name,'metadata.json');assert.equal(file.type,'application/json');assert.deepEqual(JSON.parse(options.body.get('pinataOptions')),{cidVersion:0});assert.equal(JSON.parse(options.body.get('pinataMetadata')).keyvalues.kidsOperation,input.operationId);return json({IpfsHash:cid});}
  return json({image:doc.image,symbol:doc.symbol,name:changed?'Wrong':doc.name});
 }});
 assert.equal((await provider.publish(input)).inputHash,input.inputHash);assert.ok(posted.equals(bytes),'the provider receives the canonical bytes unchanged');
 changed=true;await assert.rejects(provider.verify(input,cid),{code:'PUBLICATION_UNCERTAIN'});
 await assert.rejects(provider.publish({...input,bytes:Buffer.from('{"name":"Other"}')}),/Invalid metadata publication/);
 await assert.rejects(provider.publish({...input,bytes:undefined}),/Invalid metadata publication/);
});
test('a sealed content id holds the provider to it: another id is a typed mismatch, the gateway is read at the sealed id',async()=>{
 const doc={name:'Sealed',symbol:'Sealed',image:PINATA_GATEWAY+cid},bytes=Buffer.from(canonicalJson(doc)),sealed=cidV0(bytes),input={stage:'document',operationId:'e'.repeat(64),inputHash:canonicalHash(doc),document:doc,bytes,cid:sealed};
 let answer=sealed;const gets=[];
 const provider=createPinataProvider({jwt,fetchImpl:async(url,options)=>{if(options.method==='POST')return json({IpfsHash:answer});gets.push(url);return new Response(bytes);}});
 assert.equal((await provider.publish(input)).cid,sealed);assert.deepEqual(gets,[PINATA_GATEWAY+sealed]);
 answer='Qm'+'c'.repeat(44);await assert.rejects(provider.publish(input),error=>error.code==='PUBLICATION_CID_MISMATCH'&&error.providerCid===answer&&error.sealedCid===sealed);assert.equal(gets.length,1,'no gateway read after a mismatch');
 answer='https://attacker.invalid/x';await assert.rejects(provider.publish(input),error=>error.code==='PUBLICATION_CID_MISMATCH'&&error.providerCid===null&&!error.message.includes('attacker'));
 const rows=[{ipfs_pin_hash:'Qm'+'c'.repeat(44),date_unpinned:null,metadata:{keyvalues:{kidsOperation:input.operationId,kidsContentSha256:input.inputHash}}}];
 const recovering=createPinataProvider({jwt,fetchImpl:async(url,options)=>options.method==='GET'&&url.startsWith('https://api.pinata.cloud/data/pinList?')?json({rows,count:1}):new Response(bytes)});
 await assert.rejects(recovering.recover(input),{code:'PUBLICATION_CID_MISMATCH'});rows[0].ipfs_pin_hash=sealed;assert.equal((await recovering.recover(input)).cid,sealed);
 await assert.rejects(provider.publish({...input,cid:'nope'}),/Invalid sealed content id/);
});
test('Pinata uncertain-request recovery checks operation, content and uniqueness; absence never republishes',async()=>{
 let rows=[],posts=0;
 const provider=createPinataProvider({jwt,fetchImpl:async(url,options)=>{
  if(options.method==='POST')posts++;
  if(url.startsWith('https://api.pinata.cloud/data/pinList?')){const u=new URL(url);assert.equal(u.searchParams.get('pageLimit'),'2');assert.equal(JSON.parse(u.searchParams.get('metadata[keyvalues]')).kidsOperation.value,stage.operationId);return json({rows,count:rows.length});}
  return new Response(image);
 }});
 assert.equal(await provider.recover(stage),null);
 const record={ipfs_pin_hash:cid,date_unpinned:null,metadata:{keyvalues:{kidsOperation:stage.operationId,kidsContentSha256:stage.inputHash}}};rows=[record];assert.equal((await provider.recover(stage)).cid,cid);
 rows=[record,record];await assert.rejects(provider.recover(stage));rows=[{...record,date_unpinned:'2026-09-26'}];await assert.rejects(provider.recover(stage));rows=[{...record,metadata:{keyvalues:{kidsOperation:'foreign'}}}];await assert.rejects(provider.recover(stage));assert.equal(posts,0);
});
test('Pinata provider bounds responses, rejects redirects/errors/invalid CIDs and redacts provider failures',async()=>{
 for(const fetchImpl of [async()=>json({IpfsHash:'https://attacker.invalid/image'}),async()=>json({private:jwt},500),async()=>{throw Error(jwt);},async()=>new Response('x'.repeat(16385)),async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(17000));c.close();}})),async()=>json({IpfsHash:cid})]){
  const p=createPinataProvider({jwt,fetchImpl});await assert.rejects(p.publish(stage),error=>error.code==='PUBLICATION_UNCERTAIN'&&!error.message.includes(jwt));
 }
});

test('supplemental banner uses bounded binary pinning and content verification',async()=>{
 let uploads=0;const input={...stage,stage:'banner'};const provider=createPinataProvider({jwt,fetchImpl:async(url,options)=>{if(options.method==='POST'){assert.ok(url.endsWith('/pinning/pinFileToIPFS'));uploads++;return json({IpfsHash:cid});}return new Response(image);}});assert.equal((await provider.publish(input)).inputHash,input.inputHash);assert.equal(uploads,1);
});

test('video pinning verifies MP4 bytes and rejects image-type substitutions before upload',async()=>{
 const bytes=Buffer.alloc(32);bytes.write('ftyp',4);const input={...stage,stage:'video',contentType:'video/mp4',bytes,inputHash:contentHash(bytes)};let posts=0;
 const provider=createPinataProvider({jwt,fetchImpl:async(url,options)=>{if(options.method==='POST'){posts++;assert.equal(options.body.get('file').name,'coin.mp4');assert.equal(options.body.get('file').type,'video/mp4');return json({IpfsHash:cid});}return new Response(bytes);}});
 assert.equal((await provider.publish(input)).inputHash,input.inputHash);assert.equal(posts,1);await assert.rejects(provider.publish({...input,contentType:'image/png'}));assert.equal(posts,1);
});
