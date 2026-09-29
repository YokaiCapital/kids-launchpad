// Read-only chain proof work has its own service/RPC partition. It cannot sign,
// spend, publish or start a launch. Unknown evidence never releases a hold.
import {PublicKey} from '@solana/web3.js';
import {canonicalHash} from '../registry/canonical.mjs';
import {createOperatingSignerBudget} from '../signer/operating-budget.mjs';
export function createOperatingReconciler({registry,connection,genesisHash,programId,payer,policy,treasury=null}){
 const disabled=async()=>{throw Error('Reconciliation cannot fund or review new spending');};
 const budget=createOperatingSignerBudget({registry,connection,genesisHash,programId,payer,policy,treasury,loadFundingPacket:disabled,loadCostIntent:disabled});
 return {reconcile:budget.reconcile};
}
export function operatingReconcileHandler({reconciler,genesisHash,programId,payer,policy,minimumDelayMs=5000,maximumDelayMs=300000}){
 if(typeof reconciler?.reconcile!=='function')throw Error('Operating evidence reconciler required');
 const pinned={genesisHash:new PublicKey(genesisHash).toBase58(),programId:new PublicKey(programId).toBase58(),payer:new PublicKey(payer).toBase58(),policy};
 if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(policy??'')||!Number.isInteger(minimumDelayMs)||minimumDelayMs<1000||!Number.isInteger(maximumDelayMs)||maximumDelayMs<minimumDelayMs||maximumDelayMs>300000)throw Error('Invalid accounting worker policy');
 return {async run(job,ctx){
  const x=job.payload?.binding;
  if(job.jobClass!=='operating-reconcile'||!x||Object.keys(pinned).some(k=>x[k]!==pinned[k])||['genesisHash','programId','campaign'].some(k=>x[k]!==ctx.campaign[k])||job.operationKey!=='operating-reconcile:'+canonicalHash(x))return {outcome:'failed-permanent',category:'operating-scope',reason:'Operating job is outside this worker policy'};
  const previous=Number(job.result?.checks),checks=(Number.isSafeInteger(previous)&&previous>=0?Math.min(previous,1000000):0)+1;
  const delayMs=Math.min(maximumDelayMs,minimumDelayMs*2**Math.min(checks-1,6));
  let result;
  try{result=await ctx.fenced('operating-proof',()=>reconciler.reconcile(x));}
  catch(error){
   if(error?.code==='STALE_LEASE')throw error;
   // Persist a bounded, sanitized state. Missing history, RPC outage or invalid
   // evidence require attention/retry; none establishes that money was unspent.
   return {outcome:'yield',category:error?.code==='CAPACITY_WAIT'?'capacity':'operating-evidence-unavailable',checks,delayMs,heldLamports:x.maximumLamports};
  }
  if(result?.state==='settled')return {outcome:'done',category:'operating-settled',checks,actualLamports:result.actualLamports};
  return {outcome:'yield',category:'operating-awaiting-finality',checks,delayMs,heldLamports:x.maximumLamports};
 }};
}
