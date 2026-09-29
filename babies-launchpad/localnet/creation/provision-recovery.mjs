// Explicit creator retry for immediate-start setup. No broadcast, no automatic
// replacement, no new key or charge, and no rewrite of the native-custody journal.
import {PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {packetStatus} from '../protocol-v2/durable-send.mjs';
import {mintResultAddresses,verifyMintResult} from './mint-result.mjs';
import {nativeCustodyAddress,verifyNativeCustody} from './provision-result.mjs';
import {provisionIntentHash,verifyProvisionApproval} from './provision-packet.mjs';
import {provisionOperationId} from './provision-execution.mjs';
import {creationMode,creationRpc} from './scope.mjs';
const conflict=()=>Object.assign(Error('Setup recovery changed; reload its status'),{code:'IDEMPOTENCY_CONFLICT'});
export function createProvisionRecovery({registry,connection,config,plans,executor,timeoutMs=12000}){
 if(registry?.driver!=='postgres'||!plans?.base||!plans?.load||!executor?.status)throw Error('Recovery requires shared setup plans and journal');
 const scope=structuredClone(config),url=new URL(scope.rpcUrl);
 if(!creationMode(scope.mode)||scope.programVersion!==3||!creationRpc(url,scope.mode)||connection.rpcEndpoint!==scope.rpcUrl)throw Error('Recovery is isolated v3 localnet only');
 if(!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw Error('Bounded recovery deadline required');
 const query=(s,p=[])=>registry.query(s,p);
 return {async recover(owner,{requestId,expectedIntentHash,stage='create-campaign'}){
  if(!['native-custody','create-campaign'].includes(stage)||owner!==scope.pilotCreator||typeof requestId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)||!/^[a-f0-9]{64}$/.test(expectedIntentHash??''))throw conflict();
  const table=stage==='native-custody'?'creation_native_setup_revisions':'creation_provision_revisions';
  const deadline=Date.now()+timeoutMs;
  async function rpc(fn){let timer;const ms=deadline-Date.now();if(ms<=0)throw Error('Recovery RPC deadline exceeded');try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Recovery RPC deadline exceeded')),ms);})]);}finally{clearTimeout(timer);}}
  const base=await plans.base(requestId),intent=await plans.load(requestId,stage),hash=provisionIntentHash(intent),m=intent.mint;
  if(m.creator!==owner||m.requestId!==requestId||m.genesisHash!==scope.genesisHash||m.programId!==scope.programId||intent.treasury!==scope.treasury)throw conflict();
  const view=i=>({requestId,stage,status:'review-required',action:'prepare-setup',intentHash:provisionIntentHash(i),generation:i.generation??1,opensAt:i.opensAt});
  if(!['after-creation','scheduled'].includes(base.start))throw conflict();
  if(expectedIntentHash!==hash){
   const prior=(await query('SELECT previous_intent_hash FROM '+table+' WHERE request_id=? AND generation=?',[requestId,intent.generation??1])).rows[0];
   if(prior?.previous_intent_hash===expectedIntentHash)return view(intent);throw conflict();
  }
  const operationId=provisionOperationId(intent,stage);
  const row=await registry.operatorPackets.latest(operationId);
  if(row){
   if(row.attempt!==1||row.descriptor!==canonicalJson({intent,stage})||row.prepared.stage!==stage||row.signedBase64!==row.prepared.creatorPacket)throw conflict();
   if(verifyProvisionApproval(intent,stage,row.prepared.block,row.prepared.creatorPacket).signature!==row.signature)throw conflict();
   if(['confirmed','finalized'].includes(row.status))return {requestId,stage,status:'pending',action:'resume',reason:stage==='native-custody'?'reconcile-existing-custody':'reconcile-existing-creation',signature:row.signature};
  }
  if(stage==='create-campaign'&&(await executor.status(requestId,'native-custody')).status!=='finalized')return {requestId,stage:'native-custody',status:'pending',action:'resume',reason:'complete-native-custody-first'};
  const offers=async()=>(await query('SELECT offer_id,block_json,state FROM creation_provision_offers WHERE request_id=? AND stage=? AND intent_hash=? ORDER BY offer_id',[requestId,stage,hash])).rows;
  const observed=await offers();
  if(await rpc(()=>connection.getGenesisHash())!==scope.genesisHash)throw Error('Recovery ledger changed');
  let terminalState=null;
  if(row){const state=await rpc(()=>packetStatus(connection,row.signature,row.prepared.block));terminalState=state;if(!['failed','expired'].includes(state.status))return {requestId,stage,status:'pending',action:'resume',reason:'previous-transaction-unresolved',signature:row.signature};}
  const epoch=await rpc(()=>connection.getEpochInfo('finalized'));
  if(!Number.isSafeInteger(epoch?.blockHeight)||epoch.blockHeight<1||!Number.isSafeInteger(epoch.absoluteSlot)||epoch.absoluteSlot<1)throw Error('Finalized recovery height unavailable');
  // Even an unsigned offer could have been signed and relayed outside this API.
  // Every old blockhash must be past FINALIZED expiry before changing the plan.
  const blocks=[...observed.map(o=>JSON.parse(o.block_json)),...(row?[row.prepared.block]:[])];
  if(blocks.some(b=>!Number.isSafeInteger(b?.lastValidBlockHeight)||b.lastValidBlockHeight<1))throw conflict();
  if(blocks.some(b=>epoch.blockHeight<=b.lastValidBlockHeight))return {requestId,stage,status:'pending',action:'wait',reason:'waiting-for-finalized-expiry',signature:row?.signature??null};
  const response=await rpc(()=>connection.getMultipleAccountsInfoAndContext([...mintResultAddresses(m),SYSVAR_CLOCK_PUBKEY,nativeCustodyAddress(m),new PublicKey(m.campaign)],{commitment:'finalized',minContextSlot:epoch.absoluteSlot}));
  if(!Number.isSafeInteger(response.context?.slot)||response.context.slot<epoch.absoluteSlot||response.value?.length!==6)throw Error('Finalized recovery accounts unavailable');
  if(response.value[5])return {requestId,stage,status:'attention',action:'resume',reason:'campaign-already-exists',signature:row?.signature??null};
  verifyMintResult(m,{context:response.context,value:response.value.slice(0,3)},{minSlot:epoch.absoluteSlot});if(stage==='create-campaign'||response.value[4])verifyNativeCustody(m,response.value[4]);
  const clock=response.value[3];if(!clock||clock.data.length!==40)throw Error('Recovery clock unavailable');const now=clock.data.readBigInt64LE(32);
  if(stage==='create-campaign'&&base.start==='scheduled'&&now>BigInt(intent.opensAt)+30n)return {requestId,stage,status:'attention',action:'review-schedule',reason:'scheduled-start-is-fixed'};
  if(!row&&(stage==='native-custody'||now<=BigInt(intent.opensAt)+30n))return view(intent);
  if(stage==='create-campaign'&&base.start==='after-creation'&&now<BigInt(intent.opensAt))throw Error('Recovery clock moved backwards');
  const next={...base.intent,version:2,generation:(intent.generation??1)+1,opensAt:stage==='native-custody'||base.start==='scheduled'?base.intent.opensAt:String(now)};provisionIntentHash(next);
  if(await rpc(()=>connection.getGenesisHash())!==scope.genesisHash)throw Error('Recovery ledger changed');
  return registry.transaction(async()=>{
   const latest=await plans.load(requestId,stage);
   if(provisionIntentHash(latest)!==hash){
    const won=(await query('SELECT previous_intent_hash FROM '+table+' WHERE request_id=? AND generation=?',[requestId,latest.generation??1])).rows[0];
    if(won?.previous_intent_hash===hash)return view(latest);throw conflict();
   }
   const freshBase=await plans.base(requestId);
   if(freshBase.requestHash!==base.requestHash||canonicalHash(await offers())!==canonicalHash(observed)||canonicalHash(await registry.operatorPackets.latest(operationId))!==canonicalHash(row))throw conflict();
   if(row?.status==='signed'){
    const closed=await registry.operatorPackets.progress({operationId,attempt:row.attempt,from:'signed',to:terminalState.status,result:terminalState});
    if(closed.status!==terminalState.status)throw conflict();
   }
   await query("UPDATE creation_provision_offers SET state='superseded',updated_at=CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) WHERE request_id=? AND stage=? AND intent_hash=? AND state='open'",[requestId,stage,hash]);
   await query('INSERT INTO '+table+'(request_id,generation,owner,base_intent_hash,previous_intent_hash,intent_hash,intent_json,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT))',[requestId,next.generation,owner,provisionIntentHash(base.intent),hash,provisionIntentHash(next),canonicalJson(next),canonicalJson({version:1,finalizedSlot:response.context.slot,finalizedBlockHeight:epoch.blockHeight,previousSignature:row?.signature??null,expiredOffers:observed.map(o=>o.offer_id),campaignAbsent:true})]);
   return view(next);
  },{lockKey:'creator-provision:'+operationId});
 }};
}
