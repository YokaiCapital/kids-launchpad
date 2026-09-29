import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import {Keypair} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {createVideoService} from './video.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,hash=b=>createHash('sha256').update(b).digest('hex'),address=()=>Keypair.generate().publicKey.toBase58();
test('video replicas enforce ownership, immutable retries, quotas, fenced leases and partial-write recovery',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const owner=address(),config={mode:'localnet-rehearsal',programVersion:3,pilotCreator:owner},limits={ownerAttempts:20,globalAttempts:30,ownerBytes:2_000_000_000,globalBytes:3_000_000_000,ownerActive:1,globalActive:2};
  const bytes=Buffer.alloc(32);bytes.write('ftyp',4);const png=await sharp({create:{width:640,height:360,channels:4,background:'#ff55aa'}}).png().toBuffer();
  const result={bytes,sha256:hash(bytes),contentType:'video/mp4',width:1280,height:720,durationMs:500,sanitized:true,policyVersion:'video-h264-v1',poster:{bytes:png,sha256:hash(png),width:640,height:360,contentType:'image/png'}};
  const objects=new Map();let calls=0,decode=0,loss=false;
  const storage={storageId:'a'.repeat(64),verifyPrivacy:async()=>true,read:async key=>objects.get(key)??null,put:async(key,value)=>{calls++;if(objects.has(key))assert.equal(objects.get(key).sha256,value.sha256);else objects.set(key,value);if(loss&&key.endsWith('.png'))throw Error('response lost');return {sha256:value.sha256,byteCount:value.bytes.length};}};
  const sanitize=async()=>{decode++;return result;},open=extra=>createVideoService({registry,config,storage,sanitize,limits,...extra}),upload=requestId=>({requestId,bytes,contentType:'video/mp4'});
  const all=await Promise.all(Array.from({length:10},()=>open().upload(owner,upload('one')))),asset=all.find(x=>x.status==='ready');assert.ok(asset);assert.equal(new Set(all.map(x=>x.assetId)).size,1);assert.equal(calls,2);assert.equal(decode,1);
  assert.equal((await open().upload(owner,upload('one'))).assetId,asset.assetId);assert.equal(decode,1);assert.doesNotMatch(JSON.stringify(asset),/creator-video|object_key|source_hash/);
  assert.equal((await open().loadOwnedVideo({owner,assetId:asset.assetId})).poster.sha256,hash(png));await assert.rejects(open().loadOwnedVideo({owner:address(),assetId:asset.assetId}));
  await assert.rejects(open().upload(address(),upload('other')));await assert.rejects(open().upload(owner,{...upload('one'),contentType:'video/webm'}));
  loss=true;await assert.rejects(open().upload(owner,upload('lost')),{code:'MEDIA_PENDING'});loss=false;const stored=objects.size;assert.equal((await open().upload(owner,upload('lost'))).status,'ready');assert.equal(objects.size,stored);
  let enter,release;const entered=new Promise(r=>enter=r),held=new Promise(r=>release=r);const blocked=open({sanitize:async()=>{enter();await held;return result;}}).upload(owner,upload('held'));await entered;
  await assert.rejects(open().upload(owner,upload('busy')),{code:'MEDIA_BUSY'});assert.equal((await open({limits:{...limits,ownerActive:2,globalActive:3}}).upload(owner,upload('policy'))).status,'ready','new quotas replace the stored caps');await assert.rejects(open({storage:{...storage,storageId:'b'.repeat(64)}}).upload(owner,upload('policy-storage')),{code:'MEDIA_POLICY_CONFLICT'});
  await registry.query("UPDATE creation_videos SET lease_until=0 WHERE request_key='held'");const replacement=await open().upload(owner,upload('held'));release();assert.equal((await blocked).assetId,replacement.assetId);
  await registry.query("UPDATE creation_video_usage SET attempts=? WHERE scope='global'",[limits.globalAttempts]);const prior=(await registry.query('SELECT * FROM creation_video_usage ORDER BY scope')).rows;await assert.rejects(open().upload(owner,upload('quota')),{code:'MEDIA_QUOTA'});assert.deepEqual((await registry.query('SELECT * FROM creation_video_usage ORDER BY scope')).rows,prior);
  await assert.rejects(open({storage:{...storage,verifyPrivacy:async()=>false}}).loadOwnedVideo({owner,assetId:asset.assetId}));
  await assert.rejects(open({storage:{...storage,read:async()=>null}}).loadOwnedVideo({owner,assetId:asset.assetId}));
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
