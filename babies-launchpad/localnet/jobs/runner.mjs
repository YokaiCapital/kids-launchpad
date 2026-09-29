// Durable job runner over the registry jobs table (plan section 8, P3). Every job belongs to one campaign and one
// operation key; a lease carries a fencing token that grows on every lease, so a runner whose lease expired can neither
// publish a result nor perform a side effect (ctx.fenced checks the lease before every write). Delivery is at least
// once: handlers are idempotent and report one of four explicit outcomes:
//   done              the work is complete and reconciled;
//   retry             a transient problem; the job comes back after an exponential backoff with jitter;
//   failed-permanent  the job cannot succeed (invalid request, deadline, not wired);
//   unknown           a transaction was sent and its fate is not known: the job comes back and the handler's reconcile
//                     step reads the chain for the recorded signature before anything is rebuilt or resent.
// Fairness: due jobs are grouped by campaign and served round-robin, and within a campaign by priority class (launch,
// then claims and refunds, then settlement, then fees), with bounded receipt chunks. Production lane workers query only their assigned classes.
// Independent service capacity, not priority alone, isolates fee work from user actions. Nothing here talks to the chain.
import {setTimeout as pause} from 'node:timers/promises';
import {laneClasses} from './lanes.mjs';
import {campaignId} from '../registry/registry.mjs';
export const OUTCOMES=Object.freeze(['done','retry','failed-permanent','unknown','yield']);
/** Priority classes: lower runs first within one campaign. Unknown classes rank last. */
export const JOB_CLASSES=Object.freeze({launch:0,claims:1,refunds:1,settlement:2,reconcile:2,fees:3});
export const DEFAULT_BACKOFF=Object.freeze({baseMs:2000,maxMs:300000,unknownMs:15000});
export const DEFAULT_MAX_ATTEMPTS=8;
/** Reliability rules: retry transient failures only (network, timeout, 429, 5xx, a lost lease is not retried here). */
export function classifyError(error){
 const code=error?.code,m=String(error?.message||error||'');
 if(code==='CAPACITY_WAIT'||m.includes('Reserved upstream capacity is busy'))return {category:'capacity',transient:true};
 if(code==='RPC_UNAVAILABLE')return {category:'upstream',transient:true};
 if(code==='STALE_LEASE')return {category:'stale-lease',transient:false};
 // The signer verified its own signature against the payer before persisting and refused: deterministic, nothing persisted.
 if(code==='SIGNER_PERSISTENCE_REFUSED')return {category:'signer-refused',transient:false};
 // The signer's budget refused the packet before any hold (scope, exact template or opening commitment): deterministic.
 if(code==='SIGNER_PACKET_REFUSED')return {category:'signer-refused',transient:false};
 // The custody endpoint refused the launch packet deterministically (or the worker's token is wrong): permanent, nothing resent.
 if(code==='CUSTODY_REFUSED'||code==='CUSTODY_UNAUTHORIZED')return {category:'custody-refused',transient:false};
 if(code==='ABORT_ERR'||error?.name==='AbortError'||/timeout|timed out|unresolved/i.test(m))return {category:'timeout',transient:true};
 if(/429|rate limit/i.test(m))return {category:'rate-limited',transient:true};
 if(code==='ECONNREFUSED'||code==='ENOTFOUND'||code==='ECONNRESET'||code==='EAI_AGAIN'||/fetch failed|socket|network|ECONNRESET/i.test(m))return {category:'network',transient:true};
 // An RPC node answering behind the requested minimum context slot is a provider lag, never a permanent failure (-32016).
 if(code===-32016||/Minimum context slot has not been reached/i.test(m))return {category:'upstream',transient:true};
 if(/\b5\d\d\b|upstream|unavailable|blockhash not found|node is behind|Too many requests/i.test(m))return {category:'upstream',transient:true};
 // A signer that no longer serves the campaign (grant expired, revoked or not issued) is an operator condition, not a
 // permanent job failure: the job pauses and resumes on its own once a grant exists again. Any other refusal stays terminal.
 if(/capability (expired|revoked)|not served by any capability/i.test(m))return {category:'capability-paused',transient:false,paused:true};
 if(/unauthorized|forbidden|401|403|signer refused/i.test(m))return {category:'auth',transient:false};
 if(/malformed|invalid|mismatch|out of bounds/i.test(m))return {category:'invalid',transient:false};
 return {category:'unknown',transient:false};
}
/** Exponential backoff with full jitter: base × 2^(attempt-1), capped, then a random share between half and the whole delay. */
export function backoffMs(attempt,{baseMs=DEFAULT_BACKOFF.baseMs,maxMs=DEFAULT_BACKOFF.maxMs,random=Math.random}={}){
 const n=Math.max(1,Math.min(30,Number(attempt)||1));
 const cap=Math.min(maxMs,baseMs*2**(n-1));
 return Math.floor(cap/2+random()*(cap/2));
}
const rank=(job,classes)=>classes[job.jobClass]??99;
/** Fair pick: campaigns in a fixed order, rotated so the campaign after `lastCampaign` goes first; within a campaign the
 * lowest class rank, then the oldest. Returns null when nothing is due. */
