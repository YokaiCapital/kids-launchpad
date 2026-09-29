// Owner-only diagnostic projection. No wallet/signer calls, grants or writes.
import {isAddress,parseCampaignId} from '../../localnet/registry/registry.mjs';
import {readPresets} from '../../localnet/registry/presets.mjs';
const amount=value=>{if(typeof value!=='string'||! /^(0|[1-9][0-9]{0,29})$/.test(value))throw Error('Operating amount unavailable');return BigInt(value);};
export function createCreatorOperationsReader({registry,genesisHash,programId,floorLamports=readPresets().agreed?.operating?.floorLamports??'0'}){
 if(registry?.driver!=='postgres'||!isAddress(genesisHash)||!isAddress(programId))throw Error('Scoped shared operations reader required');
 // The sealed operating floor (option 1): below it the reserve is low before any task has to wait for funding.
 const floor=amount(String(floorLamports));
 return {async read(owner,{campaignId}={}){
  const id=typeof campaignId==='string'&&campaignId.length<160?parseCampaignId(campaignId):null;
  if(!isAddress(owner)||!id||id.genesisHash!==genesisHash||id.programId!==programId)throw Error('Launch unavailable');
  const keys=[genesisHash,programId,id.campaign];
  return registry.transaction(async()=>{
   await registry.query("SET LOCAL statement_timeout='3000ms'");
   const campaign=(await registry.query('SELECT creator,campaign_version FROM campaigns WHERE genesis_hash=? AND program_id=? AND campaign=?',keys)).rows[0];
   if(campaign?.creator!==owner||campaign.campaign_version!==3)throw Error('Launch unavailable');
   const observedAt=(await registry.query('SELECT transaction_timestamp()::text at')).rows[0].at;
   const budget=(await registry.query(`SELECT COUNT(*)::int n,
    COALESCE(SUM(b.reserved_lamports::numeric),0)::text funded,
    COALESCE(SUM(b.spent_lamports::numeric),0)::text spent,
    COALESCE(SUM(b.returned_lamports::numeric),0)::text returned,
    COALESCE(SUM(h.held),0)::text held,
    COUNT(*) FILTER(WHERE b.reserved_lamports::numeric<b.spent_lamports::numeric+b.returned_lamports::numeric+h.held)::int invalid
    FROM operational_budgets b LEFT JOIN LATERAL (
     SELECT COALESCE(SUM(maximum_lamports::numeric),0) held FROM operating_spend_holds
     WHERE genesis_hash=b.genesis_hash AND program_id=b.program_id AND campaign=b.campaign AND payer=b.payer AND state='held'
    ) h ON true WHERE b.genesis_hash=? AND b.program_id=? AND b.campaign=?`,keys)).rows[0];
   if(budget.invalid)throw Error('Operating balance needs reconciliation');
   const funded=amount(budget.funded),spent=amount(budget.spent),returned=amount(budget.returned),held=amount(budget.held),available=funded-spent-returned-held;
   // Refills booked from the coin's own fee share are pending until the treasury's owner sends the prepared transfer; they
   // are never counted as available.
   const refill=(await registry.query('SELECT COALESCE(SUM(due_lamports::numeric),0)::text due,COALESCE(SUM(funded_lamports::numeric),0)::text funded FROM operating_refills WHERE genesis_hash=? AND program_id=? AND campaign=?',keys)).rows[0];
   const prepared=(await registry.query("SELECT COALESCE(SUM((e->>'lamports')::numeric),0)::text lamports FROM operating_refill_fundings f, jsonb_array_elements(f.entitlements_json::jsonb) e WHERE f.genesis_hash=? AND f.program_id=? AND f.state='prepared' AND e->>'campaign'=?",keys)).rows[0];
   const refills={pendingLamports:String(amount(refill.due)),awaitingTransferLamports:String(amount(prepared.lamports)),fundedLamports:String(amount(refill.funded))};
   const lowReserve=budget.n>0&&available<floor;
   const jobs=(await registry.query(`SELECT
    COUNT(*) FILTER(WHERE state='queued')::int queued,COUNT(*) FILTER(WHERE state='leased')::int active,
    COUNT(*) FILTER(WHERE state='failed')::int failed,
    COUNT(*) FILTER(WHERE result_json::jsonb->>'outcome'='unknown')::int uncertain,
    COUNT(*) FILTER(WHERE result_json::jsonb->>'category'='awaiting-operating-funding')::int "fundingWait"
    FROM jobs WHERE genesis_hash=? AND program_id=? AND campaign=? AND state IN ('queued','leased','failed')
     AND job_class IN ('launch','settlement','lifecycle-control','refunds','fee-setup','fee-activate','operating-reconcile','fee-harvest','distribution','token-burn')`,keys)).rows[0];
   if(Object.values(jobs).some(n=>!Number.isSafeInteger(n)||n<0))throw Error('Job observation unavailable');
   const life=(await registry.query('SELECT stage FROM standard_lifecycles WHERE genesis_hash=? AND program_id=? AND campaign=?',keys)).rows[0];
   const status=jobs.uncertain?'reconciling':jobs.failed?'needs-attention':jobs.fundingWait?'funding-needed':lowReserve?'funding-low':jobs.active?'working':jobs.queued?'scheduled':!life?'not-scheduled':'idle';
   return {owner,campaignId,observedAt:new Date(observedAt).toISOString(),status,jobs,operating:{recorded:budget.n>0,fundedLamports:String(funded),spentLamports:String(spent),returnedLamports:String(returned),heldLamports:String(held),availableLamports:String(available),floorLamports:String(floor),lowReserve},refills,readOnly:true};
  },{retry:false});
 }};
}
