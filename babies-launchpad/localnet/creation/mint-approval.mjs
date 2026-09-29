// Private v3/localnet creator approval journal. Reuses the shared packet outbox
// and inventory authorizer interface. No endpoint is enabled by this module.
// loadIntent MUST read the immutable server-owned plan, never request instructions.
// The block argument to record is the server's saved wallet offer, not browser data.
import {createHash} from 'node:crypto';
import {PublicKey,VersionedTransaction} from '@solana/web3.js';
import {mintIntentHash,verifyMintApproval,mintPacketSigners} from './mint-packet.mjs';
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {verifySignature,encodeBase58} from '../../shared/solana.mjs';
import {creationMode,creationRpc} from './scope.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
const conflict=()=>Object.assign(Error('Mint approval differs from durable preparation'),{code:'IDEMPOTENCY_CONFLICT'});

export function createMintApprovalJournal({registry,mintLeases,connection,config,loadIntent,timeoutMs=12000}) {
 if(registry?.driver!=='postgres'||!registry.operatorPackets||typeof loadIntent!=='function')throw Error('Mint approval requires PostgreSQL and a trusted plan reader');
 if(!creationMode(config?.mode)||config.programVersion!==3)throw Error('Mint approval is an isolated v3 pilot only');
 if(!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw Error('Bounded mint RPC timeout required');
 async function bounded(fn){let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Mint approval RPC timeout')),timeoutMs);})]);}finally{clearTimeout(timer);}}
 const u=new URL(config.rpcUrl);
 if(!creationRpc(u,config.mode)||connection.rpcEndpoint!==config.rpcUrl)throw Error('Mint approval requires the configured loopback RPC');
 const genesisHash=new PublicKey(config.genesisHash).toBase58(),programId=new PublicKey(config.programId).toBase58(),creator=new PublicKey(config.pilotCreator).toBase58(),journal=registry.operatorPackets;
 const operation=id=>{
  if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(id||''))throw Error('Invalid mint request');
  return canonicalHash({kind:'creator-mint-v3',genesisHash,programId,creator,requestId:id});
 };
 async function trusted(requestId){
  const intent=structuredClone(await loadIntent(requestId));mintIntentHash(intent);
  if(intent.requestId!==requestId||intent.creator!==creator||intent.genesisHash!==genesisHash||intent.programId!==programId)throw conflict();
  const lease=await registry.mintLeases.get(intent.leaseId),binding='asset:'+requestId;
  if(!lease||!['reserved','signed-pending','consumed'].includes(lease.state)||lease.network!==(config.network??'localnet')||lease.mint!==intent.mint||lease.creator!==creator||lease.programId!==programId||lease.genesisHash!==genesisHash||lease.campaign!==intent.campaign||lease.draftId!==binding||lease.idempotencyKey!==binding||!lease.signerRef)throw conflict();
  return {intent,lease,descriptor:canonicalJson({intent,reservationId:lease.signerRef})};
 }
 async function network(){if(await bounded(()=>connection.getGenesisHash())!==genesisHash)throw Error('Mint approval network changed');}
 async function liveBlock(block){
  const valid=await bounded(()=>connection.isBlockhashValid(block.blockhash,{commitment:'confirmed'}));
  if(valid?.value!==true)throw Error('Mint approval expired or blockhash unavailable; reconcile before retry');
 }
 async function load(requestId){
  const value=await trusted(requestId),row=await journal.latest(operation(requestId));
  if(!row||!Number.isInteger(row.attempt)||row.attempt<1||row.attempt>3||row.descriptor!==value.descriptor)throw conflict();
  if(row.attempt>1&&!await permit(requestId,value.intent,row.operationId,row.attempt-1))throw conflict();
  verifyMintApproval(value.intent,row.prepared.block,row.prepared.creatorPacket);
  return {...value,row};
 }
 async function permit(requestId,intent,operationId,generation){
  const p=(await registry.query('SELECT * FROM creation_mint_retries WHERE request_id=? AND generation=?',[requestId,generation])).rows[0];
  if(!p)return null;
  if(p.owner!==creator||p.intent_hash!==mintIntentHash(intent)||p.operation_id!==operationId||generation<1||generation>2)throw conflict();
  const old=(await registry.query('SELECT * FROM operator_packets WHERE operation_id=? AND attempt=?',[operationId,generation])).rows[0];
  if(!old||!['failed','expired'].includes(old.status)||old.signature!==p.previous_signature)throw conflict();
  const oldPrepared=JSON.parse(old.prepared_json),verified=verifyMintApproval(intent,oldPrepared.block,oldPrepared.creatorPacket);
  if(digest(verified.message)!==p.previous_message_hash)throw conflict();
  return p;
 }
 async function pendingRetry(requestId){
  const {intent,lease,row}=await load(requestId);
  if(!['failed','expired'].includes(row.status)||row.attempt>=3)return null;
  const p=await permit(requestId,intent,row.operationId,row.attempt);
  if(!p)return null;
  if(lease.state!=='signed-pending'||lease.messageDigest!==p.previous_message_hash||lease.signature!==p.previous_signature)throw conflict();
  return {generation:row.attempt,previousMessageSha256:p.previous_message_hash,previousSignature:p.previous_signature};
 }
 async function record(requestId,{block,creatorPacket,offerId=null}){
  block=structuredClone(block);
  await network();const {intent,lease,descriptor}=await trusted(requestId);
  const approval=verifyMintApproval(intent,block,creatorPacket),prepared={block,creatorPacket};
  const prior=await journal.latest(operation(requestId));
  const duplicate=prior&&prior.descriptor===descriptor&&canonicalJson(prior.prepared)===canonicalJson(prepared);
  if(!duplicate){
   if(prior&&!await pendingRetry(requestId))throw conflict();
   if(lease.state==='consumed')throw Error('Mint already consumed');await liveBlock(block);
  }
  await network();
  return registry.transaction(async()=>{
   const current=await trusted(requestId);if(current.descriptor!==descriptor)throw conflict();
   if(offerId!==null){
    if(typeof offerId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(offerId))throw conflict();
    const offer=(await registry.query('SELECT * FROM creation_mint_offers WHERE offer_id=? AND request_id=? AND owner=?',[offerId,requestId,creator])).rows[0];
    if(!offer||!['open','approved'].includes(offer.state)||offer.intent_hash!==mintIntentHash(intent)||canonicalJson(JSON.parse(offer.block_json))!==canonicalJson(block))throw conflict();
   }
   const latest=await journal.latest(operation(requestId));
   const same=latest&&latest.descriptor===descriptor&&canonicalJson(latest.prepared)===canonicalJson(prepared);
   let retry=null;
   if(latest&&!same){retry=await pendingRetry(requestId);if(!retry)throw conflict();}
   const row=await journal.prepare({operationId:operation(requestId),descriptor,prepared,previous:retry?latest.attempt:null});
   if(canonicalJson(row.prepared)!==canonicalJson(prepared))throw conflict();
   if(retry){
    // Only this proof-bound retry transaction can replace a lease digest. Generic
    // lease transitions retain their immutable digest/signature protections.
    const changed=await registry.query("UPDATE mint_leases SET message_digest=?,signature=NULL,updated_at=? WHERE lease_id=? AND state='signed-pending' AND message_digest=? AND signature=?",[digest(approval.message),new Date().toISOString(),intent.leaseId,retry.previousMessageSha256,retry.previousSignature]);
    if(changed.rowCount!==1)throw conflict();
   }else{
    const bound=await mintLeases.recordSigningIntent({leaseId:intent.leaseId,messageDigest:digest(approval.message)});
    if(bound.outcome!=='recorded'){
     const winner=await registry.mintLeases.get(intent.leaseId);
     if(!winner||winner.messageDigest!==digest(approval.message)||!(winner.state==='signed-pending'||winner.state==='consumed'&&row.signature&&winner.signature===row.signature))throw Error('Mint signing intent could not be bound');
    }
   }
   if(offerId!==null)await registry.query("UPDATE creation_mint_offers SET state='approved',updated_at=CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) WHERE offer_id=? AND state='open'",[offerId]);
   return {requestId,status:row.status,signature:row.signature??null,intentHash:approval.intentHash,messageDigest:digest(approval.message),generation:row.attempt-1};
  },{lockKey:'creator-mint-offer:'+requestId});
 }
 async function authorize(input){
  if(input?.creator!==creator||typeof input.draftId!=='string'||!input.draftId.startsWith('asset:')||input.idempotencyKey!==input.draftId)throw conflict();
  await network();const {intent,lease,row}=await load(input.draftId.slice(6));
  const approval=verifyMintApproval(intent,row.prepared.block,row.prepared.creatorPacket);
  if(!['prepared','signed'].includes(row.status)||lease.state!=='signed-pending'||lease.signerRef!==input.reservationId||lease.messageDigest!==digest(approval.message))throw conflict();
  // record() required a live block before binding this exact creator approval.
  // Recovery must also retrieve the inventory's same signature after expiry: a
  // process may have died between its signing write and captureSigned(). Signing
  // these unchanged bytes cannot extend their blockhash validity. Never rebuild
  // or substitute a fresh blockhash here; the executor reconciles this attempt.
  await network();
  if(row.attempt>1){const p=await permit(intent.requestId,intent,row.operationId,row.attempt-1);return {...approval,retry:{generation:row.attempt-1,previousMessageSha256:p.previous_message_hash}};}
  return approval;
 }
 async function validateSigned(requestId,encoded){
  const {intent,lease,row}=await load(requestId);
  if(typeof encoded!=='string'||!encoded.length||encoded.length>1644)throw Error('Invalid signed mint packet');
  const bytes=Buffer.from(encoded,'base64'),tx=VersionedTransaction.deserialize(bytes);
  const approval=verifyMintApproval(intent,row.prepared.block,row.prepared.creatorPacket),message=tx.message.serialize(),signers=mintPacketSigners(intent);
  // Every signer of the packet (creator, reserved mint and, for a funding-first opening, the reserved fee NFT) signed it.
  if(bytes.length>1232||bytes.toString('base64')!==encoded||!Buffer.from(tx.serialize()).equals(bytes)||!Buffer.from(message).equals(Buffer.from(approval.message))||tx.signatures.length!==signers.length||signers.some((k,i)=>!verifySignature(k,message,tx.signatures[i])))throw Error('Inventory returned an invalid signed mint packet');
  return {intent,lease,row,message,signature:encodeBase58(tx.signatures[0])};
 }
 async function captureSigned(requestId,encoded){
  return registry.transaction(async()=>{
  const {intent,lease,row,message,signature}=await validateSigned(requestId,encoded);
  if(lease.state==='consumed'&&row.status==='finalized'&&row.signature===signature&&lease.signature===signature&&row.signedBase64===encoded&&lease.messageDigest===digest(message))return {signature,packet:encoded,block:row.prepared.block};
  if(lease.state!=='signed-pending'||lease.messageDigest!==digest(message))throw conflict();
  // Persist the exact full packet before any caller is allowed to broadcast it.
  const signed=await journal.sign({operationId:operation(requestId),attempt:row.attempt,signedBase64:encoded,signature});
  const bound=await mintLeases.recordSignature({leaseId:intent.leaseId,messageDigest:digest(message),signature});
  if(bound.outcome!=='recorded')throw Error('Mint signature could not be bound');
  return {signature,packet:signed.signedBase64,block:row.prepared.block};
  },{lockKey:'creator-mint-offer:'+requestId});
 }
 return {record,authorize,captureSigned,validateSigned,pendingRetry,async read(requestId){const {row}=await load(requestId);return row;},async find(requestId){
  await trusted(requestId);if(!await journal.latest(operation(requestId)))return null;const {row}=await load(requestId);return row;
 }};
}
