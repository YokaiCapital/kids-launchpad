// Job handlers for funding-first campaigns (accounting version 2 records, programs/kids-launch-v3 funding_first.rs): the
// keeper's lookup table during funding, the tag-42 launch through it with the custody co-signing the journaled packet, the
// close (45), refunds (44), exact-once accounting (46) and the collateral return (47). Same contract as handlers.mjs: every
// handler works on the job's own campaign, reports one explicit outcome, and an unknown transaction outcome is reconciled
// from the chain before anything is rebuilt or resent. A per-receipt (version 0) record is refused by every handler here;
// `versioned` dispatches a shared job class to the right handler by the record's accounting version.
//
// Chain adapter contract (protocol-v2/chain-adapter.mjs, all async): readCampaign(id) with accountingVersion, readExtension(id),
// listReceipts(id) with `accounted`, chainTime(), launchTable(id,{plan,...opts}), launchFundingFirst(id,{table,display,coSign,
// ...opts}), closeV2(id,opts), refundV2(id,receipt,opts), accountV2(id,receipt,opts), returnCollateralV2(id,opts), verifyLaunch(id),
// signatureStatus(signature,facts). `plans`: {read(id), allocate(id), markComplete(id,plan)} over jobs/lookup-table-plan.mjs.
import {launchFailed,campaignFailed,launchReadyV2,refundable,PHASE_FUNDING,PHASE_CLOSED,PHASE_LIVE,PHASE_REFUND_ONLY} from '../protocol-v2/policy.mjs';
import {displayHash} from '../protocol-v3/client.mjs';
const big=v=>typeof v==='bigint'?v:BigInt(String(v));
const sortReceipts=list=>[...list].sort((a,b)=>String(a.address).localeCompare(String(b.address)));
const sendOptions=(ctx,job,operationId)=>({operationId,signal:ctx.signal,holds:ctx.holds,fencingToken:ctx.token,operationKey:job.operationKey});
const unknownFacts=sent=>({...(sent.packetRef?{packetRef:sent.packetRef}:{}),signature:sent.signature||null,blockhash:sent.blockhash??null,lastValidBlockHeight:sent.lastValidBlockHeight??null});
function reconcileWith(chain,kind){
 return async function reconcile(job){
  const facts=job.result?.reconcile;if(!facts?.signature)return {status:'failed',note:'no signature recorded'};
  const s=await chain.signatureStatus(facts.signature,facts);
  return {status:s.status,kind,receipt:facts.receipt??null,signature:facts.signature,...(s.error?{error:s.error}:{})};
 };
}
function validateSlice(count,ms){if(!Number.isInteger(count)||count<1||count>64||!Number.isInteger(ms)||ms<1||ms>30000)throw Error('Invalid receipt slice budget');}
async function version2(chain,id){
 const c=await chain.readCampaign(id);
 if(Number(c.accountingVersion)!==2)return {c,refused:{outcome:'failed-permanent',category:'not-funding-first',reason:'campaign '+id.campaign+' is not a funding-first record (accounting version '+String(c.accountingVersion??0)+')'}};
 return {c};
}
const fundingOpen=(c,now)=>big(now)<big(c.deadline);
const openWait=(c,now)=>({outcome:'yield',category:'funding-open',reason:'funding is still open',delayMs:Math.max(1,Math.min(60000,Number(big(c.deadline)-big(now))*1000))});
// Deadline-aware failure: an open round is never failed, whatever its total (a fresh round has 0 committed); after the
// deadline the program's rule decides (under the soft cap, refund-only, or the launch window closed without a launch).
const failedRound=(c,now)=>campaignFailed({phase:c.phase,total:c.total,soft:c.soft,deadline:c.deadline,launchDeadline:c.launchDeadline},now);
const complete=list=>list.complete===true;
/** The keeper's lookup table for the launch: planned durably (one (keeper, slot) per campaign), created and extended through the
 * signer during funding, marked complete once every chunk finalized. A complete plan is done at once; an unknown packet is
 * reconciled and the next run resumes from the journaled packets (never a rebuild); a replaced plan is allocated again. */
