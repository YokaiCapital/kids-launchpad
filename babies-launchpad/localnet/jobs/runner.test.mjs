// Job runner gates: fair pick across campaigns and classes, bounded backoff with jitter, fencing (a stale runner can
// neither write nor publish), explicit outcomes, unknown-then-reconcile before any retry, deadlines, bounded concurrency.
import test from 'node:test';import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {openRegistry} from '../registry/registry.mjs';
import {createJobRunner,pickFair,backoffMs,classifyError,JOB_CLASSES,OUTCOMES} from './runner.mjs';
const addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const GENESIS=addr(1),PROGRAM=addr(2);
const id=n=>({genesisHash:GENESIS,programId:PROGRAM,campaign:addr(n)});
function clock(start=1790000000000){let t=start;return {now:()=>t,advance(ms){t+=ms;}};}
function setup(){const c=clock();const r=openRegistry({now:c.now});r.migrate();for(const n of [10,11,12])r.campaigns.upsert({...id(n),mode:'standard',campaignVersion:2,registryStatus:'planned'});return {c,r};}
test('pickFair rotates campaigns and orders classes within a campaign; fees never run before a refund of the same campaign',()=>{
 const {c,r}=setup();
 for(let i=0;i<50;i++)r.jobs.enqueue({...id(10),operationKey:'settle:'+i,jobClass:'settlement'});
 r.jobs.enqueue({...id(10),operationKey:'fee-cycle:1',jobClass:'fees'});c.advance(1000);
 r.jobs.enqueue({...id(11),operationKey:'refund',jobClass:'refunds'});c.advance(1000);
 r.jobs.enqueue({...id(12),operationKey:'fee-cycle:1',jobClass:'fees'});
 const due=r.jobs.due({limit:1000});assert.equal(due.length,53);
 const first=pickFair(due,{});assert.equal(first.campaign,addr(10));assert.equal(first.jobClass,'settlement','oldest settlement before the fee job of the same campaign');
 const second=pickFair(due,{lastCampaign:GENESIS+':'+PROGRAM+':'+addr(10)});assert.equal(second.campaign,addr(11),'the next campaign gets the next slot even though campaign 10 has 50 jobs waiting');
 const third=pickFair(due,{lastCampaign:GENESIS+':'+PROGRAM+':'+addr(11)});assert.equal(third.campaign,addr(12));
 const wrap=pickFair(due,{lastCampaign:GENESIS+':'+PROGRAM+':'+addr(12)});assert.equal(wrap.campaign,addr(10),'round-robin wraps');
 assert.equal(pickFair([],{}),null);
 // within one campaign: launch < refunds < settlement < fees, whatever the enqueue order
 r.jobs.enqueue({...id(10),operationKey:'launch-assert-ready',jobClass:'launch'});
 assert.equal(pickFair(r.jobs.due({limit:1000}).filter(j=>j.campaign===addr(10)),{}).jobClass,'launch');
 assert.equal(JOB_CLASSES.launch<JOB_CLASSES.refunds&&JOB_CLASSES.refunds<JOB_CLASSES.settlement&&JOB_CLASSES.settlement<JOB_CLASSES.fees,true);
 r.close();
});
test('backoff grows exponentially, is capped, and jitters between half and the full delay',()=>{
 assert.equal(backoffMs(1,{baseMs:1000,maxMs:60000,random:()=>0}),500);assert.equal(backoffMs(1,{baseMs:1000,maxMs:60000,random:()=>0.999}),999);
 assert.equal(backoffMs(4,{baseMs:1000,maxMs:60000,random:()=>0}),4000);assert.equal(backoffMs(20,{baseMs:1000,maxMs:60000,random:()=>0}),30000,'capped at maxMs');
 for(let i=0;i<50;i++){const v=backoffMs(3,{baseMs:1000,maxMs:60000});assert.ok(v>=2000&&v<4000,'jitter in range: '+v);}
});
test('explicit RPC unavailability retries even when its diagnostic does not say unavailable',()=>{
 assert.deepEqual(classifyError(Object.assign(Error('Finalized provider head regressed'),{code:'RPC_UNAVAILABLE'})),{category:'upstream',transient:true});
});
test('verified funding shortfall waits without exhausting retries and resumes the same job after funding',async()=>{
 const {c,r}=setup();let funded=false,calls=0;
 const job=r.jobs.enqueue({...id(10),operationKey:'distribution:0',jobClass:'distribution'}).job;
 const runner=createJobRunner({registry:r,owner:'funding-wait',now:c.now,maxAttempts:2,handlers:{distribution:{async run(){calls++;if(!funded)throw Object.assign(Error('Signer refused with private diagnostics'),{code:'OPERATING_FUNDING_WAIT'});return {outcome:'done'};}}}});
 for(let i=0;i<12;i++){await runner.tick();const state=r.jobs.get(job.jobId);assert.equal(state.state,'queued');assert.equal(state.result.attempts,0);assert.equal(state.result.category,'awaiting-operating-funding');assert.ok(!JSON.stringify(state.result).includes('private'));c.advance(30001);}
 funded=true;await runner.tick();assert.equal(r.jobs.get(job.jobId).state,'done');assert.equal(calls,13);runner.stop();await runner.drain();r.close();
});

