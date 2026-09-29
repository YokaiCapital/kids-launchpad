// Operator outbox: stable semantic identity -> immutable prepared packet -> immutable
// signed packet -> chain verdict. No private key enters the journal. All broadcasts,
// including recovery, use persisted bytes. A network error is never proof of failure.
import {createPublicKey,verify} from 'node:crypto';
import {PublicKey,TransactionMessage,VersionedTransaction,ComputeBudgetProgram} from '@solana/web3.js';
import {pinLookupTables,pinCompiledLookups,MAX_LOOKUP_TABLES} from '../signer/lookup-resolution.mjs';
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes){let n=BigInt('0x'+(Buffer.from(bytes).toString('hex')||'0')),out='';while(n>0n){out=B58[Number(n%58n)]+out;n/=58n;}for(const b of bytes){if(b!==0)break;out='1'+out;}return out;}
const instructionIntent=ix=>({program:ix.programId.toBase58(),keys:ix.keys.map(k=>({key:k.pubkey.toBase58(),signer:k.isSigner,writable:k.isWritable})),data:Buffer.from(ix.data).toString('base64')});
const facts=row=>({packetRef:{operationId:row.operationId,attempt:row.attempt},signature:row.signature,blockhash:row.prepared.blockhash,lastValidBlockHeight:row.prepared.lastValidBlockHeight,...row.prepared.facts});
const success=row=>({status:'confirmed',...facts(row),slot:row.result?.slot??null});
const errorText=e=>typeof e==='string'?e:Array.isArray(e?.InstructionError)&&e.InstructionError[1]?.Custom!==undefined?'instruction '+e.InstructionError[0]+': custom program error: 0x'+Number(e.InstructionError[1].Custom).toString(16):JSON.stringify(e);
const unknown=row=>({status:'unknown',...facts(row)});
export async function observedBlockhash(connection,commitment='confirmed'){
 const reply=await connection.getLatestBlockhashAndContext(commitment);
 if(!Number.isSafeInteger(reply?.context?.slot)||reply.context.slot<1)throw Error('Blockhash observation slot unavailable');
 if(!Number.isSafeInteger(reply.value?.lastValidBlockHeight)||reply.value.lastValidBlockHeight<1)throw Error('Blockhash validity unavailable');
 return {...reply.value,observedSlot:reply.context.slot};
}

/** RPC errors propagate so a caller retains uncertainty. An absent signature only
 * expires after FINALIZED block height has passed validity and a second history read
 * agrees while the entire signing window is still retained. A missing/pruned
 * history is uncertainty, never replacement permission. */
export async function packetStatus(connection,signature,packet){
 const read=async()=>{const response=await connection.getSignatureStatuses([signature],{searchTransactionHistory:true});if(!Array.isArray(response?.value)||response.value.length!==1)throw Error('Signature status response unavailable');return response;};
 const verdict=s=>!s?null:s.err?(s.confirmationStatus==='finalized'?{status:'failed',error:errorText(s.err),slot:s.slot}:{status:'unresolved',observed:true}):['confirmed','finalized'].includes(s.confirmationStatus)?{status:'confirmed',finalized:s.confirmationStatus==='finalized',slot:s.slot}:{status:'unresolved',observed:true};
 let response=await read(),v=verdict(response.value[0]);if(v)return v;
 if(Number.isSafeInteger(packet?.lastValidBlockHeight)){
  const {blockHeight,absoluteSlot}=await connection.getEpochInfo('finalized');
  if(Number.isSafeInteger(blockHeight)&&blockHeight>packet.lastValidBlockHeight){
   const observed=packet.observedSlot;
   if(!Number.isSafeInteger(observed)||observed<1||typeof connection.getFirstAvailableBlock!=='function')return {status:'unresolved',observed:false};
   const retained=async()=>{const first=await connection.getFirstAvailableBlock();return Number.isSafeInteger(first)&&first>=0&&first<=observed;};
   if(!await retained())return {status:'unresolved',observed:false};
   response=await read();v=verdict(response.value[0]);if(v)return v;
   // A load-balanced RPC may answer from a lagging node. Its history view must
   // be at least as recent as the finalized expiry observation.
   if(!Number.isSafeInteger(absoluteSlot)||!Number.isSafeInteger(response.context?.slot)||response.context.slot<absoluteSlot)return {status:'unresolved',observed:false};
   if(!await retained())return {status:'unresolved',observed:false};
   return {status:'expired',blockHeight};
  }
 }
 return {status:'unresolved',observed:false};
}

