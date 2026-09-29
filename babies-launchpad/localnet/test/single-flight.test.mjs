import test from 'node:test';
import assert from 'node:assert/strict';
import {singleFlight} from '../../shared/single-flight.mjs';
test('100 simultaneous reads share one upstream request, expiry refreshes once',async()=>{
 let calls=0,time=0;const read=singleFlight(async()=>{calls++;await new Promise(r=>setTimeout(r,10));return {calls};},{ttlMs:20,now:()=>time});
 const values=await Promise.all(Array.from({length:100},()=>read()));assert.equal(calls,1);assert.ok(values.every(v=>v.calls===1));await read();assert.equal(calls,1);time=21;await Promise.all(Array.from({length:100},()=>read()));assert.equal(calls,2);
});
test('failed refresh does not serve expired data or cache failures',async()=>{
 let time=0,fail=false,calls=0;const read=singleFlight(async()=>{calls++;if(fail)throw Error('RPC unavailable');return calls;},{ttlMs:20,now:()=>time});
 assert.equal(await read(),1);time=21;fail=true;await assert.rejects(read(),/RPC unavailable/);await assert.rejects(read(),/RPC unavailable/);assert.equal(calls,3);fail=false;assert.equal(await read(),4);
});
