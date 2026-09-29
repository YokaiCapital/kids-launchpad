import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';import {createCreationStore} from './store.mjs';import {canonicalHash} from '../registry/canonical.mjs';
import {createMetadataPublisher} from './publication.mjs';import {contentHash} from './pinata.mjs';import {PINATA_GATEWAY} from '../token-metadata.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL;
test('explicit draft consent prepares artwork; accepted creation adopts verified receipts without new pins',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool,publisher;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const owner=Keypair.generate().publicKey.toBase58(),config={mode:'localnet-rehearsal',programVersion:3,pilotCreator:owner,genesisHash:'genesis',programId:'program'},bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]),pins=new Map();let posts=0,holdDocument=null,enteredDocument=null;
  const draft={mode:'standard',name:'Prepared',symbol:'READY',description:'Approved text',publicationConsent:false,pfp:{assetId:'image',sha256:contentHash(bytes)}};
  const open=()=>createMetadataPublisher({registry,config,limits:{ownerPins:20,globalPins:20,ownerBytes:100000,globalBytes:100000},loadOwnedImage:async()=>({owner,assetId:'image',sanitized:true,sha256:contentHash(bytes),bytes,contentType:'image/png'}),provider:{publish:async i=>{posts++;if(i.stage==='document'&&holdDocument){enteredDocument();await holdDocument;}const cid='Qm'+(i.stage==='image'?'a':'b').repeat(44),r={cid,uri:PINATA_GATEWAY+cid,inputHash:i.inputHash};pins.set(i.operationId,r);return r;},recover:async i=>pins.get(i.operationId)}});
  publisher=open();await registry.drafts.save({creator:owner,id:'draft',revision:0,body:draft});await assert.rejects(publisher.prepareDraft(owner,{draftId:'draft',revision:1}));assert.equal(posts,0);
  draft.publicationConsent=true;await registry.drafts.save({creator:owner,id:'draft',revision:1,body:draft});
  await assert.rejects(publisher.prepareDraft('other',{draftId:'draft',revision:2}));await assert.rejects(publisher.prepareDraft(owner,{draftId:'draft',revision:1}));
  await publisher.prepareDraft(owner,{draftId:'draft',revision:2});await publisher.tickPrepublication();assert.equal(posts,2);
  assert.equal((await publisher.prepareDraft(owner,{draftId:'draft',revision:2})).status,'published');await publisher.close();publisher=open();
  const store=createCreationStore(registry),quote=await store.issue({owner,draftId:'draft',revision:2,draftHash:canonicalHash(draft),descriptorHash:canonicalHash({draft}),requestKey:'accept',body:{genesisHash:config.genesisHash,programId:config.programId,terms:{mode:'standard'},fundingEnabled:false,publicationConsent:true}}),accepted=await store.accept({owner,quoteId:quote.id});
  const result=await publisher.publishCore(owner,accepted.id);assert.equal(result.status,'published');assert.equal(posts,2);
  assert.equal(Number((await registry.query("SELECT pins FROM creation_publication_usage WHERE scope='global'")).rows[0].pins),2);
  const rows=(await registry.query('SELECT * FROM creation_publications WHERE request_id=?',[accepted.id])).rows;assert.equal(rows.length,2);assert.ok(rows.every(r=>r.state==='published'));
  // Changing the name invalidates only the document; the owned image receipt remains reusable.
  const changed={...draft,name:'Changed'};await registry.drafts.save({creator:owner,id:'changed',revision:0,body:changed});await publisher.prepareDraft(owner,{draftId:'changed',revision:1});await publisher.tickPrepublication();assert.equal(posts,3);
  let release,entered;holdDocument=new Promise(r=>release=r);const began=new Promise(r=>entered=r);enteredDocument=entered;
  const slow={...draft,name:'Slow receipt'};await registry.drafts.save({creator:owner,id:'slow',revision:0,body:slow});
  await publisher.prepareDraft(owner,{draftId:'slow',revision:1});await began;
  const slowQuote=await store.issue({owner,draftId:'slow',revision:1,draftHash:canonicalHash(slow),descriptorHash:canonicalHash(slow),requestKey:'slow-accept',body:{genesisHash:config.genesisHash,programId:config.programId,terms:{mode:'standard'},fundingEnabled:false,publicationConsent:true}}),slowRequest=await store.accept({owner,quoteId:slowQuote.id});
  assert.equal((await publisher.publishCore(owner,slowRequest.id)).status,'pending');assert.equal(posts,4,'acceptance never duplicates the ongoing provider write');
  release();await publisher.tickPrepublication();assert.equal((await publisher.publishCore(owner,slowRequest.id)).status,'published');assert.equal(posts,4);
 }finally{await publisher?.close();if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
