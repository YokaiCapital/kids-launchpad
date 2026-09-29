// Separate v2 fixture interface. Never selects an active application campaign.
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Connection,PublicKey,TransactionInstruction,SystemProgram} from '@solana/web3.js';
import {readLocalConfig} from '../interaction-review/server/local-config.mjs';
const runtime=fileURLToPath(new URL('./.runtime/',import.meta.url));
const read=path=>JSON.parse(readFileSync(path,'utf8'));
export function u64(value){const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(value));return b;}
export function campaignAddress(programId,creator,nonce){return PublicKey.findProgramAddressSync([Buffer.from('campaign'),new PublicKey(creator).toBuffer(),u64(nonce)],programId)[0];}
export function receiptAddress(programId,campaign,owner){return PublicKey.findProgramAddressSync([Buffer.from('commitment'),new PublicKey(campaign).toBuffer(),new PublicKey(owner).toBuffer()],programId)[0];}
export async function escrowContext(){
 const config=readLocalConfig();if(config?.network!=='localnet'||config.rpcUrl!=='http://127.0.0.1:18999')throw Error('Escrow requires isolated localnet');
 const connection=new Connection(config.rpcUrl,'confirmed');if(await connection.getGenesisHash()!==config.genesisHash)throw Error('Localnet genesis changed');
 if(!existsSync(runtime+'launch-escrow-program.json'))throw Error('Escrow program is not deployed');
 const deployment=read(runtime+'launch-escrow-program.json');if(deployment.genesisHash!==config.genesisHash)throw Error('Escrow deployment belongs to another ledger');
 const programId=new PublicKey(deployment.programId),program=await connection.getAccountInfo(programId);
 if(!program?.executable||program.owner.toBase58()!=='BPFLoaderUpgradeab1e11111111111111111111111'||program.data.readUInt32LE(0)!==2)throw Error('Escrow program is unavailable');
 const data=await connection.getAccountInfo(new PublicKey(program.data.subarray(4,36)));
 if(!data||!data.owner.equals(program.owner)||data.data.readUInt32LE(0)!==3||data.data[12]!==0)throw Error('Escrow program must have no upgrade authority');
 return {config,connection,programId};
}
export function initInstruction(ctx,creator,{nonce,soft,hard,deadline,launchDeadline}){const owner=new PublicKey(creator),campaign=campaignAddress(ctx.programId,owner,nonce);return new TransactionInstruction({programId:ctx.programId,keys:[{pubkey:owner,isSigner:true,isWritable:true},{pubkey:campaign,isSigner:false,isWritable:true},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false}],data:Buffer.concat([Buffer.from([0]),...[nonce,soft,hard,deadline,launchDeadline].map(u64)])});}
export function commitInstruction(ctx,campaign,owner,amount,sequence){owner=new PublicKey(owner);campaign=new PublicKey(campaign);return new TransactionInstruction({programId:ctx.programId,keys:[{pubkey:owner,isSigner:true,isWritable:true},{pubkey:campaign,isSigner:false,isWritable:true},{pubkey:receiptAddress(ctx.programId,campaign,owner),isSigner:false,isWritable:true},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false}],data:Buffer.concat([Buffer.from([1]),u64(amount),u64(sequence)])});}
export function finalizeInstruction(ctx,campaign){return new TransactionInstruction({programId:ctx.programId,keys:[{pubkey:new PublicKey(campaign),isSigner:false,isWritable:true}],data:Buffer.from([2])});}
export function refundInstruction(ctx,campaign,owner,destination=owner){return new TransactionInstruction({programId:ctx.programId,keys:[{pubkey:new PublicKey(campaign),isSigner:false,isWritable:true},{pubkey:receiptAddress(ctx.programId,campaign,owner),isSigner:false,isWritable:true},{pubkey:new PublicKey(destination),isSigner:false,isWritable:true}],data:Buffer.from([3])});}
export async function readCampaign(ctx,address){
 const key=new PublicKey(address),info=await ctx.connection.getAccountInfo(key);if(!info||!info.owner.equals(ctx.programId)||info.data.length!==128||info.data.subarray(0,8).toString()!=='KIDSESC2')throw Error('Campaign account is invalid');
 const d=info.data,creator=new PublicKey(d.subarray(8,40)),nonce=d.readBigUInt64LE(40);
 if(!campaignAddress(ctx.programId,creator,nonce).equals(key))throw Error('Campaign address is invalid');
 return {address:key,creator,nonce,soft:d.readBigUInt64LE(48),hard:d.readBigUInt64LE(56),deadline:Number(d.readBigInt64LE(64)),launchDeadline:Number(d.readBigInt64LE(72)),total:d.readBigUInt64LE(80),refunded:d.readBigUInt64LE(88),phase:d[96],receiptCount:d.readBigUInt64LE(104),settledReceiptCount:d.readBigUInt64LE(112),settledAccepted:d.readBigUInt64LE(120),lamports:BigInt(info.lamports)};
}
export async function readReceipt(ctx,campaign,owner){
 const address=receiptAddress(ctx.programId,campaign,owner),info=await ctx.connection.getAccountInfo(address);
 if(!info||info.owner.equals(SystemProgram.programId)&&info.data.length===0)return {address,committed:0n,refunded:0n,sequence:0n};
 if(!info.owner.equals(ctx.programId)||info.data.length!==112||info.data.subarray(0,8).toString()!=='KIDSREC2'||!new PublicKey(info.data.subarray(8,40)).equals(new PublicKey(campaign))||!new PublicKey(info.data.subarray(40,72)).equals(new PublicKey(owner)))throw Error('Commitment account is invalid');
 return {address,committed:info.data.readBigUInt64LE(72),refunded:info.data.readBigUInt64LE(80),sequence:info.data.readBigUInt64LE(88),settled:info.data[97]!==0,accepted:info.data.readBigUInt64LE(104)};
}
export function amounts(c,r,now){
 const closed=now>=c.deadline,failed=closed&&(c.total<c.soft||now>=c.launchDeadline&&c.phase!==3);
 const accepted=failed?0n:c.total>c.hard?r.committed*c.hard/c.total:r.committed;
 const entitled=closed?r.committed-accepted:0n;
 return {accepted,refundable:entitled>r.refunded?entitled-r.refunded:0n,failed,phase:failed?'failed':c.phase===3?'launched':closed?'awaiting-launch':'open'};
}

export function settleInstruction(ctx,campaign,owner){return new TransactionInstruction({programId:ctx.programId,keys:[{pubkey:new PublicKey(campaign),isSigner:false,isWritable:true},{pubkey:receiptAddress(ctx.programId,campaign,owner),isSigner:false,isWritable:true}],data:Buffer.from([4])});}
export function readyInstruction(ctx,campaign){return new TransactionInstruction({programId:ctx.programId,keys:[{pubkey:new PublicKey(campaign),isSigner:false,isWritable:false}],data:Buffer.from([5])});}
export function isFundingReady(c,now){return now>=c.deadline&&now<c.launchDeadline&&c.phase!==2&&c.phase!==3&&c.total>=c.soft&&c.receiptCount>0n&&c.settledReceiptCount===c.receiptCount&&c.settledAccepted>=c.soft;}
