import {createIntentArchive,compactIntentHistory} from './intent-archive.mjs';
export const ARCHIVE_MARKER='__kidsIntentArchive';
export const intentHistorySize=intents=>Object.keys(intents).length-(intents[ARCHIVE_MARKER]?1:0);
// Each hot journal points to a committed immutable archive chain. Its full chain
// and objects must validate at startup: incomplete backups cannot create duplicates.
export function createIntentRetention({file,service,intents,persist,describe,isBusy=()=>false,successField='confirmedSignature',threshold=9000}){
 const archive=createIntentArchive({directory:file+'.archive',identity:{service,schema:1}}),index=archive.restoreIndex(intents[ARCHIVE_MARKER]);let cursor=null,pending=null;
 function lookup(key){
  if(key===ARCHIVE_MARKER)return null;if(intents[key])return intents[key];const object=index.get(key);if(!object)return null;
  const record=archive.readObject(key,object),value=record.value;
  if(record.proof.kind==='finalized-success')value[successField]=successField==='confirmed'?true:record.proof.signature;
  Object.defineProperty(value,'archivedProof',{value:record.proof,enumerable:false});return value;
 }
 function compact(){
  if(Object.keys(intents).length<threshold)return Promise.resolve({archived:0});
  if(pending)return pending;
  // Cache expensive qualified contexts only for this bounded pass, never globally.
  const contexts=new Map(),memo=(key,load)=>{if(!contexts.has(key))contexts.set(key,Promise.resolve().then(load));return contexts.get(key);};
  pending=compactIntentHistory({intents,archive,describe:(value,key)=>key===ARCHIVE_MARKER?null:describe(value,key,memo),persist,isBusy,limit:10,cursor,onArchived:(key,record)=>{
   const prior=intents[ARCHIVE_MARKER],oldObject=index.get(key);
   const head=archive.checkpoint(prior?.head,key,record.object);
   intents[ARCHIVE_MARKER]={version:1,head,count:(prior?.count||0)+1};index.set(key,record.object);
   return()=>{if(prior)intents[ARCHIVE_MARKER]=prior;else delete intents[ARCHIVE_MARKER];if(oldObject)index.set(key,oldObject);else index.delete(key);};
  }}).then(result=>{cursor=result.cursor;return result;}).finally(()=>{pending=null;});return pending;
 }
 return {lookup,compact};
}
/** Startup reconciliation summary of one hot journal: rows that were signed but have no finalized outcome yet.
 * `successField` is 'confirmedSignature' or 'confirmed'; a row with an archived proof is resolved by definition. */
export function summarizeIntents(service,intents,successField='confirmedSignature'){
 let hot=0,signed=0,unresolvedSigned=0;
 for(const [key,row] of Object.entries(intents)){
  if(key===ARCHIVE_MARKER||!row||typeof row!=='object')continue;hot+=1;
  const wasSigned=!!(row.submittedSignature||row.signedTransactionBase64||row.signature||row.signed===true);if(!wasSigned)continue;signed+=1;
  const resolved=!!(row[successField]||row.archivedProof||row.closedReason);if(!resolved)unresolvedSigned+=1;
 }
 return {service,hot,signed,unresolvedSigned};
}
