// Job handlers for this slice (plan section 8, P3). Each handler is a factory that takes an injected chain adapter, so
// the handlers run against the localnet emulation in the recovery drill and against the real program through
// protocol-v2/chain-adapter.mjs without changing a line here. Every handler works on the job's own campaign identity,
// never on "the active campaign".
//
// Chain adapter contract (all async, all take the campaign identity {genesisHash, programId, campaign}):
//   readCampaign(id)                 -> {phase, deadline, launchDeadline, total, soft, hard, refunded, receiptCount,
//                                        settledCount, settledAccepted, slot}   (BigInt-compatible strings or bigints)
//   listReceipts(id)                 -> {receipts:[{address, owner, committed, accepted, refunded, settled}], complete, slot}
//                                       complete=false when a page ended early or a read failed: never treated as success
//   settle(id, receipt, opts)        -> {status:'confirmed'|'failed'|'unknown', signature, error?, ...facts}
//   refund(id, receipt, opts)        -> same shape
//   launch(id, opts)                 -> same shape plus pool and feeNft
//   verifyLaunch(id)                 -> {ok, failures:[...], checks}   (optional; the launch handler requires it when present)
//   signatureStatus(signature, facts)-> {status:'confirmed'|'failed'|'expired'|'unresolved'}
//   assertReady(id)                  -> {ready:boolean, reason, live?, failed?}
// opts carry {operationId, signal, fencingToken, operationKey}: the signing service's capability path binds every
// signature to the job's lease, so a runner whose lease expired cannot sign. A send that returns 'unknown' stops the
// handler at once with an explicit unknown outcome carrying the signature and its blockhash facts; the runner calls
// reconcile() with them before the handler runs again. Nothing is resent blind.
import {refundable,launchFailed} from '../protocol-v2/policy.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
const big=v=>typeof v==='bigint'?v:BigInt(String(v));
const sortReceipts=list=>[...list].sort((a,b)=>String(a.address).localeCompare(String(b.address)));
const ALREADY=/already settled|already refunded|nothing to refund|AlreadySettled|NothingToRefund|custom program error: 0x(1[0-9a-f]|2[0-9a-f])\b/i;
const sendOptions=(ctx,job,operationId)=>({operationId,signal:ctx.signal,holds:ctx.holds,fencingToken:ctx.token,operationKey:job.operationKey});
function reconcileWith(chain,kind){
 return async function reconcile(job){
  const facts=job.result?.reconcile;if(!facts?.signature)return {status:'failed',note:'no signature recorded'};
  const s=await chain.signatureStatus(facts.signature,facts);
  return {status:s.status,kind,receipt:facts.receipt??null,signature:facts.signature,...(s.error?{error:s.error}:{})};
 };
}
function validateSlice(count,ms){if(!Number.isInteger(count)||count<1||count>64||!Number.isInteger(ms)||ms<1||ms>30000)throw Error('Invalid receipt slice budget');}
function validateBatch(chain,size,kind){if(!Number.isInteger(size)||size<1||size>8||size>1&&(chain?.receiptBatchVersion!==3||typeof chain[kind+'Batch']!=='function'))throw Error('Receipt batches require the explicit v3 adapter and size 1..8');}
const unknownFacts=sent=>({...(sent.packetRef?{packetRef:sent.packetRef}:{}),signature:sent.signature||null,blockhash:sent.blockhash??null,lastValidBlockHeight:sent.lastValidBlockHeight??null});
const actionClock=(chain,ctx,authoritative)=>authoritative?chain.chainTime():BigInt(Math.floor(ctx.now()/1000));
/** Enumerates every receipt, settles singly by default (bounded batches only for an explicit v3 adapter), then reconciles count and totals against the
 * campaign counters on chain. A page that ended early, a count that differs from the counter, or totals that do not add
 * up are reported as retry with a category, never as done. */