export function launchTable({chain,plans}){
 if(!chain||typeof plans?.read!=='function'||typeof plans?.allocate!=='function'||typeof plans?.markComplete!=='function')throw Error('launch-table needs a chain adapter and the table plans');
 return {
  reconcile:reconcileWith(chain,'launch-table'),
  async run(job,ctx){
   const id=ctx.campaign,{c,refused}=await version2(chain,id);if(refused)return refused;
   if(Number(c.phase)===PHASE_LIVE)return {outcome:'done',category:'already-live',table:null};
   // The table is built while funding is open (the normal case: nothing committed yet is not a failure); only a round that
   // failed after its deadline needs no table.
   if(failedRound(c,await chain.chainTime()))return {outcome:'failed-permanent',category:'campaign-failed',reason:'the round failed after its deadline; no launch, no table'};
   let plan=await plans.read(id);
   if(plan?.status==='complete')return {outcome:'done',table:plan.table,recentSlot:plan.recentSlot,alreadyComplete:true};
   if(!plan)plan=await ctx.fenced('plan',()=>plans.allocate(id));
   if(typeof plan?.table!=='string')return {outcome:'retry',category:'plan-unavailable',reason:'no lookup table plan could be allocated',delayMs:5000};
   let sent;
   try{sent=await ctx.fenced('launch-table',()=>chain.launchTable(id,{plan,...sendOptions(ctx,job,'launch-table:'+plan.table)}));}
   catch(e){if(e?.code==='LOOKUP_TABLE_PLAN_REPLACED')return {outcome:'retry',category:'plan-replaced',reason:String(e.message).slice(0,200),delayMs:5000};throw e;}
   if(sent.status==='unknown')return {outcome:'unknown',category:'unresolved',reconcile:{kind:'launch-table',...unknownFacts(sent),table:plan.table,step:sent.step??null}};
   if(sent.status==='failed')return {outcome:'retry',category:'launch-table-failed',reason:String(sent.error||'table packet failed').slice(0,300),table:plan.table};
   await ctx.fenced('plan-complete',()=>plans.markComplete(id,plan));
   return {outcome:'done',table:plan.table,recentSlot:plan.recentSlot,steps:sent.steps??null,signature:sent.signature||null};
  },
 };
}
/** The launch (tag 42 through the planned table): after the sealed deadline on the chain clock, when the program's readiness rule
 * holds (funded to the soft cap, inside the window, not live), with the display committed at the opening and the custody
 * co-signing the journaled packet. A live campaign is verified and done, so a rerun after an unknown outcome never launches twice.
 * `displayFor(id, campaign)` returns {name, symbol, uri} from the registered record; it is checked against the opening
 * commitment (the extension's display hash) before anything is signed. */
