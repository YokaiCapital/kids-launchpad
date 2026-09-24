import {createHash} from 'node:crypto';
// One writer per runtime. All retries durably retain exactly the signed bytes.
import {VersionedTransaction} from '@solana/web3.js';
import {encodeBase58} from '../shared/solana.mjs';
/** The signer accepts operation ids of at most 120 characters. Journal ids stay descriptive (an extend step lists its
 * addresses); the id sent to the signer is the same string when it fits and its hash otherwise, so every journal id
 * still maps to exactly one signer operation. */
export function signerOperationId(id){return id.length<=120?id:'sha256:'+createHash('sha256').update(id).digest('hex');}
export function createOperatorSender({connection:c,journal,persist,now=Date.now,resendIntervalMs=2000,confirmationTimeoutMs=120000}) {
 const pending=new Map();
 return function send(id,build) {
  if(pending.has(id))return pending.get(id);
  const action=(async()=>{
   let old=journal.attempts[id];
   if(old){
    const status=(await c.getSignatureStatuses([old.signature],{searchTransactionHistory:true})).value[0];
    if(status&&!status.err&&['confirmed','finalized'].includes(status.confirmationStatus))return old.signature;
    const failed=!!status?.err&&status.confirmationStatus==='finalized';
    const expired=!status&&await c.getBlockHeight('finalized')>old.block.lastValidBlockHeight;
    if(failed||expired){journal.attempts[id+':'+old.createdAt]={...old,closedReason:failed?'failed':'expired'};delete journal.attempts[id];old=null;persist();}
   }
   if(!old){
    // A rebuilt attempt (the previous one expired or failed on chain, verified above) is a NEW signer operation: the
    // signer's replay guard binds an id to one exact message for 24 h, so the id carries this attempt's blockhash.
    const block=await c.getLatestBlockhash('confirmed'),tx=await build(block,signerOperationId(id+':'+block.blockhash));
    const signature=encodeBase58(tx instanceof VersionedTransaction?tx.signatures[0]:tx.signature);
    old={block,signature,wire:Buffer.from(tx.serialize()).toString('base64'),createdAt:now()};journal.attempts[id]=old;
   }
   // An earlier persistence error leaves in-memory state: re-persist on EVERY send.
   persist();
   const signature=await c.sendRawTransaction(Buffer.from(old.wire,'base64'),{skipPreflight:false,maxRetries:3});
   if(signature!==old.signature)throw Error('Operator signature mismatch');
   // RPC acceptance is not inclusion. Re-send the same durable wire while
   // confirmation is pending; never build another transaction on this timer.
   let stopped=false,resending=null,lastResendError,timeout;
   const abort=new AbortController();
   const timer=setInterval(()=>{
    if(stopped||resending)return;
    resending=(async()=>{try{persist();await c.sendRawTransaction(Buffer.from(old.wire,'base64'),{skipPreflight:false,maxRetries:3,preflightCommitment:'confirmed'});}catch(error){lastResendError=error;}finally{resending=null;}})();
   },resendIntervalMs);
   let result;
   try{result=await Promise.race([c.confirmTransaction({...old.block,signature,abortSignal:abort.signal},'confirmed'),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Operator confirmation unresolved; retry saved transaction'+(lastResendError?': '+lastResendError.message:''))),confirmationTimeoutMs);})]);}
   finally{stopped=true;clearInterval(timer);clearTimeout(timeout);abort.abort();if(resending)await resending;}
   if(result.value.err)throw Error('Operator transaction failed: '+JSON.stringify(result.value.err));
   old.confirmed=true;persist();return signature;
  })();
  pending.set(id,action);action.finally(()=>pending.delete(id)).catch(()=>{});return action;
 };
}
