// Explicit v3 opt-in. Keeps settlement and refunds in their independent lanes;
// the existing durable sender owns signing, journal recovery and all broadcasts.
import {PublicKey} from '@solana/web3.js';
import {settleInstruction,refundInstruction,receiptAddress} from '../protocol-v2/client.mjs';
export function withReceiptBatches(chain,{programVersion}){
 if(programVersion!==3||typeof chain?.send!=='function')throw Error('Receipt batching requires an explicit v3 durable adapter');
 const program=new PublicKey(chain.programId),genesis=new PublicKey(chain.genesisHash);
 async function batch(kind,id,receipts,options={}){
  if(!new PublicKey(id.programId).equals(program)||!new PublicKey(id.genesisHash).equals(genesis))throw Error('Receipt batch scope mismatch');
  if(!Array.isArray(receipts)||receipts.length<1||receipts.length>8)throw Error('Receipt batch must contain 1..8 receipts');
  const campaign=new PublicKey(id.campaign),seen=new Set(),builder=kind==='settle'?settleInstruction:refundInstruction;
  const instructions=receipts.map(r=>{
   const owner=new PublicKey(r.owner),address=receiptAddress(program,campaign,owner).toBase58();
   if(r.address!==address||seen.has(address))throw Error('Receipt batch has foreign or duplicate receipts');
   seen.add(address);return builder(program,campaign,owner);
  });
  // Do not combine refund payments with settlement jobs. Each exact ordered
  // instruction set remains one independently journaled, atomic operation.
  return chain.send(instructions,{...options,campaign:campaign.toBase58(),computeUnits:60000*receipts.length,label:kind+'-batch'});
 }
 return {...chain,receiptBatchVersion:3,settleBatch:(id,receipts,options)=>batch('settle',id,receipts,options),refundBatch:(id,receipts,options)=>batch('refund',id,receipts,options)};
}
