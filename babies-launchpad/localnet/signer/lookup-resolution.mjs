// Bounded, scoped address-lookup resolution for operator packets. A funding-first launch packet needs 33 accounts and
// only fits a transaction through lookup tables, and the hosted signer refused every lookup-table message until now.
//
// The rule: a packet that uses lookup tables carries its resolution PINNED at prepare time (prepared.lookups, in
// message order: the table's identity, its full contents, and the writable/readonly indexes the message selects, so the
// resolved keys are pinned too). Nothing about a table is ever taken from the signing request or read without a bound.
// Three parties then agree on the same bytes:
//   the worker pins   (pinLookupTables: finalized read, active, warm, keeper-owned or frozen, full contents),
//   the signer proves (provePinnedLookups: the same finalized checks; the ledger's entries start with the pinned ones,
//                      which is enough because table entries are append-only and never change once written),
//   every reader recompiles (resolvePinnedLookups + AddressLookupTableAccount for decompile/compile) so the exact cost
//                      template comparison covers the whole message, lookups included.
// A table entry appended in slot S is usable from slot S + 1, so "warm" means lastExtendedSlot < the finalized slot read.
import {PublicKey,VersionedTransaction,AddressLookupTableAccount,AddressLookupTableProgram} from '@solana/web3.js';
export const MAX_LOOKUP_TABLES=2,MAX_TABLE_ADDRESSES=256;
const U64_MAX=2n**64n-1n;
const b58=v=>{try{const k=new PublicKey(v);return k.toBase58()===v?k:null;}catch{return null;}};
/** Validates the pinned resolution's shape; returns AddressLookupTableAccount[] in pinned order ([] when nothing is pinned). */
export function pinnedLookupTables(lookups){
 if(lookups==null)return [];
 if(!Array.isArray(lookups)||lookups.length>MAX_LOOKUP_TABLES)throw Error('Pinned lookup tables malformed');
 const seen=new Set();
 return lookups.map(entry=>{
  if(!entry||typeof entry!=='object'||Array.isArray(entry)||Object.keys(entry).length!==4)throw Error('Pinned lookup table malformed');
  const key=b58(entry.table);if(!key||seen.has(entry.table))throw Error('Pinned lookup table address invalid');seen.add(entry.table);
  if(!Array.isArray(entry.addresses)||!entry.addresses.length||entry.addresses.length>MAX_TABLE_ADDRESSES)throw Error('Pinned lookup table addresses malformed');
  const addresses=entry.addresses.map(a=>{const k=b58(a);if(!k)throw Error('Pinned lookup table address invalid');return k;});
  const used=new Set();
  for(const k of ['writableIndexes','readonlyIndexes']){
   if(!Array.isArray(entry[k])||entry[k].length>MAX_TABLE_ADDRESSES)throw Error('Pinned lookup indexes malformed');
   for(const i of entry[k]){if(!Number.isInteger(i)||i<0||i>=addresses.length||used.has(i))throw Error('Pinned lookup index invalid');used.add(i);}
  }
  if(!used.size)throw Error('Pinned lookup table selects nothing');
  return new AddressLookupTableAccount({key,state:{deactivationSlot:U64_MAX,lastExtendedSlot:0,lastExtendedSlotStartIndex:0,authority:undefined,addresses}});
 });
}
const same=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
/** Maps a compiled message's lookups onto the pinned tables: the same tables in the same order, every index inside the
 * pinned contents, and a pinned resolution is refused for a message that uses none. Returns the tables and the loaded
 * addresses exactly as the runtime orders them (all writable lookups, then all readonly lookups). */
export function resolvePinnedLookups(message,lookups){
 const tables=pinnedLookupTables(lookups),refs=message.addressTableLookups??[];
 if(refs.length!==tables.length)throw Error('Message lookup tables differ from the pinned resolution');
 const writable=[],readonly=[];
 refs.forEach((ref,i)=>{
  const table=tables[i],pin=lookups[i];if(!new PublicKey(ref.accountKey).equals(table.key))throw Error('Message lookup table differs from the pinned resolution');
  if(!same(Array.from(ref.writableIndexes),pin.writableIndexes)||!same(Array.from(ref.readonlyIndexes),pin.readonlyIndexes))throw Error('Message lookup indexes differ from the pinned resolution');
  for(const [list,indexes] of [[writable,ref.writableIndexes],[readonly,ref.readonlyIndexes]])for(const index of indexes)list.push(table.state.addresses[index]);
 });
 return {tables,loadedAddresses:{writable,readonly}};
}
/** Reads one table at finalized commitment and checks what both the worker and the signer require of it. */
async function readTable(connection,key,owner){
 const reply=await connection.getAccountInfoAndContext(key,'finalized');
 const slot=reply?.context?.slot,info=reply?.value;
 if(!Number.isSafeInteger(slot)||slot<1)throw Error('Lookup table slot unavailable');
 if(!info)throw Error('Lookup table is not on the ledger');
 if(info.executable||!info.owner.equals(AddressLookupTableProgram.programId))throw Error('Lookup table account is not a lookup table');
 const state=AddressLookupTableAccount.deserialize(info.data);
 if(BigInt(state.deactivationSlot)!==U64_MAX)throw Error('Lookup table is deactivated');
 if(!Number.isSafeInteger(state.lastExtendedSlot)||state.lastExtendedSlot>=slot)throw Error('Lookup table is not warm');
 if(state.authority&&String(state.authority)!==owner)throw Error('Lookup table has a foreign authority');
 if(!state.addresses.length||state.addresses.length>MAX_TABLE_ADDRESSES)throw Error('Lookup table is empty or oversized');
 return {slot,state};
}
/** Worker side: reads the tables the packet will be compiled with and pins their full contents. */
export async function pinLookupTables(connection,tableAddresses,{payer}){
 if(!Array.isArray(tableAddresses)||tableAddresses.length>MAX_LOOKUP_TABLES)throw Error('Invalid lookup tables');
 const keys=tableAddresses.map(t=>{const k=b58(String(t));if(!k)throw Error('Invalid lookup table address');return k;});
 if(new Set(keys.map(String)).size!==keys.length)throw Error('Duplicate lookup table');
 const owner=new PublicKey(payer).toBase58();let slot=null;const lookups=[],tables=[];
 for(const key of keys){
  const read=await readTable(connection,key,owner);slot=slot===null?read.slot:Math.min(slot,read.slot);
  lookups.push({table:key.toBase58(),addresses:read.state.addresses.map(String)});
  tables.push(new AddressLookupTableAccount({key,state:{deactivationSlot:U64_MAX,lastExtendedSlot:0,lastExtendedSlotStartIndex:0,authority:undefined,addresses:read.state.addresses}}));
 }
 return {lookups,tables,slot};
}
/** Worker side, after compiling with the read tables: the pinned record for the message, exactly the tables the message
 * uses, in message order, with the indexes it selects (a table the compiler did not use is not pinned). */