export function pickFair(due,{lastCampaign=null,classes=JOB_CLASSES}={}){
 if(!due.length)return null;
 const byCampaign=new Map();
 for(const job of due){const key=campaignId(job);if(!byCampaign.has(key))byCampaign.set(key,[]);byCampaign.get(key).push(job);}
 const keys=[...byCampaign.keys()].sort();
 const start=lastCampaign?keys.findIndex(k=>k>lastCampaign):0;
 const order=start<0?keys:[...keys.slice(start),...keys.slice(0,start)];
 const best=byCampaign.get(order[0]).slice().sort((a,b)=>rank(a,classes)-rank(b,classes)||a.createdAt.localeCompare(b.createdAt)||a.jobId.localeCompare(b.jobId));
 return best[0];
}
const stale=jobId=>{const e=Error('Lease for job '+jobId+' is no longer held by this runner');e.code='STALE_LEASE';return e;};
/**
 * handlers: {[operation prefix or jobClass]: {run(job, ctx), reconcile?(job, ctx)}}, looked up by the operation key's prefix
 * before the first ':' first, then by job.jobClass. ctx: {jobId, token, owner, campaign, attempt, deadlineAt, signal, previous,
 * holds(), fenced(label, fn), renew(), enqueue(job), now, log}.
 */