test('a signer that serves no current grant pauses the job without spending retries; other refusals stay terminal',async()=>{
 const {c,r}=setup();let granted=false,calls=0;
 const job=r.jobs.enqueue({...id(10),operationKey:'fee-harvest:0',jobClass:'fees'}).job;
 const runner=createJobRunner({registry:r,owner:'grant-wait',now:c.now,maxAttempts:2,handlers:{fees:{async run(){calls++;if(!granted)throw Error('Signer refused the request (403): capability expired [private detail]');return {outcome:'done'};}}}});
 try{
  for(let i=0;i<5;i++){await runner.tick();const s=r.jobs.get(job.jobId);assert.equal(s.state,'queued');assert.equal(s.result.category,'capability-paused');assert.equal(s.result.attempts,0);assert.ok(!JSON.stringify(s.result).includes('private'));c.advance(60001);}
  granted=true;await runner.tick();assert.equal(r.jobs.get(job.jobId).state,'done');assert.equal(calls,6);
  const other=r.jobs.enqueue({...id(11),operationKey:'fee-harvest:1',jobClass:'fees'}).job;
  const terminal=createJobRunner({registry:r,owner:'grant-wait-2',now:c.now,maxAttempts:2,handlers:{fees:{async run(){throw Error('Signer refused the request (403): tag 25 outside capability');}}}});
  try{await terminal.tick();const s=r.jobs.get(other.jobId);assert.equal(s.state,'failed');assert.equal(s.result.category,'auth');}finally{terminal.stop();await terminal.drain();}
  assert.deepEqual(classifyError(Error('campaign not served by any capability')),{category:'capability-paused',transient:false,paused:true});
  assert.deepEqual(classifyError(Error('capability revoked')),{category:'capability-paused',transient:false,paused:true});
 }finally{runner.stop();await runner.drain();r.close();}
});

