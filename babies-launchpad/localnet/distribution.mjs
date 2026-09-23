// Off-chain side of the kids-distribution program (docs/CLAIM-VAULTS-DESIGN.md): addresses, account decoding and the
// claim, burn and sweep instruction builders. Layout offsets mirror programs/kids-distribution/src/lib.rs.
import {PublicKey,TransactionInstruction,SystemProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {readFileSync,existsSync} from 'node:fs';
export const PURPOSES=Object.freeze({participants:0,parentA:1,parentB:2,dev:3});
export const PARENT_EXPIRY_SECONDS=2_592_000;
export const OFF=Object.freeze({campaign:8,mint:40,launchProgram:72,supply:104,settledAccepted:112,launchTime:120,parentExpiry:128,devStart:136,devEnd:144,roots:152,parentSupply:216,eligible:232,allocation:248,claimed:280,burned:312,devPrior:328,flags:336,bumps:337,dev:344});
export const DISTRIBUTION_LEN=512,CLAIM_LEN=88;
const seed=s=>Buffer.from(s);
export function distributionAddress(programId,campaign){return PublicKey.findProgramAddressSync([seed('distribution'),new PublicKey(campaign).toBuffer()],new PublicKey(programId))[0];}
export function vaultAuthority(programId,campaign,purpose){return PublicKey.findProgramAddressSync([seed('vault'),new PublicKey(campaign).toBuffer(),Buffer.from([purpose])],new PublicKey(programId))[0];}
export function vaultAddress(programId,campaign,purpose,mint){return getAssociatedTokenAddressSync(new PublicKey(mint),vaultAuthority(programId,campaign,purpose),true);}
export function claimReceiptAddress(programId,campaign,purpose,owner){return PublicKey.findProgramAddressSync([seed('claim'),new PublicKey(campaign).toBuffer(),Buffer.from([purpose]),new PublicKey(owner).toBuffer()],new PublicKey(programId))[0];}
/** Decodes a Distribution account. Throws on a foreign owner, magic or length. */
export function decodeDistribution(info,programId){
 if(!info||!info.owner.equals(new PublicKey(programId))||info.data.length!==DISTRIBUTION_LEN||info.data.subarray(0,8).toString()!=='KIDSDST1')throw Error('Not a distribution account');
 const d=info.data,key=o=>new PublicKey(d.subarray(o,o+32)),u=o=>d.readBigUInt64LE(o),i=o=>d.readBigInt64LE(o);
 return {campaign:key(OFF.campaign),mint:key(OFF.mint),launchProgram:key(OFF.launchProgram),dev:key(OFF.dev),supply:u(OFF.supply),settledAccepted:u(OFF.settledAccepted),launchTime:Number(i(OFF.launchTime)),parentExpiry:Number(i(OFF.parentExpiry)),devStart:Number(i(OFF.devStart)),devEnd:Number(i(OFF.devEnd)),
  roots:[0,1].map(k=>d.subarray(OFF.roots+32*k,OFF.roots+32*k+32).toString('hex')),parentSupply:[0,1].map(k=>u(OFF.parentSupply+8*k)),eligible:[0,1].map(k=>u(OFF.eligible+8*k)),allocation:[0,1,2,3].map(k=>u(OFF.allocation+8*k)),claimed:[0,1,2,3].map(k=>u(OFF.claimed+8*k)),burned:[0,1].map(k=>u(OFF.burned+8*k)),devPrior:u(OFF.devPrior),
  activated:(d[OFF.flags]&1)!==0,parentBurned:[(d[OFF.flags]&2)!==0,(d[OFF.flags]&4)!==0]};
}
/** Remaining amounts and the parent claim window, from the decoded account and a chain time. */
export function distributionSummary(dist,now){
 const remaining=dist.allocation.map((a,k)=>a-dist.claimed[k]-(k===1||k===2?dist.burned[k-1]:0n));
 return {remaining,parentWindowOpen:now>=dist.launchTime&&now<dist.parentExpiry,parentExpired:now>=dist.parentExpiry,parentExpiryIso:new Date(dist.parentExpiry*1000).toISOString()};
}
const meta=(pubkey,isSigner=false,isWritable=false)=>({pubkey:new PublicKey(pubkey),isSigner,isWritable});
const u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
export function claimParticipantInstruction({programId,launchProgramId,campaign,mint,owner,receipt}){
 const pid=new PublicKey(programId);
 return new TransactionInstruction({programId:pid,data:Buffer.from([1]),keys:[meta(owner,true,true),meta(distributionAddress(pid,campaign),false,true),meta(receipt),meta(claimReceiptAddress(pid,campaign,0,owner),false,true),meta(mint),meta(vaultAuthority(pid,campaign,0)),meta(vaultAddress(pid,campaign,0,mint),false,true),meta(getAssociatedTokenAddressSync(new PublicKey(mint),new PublicKey(owner)),false,true),meta(TOKEN_PROGRAM_ID),meta(SystemProgram.programId)]});
}
export function claimParentInstruction({programId,campaign,mint,owner,index,balance,allocation,proof}){
 if(![0,1].includes(index)||proof.length>32)throw Error('Bad parent claim');const pid=new PublicKey(programId),purpose=1+index;
 const data=Buffer.concat([Buffer.from([2,index]),u64(balance),u64(allocation),Buffer.from([proof.length]),...proof.map(p=>Buffer.from(p))]);
 return new TransactionInstruction({programId:pid,data,keys:[meta(owner,true,true),meta(distributionAddress(pid,campaign),false,true),meta(claimReceiptAddress(pid,campaign,purpose,owner),false,true),meta(mint),meta(vaultAuthority(pid,campaign,purpose)),meta(vaultAddress(pid,campaign,purpose,mint),false,true),meta(getAssociatedTokenAddressSync(new PublicKey(mint),new PublicKey(owner)),false,true),meta(TOKEN_PROGRAM_ID),meta(SystemProgram.programId)]});
}
export function claimDevInstruction({programId,campaign,mint,dev}){
 const pid=new PublicKey(programId);
 return new TransactionInstruction({programId:pid,data:Buffer.from([3]),keys:[meta(dev,true,false),meta(distributionAddress(pid,campaign),false,true),meta(mint),meta(vaultAuthority(pid,campaign,3)),meta(vaultAddress(pid,campaign,3,mint),false,true),meta(getAssociatedTokenAddressSync(new PublicKey(mint),new PublicKey(dev)),false,true),meta(TOKEN_PROGRAM_ID)]});
}
function vaultOp(tag,{programId,campaign,mint,purpose}){
 const pid=new PublicKey(programId);
 return new TransactionInstruction({programId:pid,data:Buffer.from([tag,tag===4?purpose-1:purpose]),keys:[meta(distributionAddress(pid,campaign),false,true),meta(mint,false,true),meta(vaultAuthority(pid,campaign,purpose)),meta(vaultAddress(pid,campaign,purpose,mint),false,true),meta(TOKEN_PROGRAM_ID)]});
}
/** Tag 4: anyone may burn an expired parent vault (purpose 1 or 2). */
export function burnExpiredInstruction({programId,campaign,mint,index}){if(![0,1].includes(index))throw Error('Parent index must be 0 or 1');return vaultOp(4,{programId,campaign,mint,purpose:1+index});}
/** Tag 5: anyone may burn what a vault holds above what it still owes (donations). */
export function sweepDonationInstruction({programId,campaign,mint,purpose}){if(![0,1,2,3].includes(purpose))throw Error('Bad purpose');return vaultOp(5,{programId,campaign,mint,purpose});}

/** The distribution program a NEW campaign records: KIDS_DISTRIBUTION_PROGRAM, else the localnet manifest written by
 * kids-distribution-deploy.mjs, else the recorded mainnet identity; null when none is deployed (old claim paths). */
export function distributionProgramFor(network,env=process.env){
 if(env.KIDS_DISTRIBUTION_PROGRAM==='none')return null;if(env.KIDS_DISTRIBUTION_PROGRAM)return new PublicKey(env.KIDS_DISTRIBUTION_PROGRAM);
 if(network==='localnet'){const p=new URL('./.runtime/kids-distribution-program.json',import.meta.url);if(!existsSync(p))return null;const m=JSON.parse(readFileSync(p,'utf8'));return new PublicKey(m.programId);}
 try{const ids=JSON.parse(readFileSync(new URL('../deployment/MAINNET-IDENTITIES.json',import.meta.url),'utf8'));return ids.distribution?.programId?new PublicKey(ids.distribution.programId):null;}catch{return null;}
}
