// Funding-first (accounting version 2) lifecycle orchestration, next to jobs/lifecycle.mjs (per-receipt records). Scheduling
// never signs or enables deposits; the caller supplies an explicitly reviewed keeper grant with exactly the funding-first
// tags. The controller only schedules, verifies and hands off:
//   funding open      -> the table job (built through the signer while funding is open), wait
//   deadline, failed  -> close (refund-only) -> refunds of every commitment -> collateral return -> stage refunded -> reserve return
//   deadline, funded  -> launch (tag 42 through the table, the custody co-signing) -> wait
//   live              -> excess refunds + exact-once accounting -> collateral return -> liability zero -> fee-setup handoff
// Each lane owns its work (lifecycle: launch, launch-table, close, account, collateral-return, lifecycle-control; recovery:
// refunds, operating-return). Existing per-receipt campaigns are untouched: a record that is not accounting version 2 is refused.
import {canonicalJson,canonicalHash} from '../registry/canonical.mjs';
import {feeActivationPolicy} from './fee-activation.mjs';
import {createOperatingLedger} from '../creation/operating-ledger.mjs';
import {launchFailed,PHASE_LIVE,PHASE_REFUND_ONLY} from '../protocol-v2/policy.mjs';
const same=(a,b)=>['genesisHash','programId','campaign'].every(k=>a?.[k]===b?.[k]);
const wait=(category,delayMs=15000)=>({outcome:'yield',category,delayMs});
const fail=reason=>({outcome:'failed-permanent',category:'lifecycle-refused',reason});
/** The keeper tags a funding-first lifecycle grant carries: launch, refund, close, account, collateral return. */
export const LIFECYCLE_TAGS_V2=Object.freeze([42,44,45,46,47]);
/** A refund-only continuation after a failed round: refunds, close and the collateral return, nothing that launches. */
export const REFUND_TAGS_V2=Object.freeze([44,45,47]);
const tags=canonicalJson(LIFECYCLE_TAGS_V2),refundTags=canonicalJson(REFUND_TAGS_V2);
export function createFundingFirstLifecycle({registry,chain,config}){
 const p=feeActivationPolicy(config);
 if(config.setupHandoff!==true||registry?.driver!=='postgres'||typeof chain?.chainTime!=='function'||typeof chain?.verifyLaunch!=='function'||typeof chain?.readExtension!=='function')throw Error('Funding-first lifecycle requires explicit local v3 setup handoff, chain verification and the extension reader');
 const refundAllowanceSeconds=config.refundAllowanceSeconds??86400;
 if(!Number.isInteger(refundAllowanceSeconds)||refundAllowanceSeconds<60||refundAllowanceSeconds>2592000)throw Error('Lifecycle refund allowance must be 60..2592000 seconds');
 const descriptorHash=canonicalHash({version:2,policy:p.descriptorHash,lifecycleTags:[...LIFECYCLE_TAGS_V2],setupHandoff:true});
 const disabled=async()=>{throw Error('Lifecycle cannot credit or spend funds');};
 const ledger=createOperatingLedger({registry,verifyFunding:disabled,verifyOutcome:disabled});
 const bound=id=>id?.genesisHash===p.genesisHash&&id?.programId===p.programId;
 const rows=id=>registry.query('SELECT * FROM standard_lifecycles WHERE genesis_hash=? AND program_id=? AND campaign=?',[id.genesisHash,id.programId,id.campaign]);
 const network=config.network??'localnet';
 // The registry record must be this network's, Standard, version 3, registered from a funding-first opening (accounting version 2).
 const eligible=async id=>{const c=await registry.campaigns.get(id);return c?.network===network&&c.mode==='standard'&&c.campaignVersion===3&&c.terms?.accountingVersion===2?c:null;};
 const now=async()=>Number((await registry.query('SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) AS ms')).rows[0].ms);
 const grantOf=(cap,id,at,expected)=>cap&&same(cap,id)&&cap.programVersion===3&&cap.kind==='keeper'&&canonicalJson(cap.tags)===expected&&cap.recipients.length===0&&!cap.revokedAt&&Date.parse(cap.expiresAt)>at;
 const initialGrant=(cap,id,at)=>grantOf(cap,id,at,tags),refundGrant=(cap,id,at)=>grantOf(cap,id,at,refundTags);
 const fundingFirst=c=>Number(c.accountingVersion)===2;
 async function schedule(id,capabilityId){
  if(!bound(id)||typeof capabilityId!=='string')throw Error('Explicit lifecycle scope and grant required');
  const c=await chain.readCampaign(id),chainNow=await chain.chainTime();
  if(!fundingFirst(c))throw Error('Funding-first lifecycle needs a funding-first record (accounting version 2)');
  if(c.terms.mode!==0||String(c.terms.treasury)!==p.treasury)throw Error('Lifecycle sealed treasury or mode differs');
  return registry.transaction(async()=>{
   await registry.query('SELECT campaign FROM campaigns WHERE genesis_hash=? AND program_id=? AND campaign=? FOR UPDATE',[id.genesisHash,id.programId,id.campaign]);
   const record=await eligible(id);if(!record||record.termsHash!==c.termsHash)throw Error('Lifecycle registered terms differ');
   const prior=(await rows(id)).rows[0];
   if(prior){if(prior.descriptor_hash!==descriptorHash||prior.initial_capability_id!==capabilityId||prior.terms_hash!==c.termsHash)throw Error('Lifecycle binding changed');return {scheduled:true,duplicate:true};}
   const cap=await registry.capabilities.latest(id),at=await now();
   if(!initialGrant(cap,id,at)||cap.capabilityId!==capabilityId)throw Error('Live explicit funding-first lifecycle grant required');
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
  if(!fundingFirst(c))return fail('Campaign is not a funding-first record');
  if(c.terms.mode!==0||String(c.terms.treasury)!==p.treasury)return fail('Sealed lifecycle treasury or mode differs');
  // A confirmed launch is not sufficient for the handoff: the version-2 verifier checks the finalized custody, the sealed
  // accepted target, the collateral held and the remaining refund liability.
  const verification=Number(c.phase)===PHASE_LIVE?await ctx.fenced('lifecycle-verify-live',()=>chain.verifyLaunch(id)):null;
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
   const stage=async name=>registry.query('UPDATE standard_lifecycles SET stage=?,updated_at=? WHERE genesis_hash=? AND program_id=? AND campaign=?',[name,new Date(at).toISOString(),id.genesisHash,id.programId,id.campaign]);
   if(clock<BigInt(c.deadline)){
    // The table is built while funding is open, so the launch packet is ready the moment the deadline passes.
    const table=await enqueue('launch','launch-table');
    return wait(table.state==='failed'?'table-needs-recovery':'funding-open',Math.min(60000,Number(BigInt(c.deadline)-clock)*1000));
   }
   if(launchFailed(c.phase,c.total,c.soft,c.launchDeadline,clock)){
    // Its own operation key: an earlier close that sealed a funded round (close:sealed, if any) never stands in for the
    // refund-only close after the window passed; the handler verifies the phase the program sets.
    const closed=await enqueue('launch','close:refund-only');
    if(Number(c.phase)!==PHASE_REFUND_ONLY&&closed.state!=='done')return wait(closed.state==='failed'?'close-needs-recovery':'awaiting-close');
    const refunds=await enqueue('refunds','refunds:failure');
    if(refunds.state!=='done'||BigInt(c.refunded)!==BigInt(c.total))return wait(refunds.state==='failed'?'refunds-need-recovery':'awaiting-full-refunds');
    const collateral=await enqueue('settlement','collateral-return');
    if(collateral.state!=='done')return wait(collateral.state==='failed'?'collateral-needs-recovery':'awaiting-collateral-return');
    await stage('refunded');
    // Option 1: the unused operating reserve goes back to the creator once every refund is paid (recovery lane; the signer
    // needs an operating-return capability naming the sealed creator, issued by the operator after this stage).
    await enqueue('operating-return','operating-return');
    return {outcome:'done',category:'refunded',refundedLamports:String(c.refunded),...(continuation?{continuation}:{})};
   }
   if(continuation)return wait('lifecycle-capability-paused');
   if(Number(c.phase)!==PHASE_LIVE){
    const launched=await enqueue('launch','launch');
    return wait(launched.state==='failed'?'launch-needs-recovery':'awaiting-launch');
   }
   // Live: the excess refunds and the exact-once accounting are independent; the collateral returns once every receipt is
   // accounted; the handoff needs every excess refund paid and the collateral returned (the verifier's liability reads zero).
   const refunds=await enqueue('refunds','refunds:excess'),accounted=await enqueue('settlement','account');
   if(refunds.state!=='done'||accounted.state!=='done')return wait(refunds.state==='failed'?'refunds-need-recovery':accounted.state==='failed'?'accounting-needs-recovery':'awaiting-refunds-and-accounting');
   const collateral=await enqueue('settlement','collateral-return');
   if(collateral.state!=='done')return wait(collateral.state==='failed'?'collateral-needs-recovery':'awaiting-collateral-return');
   if(BigInt(verification.checks.liability)!==0n)return wait('awaiting-zero-liability');
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
