import test from 'node:test';import assert from 'node:assert/strict';import {signedPacketOutcome} from './wallet-outcome.mjs';
const packet={signature:'fixture',prepared:{observedSlot:50,lastValidBlockHeight:100}};
function setup(){let floor=1,height=101,status=null;const calls=[];return {rpc:{getSignatureStatuses:async()=>{calls.push('status');return {value:[status]};},getBlockHeight:async()=>height,getFirstAvailableBlock:async()=>floor},calls,setFloor:v=>floor=v,setHeight:v=>height=v,setStatus:v=>status=v};}
test('retained finalized expiry is distinguished from recent and pruned uncertainty',async()=>{
 const f=setup();assert.equal((await signedPacketOutcome(f.rpc,packet)).status,'expired');assert.equal(f.calls.filter(x=>x==='status').length,2);
 f.setFloor(51);assert.equal(await signedPacketOutcome(f.rpc,packet),null);
 f.setFloor(1);f.setHeight(100);assert.equal(await signedPacketOutcome(f.rpc,packet),null);
 f.setHeight(101);assert.equal(await signedPacketOutcome(f.rpc,{...packet,prepared:{lastValidBlockHeight:100}}),null);
});
test('retention advancing between observations cannot certify an expiry',async()=>{
 const f=setup();let read=0;f.rpc.getFirstAvailableBlock=async()=>++read===1?1:51;assert.equal(await signedPacketOutcome(f.rpc,packet),null);
});
test('a transaction discovered on the second read returns its chain result',async()=>{
 for(const err of [null,{InstructionError:[0,'Custom']}]){
  const f=setup();let read=0;f.rpc.getSignatureStatuses=async()=>({value:[++read===1?null:{confirmationStatus:'finalized',err}]});
  assert.equal((await signedPacketOutcome(f.rpc,packet)).status,err?'failed':'finalized');
 }
});
test('unavailable history never becomes expired',async()=>{
 const f=setup();f.rpc.getFirstAvailableBlock=async()=>{throw Error('offline');};await assert.rejects(signedPacketOutcome(f.rpc,packet),/offline/);
 f.rpc.getSignatureStatuses=async()=>({});await assert.rejects(signedPacketOutcome(f.rpc,packet),/unavailable/);
});
