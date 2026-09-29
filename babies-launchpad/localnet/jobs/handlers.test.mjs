// Handler gates against the in-memory v2 chain emulation: complete enumeration and counter reconciliation before
// settlement is reported done, idempotent refunds, unknown transactions stopping the pass, readiness enqueuing the launch,
// the launch handler's gates (enumeration, counters, unknown outcome, read-back), and the fee cycle refusing a campaign
// that is not explicitly enabled.
import test from 'node:test';import assert from 'node:assert/strict';
import {openRegistry} from '../registry/registry.mjs';
import {createJobRunner} from './runner.mjs';
import {settleReceipts,refundReceipts,launchAssertReady,launch,feeCycle} from './handlers.mjs';
import {createChainEmulation,address} from '../protocol-v2/chain-emulation.mjs';
import {accepted} from '../protocol-v2/policy.mjs';
const GENESIS=address(200),PROGRAM=address(201);
const identity={genesisHash:GENESIS,programId:PROGRAM,campaign:address(202)};
test('v3 settlement and refunds wait for chain time despite a fast host clock',async()=>{
 for(const factory of [settleReceipts,refundReceipts]){
  const chain={readCampaign:async()=>({deadline:200n}),chainTime:async()=>100n,listReceipts(){throw Error('Funding still open');}};
  const handler=factory({chain,authoritativeClock:true});
  for(let i=0;i<12;i++)assert.equal((await handler.run({},{campaign:identity,now:()=>900000})).outcome,'yield');
  assert.throws(()=>factory({chain:{},authoritativeClock:true}),/chain clock/);
 }
});
function clock(startSeconds=1790000000){let t=startSeconds*1000;return {now:()=>t,advance(ms){t+=ms;}};}
function world({commitments,soft=100n,hard=1000n,deadlineIn=100}={}){
 const c=clock();const registry=openRegistry({now:c.now});registry.migrate();registry.campaigns.upsert({...identity,mode:'standard',campaignVersion:2,registryStatus:'planned'});
 const terms={soft,hard,deadline:BigInt(Math.floor(c.now()/1000)+deadlineIn),launchDeadline:BigInt(Math.floor(c.now()/1000)+deadlineIn+7200)};
 const chain=createChainEmulation({identity,terms,commitments,now:c.now});
 return {c,registry,chain,terms};
}
const job=(registry,key,cls)=>registry.jobs.get(registry.jobs.enqueue({...identity,operationKey:key,jobClass:cls}).job.jobId);
function batchEmulation(w,{unknownFirst=false}={}){
 const calls=[];w.chain.receiptBatchVersion=3;
 for(const kind of ['settle','refund'])w.chain[kind+'Batch']=async(id,receipts,opts)=>{
  calls.push({kind,size:receipts.length,operationId:opts.operationId});let last;
  for(const r of receipts)last=await w.chain[kind](id,r,opts);
  if(unknownFirst&&calls.length===1)return {...last,status:'unknown'};
  return last;
 };
 return calls;
}
test('v3 batches honor receipt slices and stop on an ambiguous whole batch before reconciling',async()=>{
 const w=world({commitments:Array.from({length:19},()=>({committed:100n}))});w.c.advance(101000);
 const batches=batchEmulation(w,{unknownFirst:true});
 const handlers={settlement:settleReceipts({chain:w.chain,batchSize:8,maxReceipts:10}),refunds:refundReceipts({chain:w.chain,batchSize:8,maxReceipts:10})};
 const runner=createJobRunner({registry:w.registry,handlers,owner:'batches',concurrency:1,now:w.c.now,random:()=>0,backoff:{baseMs:10,maxMs:10,unknownMs:10}});
 w.registry.jobs.enqueue({...identity,operationKey:'settle-receipts',jobClass:'settlement'});
 await runner.tick();let j=job(w.registry,'settle-receipts','settlement');assert.equal(j.result.outcome,'unknown');assert.equal(j.result.reconcile.receipts.length,8);assert.equal(batches.length,1);assert.equal(w.chain.state.settledCount,8n);
 w.c.advance(100);await runner.tick();j=job(w.registry,'settle-receipts','settlement');assert.equal(j.result.outcome,'yield');assert.equal(j.result.checkpoint.processed,10);assert.equal(w.chain.state.settledCount,18n);
 w.c.advance(100);await runner.tick();assert.equal(job(w.registry,'settle-receipts','settlement').state,'done');assert.equal(w.chain.calls.landedSettle,19);
 assert.deepEqual(batches.filter(x=>x.kind==='settle').map(x=>x.size),[8,8,2]);
 assert.ok(batches.every(x=>x.operationId.startsWith(x.kind+'-batch:')));
 w.registry.jobs.enqueue({...identity,operationKey:'refund-receipts',jobClass:'refunds'});
 await runner.tick();assert.equal(job(w.registry,'refund-receipts','refunds').result.outcome,'yield');
 w.c.advance(100);await runner.tick();assert.equal(job(w.registry,'refund-receipts','refunds').state,'done');
 assert.equal(w.chain.state.refunded,[...w.chain.receipts.values()].reduce((sum,r)=>sum+r.refunded,0n));
 w.registry.close();
});
test('batch failures do not skip recipients and unsupported adapters cannot batch',async()=>{
 const w=world({commitments:Array.from({length:9},()=>({committed:100n}))});w.c.advance(101000);
 assert.throws(()=>settleReceipts({chain:w.chain,batchSize:8}),/explicit v3/);assert.throws(()=>refundReceipts({chain:w.chain,batchSize:9}),/size/);
 let sent=0;w.chain.receiptBatchVersion=3;w.chain.settleBatch=async()=>{sent++;return {status:'failed',error:'custom program error: 0x12'};};
 const handler=settleReceipts({chain:w.chain,batchSize:8});
 const result=await handler.run({operationKey:'settle'},{campaign:identity,now:w.c.now,fenced:async(_name,fn)=>fn()});
 assert.equal(result.outcome,'retry');assert.equal(sent,1);assert.equal(w.chain.state.settledCount,0n);
 w.registry.close();
});
test('settle-receipts: retries while funding is open, refuses an incomplete page and a count mismatch, then settles every receipt and reconciles totals',async()=>{
 const w=world({commitments:[{committed:600n},{committed:900n},{committed:1000n}]});
 const handlers={settlement:settleReceipts({chain:w.chain})};
 const runner=createJobRunner({registry:w.registry,handlers,owner:'w',now:w.c.now,random:()=>0,backoff:{baseMs:10,maxMs:10,unknownMs:10}});
 w.registry.jobs.enqueue({...identity,operationKey:'settle-receipts',jobClass:'settlement'});
 await runner.tick();let j=job(w.registry,'settle-receipts','settlement');assert.equal(j.result.category,'funding-open');assert.equal(w.chain.calls.settle,0);
 w.c.advance(101*1000);w.chain.hooks.truncateList=true;await runner.tick();j=job(w.registry,'settle-receipts','settlement');assert.equal(j.result.category,'incomplete-enumeration','a page that ended early is not success');assert.equal(w.chain.calls.settle,0);
 w.chain.hooks.truncateList=false;w.chain.state.receiptCount=4n;w.c.advance(100);await runner.tick();j=job(w.registry,'settle-receipts','settlement');assert.equal(j.result.category,'count-mismatch');assert.equal(w.chain.calls.settle,0);
 w.chain.state.receiptCount=3n;w.c.advance(100);await runner.tick();j=job(w.registry,'settle-receipts','settlement');
 assert.equal(j.state,'done');assert.equal(j.result.settled,3);assert.equal(j.result.receiptCount,3);
 const total=2500n;assert.equal(j.result.settledAccepted,String(accepted(600n,total,1000n)+accepted(900n,total,1000n)+accepted(1000n,total,1000n)));
 assert.equal(w.chain.state.settledCount,3n);
 // a second run is a no-op that still reconciles
 w.registry.jobs.enqueue({...identity,operationKey:'settle-receipts-again',jobClass:'settlement'});await runner.tick();
 const again=job(w.registry,'settle-receipts-again','settlement');assert.equal(again.state,'done');assert.equal(again.result.settled,0);assert.equal(w.chain.calls.landedSettle,3,'no receipt settled twice');
 w.registry.close();
});
test('settle-receipts: an ambiguous send stops the pass with the signature; reconcile confirms it and the pass resumes without a double settle',async()=>{
 const w=world({commitments:[{committed:100n},{committed:100n},{committed:100n}]});w.c.advance(101*1000);
 const handlers={settlement:settleReceipts({chain:w.chain})};
 const runner=createJobRunner({registry:w.registry,handlers,owner:'w',now:w.c.now,random:()=>0,backoff:{baseMs:10,maxMs:10,unknownMs:10}});
 w.chain.hooks.ambiguous.add(address(2));
 w.registry.jobs.enqueue({...identity,operationKey:'settle-receipts',jobClass:'settlement'});
 await runner.tick();let j=job(w.registry,'settle-receipts','settlement');
 assert.equal(j.state,'queued');assert.equal(j.result.outcome,'unknown');assert.equal(j.result.reconcile.receipt,address(2));assert.ok(w.chain.transactions.has(j.result.reconcile.signature));
 assert.equal(w.chain.calls.settle,2,'the pass stopped at the ambiguous receipt');
 w.c.advance(100);await runner.tick();j=job(w.registry,'settle-receipts','settlement');
 assert.equal(j.state,'done');assert.equal(w.chain.calls.landedSettle,3);assert.equal(w.chain.calls.settle,3,'the ambiguous receipt was reconciled, not resent');
 w.registry.close();
});
test('refund-receipts: over-cap excess after settlement, everything on a failed campaign, idempotent on rerun',async()=>{
 const w=world({commitments:[{committed:600n},{committed:900n},{committed:1000n}]});w.c.advance(101*1000);
 const handlers={settlement:settleReceipts({chain:w.chain}),refunds:refundReceipts({chain:w.chain})};
 const runner=createJobRunner({registry:w.registry,handlers,owner:'w',concurrency:1,now:w.c.now,random:()=>0,backoff:{baseMs:10,maxMs:10,unknownMs:10}});
 w.registry.jobs.enqueue({...identity,operationKey:'refund-receipts',jobClass:'refunds'});
 await runner.tick();let j=job(w.registry,'refund-receipts','refunds');assert.equal(j.result.category,'unsettled-receipt','refunds of a funded campaign wait for settlement');
 // refunds outrank settlement inside one campaign, so the retrying refund takes the single slot until its backoff holds it back
 w.registry.jobs.enqueue({...identity,operationKey:'settle-receipts',jobClass:'settlement'});w.c.advance(100);await runner.tick();await runner.tick();w.c.advance(100);await runner.tick();
 assert.equal(job(w.registry,'settle-receipts','settlement').state,'done');
 j=job(w.registry,'refund-receipts','refunds');assert.equal(j.state,'done');assert.equal(j.result.refunded,3);assert.equal(j.result.failedCampaign,false);
 assert.equal(w.chain.state.refunded,2500n-w.chain.state.settledAccepted);
 w.registry.jobs.enqueue({...identity,operationKey:'refund-receipts-2',jobClass:'refunds'});await runner.tick();
 assert.equal(job(w.registry,'refund-receipts-2','refunds').result.refunded,0);assert.equal(w.chain.calls.landedRefund,3);
 // failed campaign: everything back
 const f=world({commitments:[{committed:50n},{committed:20n}],soft:100n});f.c.advance(101*1000);
 const r2=createJobRunner({registry:f.registry,handlers:{refunds:refundReceipts({chain:f.chain})},owner:'w',now:f.c.now,random:()=>0,backoff:{baseMs:10,maxMs:10,unknownMs:10}});
 f.registry.jobs.enqueue({...identity,operationKey:'refund-receipts',jobClass:'refunds'});await r2.tick();
 const fj=job(f.registry,'refund-receipts','refunds');assert.equal(fj.state,'done');assert.equal(fj.result.failedCampaign,true);assert.equal(f.chain.state.refunded,70n);
 w.registry.close();f.registry.close();
});
test('launch-assert-ready: retries while not ready, then reports done and enqueues the launch job; nothing is launched by it',async()=>{
 const w=world({commitments:[{committed:500n}]});
 const runner=createJobRunner({registry:w.registry,handlers:{launch:launchAssertReady({chain:w.chain,notReadyDelayMs:50}),settlement:settleReceipts({chain:w.chain})},owner:'w',concurrency:1,now:w.c.now,random:()=>0,backoff:{baseMs:10,maxMs:10,unknownMs:10}});
 w.registry.jobs.enqueue({...identity,operationKey:'launch-assert-ready',jobClass:'launch'});
 await runner.tick();let j=job(w.registry,'launch-assert-ready','launch');assert.equal(j.result.category,'not-ready');assert.equal(j.notBefore,new Date(w.c.now()+50).toISOString());
 w.c.advance(101*1000);w.registry.jobs.enqueue({...identity,operationKey:'settle-receipts',jobClass:'settlement'});
 await runner.tick();await runner.tick();w.c.advance(51);await runner.tick();
 j=job(w.registry,'launch-assert-ready','launch');assert.equal(j.state,'done');assert.equal(j.result.ready,true);
 const launchJob=job(w.registry,'launch','launch');assert.equal(launchJob.state,'queued');assert.equal(j.result.launchJobId,launchJob.jobId);
 assert.equal(w.chain.calls.launch??0,0,'readiness never launches');assert.equal(w.chain.state.phase,1);
 // a failed campaign is permanent, not a retry
 const f=world({commitments:[{committed:50n}],soft:100n});f.c.advance(101*1000);
 const r2=createJobRunner({registry:f.registry,handlers:{launch:launchAssertReady({chain:f.chain,notReadyDelayMs:50})},owner:'w',now:f.c.now});
 f.registry.jobs.enqueue({...identity,operationKey:'launch-assert-ready',jobClass:'launch'});await r2.tick();
 assert.equal(job(f.registry,'launch-assert-ready','launch').state,'failed');assert.equal(job(f.registry,'launch-assert-ready','launch').result.category,'campaign-failed');
 w.registry.close();f.registry.close();
});
test('launch: refused before readiness, before complete enumeration and matching counters; sends once; an unknown outcome is reconciled, not resent; a live campaign is done at once',async()=>{
 const w=world({commitments:[{committed:600n},{committed:900n}]});
 const handlers={launch:launch({chain:w.chain,notReadyDelayMs:50}),settlement:settleReceipts({chain:w.chain})};
 const runner=createJobRunner({registry:w.registry,handlers,owner:'w',concurrency:1,now:w.c.now,random:()=>0,backoff:{baseMs:10,maxMs:10,unknownMs:10}});
 w.registry.jobs.enqueue({...identity,operationKey:'launch',jobClass:'launch'});
 await runner.tick();let j=job(w.registry,'launch','launch');assert.equal(j.result.category,'not-ready');assert.equal(w.chain.calls.launch??0,0);
 w.c.advance(101*1000);w.registry.jobs.enqueue({...identity,operationKey:'settle-receipts',jobClass:'settlement'});
 await runner.tick();await runner.tick();w.c.advance(51);
 // settled, but the page is short: no launch
 w.chain.hooks.truncateList=true;await runner.tick();j=job(w.registry,'launch','launch');assert.equal(j.result.category,'incomplete-enumeration');assert.equal(w.chain.calls.launch??0,0);
 // settled, counters say ready, but the enumerated accepted sum differs from the counter: no launch
 w.chain.hooks.truncateList=false;w.chain.state.settledAccepted+=1n;w.c.advance(51);await runner.tick();j=job(w.registry,'launch','launch');assert.equal(j.result.category,'reconcile-mismatch');assert.equal(w.chain.calls.launch??0,0);
 w.chain.state.settledAccepted-=1n;
 // ambiguous send: the launch lands, the answer is unknown, reconcile confirms, the rerun sees phase 3 and verifies without a second send
 w.chain.hooks.ambiguousLaunch=true;w.c.advance(51);await runner.tick();j=job(w.registry,'launch','launch');
 assert.equal(j.result.outcome,'unknown');assert.equal(j.result.reconcile.kind,'launch');assert.ok(w.chain.transactions.has(j.result.reconcile.signature));assert.equal(w.chain.calls.launch,1);
 w.c.advance(51);await runner.tick();j=job(w.registry,'launch','launch');
 assert.equal(j.state,'done');assert.equal(j.result.pool,address(240));assert.equal(j.result.verified,true);assert.equal(w.chain.calls.launch,1,'the landed launch was reconciled, never resent');assert.equal(w.chain.calls.landedLaunch,1);
 // a second launch job on a live campaign is done at once and sends nothing
 w.registry.jobs.enqueue({...identity,operationKey:'launch-again',jobClass:'launch'});await runner.tick();
 assert.equal(job(w.registry,'launch-again','launch').state,'done');assert.equal(w.chain.calls.launch,1);
 // a live campaign that does not verify is a permanent failure, not a retry
 w.chain.hooks.failVerify=true;w.registry.jobs.enqueue({...identity,operationKey:'launch-3',jobClass:'launch'});await runner.tick();
 assert.equal(job(w.registry,'launch-3','launch').state,'failed');assert.equal(job(w.registry,'launch-3','launch').result.category,'launch-verify-failed');
 w.registry.close();
});
test('fee-cycle: refused unless the campaign is enabled, refuses another served campaign before any tick, and enqueues the next period',async()=>{
 const w=world({commitments:[]});const ticks=[];
 let served=identity.campaign,resolveServed=async()=>served;
 const make=enabled=>feeCycle({createTick:()=>async()=>{ticks.push(1);return {status:'completed',operation:'collect',signature:null,campaign:served};},servedCampaign:()=>resolveServed(),enabledCampaigns:enabled,intervalMs:60000,now:w.c.now});
 assert.throws(()=>feeCycle({createTick:()=>async()=>({})}),/servedCampaign/,'a fee cycle without the served-campaign check cannot be built');
 const runner=createJobRunner({registry:w.registry,handlers:{fees:make(new Set())},owner:'w',now:w.c.now});
 w.registry.jobs.enqueue({...identity,operationKey:'fee-cycle:1',jobClass:'fees',payload:{legacy:true}});
 await runner.tick();let j=job(w.registry,'fee-cycle:1','fees');assert.equal(j.state,'failed');assert.equal(j.result.category,'not-enabled');assert.equal(ticks.length,0);
 const on=createJobRunner({registry:w.registry,handlers:{fees:make(new Set([identity.campaign]))},owner:'w',now:w.c.now});
 w.registry.jobs.enqueue({...identity,operationKey:'fee-cycle:2',jobClass:'fees',payload:{legacy:true}});await on.tick();
 j=job(w.registry,'fee-cycle:2','fees');assert.equal(j.state,'done');assert.equal(j.result.operation,'collect');
 const period=Math.floor(w.c.now()/60000)+1;const next=job(w.registry,'fee-cycle:'+period,'fees');assert.equal(next.state,'queued');assert.equal(next.notBefore,new Date(period*60000).toISOString());assert.deepEqual(next.payload,{legacy:true});
 served=address(99);w.c.advance(60000);const ticked=ticks.length;await on.tick();
 assert.equal(job(w.registry,'fee-cycle:'+period,'fees').result.category,'campaign-mismatch');assert.equal(job(w.registry,'fee-cycle:'+period,'fees').state,'failed');
 assert.equal(ticks.length,ticked,'the keeper never ticked for a campaign it does not serve');
 // unresolved served campaign: retry, no tick
 served=identity.campaign;resolveServed=async()=>{throw Error('manifest unreadable');};
 w.registry.jobs.enqueue({...identity,operationKey:'fee-cycle:x',jobClass:'fees'});await on.tick();
 const x=job(w.registry,'fee-cycle:x','fees');assert.equal(x.state,'queued');assert.equal(x.result.category,'served-campaign-unresolved');assert.equal(ticks.length,ticked);
 resolveServed=async()=>null;w.c.advance(20000);await on.tick();assert.equal(job(w.registry,'fee-cycle:x','fees').result.category,'served-campaign-unresolved');assert.equal(ticks.length,ticked);
 w.registry.close();
});