export function pinCompiledLookups(message,read){
 const byKey=new Map(read.lookups.map(l=>[l.table,l]));
 const lookups=(message.addressTableLookups??[]).map(ref=>{
  const pin=byKey.get(new PublicKey(ref.accountKey).toBase58());if(!pin)throw Error('Message uses a lookup table that was not read');
  return {table:pin.table,addresses:pin.addresses,writableIndexes:Array.from(ref.writableIndexes),readonlyIndexes:Array.from(ref.readonlyIndexes)};
 });
 resolvePinnedLookups(message,lookups.length?lookups:null);
 return lookups;
}
/** Signer side: proves a pinned resolution on the ledger. The ledger's entries must start with exactly the pinned ones. */
export async function provePinnedLookups(connection,lookups,{payer}){
 const tables=pinnedLookupTables(lookups);if(!tables.length)return {tables,slot:null};
 const owner=new PublicKey(payer).toBase58();let slot=null;
 for(const table of tables){
  const read=await readTable(connection,table.key,owner);
  const pinned=table.state.addresses,live=read.state.addresses;
  if(live.length<pinned.length||pinned.some((a,i)=>!a.equals(live[i])))throw Error('Pinned lookup table differs from the ledger');
  slot=slot===null?read.slot:Math.min(slot,read.slot);
 }
 return {tables,slot};
}
/** The signer service's `resolveLookups` for the v3 registry composition: a lookup-table message is resolved only from
 * the durable packet it names (whose bytes must equal the request), through the pinned resolution, proved on the ledger
 * with a bounded read. A registry or RPC failure is tagged `dependency` (the service answers 503, retry the same
 * operation); everything else is a deterministic refusal (403). */
export function createPinnedLookupResolver({registry,connection,payer,timeoutMs=5000}){
 if(!registry?.operatorPackets||typeof registry.operatorPackets.get!=='function')throw Error('Lookup resolver needs the operator packet journal');
 if(!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw Error('Invalid lookup resolution timeout');
 const owner=new PublicKey(payer).toBase58();
 const dependent=(error,kind)=>{try{if(error&&typeof error==='object'){if(error.code==='CAPACITY_WAIT')return error;if(!error.dependency)error.dependency=kind;return error;}}catch{}return Object.assign(Error('Lookup resolution dependency failed'),{dependency:kind,cause:error});};
 async function bounded(fn){let timer;try{return await Promise.race([Promise.resolve().then(fn).catch(e=>{throw dependent(e,'failure');}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(dependent(Error('Lookup resolution timed out'),'timeout')),timeoutMs);})]);}finally{clearTimeout(timer);}}
 const rpc=new Proxy(connection,{get(target,k){const value=target[k];return typeof value==='function'?(...args)=>bounded(()=>value.apply(target,args)):value;}});
 return async function resolveLookups(refs,{packetRef=null,message=null}={}){
  if(!message||!refs?.length)throw Error('Lookup resolution needs a lookup-table message');
  if(!packetRef||typeof packetRef.operationId!=='string'||!/^[a-f0-9]{64}$/.test(packetRef.operationId)||!Number.isSafeInteger(packetRef.attempt)||packetRef.attempt<1)throw Error('Lookup packet reference required');
  const row=await bounded(()=>registry.operatorPackets.get(packetRef.operationId,packetRef.attempt));
  if(!row||!['prepared','signed'].includes(row.status))throw Error('Lookup packet is not current');
  const tx=VersionedTransaction.deserialize(Buffer.from(row.prepared.base64,'base64'));
  if(tx.version!==0||!Buffer.from(tx.message.serialize()).equals(Buffer.from(message.serialize())))throw Error('Lookup packet differs from the request');
  if(String(tx.message.staticAccountKeys[0])!==owner)throw Error('Lookup packet payer differs');
  const {loadedAddresses}=resolvePinnedLookups(message,row.prepared.lookups);
  await provePinnedLookups(rpc,row.prepared.lookups,{payer:owner});
  return loadedAddresses;
 };
}
