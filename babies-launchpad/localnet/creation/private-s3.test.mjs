import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {createPrivateS3Store} from './private-s3.mjs';
test('private bucket adapter verifies privacy and conditionally stores exact bytes without URLs',async()=>{
 const bytes=await sharp({create:{width:32,height:32,channels:4,background:'#ff55aa'}}).png().toBuffer(),image={bytes,sha256:createHash('sha256').update(bytes).digest('hex'),policyVersion:'raster-v1'};
 const key='creator-artwork/'+'a'.repeat(64)+'.png';let saved,blocked=true,publicPolicy=false,corrupt=false,loss=false;const calls=[];
 const client={async send(command,{abortSignal}){
  assert.ok(abortSignal);const name=command.constructor.name,input=command.input;calls.push({name,input});assert.equal(input.Bucket,'kids-private-test');
  if(name==='GetPublicAccessBlockCommand')return {PublicAccessBlockConfiguration:Object.fromEntries(['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets'].map(k=>[k,blocked]))};
  if(name==='GetBucketPolicyStatusCommand')return {PolicyStatus:{IsPublic:publicPolicy}};
  if(name==='PutObjectCommand'){assert.equal(input.IfNoneMatch,'*');assert.equal(input.ACL,undefined);assert.equal(input.CacheControl,'private, no-store');assert.equal(input.ServerSideEncryption,'AES256');if(saved)throw {name:'PreconditionFailed'};saved=input;if(loss)throw Error('response lost');return {};}
  if(name==='GetObjectCommand'){if(!saved)throw {name:'NoSuchKey'};return {Body:Readable.from([corrupt?Buffer.from('wrong'):saved.Body]),ContentLength:saved.Body.length,ContentType:saved.ContentType,Metadata:saved.Metadata};}
  throw Error('Unexpected operation');
 }};
 const store=createPrivateS3Store({client,bucket:'kids-private-test',region:'eu-west-2'});
 assert.equal(await store.verifyPrivacy(),true);blocked=false;await assert.rejects(store.verifyPrivacy());blocked=true;publicPolicy=true;await assert.rejects(store.verifyPrivacy());publicPolicy=false;
 assert.equal(await store.read(key),null);loss=true;await assert.rejects(store.put(key,image),/unresolved/);loss=false;
 assert.deepEqual(await store.put(key,image),{sha256:image.sha256,byteCount:bytes.length});assert.deepEqual((await store.read(key)).bytes,bytes);
 assert.equal(calls.filter(c=>c.name==='PutObjectCommand').length,2);
 const before=calls.length;await assert.rejects(store.read('../other'));assert.equal(calls.length,before);
 corrupt=true;await assert.rejects(store.read(key));
});