export function launchFundingFirst({chain,plans,coSign,displayFor,publication=null,notReadyDelayMs=15000,publicationDelayMs=5000}){
 if(!chain||typeof plans?.read!=='function'||typeof coSign!=='function'||typeof displayFor!=='function')throw Error('launch needs a chain adapter, the table plans, the custody co-signer and the display reader');
 if(publication!==null&&typeof publication!=='function')throw Error('launch needs the publication readiness reader as a function');
 async function verified(id,sent){
  const after=await chain.readCampaign(id);
  if(Number(after.phase)!==PHASE_LIVE)return {outcome:'retry',category:'not-live-after-launch',reason:'launch '+(sent?.signature||'')+' reported '+(sent?.status||'confirmed')+' but the campaign reads phase '+after.phase};
  let verify=null;
  if(typeof chain.verifyLaunch==='function'){verify=await chain.verifyLaunch(id);if(!verify?.ok)return {outcome:'failed-permanent',category:'launch-verify-failed',reason:(verify?.failures||['no verdict']).join('; ').slice(0,300),signature:sent?.signature||null};}
  return {outcome:'done',signature:sent?.signature||null,pool:String(after.pool??''),feeNft:String(after.feeNft??''),launchTime:String(after.launchTime??''),slot:after.slot??null,verified:!!verify};
 }
 return {
  reconcile:reconcileWith(chain,'launch'),
  async run(job,ctx){
   const id=ctx.campaign,{c,refused}=await version2(chain,id);if(refused)return refused;
   if(Number(c.phase)===PHASE_LIVE)return verified(id,ctx.reconciled?{signature:ctx.reconciled.signature,status:ctx.reconciled.status}:null);
   const now=await chain.chainTime();
   if(fundingOpen(c,now))return openWait(c,now);
   if(failedRound(c,now))return {outcome:'failed-permanent',category:'campaign-failed',reason:'the round failed: under the soft cap, refund-only, or the launch window closed'};
   // Waiting is never a failure: readiness and the table are yields (uncounted), so a slow table or a lagging clock cannot
   // exhaust the retry budget and leave a permanently failed launch behind.
   if(!launchReadyV2(c,now))return {outcome:'yield',category:'not-ready',reason:'the readiness rule does not hold yet',delayMs:notReadyDelayMs};
   // The metadata of a creator-flow campaign must be pinned and content-verified before the token is created with its URI:
   // a sealed content id is the final identity, not availability. Waiting is a yield (uncounted) until the program's own
   // launch window closes the round; a verified URI that differs from the sealed terms never launches.
   if(publication){
    const pins=await publication(id);
    if(pins?.tracked&&!pins.ready)return {outcome:'yield',category:pins.attention?'publication-attention':'publication-pending',reason:'metadata pins not confirmed: '+(pins.pending||[]).join(', ')+(pins.attention?' (attention: the provider or the content disagreed with the sealed id; an operator must look)':''),delayMs:publicationDelayMs,publication:{image:pins.image,document:pins.document}};
    if(pins?.tracked&&pins.uri!==String(c.terms?.metadataUri??''))return {outcome:'failed-permanent',category:'publication-mismatch',reason:'the verified metadata URI differs from the sealed terms'};
   }
   const plan=await plans.read(id);
   if(plan?.status!=='complete'){await ctx.enqueue({operationKey:'launch-table',jobClass:'launch',payload:job.payload??{}});return {outcome:'yield',category:'table-not-ready',reason:'the lookup table is not complete yet',delayMs:notReadyDelayMs};}
   const display=await displayFor(id,c),ext=await chain.readExtension(id);
   let committed=null;try{committed=display?displayHash(display):null;}catch{committed=null;}
   if(!committed||committed!==ext.displayHash||display.uri!==String(c.terms?.metadataUri??''))return {outcome:'failed-permanent',category:'display-mismatch',reason:'the registered name, symbol and URI do not hash to the opening commitment'};
   const sent=await ctx.fenced('launch',()=>chain.launchFundingFirst(id,{table:plan.table,display,coSign,...sendOptions(ctx,job,'launch-v2:'+id.campaign)}));
   if(sent.status==='unknown')return {outcome:'unknown',category:'unresolved',reconcile:{kind:'launch',...unknownFacts(sent),feeNft:sent.feeNft??null}};
   if(sent.status==='failed')return {outcome:'retry',category:'launch-failed',reason:String(sent.error||'launch failed').slice(0,300),signature:sent.signature||null};
   return verified(id,sent);
  },
 };
}
/** Close (tag 45): after the deadline a funded round seals its totals (closed) and a failed one turns refund-only; a closed
 * round whose launch window passed without a launch turns refund-only too (the program's own transition). Idempotent: live
 * and refund-only records are done; a closed round that can still launch is done as well. The target phase is verified. */
export function closeFundingFirst({chain}){
 if(!chain)throw Error('close needs a chain adapter');
 return {
  reconcile:reconcileWith(chain,'close'),
  async run(job,ctx){
   const id=ctx.campaign,{c,refused}=await version2(chain,id);if(refused)return refused;
   const phase=Number(c.phase);
   if(phase===PHASE_LIVE||phase===PHASE_REFUND_ONLY)return {outcome:'done',category:'already-closed',phase};
   const now=await chain.chainTime();if(fundingOpen(c,now))return openWait(c,now);
   const target=failedRound(c,now)?PHASE_REFUND_ONLY:PHASE_CLOSED;
   if(phase===target)return {outcome:'done',category:'already-closed',phase};
   const sent=await ctx.fenced('close',()=>chain.closeV2(id,sendOptions(ctx,job,'close-v2:'+id.campaign+':'+target)));
   if(sent.status==='unknown')return {outcome:'unknown',category:'unresolved',reconcile:{kind:'close',...unknownFacts(sent),target}};
   if(sent.status==='failed')return {outcome:'retry',category:'close-failed',reason:String(sent.error||'close failed').slice(0,300)};
   const after=await chain.readCampaign(id);
   if(Number(after.phase)!==target)return {outcome:'retry',category:'not-closed-after-close',reason:'the record reads phase '+after.phase+' after the close, expected '+target};
   return {outcome:'done',phase:Number(after.phase),signature:sent.signature||null};
  },
 };
}
/** Refunds (tag 44): every receipt with a refundable balance (the whole commitment when the round failed, the excess over the
 * accepted amount otherwise), cumulative and idempotent in the program. No settlement condition: version-2 receipts are
 * accounted separately (tag 46). Reconciles the owed sum and the counter before reporting done. */
