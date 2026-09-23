// Native escrow-to-pool integration on the separate canonical-program localnet.
import {boundedRpcFetch} from './rpc-transport.mjs';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Connection,PublicKey,TransactionInstruction,SystemProgram,SYSVAR_RENT_PUBKEY} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,NATIVE_MINT,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {poolAddresses} from './cpmm.mjs';
export {campaignAddress,receiptAddress,commitInstruction,finalizeInstruction,refundInstruction,settleInstruction,readyInstruction} from './launch-escrow.mjs';
import {campaignAddress} from './launch-escrow.mjs';
import {networkProfile} from './network.mjs';
export const PROFILE=networkProfile();
export const RPC=PROFILE.rpcUrl;
export const CPMM=new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'),LOCK=new PublicKey('LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE'),LOCK_AUTH=new PublicKey('3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH'),METADATA=new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'),AMM_CONFIG=new PublicKey('2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5'),POOL_FEE=new PublicKey('DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8');
const LOADER='BPFLoaderUpgradeab1e11111111111111111111111';
export const u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
// The qualified context (genesis, executable bytes, hash, upgrade authority) is expensive: one ProgramData download
// per call. It is shared across the process and revalidated every CONTEXT_TTL_MS (or on demand with {fresh:true} and
// after invalidateAtomicContext()). Identity checks are unchanged; they simply run once per interval, not once per poll.
export const CONTEXT_TTL_MS=60000;let contextCache=null,contextInFlight=null;export const contextStats={qualifications:0,hits:0};
export function invalidateAtomicContext(){contextCache=null;}
export async function atomicContext({fresh=false,now=Date.now}={}){
 if(!fresh&&contextCache&&now()-contextCache.at<CONTEXT_TTL_MS){contextStats.hits+=1;return contextCache.value;}
 if(!fresh&&contextInFlight)return contextInFlight;
 const run=qualifyAtomicContext().then(value=>{contextCache={value,at:now()};return value;}).finally(()=>{contextInFlight=null;});
 if(!fresh)contextInFlight=run;return run;
}
async function qualifyAtomicContext(){
 contextStats.qualifications+=1;
 const manifest=JSON.parse(readFileSync(new URL('./.runtime/atomic-launch-program.json',import.meta.url))),connection=new Connection(RPC,{commitment:'confirmed',fetch:boundedRpcFetch()});
 if(manifest.network!==PROFILE.network||manifest.rpcUrl!==PROFILE.rpcLabel||await connection.getGenesisHash()!==manifest.genesisHash||PROFILE.genesisHash&&manifest.genesisHash!==PROFILE.genesisHash)throw Error('Atomic launch ledger mismatch');
 const programId=new PublicKey(manifest.programId),p=await connection.getAccountInfo(programId);
 if(!p?.executable||p.owner.toBase58()!==LOADER||p.data.length!==36||p.data.readUInt32LE(0)!==2)throw Error('Invalid atomic launch executable');
 const data=await connection.getAccountInfo(new PublicKey(p.data.subarray(4,36)));
 if(!data||data.owner.toBase58()!==LOADER||data.data.length<45||data.data.readUInt32LE(0)!==3)throw Error('Invalid atomic launch ProgramData');
 const authority=data.data[12]===0?null:new PublicKey(data.data.subarray(13,45)).toBase58();
 if(authority!==manifest.upgradeAuthority)throw Error('Atomic launch upgrade authority changed');
 if(!Number.isSafeInteger(manifest.binarySize)||manifest.binarySize<4||manifest.binarySize>data.data.length-45)throw Error('Invalid binary size');
 if(createHash('sha256').update(data.data.subarray(45,45+manifest.binarySize)).digest('hex')!==manifest.sha256||data.data.subarray(45+manifest.binarySize).some(n=>n!==0))throw Error('Atomic launch binary differs from verified local build');
 return {connection,programId,manifest};
}
export function authorityAddress(ctx,campaign){return PublicKey.findProgramAddressSync([Buffer.from('launch_authority'),new PublicKey(campaign).toBuffer()],ctx.programId)[0];}
export function initInstruction(ctx,creator,terms){
 const campaign=campaignAddress(ctx.programId,creator,terms.nonce);
 const data=Buffer.concat([Buffer.from([0]),...[terms.nonce,terms.soft,terms.hard,terms.deadline,terms.launchDeadline].map(u64),new PublicKey(terms.mint).toBuffer(),u64(terms.supply),new PublicKey(terms.dev).toBuffer(),new PublicKey(terms.treasury).toBuffer()]);
 return new TransactionInstruction({programId:ctx.programId,keys:[{pubkey:creator,isSigner:true,isWritable:true},{pubkey:campaign,isSigner:false,isWritable:true},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false}],data});
}
export function launchInstruction(ctx,campaign,sponsor,mint,nft){
 const authority=authorityAddress(ctx,campaign),p=poolAddresses(CPMM,AMM_CONFIG,mint,NATIVE_MINT);
 const child=getAssociatedTokenAddressSync(mint,authority,true),wsol=getAssociatedTokenAddressSync(NATIVE_MINT,authority,true),feeNft=getAssociatedTokenAddressSync(nft,campaign,true),locked=PublicKey.findProgramAddressSync([Buffer.from('locked_liquidity'),nft.toBuffer()],LOCK)[0],lockVault=getAssociatedTokenAddressSync(p.lpMint,LOCK_AUTH,true),metadata=PublicKey.findProgramAddressSync([Buffer.from('metadata'),METADATA.toBuffer(),nft.toBuffer()],METADATA)[0],lp=getAssociatedTokenAddressSync(p.lpMint,authority,true);
 const spec=[[campaign,false,true],[sponsor,true,true],[authority,false,true],[mint,false,true],[child,false,true],[wsol,false,true],[nft,true,true],[feeNft,false,true],[locked,false,true],[lockVault,false,true],[metadata,false,true],[TOKEN_PROGRAM_ID,false,false],[ASSOCIATED_TOKEN_PROGRAM_ID,false,false],[SystemProgram.programId,false,false],[SYSVAR_RENT_PUBKEY,false,false],[CPMM,false,false],[AMM_CONFIG,false,false],[p.authority,false,false],[p.pool,false,true],[p.lpMint,false,true],[lp,false,true],[p.vault0,false,true],[p.vault1,false,true],[POOL_FEE,false,true],[p.observation,false,true],[LOCK,false,false],[LOCK_AUTH,false,false],[METADATA,false,false],[NATIVE_MINT,false,false]];
 return {instruction:new TransactionInstruction({programId:ctx.programId,data:Buffer.from([6]),keys:spec.map(([pubkey,isSigner,isWritable])=>({pubkey,isSigner,isWritable}))}),addresses:{...p,authority,child,wsol,feeNft,locked,lockVault,metadata,lp}};
}
export async function readCampaign(ctx,address){
 const key=new PublicKey(address),info=await ctx.connection.getAccountInfo(key);
 if(!info||!info.owner.equals(ctx.programId)||info.data.length!==384||info.data.subarray(0,8).toString()!=='KIDSESC3')throw Error('Invalid atomic campaign');
 const d=info.data,creator=new PublicKey(d.subarray(8,40)),nonce=d.readBigUInt64LE(40);if(!campaignAddress(ctx.programId,creator,nonce).equals(key))throw Error('Atomic campaign PDA mismatch');
 return {address:key,creator,nonce,soft:d.readBigUInt64LE(48),hard:d.readBigUInt64LE(56),deadline:Number(d.readBigInt64LE(64)),launchDeadline:Number(d.readBigInt64LE(72)),total:d.readBigUInt64LE(80),refunded:d.readBigUInt64LE(88),phase:d[96],receiptCount:d.readBigUInt64LE(104),settledReceiptCount:d.readBigUInt64LE(112),settledAccepted:d.readBigUInt64LE(120),mint:new PublicKey(d.subarray(128,160)),supply:d.readBigUInt64LE(160),dev:new PublicKey(d.subarray(168,200)),treasury:new PublicKey(d.subarray(200,232)),launchedAt:Number(d.readBigInt64LE(232)),pool:new PublicKey(d.subarray(240,272)),feeNft:new PublicKey(d.subarray(272,304)),devClaimed:d.readBigUInt64LE(304),lamports:BigInt(info.lamports)};
}
