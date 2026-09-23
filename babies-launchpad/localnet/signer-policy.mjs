// Operation-level policy for the operator signer (architecture audit, 23 September 2026). The signer no longer signs
// "anything paid by the operator that touches allowed programs": every instruction is decoded and must match a keeper
// operation template, the campaign must be one this signer serves, compute and priority fees are bounded, lookup tables
// must be resolved, and every lamport the operator can lose (priority fee, transfers, rent) counts against a rolling
// spending limit. Replay-safe operation ids: the same id may only ever sign the same message.
import {PublicKey} from '@solana/web3.js';
export const PROGRAMS={compute:'ComputeBudget111111111111111111111111111111',ata:'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',token:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',token2022:'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',alt:'AddressLookupTab1e1111111111111111111111111',system:'11111111111111111111111111111111'};
export const KEEPER_TAGS=new Set([2,4,5,6,20,21,22,23,24,25,26]);// finalize, settle, ready, launch, fee cycle incl. burn
export const PROVISIONING_TAGS=new Set([0,9]);// init campaign, configure parents
export const USER_TAGS=new Set([1,3,7,8,10]);// commit, refund, claims: never operator-signed
export const DEFAULT_LIMITS={maxComputeUnits:1_400_000,maxPriorityFeeLamports:50_000_000,maxTransferLamports:500_000_000,maxRentLamports:20_000_000,maxHourlyLamports:1_000_000_000,maxInstructions:24};
const u32=(d,o=0)=>d.length>=o+4?d.readUInt32LE(o):null,u64=(d,o=0)=>d.length>=o+8?d.readBigUInt64LE(o):null;
export function launchAuthority(programId,campaign){return PublicKey.findProgramAddressSync([Buffer.from('launch_authority'),new PublicKey(campaign).toBuffer()],new PublicKey(programId))[0].toBase58();}
/** @returns {{ok:true,spendLamports:bigint,priorityFeeLamports:bigint,operations:string[]}|{ok:false,reason:string}} */
export function evaluateOperatorMessage(message,{operator,programId,campaigns=null,limits=DEFAULT_LIMITS,loadedAddresses=null,provisioning=false}){
 const fail=reason=>({ok:false,reason});
 const program=new PublicKey(programId).toBase58(),op=new PublicKey(operator).toBase58();
 const staticKeys=message.staticAccountKeys.map(k=>k.toBase58());
 if(staticKeys[0]!==op)return fail('fee payer is not the operator');
 const lookups=message.addressTableLookups||[];let keys=staticKeys;
 if(lookups.length){if(!loadedAddresses)return fail('lookup tables not resolved');keys=[...staticKeys,...loadedAddresses.writable.map(String),...loadedAddresses.readonly.map(String)];}
 const isSigner=i=>i<message.header.numRequiredSignatures;
 const ixs=message.compiledInstructions;if(!ixs.length||ixs.length>limits.maxInstructions)return fail('instruction count out of bounds');
 let cuLimit=null,cuPrice=0n,spend=0n,touchesProgram=false;const operations=[];
 for(const ix of ixs){
  const pid=keys[ix.programIdIndex],data=Buffer.from(ix.data),acc=ix.accountKeyIndexes.map(i=>keys[i]);if(!pid)return fail('instruction references an unknown account');
  if(pid===PROGRAMS.compute){
   const kind=data[0];
   if(kind===2){const v=u32(data,1);if(v===null||v>limits.maxComputeUnits)return fail('compute unit limit out of bounds');cuLimit=v;operations.push('cu-limit');continue;}
   if(kind===3){const v=u64(data,1);if(v===null)return fail('bad compute price');cuPrice=v;operations.push('cu-price');continue;}
   if(kind===1){const v=u32(data,1);if(v===null||v>262144)return fail('heap frame out of bounds');operations.push('heap');continue;}
   if(kind===4){operations.push('loaded-data-limit');continue;}
   return fail('compute budget instruction not allowed');
  }
  if(pid===PROGRAMS.ata){if(data.length>1||(data.length===1&&data[0]>1))return fail('ata instruction not allowed');if(acc[0]!==op)return fail('ata payer is not the operator');operations.push('ata');continue;}
  if(pid===PROGRAMS.alt){
   const kind=u32(data,0);
   if(kind===0){if(acc[1]!==op||acc[2]!==op)return fail('lookup table authority or payer is not the operator');operations.push('alt-create');continue;}
   if(kind===2){if(acc[1]!==op)return fail('lookup table authority is not the operator');if(acc.length>2&&acc[2]!==op&&acc[2]!==PROGRAMS.system)return fail('lookup table payer is not the operator');operations.push('alt-extend');continue;}
   return fail('lookup table instruction not allowed');
  }
  if(pid===PROGRAMS.system){
   const kind=u32(data,0);
   if(kind===2){if(!provisioning)return fail('system transfer not allowed');const lamports=u64(data,4);if(lamports===null||lamports>BigInt(limits.maxTransferLamports))return fail('transfer amount out of bounds');if(acc[0]!==op)return fail('transfer source is not the operator');const allowed=campaigns?[...campaigns].map(c=>launchAuthority(program,c)):null;if(!allowed||!allowed.includes(acc[1]))return fail('transfer destination is not a served campaign authority');spend+=lamports;operations.push('transfer');continue;}
   if(kind===0){if(!provisioning)return fail('account creation not allowed');const lamports=u64(data,4),owner=data.length>=52?new PublicKey(data.subarray(20,52)).toBase58():null;if(lamports===null||lamports>BigInt(limits.maxRentLamports))return fail('rent out of bounds');if(acc[0]!==op||acc[1]===op||!isSigner(ix.accountKeyIndexes[1]))return fail('created account must be a separate signer funded by the operator');if(![PROGRAMS.token,PROGRAMS.token2022].includes(owner))return fail('created account owner not allowed');spend+=lamports;operations.push('create-account');continue;}
   return fail('system instruction not allowed');
  }
  if(pid===PROGRAMS.token||pid===PROGRAMS.token2022){
   if(!provisioning)return fail('token instruction not allowed');const kind=data[0];
   if(kind===20){operations.push('init-mint');continue;}if(kind===7){operations.push('mint-to');continue;}if(kind===6){if(acc[1]!==op)return fail('set-authority signer is not the operator');operations.push('set-authority');continue;}
   return fail('token instruction not allowed');
  }
  if(pid===program){
   const tag=data[0];touchesProgram=true;
   if(USER_TAGS.has(tag))return fail('user-signed instruction offered to the operator');
   if(!(KEEPER_TAGS.has(tag)||(provisioning&&PROVISIONING_TAGS.has(tag))))return fail('launch program instruction not allowed');
   const campaign=PROVISIONING_TAGS.has(tag)?acc[1]:acc[0];if(!campaign)return fail('campaign account missing');
   if(campaigns&&!campaigns.has(campaign))return fail('campaign not served by this signer');
   operations.push('kids:'+tag);continue;
  }
  return fail('program not allowed');
 }
 const setup=new Set(['alt-create','alt-extend','ata']),prov=new Set(['create-account','init-mint','mint-to','set-authority','transfer']),budget=o=>o.startsWith('cu-')||o==='heap'||o==='loaded-data-limit';
 if(!touchesProgram){const real=operations.filter(o=>!budget(o));if(!real.length)return fail('transaction does nothing but set a budget');if(!real.every(o=>setup.has(o)||(provisioning&&prov.has(o))))return fail('transaction does not invoke the launch program');}
 const units=BigInt(cuLimit??Math.min(limits.maxComputeUnits,200_000*ixs.length));
 const priorityFeeLamports=(units*cuPrice+999_999n)/1_000_000n;
 if(priorityFeeLamports>BigInt(limits.maxPriorityFeeLamports))return fail('priority fee out of bounds');
 return {ok:true,spendLamports:spend+priorityFeeLamports,priorityFeeLamports,operations};
}
/** Rolling one-hour spending ledger for what the operator can lose by signing. */
export function createSpendLedger({maxHourlyLamports=DEFAULT_LIMITS.maxHourlyLamports,now=Date.now}={}){
 const entries=[];
 return {charge(lamports,at=now()){while(entries.length&&at-entries[0].at>3_600_000)entries.shift();const total=entries.reduce((s,e)=>s+e.lamports,0n)+BigInt(lamports);if(total>BigInt(maxHourlyLamports))return false;entries.push({at,lamports:BigInt(lamports)});return true;},total(at=now()){while(entries.length&&at-entries[0].at>3_600_000)entries.shift();return entries.reduce((s,e)=>s+e.lamports,0n);}};
}
/** Operation ids: one id, one message. A retry re-signs the identical bytes; anything else is refused. */
export function createOperationRegistry({ttlMs=86_400_000,now=Date.now}={}){
 const seen=new Map();
 return {check(id,messageHash,at=now()){for(const [k,v] of seen)if(at-v.at>ttlMs)seen.delete(k);const prior=seen.get(id);if(prior&&prior.hash!==messageHash)return false;const retry=!!prior;seen.set(id,{hash:messageHash,at});return retry?'retry':'new';}};
}
