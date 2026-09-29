import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {createPublicMarketHandlers,hasPoolInitialization} from './public-ingest.mjs';
import {encodeBase58} from '../../shared/solana.mjs';
import {CPMM_PROGRAM} from './decode.mjs';
const fixture=name=>JSON.parse(readFileSync(new URL('../test/fixtures/market/'+name+'.json',import.meta.url),'utf8'));
function setup(){
 const identity=fixture('pool'),tx=fixture('swap-direct-buy'),signature=tx.transaction.signatures[0];
 const entries=[{signature,slot:tx.slot,blockTime:tx.blockTime,confirmationStatus:'finalized',err:null}];
 const commits=[],calls=[];let body=null,missing=false;
 const store={cursor:async()=>({revision:0,body}),commitPage:async input=>{commits.push(input);body=input.body;return {inserted:input.swaps.length};}};
 const rpc={async call(method,params){calls.push([method,params]);if(method==='getSlot')return tx.slot+1;if(method==='getBlockTime')return tx.blockTime;if(method==='getSignaturesForAddress')return entries;if(method==='getTransaction')return missing?null:tx;throw Error('unexpected RPC');}};
 const handlers=createPublicMarketHandlers({store,rpc,resolveIdentity:async()=>identity,pageLimit:1});
 const job={jobId:'job',operationKey:'market-live:0',jobClass:'market-index',fencingToken:1};
 const ctx={campaign:{genesisHash:'ledger',programId:'program',campaign:'campaign'},now:()=>tx.blockTime*1000+1000,fenced:(_label,fn)=>fn()};
 return {identity,tx,signature,entries,commits,calls,rpc,handlers,job,ctx,setBody:b=>body=b,setMissing:b=>missing=b};
}
test('live poll atomically publishes a bounded page with separate history and next live jobs',async()=>{
 const f=setup(),r=await f.handlers['market-index'].run(f.job,f.ctx);assert.equal(r.outcome,'done');
 const page=f.commits[0];assert.equal(page.swaps.length,1);assert.equal(page.body.head,f.signature);
 assert.deepEqual(page.followups.map(j=>j.jobClass),['market-backfill','market-index']);assert.equal(page.followups[0].payload.before,f.signature);
 assert.equal(f.calls.find(c=>c[0]==='getSignaturesForAddress')[1][1].commitment,'finalized');
 assert.equal(f.calls.find(c=>c[0]==='getSignaturesForAddress')[1][1].minContextSlot,f.tx.slot+1);
 assert.deepEqual(page.body.providerHead,{slot:f.tx.slot+1,time:f.tx.blockTime});
 const before=f.calls.length;assert.equal((await f.handlers['market-index'].run(f.job,f.ctx)).replayed,true);assert.equal(f.calls.length,before);
});
test('unresolved transaction never commits a watermark or success',async()=>{
 const f=setup();f.setMissing(true);await assert.rejects(f.handlers['market-index'].run(f.job,f.ctx),/unavailable/);assert.equal(f.commits.length,0);
});
test('non-finalized or wrong transaction identity never enters finalized candles',async()=>{
 const f=setup();f.entries[0].confirmationStatus='confirmed';await assert.rejects(f.handlers['market-index'].run(f.job,f.ctx),/Malformed/);
 f.entries[0].confirmationStatus='finalized';f.tx.slot++;await assert.rejects(f.handlers['market-index'].run(f.job,f.ctx),/identity mismatch/);assert.equal(f.commits.length,0);
});
test('live poll creates a gap job when the previous watermark is beyond the page budget',async()=>{
 const f=setup(),old='2'.repeat(64);f.setBody({head:old,sequence:'0'});f.job.operationKey='market-live:1';
 await f.handlers['market-index'].run(f.job,f.ctx);assert.equal(f.calls.find(c=>c[0]==='getSignaturesForAddress')[1][1].until,old);assert.equal(f.commits[0].followups[0].payload.until,old);
});
test('backfill does one page and yields, without fetching the live head',async()=>{
 const f=setup();f.job.operationKey='market-backfill:initial';f.job.jobClass='market-backfill';f.job.payload={before:'2'.repeat(64),until:null};
 const r=await f.handlers['market-backfill'].run(f.job,f.ctx);assert.equal(r.outcome,'yield');assert.equal(f.commits[0].body.before,f.signature);assert.deepEqual(f.commits[0].followups,[]);
});
test('an old live job cannot overwrite a newer checkpoint',async()=>{
 const f=setup();f.setBody({sequence:'4',head:'2'.repeat(64)});assert.equal((await f.handlers['market-index'].run(f.job,f.ctx)).replayed,true);assert.equal(f.calls.length,0);
});
test('lease loss stops a page before the next RPC and publishes nothing',async()=>{
 const f=setup();let reads=0;
 f.ctx.fenced=(label,fn)=>{if(label==='market-read'&&++reads>1)throw Object.assign(Error('Lease lost'),{code:'STALE_LEASE'});return fn();};
 await assert.rejects(f.handlers['market-index'].run(f.job,f.ctx),{code:'STALE_LEASE'});
 assert.deepEqual(f.calls.map(c=>c[0]),['getSlot']);assert.equal(f.commits.length,0);
});
test('idle pools check chain progress without manufacturing transactions',async()=>{
 const f=setup();f.entries.length=0;
 await f.handlers['market-index'].run(f.job,f.ctx);
 assert.equal(f.commits[0].body.head,null);assert.equal(f.commits[0].body.providerHead.slot,f.tx.slot+1);
 assert.deepEqual(f.commits[0].swaps,[]);assert.equal(f.calls.some(c=>c[0]==='getTransaction'),false);
});
test('stale, future, missing and regressed provider heads cannot refresh the watermark',async()=>{
 for(const scenario of ['stale','future','missing','regressed','invalid-slot']){
  const f=setup(),call=f.rpc.call;
  if(scenario==='regressed')f.setBody({providerHead:{slot:f.tx.slot+2}});
  f.rpc.call=async(method,params)=>{
   if(method==='getSlot'&&scenario==='invalid-slot')return '123';
   if(method==='getBlockTime')return scenario==='stale'?f.tx.blockTime-121:scenario==='future'?f.tx.blockTime+32:scenario==='missing'?null:f.tx.blockTime;
   return call(method,params);
  };
  await assert.rejects(f.handlers['market-index'].run(f.job,f.ctx),/provider head/);
  assert.equal(f.commits.length,0,scenario);assert.equal(f.calls.some(c=>c[0]==='getSignaturesForAddress'),false,scenario);
 }
});