export function settleReceipts({chain,maxReceipts=16,maxSliceMs=5000,batchSize=1,authoritativeClock=false}){
 validateSlice(maxReceipts,maxSliceMs);
 validateBatch(chain,batchSize,'settle');
 if(!chain)throw Error('settle-receipts needs a chain adapter');
 if(authoritativeClock&&typeof chain.chainTime!=='function')throw Error('Authoritative chain clock required');
 return {
  reconcile:reconcileWith(chain,'settle'),
  async run(job,ctx){
   const id=ctx.campaign;
   const before=await chain.readCampaign(id);
   const now=await actionClock(chain,ctx,authoritativeClock);
   if(now<big(before.deadline))return {outcome:authoritativeClock?'yield':'retry',category:'funding-open',reason:'funding is still open',delayMs:Math.min(authoritativeClock?60000:Infinity,Number(big(before.deadline)-now)*1000)};
   const list=await chain.listReceipts(id);
   if(list.complete!==true)return {outcome:'retry',category:'incomplete-enumeration',reason:'receipt enumeration did not complete'+(list.error?': '+list.error:'')};
   if(BigInt(list.receipts.length)!==big(before.receiptCount))return {outcome:'retry',category:'count-mismatch',reason:'enumerated '+list.receipts.length+' receipts, chain counter says '+String(before.receiptCount)};
   let settledNow=0,skipped=0,processed=0,lastReceipt=null;const sliceStart=ctx.now();
   const pending=sortReceipts(list.receipts).filter(r=>!r.settled);
   for(let index=0;index<pending.length;){
    if(processed>=maxReceipts||(processed>0&&ctx.now()-sliceStart>=maxSliceMs))return {outcome:'yield',category:'receipt-slice',checkpoint:{lastReceipt,processed,settledNow}};
    const group=pending.slice(index,index+Math.min(batchSize,maxReceipts-processed)),r=group[0],multiple=group.length>1;
    const operation=multiple?'settle-batch:'+id.campaign+':'+canonicalHash(group.map(r=>r.address)):'settle:'+id.campaign+':'+r.address;
    const sent=await ctx.fenced('settle:'+r.address,()=>multiple?chain.settleBatch(id,group,sendOptions(ctx,job,operation)):chain.settle(id,r,sendOptions(ctx,job,operation)));
    if(sent.status==='unknown')return {outcome:'unknown',category:'unresolved',reconcile:{kind:'settle',receipt:r.address,...(multiple?{receipts:group.map(r=>r.address)}:{}),...unknownFacts(sent),settledBefore:settledNow}};
    if(sent.status==='failed'){if(!multiple&&ALREADY.test(String(sent.error||'')))skipped++;else return {outcome:'retry',category:'settle-failed',reason:String(sent.error||'settle failed').slice(0,200),receipt:r.address};}
    else settledNow+=group.length;
    processed+=group.length;index+=group.length;lastReceipt=group.at(-1).address;
   }
   const after=await chain.readCampaign(id),check=await chain.listReceipts(id);
   if(check.complete!==true)return {outcome:'retry',category:'incomplete-enumeration',reason:'post-settlement enumeration did not complete'};
   const acceptedSum=check.receipts.reduce((s,r)=>s+(r.settled?big(r.accepted):0n),0n);
   const complete=big(after.settledCount)===big(after.receiptCount)&&BigInt(check.receipts.length)===big(after.receiptCount)&&acceptedSum===big(after.settledAccepted);
   if(!complete)return {outcome:'retry',category:'reconcile-mismatch',reason:'settled '+String(after.settledCount)+' of '+String(after.receiptCount)+', accepted sum '+acceptedSum+' vs counter '+String(after.settledAccepted)};
   return {outcome:'done',settled:settledNow,alreadySettled:skipped,receiptCount:Number(after.receiptCount),settledAccepted:String(after.settledAccepted),slot:after.slot??null};
  },
 };
}
/** Refunds every receipt that still has a refundable balance (over-cap excess, or everything when the campaign failed).
 * The program's refund is cumulative and idempotent, so a repeated refund of a receipt that is already whole is a no-op. */
