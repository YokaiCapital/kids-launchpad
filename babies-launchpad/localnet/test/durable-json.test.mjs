import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDurableJsonWriter,writeDurableJson} from '../../shared/durable-json.mjs';
function fixture(t){const dir=fs.mkdtempSync(join(tmpdir(),'kids-durable-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,path:join(dir,'journal.json')};}
test('journal syncs file before atomic replacement and directory before returning',t=>{
 const {path}=fixture(t),events=[];
 const writer=createDurableJsonWriter({...fs,fsyncSync(fd){events.push(fs.fstatSync(fd).isDirectory()?'directory-sync':'file-sync');return fs.fsyncSync(fd);},renameSync(a,b){events.push('rename');return fs.renameSync(a,b);}});
 writer(path,{signed:'bytes'});assert.deepEqual(events,['file-sync','rename','directory-sync']);assert.deepEqual(JSON.parse(fs.readFileSync(path)),{signed:'bytes'});assert.equal(fs.statSync(path).mode&0o777,0o600);
});
test('write, file-sync and rename failures preserve the prior journal without abandoned temp files',t=>{
 const {path,dir}=fixture(t);writeDurableJson(path,{old:true});
 for(const method of ['writeFileSync','fsyncSync','renameSync']){
  const writer=createDurableJsonWriter({...fs,[method](){throw Object.assign(Error('disk failed'),{code:'EIO'});}});
  assert.throws(()=>writer(path,{new:true}),/disk failed/);assert.deepEqual(JSON.parse(fs.readFileSync(path)),{old:true});assert.deepEqual(fs.readdirSync(dir),['journal.json']);
 }
});
test('directory sync failure is reported even after rename; a successful retry restores durable acknowledgement',t=>{
 const {path}=fixture(t);writeDurableJson(path,{old:true});
 const writer=createDurableJsonWriter({...fs,fsyncSync(fd){if(fs.fstatSync(fd).isDirectory())throw Error('directory sync failed');return fs.fsyncSync(fd);}});
 assert.throws(()=>writer(path,{signed:'exact bytes'}),/directory sync failed/);
 assert.deepEqual(JSON.parse(fs.readFileSync(path)),{signed:'exact bytes'});
 assert.doesNotThrow(()=>writeDurableJson(path,{signed:'exact bytes'}));
});
test('serialization failure leaves existing journal untouched',t=>{
 const {path,dir}=fixture(t);writeDurableJson(path,{old:true});const bad={};bad.self=bad;
 assert.throws(()=>writeDurableJson(path,bad));assert.deepEqual(JSON.parse(fs.readFileSync(path)),{old:true});assert.deepEqual(fs.readdirSync(dir),['journal.json']);
});
