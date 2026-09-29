import test from 'node:test';import assert from 'node:assert/strict';import {createFeeIndexHandler} from './public-fee-ingest.mjs';
function fixture(){
 const writes=[],calls=[],identity={pool:'pool',market:{verifiedSlot:20},fees:{status:'awaiting-setup',slot:20}};let previous={revision:0,body:null};
 const store={cursor:async()=>previous,commitPage:async input=>{writes.push(input);previous={revision:input.expectedRevision+1,body:input.body};}};
 const rpc={call:async(method,params)=>{calls.push([method,params]);assert.equal(method,'getBlockTime');return 100;}},ctx={campaign:{genesisHash:'ledger'},now:()=>100000,fenced:(_label,fn)=>fn()},job={jobClass:'fee-index',operationKey:'fee-snapshot:0'};
 const handler=createFeeIndexHandler({store,rpc,resolveIdentity:async()=>identity});return {handler,job,ctx,writes,calls,store,rpc};
}
test('current fee snapshots publish without historical RPC, with an atomic successor and replay recovery',async()=>{
 const f=fixture();assert.equal((await f.handler.run(f.job,f.ctx)).outcome,'done');assert.deepEqual(f.calls,[['getBlockTime',[20]]]);
 assert.equal(f.writes[0].fees.chainTime,100);assert.deepEqual(f.writes[0].swaps,[]);assert.equal(f.writes[0].followups[0].jobClass,'fee-index');assert.equal(f.writes[0].followups[0].operationKey,'fee-snapshot:1');
 assert.equal((await f.handler.run(f.job,f.ctx)).replayed,true);assert.equal(f.writes.length,1);assert.equal(f.calls.length,1);
 await assert.rejects(f.handler.run({...f.job,operationKey:'fee-snapshot:2'},f.ctx),/sequence gap/);
});
test('missing block time or a lost lease cannot publish current-looking counters',async()=>{
 const f=fixture();f.rpc.call=async()=>null;await assert.rejects(f.handler.run(f.job,f.ctx),{code:'RPC_UNAVAILABLE'});assert.equal(f.writes.length,0);
 const lost=fixture();lost.ctx.fenced=async()=>{throw Object.assign(Error('lost'),{code:'STALE_LEASE'});};await assert.rejects(lost.handler.run(lost.job,lost.ctx),{code:'STALE_LEASE'});assert.equal(lost.writes.length,0);
});