test('hourly signer spend waits retain their bounded cause without leaking refusal details',async()=>{
 const {c,r}=setup();let available=false;
 const job=r.jobs.enqueue({...id(10),operationKey:'settlement:budget',jobClass:'settlement'}).job;
 const runner=createJobRunner({registry:r,owner:'spend-wait',now:c.now,maxAttempts:2,handlers:{settlement:{async run(){if(!available)throw Object.assign(Error('private upstream detail'),{code:'CAPACITY_WAIT',capacityKind:'hourly-spend',retryAfterMs:300000});return {outcome:'done'};}}}});
 try{for(let i=0;i<3;i++){await runner.tick();const s=r.jobs.get(job.jobId);assert.equal(s.state,'queued');assert.equal(s.result.capacityKind,'hourly-spend');assert.equal(s.result.attempts,0);assert.ok(!JSON.stringify(s.result).includes('private'));c.advance(300001);}available=true;await runner.tick();assert.equal(r.jobs.get(job.jobId).state,'done');}
 finally{runner.stop();await runner.drain();r.close();}
});
test('errors are classified: transient network, timeout, 429 and 5xx retry; auth, invalid and stale leases do not',()=>{
 for(const [e,cat,transient] of [[Object.assign(Error('fetch failed'),{code:'ECONNRESET'}),'network',true],[Error('request timed out'),'timeout',true],[Error('HTTP 429 rate limited'),'rate-limited',true],[Error('502 upstream'),'upstream',true],[Error('Signer refused the request (403)'),'auth',false],[Object.assign(Error('Signer refused the request (409): signer refused to persist the signature (signature-mismatch)'),{code:'SIGNER_PERSISTENCE_REFUSED',status:409}),'signer-refused',false],[Error('Signer refused the request (503): signature persistence unresolved; retry the same operation'),'timeout',true],[Error('failed to simulate transaction: Minimum context slot has not been reached'),'upstream',true],[Object.assign(Error('lagging provider'),{code:-32016}),'upstream',true],[Error('Invalid receipt'),'invalid',false],[Object.assign(Error('x'),{code:'STALE_LEASE'}),'stale-lease',false],[Error('something odd'),'unknown',false]]){
  const c=classifyError(e);assert.equal(c.category,cat,e.message);assert.equal(c.transient,transient,e.message);
 }
});
test('done, retry with backoff, failed-permanent and thrown errors publish the right state with the current token',async()=>{
 const {c,r}=setup();const logs=[];
 const seen=[];
 const handlers={settlement:{async run(job,ctx){seen.push(job.operationKey);assert.equal(ctx.token,job.fencingToken);return job.payload.what;}}};
 r.jobs.enqueue({...id(10),operationKey:'a',jobClass:'settlement',payload:{what:{outcome:'done',settled:3}}});
 r.jobs.enqueue({...id(10),operationKey:'b',jobClass:'settlement',payload:{what:{outcome:'retry',category:'network',reason:'rpc down'}}});
 r.jobs.enqueue({...id(10),operationKey:'c',jobClass:'settlement',payload:{what:{outcome:'failed-permanent',category:'invalid',reason:'bad'}}});
 r.jobs.enqueue({...id(10),operationKey:'d',jobClass:'settlement',payload:{what:{nope:true}}});
 const runner=createJobRunner({registry:r,handlers,owner:'w1',concurrency:4,now:c.now,random:()=>0,log:l=>logs.push(l),backoff:{baseMs:2000,maxMs:60000,unknownMs:1000}});
 assert.equal((await runner.tick()).leased,4);
 const by=k=>r.jobs.get(r.jobs.enqueue({...id(10),operationKey:k,jobClass:'settlement'}).job.jobId);
 assert.equal(by('a').state,'done');assert.deepEqual(by('a').result,{outcome:'done',attempts:1,settled:3});
 const b=by('b');assert.equal(b.state,'queued');assert.equal(b.result.outcome,'retry');assert.equal(b.result.attempts,1);assert.equal(b.notBefore,new Date(c.now()+1000).toISOString(),'base 2000 ms, attempt 1, jitter 0 = 1000 ms');
 assert.equal(by('c').state,'failed');assert.equal(by('c').result.category,'invalid');
 assert.equal(by('d').state,'failed');assert.equal(by('d').result.category,'bad-outcome');
 assert.equal((await runner.tick()).leased,0,'b is not due before its backoff');
 c.advance(1001);assert.equal((await runner.tick()).leased,1);assert.equal(by('b').result.attempts,2);
 assert.ok(logs.some(l=>l.event==='job-retry'&&l.delayMs===1000));
 r.close();
});
test('a transient throw retries and a permanent throw fails; retries are exhausted into failed-permanent with the last category kept',async()=>{
 const {c,r}=setup();let calls=0;
 const handlers={settlement:{async run(){calls++;throw Object.assign(Error('fetch failed'),{code:'ECONNREFUSED'});}},refunds:{async run(){throw Error('Invalid receipt');}}};
 r.jobs.enqueue({...id(10),operationKey:'s',jobClass:'settlement'});r.jobs.enqueue({...id(10),operationKey:'r',jobClass:'refunds'});
 const runner=createJobRunner({registry:r,handlers,owner:'w1',concurrency:2,now:c.now,random:()=>0,maxAttempts:3,backoff:{baseMs:10,maxMs:20,unknownMs:10}});
 await runner.tick();
 const s=()=>r.jobs.get(r.jobs.enqueue({...id(10),operationKey:'s',jobClass:'settlement'}).job.jobId),rf=()=>r.jobs.get(r.jobs.enqueue({...id(10),operationKey:'r',jobClass:'refunds'}).job.jobId);
 assert.equal(rf().state,'failed');assert.equal(rf().result.category,'invalid');
 assert.equal(s().state,'queued');assert.equal(s().result.category,'network');
 c.advance(100);await runner.tick();c.advance(100);await runner.tick();
 assert.equal(calls,3);assert.equal(s().state,'failed');assert.equal(s().result.category,'retries-exhausted');assert.equal(s().result.lastCategory,'network');assert.equal(s().result.attempts,3);
 r.close();
});
test('fencing: a runner whose lease expired cannot perform a side effect nor publish; the new holder finishes the job',async()=>{
 const {c,r}=setup();const effects=[];let release,started;const entered=new Promise(r=>{started=r;});
 const gate=new Promise(res=>release=res);
 const handlers={settlement:{async run(job,ctx){started();await gate;await ctx.fenced('write',async()=>{effects.push(ctx.owner);});return {outcome:'done',by:ctx.owner};}}};
 r.jobs.enqueue({...id(10),operationKey:'settle',jobClass:'settlement'});
 const logs=[];
 const old=createJobRunner({registry:r,handlers,owner:'old',concurrency:1,leaseTtlMs:5000,renewEveryMs:1000000,now:c.now,log:l=>logs.push(l)});
 const oldTick=old.tick();await entered;
 // the lease expires while the old runner is stuck; a new runner takes over with a higher fencing token
 c.advance(6000);
 const fresh=createJobRunner({registry:r,handlers:{settlement:{async run(job,ctx){await ctx.fenced('write',async()=>{effects.push(ctx.owner);});return {outcome:'done',by:ctx.owner};}}},owner:'new',concurrency:1,leaseTtlMs:5000,now:c.now});
 await fresh.tick();
 release();await oldTick;
 const job=r.jobs.get(r.jobs.enqueue({...id(10),operationKey:'settle',jobClass:'settlement'}).job.jobId);
 assert.deepEqual(effects,['new'],'the stale runner performed no side effect');
 assert.equal(job.state,'done');assert.equal(job.result.by,'new');assert.equal(job.fencingToken,2);
 assert.ok(logs.some(l=>l.event==='job-stale-runner'),'the stale runner reported itself');
 r.close();
});
test('unknown outcome: the job comes back, reconcile runs before run, an unresolved signature keeps waiting, a handler without reconcile fails closed',async()=>{
 const {c,r}=setup();const trace=[];let status='unresolved';
 const handlers={settlement:{async reconcile(job){trace.push('reconcile:'+job.result.reconcile.signature);return {status};},async run(job,ctx){trace.push('run:'+(ctx.reconciled?ctx.reconciled.status:'fresh'));if(!ctx.reconciled)return {outcome:'unknown',reconcile:{kind:'settle',receipt:'R1',signature:'5'.repeat(64)}};return {outcome:'done'};}},
  refunds:{async run(){return {outcome:'unknown',reconcile:{signature:'6'.repeat(64)}};}}};
 r.jobs.enqueue({...id(10),operationKey:'settle',jobClass:'settlement'});r.jobs.enqueue({...id(11),operationKey:'refund',jobClass:'refunds'});
 const runner=createJobRunner({registry:r,handlers,owner:'w',concurrency:2,now:c.now,maxAttempts:2,backoff:{baseMs:10,maxMs:1000,unknownMs:100}});
 await runner.tick();
 const settle=()=>r.jobs.get(r.jobs.enqueue({...id(10),operationKey:'settle',jobClass:'settlement'}).job.jobId),refund=()=>r.jobs.get(r.jobs.enqueue({...id(11),operationKey:'refund',jobClass:'refunds'}).job.jobId);
 assert.equal(settle().state,'queued');assert.equal(settle().result.outcome,'unknown');assert.equal(settle().result.reconcile.signature,'5'.repeat(64));
 c.advance(101);await runner.tick();assert.deepEqual(trace,['run:fresh','reconcile:'+'5'.repeat(64)]);
 assert.equal(settle().state,'queued');assert.equal(settle().result.outcome,'unknown','unresolved stays unknown');assert.equal(settle().result.attempts,2);
 c.advance(201);await runner.tick();assert.equal(settle().state,'queued','an unknown is never exhausted into a failure by the attempt cap');assert.equal(settle().result.attempts,3);
 status='confirmed';c.advance(301);await runner.tick();
 assert.equal(settle().state,'done');assert.equal(trace.at(-1),'run:confirmed');
 assert.equal(refund().state,'failed');assert.equal(refund().result.category,'reconcile-not-supported');assert.equal(refund().result.reconcile.signature,'6'.repeat(64),'the signature is kept in the record');
 r.close();
});
test('a job past its deadline fails with category deadline and keeps its earlier result; concurrency is bounded per tick',async()=>{
 const {c,r}=setup();
 r.jobs.enqueue({...id(10),operationKey:'late',jobClass:'settlement',deadlineAt:new Date(c.now()+1000).toISOString()});
 for(let i=0;i<5;i++)r.jobs.enqueue({...id(11),operationKey:'j'+i,jobClass:'settlement'});
 let running=0,peak=0;
 const handlers={settlement:{async run(job){running++;peak=Math.max(peak,running);await new Promise(res=>setTimeout(res,5));running--;return job.operationKey==='late'?{outcome:'retry',category:'network',reason:'x'}:{outcome:'done'};}}};
 const runner=createJobRunner({registry:r,handlers,owner:'w',concurrency:2,now:c.now,random:()=>0,backoff:{baseMs:10,maxMs:10,unknownMs:10}});
 assert.equal((await runner.tick()).leased,2);assert.ok(peak<=2);
 c.advance(2000);
 for(let i=0;i<4;i++)await runner.tick();
 const late=r.jobs.get(r.jobs.enqueue({...id(10),operationKey:'late',jobClass:'settlement'}).job.jobId);
 assert.equal(late.state,'failed');assert.equal(late.result.category,'deadline');assert.equal(late.result.previous.outcome,'retry');
 assert.equal(r.jobs.listForCampaign({...id(11)}).filter(j=>j.state==='done').length,5);
 assert.deepEqual(OUTCOMES,['done','retry','failed-permanent','unknown','yield']);
 r.close();
});

