// Private operator action: renew the fee-keeper grant of an activated Standard campaign with exactly the scope its
// activation recorded (same tags, no recipients, the same limits). Deliberately not exposed by any HTTP or creator
// route. It cannot widen authority, touch money, undo a revocation or erase history: the renewal is one more audited
// grant row, and the signer keeps serving only the latest current grant.
import {campaignIdentity} from '../registry/registry.mjs';
const conflict=message=>Object.assign(Error(message),{code:'RENEWAL_CONFLICT'});
const actorPattern=/^[A-Za-z0-9_.:-]{1,128}$/;
export const MIN_RENEWAL_MS=3600000,MAX_RENEWAL_MS=90*86400000;
export async function renewFeeGrant({registry,identity,expectedCapabilityId,expiresAt,actor,now=Date.now}){
 if(registry?.driver!=='postgres')throw Error('Fee grant renewal requires PostgreSQL');
 const scope=campaignIdentity(identity);
 if(!actorPattern.test(actor??'')||typeof expectedCapabilityId!=='string'||!expectedCapabilityId)throw conflict('Operator identity and the current grant id are required');
 const until=Date.parse(expiresAt),at=now();
 if(!Number.isFinite(until)||until<at+MIN_RENEWAL_MS||until>at+MAX_RENEWAL_MS)throw conflict('Renewal must expire between one hour and ninety days from now');
 return registry.transaction(async()=>{
  await registry.query('SELECT campaign FROM campaigns WHERE genesis_hash=? AND program_id=? AND campaign=? FOR UPDATE',[scope.genesisHash,scope.programId,scope.campaign]);
  const campaign=await registry.campaigns.get(scope);if(campaign?.campaignVersion!==3)throw conflict('Renewal applies to version 3 campaigns only');
  const activation=(await registry.query('SELECT active_capability_id FROM standard_fee_activations WHERE genesis_hash=? AND program_id=? AND campaign=?',[scope.genesisHash,scope.programId,scope.campaign])).rows[0];
  if(!activation)throw conflict('Campaign has no recorded fee activation');
  const original=(await registry.query('SELECT kind,program_version,tags_json,recipients_json,limits_json FROM signer_capabilities WHERE capability_id=? AND genesis_hash=? AND program_id=? AND campaign=?',[activation.active_capability_id,scope.genesisHash,scope.programId,scope.campaign])).rows[0];
  if(!original||original.kind!=='keeper'||Number(original.program_version)!==3||JSON.parse(original.recipients_json||'[]').length)throw conflict('Recorded active grant is not a version 3 keeper grant');
  const latest=await registry.capabilities.latest(scope);
  if(!latest||latest.capabilityId!==expectedCapabilityId)throw conflict('Current grant changed; re-read before renewing');
  if(latest.revokedAt)throw conflict('A revoked grant is not renewed');
  const tags=JSON.parse(original.tags_json),limits=JSON.parse(original.limits_json||'{}');
  const grant=await registry.capabilities.grant({...scope,programVersion:3,kind:'keeper',tags,recipients:[],limits,expiresAt:new Date(until).toISOString()});
  return {capabilityId:grant.capabilityId,previousCapabilityId:latest.capabilityId,tags:grant.tags,limits:grant.limits,expiresAt:grant.expiresAt};
 },{lockKey:'fee-grant-renewal:'+scope.campaign});
}
