import test from 'node:test';import assert from 'node:assert/strict';
import {cidV0,IPFS_CHUNK_BYTES} from './ipfs-cid.mjs';
import {validCid} from './pinata.mjs';
test('CIDv0 of a single-chunk file matches the default ipfs add vectors; larger files are refused',()=>{
 assert.equal(cidV0(Buffer.alloc(0)),'QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH','empty file');
 assert.equal(cidV0(Buffer.from('hello world\n')),'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o');
 assert.equal(cidV0(Buffer.from('hello world')),'Qmf412jQZiuVUtdgnB36FXFX7xg5V6KEbSJ4dpQuhkLyfD');
 const document=Buffer.from(JSON.stringify({name:'Local coin',symbol:'LocalCoin',image:'https://gateway.pinata.cloud/ipfs/Qm'+'a'.repeat(44)}));
 const cid=cidV0(document);assert.ok(validCid(cid));assert.equal(cidV0(Buffer.from(document)),cid,'deterministic');assert.notEqual(cidV0(Buffer.concat([document,Buffer.from(' ')])),cid,'byte-exact');
 assert.equal(cidV0(Buffer.alloc(IPFS_CHUNK_BYTES,7)).length>=45,true,'the largest single chunk still computes');
 assert.throws(()=>cidV0(Buffer.alloc(IPFS_CHUNK_BYTES+1)),/single-chunk/);
 assert.throws(()=>cidV0('text'),/bytes/);
});
