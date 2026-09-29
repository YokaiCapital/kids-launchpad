import test from 'node:test';import assert from 'node:assert/strict';import {runRehearsalBatch} from './rehearsal-work.mjs';
test('rehearsal failure drains in-flight financial work before rejecting and starts no successors',async()=>{
 let finish,settled=false;const started=[],gate=new Promise(r=>{finish=r;});
 const result=runRehearsalBatch([0,1,2,3],2,async i=>{started.push(i);if(i===0)throw Error('fixture interruption');await gate;settled=true;});const rejection=assert.rejects(result,/fixture interruption/);
 await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.deepEqual(started,[0,1]);finish();await rejection;assert.equal(settled,true);assert.deepEqual(started,[0,1]);
});
test('rehearsal batches retain input order and bound concurrency',async()=>{let active=0,peak=0;const result=await runRehearsalBatch([1,2,3,4],2,async x=>{peak=Math.max(peak,++active);await new Promise(r=>setImmediate(r));active--;return x*2;});assert.deepEqual(result,[2,4,6,8]);assert.equal(peak,2);await assert.rejects(runRehearsalBatch([],9,async()=>{}));});