export function refundReceipts({chain,maxReceipts=16,maxSliceMs=5000,batchSize=1,authoritativeClock=false}){
 validateSlice(maxReceipts,maxSliceMs);
 validateBatch(chain,batchSize,'refund');
 if(!chain)throw Error('refund-receipts needs a chain adapter');
 if(authoritativeClock&&typeof chain.chainTime!=='function')throw Error('Authoritative chain clock required');
 return {
  reconcile:reconcileWith(chain,'refund'),
  async run(job,ctx){
   const id=ctx.campaign;
   const c=await chain.readCampaign(id);
   const now=await actionClock(chain,ctx,authoritativeClock);
   if(now<big(c.deadline))return {outcome:authoritativeClock?'yield':'retry',category:'funding-open',reason:'funding is still open',delayMs:Math.min(authoritativeClock?60000:Infinity,Number(big(c.deadline)-now)*1000)};
   const failed=launchFailed(c.phase,c.total,c.soft,c.launchDeadline,now);
   const list=await chain.listReceipts(id);
   if(list.complete!==true)return {outcome:'retry',category:'incomplete-enumeration',reason:'receipt enumeration did not complete'+(list.error?': '+list.error:'')};
   if(BigInt(list.receipts.length)!==big(c.receiptCount))return {outcome:'retry',category:'count-mismatch',reason:'enumerated '+list.receipts.length+' receipts, chain counter says '+String(c.receiptCount)};
   let refundedNow=0,owed=0n,processed=0,lastReceipt=null;const sliceStart=ctx.now();
   const pending=sortReceipts(list.receipts).filter(r=>refundable(r.committed,c.total,c.hard,failed)-big(r.refunded)>0n);
   for(let index=0;index<pending.length;){
    if(processed>=maxReceipts||(processed>0&&ctx.now()-sliceStart>=maxSliceMs))return {outcome:'yield',category:'receipt-slice',checkpoint:{lastReceipt,processed,refundedNow}};
    const group=pending.slice(index,index+Math.min(batchSize,maxReceipts-processed)),r=group[0],multiple=group.length>1;
    const unsettled=!failed&&group.find(r=>!r.settled);
    if(unsettled)return {outcome:'retry',category:'unsettled-receipt',reason:'receipt '+unsettled.address+' is not settled yet',receipt:unsettled.address};
    const operation=multiple?'refund-batch:'+id.campaign+':'+canonicalHash(group.map(r=>({address:r.address,refunded:String(r.refunded)}))):'refund:'+id.campaign+':'+r.address+':'+String(r.refunded);
    const sent=await ctx.fenced('refund:'+r.address,()=>multiple?chain.refundBatch(id,group,sendOptions(ctx,job,operation)):chain.refund(id,r,sendOptions(ctx,job,operation)));
    if(sent.status==='unknown')return {outcome:'unknown',category:'unresolved',reconcile:{kind:'refund',receipt:r.address,...(multiple?{receipts:group.map(r=>r.address)}:{}),...unknownFacts(sent),refundedBefore:refundedNow}};
    if(sent.status==='failed'){if(multiple||!ALREADY.test(String(sent.error||'')))return {outcome:'retry',category:'refund-failed',reason:String(sent.error||'refund failed').slice(0,200),receipt:r.address};}
    else refundedNow+=group.length;
    processed+=group.length;index+=group.length;lastReceipt=group.at(-1).address;
   }
   const after=await chain.readCampaign(id),check=await chain.listReceipts(id);
   if(check.complete!==true)return {outcome:'retry',category:'incomplete-enumeration',reason:'post-refund enumeration did not complete'};
   for(const r of check.receipts)owed+=refundable(r.committed,after.total,after.hard,failed)-big(r.refunded);
   const refundedSum=check.receipts.reduce((s,r)=>s+big(r.refunded),0n);
   if(owed!==0n||refundedSum!==big(after.refunded))return {outcome:'retry',category:'reconcile-mismatch',reason:'still owed '+owed+', refunded sum '+refundedSum+' vs counter '+String(after.refunded)};
   return {outcome:'done',refunded:refundedNow,failedCampaign:failed,refundedLamports:String(after.refunded),receiptCount:Number(after.receiptCount),slot:after.slot??null};
  },
 };
}
/** Asks the chain whether a launch could run now. Not ready is a retry (a failed campaign is permanent); ready is done
 * and, unless `enqueueLaunch` is false, the launch job of the same campaign is enqueued (operation key `launch`). Nothing
 * is sent here. */
