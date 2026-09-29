// Read-only signer boundary for the new worker path. Match the exact ledger,
// program, campaign, current grant and current job token; never scan a first page
// of jobs or treat a historical high-water mark as proof of a live lease.
import {isAddress} from './registry.mjs';
import {databaseIso} from './postgres-job-clock.mjs';
const key=/^[A-Za-z0-9_.:-]{1,128}$/;
const sql=`SELECT j.lease_expires_at,c.expires_at
 FROM jobs j JOIN signer_capabilities c
 ON c.genesis_hash=j.genesis_hash AND c.program_id=j.program_id AND c.campaign=j.campaign
 WHERE c.capability_id=? AND c.genesis_hash=? AND c.program_id=? AND c.campaign=?
 AND (c.program_version=1 OR EXISTS (SELECT 1 FROM campaigns issuer
  WHERE issuer.genesis_hash=c.genesis_hash AND issuer.program_id=c.program_id
  AND issuer.campaign=c.campaign AND issuer.campaign_version=c.program_version))
 AND c.program_version=? AND c.revoked_at IS NULL AND c.expires_at>?
 AND j.operation_key=? AND j.fencing_token=? AND j.state='leased' AND j.lease_expires_at>?
 AND NOT EXISTS (SELECT 1 FROM signer_capabilities newer
  WHERE newer.genesis_hash=c.genesis_hash AND newer.program_id=c.program_id AND newer.campaign=c.campaign
  AND (newer.created_at>c.created_at OR (newer.created_at=c.created_at AND newer.capability_id>c.capability_id)))`;
export function leaseAuthorityApi(driver,{async=false,now=Date.now}={}){
 function params({capability:c,operationKey,fencingToken},at){
  if(!c||!isAddress(c.genesisHash)||!isAddress(c.programId)||!isAddress(c.campaign)||typeof c.capabilityId!=='string'||!key.test(c.capabilityId)||!Number.isInteger(c.programVersion)||!key.test(operationKey||'')||!Number.isSafeInteger(fencingToken)||fencingToken<1)throw Error('Exact registry capability and job binding required');
  return [c.capabilityId,c.genesisHash,c.programId,c.campaign,c.programVersion,new Date(at).toISOString(),operationKey,fencingToken,new Date(at).toISOString()];
 }
 function verdict(row,at){return row?{allowed:true,validForMs:Math.max(0,Math.min(Date.parse(row.lease_expires_at),Date.parse(row.expires_at))-at)}:{allowed:false,validForMs:0};}
 if(async)return async input=>{
  // Read the grant, job and database time in one statement. A separate time
  // query could age while waiting for a pooled connection. Subtract the full
  // monotonic round trip conservatively so response delays never extend rights.
  const started=performance.now(),values=params(input,0).filter((_,i)=>i!==5&&i!==8);
  const query=sql.replace('SELECT j.lease_expires_at',
   'SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) AS db_now_ms,j.lease_expires_at')
   .replace('c.expires_at>?','c.expires_at>'+databaseIso)
   .replace('j.lease_expires_at>?','j.lease_expires_at>'+databaseIso);
  const row=await driver.get(query,values);
  if(!row)return {allowed:false,validForMs:0};
  const at=Number(row.db_now_ms);
  if(!Number.isSafeInteger(at))throw Error('Database lease time unavailable');
  const result=verdict(row,at+Math.ceil(performance.now()-started));
  return result.validForMs>0?result:{allowed:false,validForMs:0};
 };
 return input=>{const at=now();return verdict(driver.get(sql,params(input,at)),at);};
}
