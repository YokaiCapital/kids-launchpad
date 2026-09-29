import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createPublicActivityHandlers} from './public-activity-ingest.mjs';import {encodeBase58} from '../../shared/solana.mjs';import {PublicKey} from '@solana/web3.js';
const fixture=n=>JSON.parse(readFileSync(new URL('../test/fixtures/market/activity/'+n+'.json',import.meta.url),'utf8'));
function setup(){
 const identity={...fixture('identity'),distribution:null,distributionProgram:null,mode:'standard',programVersion:3},tx=fixture('commit'),signature=tx.transaction.signatures[0],entries=[{signature,slot:tx.slot,blockTime:tx.blockTime,confirmationStatus:'finalized',err:null}],writes=[],calls=[];let previous={revision:0,body:null};
 const store={cursor:async()=>previous,commit:async input=>{writes.push(input);previous={revision:input.expectedRevision+1,body:input.body};}},rpc={call:async(method,params)=>{calls.push(method);if(method==='getSlot')return tx.slot+1;if(method==='getBlockTime')return tx.blockTime;if(method==='getSignaturesForAddress')return entries;if(method==='getTransaction')return tx;if(method==='getFirstAvailableBlock')return tx.slot-10;throw Error('Unexpected RPC');}},ctx={campaign:{genesisHash:'ledger',programId:identity.launchProgram,campaign:identity.campaign},now:()=>tx.blockTime*1000+1000,fenced:(_label,fn)=>fn()},job={jobClass:'activity-index',operationKey:'activity-live:0'};
 return {identity,tx,entries,writes,calls,store,rpc,ctx,job,handlers:createPublicActivityHandlers({store,rpc,resolveIdentity:async()=>identity}),setPrevious:v=>previous=v};
}
test('recent activity remains visible with explicitly incomplete pruned opening history',async()=>{
 const f=setup();await f.handlers['activity-index'].run(f.job,f.ctx);const w=f.writes[0];assert.equal(w.events[0].kind,'commit');assert.equal(w.body.historyUnavailable,true);assert.equal(w.body.creationVerified,false);assert.deepEqual(w.followups.map(j=>j.jobClass),['activity-index']);assert.equal(w.followups[0].operationKey,'activity-live:1');
 const calls=f.calls.length;assert.equal((await f.handlers['activity-index'].run(f.job,f.ctx)).replayed,true);assert.equal(f.calls.length,calls);
});
test('a full live page schedules bounded archive work separately',async()=>{
 const f=setup(),h=createPublicActivityHandlers({store:f.store,rpc:f.rpc,resolveIdentity:async()=>f.identity,pageLimit:1});await h['activity-index'].run(f.job,f.ctx);assert.deepEqual(f.writes[0].followups.map(j=>j.jobClass),['activity-backfill','activity-index']);assert.equal(f.writes[0].followups[0].operationKey,'activity-backfill:initial');
});
test('unverified transaction identity or expired lease cannot advance activity',async()=>{
 const f=setup();f.entries[0].slot++;await assert.rejects(f.handlers['activity-index'].run(f.job,f.ctx),/identity mismatch/);assert.equal(f.writes.length,0);
 const lost=setup();lost.ctx.fenced=async()=>{throw Object.assign(Error('lost'),{code:'STALE_LEASE'});};await assert.rejects(lost.handlers['activity-index'].run(lost.job,lost.ctx),{code:'STALE_LEASE'});assert.equal(lost.writes.length,0);
});
test('failed calls are indexed as attempts without claiming their planned assets moved',async()=>{
 const f=setup();f.tx.meta.err={InstructionError:[0,'Custom']};f.entries[0].err=f.tx.meta.err;await f.handlers['activity-index'].run(f.job,f.ctx);assert.equal(f.writes[0].events[0].failed,true);assert.deepEqual(f.writes[0].events[0].assets,[]);
});
test('a retention gap cannot turn absent historical transactions into zero activity',async()=>{
 const f=setup();f.setPrevious({revision:1,body:{sequence:'0',providerHead:{slot:f.tx.slot-100,time:f.tx.blockTime}}});await assert.rejects(f.handlers['activity-index'].run({...f.job,operationKey:'activity-live:1'},f.ctx),/outside provider retention/);assert.equal(f.writes.length,0);
});

test('a compact creation (tag 40) indexes once as a campaign creation and replays idempotently; a foreign creation indexes nothing',async()=>{
 const f=setup(),key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
 const creation=(campaign)=>({programId:f.identity.launchProgram,accounts:[key(5),campaign,'11111111111111111111111111111111',key(6)],data:encodeBase58(Uint8Array.of(40)),stackHeight:1});
 f.tx.transaction.message.instructions=[creation(f.identity.campaign)];f.tx.meta.innerInstructions=[];
 await f.handlers['activity-index'].run(f.job,f.ctx);assert.equal(f.writes[0].events.length,1);assert.equal(f.writes[0].events[0].kind,'campaign-init');
 const calls=f.calls.length;assert.equal((await f.handlers['activity-index'].run(f.job,f.ctx)).replayed,true);assert.equal(f.calls.length,calls);
 const g=setup();g.tx.transaction.message.instructions=[creation(key(8))];g.tx.meta.innerInstructions=[];
 await g.handlers['activity-index'].run(g.job,g.ctx);assert.deepEqual(g.writes[0].events,[]);
});
