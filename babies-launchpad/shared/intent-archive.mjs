// Single-writer immutable audit objects + exact-key replay references.
// Callers must retain unresolved intents and consult lookup before creating a request.
import * as fs from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {writeDurableJson} from './durable-json.mjs';
const digest=s=>createHash('sha256').update(s).digest('hex');
const json=value=>JSON.stringify(value);
const hashPattern=/^[a-f0-9]{64}$/;
function syncDirectory(path){const fd=fs.openSync(path,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function mkdir(path){if(!fs.existsSync(path)){mkdir(dirname(path));fs.mkdirSync(path,{mode:0o700});syncDirectory(path);syncDirectory(dirname(path));}}
function immutable(path,body){
 const temporary=path+'.'+randomUUID()+'.tmp';let fd;
 try{fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,body);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  try{fs.linkSync(temporary,path);}catch(error){if(error.code!=='EEXIST')throw error;if(fs.readFileSync(path,'utf8')!==body)throw Error('Archive object content collision');}
  syncDirectory(dirname(path));
 }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
export function createIntentArchive({directory,identity}){
 if(!identity||typeof identity!=='object'||!Object.keys(identity).length)throw Error('Archive identity required');
 // Namespace identity is canonicalized once; integrations separately revalidate each record’s ledger identity before replay.
 const binding=JSON.parse(json(identity)),bound=json(binding),objects=join(directory,'objects'),refs=join(directory,'refs');
 const filename=key=>{if(typeof key!=='string'||!key.length||key.length>512)throw Error('Invalid archive lookup key');return digest(key);};
 function lookup(key){
  const path=join(refs,filename(key)+'.json');if(!fs.existsSync(path))return null;
  const ref=JSON.parse(fs.readFileSync(path,'utf8'));if(ref.version!==1||ref.key!==key||ref.identity!==bound||!hashPattern.test(ref.object))throw Error('Archive reference identity mismatch');
  const body=fs.readFileSync(join(objects,ref.object+'.json'),'utf8');if(digest(body)!==ref.object)throw Error('Archive object checksum mismatch');
  const record=JSON.parse(body);if(record.version!==1||record.key!==key||record.identity!==bound)throw Error('Archive object identity mismatch');
  return {...record,object:ref.object};
 }
 function append(key,value,proof){
  filename(key);lookup(key); // Existing namespace or corrupt references must fail closed.
  if(!proof||!['finalized-success','finalized-failure','finalized-expiry'].includes(proof.kind)||!Number.isSafeInteger(proof.observedAt)||proof.observedAt<0)throw Error('Finalized terminal proof required');
  if(proof.kind==='finalized-expiry'){
   if(!Number.isSafeInteger(proof.finalizedBlockHeight)||!Number.isSafeInteger(proof.lastValidBlockHeight)||proof.lastValidBlockHeight<0||proof.finalizedBlockHeight<=proof.lastValidBlockHeight)throw Error('Invalid finalized expiry proof');
  }else if(typeof proof.signature!=='string'||!proof.signature||!Number.isSafeInteger(proof.slot)||proof.slot<0)throw Error('Invalid finalized signature proof');
  const record={version:1,key,identity:bound,value,proof},body=json(record)+'\n',object=digest(body);
  mkdir(directory);mkdir(objects);mkdir(refs);immutable(join(objects,object+'.json'),body);
  writeDurableJson(join(refs,filename(key)+'.json'),{version:1,key,identity:bound,object});
  return {...record,object};
 }
 function readObject(key,object){
  if(!hashPattern.test(object))throw Error('Invalid archive object reference');
  const body=fs.readFileSync(join(objects,object+'.json'),'utf8');if(digest(body)!==object)throw Error('Archive object checksum mismatch');
  const record=JSON.parse(body);if(record.version!==1||record.key!==key||record.identity!==bound)throw Error('Archive object identity mismatch');return {...record,object};
 }
 function checkpoint(previous,key,object){
  const body=json({version:1,identity:bound,previous:previous||null,key,object})+'\n',head=digest(body),heads=join(directory,'heads');mkdir(heads);immutable(join(heads,head+'.json'),body);return head;
 }
 function restoreIndex(marker){
  const index=new Map();if(!marker)return index;
  if(marker.version!==1||!Number.isSafeInteger(marker.count)||marker.count<1||!hashPattern.test(marker.head))throw Error('Invalid archive checkpoint marker');
  let head=marker.head,count=0;const seen=new Set();
  while(head){
   if(!hashPattern.test(head)||seen.has(head)||++count>marker.count)throw Error('Invalid archive checkpoint chain');seen.add(head);
   const body=fs.readFileSync(join(directory,'heads',head+'.json'),'utf8');if(digest(body)!==head)throw Error('Archive checkpoint checksum mismatch');
   const row=JSON.parse(body);if(row.version!==1||row.identity!==bound)throw Error('Archive checkpoint identity mismatch');
   readObject(row.key,row.object);if(!index.has(row.key))index.set(row.key,row.object);head=row.previous;
  }
  if(count!==marker.count)throw Error('Incomplete archive checkpoint chain');return index;
 }
 return {lookup,append,readObject,checkpoint,restoreIndex};
}
// RPC policy is explicit and conservative. Confirmed != finalized; a failed status
// is not definitive until finalized. Missing history alone is never sufficient.
export async function finalizedIntentProof(connection,{signature,lastValidBlockHeight},now=Date.now){
 const status=signature?(await connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0]:null;
 if(status){
  if(status.confirmationStatus!=='finalized')return null;
  return {kind:status.err?'finalized-failure':'finalized-success',signature,slot:status.slot,observedAt:now(),...(status.err?{error:status.err}:{})};
 }
 if(signature)return null; // Pruned signed history is unresolved, even after block expiry.
 if(!Number.isSafeInteger(lastValidBlockHeight)||lastValidBlockHeight<0)return null;
 const finalizedBlockHeight=await connection.getBlockHeight('finalized');
 if(!Number.isSafeInteger(finalizedBlockHeight)||finalizedBlockHeight<=lastValidBlockHeight)return null;
 return {kind:'finalized-expiry',...(signature?{signature}:{}),lastValidBlockHeight,finalizedBlockHeight,observedAt:now()};
}
// Bounded compaction. describe must bind each row to the correct ledger before
// returning a connection/signature/blockheight; isBusy protects active requests.
export async function compactIntentHistory({intents,archive,describe,persist,isBusy=()=>false,limit=100,cursor=null,now=Date.now,onArchived=()=>()=>{}}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw Error('Invalid compaction limit');
 let inspected=0,archived=0,nextCursor=cursor;const keys=Object.keys(intents).sort(),start=cursor===null?0:keys.findIndex(key=>key>cursor);
 for(const key of keys.slice(start<0?0:start)){
  if(inspected>=limit)break;nextCursor=key;if(isBusy(key))continue;inspected++;
  const value=intents[key],snapshot=json(value),description=await describe(value,key);if(!description)continue;
  const proof=await finalizedIntentProof(description.connection,description,now);if(!proof||isBusy(key)||json(intents[key])!==snapshot)continue;
  // No await from this point through persist: another request cannot interleave.
  const record=archive.append(key,value,proof),rollback=onArchived(key,record);delete intents[key];
  try{persist();}catch(error){intents[key]=value;rollback();throw error;}
  archived++;
 }
 return {inspected,archived,cursor:nextCursor};
}
