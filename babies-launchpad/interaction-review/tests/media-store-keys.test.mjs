import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes} from 'node:crypto';
import {createFileObjectStore} from '../server/media-store.mjs';
test('media store accepts exactly the object keys the artwork and video services produce, and keeps shapes apart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-media-keys-'));
 try{
  const store=createFileObjectStore({dir}),hex='a'.repeat(64),bytes=randomBytes(32);
  for(const k of ['creator-artwork/'+hex+'.png','creator-video/'+hex+'.mp4','creator-video/'+hex+'.png']){await store.put(k,{bytes,contentType:'x'});assert.deepEqual(Buffer.from((await store.read(k)).bytes),bytes,k);}
  await store.put('creator-artwork:'+hex+'.png',{bytes:randomBytes(8),contentType:'x'});
  assert.equal((await store.read('creator-artwork/'+hex+'.png')).bytes.length,32,'the slash key and the colon key are different objects');
  assert.equal(readdirSync(dir).length,4);
  for(const bad of ['creator-artwork/../x.png','creator-artwork/'+hex+'.exe','other/'+hex+'.png','creator-artwork/'+'A'.repeat(64)+'.png','creator-video/'+hex+'.webm','/'+hex+'.png'])await assert.rejects(store.put(bad,{bytes}),/Invalid media object key/,bad);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
