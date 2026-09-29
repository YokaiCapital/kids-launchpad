import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';
import {Keypair} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {createCreationStore} from './store.mjs';import {createMetadataPublisher} from './publication.mjs';import {contentHash} from './pinata.mjs';
import {cidV0,IPFS_CHUNK_BYTES} from './ipfs-cid.mjs';import {PINATA_GATEWAY,metadataDocument} from '../token-metadata.mjs';import {publishedCreatorProfile} from './creator-profile.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,address=()=>Keypair.generate().publicKey.toBase58();
test('funding-first publication seals the document and a single-chunk image with the local content id; the provider pin runs in the background and must agree',{skip:!url},async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const owner=address(),config={mode:'localnet-rehearsal',programVersion:3,pilotCreator:owner,genesisHash:address(),programId:address(),fundingFirst:true};
  const png=Buffer.from([137,80,78,71,13,10,26,10]),small=Buffer.concat([png,Buffer.from([1,2,3])]),big=Buffer.concat([png,Buffer.alloc(IPFS_CHUNK_BYTES,9)]);
  const images={small:{owner,assetId:'small',sanitized:true,sha256:contentHash(small),bytes:small,contentType:'image/png'},big:{owner,assetId:'big',sanitized:true,sha256:contentHash(big),bytes:big,contentType:'image/png'}};
  const posts=[],pins=new Map(),logs=[];let mode='exact';
  const wrongCid='Qm'+'c'.repeat(44),mismatch=(input,cid)=>Object.assign(Error('mismatch'),{code:'PUBLICATION_CID_MISMATCH',sealedCid:input.cid,providerCid:cid});
  const idOf=input=>input.bytes.length<=IPFS_CHUNK_BYTES?cidV0(input.bytes):'Qm'+'a'.repeat(44);
  const provider={
   publish:async input=>{posts.push({stage:input.stage,operationId:input.operationId,cid:input.cid??null});
    const cid=(mode==='wrong'||mode==='wrong-receipt')&&input.stage==='document'?wrongCid:input.cid??idOf(input),value={cid,uri:PINATA_GATEWAY+cid,inputHash:input.inputHash};pins.set(input.operationId,value);
    if(mode==='lost')throw Error('lost provider response');
    if(mode==='wrong'&&input.cid!==undefined&&cid!==input.cid)throw mismatch(input,cid);
    return value;},
   recover:async input=>{const value=pins.get(input.operationId)??null;if(value&&mode!=='wrong-receipt'&&input.cid!==undefined&&value.cid!==input.cid)throw mismatch(input,value.cid);return value;}
  };
  const limits={ownerPins:60,globalPins:80,ownerBytes:5_000_000,globalBytes:10_000_000};
  const open=extra=>createMetadataPublisher({registry,config,provider,limits,loadOwnedImage:async({assetId})=>images[assetId],log:e=>logs.push(e),...extra});
  const store=createCreationStore(registry);
  async function accepted(draftId,asset='small',extra={}){
   const draft={name:'Sealed coin',symbol:'SEAL',description:'Creator-approved text.',pfp:{assetId:asset,sha256:images[asset].sha256},...extra};
   await registry.drafts.save({creator:owner,id:draftId,revision:0,body:draft});
   const q=await store.issue({owner,draftId,revision:1,draftHash:canonicalHash(draft),descriptorHash:canonicalHash({draftId}),requestKey:draftId,body:{genesisHash:config.genesisHash,programId:config.programId,terms:{mode:'standard'},fundingEnabled:false,publicationConsent:true}});
   return {draft,...(await store.accept({owner,quoteId:q.id}))};
  }
  const rows=async id=>Object.fromEntries((await registry.query('SELECT * FROM creation_publications WHERE request_id=? ORDER BY stage',[id])).rows.map(r=>[r.stage,r]));
  const expectedDocument=(draft,imageCid)=>{const document=metadataDocument(draft,PINATA_GATEWAY+imageCid,{imageType:'image/png'});return {document,cid:cidV0(Buffer.from(canonicalJson(document)))};};
  await t.test('the URI is final without a provider call; the background tick pins both receipts and turns them published',async()=>{
   const r=await accepted('instant'),publisher=open(),result=await publisher.publish(owner,r.id);
   assert.equal(result.status,'sealed','every URI is final; the pins are not confirmed yet');assert.equal(posts.length,0,'no provider call on the creator path');assert.deepEqual(result.pins,{image:'sealed',document:'sealed'});
   const imageCid=cidV0(small),{document,cid:documentCid}=expectedDocument(r.draft,imageCid);
   assert.equal(result.imageUri,PINATA_GATEWAY+imageCid);assert.equal(result.metadata.uri,PINATA_GATEWAY+documentCid);assert.equal(result.metadata.documentHash,canonicalHash(document));assert.deepEqual(result.document,document);
   let saved=await rows(r.id);assert.equal(saved.image.state,'sealed');assert.equal(saved.document.state,'sealed');assert.equal(saved.document.cid,documentCid);assert.equal(Number(saved.document.attempts),0);
   assert.equal(Number((await registry.query("SELECT pins FROM creation_publication_usage WHERE scope='global'")).rows[0].pins),2,'the quota is charged at the seal');
   assert.equal(logs.filter(e=>e.event==='publication-sealed').length,2);
   // The readers accept a sealed receipt as the final URI (the profile is what registration publishes).
   const body=JSON.parse((await registry.query('SELECT body FROM creation_requests WHERE request_id=?',[r.id])).rows[0].body);
   const intent={mint:{genesisHash:config.genesisHash,programId:config.programId,campaign:address(),creator:owner,requestId:r.id,metadata:result.metadata}};
   assert.equal(publishedCreatorProfile({intent,accepted:body,receipts:Object.values(saved)}).media.pfp,result.imageUri);
   while(await publisher.tickSealed());
   saved=await rows(r.id);assert.equal(saved.image.state,'published');assert.equal(saved.document.state,'published');assert.equal(saved.document.cid,documentCid);assert.equal(saved.image.cid,imageCid);
   assert.deepEqual(posts.map(p=>p.stage).sort(),['document','image']);assert.ok(posts.every(p=>p.cid),'the background pin names the sealed id');
   assert.equal(logs.filter(e=>e.event==='publication-pinned').length,2);
   const repeat=await publisher.publish(owner,r.id);assert.equal(repeat.status,'published');assert.equal(repeat.metadata.uri,PINATA_GATEWAY+documentCid,'a repeat answers the same URI');
   assert.equal(await publisher.tickSealed(),false,'nothing is left to pin');
  });
  await t.test('an image above one chunk keeps the provider pin; the document is still sealed at once',async()=>{
   const r=await accepted('large','big'),before=posts.length,publisher=open(),result=await publisher.publish(owner,r.id);
   assert.equal(result.status,'sealed');assert.deepEqual(result.pins,{image:'published',document:'sealed'});
   const saved=await rows(r.id);assert.equal(saved.image.state,'published');assert.equal(saved.document.state,'sealed');
   assert.equal(posts.length,before+1);assert.equal(posts.at(-1).stage,'image');assert.equal(posts.at(-1).cid,null,'the provider chooses the large image id');
   assert.equal(result.metadata.uri,PINATA_GATEWAY+expectedDocument(r.draft,'Qm'+'a'.repeat(44)).cid);
   while(await publisher.tickSealed());assert.equal((await rows(r.id)).document.state,'published');assert.equal(posts.length,before+2);
  });
  await t.test('a lost provider answer is journaled and recovered under the same operation; the backoff is respected',async()=>{
   const r=await accepted('lost'),publisher=open();mode='lost';
   assert.equal((await publisher.publish(owner,r.id)).status,'sealed');
   const before=posts.length;assert.equal(await publisher.tickSealed(),true);assert.equal(await publisher.tickSealed(),true);
   assert.equal(posts.length,before+2,'one post per sealed receipt');
   let saved=await rows(r.id);assert.equal(saved.image.state,'sealed');assert.equal(Number(saved.image.attempts),1);assert.ok(Number(saved.image.next_attempt_at)>Date.now()+5000,'next attempt after the backoff');
   assert.equal(await publisher.tickSealed(),false,'nothing is due before the backoff');
   mode='exact';await registry.query('UPDATE creation_publications SET next_attempt_at=0 WHERE request_id=?',[r.id]);
   while(await publisher.tickSealed());
   saved=await rows(r.id);assert.equal(saved.image.state,'published');assert.equal(saved.document.state,'published');assert.equal(posts.length,before+2,'recovered from the provider record, not re-posted');
  });
  await t.test('a provider that pins another content id turns the receipt to attention, alerts and stops sealing in this process',async()=>{
   const r=await accepted('wrong'),publisher=open();mode='wrong';
   assert.equal((await publisher.publish(owner,r.id)).status,'sealed');
   while(await publisher.tickSealed());
   const saved=await rows(r.id);assert.equal(saved.image.state,'published');assert.equal(saved.document.state,'attention');
   const alert=logs.find(e=>e.event==='publication-cid-mismatch');assert.equal(alert?.requestId,r.id);assert.equal(alert.stage,'document');assert.equal(alert.providerCid,wrongCid);assert.equal(alert.cid,saved.document.cid);
   assert.equal(logs.find(e=>e.event==='publication-sealing-disabled')?.reason,'publication-cid-mismatch');
   // The creation answers pending for attention (never a URI the pin contradicts); a new request pins through the provider.
   const again=await publisher.publish(owner,r.id);assert.equal(again.status,'pending');assert.equal(again.stage,'document');assert.equal(again.reason,'publication-attention');
   mode='exact';const next=await accepted('after-distrust'),before=posts.length,result=await publisher.publish(owner,next.id);
   assert.equal(result.status,'published');assert.deepEqual(result.pins,{image:'published',document:'published'});assert.equal(posts.length,before+2);
   assert.equal(await publisher.tickSealed(),false);
  });
  await t.test('a receipt that names another id without a typed error is refused the same way',async()=>{
   const r=await accepted('wrong-receipt'),publisher=open();mode='wrong-receipt';const before=logs.length;
   assert.equal((await publisher.publish(owner,r.id)).status,'sealed');while(await publisher.tickSealed());
   assert.equal((await rows(r.id)).document.state,'attention');assert.ok(logs.slice(before).some(e=>e.event==='publication-cid-mismatch'&&e.providerCid===wrongCid));mode='exact';
  });
  await t.test('sealed receipts survive a restart: a fresh publisher pins what the closed one sealed; attention rows are left to the operator',async()=>{
   const first=open(),r=await accepted('restart');assert.equal((await first.publish(owner,r.id)).status,'sealed');await first.close();
   const second=open();while(await second.tickSealed());const saved=await rows(r.id);assert.equal(saved.image.state,'published');assert.equal(saved.document.state,'published');
   assert.equal((await second.publish(owner,r.id)).status,'published');
   assert.ok(Number((await registry.query("SELECT COUNT(*) AS n FROM creation_publications WHERE state='attention'")).rows[0].n)>=1);assert.equal(await second.tickSealed(),false,'attention rows are never retried automatically');
  });
  await t.test('a prepared receipt with the same id is adopted as published and confirms the computation; a different one disproves it',async()=>{
   const publisher=open();
   const prepare=async(draftId,name)=>{
    const draft={mode:'standard',publicationConsent:true,name,symbol:'SEAL',description:'Creator-approved text.',pfp:{assetId:'small',sha256:images.small.sha256}};
    await registry.drafts.save({creator:owner,id:draftId,revision:0,body:draft});await publisher.prepareDraft(owner,{draftId,revision:1});
    while((await registry.query("SELECT state FROM creation_prepublications WHERE draft_id=?",[draftId])).rows[0].state!=='published')await publisher.tickPrepublication();
    const q=await store.issue({owner,draftId,revision:1,draftHash:canonicalHash(draft),descriptorHash:canonicalHash({draftId}),requestKey:draftId,body:{genesisHash:config.genesisHash,programId:config.programId,terms:{mode:'standard'},fundingEnabled:false,publicationConsent:true}});
    return {draft,...(await store.accept({owner,quoteId:q.id}))};
   };
   const r=await prepare('prepared','Prepared coin'),before=posts.length,result=await publisher.publish(owner,r.id);
   assert.equal(result.status,'published');assert.deepEqual(result.pins,{image:'published',document:'published'});assert.equal(posts.length,before,'no new pin');
   assert.equal(result.metadata.uri,PINATA_GATEWAY+expectedDocument(r.draft,cidV0(small)).cid);assert.equal(logs.filter(e=>e.event==='publication-seal-confirmed').length,1);
   const other=await prepare('contradicted','Contradicted coin');
   await registry.query("UPDATE creation_prepublication_receipts SET cid=? WHERE stage='document' AND input_hash=?",[wrongCid,canonicalHash(expectedDocument(other.draft,cidV0(small)).document)]);
   const adopted=await publisher.publish(owner,other.id);assert.equal(adopted.status,'published');assert.equal(adopted.metadata.uri,PINATA_GATEWAY+wrongCid,'the verified provider id is what is reused');
   const contradiction=logs.find(e=>e.event==='publication-seal-contradicted');assert.equal(contradiction?.requestId,other.id);assert.equal(contradiction.providerCid,wrongCid);
   const later=await accepted('after-contradiction'),count=posts.length;assert.deepEqual((await publisher.publish(owner,later.id)).pins,{image:'published',document:'published'});
   assert.equal(posts.length,count+1,'sealing is off after a contradiction: the document is posted (the same picture reuses its prepared receipt)');assert.equal(posts.at(-1).stage,'document');assert.equal(posts.at(-1).cid,null);
  });
  await t.test('without the funding-first admission the provider path is unchanged',async()=>{
   const r=await accepted('legacy','big'),before=posts.length,result=await open({config:{...config,fundingFirst:false}}).publish(owner,r.id);
   assert.equal(result.status,'published');assert.deepEqual(result.pins,{image:'published',document:'published'});assert.equal(posts.length,before+2);assert.ok(posts.slice(-2).every(p=>p.cid===null));
  });
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
