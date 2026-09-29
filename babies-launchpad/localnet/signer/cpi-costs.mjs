// New v3 capability path only. Legacy message policy stays unchanged.
// A reserve ceiling, not an actual-spend receipt. The launch authority's pool
// reserve and user escrow are separate from the keeper's lock-account rent.
import {PublicKey} from '@solana/web3.js';
import {ATA_RENT_LAMPORTS} from '../signer-policy.mjs';
const ATA_PROGRAM='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const CPI_RENT_BYTES=Object.freeze([82,160,165,256,607,679]);
// Metaplex charges its creation fee to the payer when a funding-first launch creates the child metadata (607 bytes).
export const METAPLEX_CREATE_FEE_LAMPORTS=10_000_000n;
const readKeys=(message,loaded)=>[...message.staticAccountKeys.map(String),...(loaded?.writable??[]).map(String),...(loaded?.readonly??[]).map(String)];
export function needsCpiRent(message,cap,loaded){
 if(cap?.programVersion!==3)return false;
 const keys=readKeys(message,loaded);
 return message.compiledInstructions.some(ix=>keys[ix.programIdIndex]===ATA_PROGRAM||(keys[ix.programIdIndex]===cap.programId&&[6,20,42].includes(ix.data[0])));
}
export function evaluateCpiRent({message,cap,operator,loadedAddresses=null,evidence,now=Date.now()}){
 if(cap?.programVersion===3){
  const keys=readKeys(message,loadedAddresses);
  for(const ix of message.compiledInstructions){
   if(keys[ix.programIdIndex]!==ATA_PROGRAM)continue;
   // Standard v3 currently uses classic token accounts. Token-2022 extensions
   // can require more than 165 bytes; do not price those as a classic ATA.
   const a=Array.from(ix.accountKeyIndexes,i=>keys[i]);
   if(a.length!==6||a[4]!=='11111111111111111111111111111111'||a[5]!=='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')return {ok:false,reason:'Unqualified v3 associated-account rent template'};
  }
 }
 if(!needsCpiRent(message,cap,loadedAddresses))return {ok:true,lamports:0n,feeLamports:0n};
 const fail=reason=>({ok:false,reason});
 if(!evidence||evidence.genesisHash!==cap.genesisHash||!Number.isSafeInteger(evidence.validUntil)||evidence.validUntil<=now||evidence.validUntil>now+30000)return fail('CPI rent evidence unavailable or expired');
 let rent;try{rent=Object.fromEntries(CPI_RENT_BYTES.map(size=>{const n=evidence.lamportsByBytes?.[size];if(typeof n!=='string'||!/^[1-9][0-9]{0,15}$/.test(n)||BigInt(n)>BigInt(Number.MAX_SAFE_INTEGER))throw Error();return [size,BigInt(n)];}));}catch{return fail('CPI rent evidence malformed');}
 const keys=readKeys(message,loadedAddresses),payer=new PublicKey(operator).toBase58();let lamports=0n,feeLamports=0n;
 for(const ix of message.compiledInstructions){
  // The legacy decoder already includes its static ATA rent. Only add any
  // increase measured on this ledger; never reduce the conservative reserve.
  if(keys[ix.programIdIndex]===ATA_PROGRAM){lamports+=rent[165]>ATA_RENT_LAMPORTS?rent[165]-ATA_RENT_LAMPORTS:0n;continue;}
  if(keys[ix.programIdIndex]!==cap.programId)continue;
  const tag=ix.data[0];if(tag!==6&&tag!==20&&tag!==42)continue;
  const accounts=Array.from(ix.accountKeyIndexes,i=>keys[i]);
  if(accounts[1]!==payer||ix.accountKeyIndexes[1]>=message.header.numRequiredSignatures)return fail('CPI rent payer differs from the operator');
  if(tag===6){
   if(ix.data.length!==1||accounts.length!==29||ix.accountKeyIndexes[6]>=message.header.numRequiredSignatures)return fail('Unrecognized v3 launch cost template');
   // Fee NFT mint, its ATA, locked position, lock LP ATA, plus a conservative
   // metadata allowance. Current launch.rs uses with_metadata=false; reserving
   // this allowance never claims it was spent. Full pool rent is paid by the PDA.
   lamports+=rent[82]+rent[165]*2n+rent[256]+rent[679];
  }else if(tag===42){
   // Funding-first launch: the tag-6 lock rents plus the mint leg (child mint, custody and WSOL custody accounts, child
   // metadata). The child mint (3) and the fee NFT (6) are auxiliary signers; the data carries the display fields.
   if(ix.data.length<16||accounts.length!==33||ix.accountKeyIndexes[3]>=message.header.numRequiredSignatures||ix.accountKeyIndexes[6]>=message.header.numRequiredSignatures)return fail('Unrecognized funding-first launch cost template');
   lamports+=rent[82]*2n+rent[165]*4n+rent[256]+rent[607];feeLamports+=METAPLEX_CREATE_FEE_LAMPORTS;
  }else{
   if(ix.data.length!==33||accounts.length!==5)return fail('Unrecognized v3 fee initialization cost template');
   // The sealed treasury is the caller/payer; a separate keeper may not sign
   // this as though its own funded balance covered another wallet's rent.
   lamports+=rent[160];
  }
 }
 if(lamports>BigInt(cap.limits.maxRentLamports))return fail('CPI rent exceeds capability limit');
 if(feeLamports>BigInt(cap.limits.maxCpiFeeLamports??0))return fail('CPI fee exceeds capability limit');
 return {ok:true,lamports,feeLamports,validUntil:evidence.validUntil};
}
export function createCpiRentReader({connection,genesisHash,now=Date.now,timeoutMs=5000}){
 const genesis=new PublicKey(genesisHash).toBase58();
 if(!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>10000)throw Error('Invalid CPI rent timeout');
 let pending=null;
 async function read(){
  let timer;const started=now();
  try{return await Promise.race([(async()=>{
   if(await connection.getGenesisHash()!==genesis)throw Error('CPI rent ledger changed');
   const rents=await Promise.all(CPI_RENT_BYTES.map(size=>connection.getMinimumBalanceForRentExemption(size,'finalized')));
   if(await connection.getGenesisHash()!==genesis)throw Error('CPI rent ledger changed');
   if(rents.some(n=>!Number.isSafeInteger(n)||n<1))throw Error('CPI rent unavailable');
   if(now()>=started+30000)throw Error('CPI rent evidence expired');
   return {genesisHash:genesis,validUntil:started+30000,lamportsByBytes:Object.fromEntries(CPI_RENT_BYTES.map((size,i)=>[size,String(rents[i])]))};
  })(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('CPI rent read timed out')),timeoutMs);})]);}finally{clearTimeout(timer);}
 }
 // Coalesce simultaneous reads; don't serve an old cached value after an outage.
 return async()=>{if(!pending)pending=read().finally(()=>{pending=null;});return structuredClone(await pending);};
}
