// Arms one bounded signature generation. Never signs, sends, re-reserves a
// key, changes coin terms, or interprets an RPC timeout as permission to replace.
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {mintIntentHash} from './mint-packet.mjs';
import {mintResultAddresses} from './mint-result.mjs';
import {packetStatus} from '../protocol-v2/durable-send.mjs';
import {creationMode,creationRpc} from './scope.mjs';
const conflict=()=>Object.assign(Error('Mint recovery changed; reload its status'),{code:'IDEMPOTENCY_CONFLICT'});
export function createMintRecovery({registry,connection,config,plans,approvals,timeoutMs=12000}){
 if(registry?.driver!=='postgres'||!plans?.load||!approvals?.validateSigned||!approvals?.pendingRetry)throw Error('Mint recovery requires shared plans and verified approvals');
 const scope=structuredClone(config),url=new URL(scope.rpcUrl);
 if(!creationMode(scope.mode)||scope.programVersion!==3||!creationRpc(url,scope.mode)||connection.rpcEndpoint!==scope.rpcUrl)throw Error('Mint recovery is isolated v3 localnet only');
 if(!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw Error('Bounded recovery deadline required');
 const query=(s,p=[])=>registry.query(s,p);
 return {async recover(owner,{requestId,expectedSignature}){
  if(owner!==scope.pilotCreator||!/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId??'')||!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(expectedSignature??''))throw conflict();
  const deadline=Date.now()+timeoutMs;
  async function rpc(fn){let timer;const ms=deadline-Date.now();if(ms<=0)throw Error('Recovery RPC deadline exceeded');try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Recovery RPC deadline exceeded')),ms);})]);}finally{clearTimeout(timer);}}
  const intent=await plans.load(requestId),hash=mintIntentHash(intent);
  if(intent.creator!==owner||intent.requestId!==requestId||intent.genesisHash!==scope.genesisHash||intent.programId!==scope.programId)throw conflict();
  const row=await approvals.read(requestId),pending=await approvals.pendingRetry(requestId);
  const view=generation=>({requestId,mint:intent.mint,status:'review-required',action:'prepare-mint',generation});
  if(pending&&pending.previousSignature===expectedSignature)return view(pending.generation);
  if(row.signature!==expectedSignature)throw conflict();
  if(['confirmed','finalized'].includes(row.status))return {requestId,status:'pending',action:'resume',reason:'reconcile-existing-mint',signature:row.signature};
  if(row.attempt>=3)return {requestId,status:'attention',action:'support',reason:'mint-retry-limit',signature:row.signature};
  if(!row.signedBase64)return {requestId,status:'pending',action:'resume',reason:'recover-exact-mint-signature',signature:row.signature};
  const verified=await approvals.validateSigned(requestId,row.signedBase64),lease=await registry.mintLeases.get(intent.leaseId);
  const messageHash=createHash('sha256').update(verified.message).digest('hex');
  if(verified.signature!==row.signature||canonicalHash(verified.row)!==canonicalHash(row)||lease?.state!=='signed-pending'||lease.signature!==row.signature||lease.messageDigest!==messageHash){
   // A concurrent recovery of the same packet may have closed it between these reads. That is the idempotent
   // duplicate, not a conflict: return the generation it armed. Anything else stays a conflict.
   const won=await approvals.pendingRetry(requestId);if(won?.previousSignature===expectedSignature)return view(won.generation);
   throw conflict();
  }
  const offers=async()=>(await query('SELECT offer_id,block_json,state FROM creation_mint_offers WHERE request_id=? ORDER BY offer_id',[requestId])).rows;
  const observed=await offers();
  if(await rpc(()=>connection.getGenesisHash())!==scope.genesisHash)throw Error('Recovery ledger changed');
  const state=await rpc(()=>packetStatus(connection,row.signature,row.prepared.block));
  if(!['failed','expired'].includes(state.status))return {requestId,status:'pending',action:'resume',reason:'previous-transaction-unresolved',signature:row.signature};
  const epoch=await rpc(()=>connection.getEpochInfo('finalized'));
  if(!Number.isSafeInteger(epoch?.blockHeight)||epoch.blockHeight<1||!Number.isSafeInteger(epoch.absoluteSlot)||epoch.absoluteSlot<1)throw Error('Finalized recovery height unavailable');
  const blocks=[row.prepared.block,...observed.map(o=>JSON.parse(o.block_json))];
  if(blocks.some(b=>!Number.isSafeInteger(b?.lastValidBlockHeight)||b.lastValidBlockHeight<1))throw conflict();
  if(blocks.some(b=>epoch.blockHeight<=b.lastValidBlockHeight))return {requestId,status:'pending',action:'wait',reason:'waiting-for-finalized-expiry',signature:row.signature};
  // Refuse even externally created or pre-funded conflicting accounts. A mint
  // packet is atomic; successful creation must be reconciled, never recreated.
  const addresses=[...mintResultAddresses(intent),...(intent.version>=2?[]:[new PublicKey(intent.campaign)])];
  const response=await rpc(()=>connection.getMultipleAccountsInfoAndContext(addresses,{commitment:'finalized',minContextSlot:epoch.absoluteSlot}));
  if(!Number.isSafeInteger(response?.context?.slot)||response.context.slot<epoch.absoluteSlot||response.value?.length!==addresses.length)throw Error('Finalized recovery accounts unavailable');
  if(response.value.some(a=>a!==null))return {requestId,status:'attention',action:'resume',reason:'mint-accounts-already-exist',signature:row.signature};
  if(await rpc(()=>connection.getGenesisHash())!==scope.genesisHash)throw Error('Recovery ledger changed');
  return registry.transaction(async()=>{
   const won=await approvals.pendingRetry(requestId);if(won?.previousSignature===expectedSignature)return view(won.generation);
   if(mintIntentHash(await plans.load(requestId))!==hash||canonicalHash(await approvals.read(requestId))!==canonicalHash(row)||canonicalHash(await registry.mintLeases.get(intent.leaseId))!==canonicalHash(lease)||canonicalHash(await offers())!==canonicalHash(observed))throw conflict();
   if(row.status==='signed'){
    const closed=await registry.operatorPackets.progress({operationId:row.operationId,attempt:row.attempt,from:'signed',to:state.status,result:state});if(closed.status!==state.status)throw conflict();
   }else if(row.status!==state.status)throw conflict();
   await query("UPDATE creation_mint_offers SET state='superseded',updated_at=CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) WHERE request_id=? AND state='open'",[requestId]);
   await query('INSERT INTO creation_mint_retries(request_id,generation,owner,intent_hash,operation_id,previous_message_hash,previous_signature,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT))',[requestId,row.attempt,owner,hash,row.operationId,messageHash,row.signature,canonicalJson({version:1,terminal:state,finalizedSlot:response.context.slot,finalizedBlockHeight:epoch.blockHeight,expiredOffers:observed.map(o=>o.offer_id),accountsAbsent:true})]);
   return view(row.attempt);
  },{lockKey:'creator-mint-offer:'+requestId});
 }};
}
