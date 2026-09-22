import test from 'node:test';
import assert from 'node:assert/strict';
import {createActiveLifecycleKeeper} from '../active-keeper.mjs';
const base=()=>({configured:true,network:'localnet',scope:'active-localnet',version:3,genesisHash:'genesis',programId:'program',escrowAddress:'campaign',mint:'mint',phase:'awaiting-launch',chainTimeUnix:11,deadlineUnix:10,launchDeadlineUnix:20,softCapLamports:'100',totalLamports:'761',settledAcceptedLamports:'500',receiptCount:'3',settledReceiptCount:'3'});
function fixture(initial=base(),after=initial){const calls=[];let reads=0;const tick=createActiveLifecycleKeeper({read:async()=>{calls.push('read');return reads++?after:initial;},settle:async()=>calls.push('settle'),launch:async()=>calls.push('launch')});return {tick,calls};}
test('unconfigured and open campaigns perform no financial operations',async()=>{
 for(const state of [{configured:false},{...base(),phase:'open',chainTimeUnix:9}]){const f=fixture(state);await f.tick();assert.deepEqual(f.calls,['read']);}
});
test('closed eligible campaign settles, rereads and launches once per tick',async()=>{const f=fixture();assert.deepEqual(await f.tick(),{status:'launch-completed'});assert.deepEqual(f.calls,['read','settle','read','launch']);});
test('failed, below-soft, expired and partially settled campaigns never launch',async()=>{
 for(const [change,status] of [[{phase:'failed'},'refunding'],[{totalLamports:'99',settledAcceptedLamports:'99'},'below-soft-cap'],[{chainTimeUnix:20},'refunding'],[{settledReceiptCount:'2'},'awaiting-settlement'],[{settledAcceptedLamports:'99'},'awaiting-settlement'],[{receiptCount:'0',settledReceiptCount:'0',settledAcceptedLamports:'0'},'awaiting-settlement']]){
  const f=fixture({...base(),...change});assert.equal((await f.tick()).status,status);assert.deepEqual(f.calls,['read','settle','read']);
 }
});
test('launched campaigns can finish refunds but are never launched again',async()=>{const f=fixture({...base(),phase:'launched'});assert.equal((await f.tick()).status,'launched');assert.deepEqual(f.calls,['read','settle','read']);});
test('fresh settlement read prevents launch after window closes or another operator launches',async()=>{
 for(const after of [{...base(),chainTimeUnix:20,phase:'failed'},{...base(),phase:'launched'}]){const f=fixture(base(),after);await f.tick();assert.ok(!f.calls.includes('launch'));}
});
test('explicit localnet identity and consistent clocks are required before settlement',async()=>{
 for(const change of [{network:'mainnet-beta'},{scope:'rehearsal'},{version:1},{genesisHash:''},{phase:'unknown'},{chainTimeUnix:NaN},{chainTimeUnix:9},{launchDeadlineUnix:10}]){
  const f=fixture({...base(),...change});await assert.rejects(f.tick());assert.deepEqual(f.calls,['read']);
 }
});
test('campaign identity changes during settlement fail closed',async()=>{
 for(const key of ['genesisHash','programId','escrowAddress','mint']){const f=fixture(base(),{...base(),[key]:'changed'});await assert.rejects(f.tick(),/identity changed/);assert.ok(!f.calls.includes('launch'));}
});
test('invalid accounting cannot authorize launch',async()=>{
 for(const change of [{softCapLamports:'0'},{totalLamports:'-1'},{settledReceiptCount:'4'},{settledAcceptedLamports:'999'}]){const f=fixture({...base(),...change});await assert.rejects(f.tick());assert.ok(!f.calls.includes('launch'));}
});
test('concurrent ticks do not overlap, and failures release the lease for retry',async()=>{
 let unblock;const wait=new Promise(resolve=>{unblock=resolve;}),calls=[];let fail=true;
 const tick=createActiveLifecycleKeeper({read:async()=>base(),settle:async()=>{calls.push('settle');await wait;if(fail)throw Error('RPC unavailable');},launch:async()=>calls.push('launch')});
 const first=tick();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(await tick(),{status:'busy'});unblock();await assert.rejects(first,/RPC unavailable/);assert.deepEqual(calls,['settle']);fail=false;await tick();assert.deepEqual(calls,['settle','settle','launch']);
});
test('settlement or state-read failures never fall through to launch',async()=>{
 let launched=0;const tick=createActiveLifecycleKeeper({read:async()=>{throw Error('offline');},settle:async()=>{},launch:async()=>{launched++;}});await assert.rejects(tick(),/offline/);assert.equal(launched,0);
});
