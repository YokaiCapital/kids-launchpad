import test from 'node:test';
import assert from 'node:assert/strict';
import {createEscrowKeepers} from '../server/escrow-keepers.mjs';
test('missing legacy configuration does not prevent active settlement',async()=>{
 let active=0;const errors=[];const tick=createEscrowKeepers({legacy:async()=>{throw Error('No legacy configuration');},active:async()=>{active++;}},(name,error)=>errors.push([name,error.message]));
 await tick();await tick();assert.equal(active,2);assert.equal(errors.length,2);assert.equal(errors[0][0],'legacy');
});
test('slow legacy keeper cannot block subsequent active ticks or overlap itself',async()=>{
 let finish,legacy=0,active=0;const slow=new Promise(resolve=>{finish=resolve;});const tick=createEscrowKeepers({legacy:async()=>{legacy++;await slow;},active:async()=>{active++;}},()=>{});
 const first=tick();await Promise.resolve();await tick();assert.equal(legacy,1);assert.equal(active,2);finish();await first;
});