export function launchAssertReady({chain,notReadyDelayMs=30000,enqueueLaunch=true}){
 if(!chain)throw Error('launch-assert-ready needs a chain adapter');
 return {
  async run(job,ctx){
   const r=await chain.assertReady(ctx.campaign);
   if(!r||typeof r.ready!=='boolean')return {outcome:'failed-permanent',category:'bad-readiness',reason:'readiness check returned no verdict'};
   if(r.live===true)return {outcome:'done',ready:false,live:true,reason:'campaign is already live'};
   if(r.failed===true)return {outcome:'failed-permanent',category:'campaign-failed',reason:String(r.reason||'campaign failed').slice(0,200)};
   if(!r.ready)return {outcome:'retry',category:'not-ready',reason:String(r.reason||'not ready').slice(0,200),delayMs:notReadyDelayMs};
   let enqueued=null;
   if(enqueueLaunch){const q=await ctx.enqueue({operationKey:'launch',jobClass:'launch',payload:job.payload??{},deadlineAt:job.deadlineAt??null});enqueued=q?.job?.jobId??null;}
   return {outcome:'done',ready:true,reason:'ready',launchJobId:enqueued};
  },
 };
}
/** Tag 6 through the adapter. Before sending: the campaign is not live yet (a live campaign is done at once, so a rerun
 * after an unknown outcome never double-launches), the chain says ready, every receipt is enumerated and settled and the
 * sums match the counters. After a confirmed send the campaign must read back live and, when the adapter can verify,
 * every launch read-back must hold; otherwise the job fails permanently with the failures listed (the chain is the
 * authority: a launch that is live but does not verify is an incident, not a retry). */
export function launch({chain,notReadyDelayMs=30000}){
 if(!chain)throw Error('launch needs a chain adapter');
 async function verified(id,sent){
  const after=await chain.readCampaign(id);
  if(Number(after.phase)!==3)return {outcome:'retry',category:'not-live-after-launch',reason:'launch '+(sent?.signature||'')+' reported '+(sent?.status||'confirmed')+' but the campaign reads phase '+after.phase};
  let verify=null;
  if(typeof chain.verifyLaunch==='function'){verify=await chain.verifyLaunch(id);if(!verify?.ok)return {outcome:'failed-permanent',category:'launch-verify-failed',reason:(verify?.failures||['no verdict']).join('; ').slice(0,300),signature:sent?.signature||null,pool:after.pool??null,feeNft:after.feeNft??null};}
  return {outcome:'done',signature:sent?.signature||null,pool:String(after.pool??''),feeNft:String(after.feeNft??''),launchTime:String(after.launchTime??''),slot:after.slot??null,verified:!!verify,checks:verify?stringify(verify.checks):null};
 }
 return {
  reconcile:reconcileWith(chain,'launch'),
  async run(job,ctx){
   const id=ctx.campaign;
   const before=await chain.readCampaign(id);
   if(Number(before.phase)===3)return verified(id,ctx.reconciled?{signature:ctx.reconciled.signature,status:ctx.reconciled.status}:null);
   const r=await chain.assertReady(id);
   if(!r||typeof r.ready!=='boolean')return {outcome:'failed-permanent',category:'bad-readiness',reason:'readiness check returned no verdict'};
   if(r.failed===true)return {outcome:'failed-permanent',category:'campaign-failed',reason:String(r.reason||'campaign failed').slice(0,200)};
   if(!r.ready)return {outcome:'retry',category:'not-ready',reason:String(r.reason||'not ready').slice(0,200),delayMs:notReadyDelayMs};
   const list=await chain.listReceipts(id);
   if(list.complete!==true)return {outcome:'retry',category:'incomplete-enumeration',reason:'receipt enumeration did not complete'+(list.error?': '+list.error:'')};
   if(BigInt(list.receipts.length)!==big(before.receiptCount))return {outcome:'retry',category:'count-mismatch',reason:'enumerated '+list.receipts.length+' receipts, chain counter says '+String(before.receiptCount)};
   const unsettled=list.receipts.filter(x=>!x.settled).length;const acceptedSum=list.receipts.reduce((s,x)=>s+(x.settled?big(x.accepted):0n),0n);
   if(unsettled||BigInt(list.receipts.length)!==big(before.settledCount)||acceptedSum!==big(before.settledAccepted))return {outcome:'retry',category:'reconcile-mismatch',reason:unsettled+' unsettled receipts, settled counter '+String(before.settledCount)+' of '+list.receipts.length+', accepted sum '+acceptedSum+' vs counter '+String(before.settledAccepted)};
   const sent=await ctx.fenced('launch',()=>chain.launch(id,sendOptions(ctx,job,'launch:'+id.campaign)));
   if(sent.status==='unknown')return {outcome:'unknown',category:'unresolved',reconcile:{kind:'launch',...unknownFacts(sent),feeNft:sent.feeNft??null}};
   if(sent.status==='failed')return {outcome:'retry',category:'launch-failed',reason:String(sent.error||'launch failed').slice(0,300),signature:sent.signature||null};
   return verified(id,sent);
  },
 };
}
const stringify=o=>o&&typeof o==='object'?Object.fromEntries(Object.entries(o).map(([k,v])=>[k,typeof v==='bigint'?v.toString():v&&typeof v==='object'&&typeof v.toBase58==='function'?v.toBase58():v])):o;
/** Wraps the existing fee keeper for a LEGACY campaign, only when that campaign is explicitly enabled. The keeper still
 * resolves the process's active campaign itself, so `servedCampaign` (the campaign address the keeper would serve, read
 * from the same manifest the keeper reads) is resolved first and a job for any other campaign is refused BEFORE the
 * keeper ticks: nothing is collected, bought back or burned under the wrong job. An unresolved served campaign is a
 * retry, never a tick. A tick whose result names another campaign is still refused afterwards. A finished cycle
 * enqueues the next period (operation key fee-cycle:<period>). */
