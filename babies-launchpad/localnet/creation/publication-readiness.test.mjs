import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';
import {Keypair} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';import {canonicalHash} from '../registry/canonical.mjs';
import {createCreationStore} from './store.mjs';import {createMetadataPublisher} from './publication.mjs';import {contentHash} from './pinata.mjs';
import {cidV0} from './ipfs-cid.mjs';import {PINATA_GATEWAY} from '../token-metadata.mjs';import {createPublicationReadiness} from './publication-readiness.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,address=()=>Keypair.generate().publicKey.toBase58();
test('publication readiness maps a campaign to its two metadata receipts: sealed waits, published launches, attention alerts, untracked is unaffected',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:4,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const owner=address(),config={mode:'localnet-rehearsal',programVersion:3,pilotCreator:owner,genesisHash:address(),programId:address(),fundingFirst:true};
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]),image={owner,assetId:'pfp',sanitized:true,sha256:contentHash(bytes),bytes,contentType:'image/png'};
  const provider={publish:async input=>{const cid=input.cid??cidV0(input.bytes);return {cid,uri:PINATA_GATEWAY+cid,inputHash:input.inputHash};},recover:async()=>null};
  const publisher=createMetadataPublisher({registry,config,provider,limits:{ownerPins:10,globalPins:10,ownerBytes:100000,globalBytes:100000},loadOwnedImage:async()=>image});
  const store=createCreationStore(registry),draft={name:'Ready coin',symbol:'READY',description:'Creator-approved text.',pfp:{assetId:'pfp',sha256:image.sha256}};
  await registry.drafts.save({creator:owner,id:'ready',revision:0,body:draft});
  const q=await store.issue({owner,draftId:'ready',revision:1,draftHash:canonicalHash(draft),descriptorHash:canonicalHash({draftId:'ready'}),requestKey:'ready',body:{genesisHash:config.genesisHash,programId:config.programId,terms:{mode:'standard'},fundingEnabled:false,publicationConsent:true}});
  const request=await store.accept({owner,quoteId:q.id}),id={genesisHash:config.genesisHash,programId:config.programId,campaign:address()};
  // The creator flow's reservation row binds the request to its campaign (creation_preparations, one per campaign).
  await registry.query("INSERT INTO creation_preparations(request_id,genesis_hash,program_id,program_version,campaign,nonce,authority,descriptor_hash,state,mint_lease_id,mint,created_at,updated_at) VALUES(?,?,?,3,?,'1',?,?,'reserved',?,?,1,1)",[request.id,id.genesisHash,id.programId,id.campaign,address(),'d'.repeat(64),'lease-1',address()]);
  const readiness=createPublicationReadiness(registry);
  assert.deepEqual(await readiness.read({...id,campaign:address()}),{tracked:false,ready:true,requestId:null,image:null,document:null,uri:null,attention:false,pending:[]},'no creator-flow record');
  assert.deepEqual(await readiness.read(id),{tracked:true,ready:false,requestId:request.id,image:'missing',document:'missing',uri:null,attention:false,pending:['image','document']},'accepted but not yet published');
  const result=await publisher.publish(owner,request.id);assert.equal(result.status,'sealed');
  let r=await readiness.read(id);assert.equal(r.ready,false);assert.equal(r.image,'sealed');assert.equal(r.document,'sealed');assert.equal(r.uri,result.metadata.uri);assert.deepEqual(r.pending,['image','document']);assert.equal(r.attention,false);
  while(await publisher.tickSealed());
  r=await readiness.read(id);assert.deepEqual(r,{tracked:true,ready:true,requestId:request.id,image:'published',document:'published',uri:result.metadata.uri,attention:false,pending:[]});
  await registry.query("UPDATE creation_publications SET state='attention' WHERE request_id=? AND stage='document'",[request.id]);
  r=await readiness.read(id);assert.equal(r.ready,false);assert.equal(r.attention,true);assert.deepEqual(r.pending,['document']);assert.equal(r.uri,result.metadata.uri,'the sealed URI is still reported');
  await assert.rejects(readiness.read({genesisHash:id.genesisHash}),/campaign identity/);assert.throws(()=>createPublicationReadiness({}),/registry/);
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
