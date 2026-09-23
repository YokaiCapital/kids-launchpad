// Authenticated fixture-wallet claims. This module is loopback-only and never signs on mainnet.
import {readFileSync,existsSync} from 'node:fs';
import {PublicKey,Transaction,sendAndConfirmTransaction} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction} from '@solana/spl-token';
import {atomicContext,readCampaign,receiptAddress,refundInstruction} from './atomic-launch.mjs';
import {participantClaimInstruction,parentClaimInstruction,devClaimInstruction,parentClaimAddress,parentsAddress} from './atomic-claims.mjs';
import {devPlan,unlockedRaw} from './vesting-plan.mjs';
import {localKey,chainTime} from './dev-vesting.mjs';
import {qualifiedCampaign} from './postlaunch-campaign.mjs';
import {networkProfile} from './network.mjs';
import {distributionAddress,claimReceiptAddress,decodeDistribution,distributionSummary,claimParticipantInstruction as vaultParticipantClaim,claimParentInstruction as vaultParentClaim,claimDevInstruction as vaultDevClaim} from './distribution.mjs';
/** Vault-side view for an activated campaign: counters from the Distribution account and the owner's claim receipts. */
async function vaultView(ctx,state,campaign,wallet,now){
 const dp=state.distributionProgram;const infos=await ctx.connection.getMultipleAccountsInfo([distributionAddress(dp,campaign),...[0,1,2].map(p=>claimReceiptAddress(dp,campaign,p,wallet))],'confirmed');
 const dist=decodeDistribution(infos[0],dp),summary=distributionSummary(dist,now),claimed=[1,2,3].map(i=>!!infos[i]&&infos[i].owner.equals(dp)&&infos[i].data.subarray(0,8).toString()==='KIDSDCL1');
 return {dist,summary,claimed:{participant:claimed[0],parentA:claimed[1],parentB:claimed[2]}};
}
export {qualifiedCampaign};
/** The fixture identity (alice or bob) that owns `owner`, or null. Never consulted outside the isolated localnet, and a
 * missing fixture file is 'no identity', not an error: on a real network every wallet is external. */
export function localClaimIdentity(owner,profile=networkProfile()){
 if(profile.network!=='localnet')return null;
 for(const name of ['alice','bob']){let key;try{key=localKey(name);}catch(error){if(error.message==='Wallet missing')continue;throw error;}if(key.publicKey.toBase58()===owner)return key;}
 return null;
}
function snapshot(campaign){const path=new URL('./.runtime/parent-snapshot-'+campaign.toBase58()+'.json',import.meta.url);return existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;}
export async function postlaunchClaims(owner,expectedCampaign){
 if(!owner)return null;
 const {ctx,campaign,state}=await qualifiedCampaign(expectedCampaign),wallet=new PublicKey(owner),snap=snapshot(campaign),now=await chainTime(ctx.connection);
 const addresses=[receiptAddress(ctx.programId,campaign,wallet),parentsAddress(ctx,campaign),...[0,1].map(i=>parentClaimAddress(ctx,campaign,i,wallet))];
 const infos=await ctx.connection.getMultipleAccountsInfo(addresses,'confirmed');
 const receipt=infos[0];let participant={allocatedRaw:'0',claimedRaw:'0'},refund={claimableLamports:'0',refundedLamports:'0'};
 if(receipt){
  const d=receipt.data;if(!receipt.owner.equals(ctx.programId)||d.length!==112||d.subarray(0,8).toString()!=='KIDSREC3'||!d.subarray(8,40).equals(campaign.toBuffer())||!d.subarray(40,72).equals(wallet.toBuffer()))throw Error('Invalid participant receipt');
  const committed=d.readBigUInt64LE(72),refunded=d.readBigUInt64LE(80),accepted=d.readBigUInt64LE(104);
  const allocation=d[97]&&state.settledAccepted>0n?state.supply*435n/1000n*accepted/state.settledAccepted:0n;
  participant={allocatedRaw:allocation.toString(),claimedRaw:d[98]?allocation.toString():'0'};
  refund={claimableLamports:(committed-accepted-refunded).toString(),refundedLamports:refunded.toString()};
 }
 const config=infos[1];
 if(!config||!config.owner.equals(ctx.programId)||config.data.length!==256||config.data.subarray(0,8).toString()!=='KIDSPAR1')throw Error('Parent configuration unavailable');
 const parents=[0,1].map(index=>{
  const tree=snap?.parents?.[index];if(!tree||tree.root!==config.data.subarray(104+index*32,136+index*32).toString('hex'))return {name:index?'Buttcoin':'Fartcoin',eligible:null,allocationRaw:null,claimedRaw:null};
  const entry=tree.entries.find(e=>e.owner===owner),claim=infos[2+index];
  if(claim&&(!claim.owner.equals(ctx.programId)||claim.data.length!==80||claim.data.subarray(0,8).toString()!=='KIDSPCL1'))throw Error('Invalid parent claim receipt');
  return {name:index?'Buttcoin':'Fartcoin',eligible:!!entry,allocationRaw:entry?.allocation||'0',claimedRaw:claim?(entry?.allocation||'0'):'0'};
 });
 const plan=devPlan(state.supply,state.launchedAt),unlocked=BigInt(plan.immediateRaw)+unlockedRaw('linear',plan.linearRaw,plan.start,plan.end,now),isDev=state.dev.equals(wallet);
 let devClaimed=state.devClaimed,vault=null;
 if(state.distributionActivated){
  // Vault campaign: what was claimed lives in the distribution program, and parent claims close at the recorded expiry.
  const v=await vaultView(ctx,state,campaign,wallet,now);vault={parentExpiryUnix:v.dist.parentExpiry,parentWindowOpen:v.summary.parentWindowOpen,parentExpired:v.summary.parentExpired,parentBurned:v.dist.parentBurned};
  if(v.claimed.participant)participant={...participant,claimedRaw:participant.allocatedRaw};else participant={...participant,claimedRaw:'0'};
  parents.forEach((row,index)=>{if(row.eligible===null)return;row.claimedRaw=v.claimed[index?'parentB':'parentA']?row.allocationRaw:'0';row.windowOpen=v.summary.parentWindowOpen;row.expiresAtUnix=v.dist.parentExpiry;if(!v.summary.parentWindowOpen&&row.claimedRaw==='0')row.expired=true;});
  devClaimed=v.dist.claimed[3];
 }
 return {owner:wallet.toBase58(),genesisHash:ctx.manifest.genesisHash,campaign:campaign.toBase58(),participant,refund,parents,dev:{isDev,totalRaw:plan.totalRaw,claimableRaw:isDev?(unlocked>devClaimed?unlocked-devClaimed:0n).toString():'0',claimedRaw:isDev?devClaimed.toString():'0',endUnix:plan.end},vault,externalClaimEnabled:true,localClaimEnabled:!!localClaimIdentity(owner)};
}
const pending=new Map();
export async function claimPostlaunch(owner,input){
 if(!['participant','refund','parentA','parentB','dev'].includes(input.action))throw Error('Unknown claim action');
 const {ctx,campaign,state}=await qualifiedCampaign(input.campaign);
 if(input.campaign!==campaign.toBase58())throw Error('Local launch changed. Refresh before claiming');
 const key=campaign+':'+owner+':'+input.action;if(pending.has(key))return pending.get(key);
 const operation=(async()=>{
  const signer=localClaimIdentity(owner);
  if(!signer)throw Error(networkProfile().network==='localnet'?'Only the local test identities can claim in this rehearsal':'Claims on this network are signed by your own wallet');
  const {tx}=await buildPostlaunchClaim(owner,input.action,input.campaign);
  const signature=await sendAndConfirmTransaction(ctx.connection,tx,[signer],{commitment:'confirmed',maxRetries:3});
  return {signature,claims:await postlaunchClaims(owner,campaign.toBase58())};
 })();pending.set(key,operation);try{return await operation;}finally{pending.delete(key);}
}

