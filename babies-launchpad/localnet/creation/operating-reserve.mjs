// Creator operating reserve (option 1, owner decision of 27 September 2026): one creator-signed transfer to the keeper
// payer, bound to the campaign by a memo, journaled durably and credited to the campaign's operating budget only on
// finalized chain evidence. No keeper key, no automatic signing and no participant escrow is involved here.
import {PublicKey,VersionedTransaction} from '@solana/web3.js';
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {observedBlockhash,packetStatus} from '../protocol-v2/durable-send.mjs';
import {buildOperatingFundingPacket} from './operating-proofs.mjs';
import {verifySignature,encodeBase58} from '../../shared/solana.mjs';
import {creationMode,creationRpc} from './scope.mjs';
const key=/^[A-Za-z0-9_.:-]{1,128}$/,DECIMAL=/^[1-9][0-9]{0,15}$/;
export const OPERATING_RESERVE_POLICY='creator-funded-v1';
export const OPERATING_RESERVE_STAGE='operating-reserve';
const conflict=()=>Object.assign(Error('Operating reserve offer changed; reload creation status'),{code:'IDEMPOTENCY_CONFLICT'});
const address=x=>{const k=new PublicKey(x).toBase58();if(k!==x)throw conflict();return k;};
/** One durable journal identity per campaign, payer and policy: the funding of a campaign's operating budget. */
export function operatingReserveOperationId(binding){
 for(const k of ['genesisHash','programId','campaign','payer'])address(binding[k]);
 if(!key.test(binding.policy??''))throw conflict();
 return canonicalHash({kind:'creator-operating-reserve-v1',genesisHash:binding.genesisHash,programId:binding.programId,campaign:binding.campaign,payer:binding.payer,policy:binding.policy});
}
const fundingTerms=intent=>Object.fromEntries(['genesisHash','programId','campaign','payer','policy','creator','lamports'].map(k=>[k,intent[k]]));
export const operatingReserveMemo=intent=>'KIDS operating:'+canonicalHash(fundingTerms(intent));
/** Durable packet loader for the operating proof reader: the creator's signed reserve transfer for one budget. */
export function loadOperatingFundingPacket(registry){
 if(!registry?.operatorPackets)throw Error('Operating funding packets need the shared journal');
 return async x=>{
  const row=await registry.operatorPackets.latest(operatingReserveOperationId(x));
  if(!row?.signedBase64||!row.signature||!row.prepared?.intent||!row.prepared.block)throw Error('Operating funding packet unavailable');
  return {binding:fundingTerms(row.prepared.intent),signature:row.signature,transactionBase64:row.signedBase64,block:row.prepared.block,kind:row.prepared.kind==='creation'?'creation':'transfer'};
 };
}
/** The reserve amount an accepted request was quoted with: `operatingReserveLamports` of the accepted quote, or its terms. */
export function acceptedReserveLamports(quote){const v=quote?.operatingReserveLamports??quote?.terms?.operating?.reserveLamports;return typeof v==='string'&&DECIMAL.test(v)?v:null;}
export function createOperatingReserveService({registry,connection,config,ledger,loadCampaign,timeoutMs=12000,loadAccepted=null}){
 if(registry?.driver!=='postgres'||!registry.operatorPackets||typeof ledger?.credit!=='function'||typeof ledger?.balance!=='function'||typeof loadCampaign!=='function')throw Error('Operating reserve needs the shared journal, the operating ledger and a trusted campaign reader');
 if(!creationMode(config?.mode)||config.programVersion!==3)throw Error('Operating reserve is an isolated v3 pilot only');
 const scope=structuredClone(config),u=new URL(scope.rpcUrl);
 if(!creationRpc(u,scope.mode)||connection.rpcEndpoint!==scope.rpcUrl)throw Error('Operating reserve requires configured loopback RPC');
 if(!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw Error('Bounded operating reserve RPC timeout required');
 const payer=address(scope.operatingPayer),lamports=scope.operatingReserveLamports;
 if(typeof lamports!=='string'||!DECIMAL.test(lamports))throw Error('Operating reserve amount must be a sealed decimal lamport string');
 if(payer===address(scope.pilotCreator))throw Error('Operating payer cannot be the creator');
 const journal=registry.operatorPackets;
 async function bounded(fn){let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Operating reserve RPC timeout')),timeoutMs);})]);}finally{clearTimeout(timer);}}
 async function network(){if(await bounded(()=>connection.getGenesisHash())!==scope.genesisHash)throw Error('Operating reserve ledger changed');}
 async function acceptedQuote(owner,requestId){
  const row=(await registry.query('SELECT body FROM creation_requests WHERE request_id=? AND owner=?',[requestId,owner])).rows[0];
  if(!row)return null;try{return JSON.parse(row.body)?.quote??null;}catch{return null;}
 }
 async function trusted(owner,requestId){
  if(owner!==scope.pilotCreator||typeof requestId!=='string'||!key.test(requestId))throw conflict();
  const campaign=await loadCampaign(owner,requestId);
  if(!campaign||campaign.creator!==owner||campaign.campaignVersion!==3||campaign.genesisHash!==scope.genesisHash||campaign.programId!==scope.programId)throw conflict();
  // The amount is the one the creator accepted (immutable accepted quote), never the currently configured amount: a later
  // preset change must not rewrite an offer, a journal row or a credit (28 September 2026, work package 0).
  const accepted=await (loadAccepted?loadAccepted(owner,requestId):acceptedQuote(owner,requestId)),amount=acceptedReserveLamports(accepted);
  if(!amount)throw conflict();
  const binding={genesisHash:scope.genesisHash,programId:scope.programId,campaign:address(campaign.campaign),payer,policy:OPERATING_RESERVE_POLICY};
  const intent={...binding,creator:owner,lamports:amount};
  return {binding,intent,descriptor:canonicalJson({kind:'creator-operating-reserve-v1',requestId,intent}),operationId:operatingReserveOperationId(binding)};
 }
 const base=(source,requestId)=>({requestId,stage:OPERATING_RESERVE_STAGE,payer,lamports:source.intent.lamports,campaign:source.binding.campaign,policy:OPERATING_RESERVE_POLICY});
 function offer(row,source,requestId){
  if(row.descriptor!==source.descriptor||canonicalJson(row.prepared.intent)!==canonicalJson(source.intent))throw conflict();
  const unsigned=Buffer.from(buildOperatingFundingPacket(source.intent,row.prepared.block).serialize()).toString('base64');
  if(row.prepared.unsigned!==unsigned)throw conflict();
  return {...base(source,requestId),status:'awaiting-approval',action:'sign-operating-reserve',offerId:row.operationId+':'+row.attempt,attempt:row.attempt,transactionBase64:unsigned,verification:structuredClone(source.intent),
   review:{network:scope.network??'localnet',programId:scope.programId,campaign:source.binding.campaign,creator:source.intent.creator,payer,lamports:source.intent.lamports,policy:OPERATING_RESERVE_POLICY,memo:operatingReserveMemo(source.intent)},signature:null};
 }
 const state=(row,source,requestId)=>{
  if(!row)return {...base(source,requestId),status:'awaiting-approval',action:'prepare',signature:null,attempt:0};
  if(row.descriptor!==source.descriptor)throw conflict();
  const credited=row.status==='finalized'&&row.result?.credited===true;
  const status=row.status==='prepared'?'awaiting-approval':credited?'credited':row.status;
  return {...base(source,requestId),status,action:status==='awaiting-approval'?'prepare':status==='credited'?'none':['failed','expired'].includes(status)?'recover':'resume',signature:row.signature??null,attempt:row.attempt,...(credited?{creditedSlot:row.result.slot??null}:{}),...(row.result?.reason?{reason:row.result.reason}:{})};
 };
 async function credit(row,source,requestId,evidence){
  // The ledger verifies the finalized transfer against this durable packet itself; a UI balance is never proof.
  const applied=await ledger.credit({...source.binding,signature:row.signature});
  if(applied?.status!=='credited')throw Error('Operating reserve credit refused');
  let saved=row;
  if(['signed','confirmed'].includes(row.status))saved=await journal.progress({operationId:row.operationId,attempt:row.attempt,from:row.status,to:'finalized',result:{...evidence,credited:true}});
  else if(row.status==='finalized'&&row.result?.credited!==true)saved={...row,result:{...row.result,credited:true}};
  return {...state(saved,source,requestId),status:'credited',action:'none'};
 }
 return {
  loadFundingPacket:loadOperatingFundingPacket(registry),
  async prepare(owner,{requestId}){
   const source=await trusted(owner,requestId);await network();
   const current=await journal.latest(source.operationId);
   if(current&&current.descriptor!==source.descriptor)throw conflict();
   if(current&&['signed','confirmed','finalized'].includes(current.status))return state(current,source,requestId);
   let previous=null;
   if(current?.status==='prepared'){
    const valid=(await bounded(()=>connection.isBlockhashValid(current.prepared.block.blockhash,{commitment:'confirmed'})))?.value;
    if(typeof valid!=='boolean')throw Error('Operating reserve offer validity unavailable');
    if(valid)return offer(current,source,requestId);
    const expired=await journal.progress({operationId:current.operationId,attempt:current.attempt,from:'prepared',to:'expired',result:{unsigned:true,reason:'blockhash-expired'}});
    if(expired.status!=='expired')return state(expired,source,requestId);previous=expired.attempt;
   }else if(current)previous=current.attempt;
   const block=await bounded(()=>observedBlockhash(connection,'confirmed'));
   const unsigned=Buffer.from(buildOperatingFundingPacket(source.intent,block).serialize()).toString('base64');await network();
   const row=await journal.prepare({operationId:source.operationId,descriptor:source.descriptor,prepared:{intent:source.intent,requestId,block,unsigned},previous});
   return row.status==='prepared'?offer(row,source,requestId):state(row,source,requestId);
  },
  async submit(owner,{requestId,offerId,transactionBase64}){
   const source=await trusted(owner,requestId);
   if(typeof offerId!=='string'||!/^[a-f0-9]{64}:[1-9][0-9]{0,6}$/.test(offerId))throw conflict();
   const [operationId,attempt]=offerId.split(':');if(operationId!==source.operationId)throw conflict();
   const row=await journal.get(operationId,Number(attempt));if(!row||row.descriptor!==source.descriptor)throw conflict();
   if(typeof transactionBase64!=='string'||!transactionBase64||transactionBase64.length>1644)throw Error('Signed operating reserve packet required');
   const raw=Buffer.from(transactionBase64,'base64');if(raw.toString('base64')!==transactionBase64||raw.length>1232)throw Error('Signed operating reserve packet required');
   const tx=VersionedTransaction.deserialize(raw),bytes=Buffer.from(tx.message.serialize());
   const unsigned=VersionedTransaction.deserialize(Buffer.from(row.prepared.unsigned,'base64'));
   if(!Buffer.from(tx.serialize()).equals(raw)||!bytes.equals(Buffer.from(unsigned.message.serialize()))||tx.signatures.length!==1||!verifySignature(owner,bytes,tx.signatures[0]))throw Error('Wallet signature does not match the reviewed operating reserve transfer');
   const signature=encodeBase58(tx.signatures[0]);
   if(row.status==='prepared'){await network();await journal.sign({operationId,attempt:Number(attempt),signedBase64:transactionBase64,signature});}
   else if(row.signedBase64!==transactionBase64||row.signature!==signature)throw conflict();
   // Best effort first broadcast; resume re-broadcasts until the blockhash expires, never with different bytes.
   try{await bounded(()=>connection.sendRawTransaction(raw,{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0}));}catch{}
   return state(await journal.get(operationId,Number(attempt)),source,requestId);
  },
  async status(owner,{requestId}){const source=await trusted(owner,requestId);return state(await journal.latest(source.operationId),source,requestId);},
  /** One creation transaction: the reserve transfer already landed inside the finalized creation packet. Journal that
   * packet under the reserve operation and credit the budget through the same finalized-proof reader. */
  async creditFromCreation(owner,{requestId,signature,transactionBase64,block}){
   const source=await trusted(owner,requestId);
   if(typeof signature!=='string'||!signature||typeof transactionBase64!=='string'||!transactionBase64||transactionBase64.length>1644||!Number.isSafeInteger(block?.lastValidBlockHeight))throw conflict();
   let row=await journal.latest(source.operationId);
   if(row&&row.descriptor!==source.descriptor)throw conflict();
   if(row?.status==='finalized'&&row.result?.credited===true)return state(row,source,requestId);
   if(!row)row=await journal.prepare({operationId:source.operationId,descriptor:source.descriptor,prepared:{intent:source.intent,requestId,block,unsigned:null,kind:'creation'},previous:null});
   if(row.prepared?.kind!=='creation')throw conflict();
   if(row.status==='prepared'){await journal.sign({operationId:row.operationId,attempt:row.attempt,signedBase64:transactionBase64,signature});row=await journal.get(row.operationId,row.attempt);}
   if(row.signature!==signature||row.signedBase64!==transactionBase64)throw conflict();
   await network();
   return credit(row,source,requestId,{kind:'creation',signature});
  },
  async resume(owner,{requestId},{signal}={}){
   const source=await trusted(owner,requestId),row=await journal.latest(source.operationId);
   if(!row||row.status==='prepared')return state(row,source,requestId);
   if(row.descriptor!==source.descriptor)throw conflict();
   const pending=reason=>({...state(row,source,requestId),status:'pending',action:'resume',reason});
   if(['failed','expired'].includes(row.status))return state(row,source,requestId);
   try{await network();}catch{return pending('network-unavailable');}
   if(row.status==='finalized'){if(row.result?.credited===true)return state(row,source,requestId);return credit(row,source,requestId,row.result??{});}
   let chain;try{chain=await bounded(()=>packetStatus(connection,row.signature,row.prepared.block));}catch{return pending('confirmation-unavailable');}
   if(['failed','expired'].includes(chain.status)){
    const saved=await journal.progress({operationId:row.operationId,attempt:row.attempt,from:row.status,to:chain.status,result:{...chain,reason:chain.status==='failed'?chain.error??'transaction failed':'blockhash-expired'}});
    return state(saved,source,requestId);
   }
   if(chain.status==='confirmed'&&chain.finalized){
    try{return await credit(row,source,requestId,chain);}catch(error){return pending(error.code==='IDEMPOTENCY_CONFLICT'?'credit-evidence-mismatch':'credit-pending');}
   }
   if(chain.status==='confirmed'){if(row.status==='signed')await journal.progress({operationId:row.operationId,attempt:row.attempt,from:'signed',to:'confirmed',result:chain});return pending('awaiting-finality');}
   if(chain.observed||signal?.aborted)return pending('confirmation-pending');
   try{const s=await bounded(()=>connection.sendRawTransaction(Buffer.from(row.signedBase64,'base64'),{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0}));if(s!==row.signature)throw Error('Unexpected reserve signature');}catch{return pending('submission-unresolved');}
   return pending('submitted');
  },
  async recover(owner,{requestId}){
   const source=await trusted(owner,requestId),row=await journal.latest(source.operationId);
   if(!row||!['failed','expired'].includes(row.status))return state(row,source,requestId);
   return this.prepare(owner,{requestId});
  },
 };
}