test('an unknown transaction is reconciled beyond deadline and survives RPC errors without a replacement',async()=>{
 const {c,r}=setup();let calls=0,checks=0;
 const q=r.jobs.enqueue({...id(10),operationKey:'send',jobClass:'launch',deadlineAt:new Date(c.now()+1000).toISOString()});
 const handlers={launch:{async run(){calls++;return calls===1?{outcome:'unknown',reconcile:{signature:'5'.repeat(64)}}:{outcome:'done'};},async reconcile(){checks++;if(checks===1)throw Error('network unavailable');return {status:checks===2?'unresolved':'confirmed'};}}};
 const worker=createJobRunner({registry:r,handlers,owner:'recover',now:c.now,backoff:{baseMs:1,maxMs:10,unknownMs:1}});
 await worker.tick();c.advance(2000);await worker.tick();assert.equal(r.jobs.get(q.job.jobId).result.outcome,'unknown');assert.equal(calls,1);
 c.advance(2000);await worker.tick();assert.equal(calls,1);assert.equal(r.jobs.get(q.job.jobId).state,'queued');
 c.advance(2000);await worker.tick();assert.equal(r.jobs.get(q.job.jobId).state,'done');assert.equal(checks,3);assert.equal(calls,2);r.close();
});
test('an expired lease cannot be revived or publish even before a replacement worker appears',()=>{
 const {c,r}=setup();r.jobs.enqueue({...id(10),operationKey:'expired',jobClass:'launch'});const j=r.jobs.lease({owner:'old',ttlMs:1000});c.advance(1001);
 assert.equal(r.jobs.renew({jobId:j.jobId,token:j.fencingToken,owner:'old'}),false);
 for(const method of ['complete','fail','requeue'])assert.throws(()=>r.jobs[method]({jobId:j.jobId,token:j.fencingToken}),{code:'STALE_LEASE'});
 r.close();
});