export function createDurableSender({connection,keeper,journal,genesisHash,programId,commitment='confirmed',preflightCommitment='confirmed',confirmationWaitMs=null,calls,log=()=>{},checkpoint=async()=>{}}){
 if(!journal?.latest||!journal?.prepare||!journal?.sign||!journal?.progress)throw Error('Operator packet journal required before sending');
 if(!['confirmed','finalized'].includes(commitment))throw Error('Operator confirmation must be confirmed or finalized');
 // The preflight simulates on a bank of its own commitment: a time-gated instruction (a launch right after its deadline) would be
 // refused by a finalized bank whose clock is still behind, so the preflight runs at confirmed; finality is proven afterwards.
 if(!['confirmed','finalized'].includes(preflightCommitment))throw Error('Operator preflight must be confirmed or finalized');
 if(confirmationWaitMs!==null&&(!Number.isInteger(confirmationWaitMs)||confirmationWaitMs<0||confirmationWaitMs>30000))throw Error('Invalid operator confirmation wait');
 const accepted=row=>row?.status==='finalized'||commitment==='confirmed'&&row?.status==='confirmed';
 // `lookupTables`: addresses of the lookup tables the packet may compile through (funding-first launch packets). They
 // are read at finalized commitment, must be active, warm and keeper-owned or frozen, and their contents are pinned into
 // the prepared packet so the signer proves and every reader recompiles the same resolution (signer/lookup-resolution.mjs).
 // `coSign(tx, ref)` (optional): custody co-signing of the reserved signers of a funding-first launch. The attempt is journaled
 // FIRST with empty custody slots, then the custody signs that exact journaled message, then the signatures are attached to the
 // same attempt (compare-and-set). A lost custody answer or a crash in between resumes on the next send: the journaled message is
 // re-presented (the custody returns the same signatures for the same bytes) and attached; nothing is rebuilt. The accounting
 // budget keeps refusing a prepared packet without valid auxiliary signatures.
 return async function send(input,{operationId,campaign,operationKey=null,fencingToken=null,signal=null,holds=null,computeUnits=200000,label='send',intent=null,extraSigners=[],lookupTables=[],coSign=null}={}){
  if(coSign!==null&&typeof coSign!=='function')throw Error('Custody co-signer must be a function');
  const spki=k=>createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(k.toBytes())]),format:'der',type:'spki'});
  /** Custody signatures for a journaled prepared attempt: skipped when the row already carries valid ones, otherwise requested for
   * the exact journaled message and attached with a compare-and-set. Any deviation attaches nothing. */
  const custody=async row=>{
   const journaled=VersionedTransaction.deserialize(Buffer.from(row.prepared.base64,'base64')),bytes=Buffer.from(journaled.message.serialize()),n=journaled.message.header.numRequiredSignatures;
   const complete=[...Array(n).keys()].slice(1).every(i=>verify(null,bytes,spki(journaled.message.staticAccountKeys[i]),Buffer.from(journaled.signatures[i])));
   if(n<2||complete)return row;
   const signed=await coSign(journaled,{operationId:row.operationId,attempt:row.attempt,message:bytes,lookups:row.prepared.lookups??null});
   if(!(signed instanceof VersionedTransaction)||!Buffer.from(signed.message.serialize()).equals(bytes))throw Error('Custody changed the operator message');
   for(let i=1;i<n;i++)if(!verify(null,bytes,spki(signed.message.staticAccountKeys[i]),Buffer.from(signed.signatures[i])))throw Error('Custody returned an invalid auxiliary signature');
   if(!journaled.signatures[0].every(b=>b===0)||!signed.signatures[0].every(b=>b===0))throw Error('Custody must not sign for the keeper');
   return journal.attachAuxiliary({operationId:row.operationId,attempt:row.attempt,prepared:{...row.prepared,base64:Buffer.from(signed.serialize()).toString('base64')},previousPrepared:row.prepared});
  };
  if(typeof operationId!=='string'||!operationId||operationId.length>512||typeof campaign!=='string'||!campaign)throw Error('Stable operation and campaign identity required');
  if(!Number.isInteger(computeUnits)||computeUnits<1||computeUnits>1400000)throw Error('Invalid compute budget');
  if(typeof input==='function'&&!intent)throw Error('Lazy operator build needs immutable semantic intent');
  if(!Array.isArray(lookupTables)||lookupTables.length>MAX_LOOKUP_TABLES)throw Error('Invalid lookup tables');
  const tableKeys=lookupTables.map(t=>new PublicKey(t).toBase58());if(new Set(tableKeys).size!==tableKeys.length)throw Error('Duplicate lookup table');
  const operation=canonicalHash({genesisHash,programId,campaign,operationId});
  const descriptor=canonicalJson({genesisHash,programId,campaign,operationId,operationKey,payer:keeper.publicKey.toBase58(),computeUnits,intent:intent??input.map(instructionIntent),...(tableKeys.length?{lookupTables:tableKeys}:{})});
  const guarded=async()=>{if(signal?.aborted||holds&&!await holds())throw Object.assign(Error('Operator job lease no longer held'),{code:'STALE_LEASE'});};
  await guarded();
  let row=await journal.latest(operation);
  if(row&&row.descriptor!==descriptor)throw Object.assign(Error('Operator operation parameters changed'),{code:'IDEMPOTENCY_CONFLICT'});
  if(accepted(row))return success(row);
  // A previous confirmed consumer cannot satisfy a finalized consumer. Keep the
  // immutable packet and wait; neither a timeout nor a fork permits a replacement.
  if(row?.status==='confirmed'){
   let state;try{state=await packetStatus(connection,row.signature,row.prepared);}catch{calls.unknown++;return unknown(row);}
   if(state.status==='confirmed'&&state.finalized){row=await journal.progress({operationId:operation,attempt:row.attempt,from:'confirmed',to:'finalized',result:state});return accepted(row)?success(row):unknown(row);}
   calls.unknown++;return unknown(row);
  }
  // Always reconcile a stored signed packet before considering a replacement.
  if(row?.status==='signed'){
   let state;try{state=await packetStatus(connection,row.signature,row.prepared);}catch{calls.unknown++;return unknown(row);}
   if(state.status==='confirmed'){
    if(commitment==='finalized'&&!state.finalized){calls.unknown++;return unknown(row);}
    row=await journal.progress({operationId:operation,attempt:row.attempt,from:'signed',to:state.finalized?'finalized':'confirmed',result:state});return accepted(row)?success(row):unknown(row);
   }
   if(['failed','expired'].includes(state.status)){
    row=await journal.progress({operationId:operation,attempt:row.attempt,from:'signed',to:state.status,result:state});
    if(['confirmed','finalized'].includes(row.status))return accepted(row)?success(row):unknown(row);
    return {status:'failed',...facts(row),error:state.error??'Previous packet expired; re-read chain before a fresh attempt'};
   }
   if(state.observed){calls.unknown++;return unknown(row);}
  }
  if(!row||['failed','expired'].includes(row.status)){
   await guarded();
   const block=await observedBlockhash(connection,commitment);
   if(!Number.isSafeInteger(block.lastValidBlockHeight)||block.lastValidBlockHeight<1)throw Error('Blockhash validity unavailable');
   const built=typeof input==='function'?await input():{instructions:input,extraSigners,facts:{}};
   const read=tableKeys.length?await pinLookupTables(connection,tableKeys,{payer:keeper.publicKey}):null;
   const message=new TransactionMessage({payerKey:keeper.publicKey,recentBlockhash:block.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:computeUnits}),...built.instructions]}).compileToV0Message(read?read.tables:[]);
   const lookups=read?pinCompiledLookups(message,read):[];
   const tx=new VersionedTransaction(message);
   if(built.extraSigners?.length)tx.sign(built.extraSigners);
   const wire=tx.serialize();if(wire.length>1232)throw Error('Operator transaction exceeds packet limit');
   row=await journal.prepare({operationId:operation,descriptor,previous:row?.attempt??null,prepared:{base64:Buffer.from(wire).toString('base64'),...block,...(lookups.length?{lookups,lookupSlot:read.slot}:{}),facts:built.facts??{}}});
   await checkpoint('prepared',row);
   if(['confirmed','finalized'].includes(row.status))return accepted(row)?success(row):unknown(row);
   // A concurrent attempt may already have advanced; do not build/sign against it.
   if(!['prepared','signed'].includes(row.status))return {status:'failed',...facts(row),error:'Concurrent operator attempt resolved; re-read chain'};
   if(row.status==='signed')return unknown(row);
  }
  if(row.status==='prepared'){
   if(await connection.getBlockHeight('finalized')>row.prepared.lastValidBlockHeight){
    const updated=await journal.progress({operationId:operation,attempt:row.attempt,from:'prepared',to:'expired'});
    if(updated.status==='signed')return unknown(updated);
    return {status:'failed',signature:null,error:'Unsigned packet expired; re-read chain before rebuilding'};
   }
   await guarded();
   if(coSign)row=await custody(row);
   const tx=VersionedTransaction.deserialize(Buffer.from(row.prepared.base64,'base64'));
   const message=Buffer.from(tx.message.serialize());
   // Fixed-length hash includes the entire identity AND exact message, avoiding truncation collisions.
   const attemptId='op:'+canonicalHash({operation,attempt:row.attempt,message:message.toString('base64')});
   await keeper.sign(tx,{operationId:attemptId,campaign,fencingToken,operationKey,packetRef:{operationId:operation,attempt:row.attempt}});
   if(!message.equals(Buffer.from(tx.message.serialize())))throw Error('Operator signer changed approved message');
   for(let i=0;i<tx.message.header.numRequiredSignatures;i++){
    const publicKey=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(tx.message.staticAccountKeys[i].toBytes())]),format:'der',type:'spki'});
    if(!verify(null,message,publicKey,Buffer.from(tx.signatures[i])))throw Error('Operator packet has an invalid signature');
   }
   row=await journal.sign({operationId:operation,attempt:row.attempt,signedBase64:Buffer.from(tx.serialize()).toString('base64'),signature:base58(tx.signatures[0])});
   if(['confirmed','finalized'].includes(row.status))return accepted(row)?success(row):unknown(row);
   if(row.status!=='signed')return {status:'failed',...facts(row),error:'Operator attempt already resolved; re-read chain'};
   await checkpoint('signed',row);
  }
  await guarded();
  // Persist succeeded above; the worker can now die without losing transaction identity.
  calls.sent++;
  try{await connection.sendRawTransaction(Buffer.from(row.signedBase64,'base64'),{skipPreflight:false,preflightCommitment,maxRetries:0});}
  catch{calls.unknown++;log({event:'v2-send-unknown',label,signature:row.signature});return unknown(row);}
  await checkpoint('broadcast',row);
  // V3 workers reconcile from the durable job on a later pass. Do not create
  // SDK background confirmation subscriptions in this mode: their independent
  // status probe may reject outside the caller's cancellation/error boundary.
  if(confirmationWaitMs===0){calls.unknown++;return unknown(row);}
  let timer=null,abort=null;
  const controller=new AbortController();
  try{
   const cancelled=new Promise((_,reject)=>{
    abort=()=>{controller.abort();reject(Error('Operator confirmation interrupted'));};
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
    if(confirmationWaitMs!==null)timer=setTimeout(abort,confirmationWaitMs);
   });
   const confirmed=await Promise.race([connection.confirmTransaction({signature:row.signature,blockhash:row.prepared.blockhash,lastValidBlockHeight:row.prepared.lastValidBlockHeight,abortSignal:controller.signal},commitment),cancelled]);
   // Even preflight or confirmed execution errors await a final chain verdict; a
   // prior broadcaster may have submitted the same packet on another fork.
   if(confirmed.value.err){calls.unknown++;return unknown(row);}
   row=await journal.progress({operationId:operation,attempt:row.attempt,from:'signed',to:commitment==='finalized'?'finalized':'confirmed',result:{slot:confirmed.context.slot}});
   calls.confirmed++;return accepted(row)?success(row):unknown(row);
  }catch{calls.unknown++;return unknown(row);}
  finally{if(timer!==null)clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort);}
 };
}