test('empty pruned history cannot be called a quiet pool or complete its initial backfill',async()=>{
 const f=setup();f.identity.market={launchTime:f.tx.blockTime-100};f.entries.length=0;
 await assert.rejects(f.handlers['market-index'].run(f.job,f.ctx),{code:'RPC_UNAVAILABLE'});assert.equal(f.commits.length,0);
 f.job.operationKey='market-backfill:initial';f.job.jobClass='market-backfill';f.job.payload={before:'2'.repeat(64),until:null};
 await assert.rejects(f.handlers['market-backfill'].run(f.job,f.ctx),{code:'RPC_UNAVAILABLE'});assert.equal(f.commits.length,0);
 f.setBody({before:'2'.repeat(64),until:null,openingVerified:true});
 assert.equal((await f.handlers['market-backfill'].run(f.job,f.ctx)).outcome,'done');
});
test('only successful exact pool initialization verifies its history boundary',()=>{
 const f=setup(),p=f.identity,data=new Uint8Array(32);data.set([175,175,109,31,13,152,155,237]);
 const accounts=Array(12).fill('x');for(const [i,k]of [[2,'authority'],[3,'pool'],[4,'mint0'],[5,'mint1'],[10,'vault0'],[11,'vault1']])accounts[i]=p[k];
 const ix={programId:CPMM_PROGRAM,accounts,data:encodeBase58(data)},tx={transaction:{message:{instructions:[ix]}},meta:{err:null}};
 assert.equal(hasPoolInitialization(tx,p),true);assert.equal(hasPoolInitialization({...tx,meta:{err:'failed'}},p),false);
 for(const i of [2,3,4,5,10,11]){const bad={...ix,accounts:[...accounts]};bad.accounts[i]='wrong';assert.equal(hasPoolInitialization({transaction:{message:{instructions:[bad]}},meta:{err:null}},p),false);}
 assert.equal(hasPoolInitialization({transaction:{message:{instructions:[]}},meta:{err:null,innerInstructions:[{index:0,instructions:[ix]}]}},p),true);
});
test('incremental recovery cannot declare missing retained slots to be quiet',async()=>{
 const f=setup();f.identity.market={launchTime:f.tx.blockTime-100};f.setBody({sequence:'0',head:'2'.repeat(64),providerHead:{slot:f.tx.slot-1},openingVerified:true});f.job.operationKey='market-live:1';
 const call=f.rpc.call;let floor=f.tx.slot;
 f.rpc.call=(method,params)=>method==='getFirstAvailableBlock'?floor:call(method,params);
 await assert.rejects(f.handlers['market-index'].run(f.job,f.ctx),/retention/);assert.equal(f.commits.length,0);
 floor=f.tx.slot-2;await f.handlers['market-index'].run(f.job,f.ctx);assert.equal(f.commits[0].followups[0].payload.boundarySlot,f.tx.slot-1);
});