test('shutdown returns an in-flight lease without running it or losing reconciliation',async()=>{
 const {c,r}=setup();let release,entered;const ready=new Promise(resolve=>{entered=resolve;});
 const barrier=new Promise(resolve=>{release=resolve;});
 const job=r.jobs.enqueue({...id(10),operationKey:'settle-stop',jobClass:'settlement'}).job;
 const first=r.jobs.leaseById({jobId:job.jobId,token:job.fencingToken,owner:'prior',ttlMs:30000});
 const previous={outcome:'unknown',attempts:2,reconcile:{signature:'preserve-me'}};
 r.jobs.requeue({jobId:job.jobId,token:first.fencingToken,result:previous});
 const registry={...r,driver:'postgres',jobs:{...r.jobs,async leaseNext({owner,ttlMs}){
  const pending=r.jobs.get(job.jobId);
  const leased=r.jobs.leaseById({jobId:pending.jobId,token:pending.fencingToken,owner,ttlMs});
  entered();await barrier;return leased;
 }}};
 let calls=0;
 const runner=createJobRunner({registry,lane:'lifecycle',owner:'stopping',now:c.now,handlers:{settlement:{async run(){calls++;return {outcome:'done'};}}}});
 const ticking=runner.tick();await ready;runner.stop();const draining=runner.drain();release();
 await Promise.all([ticking,draining]);
 assert.equal(calls,0);assert.equal(runner.active(),0);
 const after=r.jobs.get(job.jobId);assert.equal(after.state,'queued');assert.deepEqual(after.result,previous);
 r.close();
});

