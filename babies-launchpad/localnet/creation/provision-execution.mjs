// Internal wallet-approved setup outbox. No public endpoint, auto-signing, ledger
// registration or replacement-generation policy is enabled by this module.
import {PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {packetStatus} from '../protocol-v2/durable-send.mjs';
import {mintResultAddresses,verifyMintResult} from './mint-result.mjs';
import {nativeCustodyAddress,verifyNativeCustody,provisionResultAddresses,verifyProvisionResult} from './provision-result.mjs';
import {provisionIntentHash,verifyProvisionApproval,buildProvisionPacket} from './provision-packet.mjs';
import {creationMode,creationRpc} from './scope.mjs';
const conflict=()=>Object.assign(Error('Provisioning approval changed'),{code:'IDEMPOTENCY_CONFLICT'});
export function provisionOperationId(intent,stage){
 provisionIntentHash(intent);if(!['native-custody','create-campaign'].includes(stage))throw conflict();
 const m=intent.mint;return canonicalHash({kind:'creator-provision-v3',genesisHash:m.genesisHash,programId:m.programId,creator:m.creator,requestId:m.requestId,stage,...(intent.version===2?{generation:intent.generation}:{})});
}
export function createProvisionExecutor({registry,connection,config,loadIntent,timeoutMs=12000,checkpoint=async()=>{}}){
 if(registry?.driver!=='postgres'||!registry.operatorPackets||typeof loadIntent!=='function')throw Error('Provisioning needs a shared journal and trusted intent reader');
 if(!creationMode(config?.mode)||config.programVersion!==3)throw Error('Provisioning is restricted to the isolated v3 pilot');
 const scope=structuredClone(config),u=new URL(scope.rpcUrl);
 if(!creationRpc(u,scope.mode)||connection.rpcEndpoint!==scope.rpcUrl)throw Error('Provisioning needs the configured loopback RPC');
 if(!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw Error('Bounded provisioning RPC timeout required');
 const journal=registry.operatorPackets;
 async function bounded(fn){let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Provisioning RPC timeout')),timeoutMs);})]);}finally{clearTimeout(timer);}}
 async function network(){if(await bounded(()=>connection.getGenesisHash())!==scope.genesisHash)throw Error('Provisioning ledger changed');}
 async function trusted(requestId,stage){
  if(typeof requestId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)||!['native-custody','create-campaign'].includes(stage))throw conflict();
  const intent=structuredClone(await loadIntent(requestId,stage));provisionIntentHash(intent);const m=intent.mint;
  if(m.requestId!==requestId||m.genesisHash!==scope.genesisHash||m.programId!==scope.programId||m.creator!==scope.pilotCreator||intent.treasury!==scope.treasury)throw conflict();
  return {intent,descriptor:canonicalJson({intent,stage}),operationId:provisionOperationId(intent,stage)};
 }
 async function preflight(intent,stage){
  if(intent.mint.version>=2)throw Error('One-transaction creation has no provisioning stages');
  const keys=[...mintResultAddresses(intent.mint),SYSVAR_CLOCK_PUBKEY,...(stage==='create-campaign'?[nativeCustodyAddress(intent.mint),new PublicKey(intent.mint.campaign)]:[])];
  const r=await bounded(()=>connection.getMultipleAccountsInfoAndContext(keys,{commitment:'finalized'}));
  verifyMintResult(intent.mint,{context:r.context,value:r.value.slice(0,3)},{minSlot:0});
  const clock=r.value[3];if(!clock||clock.data.length!==40)throw Error('Provisioning clock unavailable');
  if(stage==='create-campaign'){
   verifyNativeCustody(intent.mint,r.value[4]);if(r.value[5])throw Error('Campaign already exists; reconcile before another approval');
   if(clock.data.readBigInt64LE(32)>BigInt(intent.opensAt)+30n)throw Error('Opening time expired; do not sign this setup');
  }
 }
 async function rowFor(source){
  const row=await journal.latest(source.operationId);if(!row)return null;
  if(row.attempt!==1||row.descriptor!==source.descriptor)throw conflict();
  const signed=verifyProvisionApproval(source.intent,row.prepared.stage,row.prepared.block,row.prepared.creatorPacket);
  if(row.prepared.stage!==JSON.parse(source.descriptor).stage||row.signedBase64!==row.prepared.creatorPacket||row.signature!==signed.signature)throw conflict();
  return row;
 }
 async function finalizedEvidence(intent,stage,state){
  if(stage==='native-custody'){
   const r=await bounded(()=>connection.getMultipleAccountsInfoAndContext([nativeCustodyAddress(intent.mint)],{commitment:'finalized',minContextSlot:state.slot}));
   if(!Number.isSafeInteger(r.context?.slot)||r.context.slot<state.slot||r.value.length!==1)throw Error('Finalized native custody unavailable');
   return {version:1,intentHash:provisionIntentHash(intent),stage,slot:r.context.slot,...verifyNativeCustody(intent.mint,r.value[0])};
  }
  const r=await bounded(()=>connection.getMultipleAccountsInfoAndContext(provisionResultAddresses(intent),{commitment:'finalized',minContextSlot:state.slot}));
  const rent=await bounded(()=>connection.getMinimumBalanceForRentExemption(1024,'finalized'));if(!Number.isSafeInteger(rent)||rent<1)throw Error('Campaign rent unavailable');
  return {...verifyProvisionResult(intent,r,{minSlot:state.slot,campaignRentLamports:String(rent)}),stage};
 }
 return {
  // block is the server's saved offer, not browser-supplied expiry. This internal
  // boundary must only be mounted behind an owned, persisted wallet-offer service.
  async record(requestId,{stage,block,creatorPacket,offerId=null}){
   const source=await trusted(requestId,stage),approved=verifyProvisionApproval(source.intent,stage,block,creatorPacket),prepared={stage,block:structuredClone(block),creatorPacket};
   const checkOffer=async()=>{
    if(offerId===null)return;
    if(typeof offerId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(offerId))throw conflict();
    const offer=(await registry.query('SELECT * FROM creation_provision_offers WHERE offer_id=? AND request_id=? AND owner=? AND stage=?',[offerId,requestId,scope.pilotCreator,stage])).rows[0];
    if(!offer||!['open','approved'].includes(offer.state)||offer.intent_hash!==provisionIntentHash(source.intent)||canonicalJson(JSON.parse(offer.block_json))!==canonicalJson(block)||offer.unsigned_packet!==Buffer.from(buildProvisionPacket(source.intent,stage,block).serialize()).toString('base64'))throw conflict();
   };
   await checkOffer();const prior=await rowFor(source);
   if(prior){if(canonicalJson(prior.prepared)!==canonicalJson(prepared))throw conflict();return {status:prior.status,signature:prior.signature};}
   await network();if((await bounded(()=>connection.isBlockhashValid(block.blockhash,{commitment:'confirmed'})))?.value!==true)throw Error('Provisioning offer expired or unavailable');
   await preflight(source.intent,stage);await network();
   const row=await registry.transaction(async()=>{
    if((await trusted(requestId,stage)).descriptor!==source.descriptor)throw conflict();
    await checkOffer();
    const row=await journal.prepare({operationId:source.operationId,descriptor:source.descriptor,prepared});
    if(canonicalJson(row.prepared)!==canonicalJson(prepared))throw conflict();
    const signed=await journal.sign({operationId:source.operationId,attempt:row.attempt,signedBase64:creatorPacket,signature:approved.signature});
    if(offerId!==null)await registry.query("UPDATE creation_provision_offers SET state='approved',updated_at=CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) WHERE offer_id=? AND state='open'",[offerId]);
    return signed;
   },{lockKey:'creator-provision:'+source.operationId});
   return {status:row.status,signature:row.signature};
  },
  async status(requestId,stage){const source=await trusted(requestId,stage),row=await rowFor(source);return {requestId,stage,status:row?.status??'awaiting-approval',signature:row?.signature??null};},
  async resume(requestId,stage,{signal}={}){
   const source=await trusted(requestId,stage),row=await rowFor(source);if(!row)return {status:'awaiting-approval',requestId,stage};
   const result=(status,reason)=>({status,reason,requestId,stage,signature:row.signature});
   if(['failed','expired'].includes(row.status))return result('attention',row.status);
   try{await network();}catch{return result('pending','network-unavailable');}
   if(row.status==='finalized'){
    if(row.result?.provisionEvidence?.intentHash!==provisionIntentHash(source.intent)||row.result.provisionEvidence.stage!==stage)throw conflict();
    return {...result('complete','verified'),evidence:row.result.provisionEvidence};
   }
   let state;try{state=await bounded(()=>packetStatus(connection,row.signature,row.prepared.block));}catch{return result('pending','confirmation-unavailable');}
   if(['failed','expired'].includes(state.status)){
    if(row.status==='signed')await journal.progress({operationId:row.operationId,attempt:row.attempt,from:'signed',to:state.status,result:state});
    return result('attention',state.status);
   }
   if(state.status!=='confirmed'||!state.finalized){
    if(state.status==='confirmed'||state.observed||signal?.aborted)return result('pending',state.status==='confirmed'?'awaiting-finality':'confirmation-pending');
    try{await network();if(signal?.aborted)return result('pending','paused');const s=await bounded(()=>connection.sendRawTransaction(Buffer.from(row.signedBase64,'base64'),{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0}));if(s!==row.signature)throw Error('Unexpected setup signature');}catch{return result('pending','submission-unresolved');}
    await checkpoint('broadcast',row);return result('pending','submitted');
   }
   let evidence;try{evidence=await finalizedEvidence(source.intent,stage,state);await network();}catch(error){return result(error.code==='PROVISION_RESULT_MISMATCH'||error.code==='MINT_RESULT_MISMATCH'?'attention':'pending',error.code?.endsWith('MISMATCH')?'account-mismatch':'finalized-evidence-unavailable');}
   const saved=await journal.progress({operationId:row.operationId,attempt:row.attempt,from:row.status,to:'finalized',result:{...state,provisionEvidence:evidence}});
   if(saved.status!=='finalized'||saved.result?.provisionEvidence?.intentHash!==evidence.intentHash)return result('pending','journal-reconciliation');
   await checkpoint('verified',saved);return {...result('complete','verified'),evidence};
  },
 };
}
