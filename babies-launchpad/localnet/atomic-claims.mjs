import {createHash} from 'node:crypto';
import {PublicKey,TransactionInstruction,SystemProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {authorityAddress,receiptAddress,u64} from './atomic-launch.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest();
const pub=value=>new PublicKey(value);
const ata=(mint,owner)=>getAssociatedTokenAddressSync(pub(mint),pub(owner),true);
const ix=(ctx,tag,accounts,body=Buffer.alloc(0))=>new TransactionInstruction({programId:ctx.programId,keys:accounts.map(([pubkey,isSigner=false,isWritable=false])=>({pubkey:pub(pubkey),isSigner,isWritable})),data:Buffer.concat([Buffer.from([tag]),body])});
export const parentsAddress=(ctx,campaign)=>PublicKey.findProgramAddressSync([Buffer.from('parents'),pub(campaign).toBuffer()],ctx.programId)[0];
export const parentClaimAddress=(ctx,campaign,index,owner)=>PublicKey.findProgramAddressSync([Buffer.from('parent_claim'),pub(campaign).toBuffer(),Buffer.from([index]),pub(owner).toBuffer()],ctx.programId)[0];
export function participantClaimInstruction(ctx,campaign,mint,owner,destination=ata(mint,owner)){
 const authority=authorityAddress(ctx,campaign);return ix(ctx,7,[[campaign,false,true],[receiptAddress(ctx.programId,campaign,owner),false,true],[authority],[mint],[ata(mint,authority),false,true],[destination,false,true],[TOKEN_PROGRAM_ID]]);
}
export function devClaimInstruction(ctx,campaign,mint,dev,destination=ata(mint,dev)){
 const authority=authorityAddress(ctx,campaign);return ix(ctx,8,[[campaign,false,true],[authority],[mint],[ata(mint,authority),false,true],[destination,false,true],[TOKEN_PROGRAM_ID]]);
}
export function configureParentsInstruction(ctx,campaign,creator,mints,roots,slot,eligible){
 return ix(ctx,9,[[creator,true,true],[campaign,false,true],[parentsAddress(ctx,campaign),false,true],[mints[0]],[mints[1]],[SystemProgram.programId]],Buffer.concat([...roots.map(r=>Buffer.from(r)),u64(slot),...eligible.map(u64)]));
}
export function parentClaimInstruction(ctx,campaign,payer,mint,index,owner,balance,allocation,proof,destination=ata(mint,owner)){
 if(![0,1].includes(index)||proof.length>32)throw Error('Invalid parent proof');const authority=authorityAddress(ctx,campaign);
 return ix(ctx,10,[[payer,true,true],[campaign],[parentsAddress(ctx,campaign),false,true],[parentClaimAddress(ctx,campaign,index,owner),false,true],[owner],[authority],[mint],[ata(mint,authority),false,true],[destination,false,true],[TOKEN_PROGRAM_ID],[SystemProgram.programId]],Buffer.concat([Buffer.from([index]),u64(balance),u64(allocation),Buffer.from([proof.length]),...proof.map(p=>Buffer.from(p))]));
}
/** Tag 11 (program build 6): after the parent claim window, burn the unclaimed rest of both parent reserves from launch
 * custody. No signer and no body; anyone may send it and a second call burns nothing more. Accounts per the build-6
 * table: campaign, parents (writable), launch authority, coin mint (writable), launch custody (writable), Token. */
export function burnExpiredParentReservesInstruction(ctx,campaign,mint){
 const authority=authorityAddress(ctx,campaign);return ix(ctx,11,[[campaign],[parentsAddress(ctx,campaign),false,true],[authority],[mint,false,true],[ata(mint,authority),false,true],[TOKEN_PROGRAM_ID]]);
}
export function parentLeaf(campaign,index,owner,balance,allocation){return sha(Buffer.concat([Buffer.from('kids-parent-v1'),pub(campaign).toBuffer(),Buffer.from([index]),pub(owner).toBuffer(),u64(balance),u64(allocation)]));}
const pair=(a,b)=>sha(Buffer.concat(Buffer.compare(a,b)<=0?[a,b]:[b,a]));
// Snapshot adapter: aggregate each owner's balance BEFORE calling; threshold is
// applied independently to each parent. The immutable publisher root remains a
// trust boundary and must be accompanied by a public, reproducible snapshot.
// `eligibleTotal` may exceed the eligible sum when a per-owner cap leaves part of the pool unallocated (a tiny
// community where everyone sits at the cap): shares are then balance / eligibleTotal and the rest stays in custody.
export function parentTree(campaign,index,parentSupply,holders,childSupply=1000000000000000n,eligibleTotal=null){
 const threshold=(parentSupply*5n+9999n)/10000n,seen=new Set();
 const rows=holders.map(h=>({owner:pub(h.owner).toBase58(),balance:BigInt(h.balance)}));
 for(const row of rows){if(seen.has(row.owner)||row.balance<0n)throw Error('Snapshot owners must be unique with nonnegative balances');seen.add(row.owner);}
 if(rows.reduce((sum,h)=>sum+h.balance,0n)>parentSupply)throw Error('Snapshot exceeds parent supply');
 const eligible=rows.filter(h=>h.balance>=threshold),summed=eligible.reduce((sum,h)=>sum+h.balance,0n);if(!summed)throw Error('No eligible parent holders');
 const total=eligibleTotal===null?summed:BigInt(eligibleTotal);if(total<summed||total>parentSupply)throw Error('Eligible total must cover the eligible sum and stay within the parent supply');
 const entries=eligible.map(h=>({...h,allocation:childSupply*5n/100n*h.balance/total}));
 const levels=[entries.map(h=>parentLeaf(campaign,index,h.owner,h.balance,h.allocation))];
 while(levels.at(-1).length>1){const prior=levels.at(-1),next=[];for(let i=0;i<prior.length;i+=2)next.push(i+1<prior.length?pair(prior[i],prior[i+1]):prior[i]);levels.push(next);}
 return {root:levels.at(-1)[0],eligibleBalance:total,threshold,entries:entries.map((entry,i)=>{const proof=[];for(let l=0;l<levels.length-1;l++){const sibling=i^1;if(sibling<levels[l].length)proof.push(levels[l][sibling]);i=Math.floor(i/2);}return {...entry,proof};})};
}