test('SDK-wrapped local capacity waits yield without exhausting financial retries',async()=>{
 const {c,r}=setup();let available=false;const job=r.jobs.enqueue({...id(10),operationKey:'wrapped-admission',jobClass:'settlement'}).job;
 const runner=createJobRunner({registry:r,owner:'wrapped-admission',now:c.now,maxAttempts:2,handlers:{settlement:{async run(){if(!available)throw Error('failed to get info about account: Reserved upstream capacity is busy');return {outcome:'done'};}}}});
 for(let n=0;n<10;n++){await runner.tick();const s=r.jobs.get(job.jobId);assert.equal(s.state,'queued');assert.equal(s.result.category,'capacity');assert.equal(s.result.attempts,0);c.advance(1001);}
 available=true;await runner.tick();assert.equal(r.jobs.get(job.jobId).state,'done');runner.stop();await runner.drain();r.close();
});

test('finished work emits slot occupancy and a broken metrics sink cannot retain the slot',async()=>{
 const {c,r}=setup(),logs=[];let runner;
 try{
  const job=r.jobs.enqueue({...id(10),operationKey:'settlement',jobClass:'settlement'}).job;
  runner=createJobRunner({registry:r,owner:'timing',now:c.now,handlers:{settlement:{async run(){await new Promise(resolve=>setImmediate(resolve));return {outcome:'done'};}}},log:event=>{if(event.event==='job-finished'){logs.push(event);throw Error('Metrics sink unavailable');}}});
  await runner.tick();assert.equal(r.jobs.get(job.jobId).state,'done');assert.equal(runner.active(),0);assert.equal(logs.length,1);assert.equal(logs[0].jobClass,'settlement');assert.ok(Number.isSafeInteger(logs[0].durationMs)&&logs[0].durationMs>=0);assert.equal(runner.health().finished,1);
 }finally{runner?.stop();await runner?.drain();r.close();}
});


test('many unresolved checks do not exhaust the next real transient retry',async()=>{
 const {c,r}=setup();let checks=0,runs=0;
 const job=r.jobs.enqueue({...id(10),operationKey:'refund:poll-budget',jobClass:'refunds'}).job;
 const runner=createJobRunner({registry:r,owner:'poll-budget',now:c.now,maxAttempts:2,random:()=>0,backoff:{baseMs:10,maxMs:100,unknownMs:1},handlers:{refunds:{
  async reconcile(){checks++;return {status:checks<12?'unresolved':'expired'};},
  async run(){runs++;return runs===1?{outcome:'unknown',reconcile:{signature:'5'.repeat(64)}}:runs===2?{outcome:'retry',category:'unsigned-expired'}:{outcome:'done'};}
 }}});
 await runner.tick();for(let i=0;i<12;i++){c.advance(101);await runner.tick();}
 const retry=r.jobs.get(job.jobId);assert.equal(retry.state,'queued');assert.equal(retry.result.outcome,'retry');assert.equal(retry.result.retryAttempts,1);assert.equal(retry.result.attempts,13);assert.equal(runs,2);
 c.advance(101);await runner.tick();assert.equal(r.jobs.get(job.jobId).state,'done');assert.equal(runs,3);
 runner.stop();await runner.drain();r.close();
});

