// Startup reconciliation against the chain (docs/ENGINEERING-RULES.md). Independent of archival thresholds: EVERY hot
// row that was signed and has no recorded outcome is looked up on the chain in bounded batches before financial
// writes reopen. Outcomes are persisted so a restart never re-asks the same question. Classification:
//   finalized/confirmed success  -> success field set (confirmedSignature or confirmed=true)
//   finalized failure            -> closedReason 'failed' (+ chainError)
//   not found, blockhash expired -> closedReason 'expired'   (cannot land any more)
//   not found, still valid / processed / non-final error -> unresolvedSigned (keeps writes closed; resolves within the
//   blockhash validity window, about 90 s, on the next pass)
import {ARCHIVE_MARKER} from '../shared/intent-retention.mjs';import {VersionedTransaction} from '@solana/web3.js';import {encodeBase58} from '../shared/solana.mjs';
export function signatureOf(row){
 if(!row||typeof row!=='object')return null;
 if(row.submittedSignature)return row.submittedSignature;if(row.signature)return row.signature;
 if(row.signedTransactionBase64){try{return encodeBase58(VersionedTransaction.deserialize(Buffer.from(row.signedTransactionBase64,'base64')).signatures[0]);}catch{return null;}}
 return null;
}
const isResolved=(row,successField)=>!!(row[successField]||row.archivedProof||row.closedReason);
/** True when a journal has no signed row without an outcome: nothing to ask the chain about. */
export function hasPendingSigned(intents,successField='confirmedSignature'){
 for(const [key,row] of Object.entries(intents)){if(key===ARCHIVE_MARKER||!row||typeof row!=='object')continue;const wasSigned=!!(row.submittedSignature||row.signedTransactionBase64||row.signature||row.signed===true||row.signed);if(wasSigned&&!isResolved(row,successField))return true;}
 return false;
}
export async function reconcileSignedIntents({service,intents,connection,successField='confirmedSignature',persist=()=>{},batchSize=100,deadlineMs=120000,now=Date.now,log=()=>{}}){
 const started=now();let hot=0,signed=0,checked=0,resolvedSuccess=0,resolvedFailed=0,expired=0,unresolvedSigned=0,unchecked=0;
 const pending=[];
 for(const [key,row] of Object.entries(intents)){
  if(key===ARCHIVE_MARKER||!row||typeof row!=='object')continue;hot+=1;
  const wasSigned=!!(row.submittedSignature||row.signedTransactionBase64||row.signature||row.signed===true||row.signed);if(!wasSigned)continue;signed+=1;
  if(isResolved(row,successField))continue;
  const signature=signatureOf(row);if(!signature){unresolvedSigned+=1;continue;}
  pending.push({key,row,signature});
 }
 let finalizedHeight=null;
 for(let i=0;i<pending.length;i+=batchSize){
  if(now()-started>deadlineMs){unchecked+=pending.length-i;unresolvedSigned+=pending.length-i;break;}
  const batch=pending.slice(i,i+batchSize);
  const statuses=(await connection.getSignatureStatuses(batch.map(p=>p.signature),{searchTransactionHistory:true})).value;
  for(let j=0;j<batch.length;j++){
   const {row,signature}=batch[j],status=statuses[j];checked+=1;
   if(status&&!status.err&&['confirmed','finalized'].includes(status.confirmationStatus)){row[successField]=successField==='confirmed'?true:signature;resolvedSuccess+=1;continue;}
   if(status?.err&&status.confirmationStatus==='finalized'){row.closedReason='failed';row.chainError=JSON.stringify(status.err).slice(0,200);resolvedFailed+=1;continue;}
   if(!status){
    const lastValid=Number(row.block?.lastValidBlockHeight);
    if(Number.isFinite(lastValid)){if(finalizedHeight===null)finalizedHeight=await connection.getBlockHeight('finalized');if(finalizedHeight>lastValid){row.closedReason='expired';expired+=1;continue;}}
   }
   unresolvedSigned+=1;
  }
  persist();log({event:'chain-reconcile-progress',service,checked,of:pending.length});
 }
 const summary={service,hot,signed,checked,resolvedSuccess,resolvedFailed,expired,unresolvedSigned,unchecked,complete:unchecked===0,ms:now()-started};
 log({event:'chain-reconcile',...summary});return summary;
}
/** Operator journals ({attempts:{id:{signature,block,confirmed?,closedReason?}}}): same classification, same persistence rules as the sender. */
export async function reconcileOperatorJournal({service,journal,connection,persist=()=>{},now=Date.now,log=()=>{}}){
 const attempts=journal?.attempts||{};const rows={};
 for(const [id,a] of Object.entries(attempts)){if(!a||typeof a!=='object'||a.confirmed||a.closedReason)continue;rows[id]={signature:a.signature,block:a.block,signed:true};}
 const summary=await reconcileSignedIntents({service,intents:rows,connection,successField:'confirmedSignature',persist:()=>{},now,log:()=>{}});
 for(const [id,r] of Object.entries(rows)){const a=attempts[id];if(r.confirmedSignature)a.confirmed=true;else if(r.closedReason){attempts[id+':'+(a.createdAt||now())]={...a,closedReason:r.closedReason,chainError:r.chainError};delete attempts[id];if(journal.current?.id===id)journal.current=null;}}
 if(summary.checked)persist();
 log({event:'chain-reconcile',...summary});return summary;
}
