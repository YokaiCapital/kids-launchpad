// Settlement and refund recovery drill (P3 exit gate), localnet only: no network, no keys, no real program. It runs the
// job runner and the settle/refund handlers against the in-memory v2 chain emulation and checks, with counts:
//   1. N receipts settle; the runner crashes after k settled; a new runner takes over after the lease expires and
//      finishes without settling any receipt twice; count and totals reconcile against the campaign counters.
//   2. Refunds crash mid-way and complete idempotently on restart (every lamport refunded exactly once).
//   3. A stale runner holding an old fencing token is refused: it performs no side effect and publishes nothing.
//   4. An ambiguous send is reconciled by signature before the pass resumes (no second settle of that receipt).
// Usage: node localnet/protocol-v2/recovery-drill.mjs [--receipts N] [--crash-after K] [--write path.md]
import {writeFileSync} from 'node:fs';
import {openRegistry} from '../registry/registry.mjs';
import {createJobRunner} from '../jobs/runner.mjs';
import {settleReceipts,refundReceipts} from '../jobs/handlers.mjs';
import {createChainEmulation,address} from './chain-emulation.mjs';
import {accepted} from './policy.mjs';
const args=process.argv.slice(2),opt=(n,d)=>{const i=args.indexOf(n);return i>=0?args[i+1]:d;};
const N=Number(opt('--receipts',200)),K=Number(opt('--crash-after',73)),WRITE=opt('--write',null);
if(!Number.isInteger(N)||N<2||N>5000||!Number.isInteger(K)||K<1||K>=N)throw Error('--receipts must be 2..5000 and --crash-after inside it');
const identity={genesisHash:address(200),programId:address(201),campaign:address(202)};
function clock(startSeconds=1790000000){let t=startSeconds*1000;return {now:()=>t,advance(ms){t+=ms;}};}
const BACKOFF={baseMs:10,maxMs:10,unknownMs:10};
function world({commitments,soft,hard}){
 const c=clock();const registry=openRegistry({now:c.now});registry.migrate();registry.campaigns.upsert({...identity,mode:'standard',campaignVersion:2,registryStatus:'planned'});
 const deadline=BigInt(Math.floor(c.now()/1000)+10);
 const chain=createChainEmulation({identity,terms:{soft,hard,deadline,launchDeadline:deadline+7200n},commitments,now:c.now});
 c.advance(11_000);// funding closed
 return {c,registry,chain};
}
const jobOf=(registry,key,cls)=>registry.jobs.get(registry.jobs.enqueue({...identity,operationKey:key,jobClass:cls}).job.jobId);
const runner=(w,name,handlers,extra={})=>createJobRunner({registry:w.registry,handlers,owner:name,concurrency:1,leaseTtlMs:5000,renewEveryMs:1_000_000,now:w.c.now,random:()=>0,backoff:BACKOFF,log:()=>{},...extra});
async function untilState(w,run,key,cls,states,maxTicks=Math.ceil(N/64)+50){for(let i=0;i<maxTicks;i++){const j=jobOf(w.registry,key,cls);if(states.includes(j.state))return j;await run.tick();w.c.advance(50);}return jobOf(w.registry,key,cls);}
async function runUntilCrash(w,worker){
 const before=w.chain.calls.crashes||0;
 const dying=(async()=>{for(let i=0;i<Math.ceil(N/64)+10;i++){await worker.tick();w.c.advance(50);}throw Error('Expected worker crash did not occur');})();
 dying.catch(()=>{});
 const observed=(async()=>{for(let i=0;i<100;i++){if((w.chain.calls.crashes||0)>before)return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out waiting for simulated worker crash');})();
 await Promise.race([dying,observed]);
}
const results=[];const record=(name,facts)=>{results.push({name,...facts});return facts;};
const commitments=Array.from({length:N},(_,i)=>({committed:BigInt(1_000_000+i*7919)}));
const total=commitments.reduce((s,c)=>s+c.committed,0n),hard=total*3n/4n,soft=total/10n;// oversubscribed: excess refundable
const expectedAccepted=commitments.reduce((s,c)=>s+accepted(c.committed,total,hard),0n);
// 1. settle, crash after K, restart
{
 const w=world({commitments,soft,hard});const handlers={settlement:settleReceipts({chain:w.chain,maxReceipts:64})};
 w.chain.hooks.crashAfterSettle=K;
 w.registry.jobs.enqueue({...identity,operationKey:'settle-receipts',jobClass:'settlement'});
 const first=runner(w,'runner-1',handlers);
 // the process "dies" inside the K-th settle: the tick never resolves, the lease stays held, nothing is renewed
 await runUntilCrash(w,first);
 const afterCrash=jobOf(w.registry,'settle-receipts','settlement');
 const landedAtCrash=w.chain.calls.landedSettle;
 const held=afterCrash.state==='leased'&&afterCrash.leaseOwner==='runner-1';
 w.c.advance(6_000);// lease expires
 const second=runner(w,'runner-2',handlers);
 const done=await untilState(w,second,'settle-receipts','settlement',['done','failed']);
 record('settle crash and restart',{receipts:N,crashAfter:K,landedAtCrash,leaseHeldByCrashedRunner:held,finalState:done.state,settleCallsTotal:w.chain.calls.settle,settledOnChain:Number(w.chain.state.settledCount),settledTwice:w.chain.calls.landedSettle-N,settledAcceptedMatches:w.chain.state.settledAccepted===expectedAccepted,settledAccepted:w.chain.state.settledAccepted.toString(),expectedAccepted:expectedAccepted.toString(),fencingTokenAtEnd:done.fencingToken,attempts:done.result?.attempts??null,resultCategory:done.result?.category??null});
 w.registry.close();
}
// 2. refunds crash mid-way and complete idempotently
{
 const w=world({commitments,soft,hard});const handlers={settlement:settleReceipts({chain:w.chain,maxReceipts:64}),refunds:refundReceipts({chain:w.chain,maxReceipts:64})};
 w.registry.jobs.enqueue({...identity,operationKey:'settle-receipts',jobClass:'settlement'});
 const r1=runner(w,'runner-1',handlers);await untilState(w,r1,'settle-receipts','settlement',['done','failed']);
 const settled=Number(w.chain.state.settledCount);
 w.chain.hooks.crashAfterRefund=Math.floor(N/3);
 w.registry.jobs.enqueue({...identity,operationKey:'refund-receipts',jobClass:'refunds'});
 await runUntilCrash(w,r1);
 const landedAtCrash=w.chain.calls.landedRefund;const held=jobOf(w.registry,'refund-receipts','refunds').leaseOwner==='runner-1';
 w.c.advance(6_000);
 const r2=runner(w,'runner-2',handlers);const done=await untilState(w,r2,'refund-receipts','refunds',['done','failed']);
 const expectedRefund=total-expectedAccepted;
 const overRefunded=[...w.chain.receipts.values()].filter(r=>r.refunded>r.committed-r.accepted).length;
 record('refund crash and restart',{receipts:N,settledBefore:settled,crashAfter:Math.floor(N/3),landedAtCrash,leaseHeldByCrashedRunner:held,finalState:done.state,refundCallsTotal:w.chain.calls.refund,refundsLanded:w.chain.calls.landedRefund,refundedLamports:w.chain.state.refunded.toString(),expectedRefundLamports:expectedRefund.toString(),refundedMatches:w.chain.state.refunded===expectedRefund,receiptsOverRefunded:overRefunded,fencingTokenAtEnd:done.fencingToken});
 w.registry.close();
}
// 3. a stale runner with an old fencing token is refused
{
 const w=world({commitments:commitments.slice(0,20),soft:1n,hard:hard});
 let release,started;const entered=new Promise(res=>started=res);const gate=new Promise(res=>release=res);const effects=[];
 const slow={settlement:{async run(job,ctx){started();await gate;let refused=false;try{await ctx.fenced('settle',async()=>{effects.push('stale-write');await w.chain.settle(identity,{address:address(1)});});}catch(e){refused=e.code==='STALE_LEASE';}return {outcome:'done',refused};}}};
 w.registry.jobs.enqueue({...identity,operationKey:'settle-receipts',jobClass:'settlement'});
 const stale=runner(w,'stale',slow);const staleTick=stale.tick();await entered;
 w.c.advance(6_000);
 const fresh=runner(w,'fresh',{settlement:settleReceipts({chain:w.chain,maxReceipts:64})});await untilState(w,fresh,'settle-receipts','settlement',['done','failed']);
 const beforeStale=Number(w.chain.state.settledCount),callsBefore=w.chain.calls.settle;
 release();await staleTick;
 const j=jobOf(w.registry,'settle-receipts','settlement');
 record('stale runner refused',{receipts:20,staleSideEffects:effects.length,settleCallsAfterFresh:w.chain.calls.settle-callsBefore,settledOnChain:Number(w.chain.state.settledCount),settledBeforeStaleAttempt:beforeStale,finalState:j.state,resultPublishedBy:j.result?.refused===undefined?'fresh':'stale',fencingTokenAtEnd:j.fencingToken});
 w.registry.close();
}
// 4. ambiguous send reconciled by signature
{
 const w=world({commitments:commitments.slice(0,30),soft:1n,hard});const handlers={settlement:settleReceipts({chain:w.chain,maxReceipts:64})};
 w.chain.hooks.ambiguous.add(address(7));w.chain.hooks.ambiguous.add(address(19));
 w.registry.jobs.enqueue({...identity,operationKey:'settle-receipts',jobClass:'settlement'});
 const r=runner(w,'runner-1',handlers);const trail=[];
 for(let i=0;i<20;i++){await r.tick();const j=jobOf(w.registry,'settle-receipts','settlement');trail.push(j.result?.outcome??j.state);if(j.state==='done')break;w.c.advance(50);}
 const j=jobOf(w.registry,'settle-receipts','settlement');
 record('ambiguous send reconciled',{receipts:30,ambiguousReceipts:2,outcomes:trail.join(' > '),finalState:j.state,settleCalls:w.chain.calls.settle,settledOnChain:Number(w.chain.state.settledCount),settledTwice:w.chain.calls.landedSettle-30});
 w.registry.close();
}
const ok=results.every(r=>r.finalState==='done')&&results[0].settledTwice===0&&results[0].settledAcceptedMatches&&results[1].refundedMatches&&results[1].receiptsOverRefunded===0&&results[2].staleSideEffects===0&&results[2].resultPublishedBy==='fresh'&&results[3].settledTwice===0;
const lines=['# Chunked settlement and refund recovery drill, '+new Date().toISOString().slice(0,10),'','Localnet only: in-memory chain emulation of one kids-launch-v2 campaign (`localnet/protocol-v2/chain-emulation.mjs`), the job runner (`localnet/jobs/runner.mjs`) and the settle and refund handlers (`localnet/jobs/handlers.mjs`). No network, no keys, no real program. Rerun: `node localnet/protocol-v2/recovery-drill.mjs --receipts '+N+' --crash-after '+K+' --write '+(WRITE||'deployment/evidence/RECOVERY-DRILL.md')+'`.','','Result: '+(ok?'PASS':'FAIL')+' (every scenario finished, no receipt settled twice, no lamport refunded twice, the stale runner wrote nothing).','','Campaign: '+N+' receipts, committed '+total+' lamports, hard cap '+hard+' (oversubscribed), soft cap '+soft+'.',''];
for(const r of results){lines.push('## '+r.name,'');for(const [k,v] of Object.entries(r))if(k!=='name')lines.push('- '+k+': '+String(v));lines.push('');}
lines.push('Scope: the emulation proves the runner, the fencing and the handlers; it does not prove RPC behaviour, the signer or the real program. Those are P5 gates.');
const text=lines.join('\n')+'\n';
if(WRITE)writeFileSync(WRITE,text);
process.stdout.write(text);
if(!ok)process.exit(1);
