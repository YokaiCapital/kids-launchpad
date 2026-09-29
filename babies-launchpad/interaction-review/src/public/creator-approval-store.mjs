// Store only the already approved packet. No wallet keys or session credentials.
export function createApprovalStore({owner,network,programId,requestId,indexedDB=globalThis.indexedDB}={}){
 if(!indexedDB)return null;
 const key=JSON.stringify([network,programId,owner,requestId]);let database;
 const open=()=>database??=new Promise((resolve,reject)=>{
  const request=indexedDB.open('kids-creator-approvals',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('approvals');
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('Could not open saved approvals'));
 });
 async function operation(mode,fn){
  const db=await open();return new Promise((resolve,reject)=>{
   const tx=db.transaction('approvals',mode),request=fn(tx.objectStore('approvals'));
   tx.oncomplete=()=>resolve(request.result??null);tx.onerror=tx.onabort=()=>reject(Error('Could not preserve the wallet approval'));
  });
 }
 return {load:()=>operation('readonly',s=>s.get(key)),save:value=>operation('readwrite',s=>s.put(value,key)),clear:()=>operation('readwrite',s=>s.delete(key))};
}
export async function withCreationLock(key,fn){
 if(!globalThis.navigator?.locks)return fn();
 return navigator.locks.request('kids-approval:'+key,{ifAvailable:true},lock=>{
  if(!lock)throw Error('This launch is already open for approval in another tab.');return fn();
 });
}
