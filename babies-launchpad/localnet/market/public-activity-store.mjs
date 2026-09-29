import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {campaignIdentity,isAddress} from '../registry/registry.mjs';
import {validatePublicEvent,hasMovement,ACTIVITY_FILTERS} from '../../shared/public-activity.mjs';
const streamName=/^[A-Za-z0-9_.:-]{1,128}$/;
const key=id=>{campaignIdentity(id);return [id.genesisHash,id.programId,id.campaign];};
const order=e=>String(e.slot).padStart(16,'0')+':'+e.signature+':'+e.instructionPath.split('.').map(n=>n.padStart(4,'0')).join('.');
const stale=()=>Object.assign(Error('Activity lease expired'),{code:'STALE_LEASE'});
export function createPublicActivityStore(registry){
 if(registry?.driver!=='postgres')throw Error('Shared activity requires PostgreSQL');const query=(s,p=[])=>registry.query(s,p);
 async function cursor(id,stream){if(!streamName.test(stream))throw Error('Invalid activity stream');const row=(await query('SELECT * FROM public_activity_cursors WHERE genesis=? AND program_id=? AND campaign=? AND stream=?',[...key(id),stream])).rows[0];return row?{revision:Number(row.revision),body:JSON.parse(row.body),updatedAt:Number(row.updated_at)}:{revision:0,body:null,updatedAt:null};}
 async function commit({identity,stream,expectedRevision,body,events,job,followups=[]}){
  const id={genesisHash:identity.genesisHash,programId:identity.launchProgram,campaign:identity.campaign};key(id);
  if(!isAddress(identity.mint)||identity.programVersion!==3||identity.mode!=='standard'||!Number.isInteger(identity.coinDecimals)||identity.coinDecimals<0||identity.coinDecimals>9||!streamName.test(stream)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||!Array.isArray(events)||events.length>2000||!Array.isArray(followups)||followups.length>2||canonicalJson(body).length>8192)throw Error('Invalid activity page');
  for(const e of events){validatePublicEvent(e);if(e.campaign!==id.campaign)throw Error('Activity campaign mismatch');}
  if(job.genesisHash!==id.genesisHash||job.programId!==id.programId||job.campaign!==id.campaign)throw Error('Activity job identity mismatch');
  return registry.transaction(async()=>{
   const at=Number((await query('SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) AS ms')).rows[0].ms);
   if(!(await query("SELECT 1 FROM jobs WHERE job_id=? AND genesis_hash=? AND program_id=? AND campaign=? AND fencing_token=? AND state='leased' AND lease_expires_at>? FOR UPDATE",[job.jobId,...key(id),job.fencingToken,new Date(at).toISOString()])).rows.length)throw stale();
   const previous=await cursor(id,stream);if(previous.revision!==expectedRevision)throw Object.assign(Error('Activity cursor changed'),{code:'ACTIVITY_CURSOR_CONFLICT'});
   const hash=canonicalHash(identity),known=(await query('SELECT fingerprint FROM public_activity_identities WHERE genesis=? AND program_id=? AND campaign=?',key(id))).rows[0];
   if(known&&known.fingerprint!==hash)throw Error('Activity identity changed');
   if(!known)await query('INSERT INTO public_activity_identities(genesis,program_id,campaign,fingerprint,body) VALUES(?,?,?,?,?)',[...key(id),hash,canonicalJson(identity)]);
   for(const event of events){const fingerprint=canonicalHash(event),insert=await query('INSERT INTO public_activity_events(genesis,program_id,campaign,signature,path,order_key,kind,failed,has_movement,fingerprint,body) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING signature',[...key(id),event.signature,event.instructionPath,order(event),event.kind,event.failed?1:0,hasMovement(event)?1:0,fingerprint,canonicalJson(event)]);
    if(!insert.rowCount&&(await query('SELECT fingerprint FROM public_activity_events WHERE genesis=? AND program_id=? AND campaign=? AND signature=? AND path=?',[...key(id),event.signature,event.instructionPath])).rows[0]?.fingerprint!==fingerprint)throw Error('Finalized activity changed');
   }
   await query('INSERT INTO public_activity_cursors(genesis,program_id,campaign,stream,revision,body,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(genesis,program_id,campaign,stream) DO UPDATE SET revision=EXCLUDED.revision,body=EXCLUDED.body,updated_at=EXCLUDED.updated_at',[...key(id),stream,expectedRevision+1,canonicalJson(body),at]);
   for(const f of followups)await registry.jobs.enqueue({...f,...id});
   if(!(await query("SELECT 1 FROM jobs WHERE job_id=? AND fencing_token=? AND state='leased' AND lease_expires_at>to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",[job.jobId,job.fencingToken])).rows.length)throw stale();
   return {revision:expectedRevision+1};
  },{lockKey:'activity:'+key(id).join(':')});
 }
 async function page(id,{filter='movements',before=null,limit=8}={}){
  if(!ACTIVITY_FILTERS.includes(filter)||!Number.isInteger(limit)||limit<1||limit>50||before!==null&&(typeof before!=='string'||before.length>150||!/^[0-9A-Za-z:.]+$/.test(before)))throw Error('Invalid activity page request');
  const predicate=filter==='movements'?' AND has_movement=1 AND failed=0':filter==='failed'?' AND failed=1':'';
  const rows=(await query('SELECT body,order_key FROM public_activity_events WHERE genesis=? AND program_id=? AND campaign=?'+predicate+' AND (?::text IS NULL OR order_key COLLATE "C"<?) ORDER BY order_key COLLATE "C" DESC LIMIT ?',[...key(id),before,before,limit+1])).rows;
  return {events:rows.slice(0,limit).map(r=>({...JSON.parse(r.body),commitment:'finalized'})),nextCursor:rows.length>limit?rows[limit-1].order_key:null};
 }
 async function status(id){
  const row=(await query('SELECT body FROM public_activity_identities WHERE genesis=? AND program_id=? AND campaign=?',key(id))).rows[0];if(!row)return null;
  const live=await cursor(id,'live'),initial=await cursor(id,'activity-backfill:initial');
  const jobs=(await query("SELECT job_class,state,COUNT(*) AS n FROM jobs WHERE genesis_hash=? AND program_id=? AND campaign=? AND job_class IN ('activity-index','activity-backfill') AND state<>'done' GROUP BY job_class,state",key(id))).rows;
  return {identity:JSON.parse(row.body),updatedAt:live.updatedAt,providerHead:live.body?.providerHead??null,complete:(live.body?.creationVerified===true||initial.body?.creationVerified===true)&&!jobs.some(j=>j.job_class==='activity-backfill'),failed:jobs.some(j=>j.state==='failed'),historyUnavailable:live.body?.historyUnavailable===true||initial.body?.historyUnavailable===true};
 }
 return {cursor,commit,page,status};
}