export function refundsFundingFirst({chain,maxReceipts=16,maxSliceMs=5000}){
 validateSlice(maxReceipts,maxSliceMs);if(!chain)throw Error('refunds need a chain adapter');
 return {
  reconcile:reconcileWith(chain,'refund'),
  async run(job,ctx){
   const id=ctx.campaign,{c,refused}=await version2(chain,id);if(refused)return refused;
   const now=await chain.chainTime();if(fundingOpen(c,now))return openWait(c,now);
   const failed=failedRound(c,now);
   const list=await chain.listReceipts(id);
   if(!complete(list))return {outcome:'retry',category:'incomplete-enumeration',reason:'receipt enumeration did not complete'+(list.error?': '+list.error:'')};
   if(BigInt(list.receipts.length)!==big(c.receiptCount))return {outcome:'retry',category:'count-mismatch',reason:'enumerated '+list.receipts.length+' receipts, chain counter says '+String(c.receiptCount)};
   let refundedNow=0,processed=0,lastReceipt=null;const sliceStart=ctx.now();
   for(const r of sortReceipts(list.receipts).filter(r=>refundable(r.committed,c.total,c.hard,failed)-big(r.refunded)>0n)){
    if(processed>=maxReceipts||(processed>0&&ctx.now()-sliceStart>=maxSliceMs))return {outcome:'yield',category:'receipt-slice',checkpoint:{lastReceipt,processed,refundedNow}};
    const sent=await ctx.fenced('refund:'+r.address,()=>chain.refundV2(id,r,sendOptions(ctx,job,'refund-v2:'+id.campaign+':'+r.address+':'+String(r.refunded))));
    if(sent.status==='unknown')return {outcome:'unknown',category:'unresolved',reconcile:{kind:'refund',receipt:r.address,...unknownFacts(sent),refundedBefore:refundedNow}};
    if(sent.status==='failed')return {outcome:'retry',category:'refund-failed',reason:String(sent.error||'refund failed').slice(0,200),receipt:r.address};
    refundedNow++;processed++;lastReceipt=r.address;
   }
   const after=await chain.readCampaign(id),check=await chain.listReceipts(id);
   if(!complete(check))return {outcome:'retry',category:'incomplete-enumeration',reason:'post-refund enumeration did not complete'};
   let owed=0n;for(const r of check.receipts)owed+=refundable(r.committed,after.total,after.hard,failed)-big(r.refunded);
   const refundedSum=check.receipts.reduce((s,r)=>s+big(r.refunded),0n);
   if(owed!==0n||refundedSum!==big(after.refunded))return {outcome:'retry',category:'reconcile-mismatch',reason:'still owed '+owed+', refunded sum '+refundedSum+' vs counter '+String(after.refunded)};
   return {outcome:'done',refunded:refundedNow,failedCampaign:failed,refundedLamports:String(after.refunded),receiptCount:Number(after.receiptCount),slot:after.slot??null};
  },
 };
}
/** Exact-once accounting (tag 46): once the totals are sealed (closed or live), every receipt's accepted amount is added to the
 * extension's accounted total exactly once. Done when the accounted count equals the sealed receipt count. A send that fails
 * for a receipt the chain now shows accounted (a concurrent or replayed accounting) is not an error. */
