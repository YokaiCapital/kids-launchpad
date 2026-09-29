import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import {Keypair} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {createArtworkService} from './artwork.mjs';
import {createImageSanitizer} from './image-sanitizer.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,address=()=>Keypair.generate().publicKey.toBase58();
test('private artwork uses shared admission, owner binding, immutable retries and storage recovery',{skip:!url},async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:10,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const owner=address(),config={mode:'localnet-rehearsal',programVersion:3,pilotCreator:owner},limits={ownerAttempts:30,globalAttempts:40,ownerBytes:100000000,globalBytes:200000000,ownerActive:1,globalActive:2};
  const bytes=await sharp({create:{width:64,height:64,channels:4,background:'#ff55aa'}}).withMetadata().png().toBuffer(),objects=new Map();let calls=0,loss=false,decode=0;
  const actual=createImageSanitizer(),storage={storageId:'a'.repeat(64),verifyPrivacy:async()=>true,read:async key=>objects.get(key)??null,put:async(key,image)=>{calls++;if(objects.has(key))assert.equal(objects.get(key).sha256,image.sha256);else objects.set(key,image);if(loss)throw Error('store response lost');return {sha256:image.sha256,byteCount:image.bytes.length};}};
  const sanitize=async input=>{decode++;return actual(input);},open=extra=>createArtworkService({registry,config,limits,storage,sanitize,...extra}),upload=requestId=>({requestId,bytes,contentType:'image/png',kind:'pfp'});
  let asset;
  await t.test('parallel replicas share one job and return only owned descriptors',async()=>{
   const all=await Promise.all(Array.from({length:10},()=>open().upload(owner,upload('one'))));asset=all.find(x=>x.status==='ready');assert.ok(asset);assert.equal(new Set(all.map(x=>x.assetId)).size,1);assert.equal(calls,1);assert.equal(decode,1);
   assert.deepEqual(await open().upload(owner,upload('one')),asset);assert.equal(decode,1);
   assert.ok(!JSON.stringify(asset).includes('creator-artwork/'));assert.equal(asset.url,undefined);
   const loaded=await open().loadOwnedImage({owner,assetId:asset.assetId});assert.equal(loaded.sanitized,true);assert.equal(loaded.sha256,asset.sha256);assert.equal((await sharp(loaded.bytes).metadata()).exif,undefined);
   await assert.rejects(open().loadOwnedImage({owner:address(),assetId:asset.assetId}));await assert.rejects(open().upload(address(),upload('foreign')));
   await assert.rejects(open().upload(owner,{...upload('one'),kind:'banner'}),{code:'MEDIA_CONFLICT'});
   const raw=JSON.stringify((await registry.query('SELECT * FROM creation_artwork')).rows);assert.ok(!raw.includes(bytes.toString('base64')));
  });
  await t.test('lost object-write response is recoverable using same immutable object and charged attempts',async()=>{
   loss=true;await assert.rejects(open().upload(owner,upload('lost')),{code:'MEDIA_PENDING'});loss=false;
   const before=objects.size;const recovered=await open().upload(owner,upload('lost'));assert.equal(recovered.status,'ready');assert.equal(objects.size,before);
   const row=(await registry.query('SELECT attempts FROM creation_artwork WHERE asset_id=?',[recovered.assetId])).rows[0];assert.equal(row.attempts,2);
  });
  await t.test('global concurrency and policy are enforced across processes; stale lease cannot finish',async()=>{
   let enter,release;const entered=new Promise(r=>enter=r),held=new Promise(r=>release=r);
   const blocked=open({sanitize:async input=>{enter();await held;return actual(input);}}).upload(owner,upload('blocked'));await entered;
   await assert.rejects(open().upload(owner,upload('other')),{code:'MEDIA_BUSY'});
   // A deploy with new quotas replaces the stored caps (logged once); a different storage identity still conflicts.
   const updated=[];assert.equal((await open({limits:{...limits,ownerActive:2,globalActive:3},log:e=>updated.push(e)}).upload(owner,upload('policy'))).status,'ready');assert.equal(updated[0]?.event,'artwork-policy-caps-updated');
   await assert.rejects(open({storage:{...storage,storageId:'b'.repeat(64)}}).upload(owner,upload('policy-storage')),{code:'MEDIA_POLICY_CONFLICT'});
   await registry.query("UPDATE creation_artwork SET lease_until=0 WHERE request_key='blocked'");
   const replacement=await open().upload(owner,upload('blocked'));assert.equal(replacement.status,'ready');release();assert.equal((await blocked).status,'ready');
   assert.equal((await registry.query("SELECT attempts FROM creation_artwork WHERE request_key='blocked'")).rows[0].attempts,2);
  });
  await t.test('quota rollback, bounded retries, privacy and read integrity fail closed',async()=>{
   await registry.query("UPDATE creation_artwork_usage SET attempts=? WHERE scope='global'",[limits.globalAttempts]);const prior=(await registry.query('SELECT * FROM creation_artwork_usage ORDER BY scope')).rows;
   await assert.rejects(open().upload(owner,upload('quota')),{code:'MEDIA_QUOTA'});assert.deepEqual((await registry.query('SELECT * FROM creation_artwork_usage ORDER BY scope')).rows,prior);
   await registry.query("UPDATE creation_artwork_usage SET attempts=1 WHERE scope='global'");
   const fail=open({sanitize:async()=>{throw Error('decoder private detail');}});
   for(let i=0;i<3;i++)await assert.rejects(fail.upload(owner,upload('bad')),{code:'MEDIA_PENDING'});
   assert.equal((await fail.upload(owner,upload('bad'))).status,'failed');
   await assert.rejects(open({storage:{...storage,verifyPrivacy:async()=>false}}).upload(owner,upload('public')));
   await assert.rejects(open({storage:{...storage,read:async()=>null}}).loadOwnedImage({owner,assetId:asset.assetId}));
  });
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
