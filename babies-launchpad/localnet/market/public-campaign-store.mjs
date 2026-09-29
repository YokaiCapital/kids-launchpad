// Shared finalized directory observations. Reads never fan out to Solana RPC.
import {campaignIdentity,CHAIN_STATUSES} from '../registry/registry.mjs';
import {canonicalJson} from '../registry/canonical.mjs';import {providerFreshness} from './freshness.mjs';
const keys=id=>{campaignIdentity(id);return [id.genesisHash,id.programId,id.campaign];};
export function createPublicCampaignStore(registry,{now=Date.now}={}){
 if(registry?.driver!=='postgres')throw Error('Campaign projections require PostgreSQL');const q=(sql,p=[])=>registry.query(sql,p);
 async function snapshot(id){const r=(await q('SELECT * FROM public_campaign_snapshots WHERE genesis=? AND program_id=? AND campaign=?',keys(id))).rows[0];return r?{revision:Number(r.revision),body:JSON.parse(r.body),updatedAt:Number(r.updated_at)}:{revision:0,body:null,updatedAt:null};}
 async function commit({id,job,expectedRevision,body,followup}){
  const k=keys(id),v=body?.view,slot=v?.source?.slot,time=v?.source?.chainTimeUnix;
  if(job.jobClass!=='campaign-index'||keys(job).join(':')!==k.join(':')||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||!/^\d{1,15}$/.test(body.sequence)||!v?.available||!CHAIN_STATUSES.includes(v.phase)||v.source.commitment!=='finalized'||!Number.isSafeInteger(slot)||slot<1||!Number.isSafeInteger(time)||time<1||!/^[a-f0-9]{64}$/.test(body.termsHash)||canonicalJson(body).length>20000||followup?.jobClass!=='campaign-index'||followup.operationKey!=='campaign:'+String(BigInt(body.sequence)+1n))throw Error('Invalid finalized campaign projection');
  return registry.transaction(async()=>{
   const lease=async()=>{if(!(await q("SELECT 1 FROM jobs WHERE job_id=? AND genesis_hash=? AND program_id=? AND campaign=? AND fencing_token=? AND state='leased' AND lease_expires_at>to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FOR UPDATE",[job.jobId,...k,job.fencingToken])).rows.length)throw Object.assign(Error('Campaign projection lease expired'),{code:'STALE_LEASE'});};await lease();
   const prev=await snapshot(id);if(prev.revision!==expectedRevision)throw Object.assign(Error('Campaign projection cursor changed'),{code:'CAMPAIGN_CURSOR_CONFLICT'});
   if(prev.body&&(slot<prev.body.view.source.slot||time<prev.body.view.source.chainTimeUnix||body.termsHash!==prev.body.termsHash))throw Error('Campaign projection regressed');
   const row=await registry.campaigns.get(id);if(!row||row.mode!=='standard'||row.campaignVersion!==3||row.termsHash!==body.termsHash||row.sourceSlot>slot)throw Error('Campaign projection registry mismatch');
   const projected=await registry.campaigns.upsert({...id,mode:'standard',campaignVersion:3,registryStatus:row.registryStatus,termsHash:body.termsHash,sourceSlot:slot,sourceCommitment:'finalized',chainStatus:v.phase,mint:v.terms.mint,pool:v.pool,creator:v.terms.creator,dev:v.terms.dev,treasury:v.terms.treasury});if(projected.conflicts.length)throw Error('Campaign projection sealed fields differ');
   await q("INSERT INTO public_campaign_snapshots(genesis,program_id,campaign,revision,body,updated_at) VALUES(?,?,?,?,?,CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT)) ON CONFLICT(genesis,program_id,campaign) DO UPDATE SET revision=EXCLUDED.revision,body=EXCLUDED.body,updated_at=EXCLUDED.updated_at",[...k,expectedRevision+1,canonicalJson(body)]);
   await registry.jobs.enqueue({...followup,...id});await lease();return {revision:expectedRevision+1};
  },{lockKey:'campaign-view:'+k.join(':')});
 }
 async function read(id){
  const s=await snapshot(id);if(!s.body)return {available:false,reason:'Launch data is being indexed.'};
  const at=now(),v=s.body.view,provider=providerFreshness({slot:v.source.slot,time:v.source.chainTimeUnix},at),age=at-s.updatedAt;
  if(provider.stale||age>45000||age< -5000)return {available:false,reason:'Launch data is stale. Refreshing chain status.',lastUpdatedAt:s.updatedAt};
  return {...v,readAt:new Date(s.updatedAt).toISOString()};
 }
 return {snapshot,commit,read};
}