export function accountFundingFirst({chain,maxReceipts=16,maxSliceMs=5000}){
 validateSlice(maxReceipts,maxSliceMs);if(!chain)throw Error('accounting needs a chain adapter');
 return {
  reconcile:reconcileWith(chain,'account'),
  async run(job,ctx){
   const id=ctx.campaign,{c,refused}=await version2(chain,id);if(refused)return refused;
   const ext=await chain.readExtension(id);
   if(!ext.sealed||![PHASE_CLOSED,PHASE_LIVE].includes(Number(c.phase)))return {outcome:'retry',category:'not-sealed',reason:'accounting starts once the totals are sealed (closed or live)',delayMs:15000};
   const finished=e=>({outcome:'done',accountedCount:Number(e.accountedCount),sealedReceipts:Number(e.sealedReceipts),accountedAccepted:String(e.accountedAccepted),dust:String(big(e.acceptedTarget)-big(e.accountedAccepted))});
   if(Number(ext.accountedCount)===Number(ext.sealedReceipts))return {...finished(ext),accounted:0};
   const list=await chain.listReceipts(id);
   if(!complete(list))return {outcome:'retry',category:'incomplete-enumeration',reason:'receipt enumeration did not complete'+(list.error?': '+list.error:'')};
   if(list.receipts.length!==Number(ext.sealedReceipts))return {outcome:'retry',category:'count-mismatch',reason:'enumerated '+list.receipts.length+' receipts, sealed count says '+String(ext.sealedReceipts)};
   let accountedNow=0,processed=0,lastReceipt=null;const sliceStart=ctx.now();
   for(const r of sortReceipts(list.receipts).filter(r=>!r.accounted)){
    if(processed>=maxReceipts||(processed>0&&ctx.now()-sliceStart>=maxSliceMs))return {outcome:'yield',category:'receipt-slice',checkpoint:{lastReceipt,processed,accountedNow}};
    const sent=await ctx.fenced('account:'+r.address,()=>chain.accountV2(id,r,sendOptions(ctx,job,'account-v2:'+id.campaign+':'+r.address)));
    if(sent.status==='unknown')return {outcome:'unknown',category:'unresolved',reconcile:{kind:'account',receipt:r.address,...unknownFacts(sent),accountedBefore:accountedNow}};
    if(sent.status==='failed'){
     const again=await chain.listReceipts(id),row=complete(again)?again.receipts.find(x=>x.address===r.address):null;
     if(!row?.accounted)return {outcome:'retry',category:'account-failed',reason:String(sent.error||'accounting failed').slice(0,200),receipt:r.address};
    }else accountedNow++;
    processed++;lastReceipt=r.address;
   }
   const after=await chain.readExtension(id);
   if(Number(after.accountedCount)!==Number(after.sealedReceipts))return {outcome:'retry',category:'reconcile-mismatch',reason:'accounted '+String(after.accountedCount)+' of '+String(after.sealedReceipts)+' receipts'};
   return {...finished(after),accounted:accountedNow};
  },
 };
}
/** Collateral return (tag 47), once: the whole collateral after a failed round (refund-only), or `collateral - dust` once every
 * receipt of a live round is accounted. The program decides the amount and keeps the refund liability; a confirmed send is done. */
export function collateralReturnFundingFirst({chain}){
 if(!chain)throw Error('collateral return needs a chain adapter');
 return {
  reconcile:reconcileWith(chain,'collateral'),
  async run(job,ctx){
   const id=ctx.campaign,{c,refused}=await version2(chain,id);if(refused)return refused;
   const ext=await chain.readExtension(id);
   if(big(ext.collateralReturned)!==0n||ctx.reconciled?.status==='confirmed')return {outcome:'done',returnedLamports:String(ext.collateralReturned),signature:ctx.reconciled?.signature??null};
   const phase=Number(c.phase);
   if(phase===PHASE_LIVE){if(!ext.sealed||Number(ext.accountedCount)!==Number(ext.sealedReceipts))return {outcome:'retry',category:'not-accounted',reason:'every receipt must be accounted before the collateral returns',delayMs:15000};}
   else if(phase!==PHASE_REFUND_ONLY)return {outcome:'retry',category:'not-terminal',reason:'the collateral returns after the round is live and accounted, or refund-only',delayMs:30000};
   const sent=await ctx.fenced('collateral',()=>chain.returnCollateralV2(id,sendOptions(ctx,job,'collateral-v2:'+id.campaign)));
   if(sent.status==='unknown')return {outcome:'unknown',category:'unresolved',reconcile:{kind:'collateral',...unknownFacts(sent)}};
   if(sent.status==='failed')return {outcome:'retry',category:'collateral-failed',reason:String(sent.error||'collateral return failed').slice(0,300)};
   const after=await chain.readExtension(id);
   return {outcome:'done',returnedLamports:String(after.collateralReturned),signature:sent.signature||null};
  },
 };
}
/** Dispatches a shared job class (launch, refunds, lifecycle-control) to the per-receipt (version 0) or the funding-first
 * (version 2) handler by the record's accounting version, read from the chain for the job's own campaign. */
export function versioned({chain,v0,v2}){
 if(typeof chain?.readCampaign!=='function'||typeof v0?.run!=='function'||typeof v2?.run!=='function')throw Error('versioned handler needs a chain adapter and both handlers');
 const pick=async id=>Number((await chain.readCampaign(id)).accountingVersion)===2?v2:v0;
 return {
  async run(job,ctx){return (await pick(ctx.campaign)).run(job,ctx);},
  async reconcile(job,ctx){const h=await pick(ctx?.campaign??{genesisHash:job.genesisHash,programId:job.programId,campaign:job.campaign});if(typeof h.reconcile!=='function')return {status:'failed',note:'handler cannot reconcile'};return h.reconcile(job,ctx);},
 };
}