test('a new signed attempt resets only its confirmation backoff',async()=>{
 const {c,r}=setup();let resolved=false;
 const job=r.jobs.enqueue({...id(10),operationKey:'launch:backoff',jobClass:'launch'}).job;
 const runner=createJobRunner({registry:r,owner:'packet-backoff',now:c.now,backoff:{baseMs:10,maxMs:1000,unknownMs:100},handlers:{launch:{async reconcile(){return {status:resolved?'expired':'unresolved'};},async run(){return {outcome:'unknown',reconcile:{signature:(resolved?'6':'5').repeat(64)}};}}}});
 await runner.tick();for(let i=0;i<10;i++){c.advance(1001);await runner.tick();}
 const prior=r.jobs.get(job.jobId);assert.equal(prior.result.reconcileChecks,11);assert.equal(Date.parse(prior.notBefore)-c.now(),800);
 resolved=true;c.advance(1001);await runner.tick();const next=r.jobs.get(job.jobId);assert.equal(next.result.attempts,12);assert.equal(next.result.reconcileChecks,1);assert.equal(Date.parse(next.notBefore)-c.now(),100);assert.equal(next.result.retryAttempts,0);
 runner.stop();await runner.drain();r.close();
});

test('a simulation answered behind the minimum context slot retries as upstream; a deterministic simulation failure stays permanent; a pending reconciliation keeps its signature',async()=>{
 const {c,r}=setup();let lagging=true;
 let reconciled=0;
 const handlers={
  fees:{async run(job){
    if(job.operationKey==='fee-harvest:1'){if(lagging)throw Error('failed to simulate transaction: Minimum context slot has not been reached');return {outcome:'done'};}
    if(job.operationKey==='fee-harvest:3')return {outcome:'unknown',reconcile:{signature:'Sig111',blockhash:'b',lastValidBlockHeight:5}};
    throw Error('failed to simulate transaction: Error processing Instruction 0: custom program error: 0x1');},
   async reconcile(job){reconciled++;throw Error('failed to simulate transaction: Minimum context slot has not been reached');}},
 };
 const lag=r.jobs.enqueue({...id(10),operationKey:'fee-harvest:1',jobClass:'fees'}).job,det=r.jobs.enqueue({...id(10),operationKey:'fee-harvest:2',jobClass:'fees'}).job;
 const pending=r.jobs.enqueue({...id(11),operationKey:'fee-harvest:3',jobClass:'fees'}).job;
 const runner=createJobRunner({registry:r,handlers,owner:'w1',concurrency:4,now:c.now,random:()=>0,backoff:{baseMs:2000,maxMs:60000,unknownMs:1000}});
 await runner.tick();
 const a=r.jobs.get(lag.jobId);assert.equal(a.state,'queued','the lag is retried');assert.equal(a.result.outcome,'retry');assert.equal(a.result.category,'upstream');assert.equal(a.result.attempts,1);
 const b=r.jobs.get(det.jobId);assert.equal(b.state,'failed','a deterministic simulation failure is permanent');assert.notEqual(b.result.category,'upstream');
 let p=r.jobs.get(pending.jobId);assert.equal(p.result.outcome,'unknown');assert.equal(p.result.reconcile.signature,'Sig111');
 // The reconciliation itself hits the lag: the job stays unknown with its original signature and comes back, never failed.
 c.advance(1001);await runner.tick();p=r.jobs.get(pending.jobId);assert.equal(reconciled,1);assert.notEqual(p.state,'failed');assert.equal(p.result.reconcile.signature,'Sig111','an unresolved reconciliation keeps the original signature');
 lagging=false;c.advance(60001);await runner.tick();assert.equal(r.jobs.get(lag.jobId).state,'done','the same job completes once the provider caught up');
 r.close();
});
