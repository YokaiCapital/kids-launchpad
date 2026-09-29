// Isolated v3 Standard orchestration. Scheduling never signs or enables deposits.
// The caller must supply an existing explicitly reviewed lifecycle capability.
// Each lane owns its work; this controller only schedules, verifies and hands off
// to fee setup after ALL excess refunds are delivered. Existing programs untouched.
import {canonicalJson,canonicalHash} from '../registry/canonical.mjs';
import {feeActivationPolicy} from './fee-activation.mjs';
import {createOperatingLedger} from '../creation/operating-ledger.mjs';
import {launchFailed} from '../protocol-v2/policy.mjs';
const same=(a,b)=>['genesisHash','programId','campaign'].every(k=>a?.[k]===b?.[k]);
const wait=(category,delayMs=15000)=>({outcome:'yield',category,delayMs});
const fail=reason=>({outcome:'failed-permanent',category:'lifecycle-refused',reason});
const tags='[3,4,6]',refundTags='[3]';
export function createLifecycleController({registry,chain,config}){
 const p=feeActivationPolicy(config);
 if(config.setupHandoff!==true||registry?.driver!=='postgres'||typeof chain?.chainTime!=='function'||typeof chain?.verifyLaunch!=='function')throw Error('Lifecycle requires explicit local v3 setup handoff and chain verification');
 // Refunds are the one obligation that outlives every other lifecycle step. The initial grant has to cover the sealed
 // launch window plus this allowance; the allowance is operational, not part of the sealed lifecycle descriptor.
 const refundAllowanceSeconds=config.refundAllowanceSeconds??86400;
 if(!Number.isInteger(refundAllowanceSeconds)||refundAllowanceSeconds<60||refundAllowanceSeconds>2592000)throw Error('Lifecycle refund allowance must be 60..2592000 seconds');
 const descriptorHash=canonicalHash({version:1,policy:p.descriptorHash,lifecycleTags:[3,4,6],setupHandoff:true});
 const disabled=async()=>{throw Error('Lifecycle cannot credit or spend funds');};
 const ledger=createOperatingLedger({registry,verifyFunding:disabled,verifyOutcome:disabled});
 const bound=id=>id?.genesisHash===p.genesisHash&&id?.programId===p.programId;
 const rows=id=>registry.query('SELECT * FROM standard_lifecycles WHERE genesis_hash=? AND program_id=? AND campaign=?',[id.genesisHash,id.programId,id.campaign]);
 // The registry record must belong to this scope's network: the rehearsal's localnet or the hosted release's network.
 const network=config.network??'localnet';
 const eligible=async id=>{const c=await registry.campaigns.get(id);return c?.network===network&&c.mode==='standard'&&c.campaignVersion===3?c:null;};
 const now=async()=>Number((await registry.query('SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) AS ms')).rows[0].ms);
 const initialGrant=(cap,id,at)=>cap&&same(cap,id)&&cap.programVersion===3&&cap.kind==='keeper'&&canonicalJson(cap.tags)===tags&&cap.recipients.length===0&&!cap.revokedAt&&Date.parse(cap.expiresAt)>at;
 // A refund-only continuation: tag 3 alone, no recipients, current. It can only deliver refunds after the launch window
 // closed without a launch; it never resumes settlement, launch or fee setup. Nothing here issues it: an operator does.
 const refundGrant=(cap,id,at)=>cap&&same(cap,id)&&cap.programVersion===3&&cap.kind==='keeper'&&canonicalJson(cap.tags)===refundTags&&cap.recipients.length===0&&!cap.revokedAt&&Date.parse(cap.expiresAt)>at;
 async function schedule(id,capabilityId){
  if(!bound(id)||typeof capabilityId!=='string')throw Error('Explicit lifecycle scope and grant required');
  const c=await chain.readCampaign(id),chainNow=await chain.chainTime();
  if(c.terms.mode!==0||String(c.terms.treasury)!==p.treasury)throw Error('Lifecycle sealed treasury or mode differs');
  return registry.transaction(async()=>{
   // Serialize simultaneous enablement requests for the same registry campaign.
   await registry.query('SELECT campaign FROM campaigns WHERE genesis_hash=? AND program_id=? AND campaign=? FOR UPDATE',[id.genesisHash,id.programId,id.campaign]);
   const record=await eligible(id);if(!record||record.termsHash!==c.termsHash)throw Error('Lifecycle registered terms differ');
   const prior=(await rows(id)).rows[0];
   if(prior){if(prior.descriptor_hash!==descriptorHash||prior.initial_capability_id!==capabilityId||prior.terms_hash!==c.termsHash)throw Error('Lifecycle binding changed');return {scheduled:true,duplicate:true};}
   const cap=await registry.capabilities.latest(id),at=await now();
   if(!initialGrant(cap,id,at)||cap.capabilityId!==capabilityId)throw Error('Live explicit lifecycle grant required');
   // Measured from chain time: the grant must still be live when the launch window closes, plus the refund allowance.
   const requiredUntil=at+Math.max(0,Number(BigInt(c.launchDeadline)-BigInt(chainNow)))*1000+refundAllowanceSeconds*1000;
   if(Date.parse(cap.expiresAt)<requiredUntil)throw Error('Lifecycle grant expires before the launch window closes plus the refund allowance');
   const balance=await ledger.balance({...id,payer:p.payer,policy:p.policy});
   if(BigInt(balance.availableLamports)<BigInt(p.minimumReserveLamports))throw Error('Lifecycle operating reserve required');
   await registry.query('INSERT INTO standard_lifecycles(genesis_hash,program_id,campaign,descriptor_hash,initial_capability_id,terms_hash,stage,updated_at) VALUES(?,?,?,?,?,?,?,?)',[id.genesisHash,id.programId,id.campaign,descriptorHash,capabilityId,c.termsHash,'scheduled',new Date(at).toISOString()]);
   await registry.jobs.enqueue({...id,jobClass:'lifecycle-control',operationKey:'lifecycle-control',payload:{descriptorHash}});
   return {scheduled:true,duplicate:false};
  });
 }
 const handler={async run(job,ctx){
  const id=ctx.campaign;
  if(!bound(id)||!same(job,id)||job.jobId!==ctx.jobId||job.jobClass!=='lifecycle-control'||job.operationKey!=='lifecycle-control'||job.payload?.descriptorHash!==descriptorHash)return fail('Lifecycle job or policy differs');
  const c=await ctx.fenced('lifecycle-read',()=>chain.readCampaign(id)),clock=await chain.chainTime();
  if(c.terms.mode!==0||String(c.terms.treasury)!==p.treasury)return fail('Sealed lifecycle treasury or mode differs');
  // A confirmed launch is not sufficient for the handoff. The v3 adapter verifies
  // finalized current custody, including remaining claims and refund liabilities.
  const verification=c.phase===3?await ctx.fenced('lifecycle-verify-live',()=>chain.verifyLaunch(id)):null;
  if(verification&&!verification.ok)return fail('Current live custody did not verify');
  return registry.transaction(async()=>{
   const lease=(await registry.query("SELECT job_id FROM jobs WHERE job_id=? AND fencing_token=? AND lease_owner=? AND state='leased' AND lease_expires_at>to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FOR UPDATE",[ctx.jobId,ctx.token,ctx.owner])).rows[0];
   if(!lease)throw Object.assign(Error('Lifecycle lease expired'),{code:'STALE_LEASE'});
   const record=await eligible(id),flow=(await rows(id)).rows[0];
   if(!record||!flow||record.termsHash!==c.termsHash||flow.terms_hash!==c.termsHash||flow.descriptor_hash!==descriptorHash)return fail('Lifecycle registration changed');
   if(flow.stage==='fee-setup'||flow.stage==='refunded')return {outcome:'done',category:flow.stage,duplicate:true};
   const cap=await registry.capabilities.latest(id),at=await now();
   const initial=initialGrant(cap,id,at)&&cap.capabilityId===flow.initial_capability_id;
   const failedAfterClose=clock>=BigInt(c.deadline)&&launchFailed(c.phase,c.total,c.soft,c.launchDeadline,clock);
   const continuation=!initial&&failedAfterClose&&refundGrant(cap,id,at)?cap.capabilityId:null;
   if(!initial&&!continuation)return wait('lifecycle-capability-paused');
   const enqueue=async(jobClass,operationKey)=>{
    const q=await registry.jobs.enqueue({...id,jobClass,operationKey,payload:{lifecycle:descriptorHash}});
    if(q.job.jobClass!==jobClass||q.job.payload?.lifecycle!==descriptorHash)throw Error('Lifecycle job binding differs');return q.job;
   };
   if(clock<BigInt(c.deadline))return wait('funding-open',Math.min(60000,Number(BigInt(c.deadline)-clock)*1000));
   if(launchFailed(c.phase,c.total,c.soft,c.launchDeadline,clock)){
    const refunds=await enqueue('refunds','refunds:failure');
    if(refunds.state!=='done'||BigInt(c.refunded)!==BigInt(c.total))return wait(refunds.state==='failed'?'refunds-need-recovery':'awaiting-full-refunds');
    await registry.query("UPDATE standard_lifecycles SET stage='refunded',updated_at=? WHERE genesis_hash=? AND program_id=? AND campaign=?",[new Date(at).toISOString(),id.genesisHash,id.programId,id.campaign]);
    // Option 1: the unused operating reserve goes back to the creator once every refund is paid (recovery lane; the signer
    // needs an operating-return capability naming the sealed creator, issued by the operator after this stage).
    await enqueue('operating-return','operating-return');
    return {outcome:'done',category:'refunded',refundedLamports:String(c.refunded),...(continuation?{continuation}:{})};
   }
   if(continuation)return wait('lifecycle-capability-paused');
   if(c.phase!==3){
    const settled=await enqueue('settlement','settlement');
    if(settled.state!=='done'||BigInt(c.settledCount)!==BigInt(c.receiptCount))return wait(settled.state==='failed'?'settlement-needs-recovery':'awaiting-settlement');
    // Launch and excess refunds are independent; campaign escrow reserves them.
    await enqueue('refunds','refunds:excess');
    const launched=await enqueue('launch','launch');
    return wait(launched.state==='failed'?'launch-needs-recovery':'awaiting-launch');
   }
   const refunds=await enqueue('refunds','refunds:excess');
   if(refunds.state!=='done'||BigInt(c.refunded)!==BigInt(c.total)-BigInt(c.settledAccepted)||BigInt(verification.checks.liability)!==0n)return wait(refunds.state==='failed'?'refunds-need-recovery':'awaiting-excess-refunds');
   const balance=await ledger.balance({...id,payer:p.payer,policy:p.policy});
   if(BigInt(balance.availableLamports)<BigInt(p.minimumReserveLamports))return wait('awaiting-operating-funding');
   const recipients=[...new Set([String(c.terms.treasury),String(c.terms.dev)])].sort();
   const setup=await registry.capabilities.grant({...id,programVersion:3,kind:'fee-setup',tags:[20],recipients,limits:cap.limits,expiresAt:cap.expiresAt});
   await enqueue('fee-setup','fee-setup');
   await registry.query("UPDATE standard_lifecycles SET stage='fee-setup',setup_capability_id=?,updated_at=? WHERE genesis_hash=? AND program_id=? AND campaign=?",[setup.capabilityId,new Date(at).toISOString(),id.genesisHash,id.programId,id.campaign]);
   return {outcome:'done',category:'fee-setup',capabilityId:setup.capabilityId,slot:verification.checks.slot};
  });
 }};
 return {schedule,handler,descriptorHash};
}