test('large receipt sets yield bounded slices without exhausting retries and conserve funds on resume',async()=>{
 const w=world({commitments:Array.from({length:45},()=>({committed:100n})),soft:100n,hard:2000n});w.c.advance(101000);
 const worker=createJobRunner({registry:w.registry,owner:'chunks',concurrency:1,now:w.c.now,maxAttempts:2,handlers:{settlement:settleReceipts({chain:w.chain,maxReceipts:4}),refunds:refundReceipts({chain:w.chain,maxReceipts:4})}});
 for(const [key,cls,counter]of [['settle-receipts','settlement','settle'],['refund-receipts','refunds','refund']]){
  w.registry.jobs.enqueue({...identity,operationKey:key,jobClass:cls});let done=false;
  for(let i=0;i<20;i++){const before=w.chain.calls[counter];await worker.tick();assert.ok(w.chain.calls[counter]-before<=4);const row=job(w.registry,key,cls);if(row.state==='done'){done=true;break;}assert.equal(row.result.outcome,'yield');assert.equal(row.result.attempts,0);assert.ok(row.result.checkpoint.lastReceipt);w.c.advance(2);}
  assert.equal(done,true);
 }
 assert.equal(w.chain.state.refunded,4500n-w.chain.state.settledAccepted);assert.equal(w.chain.calls.landedSettle,45);assert.equal(w.chain.calls.landedRefund,45);w.registry.close();
});
