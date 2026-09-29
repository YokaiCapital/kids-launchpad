// Test helper: address-lookup-table accounts exactly as the lookup-table program lays them out (56-byte meta, then
// 32-byte entries), and a fake connection that serves them at finalized commitment.
import {PublicKey,AddressLookupTableProgram} from '@solana/web3.js';
export const U64_MAX=2n**64n-1n;
export function encodeLookupTableAccount({authority=null,addresses=[],lastExtendedSlot=0,deactivationSlot=U64_MAX}){
 const meta=Buffer.alloc(56);meta.writeUInt32LE(1,0);meta.writeBigUInt64LE(BigInt(deactivationSlot),4);meta.writeBigUInt64LE(BigInt(lastExtendedSlot),12);meta.writeUInt8(0,20);
 if(authority){meta.writeUInt8(1,21);new PublicKey(authority).toBuffer().copy(meta,22);}
 return Buffer.concat([meta,...addresses.map(a=>new PublicKey(a).toBuffer())]);
}
/** `tables`: Map(address -> {authority, addresses, lastExtendedSlot, deactivationSlot, owner}); `slot` a number or a function. */
export function lookupTableConnection(tables,{slot=1000,genesisHash=null}={}){
 const calls=[];
 return {calls,getGenesisHash:async()=>genesisHash,
  getAccountInfoAndContext:async(key,commitment)=>{calls.push({key:String(key),commitment});const t=tables.get(String(key));return {context:{slot:typeof slot==='function'?slot():slot},value:t?{owner:t.owner??AddressLookupTableProgram.programId,executable:false,lamports:1,data:encodeLookupTableAccount(t)}:null};}};
}
