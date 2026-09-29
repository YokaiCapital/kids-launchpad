import {publishCreatorProfile,createCreatorProfileReader} from './creator-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {Keypair} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {createCreationStore} from './store.mjs';
import {createMetadataPublisher} from './publication.mjs';
import {contentHash} from './pinata.mjs';
import {PINATA_GATEWAY} from '../token-metadata.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,address=()=>Keypair.generate().publicKey.toBase58();
test('shared creator publication owns artwork, charges once and recovers provider ambiguity', {skip:!url},async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const owner=address(),config={mode:'localnet-rehearsal',programVersion:3,pilotCreator:owner,genesisHash:address(),programId:address()},bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
  let owned={owner,assetId:'owned-pfp',sanitized:true,sha256:contentHash(bytes),bytes,contentType:'image/png'},posts=[],unknown=false,badReceipt=false;
  const bannerBytes=Buffer.from([...bytes,4]),bannerAsset={...owned,assetId:'owned-banner',kind:'banner',bytes:bannerBytes,sha256:contentHash(bannerBytes)};
  const videoBytes=Buffer.alloc(32);videoBytes.write('ftyp',4);const videoAsset={owner,assetId:'owned-video',sanitized:true,policyVersion:'video-h264-v1',bytes:videoBytes,sha256:contentHash(videoBytes),contentType:'video/mp4',width:1280,height:720,durationMs:500,poster:{bytes:bannerBytes,sha256:contentHash(bannerBytes),contentType:'image/png'}};
  const pins=new Map(),imageCid='Qm'+'a'.repeat(44),documentCid='Qm'+'b'.repeat(44);
  const receipt=input=>({cid:input.stage==='image'?imageCid:documentCid,uri:PINATA_GATEWAY+(input.stage==='image'?imageCid:documentCid),inputHash:input.inputHash});
  const provider={publish:async input=>{posts.push(input);const value=receipt(input);pins.set(input.operationId,value);if(unknown)throw Error('lost provider response');return badReceipt?{...value,inputHash:'0'.repeat(64)}:value;},recover:async input=>pins.get(input.operationId)??null};
  const limits={ownerPins:40,globalPins:50,ownerBytes:100000,globalBytes:200000};
  const open=extra=>createMetadataPublisher({registry,config,provider,limits,loadOwnedImage:async({assetId})=>assetId==='owned-banner'?bannerAsset:owned,loadOwnedVideo:async()=>videoAsset,...extra});
  async function accepted(draftId,consent=true,withBanner=false,withVideo=false){
   const draft={...(withVideo?{video:{assetId:videoAsset.assetId,sha256:videoAsset.sha256,posterHash:videoAsset.poster.sha256},videoCaption:'An approved video'}:{}),...(withBanner?{banner:{assetId:bannerAsset.assetId,sha256:bannerAsset.sha256},xUrl:'https://x.com/localcoin',websiteUrl:'https://example.com/'}:{}),name:'Local coin',symbol:'LocalCoin',description:'Creator-approved text.',pfp:{assetId:owned.assetId,sha256:owned.sha256}};
   await registry.drafts.save({creator:owner,id:draftId,revision:0,body:draft});const store=createCreationStore(registry);
   const q=await store.issue({owner,draftId,revision:1,draftHash:canonicalHash(draft),descriptorHash:canonicalHash({draftId}),requestKey:draftId,body:{genesisHash:config.genesisHash,programId:config.programId,terms:{mode:'standard'},fundingEnabled:false,publicationConsent:consent}});
   return store.accept({owner,quoteId:q.id});
  }
  await t.test('concurrent replicas publish each stage once; restart retains the exact document',async()=>{
   const r=await accepted('parallel');await Promise.all(Array.from({length:10},()=>open().publish(owner,r.id)));
   const result=await open().publish(owner,r.id);assert.equal(result.status,'published');assert.equal(result.document.image,PINATA_GATEWAY+imageCid);assert.equal(result.metadata.uri,PINATA_GATEWAY+documentCid);assert.equal(posts.length,2);
   const usage=(await registry.query("SELECT * FROM creation_publication_usage WHERE scope='global'")).rows[0];assert.equal(Number(usage.pins),2);
   const serialized=JSON.stringify((await registry.query('SELECT * FROM creation_publications')).rows);assert.ok(!serialized.includes(bytes.toString('base64')),'no image blobs in registry');
  });
  await t.test('banner is separately published and approved profile survives registration/restart without private fields',async()=>{
   const r=await accepted('profile',true,true),before=posts.length,result=await open().publish(owner,r.id);assert.equal(result.status,'published');assert.ok(result.bannerUri);assert.equal(posts.length,before+3);assert.equal(result.document.banner,undefined,'immutable token document format is preserved');
   const id={genesisHash:config.genesisHash,programId:config.programId,campaign:address()},intent={mint:{...id,creator:owner,requestId:r.id,metadata:result.metadata}};
   await registry.campaigns.upsert({...id,creator:owner,mode:'standard',campaignVersion:3,registryStatus:'planned'});
   await publishCreatorProfile({registry,id,intent,signature:'2'.repeat(88)});await publishCreatorProfile({registry,id,intent,signature:'2'.repeat(88)});
   const profile=await createCreatorProfileReader(registry).read(id);assert.equal(profile.media.pfp,result.imageUri);assert.equal(profile.media.banner,result.bannerUri);assert.equal(profile.links.x,'https://x.com/localcoin');assert.equal(profile.description,'Creator-approved text.');assert.doesNotMatch(JSON.stringify(profile),/assetId|sha256|requestId|descriptor|object_key|signed|private/);
   assert.equal(Number((await registry.query('SELECT COUNT(*) AS n FROM campaign_profiles')).rows[0].n),1);
   await registry.query("UPDATE campaign_profiles SET moderation_state='blocked' WHERE campaign=?",[id.campaign]);assert.equal(await createCreatorProfileReader(registry).read(id),null);await publishCreatorProfile({registry,id,intent,signature:'2'.repeat(88)});assert.equal(await createCreatorProfileReader(registry).read(id),null,'retry cannot undo moderation');
   await assert.rejects(publishCreatorProfile({registry,id,intent:{mint:{...intent.mint,metadata:{...result.metadata,documentHash:'0'.repeat(64)}}},signature:'2'.repeat(88)}),{code:'PROFILE_PUBLICATION_CONFLICT'});
  });
  await t.test('video and poster publish separately, recover ambiguity and require owned sanitized media',async()=>{
   const r=await accepted('video',true,true,true),first=posts.length;
   const pending=open({provider:{...provider,publish:async input=>{const receipt=await provider.publish(input);if(input.stage==='video')throw Error('lost response');return receipt;}}});
   assert.equal((await pending.publish(owner,r.id)).stage,'video');const before=posts.length;
   const result=await open().publish(owner,r.id);assert.equal(result.status,'published');assert.ok(result.videoUri);assert.ok(result.posterUri);assert.equal(posts.length,before,'poster already published alongside the video');assert.equal(posts.length,first+5);assert.equal(result.document.animation_url,undefined);
   const id={genesisHash:config.genesisHash,programId:config.programId,campaign:address()},intent={mint:{...id,creator:owner,requestId:r.id,metadata:result.metadata}};await registry.campaigns.upsert({...id,creator:owner,mode:'standard',campaignVersion:3,registryStatus:'planned'});await publishCreatorProfile({registry,id,intent,signature:'2'.repeat(88)});
   const profile=await createCreatorProfileReader(registry).read(id);assert.equal(profile.media.video,result.videoUri);assert.equal(profile.media.poster,result.posterUri);assert.equal(profile.media.videoCaption,'An approved video');
   for(const patch of [{owner:address()},{sanitized:false},{durationMs:NaN},{sha256:'0'.repeat(64)},{poster:{...videoAsset.poster,sha256:'0'.repeat(64)}}])await assert.rejects(open({loadOwnedVideo:async()=>({...videoAsset,...patch})}).publish(owner,r.id));
  });
  await t.test('banner publication starts while the token image is still pending',{timeout:3000},async()=>{
   const r=await accepted('parallel-media',true,true);let release;
   const bannerStarted=new Promise(resolve=>{release=resolve;});
   const parallel=open({provider:{...provider,publish:async input=>{
    if(input.stage==='image')await bannerStarted;
    if(input.stage==='banner')release();
    return provider.publish(input);
   }}});
   assert.equal((await parallel.publish(owner,r.id)).status,'published');
  });
  await t.test('core creation never waits for or reads optional media; the approved profile can be completed later',async()=>{
   const r=await accepted('core-only',true,true,true),before=posts.length;
   const core=await open({loadOwnedImage:async({assetId})=>{assert.equal(assetId,owned.assetId);return owned;},loadOwnedVideo:async()=>{throw Error('Optional video must not block creation');}}).publishCore(owner,r.id);
   assert.equal(core.status,'published');assert.equal(posts.length,before+2);
   const id={genesisHash:config.genesisHash,programId:config.programId,campaign:address()},intent={mint:{...id,creator:owner,requestId:r.id,metadata:core.metadata}};
   await registry.campaigns.upsert({...id,creator:owner,mode:'standard',campaignVersion:3,registryStatus:'planned'});
   await publishCreatorProfile({registry,id,intent,signature:'2'.repeat(88),allowPendingMedia:true});
   let profile=await createCreatorProfileReader(registry).read(id);assert.equal(profile.media.pfp,core.imageUri);assert.equal(profile.media.banner,null);assert.equal(profile.media.video,null);
   await open().publish(owner,r.id);await publishCreatorProfile({registry,id,intent,signature:'2'.repeat(88)});
   profile=await createCreatorProfileReader(registry).read(id);assert.ok(profile.media.banner);assert.ok(profile.media.video);
  });
  await t.test('publication memory admission bounds concurrent source reads and releases after errors',async()=>{
   const r=await accepted('bounded-memory'),other=await accepted('other-memory');let entered,release,reads=0;const enteredPromise=new Promise(r=>entered=r),held=new Promise(r=>release=r);
   const bounded=open({maxActive:1,loadOwnedImage:async()=>{reads++;entered();await held;throw Error('unavailable');}});
   const pending=assert.rejects(bounded.publish(owner,r.id));await enteredPromise;const duplicate=assert.rejects(bounded.publish(owner,r.id));await assert.rejects(bounded.publish(address(),r.id));assert.equal((await bounded.publish(owner,other.id)).reason,'publication-busy');assert.equal(reads,1);release();await Promise.all([pending,duplicate]);await assert.rejects(bounded.publish(owner,r.id));assert.equal(reads,2);
  });
  await t.test('provider accepted but response was lost: recover without another pin or charge',async()=>{
   const r=await accepted('unknown');unknown=true;const first=await open().publish(owner,r.id);assert.equal(first.status,'pending');assert.equal(first.stage,'image');
   const before=posts.length;unknown=false;const recovered=await open().publish(owner,r.id);assert.equal(recovered.status,'published');assert.equal(posts.length,before+1,'only the previously unattempted JSON is uploaded');
  });
  await t.test('an absent recovery record never permits another uncertain POST',async()=>{
   const r=await accepted('not-visible');unknown=true;await open().publish(owner,r.id);unknown=false;pins.clear();const before=posts.length;
   for(let i=0;i<3;i++)assert.equal((await open().publish(owner,r.id)).status,'pending');assert.equal(posts.length,before);
  });
  await t.test('foreign owner, changed content, unsanitized source and missing publication consent are refused',async()=>{
   const r=await accepted('invalid'),noConsent=await accepted('private',false),before=posts.length,original=owned;
   await assert.rejects(open().publish(address(),r.id));await assert.rejects(open().publish(owner,noConsent.id));
   for(const patch of [{owner:address()},{assetId:'foreign'},{sanitized:false},{bytes:Buffer.from('different')},{contentType:'image/svg+xml'}]){owned={...original,...patch};await assert.rejects(open().publish(owner,r.id));}owned=original;assert.equal(posts.length,before);
  });
  await t.test('quota exhaustion rolls back both counters and never calls provider; a deploy with higher quotas lifts it',async()=>{
   const r=await accepted('quota'),before=posts.length;
   const old=(await registry.query("SELECT pins FROM creation_publication_usage WHERE scope='global'")).rows[0].pins;
   await registry.query("UPDATE creation_publication_usage SET pins=? WHERE scope='global'",[limits.globalPins]);
   const counters=(await registry.query('SELECT * FROM creation_publication_usage ORDER BY scope')).rows;
   await assert.rejects(open().publish(owner,r.id),{code:'PUBLICATION_QUOTA'});
   assert.deepEqual((await registry.query('SELECT * FROM creation_publication_usage ORDER BY scope')).rows,counters);assert.equal(posts.length,before);
   // A deploy with higher quotas replaces the stored caps (logged once) and the same publication then goes through.
   const updated=[];assert.equal((await open({limits:{...limits,globalPins:limits.globalPins+1000},log:e=>updated.push(e)}).publish(owner,r.id)).status,'published');assert.equal(updated[0]?.event,'publication-quotas-updated');
   await registry.query("UPDATE creation_publication_usage SET pins=? WHERE scope='global'",[old]);
  });
  await t.test('mismatching provider receipt cannot become immutable mint metadata',async()=>{
   const r=await accepted('wrong-receipt');badReceipt=true;await assert.rejects(open().publish(owner,r.id),{code:'PUBLICATION_CONFLICT'});badReceipt=false;
   assert.equal((await registry.query('SELECT state FROM creation_publications WHERE request_id=?',[r.id])).rows[0].state,'publishing');
  });
  assert.throws(()=>open({config:{...config,mode:'mainnet'}}));assert.throws(()=>open({limits:null}));
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