export function feeCycle({createTick,servedCampaign,enabledCampaigns=new Set(),intervalMs=300000,now=Date.now}){
 if(typeof createTick!=='function')throw Error('fee-cycle needs createTick');
 if(typeof servedCampaign!=='function')throw Error('fee-cycle needs servedCampaign: the campaign the legacy keeper serves, read before any tick');
 let tick=null;
 return {
  async run(job,ctx){
   const key=ctx.campaign.genesisHash+':'+ctx.campaign.programId+':'+ctx.campaign.campaign;
   if(!(enabledCampaigns.has(key)||enabledCampaigns.has(ctx.campaign.campaign)))return {outcome:'failed-permanent',category:'not-enabled',reason:'fee cycle is not enabled for this campaign'};
   let served;try{served=await servedCampaign();}catch(e){return {outcome:'retry',category:'served-campaign-unresolved',reason:String(e?.message||e).slice(0,200),delayMs:Math.min(intervalMs,15000)};}
   if(typeof served!=='string'||!served)return {outcome:'retry',category:'served-campaign-unresolved',reason:'the fee keeper did not name the campaign it serves',delayMs:Math.min(intervalMs,15000)};
   if(served!==ctx.campaign.campaign)return {outcome:'failed-permanent',category:'campaign-mismatch',reason:'fee keeper serves '+served+' not '+ctx.campaign.campaign+'; nothing was ticked'};
   tick??=createTick();
   const r=await ctx.fenced('fee-tick',()=>tick());
   if(r?.status==='busy')return {outcome:'retry',category:'busy',reason:'fee keeper busy',delayMs:Math.min(intervalMs,15000)};
   if(r?.campaign&&r.campaign!==ctx.campaign.campaign)return {outcome:'failed-permanent',category:'campaign-mismatch',reason:'fee keeper served '+r.campaign+' not '+ctx.campaign.campaign};
   const period=Math.floor(now()/intervalMs)+1;
   await ctx.enqueue({operationKey:'fee-cycle:'+period,jobClass:'fees',payload:job.payload??{},notBefore:new Date(period*intervalMs).toISOString()});
   return {outcome:'done',status:r?.status??null,operation:r?.operation??null,signature:r?.signature??null,nextPeriod:period};
  },
 };
}
