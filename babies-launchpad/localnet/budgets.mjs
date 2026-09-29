// Operational cost budget per campaign and payer (plan section 8, operational_budgets). A quote lists every account the
// creator's setup and the keeper's operation will pay rent or fees for, from live-readable constants the caller supplies
// (rent rate, pool creation fee from the AMM config, priority fee) plus a configured margin. Receipts are paid by the
// committing wallet, never by the campaign budget. The ledger binds reserve, spend and return to one (campaign, payer)
// row: a spend that another campaign's reservation would cover is refused with an explicit `insufficient` outcome, so
// no campaign subsidises another without a written platform policy row. Integer lamports throughout.
import {rentLamports,BASE_FEE_LAMPORTS} from './signer-policy.mjs';
import {CAMPAIGN_LEN,RECEIPT_LEN} from './protocol-v2/policy.mjs';
/** Account sizes in bytes. Pool and lock sizes are the Raydium CPMM and lock program layouts pinned in atomic-launch.mjs and
 * active-fee-keeper.mjs (pool state 637, observation state 9016, locked position 256); metadata is the Metaplex v1 size. */
export const ACCOUNT_BYTES=Object.freeze({campaign:CAMPAIGN_LEN,receipt:RECEIPT_LEN,mint:82,metadata:679,tokenAccount:165,cpmmPool:637,cpmmObservation:9016,lpMint:82,lockedPosition:256,feeNftMint:82,feeNftMetadata:679,feeState:160});
export const DEFAULT_MARGIN_BPS=1500;
const big=v=>typeof v==='bigint'?v:BigInt(String(v));
/**
 * live: {ammCreationFeeLamports (AmmConfig.creationFee), priorityFeeLamports (per transaction cap), baseFeeLamports}
 * counts: {ataCreates (token accounts the setup creates), transactions (signed by the creator or keeper), lockedPositions}
 * Returns itemised lines with the payer of each, a subtotal, the margin and the total the creator must fund.
 */
export function quoteCampaignCosts({live,counts={},marginBps=DEFAULT_MARGIN_BPS,rent=rentLamports}={}){
 if(!live||live.ammCreationFeeLamports==null)throw Error('quote needs the live AMM creation fee');
 if(!Number.isInteger(marginBps)||marginBps<0||marginBps>10000)throw Error('marginBps must be 0..10000');
 const priority=big(live.priorityFeeLamports??0n),base=big(live.baseFeeLamports??BASE_FEE_LAMPORTS),creation=big(live.ammCreationFeeLamports);
 if([priority,base,creation].some(n=>n<0n))throw Error('Quote fees must be non-negative');
 const count=(name,fallback)=>{const n=counts[name]??fallback;if(!Number.isSafeInteger(n)||n<0)throw Error('Quote count '+name+' must be a non-negative safe integer');return n;};
 const ata=count('ataCreates',6),tx=count('transactions',8),locks=count('lockedPositions',1),signatures=count('signatures',tx),feeStates=count('feeStates',0);
 if(signatures<tx)throw Error('Quote signatures must cover every transaction');
 const line=(item,lamports,payer,extra={})=>{const n=big(lamports);if(n<0n)throw Error('Quote line must be non-negative');return {item,lamports:n,payer,...extra};};
 const lines=[
  line('campaign account rent',rent(ACCOUNT_BYTES.campaign),'creator',{bytes:ACCOUNT_BYTES.campaign}),
  line('receipt rent (each committing wallet pays its own)',0n,'committer',{bytes:ACCOUNT_BYTES.receipt,perReceiptLamports:rent(ACCOUNT_BYTES.receipt)}),
  line('mint account rent',rent(ACCOUNT_BYTES.mint),'creator',{bytes:ACCOUNT_BYTES.mint}),
  line('metadata account rent',rent(ACCOUNT_BYTES.metadata),'creator',{bytes:ACCOUNT_BYTES.metadata}),
  line('pool creation fee (AMM config)',creation,'creator'),
  line('pool accounts rent (pool, observation, LP mint)',rent(ACCOUNT_BYTES.cpmmPool)+rent(ACCOUNT_BYTES.cpmmObservation)+rent(ACCOUNT_BYTES.lpMint),'creator'),
  line('lock (fee NFT mint, metadata, locked position)',(rent(ACCOUNT_BYTES.feeNftMint)+rent(ACCOUNT_BYTES.feeNftMetadata)+rent(ACCOUNT_BYTES.lockedPosition))*BigInt(locks),'creator',{count:locks}),
  line('associated token accounts',rent(ACCOUNT_BYTES.tokenAccount)*BigInt(ata),'creator',{count:ata}),
  line('fee state accounts',rent(ACCOUNT_BYTES.feeState)*BigInt(feeStates),'creator',{count:feeStates}),
  line('transaction fees (base + priority cap)',base*BigInt(signatures)+priority*BigInt(tx),'creator',{count:tx,signatures}),
 ];
 const subtotal=lines.reduce((s,l)=>s+l.lamports,0n);
 const margin=(subtotal*BigInt(marginBps)+9999n)/10000n;
 return {lines,subtotalLamports:subtotal,marginBps,marginLamports:margin,totalLamports:subtotal+margin,committerPerReceiptLamports:rent(ACCOUNT_BYTES.receipt)};
}
/** Idempotent operational accounting, not a transfer executor. A stable operationKey
 * identifies a verified credit, spend reservation or return. A replay returns its
 * original result, including a refusal; a new decision needs a new operation key. */
export function createBudgetLedger({registry}){
 if(!registry?.budgets?.apply)throw Error('Budget ledger needs an accounting registry');
 const apply=async(action,{identity,payer,lamports,operationKey,policy='creator-funded-v1'})=>registry.budgets.apply({...identity,payer,action,lamports,operationKey,policy});
 return {
  reserve:input=>apply('reserve',input),
  spend:input=>apply('spend',input),
  return:input=>apply('return',input),
  async get({identity,payer}){
   const read=async()=>{
    const row=await registry.budgets.get({...identity,payer});if(!row)return null;
    const held=registry.driver==='postgres'?BigInt((await registry.query("SELECT COALESCE(SUM(CAST(maximum_lamports AS NUMERIC)),0) held FROM operating_spend_holds WHERE genesis_hash=? AND program_id=? AND campaign=? AND payer=? AND state='held'",[identity.genesisHash,identity.programId,identity.campaign,payer])).rows[0].held):0n;
    const available=big(row.reservedLamports)-big(row.spentLamports)-big(row.returnedLamports)-held;if(available<0n)throw Error('Budget exposure exceeds funds');
    return {reservedLamports:row.reservedLamports,spentLamports:row.spentLamports,returnedLamports:row.returnedLamports,availableLamports:String(available),...(held?{heldLamports:String(held)}:{}),policy:row.policy};
   };
   return registry.driver==='postgres'?registry.transaction(read,{lockKey:'budget:'+ [identity.genesisHash,identity.programId,identity.campaign,payer].join(':')}):read();
  },
 };
}
