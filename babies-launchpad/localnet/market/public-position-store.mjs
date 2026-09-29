// Discovery only: a receipt's existence locates a launch; wallet actions must
// still re-read current program state. This never authorizes or prepares money movement.
import {campaignIdentity,isAddress} from '../registry/registry.mjs';
import {canonicalJson} from '../registry/canonical.mjs';
const scope=id=>{campaignIdentity(id);return [id.genesisHash,id.programId,id.campaign];};
export function createPublicPositionStore(registry){
 if(registry?.driver!=='postgres')throw Error('Shared position discovery requires PostgreSQL');const q=(sql,params=[])=>registry.query(sql,params);
 async function snapshot(id){const r=(await q('SELECT * FROM public_position_snapshots WHERE genesis=? AND program_id=? AND campaign=?',scope(id))).rows[0];return r?{revision:Number(r.revision),body:JSON.parse(r.body),updatedAt:Number(r.updated_at)}:{revision:0,body:null,updatedAt:null};}
 async function commit({id,expectedRevision,body,receipts,job,followup}){
  const keys=scope(id);
  if(job.genesisHash!==id.genesisHash||job.programId!==id.programId||job.campaign!==id.campaign||job.jobClass!=='position-index'||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||!Number.isSafeInteger(body.slot)||body.slot<1||!Number.isSafeInteger(body.chainTime)||body.chainTime<1||!Number.isInteger(body.count)||body.count<0||body.count>10000||!/^\d{1,15}$/.test(body.sequence)||!Array.isArray(receipts)&&receipts!==null)throw Error('Invalid position snapshot');
  if(receipts&&(receipts.length!==body.count||new Set(receipts.map(r=>r.owner)).size!==receipts.length||new Set(receipts.map(r=>r.receipt)).size!==receipts.length||receipts.some(r=>!isAddress(r.owner)||!isAddress(r.receipt))))throw Error('Invalid complete position enumeration');
  if(followup?.jobClass!=='position-index'||followup.operationKey!=='positions:'+(BigInt(body.sequence)+1n))throw Error('Invalid position successor');
  return registry.transaction(async()=>{
   const lease=async()=>{if(!(await q("SELECT 1 FROM jobs WHERE job_id=? AND genesis_hash=? AND program_id=? AND campaign=? AND fencing_token=? AND state='leased' AND lease_expires_at>to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FOR UPDATE",[job.jobId,...keys,job.fencingToken])).rows.length)throw Object.assign(Error('Position lease expired'),{code:'STALE_LEASE'});};await lease();
   const prev=await snapshot(id);if(prev.revision!==expectedRevision)throw Object.assign(Error('Position cursor changed'),{code:'POSITION_CURSOR_CONFLICT'});
   if(prev.body&&(body.slot<prev.body.slot||body.chainTime<prev.body.chainTime||body.count<prev.body.count)||receipts===null&&(!prev.body||prev.body.count!==body.count))throw Error('Position snapshot regressed or omitted enumeration');
   if(receipts){
    const known=new Map((await q('SELECT owner,receipt FROM public_wallet_campaigns WHERE genesis=? AND program_id=? AND campaign=?',keys)).rows.map(r=>[r.owner,r.receipt]));
    if(receipts.some(r=>known.has(r.owner)&&known.get(r.owner)!==r.receipt))throw Error('Receipt identity changed');
    const added=receipts.filter(r=>!known.has(r.owner));for(let i=0;i<added.length;i+=250){const batch=added.slice(i,i+250);await q('INSERT INTO public_wallet_campaigns(genesis,program_id,campaign,owner,receipt,source_slot) VALUES '+batch.map(()=>'(?,?,?,?,?,?)').join(',')+' ON CONFLICT(genesis,program_id,campaign,owner) DO NOTHING',batch.flatMap(r=>[...keys,r.owner,r.receipt,body.slot]));}
   }
   const count=Number((await q('SELECT COUNT(*) AS n FROM public_wallet_campaigns WHERE genesis=? AND program_id=? AND campaign=?',keys)).rows[0].n);if(count!==body.count)throw Error('Position enumeration cannot drop known wallets');
   await q("INSERT INTO public_position_snapshots(genesis,program_id,campaign,revision,body,updated_at) VALUES(?,?,?,?,?,CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT)) ON CONFLICT(genesis,program_id,campaign) DO UPDATE SET revision=EXCLUDED.revision,body=EXCLUDED.body,updated_at=EXCLUDED.updated_at",[...keys,expectedRevision+1,canonicalJson(body)]);
   await registry.jobs.enqueue({...followup,...id});await lease();return {revision:expectedRevision+1};
  },{lockKey:'position-index:'+keys.join(':')});
 }
 async function discover({genesisHash,programId,owner,before=null,limit=20}){
  if(!isAddress(genesisHash)||!isAddress(programId)||!isAddress(owner)||!Number.isInteger(limit)||limit<1||limit>20||before!==null&&(!Number.isSafeInteger(before)||before<1))throw Error('Invalid portfolio page');
  // Successful receipts and creator/dev allocations are discoverable even if no
  // request was ever submitted through this website. No RPC per directory coin.
  const rows=(await q(`SELECT c.genesis_hash,c.program_id,c.campaign,c.ordinal FROM campaigns c WHERE c.genesis_hash=? AND c.program_id=? AND c.campaign_version=3 AND c.mode='standard' AND (c.creator=? OR c.dev=? OR EXISTS(SELECT 1 FROM public_wallet_campaigns p WHERE p.genesis=c.genesis_hash AND p.program_id=c.program_id AND p.campaign=c.campaign AND p.owner=?)) AND (?::bigint IS NULL OR c.ordinal<?) ORDER BY c.ordinal DESC LIMIT ?`,[genesisHash,programId,owner,owner,owner,before,before,limit+1])).rows;
  const totals=(await q("SELECT COUNT(*) AS total,COUNT(s.campaign) AS indexed,COUNT(CASE WHEN s.updated_at>CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT)-60000 THEN 1 END) AS fresh FROM campaigns c LEFT JOIN public_position_snapshots s ON s.genesis=c.genesis_hash AND s.program_id=c.program_id AND s.campaign=c.campaign WHERE c.genesis_hash=? AND c.program_id=? AND c.campaign_version=3 AND c.mode='standard'",[genesisHash,programId])).rows[0];
  return {campaignIds:rows.slice(0,limit).map(r=>[r.genesis_hash,r.program_id,r.campaign].join(':')),nextCursor:rows.length>limit?Number(rows[limit-1].ordinal):null,coverage:{campaigns:Number(totals.total),indexed:Number(totals.indexed),fresh:Number(totals.fresh),complete:Number(totals.total)===Number(totals.fresh),includes:'launch-receipts-and-creator-allocations',tokenHoldingsIndexed:false}};
 }
 return {snapshot,commit,discover};
}
