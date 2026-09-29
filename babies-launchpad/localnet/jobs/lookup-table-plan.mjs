// Durable allocation of a campaign's lookup table before its first signature. A lookup table's address derives from
// (authority, creation slot) only: two campaigns prepared by the same keeper in the same slot would choose the SAME table
// while their exact contents differ. So one (payer, slot) is reserved per campaign in the registry, unique across the
// keeper's campaigns, and every retry reuses it. The creation slot must be one the runtime still knows: it is taken from
// the SlotHashes sysvar at finalized commitment (a skipped slot is not in it and the lookup-table program refuses it),
// newest first. A plan whose table was never created is replaced only when its slot has left SlotHashes, no journaled
// creation attempt is unresolved (prepared, signed, confirmed or finalized) and the ledger holds no account at its
// address; a plan is never replaced once its table exists. Status advances by one atomic conditional update bound to the
// plan's table and slot, so a delayed result can neither regress a status nor mark a replacement plan. Allocations for one
// keeper are serialized (advisory lock), and the unresolved-attempt check is repeated under that lock before a replacement.
// A never-created plan is stale only once its creation slot is no longer in the SlotHashes sysvar (512 produced entries,
// however many numbered slots they span): the lookup-table program then refuses that slot, so no creation packet built for
// the plan can still land (a blockhash lives far shorter than the SlotHashes window).
import {PublicKey,AddressLookupTableProgram,SYSVAR_SLOT_HASHES_PUBKEY} from '@solana/web3.js';
import {canonicalHash} from '../registry/canonical.mjs';
export const SLOT_SEARCH=150,MAX_TABLE_PACKETS=13;
const RANK={planned:0,created:1,complete:2};
const decode=r=>r?{genesisHash:r.genesis_hash,programId:r.program_id,campaign:r.campaign,payer:r.payer,table:r.table_address,recentSlot:Number(r.recent_slot),status:r.status}:null;
const key=v=>new PublicKey(v).toBase58();
/** The slots the runtime still accepts as a lookup table's creation slot, newest first (SlotHashes at finalized commitment). */
export async function recentSlots(connection){
 const info=await connection.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY,'finalized');if(!info?.data)throw Error('SlotHashes sysvar unavailable');
 const d=Buffer.from(info.data);if(d.length<8)throw Error('SlotHashes sysvar malformed');
 const n=Number(d.readBigUInt64LE(0)),slots=[];
 for(let i=0;i<n;i++){const at=8+i*40;if(at+40>d.length)throw Error('SlotHashes sysvar malformed');slots.push(Number(d.readBigUInt64LE(at)));}
 return slots;
}
/** The durable packet ids the adapter uses for the plan's table packets (protocol-v2/chain-adapter.mjs launchTable). */
export const tablePacketOperation=(identity,table,n)=>canonicalHash({genesisHash:key(identity.genesisHash),programId:key(identity.programId),campaign:key(identity.campaign),operationId:'launch-table:'+table+':'+n});
export async function readLookupTablePlan({registry,identity}){
 const {genesisHash,programId,campaign}=identity;
 return decode((await registry.query('SELECT * FROM lookup_table_plans WHERE genesis_hash=? AND program_id=? AND campaign=?',[key(genesisHash),key(programId),key(campaign)])).rows[0]);
}
/** True when some journaled packet of the plan's table is not terminal (prepared, signed, confirmed, finalized). */
export async function unresolvedTablePackets({registry,identity,table}){
 if(!registry.operatorPackets||typeof registry.operatorPackets.latest!=='function')throw Error('Operator packet journal required');
 for(let n=1;n<=MAX_TABLE_PACKETS;n++){const row=await registry.operatorPackets.latest(tablePacketOperation(identity,table,n));if(!row)break;if(!['expired','failed'].includes(row.status))return true;}
 return false;
}
export async function allocateLookupTablePlan({registry,connection,identity,payer,now=Date.now}){
 if(registry?.driver!=='postgres'||typeof registry.transaction!=='function')throw Error('Lookup table plans need the PostgreSQL registry');
 const genesisHash=key(identity.genesisHash),programId=key(identity.programId),campaign=key(identity.campaign),owner=key(payer),authority=new PublicKey(owner);
 const slotNow=await connection.getSlot('finalized');if(!Number.isSafeInteger(slotNow)||slotNow<1)throw Error('Finalized slot unavailable');
 const knownList=(await recentSlots(connection)).filter(s=>s<=slotNow);if(!knownList.length)throw Error('No finalized creation slot available');
 const known=new Set(knownList),oldest=Math.min(...knownList);
 const existing=await readLookupTablePlan({registry,identity});
 if(existing){
  if(existing.payer!==owner)throw Error('Lookup table plan belongs to another payer');
  if(existing.status!=='planned'||known.has(existing.recentSlot))return existing;
  // Stale and never marked created: an unresolved journaled attempt keeps the plan (the worker reconciles it first); a table
  // on the ledger makes the plan permanent; only a plan with no live attempt and no account is replaced.
  if(await unresolvedTablePackets({registry,identity,table:existing.table}))return existing;
  const live=await connection.getAccountInfo(new PublicKey(existing.table),'finalized');
  if(live)return markLookupTablePlan({registry,identity,plan:existing,status:'created',now});
 }
 return registry.transaction(async()=>{
  const current=await readLookupTablePlan({registry,identity});
  if(current&&(current.status!=='planned'||known.has(current.recentSlot)))return current;
  // Repeated under the lock: an attempt journaled since the first check keeps the plan.
  if(current&&await unresolvedTablePackets({registry,identity,table:current.table}))return current;
  if(current)await registry.query('DELETE FROM lookup_table_plans WHERE genesis_hash=? AND program_id=? AND campaign=? AND status=? AND table_address=? AND recent_slot=?',[genesisHash,programId,campaign,'planned',current.table,current.recentSlot]);
  const used=new Set((await registry.query('SELECT recent_slot FROM lookup_table_plans WHERE genesis_hash=? AND program_id=? AND payer=? AND recent_slot>=?',[genesisHash,programId,owner,oldest])).rows.map(r=>Number(r.recent_slot)));
  const slot=knownList.slice(0,SLOT_SEARCH).find(s=>!used.has(s));
  if(slot===undefined)throw Object.assign(Error('No unused creation slot for a lookup table right now; retry later'),{code:'LOOKUP_TABLE_SLOT_BUSY'});
  const [,table]=AddressLookupTableProgram.createLookupTable({authority,payer:authority,recentSlot:slot}),at=new Date(now()).toISOString();
  await registry.query('INSERT INTO lookup_table_plans(genesis_hash,program_id,campaign,payer,table_address,recent_slot,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',[genesisHash,programId,campaign,owner,table.toBase58(),slot,'planned',at,at]);
  return readLookupTablePlan({registry,identity});
 },{lockKey:'lookup-table-plan:'+genesisHash+':'+programId+':'+owner});
}
/** One atomic conditional update: the plan named by (table, slot) advances to `status` only from a lower status. A delayed
 * or repeated result never regresses the status and never touches a replacement plan. Returns the current row. */
export async function markLookupTablePlan({registry,identity,plan,status,now=Date.now}){
 if(!(status in RANK))throw Error('Invalid lookup table plan status');
 if(!plan||typeof plan.table!=='string'||!Number.isSafeInteger(plan.recentSlot))throw Error('Lookup table plan (table and slot) required');
 const {genesisHash,programId,campaign}=identity;
 await registry.query("UPDATE lookup_table_plans SET status=?,updated_at=? WHERE genesis_hash=? AND program_id=? AND campaign=? AND table_address=? AND recent_slot=? AND (CASE status WHEN 'planned' THEN 0 WHEN 'created' THEN 1 ELSE 2 END)<?",[status,new Date(now()).toISOString(),key(genesisHash),key(programId),key(campaign),plan.table,plan.recentSlot,RANK[status]]);
 const current=await readLookupTablePlan({registry,identity});if(!current)throw Error('Lookup table plan missing');
 return current;
}
