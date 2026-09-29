// Private operator action: deliberately not exposed by any HTTP/creator route.
// Requires database administration access and an exact reviewed failed revision.
// It does not grant signing rights, erase packets, refund expiry or fund a budget.
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {campaignIdentity} from '../registry/registry.mjs';
import {refillJobBinding} from './operating-refill.mjs';
const conflict=()=>Object.assign(Error('Failed job changed or is not eligible for recovery'),{code:'RECOVERY_CONFLICT'});
const id=/^[A-Za-z0-9_.:-]{1,128}$/;
const reasons=new Set(['transient-retry-reviewed','reconciliation-budget-correction','expired-grant-regranted','activity-decoder-fix-reviewed','rpc-context-slot-reviewed','signer-policy-tags-reviewed']);
// The signer's keeper tag set lacked the funding-first bookkeeping tags (44-47) until 29 September 2026: a funding-first job
// that failed permanently on exactly this refusal may be requeued once the deployed signer allows the tag (the current
// keeper grant must cover the funding-first tags; the grant itself is a separate, audited operator action).
const POLICY_TAGS_MESSAGE=/^Signer refused the request \(403\): launch program instruction not allowed$/;
const FUNDING_FIRST_CLASSES=new Set(['launch','settlement','refunds']);
// One transient the classifier did not know before 28 September 2026: a simulation answered behind the requested minimum
// context slot. A job that failed permanently on exactly this message can be requeued once the classifier fix is deployed.
const CONTEXT_SLOT_MESSAGE=/^failed to simulate transaction: Minimum context slot has not been reached$/;
// The one read-model failure a reviewed decoder fix (f0d036a, 28 September 2026) makes recoverable: the activity indexer did not
// know the compact creation (tag 40) and failed permanently with exactly this message. Never a financial job class.
const ACTIVITY_DECODER_MESSAGE='Activity decoder requires supported finalized data';
const transient=new Set(['network','timeout','rate-limited','upstream']);
// A job that failed only because the signer served no grant (expired, revoked or not issued) may be requeued once a
// current keeper grant exists again. The grant itself is a separate, audited operator action; nothing here issues one.
const NO_GRANT=/capability (expired|revoked)|not served by any capability/i;
export async function recoverFailedJob({registry,identity,jobId,expectedToken,expectedResultHash,recoveryId,actor,reason}){
 if(registry?.driver!=='postgres')throw Error('Audited recovery requires PostgreSQL');
 const scope=campaignIdentity(identity);
 if(!id.test(jobId??'')||!id.test(recoveryId??'')||!id.test(actor??'')||!reasons.has(reason)||!Number.isSafeInteger(expectedToken)||expectedToken<1||!/^[a-f0-9]{64}$/.test(expectedResultHash??''))throw conflict();
 return registry.transaction(async()=>{
  const query=(s,p=[])=>registry.query(s,p),previous=(await query('SELECT * FROM job_recoveries WHERE recovery_id=?',[recoveryId])).rows[0];
  if(previous){
   if(previous.job_id!==jobId||Number(previous.prior_token)!==expectedToken||previous.prior_result_hash!==expectedResultHash||previous.actor!==actor||previous.reason!==reason||previous.genesis_hash!==scope.genesisHash||previous.program_id!==scope.programId||previous.campaign!==scope.campaign)throw conflict();
   return {jobId,recoveryId,requeued:false};
  }
  const row=(await query('SELECT * FROM jobs WHERE job_id=? FOR UPDATE',[jobId])).rows[0];
  if(!row||row.state!=='failed'||Number(row.fencing_token)!==expectedToken||row.genesis_hash!==scope.genesisHash||row.program_id!==scope.programId||row.campaign!==scope.campaign)throw conflict();
  const result=JSON.parse(row.result_json||'null');
  if(!result||result.outcome!=='failed-permanent'||canonicalHash(result)!==expectedResultHash)throw conflict();
  if(reason==='expired-grant-regranted'){
   if(result.category!=='auth'||!NO_GRANT.test(String(result.reason||'')))throw conflict();
   const cap=await registry.capabilities.latest(scope);
   if(!cap||cap.kind!=='keeper'||cap.programVersion!==3||cap.revokedAt||Date.parse(cap.expiresAt)<=Date.now())throw conflict();
  }else if(reason==='activity-decoder-fix-reviewed'){
   if(row.job_class!=='activity-index'||result.category!=='unknown'||result.reason!==ACTIVITY_DECODER_MESSAGE)throw conflict();
  }else if(reason==='signer-policy-tags-reviewed'){
   if(!FUNDING_FIRST_CLASSES.has(row.job_class)||result.category!=='auth'||!POLICY_TAGS_MESSAGE.test(String(result.reason||'')))throw conflict();
   const cap=await registry.capabilities.latest(scope);
   if(!cap||cap.kind!=='keeper'||cap.programVersion!==3||cap.revokedAt||Date.parse(cap.expiresAt)<=Date.now()||![44,45,46,47].every(t=>cap.tags.includes(t)))throw conflict();
  }else if(reason==='rpc-context-slot-reviewed'){
   // The historical repair covers the one class it was observed on (the pilot coin's fee-harvest chain); the classifier fix
   // itself applies to every worker from the next deployment on.
   if(row.job_class!=='fee-harvest'||result.category!=='unknown'||!CONTEXT_SLOT_MESSAGE.test(String(result.reason||''))||Number(result.attempts)!==1)throw conflict();
  }else{
   if(result.category!=='retries-exhausted')throw conflict();
   const expiry=result.reason==='Unsigned packet expired; re-read chain before rebuilding'||result.reason==='Previous packet expired; re-read chain before a fresh attempt';
   if(!transient.has(result.lastCategory)&&!(reason==='reconciliation-budget-correction'&&expiry))throw conflict();
  }
  const campaign=await registry.campaigns.get(scope);if(campaign?.campaignVersion!==3)throw conflict();
  // No pending signed packet can be abandoned by the operator. The normal
  // reconciler must first record its terminal chain evidence.
  const pending=(await query("SELECT COUNT(*) n FROM operator_packets WHERE status IN ('signed','confirmed') AND descriptor::jsonb->>'genesisHash'=? AND descriptor::jsonb->>'programId'=? AND descriptor::jsonb->>'campaign'=? AND descriptor::jsonb->>'operationKey'=?",[scope.genesisHash,scope.programId,scope.campaign,row.operation_key])).rows[0];
  if(Number(pending.n)!==0)throw conflict();
  const at=(await query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') at")).rows[0].at;
  if(row.deadline_at&&Date.parse(row.deadline_at)<=Date.parse(at))throw conflict();
  await query('INSERT INTO job_recoveries(recovery_id,job_id,genesis_hash,program_id,campaign,actor,reason,prior_token,prior_result_hash,prior_result_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[recoveryId,jobId,scope.genesisHash,scope.programId,scope.campaign,actor,reason,expectedToken,expectedResultHash,canonicalJson(result),at]);
  const next={outcome:'retry',attempts:Number(result.attempts)||0,retryAttempts:0,category:'operator-recovery',recoveryId};
  const changed=await query("UPDATE jobs SET state='queued',result_json=?,not_before=?,updated_at=?,lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1 WHERE job_id=? AND state='failed' AND fencing_token=?",[canonicalJson(next),at,at,jobId,expectedToken]);
  if(changed.rowCount!==1)throw conflict();
  return {jobId,recoveryId,requeued:true};
 },{lockKey:'job-recovery:'+jobId});
}
/** Audited repair of ONE queued, never-leased operating-refill row that was enqueued without the payer/policy binding the
 * accounting lane selects on (rows seeded before 28 September 2026). The binding is taken from the campaign's verified fee
 * activation, never from the caller; nothing else on the row changes; the audit row records the prior payload. */
export const REFILL_REPAIR_REASON='refill-binding-repaired';
export async function repairRefillBinding({registry,jobId,recoveryId,actor}){
 if(registry?.driver!=='postgres')throw Error('Audited recovery requires PostgreSQL');
 if(!id.test(jobId??'')||!id.test(recoveryId??'')||!id.test(actor??''))throw conflict();
 return registry.transaction(async()=>{
  const query=(s,p=[])=>registry.query(s,p),previous=(await query('SELECT * FROM job_recoveries WHERE recovery_id=?',[recoveryId])).rows[0];
  if(previous){if(previous.job_id!==jobId||previous.actor!==actor||previous.reason!==REFILL_REPAIR_REASON)throw conflict();return {jobId,recoveryId,repaired:false};}
  const row=(await query('SELECT * FROM jobs WHERE job_id=? FOR UPDATE',[jobId])).rows[0];
  if(!row||row.job_class!=='operating-refill'||row.state!=='queued'||Number(row.fencing_token)!==0||row.lease_owner||!/^operating-refill:(0|[1-9][0-9]{0,14})$/.test(row.operation_key||''))throw conflict();
  const payload=JSON.parse(row.payload_json||'null')??{};if(typeof payload!=='object'||Array.isArray(payload)||payload.binding)throw conflict();
  const scope={genesisHash:row.genesis_hash,programId:row.program_id,campaign:row.campaign};
  const campaign=await registry.campaigns.get(scope);if(campaign?.campaignVersion!==3)throw conflict();
  const activation=(await query('SELECT payer,policy FROM standard_fee_activations WHERE genesis_hash=? AND program_id=? AND campaign=?',[scope.genesisHash,scope.programId,scope.campaign])).rows[0];
  if(!activation)throw conflict();
  const binding=refillJobBinding({...scope,payer:activation.payer,policy:activation.policy});
  const at=(await query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') at")).rows[0].at;
  await query('INSERT INTO job_recoveries(recovery_id,job_id,genesis_hash,program_id,campaign,actor,reason,prior_token,prior_result_hash,prior_result_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[recoveryId,jobId,scope.genesisHash,scope.programId,scope.campaign,actor,REFILL_REPAIR_REASON,0,canonicalHash(payload),canonicalJson(payload),at]);
  const changed=await query("UPDATE jobs SET payload_json=?,updated_at=? WHERE job_id=? AND state='queued' AND fencing_token=0 AND lease_owner IS NULL",[canonicalJson({...payload,binding}),at,jobId]);
  if(changed.rowCount!==1)throw conflict();
  return {jobId,recoveryId,repaired:true,binding};
 },{lockKey:'job-recovery:'+jobId});
}