export function createJobRunner({registry,handlers,owner,concurrency=2,leaseTtlMs=30000,renewEveryMs=null,maxAttempts=DEFAULT_MAX_ATTEMPTS,backoff=DEFAULT_BACKOFF,classes=JOB_CLASSES,now=Date.now,random=Math.random,log=()=>{},dueLimit=200,lane=null,scope=null,servedClasses=null}){
 if(!registry?.jobs)throw Error('Job runner needs a registry');if(!handlers||typeof handlers!=='object')throw Error('Job runner needs handlers');
 if(typeof owner!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(owner))throw Error('Job runner needs an owner id');
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>64)throw Error('concurrency must be 1..64');
 const renewMs=renewEveryMs??Math.max(1000,Math.floor(leaseTtlMs/3));
 const allowedClasses=lane?laneClasses(lane):null;
 if(servedClasses&&(!allowedClasses||!Array.isArray(servedClasses)||!servedClasses.length||servedClasses.some(c=>!allowedClasses.includes(c))))throw Error('Worker classes must belong to its lane');
 const jobClasses=servedClasses||allowedClasses;
 if(scope&&!jobClasses)throw Error('Scoped worker requires atomic lane leasing');
 if(registry.driver==='postgres'&&!jobClasses)throw Error('A PostgreSQL worker requires an explicit independent lane');
 if(jobClasses&&typeof registry.jobs.leaseNext!=='function')throw Error('Lane workers require atomic lane-filtered leasing');
 const active=new Map(),activeSince=new Map();let lastDispatch=performance.now(),finished=0;let lastCampaign=null,stopped=false,filling=null,serving=false;
 const iso=ms=>new Date(ms).toISOString();
 // The operation key's prefix names the most specific handler (launch-assert-ready and launch share the launch class).
 const handlerFor=job=>handlers[String(job.operationKey).split(':')[0]]||handlers[job.jobClass]||null;
 async function publish(label,fn){try{return await fn();}catch(e){if(e?.code==='STALE_LEASE'){log({event:'job-stale-runner',owner,step:label});throw e;}throw e;}}
 async function run(job){
  // PostgreSQL stamped updatedAt when granting this lease. Advance that
  // baseline monotonically; a worker's wall clock must not fail a valid job
  // early or postpone retries by its clock offset. On-chain time stays final.
  const leasedAt=Date.parse(job.updatedAt),startedAt=performance.now();
  if(registry.driver==='postgres'&&!Number.isFinite(leasedAt))throw Error('Database lease timestamp unavailable');
  const jobNow=registry.driver==='postgres'?()=>Math.floor(leasedAt+performance.now()-startedAt):now;
  const handler=handlerFor(job);
  const attempt=(Number(job.result?.attempts)||0)+1;
  // Chain reconciliation is not a failed execution. Keep its poll count for
  // observability/backoff without spending the bounded transient retry budget.
  // Older unknown rows have no reliable failure count; their polls count as zero.
  const priorRetries=Number.isSafeInteger(job.result?.retryAttempts)&&job.result.retryAttempts>=0?job.result.retryAttempts:job.result?.outcome==='retry'?(Number(job.result.attempts)||0):0;
  const identity={genesisHash:job.genesisHash,programId:job.programId,campaign:job.campaign};
  const abort=new AbortController();let deadlineTimer=null;
  const pendingReconcile=job.result?.outcome==='unknown'&&job.result?.reconcile;
  if(job.deadlineAt&&!pendingReconcile){const left=Date.parse(job.deadlineAt)-jobNow();if(left<=0){await publish('deadline',()=>registry.jobs.fail({jobId:job.jobId,token:job.fencingToken,error:'deadline passed',result:{outcome:'failed-permanent',category:'deadline',attempts:attempt-1,previous:job.result??null}}));log({event:'job-failed',jobId:job.jobId,campaign:job.campaign,category:'deadline'});return;}deadlineTimer=setTimeout(()=>abort.abort(),left);deadlineTimer.unref?.();}
  const holds=()=>registry.jobs.holds({jobId:job.jobId,token:job.fencingToken,owner});
  const ctx={jobId:job.jobId,token:job.fencingToken,owner,campaign:identity,attempt,deadlineAt:job.deadlineAt,signal:abort.signal,previous:job.result??null,now:jobNow,log,holds,
   async fenced(label,fn){if(abort.signal.aborted||!await holds())throw stale(job.jobId);return fn();},
   renew:()=>registry.jobs.renew({jobId:job.jobId,token:job.fencingToken,owner,ttlMs:leaseTtlMs}),
   enqueue:input=>registry.jobs.enqueue({...identity,...input})};
  let renewing=false;
  const renewTimer=setInterval(async()=>{if(renewing)return;renewing=true;try{if(!await ctx.renew()){abort.abort();log({event:'job-renew-lost',jobId:job.jobId,owner});}}catch(e){abort.abort();log({event:'job-renew-error',jobId:job.jobId,category:classifyError(e).category});}finally{renewing=false;}},renewMs);renewTimer.unref?.();
  let result;
  try{
   if(!handler)result={outcome:'failed-permanent',category:'no-handler',reason:'no handler for '+job.jobClass};
   else{
    // An unknown transaction outcome is reconciled from the chain before any work that could rebuild or resend it.
    if(job.result?.outcome==='unknown'&&job.result.reconcile){
     if(typeof handler.reconcile!=='function')result={outcome:'failed-permanent',category:'reconcile-not-supported',reason:'handler cannot reconcile an unknown transaction',reconcile:job.result.reconcile};
     else{const r=await handler.reconcile(job,ctx);
      if(!r||!['confirmed','failed','expired','unresolved'].includes(r.status))result={outcome:'failed-permanent',category:'bad-reconcile',reason:'reconcile returned no status'};
      else if(r.status==='unresolved')result={outcome:'unknown',reconcile:{...job.result.reconcile,lastCheck:r},category:'unresolved'};
      else if(job.deadlineAt&&Date.parse(job.deadlineAt)<=jobNow()&&r.status!=='confirmed')result={outcome:'failed-permanent',category:'deadline',reason:'deadline passed after transaction resolved',reconcile:r};
      else{ctx.reconciled=r;result=await handler.run(job,ctx);}
     }
    }else result=await handler.run(job,ctx);
   }
   if(!result||!OUTCOMES.includes(result.outcome))result={outcome:'failed-permanent',category:'bad-outcome',reason:'handler returned no explicit outcome'};
  }catch(e){
   const c=classifyError(e);
   if(c.category==='stale-lease'){log({event:'job-stale-runner',jobId:job.jobId,owner,step:'run'});clearInterval(renewTimer);clearTimeout(deadlineTimer);return;}
   result=pendingReconcile?{outcome:'unknown',reconcile:job.result.reconcile,category:c.category,reason:'Reconciliation unavailable; original transaction retained'}:e?.code==='OPERATING_FUNDING_WAIT'?{outcome:'yield',category:'awaiting-operating-funding',delayMs:30000,reason:'Operating reserve needs funding; no new signature issued'}:c.paused?{outcome:'yield',category:'capability-paused',delayMs:60000,reason:'Signer serves no current grant for this campaign; waiting for an operator grant, no signature issued'}:c.category==='capacity'?{outcome:'yield',category:'capacity',delayMs:Math.max(10,Math.min(300000,Number(e.retryAfterMs)||1000))}:{outcome:c.transient?'retry':'failed-permanent',category:c.category,reason:String(e?.message||e).slice(0,300)};
   if(c.category==='capacity'&&['rpc','request-rate','hourly-spend'].includes(e.capacityKind))result.capacityKind=e.capacityKind;
  }finally{clearInterval(renewTimer);clearTimeout(deadlineTimer);}
  const {outcome,...rest}=result;const retryAttempt=priorRetries+(outcome==='retry'?1:0);
  const record={outcome,attempts:attempt,...rest,...(['retry','unknown'].includes(outcome)||job.result?.retryAttempts!==undefined?{retryAttempts:retryAttempt}:{})};
  if(outcome==='done'){await publish('complete',()=>registry.jobs.complete({jobId:job.jobId,token:job.fencingToken,result:record}));log({event:'job-done',jobId:job.jobId,campaign:job.campaign,operationKey:job.operationKey,attempts:attempt});return;}
  if(outcome==='failed-permanent'){await publish('fail',()=>registry.jobs.fail({jobId:job.jobId,token:job.fencingToken,error:rest.reason||rest.category||'failed',result:record}));log({event:'job-failed',jobId:job.jobId,campaign:job.campaign,operationKey:job.operationKey,category:rest.category||'unknown',attempts:attempt});return;}
  if(outcome==='yield'){
   await publish('yield',()=>registry.jobs.requeue({jobId:job.jobId,token:job.fencingToken,result:{...record,attempts:Number(job.result?.attempts)||0},notBefore:iso(jobNow()+Math.max(1,Math.min(300000,Number(rest.delayMs)||1)))}));
   log({event:'job-yield',jobId:job.jobId,campaign:job.campaign,checkpoint:rest.checkpoint??null});return;
  }
  if(outcome==='retry'){
   if(retryAttempt>=maxAttempts){await publish('fail',()=>registry.jobs.fail({jobId:job.jobId,token:job.fencingToken,error:'retries exhausted: '+(rest.reason||rest.category||''),result:{...record,outcome:'failed-permanent',category:'retries-exhausted',lastCategory:rest.category||null}}));log({event:'job-failed',jobId:job.jobId,campaign:job.campaign,category:'retries-exhausted',attempts:attempt,retryAttempts:retryAttempt});return;}
   const delay=Number.isInteger(rest.delayMs)&&rest.delayMs>=0?rest.delayMs:backoffMs(retryAttempt,{...backoff,random});
   await publish('requeue',()=>registry.jobs.requeue({jobId:job.jobId,token:job.fencingToken,result:record,notBefore:iso(jobNow()+delay)}));log({event:'job-retry',jobId:job.jobId,campaign:job.campaign,category:rest.category||'unknown',attempts:attempt,delayMs:delay});return;
  }
  // unknown: never exhausted into a failure. It comes back for reconciliation until chain evidence resolves it, including after scheduling deadlines.
  // A newly signed attempt deserves its first confirmation check promptly;
  // earlier ambiguous packets must not carry a two-minute backoff into it.
  const samePacket=job.result?.outcome==='unknown'&&job.result.reconcile?.signature&&job.result.reconcile.signature===rest.reconcile?.signature;
  const reconcileChecks=samePacket?(Number(job.result.reconcileChecks)||1)+1:1;
  const delay=Math.min(backoff.maxMs,(backoff.unknownMs||DEFAULT_BACKOFF.unknownMs)*Math.min(8,reconcileChecks));
  await publish('requeue',()=>registry.jobs.requeue({jobId:job.jobId,token:job.fencingToken,result:{...record,reconcileChecks},notBefore:iso(jobNow()+delay)}));log({event:'job-unknown',jobId:job.jobId,campaign:job.campaign,attempts:attempt,reconcileChecks,delayMs:delay,signature:rest.reconcile?.signature||null});
 }
 /** Starts a bounded batch; a serialized fill prevents overlapping callers exceeding concurrency. */
 async function dispatch(){
  if(filling)return [];
  lastDispatch=performance.now();
  let release;filling=new Promise(r=>{release=r;});
  const started=[],taken=new Set(active.keys());
  try{
   while(!stopped&&active.size<concurrency&&started.length<concurrency){
    let leased;
    if(jobClasses)leased=await registry.jobs.leaseNext({owner,ttlMs:leaseTtlMs,jobClasses,lastCampaign,scope});
    else{
     const due=(await registry.jobs.due({limit:dueLimit})).filter(j=>!taken.has(j.jobId));
     const pick=pickFair(due,{lastCampaign,classes});if(!pick)break;
     taken.add(pick.jobId);
     leased=await registry.jobs.leaseById({jobId:pick.jobId,token:pick.fencingToken,owner,ttlMs:leaseTtlMs});
     if(!leased)continue;
    }
    if(!leased)break;
    // Shutdown may begin while the database lease request is in flight. Return
    // that lease without starting a new side effect or discarding reconciliation.
    if(stopped){
     await registry.jobs.requeue({jobId:leased.jobId,token:leased.fencingToken,result:leased.result??{},notBefore:leased.notBefore??null});
     break;
    }
    lastCampaign=campaignId(leased);
    activeSince.set(leased.jobId,performance.now());
    log({event:'job-started',jobId:leased.jobId,campaign:leased.campaign,lane,jobClass:leased.jobClass,
     operationKey:leased.operationKey,fencingToken:leased.fencingToken,leasedAt:leased.updatedAt,
     dueAt:leased.notBefore&&leased.notBefore>leased.createdAt?leased.notBefore:leased.createdAt});
    const p=run(leased).catch(e=>log({event:'job-runner-error',jobId:leased.jobId,category:classifyError(e).category})).finally(()=>{
     const durationMs=Math.max(0,Math.round(performance.now()-activeSince.get(leased.jobId)));
     active.delete(leased.jobId);activeSince.delete(leased.jobId);finished++;
     try{log({event:'job-finished',lane,jobClass:leased.jobClass,jobId:leased.jobId,campaign:leased.campaign,durationMs});}catch{/* Telemetry cannot retain a finished execution slot. */}
    });
    active.set(leased.jobId,p);started.push(p);
   }
   return started;
  }finally{release();filling=null;}
 }
 async function tick(){const started=await dispatch();await Promise.all(started);return {leased:started.length};}
 /** Continuous service: refill when ANY slot finishes, not when the slowest job in a batch finishes. */
 async function serve({pollMs=250,signal}={}){
  if(serving)throw Error('Worker is already serving');
  if(!Number.isInteger(pollMs)||pollMs<10||pollMs>10000)throw Error('Invalid worker poll interval');
  serving=true;
  try{
   while(!stopped&&!signal?.aborted){
    try{await dispatch();}catch(e){log({event:'job-lease-error',lane,category:classifyError(e).category});await pause(Math.max(1000,pollMs));continue;}
    // Clear the losing timer to avoid accumulating timers during high throughput.
    let timer;try{await Promise.race([...active.values(),new Promise(r=>{timer=setTimeout(r,pollMs);})]);}finally{clearTimeout(timer);}
   }
  }finally{serving=false;}
 }
 async function drain(){if(filling)await filling;await Promise.all([...active.values()]);}
 return {tick,serve,drain,owner,lane,active:()=>active.size,health:()=>({active:active.size,dispatchAgeMs:Math.max(0,Math.round(performance.now()-lastDispatch)),oldestActiveMs:activeSince.size?Math.max(0,Math.round(performance.now()-Math.min(...activeSince.values()))):0,finished}),stop(){stopped=true;},get lastCampaign(){return lastCampaign;}};
}