export async function buildPostlaunchClaim(owner,action,expectedCampaign){
 if(!['participant','refund','parentA','parentB','dev'].includes(action))throw Error('Unknown claim action');
 const {ctx,campaign,state}=await qualifiedCampaign(expectedCampaign);
 if(expectedCampaign!==campaign.toBase58())throw Error('Local launch changed. Refresh before claiming');
  const wallet=new PublicKey(owner),claims=await postlaunchClaims(owner,campaign.toBase58());
  if(claims.campaign!==campaign.toBase58())throw Error('Local launch changed. Refresh before claiming');
  let instruction;
  if(action==='participant'){
   if(BigInt(claims.participant.allocatedRaw)<=BigInt(claims.participant.claimedRaw))throw Error('No participant tokens remain to claim');
   instruction=state.distributionActivated?vaultParticipantClaim({programId:state.distributionProgram,launchProgramId:ctx.programId,campaign,mint:state.mint,owner:wallet,receipt:receiptAddress(ctx.programId,campaign,wallet)}):participantClaimInstruction(ctx,campaign,state.mint,wallet);
  }else if(action==='refund'){
   if(BigInt(claims.refund.claimableLamports)<=0n)throw Error('No SOL refund remains');
   instruction=refundInstruction(ctx,campaign,wallet);
  }else if(action==='dev'){
   if(!claims.dev.isDev||BigInt(claims.dev.claimableRaw)<=0n)throw Error('No vested dev tokens are available');
   instruction=state.distributionActivated?vaultDevClaim({programId:state.distributionProgram,campaign,mint:state.mint,dev:wallet}):devClaimInstruction(ctx,campaign,state.mint,wallet);
  }else{
   const index=action==='parentA'?0:1,row=claims.parents[index];
   if(!row.eligible||BigInt(row.allocationRaw)<=BigInt(row.claimedRaw))throw Error('No parent tokens remain to claim');
   if(row.windowOpen===false)throw Error('The parent claim window closed on '+new Date(row.expiresAtUnix*1000).toISOString().slice(0,16).replace('T',' ')+' UTC');
   const entry=snapshot(campaign).parents[index].entries.find(e=>e.owner===owner);
   instruction=state.distributionActivated?vaultParentClaim({programId:state.distributionProgram,campaign,mint:state.mint,owner:wallet,index,balance:BigInt(entry.balance),allocation:BigInt(entry.allocation),proof:entry.proof.map(p=>Buffer.from(p,'hex'))}):parentClaimInstruction(ctx,campaign,wallet,state.mint,index,wallet,BigInt(entry.balance),BigInt(entry.allocation),entry.proof.map(p=>Buffer.from(p,'hex')));
  }
  const tx=new Transaction();
  if(action!=='refund')tx.add(createAssociatedTokenAccountIdempotentInstruction(wallet,getAssociatedTokenAddressSync(state.mint,wallet),wallet,state.mint));
  tx.add(instruction);
 return {ctx,campaign,state,tx};
}
