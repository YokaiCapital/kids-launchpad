import {observedBlockhash} from '../protocol-v2/durable-send.mjs';
// Private creator boundary: persisted server offers, exact wallet signatures and
// atomic refresh-versus-approval. No caller-provided instructions or expiry.
import {randomUUID} from 'node:crypto';
import {SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {canonicalJson} from '../registry/canonical.mjs';
import {buildProvisionPacket,provisionIntentHash,provisionTerms} from './provision-packet.mjs';
import {provisionOperationId} from './provision-execution.mjs';
import {creationMode,creationRpc} from './scope.mjs';
const conflict=()=>Object.assign(Error('Setup offer changed; reload creation status'),{code:'IDEMPOTENCY_CONFLICT'});
export function createProvisionWalletService({registry,connection,config,plans,executor,recovery=null,timeoutMs=12000}){
 if(registry?.driver!=='postgres'||!plans?.load||!executor?.record||!executor?.status||!executor?.resume)throw Error('Setup wallet requires shared plans and execution');
 if(!creationMode(config?.mode)||config.programVersion!==3)throw Error('Setup wallet is an isolated v3 pilot only');
 const scope=structuredClone(config),u=new URL(scope.rpcUrl);
 if(!creationRpc(u,scope.mode)||connection.rpcEndpoint!==scope.rpcUrl)throw Error('Setup wallet requires configured loopback RPC');
 if(!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw Error('Bounded setup wallet RPC timeout required');
 async function bounded(fn){let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Setup wallet RPC timeout')),timeoutMs);})]);}finally{clearTimeout(timer);}}
 const query=(s,p=[])=>registry.query(s,p),active=async(id,stage)=>(await query("SELECT * FROM creation_provision_offers WHERE request_id=? AND stage=? AND state='open'",[id,stage])).rows[0];
 async function trusted(owner,requestId,stage){
  if(owner!==scope.pilotCreator||typeof requestId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)||!['native-custody','create-campaign'].includes(stage))throw conflict();
  const intent=await plans.load(requestId,stage);provisionIntentHash(intent);const m=intent.mint;
  if(m.requestId!==requestId||m.creator!==owner||m.programId!==scope.programId||m.genesisHash!==scope.genesisHash||intent.treasury!==scope.treasury)throw conflict();return intent;
 }
 const resumeView=row=>({...row,action:'resume'});
 function view(row,intent){
  const block=JSON.parse(row.block_json),unsigned=Buffer.from(buildProvisionPacket(intent,row.stage,block).serialize()).toString('base64'),m=intent.mint,t=provisionTerms(intent);
  if(row.owner!==m.creator||row.request_id!==m.requestId||row.intent_hash!==provisionIntentHash(intent)||row.unsigned_packet!==unsigned)throw conflict();
  return {requestId:m.requestId,stage:row.stage,intentHash:provisionIntentHash(intent),generation:intent.generation??1,offerId:row.offer_id,action:'sign-setup',transactionBase64:unsigned,verification:structuredClone(intent),review:{network:scope.network??'localnet',programId:m.programId,campaign:m.campaign,mint:m.mint,creator:m.creator,treasury:intent.treasury,opensAt:intent.opensAt,deadline:t.deadline,softCapLamports:t.soft,hardCapLamports:t.hard,setupReserveLamports:row.stage==='create-campaign'?intent.authorityBudgetLamports:'0',setupDestination:row.stage==='create-campaign'?m.authority:null,costCoverage:row.stage==='create-campaign'?'pool-initialization-only':'native-custody-rent-and-network-fee'}};
 }
 async function network(){if(await bounded(()=>connection.getGenesisHash())!==scope.genesisHash)throw Error('Setup wallet ledger changed');}
 return {
  async prepare(owner,{requestId,stage}){
   const intent=await trusted(owner,requestId,stage);await network();
   const approved=await executor.status(requestId,stage);if(approved.status!=='awaiting-approval')return resumeView(approved);
   if(stage==='create-campaign'){
    const native=await executor.status(requestId,'native-custody');
    if(native.status!=='finalized')return {...resumeView(native),reason:'complete-native-custody-first'};
    const r=await bounded(()=>connection.getMultipleAccountsInfoAndContext([SYSVAR_CLOCK_PUBKEY],{commitment:'finalized'})),clock=r.value?.[0];
    if(!Number.isSafeInteger(r.context?.slot)||!clock||clock.data.length!==40)throw Error('Setup clock unavailable');
    if(clock.data.readBigInt64LE(32)>BigInt(intent.opensAt)+30n)return {requestId,stage,status:'attention',action:'review-schedule',reason:'opening-time-expired',intentHash:provisionIntentHash(intent),signature:null};
   }
   const observed=await active(requestId,stage);let reusable=false;
   if(observed){view(observed,intent);const valid=(await bounded(()=>connection.isBlockhashValid(JSON.parse(observed.block_json).blockhash,{commitment:'confirmed'})))?.value;if(typeof valid!=='boolean')throw Error('Setup offer validity unavailable');reusable=valid;}
   const block=reusable?JSON.parse(observed.block_json):await bounded(()=>observedBlockhash(connection,'confirmed'));
   const unsigned=Buffer.from(buildProvisionPacket(intent,stage,block).serialize()).toString('base64');await network();
   return registry.transaction(async()=>{
    if(provisionIntentHash(await trusted(owner,requestId,stage))!==provisionIntentHash(intent))throw conflict();
    const approved=await executor.status(requestId,stage);if(approved.status!=='awaiting-approval')return resumeView(approved);
    const current=await active(requestId,stage);if(current&&(!observed||current.offer_id!==observed.offer_id||reusable))return view(current,intent);
    if(current)await query("UPDATE creation_provision_offers SET state='superseded',updated_at=CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) WHERE offer_id=? AND state='open'",[current.offer_id]);
    await query("INSERT INTO creation_provision_offers(offer_id,request_id,owner,stage,intent_hash,block_json,unsigned_packet,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'open',CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT),CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT))",[randomUUID(),requestId,owner,stage,provisionIntentHash(intent),canonicalJson(block),unsigned]);
    return view(await active(requestId,stage),intent);
   },{lockKey:'creator-provision:'+provisionOperationId(intent,stage)});
  },
  async submit(owner,{requestId,stage,offerId,transactionBase64}){
   const intent=await trusted(owner,requestId,stage);
   if(typeof offerId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(offerId))throw conflict();
   const row=(await query('SELECT * FROM creation_provision_offers WHERE offer_id=? AND request_id=? AND owner=? AND stage=?',[offerId,requestId,owner,stage])).rows[0];
   if(!row||!['open','approved'].includes(row.state))throw conflict();view(row,intent);
   const result=await executor.record(requestId,{stage,offerId,block:JSON.parse(row.block_json),creatorPacket:transactionBase64});
   return resumeView({requestId,stage,...result});
  },
  async recover(owner,input){await trusted(owner,input.requestId,input.stage??'create-campaign');if(!recovery)throw Error('Setup recovery is not configured');return recovery.recover(owner,input);},
  async status(owner,{requestId,stage}){await trusted(owner,requestId,stage);return executor.status(requestId,stage);},
  async resume(owner,{requestId,stage},{signal}={}){await trusted(owner,requestId,stage);return executor.resume(requestId,stage,{signal});},
 };
}
