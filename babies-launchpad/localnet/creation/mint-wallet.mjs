import {observedBlockhash} from '../protocol-v2/durable-send.mjs';
// Private localnet creator-wallet boundary. This does not invoke the mint signer
// or broadcast. Submission atomically binds one approved, server-built offer.
import {randomUUID} from 'node:crypto';
import {buildMintPacket,mintIntentHash} from './mint-packet.mjs';
import {canonicalJson} from '../registry/canonical.mjs';
import {creationMode,creationRpc} from './scope.mjs';
const conflict=()=>Object.assign(Error('Mint offer changed; reload creation status'),{code:'IDEMPOTENCY_CONFLICT'});
export function createMintWalletService({registry,connection,config,plans,approvals,recovery=null,timeoutMs=12000}){
 if(registry?.driver!=='postgres'||!plans?.load||!approvals?.find||!approvals?.record)throw Error('Mint wallet needs a shared plan and approval journal');
 if(!creationMode(config?.mode)||config.programVersion!==3)throw Error('Mint wallet is an isolated v3 pilot only');
 if(!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw Error('Bounded mint RPC timeout required');
 async function bounded(fn){let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Mint wallet RPC timeout')),timeoutMs);})]);}finally{clearTimeout(timer);}}
 const scope=structuredClone(config),url=new URL(scope.rpcUrl);
 if(!creationRpc(url,scope.mode)||connection.rpcEndpoint!==scope.rpcUrl)throw Error('Mint wallet requires the configured loopback RPC');
 const query=(s,p=[])=>registry.query(s,p),active=async id=>(await query("SELECT * FROM creation_mint_offers WHERE request_id=? AND state='open'",[id])).rows[0];
 async function intentFor(owner,id){
  if(owner!==scope.pilotCreator||!/^[A-Za-z0-9_.:-]{1,128}$/.test(id||''))throw conflict();
  const intent=await plans.load(id);mintIntentHash(intent);
  if(intent.requestId!==id||intent.creator!==owner||intent.genesisHash!==scope.genesisHash||intent.programId!==scope.programId)throw conflict();
  return intent;
 }
 const status=(id,row)=>({requestId:id,action:'resume',state:row.status,signature:row.signature??null});
 function offerView(row,intent){
  const block=JSON.parse(row.block_json),expected=Buffer.from(buildMintPacket(intent,block).serialize()).toString('base64');
  if(row.intent_hash!==mintIntentHash(intent)||row.unsigned_packet!==expected||row.owner!==intent.creator)throw conflict();
  // Version 3 (funding-first): the review also names the reserved fee NFT the opening binds and says no token exists yet.
  return {requestId:intent.requestId,action:intent.version>=2?'sign-launch':'sign-mint',offerId:row.offer_id,transactionBase64:expected,block,verification:structuredClone(intent),review:{network:scope.network??'localnet',creator:intent.creator,programId:intent.programId,mint:intent.mint,name:intent.metadata.name,symbol:intent.metadata.symbol,supply:intent.supply,decimals:intent.decimals,custody:intent.authority,metadataUri:intent.metadata.uri,mintAuthorityAfter:null,freezeAuthorityAfter:null,...(intent.version>=2?{campaign:intent.campaign,opensAt:intent.launch.opensAt,softCapLamports:intent.launch.policy.softCapLamports,hardCapLamports:intent.launch.policy.hardCapLamports,treasury:intent.launch.treasury,authorityBudgetLamports:intent.launch.authorityBudgetLamports,operatingPayer:intent.launch.reserve.payer,operatingReserveLamports:intent.launch.reserve.lamports}:{}),...(intent.version===3?{accounting:'funding-first',feeNft:intent.fundingFirst.feeNft,tokenCreatedAtOpening:false}:{})}};
 }
 async function network(){if(await bounded(()=>connection.getGenesisHash())!==scope.genesisHash)throw Error('Mint wallet ledger changed');}
 return {
  async prepare(owner,{requestId}){
   const intent=await intentFor(owner,requestId);await network();
   const approved=await approvals.find(requestId),retry=approved&&await approvals.pendingRetry?.(requestId);if(approved&&!retry)return status(requestId,approved);
   if((await registry.mintLeases.get(intent.leaseId))?.state!=='reserved'&&!retry)throw Error('Mint reservation needs reconciliation before another wallet offer');
   const observed=await active(requestId);
   let reusable=false;
   if(observed){
    offerView(observed,intent);const previous=JSON.parse(observed.block_json);
    const [reply,height]=await Promise.all([bounded(()=>connection.isBlockhashValid(previous.blockhash,{commitment:'confirmed'})),typeof connection.getBlockHeight==='function'?bounded(()=>connection.getBlockHeight('confirmed')):null]);
    if(typeof reply?.value!=='boolean'||height!==null&&!Number.isSafeInteger(height))throw Error('Mint offer validity unavailable');
    reusable=reply.value&&(height===null||previous.lastValidBlockHeight-height>=50);
   }
   const block=reusable?JSON.parse(observed.block_json):await bounded(()=>observedBlockhash(connection,'confirmed'));
   const unsigned=Buffer.from(buildMintPacket(intent,block).serialize()).toString('base64');await network();
   return registry.transaction(async()=>{
    const approved=await approvals.find(requestId),retry=approved&&await approvals.pendingRetry?.(requestId);if(approved&&!retry)return status(requestId,approved);
    const current=await active(requestId);
    // A concurrent replica already supplied a newer immutable offer. Return it
    // instead of repeatedly invalidating another wallet's prompt.
    if(current&&(!observed||current.offer_id!==observed.offer_id||reusable))return offerView(current,intent);
    if(current)await query("UPDATE creation_mint_offers SET state='superseded',updated_at=CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) WHERE offer_id=? AND state='open'",[current.offer_id]);
    const id=randomUUID();await query("INSERT INTO creation_mint_offers(offer_id,request_id,owner,intent_hash,block_json,unsigned_packet,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'open',CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT),CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT))",[id,requestId,owner,mintIntentHash(intent),canonicalJson(block),unsigned]);
    return offerView(await active(requestId),intent);
   },{lockKey:'creator-mint-offer:'+requestId});
  },
  async submit(owner,{requestId,offerId,transactionBase64}){
   const intent=await intentFor(owner,requestId);
   if(typeof offerId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(offerId))throw conflict();
   const row=(await query('SELECT * FROM creation_mint_offers WHERE offer_id=? AND request_id=? AND owner=?',[offerId,requestId,owner])).rows[0];
   if(!row||!['open','approved'].includes(row.state))throw conflict();offerView(row,intent);
   const saved=await approvals.record(requestId,{offerId,block:JSON.parse(row.block_json),creatorPacket:transactionBase64});
   return {requestId,action:'resume',state:saved.status,signature:saved.signature??null};
  },
  async recover(owner,input){await intentFor(owner,input.requestId);if(!recovery?.recover)throw Error('Mint recovery is not configured');return recovery.recover(owner,input);},
  async status(owner,{requestId}){await intentFor(owner,requestId);const approved=await approvals.find(requestId),retry=approved&&await approvals.pendingRetry?.(requestId);if(retry)return {requestId,action:'prepare-mint',state:'review-required',generation:retry.generation,previousSignature:retry.previousSignature};return approved?status(requestId,approved):{requestId,action:'prepare-mint',state:'awaiting-approval',signature:null};},
 };
}