test('continuous quiet observations survive pruning of the old transaction cursor',async()=>{
 const f=setup();f.identity.market={launchTime:f.tx.blockTime-100};
 f.setBody({sequence:'0',head:'2'.repeat(64),slot:f.tx.slot-100,providerHead:{slot:f.tx.slot-1},openingVerified:true});f.job.operationKey='market-live:1';
 const call=f.rpc.call;f.rpc.call=(method,params)=>method==='getFirstAvailableBlock'?f.tx.slot-10:call(method,params);
 await f.handlers['market-index'].run(f.job,f.ctx);
 assert.equal(f.calls.find(c=>c[0]==='getSignaturesForAddress')[1][1].until,undefined);
 const gap=f.commits[0].followups[0];assert.match(gap.operationKey,/market-backfill:[a-f0-9]{32}$/);assert.equal(gap.payload.until,null);assert.equal(gap.payload.boundarySlot,f.tx.slot-1);
 assert.equal(f.commits[0].body.openingVerified,true);
});
test('incremental backfill without a retained signature stops at its verified slot boundary',async()=>{
 const f=setup();f.identity.market={launchTime:f.tx.blockTime-100};
 f.job={...f.job,operationKey:'market-backfill:'+'a'.repeat(32),jobClass:'market-backfill',payload:{before:'2'.repeat(64),until:null,boundarySlot:f.tx.slot}};
 const call=f.rpc.call;f.rpc.call=(method,params)=>method==='getFirstAvailableBlock'?f.tx.slot-10:call(method,params);
 const r=await f.handlers['market-backfill'].run(f.job,f.ctx);assert.equal(r.outcome,'done');assert.equal(f.commits[0].body.complete,true);
});
test('continuous quiet observation with no new transactions preserves opening proof',async()=>{
 const f=setup();f.identity.market={launchTime:f.tx.blockTime-100};f.entries.length=0;
 f.setBody({sequence:'0',head:'2'.repeat(64),slot:f.tx.slot-100,providerHead:{slot:f.tx.slot-1},openingVerified:true});f.job.operationKey='market-live:1';
 const call=f.rpc.call;f.rpc.call=(method,params)=>method==='getFirstAvailableBlock'?f.tx.slot-10:call(method,params);
 await f.handlers['market-index'].run(f.job,f.ctx);assert.equal(f.commits[0].body.openingVerified,true);assert.deepEqual(f.commits[0].swaps,[]);assert.equal(f.commits[0].followups.length,1);
});
