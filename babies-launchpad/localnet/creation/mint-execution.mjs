// Resume only an already approved, fully signed mint packet. No new key, packet,
// blockhash, retry generation or creator signature is ever produced by this worker.
import {VersionedTransaction} from '@solana/web3.js';
import {packetStatus} from '../protocol-v2/durable-send.mjs';
import {verifyMintApproval,mintIntentHash} from './mint-packet.mjs';
import {mintResultAddresses,verifyMintResult} from './mint-result.mjs';
import {encodeBase58} from '../../shared/solana.mjs';
import {creationMode,creationRpc} from './scope.mjs';

export function createMintExecutor({registry,approvals,mintLeases,connection,config,loadIntent,timeoutMs=12000,checkpoint=async()=>{}}){
 if(registry?.driver!=='postgres'||!registry.operatorPackets||typeof loadIntent!=='function'||!approvals?.read||!mintLeases?.markConsumed)throw Error('Mint execution requires the shared approval journal');
 if(!creationMode(config?.mode)||config.programVersion!==3)throw Error('Mint execution is an isolated v3 pilot only');
 const url=new URL(config.rpcUrl);
 if(!creationRpc(url,config.mode)||connection.rpcEndpoint!==config.rpcUrl)throw Error('Mint execution requires the configured loopback RPC');
 if(!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw Error('Bounded mint RPC timeout required');
 const scope={genesisHash:config.genesisHash,programId:config.programId,creator:config.pilotCreator};
 async function bounded(fn){let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Mint RPC timeout')),timeoutMs);})]);}finally{clearTimeout(timer);}}
 async function network(){if(await bounded(()=>connection.getGenesisHash())!==scope.genesisHash)throw Error('Mint execution network changed');}
 return {async resume(requestId,{signal}={}){
  const intent=structuredClone(await loadIntent(requestId));mintIntentHash(intent);
  if(intent.requestId!==requestId||Object.entries(scope).some(([k,v])=>intent[k]!==v))throw Error('Mint execution scope changed');
  let row=await approvals.read(requestId);
  const unknown=reason=>({status:'pending',reason,requestId,signature:row.signature??null,mint:intent.mint});
  // The existing signer journal owns signature validation and immutable binding.
  if(!row.signedBase64)return unknown('awaiting-mint-signature');
  const approval=verifyMintApproval(intent,row.prepared.block,row.prepared.creatorPacket);
  const bytes=Buffer.from(row.signedBase64,'base64'),tx=VersionedTransaction.deserialize(bytes);
  if(bytes.toString('base64')!==row.signedBase64||!Buffer.from(tx.serialize()).equals(bytes)||!Buffer.from(tx.message.serialize()).equals(Buffer.from(approval.message))||encodeBase58(tx.signatures[0])!==row.signature)throw Error('Stored mint packet changed');
  const lease=await registry.mintLeases.get(intent.leaseId);
  if(!lease||!['signed-pending','consumed'].includes(lease.state)||lease.signature!==row.signature)throw Error('Mint execution lease changed');
  try{await network();}catch{return unknown('network-unavailable');}
  if(['failed','expired'].includes(row.status))return {status:'attention',reason:row.status,requestId,signature:row.signature,mint:intent.mint};
  let evidence=row.status==='finalized'?row.result?.mintEvidence:null;
  if(evidence&&(evidence.intentHash!==mintIntentHash(intent)||evidence.version!==1))throw Error('Stored mint evidence changed');
  if(!evidence){
   let state;try{state=await bounded(()=>packetStatus(connection,row.signature,row.prepared.block));}catch{return unknown('confirmation-unavailable');}
   if(state.status==='failed'||state.status==='expired'){
    // Never replace or release a mint here, even after finalized failure/expiry.
    if(row.status==='signed'){
     const latest=await registry.operatorPackets.progress({operationId:row.operationId,attempt:row.attempt,from:'signed',to:state.status,result:state});
     if(latest.status!==state.status)return unknown('journal-reconciliation');
    }
    return {status:'attention',reason:state.status,requestId,signature:row.signature,mint:intent.mint};
   }
   if(state.status!=='confirmed'||!state.finalized){
    if(state.status==='confirmed'||state.observed||signal?.aborted)return unknown(state.status==='confirmed'?'awaiting-finality':'confirmation-pending');
    // A not-yet-visible transaction can only be rebroadcast with its exact bytes.
    // Persist-before-broadcast was already enforced by captureSigned. Do not hold
    // a PostgreSQL transaction while waiting for a provider.
    try{await network();if(signal?.aborted)return unknown('paused');await bounded(async()=>{const signature=await connection.sendRawTransaction(bytes,{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0});if(signature!==row.signature)throw Error('Mint provider returned a different signature');});}
    catch{return unknown('submission-unresolved');}
    await checkpoint('broadcast',row);
    return unknown('submitted');
   }
   try{
    const accounts=await bounded(()=>connection.getMultipleAccountsInfoAndContext(mintResultAddresses(intent),{commitment:'finalized',minContextSlot:state.slot}));
    evidence=verifyMintResult(intent,accounts,{minSlot:state.slot});
    await network();
   }catch(error){
    if(error.code==='MINT_RESULT_MISMATCH')return {status:'attention',reason:'account-mismatch',requestId,signature:row.signature,mint:intent.mint};
    return unknown('finalized-evidence-unavailable');
   }
   if(!['signed','confirmed'].includes(row.status))throw Error('Mint journal has no valid finalization transition');
   row=await registry.operatorPackets.progress({operationId:row.operationId,attempt:row.attempt,from:row.status,to:'finalized',result:{...state,mintEvidence:evidence}});
   if(row.status!=='finalized'||row.result?.mintEvidence?.intentHash!==evidence.intentHash)return unknown('journal-reconciliation');
   await checkpoint('verified',row);
  }
  const consumed=await mintLeases.markConsumed({leaseId:intent.leaseId,signature:row.signature});
  if(consumed.outcome!=='consumed'){
   const winner=await registry.mintLeases.get(intent.leaseId);
   if(winner?.state!=='consumed'||winner.signature!==row.signature)return unknown('lease-reconciliation');
  }
  return {status:'minted',requestId,signature:row.signature,mint:intent.mint,evidence};
 }};
}
