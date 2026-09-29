// Returns a terminally refunded campaign's unused operating reserve to its sealed creator (option 1, owner decision of
// 27 September 2026). One keeper-signed transfer, bounded by the campaign's own budget through the signer's hold; the
// signer's cost reader independently checks the campaign state and the creator; the accounting lane proves the
// finalized balances and records the return. Participant escrow is never touched here.
import {createOperatingLedger} from '../creation/operating-ledger.mjs';
import {operatingReturnInstructions} from '../creation/operating-costs.mjs';
import {campaignFailed} from '../protocol-v2/policy.mjs';
const big=v=>typeof v==='bigint'?v:BigInt(String(v));
export const OPERATING_RETURN_CLASS='operating-return';
/** The memo program alone needs tens of thousands of compute units; the limit is part of the operation identity so a
 * changed template never collides with an older packet of the same amount. */
export const OPERATING_RETURN_COMPUTE_UNITS=60000;
export function operatingReturnHandler({chain,registry,policy='creator-funded-v1',feeReserveLamports=5000n,delayMs=30000}){
 if(typeof chain?.send!=='function'||typeof chain?.readCampaign!=='function'||typeof chain?.chainTime!=='function'||typeof chain?.signatureStatus!=='function'||!chain.keeper)throw Error('operating-return needs the keeper chain adapter');
 if(registry?.driver!=='postgres')throw Error('operating-return needs the shared registry');
 if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(policy)||typeof feeReserveLamports!=='bigint'||feeReserveLamports<0n||!Number.isInteger(delayMs)||delayMs<1000)throw Error('Invalid operating return policy');
 const disabled=async()=>{throw Error('Operating return never credits or reconciles by itself');};
 // The read-only ledger view opens on first use, so a worker can be composed before the shared accounting is reachable.
 let ledger=null;const view=()=>ledger??=createOperatingLedger({registry,verifyFunding:disabled,verifyOutcome:disabled});const payer=String(chain.keeper);
 return {
  async reconcile(job){
   const f=job.result?.reconcile;if(!f?.signature)return {status:'failed',note:'no signature recorded'};
   const s=await chain.signatureStatus(f.signature,f);return {status:s.status,kind:OPERATING_RETURN_CLASS,signature:f.signature,...(s.error?{error:s.error}:{})};
  },
  async run(job,ctx){
   const id=ctx.campaign,wait=(category,reason)=>({outcome:'yield',category,reason,delayMs});
   if(job.jobClass!==OPERATING_RETURN_CLASS)return {outcome:'failed-permanent',category:'operating-return-scope',reason:'Not an operating return job'};
   const flow=(await registry.query('SELECT stage FROM standard_lifecycles WHERE genesis_hash=? AND program_id=? AND campaign=?',[id.genesisHash,id.programId,id.campaign])).rows[0];
   if(flow?.stage!=='refunded')return wait('awaiting-refunded-stage','Lifecycle has not recorded full refunds');
   // The recipient is the creator sealed on chain, never a registry field; the signer's cost reader checks the same bytes.
   const c=await chain.readCampaign(id),now=await chain.chainTime(),creator=c.terms?.creator==null?null:String(c.terms.creator);
   if(!creator)return {outcome:'failed-permanent',category:'operating-return-scope',reason:'Sealed creator unavailable from the chain read'};
   const record={creator};
   if(!campaignFailed(c,now)||big(c.refunded)!==big(c.total))return wait('awaiting-full-refunds','Chain does not show a fully refunded failed campaign');
   const b=await view().balance({...id,payer,policy});
   if(big(b.heldLamports)>0n)return wait('awaiting-operating-holds','Open operating holds must settle first');
   // The signer only returns under an explicit operating-return grant naming the sealed creator; until the operator issues
   // it the job waits instead of failing, and the reserve stays in the budget.
   const cap=await registry.capabilities.latest(id),live=cap&&!cap.revokedAt&&Date.parse(cap.expiresAt)>Date.now();
   if(!live||cap.kind!=='operating-return'||cap.programVersion!==3||JSON.stringify(cap.recipients)!==JSON.stringify([record.creator]))return wait('awaiting-return-capability','No live operating-return capability names the sealed creator');
   const lamports=big(b.availableLamports)-feeReserveLamports;
   if(lamports<=0n)return {outcome:'done',category:'nothing-to-return',availableLamports:b.availableLamports,creator:record.creator};
   const amount=String(lamports),intent={action:OPERATING_RETURN_CLASS,creator:record.creator,lamports:amount};
   const sent=await ctx.fenced(OPERATING_RETURN_CLASS,()=>chain.send(()=>({instructions:operatingReturnInstructions({...id,payer},{creator:record.creator,lamports:amount}),facts:{kind:OPERATING_RETURN_CLASS,creator:record.creator,lamports:amount},extraSigners:[]}),
    {operationId:OPERATING_RETURN_CLASS+':'+id.campaign+':'+amount+':cu'+OPERATING_RETURN_COMPUTE_UNITS,operationKey:job.operationKey,fencingToken:ctx.token,signal:ctx.signal,holds:ctx.holds,campaign:id.campaign,computeUnits:OPERATING_RETURN_COMPUTE_UNITS,label:OPERATING_RETURN_CLASS,intent}));
   if(sent.status==='unknown')return {outcome:'unknown',category:'unresolved',reconcile:{kind:OPERATING_RETURN_CLASS,...(sent.packetRef?{packetRef:sent.packetRef}:{}),signature:sent.signature||null,blockhash:sent.blockhash??null,lastValidBlockHeight:sent.lastValidBlockHeight??null}};
   if(sent.status==='failed')return {outcome:'retry',category:'operating-return-failed',reason:String(sent.error||'return failed').slice(0,200)};
   if(sent.status!=='confirmed')throw Error('Invalid operating return result');
   return {outcome:'done',category:'operating-returned',returnedLamports:amount,creator:record.creator,signature:sent.signature??null};
  },
 };
}
