// Parent reward statistics for the coin page (owner request, 23 September 2026): eligible owners and totals from the
// frozen snapshot evidence, verified against the on-chain roots; claimed counts and amounts from the chain (claim
// receipts of the launch program, or the distribution program's receipts and counters for vault campaigns). Unknown
// stays null; nothing is estimated from current holders.
import {readFileSync,existsSync} from 'node:fs';import {fileURLToPath} from 'node:url';
import {PublicKey} from '@solana/web3.js';import {parentsAddress} from './atomic-claims.mjs';import {distributionAddress,decodeDistribution} from './distribution.mjs';import {networkProfile} from './network.mjs';
const CACHE_MS=60_000;const cache=new Map();
function runtimeSnapshot(campaign){const p=new URL('./.runtime/parent-snapshot-'+campaign+'.json',import.meta.url);return existsSync(p)?JSON.parse(readFileSync(p,'utf8')):null;}
function evidence(network,campaign,mint){try{const p=fileURLToPath(new URL('../deployment/'+network+'/snapshots/'+campaign+'/'+mint+'.json',import.meta.url));return existsSync(p)?JSON.parse(readFileSync(p,'utf8')):null;}catch{return null;}}
/** Count and sum claim receipts of one parent: launch-program receipts (KIDSPCL1, 80 bytes: campaign at 8, index at 72) or
 * distribution receipts (KIDSDCL1, 88 bytes: campaign at 8, purpose byte after the owner at 72, claimed byte, amount). */
async function claimedOnChain(connection,programId,campaign,index,vault){
  if(!vault){const rows=await connection.getProgramAccounts(programId,{filters:[{dataSize:80},{memcmp:{offset:8,bytes:campaign.toBase58()}},{memcmp:{offset:72,bytes:Buffer.from([index]).toString('base64'),encoding:'base64'}}],dataSlice:{offset:0,length:0}});return {count:rows.length};}
 const rows=await connection.getProgramAccounts(programId,{filters:[{dataSize:88},{memcmp:{offset:8,bytes:campaign.toBase58()}},{memcmp:{offset:72,bytes:Buffer.from([1+index]).toString('base64'),encoding:'base64'}}],dataSlice:{offset:0,length:0}});return {count:rows.length};
}
export async function parentStats(ctx,state,{now=Date.now(),profile=networkProfile()}={}){
 const campaign=state.address,key=campaign.toBase58();const hit=cache.get(key);if(hit&&now-hit.at<CACHE_MS)return hit.value;
 const snap=runtimeSnapshot(key);const parentsInfo=await ctx.connection.getAccountInfo(parentsAddress(ctx,campaign),'confirmed');
 const vault=state.distributionActivated?state.distributionProgram:null;const dist=vault?decodeDistribution(await ctx.connection.getAccountInfo(distributionAddress(vault,campaign),'confirmed'),vault):null;
 const out=[];
 for(const index of [0,1]){
  const tree=snap?.parents?.[index]||null,onChainRoot=parentsInfo?parentsInfo.data.subarray(104+index*32,136+index*32).toString('hex'):null;
  const rootVerified=!!(tree&&onChainRoot&&tree.root===onChainRoot);
  const ev=tree?evidence(profile.network,key,tree.mint):null;
  const claimedRaw=dist?dist.claimed[1+index]:parentsInfo?parentsInfo.data.readBigUInt64LE(208+index*8):null;
  let claimedCount=null;try{if(rootVerified)claimedCount=(await claimedOnChain(ctx.connection,vault||ctx.programId,campaign,index,!!vault)).count;}catch{claimedCount=null;}
  const allocationRaw=state.supply*500n/10000n;const burnedRaw=dist?dist.burned[index]:0n;
  out.push({index,mint:tree?.mint||null,rootVerified,eligibleOwners:rootVerified?tree.entries.length:null,eligibleTotalRaw:rootVerified?tree.entries.reduce((s,e)=>s+BigInt(e.balance),0n).toString():null,
   snapshotSlot:tree?.slot??snap?.slot??null,snapshotAt:ev?.readAt||null,thresholdRaw:ev?.threshold||null,parentSupplyRaw:ev?.supply||null,
   allocationRaw:allocationRaw.toString(),claimedRaw:claimedRaw===null?null:claimedRaw.toString(),claimedCount,burnedRaw:burnedRaw.toString(),remainingRaw:claimedRaw===null?null:(allocationRaw-claimedRaw-burnedRaw).toString(),
   expiresAtUnix:dist?dist.parentExpiry:null,evidenceSha256:ev?.snapshotSha256||null});
 }
 const value={verifiedAt:new Date(now).toISOString(),parents:out};cache.set(key,{at:now,value});return value;
}
export function resetParentStatsCache(){cache.clear();}
