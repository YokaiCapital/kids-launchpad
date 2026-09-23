// Direct-chain claims without the website or the API (docs: a website outage must not trap claims).
//   KIDS_NETWORK=mainnet KIDS_HELIUS_RPC_URL=… node localnet/claim-cli.mjs <campaign> <owner> [--send <keypair.json>] [--rpc <url>]
//   KIDS_NETWORK=localnet                       node localnet/claim-cli.mjs <campaign> <owner> [--send <keypair.json>]
// Reads the campaign and the receipts from the chain and the parent snapshot evidence from the repository
// (deployment/<network>/snapshots/<campaign>/, public files), prints what the owner can claim, and with --send signs the
// claim transactions with the given keypair file (never printed, never copied). Nothing else is written anywhere.
import {readFileSync,existsSync} from 'node:fs';import {fileURLToPath} from 'node:url';
import {Connection,Keypair,PublicKey,Transaction,sendAndConfirmTransaction} from '@solana/web3.js';
import {createAssociatedTokenAccountIdempotentInstruction,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {networkProfile} from './network.mjs';import {readCampaign,receiptAddress} from './atomic-launch.mjs';
import {participantClaimInstruction,parentClaimInstruction,devClaimInstruction,parentClaimAddress,parentsAddress} from './atomic-claims.mjs';
import {buildCampaignSnapshot} from './import-parent-snapshot.mjs';import {publicSnapshot} from './parent-snapshot.mjs';
import {devPlan,unlockedRaw} from './vesting-plan.mjs';
const args=process.argv.slice(2),opt=n=>{const i=args.indexOf(n);return i>=0?args[i+1]:undefined;};const [campaignArg,ownerArg]=args.filter(a=>!a.startsWith('--')&&a!==opt('--send')&&a!==opt('--rpc'));
if(!campaignArg||!ownerArg)throw Error('usage: <campaign> <owner> [--send <keypair.json>] [--rpc <url>]');
const profile=networkProfile();const rpc=opt('--rpc')||profile.rpcUrl;if(!/^https?:\/\//.test(rpc))throw Error('RPC URL required (KIDS_HELIUS_RPC_URL or --rpc)');
const identities=JSON.parse(readFileSync(new URL('../deployment/MAINNET-IDENTITIES.json',import.meta.url),'utf8'));
const programId=new PublicKey(process.env.KIDS_PROGRAM_ID||(profile.network==='localnet'?JSON.parse(readFileSync(new URL('./.runtime/atomic-launch-program.json',import.meta.url),'utf8')).programId:identities.program.programId));
const connection=new Connection(rpc,'confirmed'),ctx={connection,programId},campaign=new PublicKey(campaignArg),owner=new PublicKey(ownerArg);
const genesis=await connection.getGenesisHash();if(profile.genesisHash&&genesis!==profile.genesisHash)throw Error('RPC is not '+profile.network);
const state=await readCampaign(ctx,campaign);if(state.phase!==3)throw Error('Campaign has not launched (phase '+state.phase+'); nothing to claim yet');
const report={network:profile.network,campaign:campaignArg,owner:ownerArg,mint:state.mint.toBase58(),claims:[]};const instructions=[];
// Participant: settled receipt, proportional share of 43.5 % of the supply.
const receipt=await connection.getAccountInfo(receiptAddress(programId,campaign,owner),'confirmed');
if(receipt&&receipt.owner.equals(programId)&&receipt.data.length===112){const d=receipt.data,accepted=d.readBigUInt64LE(104),settled=!!d[97],claimed=!!d[98];const allocation=settled&&state.settledAccepted>0n?state.supply*4350n/10000n*accepted/state.settledAccepted:0n;
 report.claims.push({kind:'participant',acceptedLamports:accepted.toString(),allocationRaw:allocation.toString(),claimed});if(settled&&!claimed&&allocation>0n)instructions.push(['participant',participantClaimInstruction(ctx,campaign,state.mint,owner)]);}
else report.claims.push({kind:'participant',note:'no receipt for this owner'});
// Parents: snapshot evidence from the repository, proof rebuilt locally, compared with the on-chain roots.
const dir=fileURLToPath(new URL('../deployment/'+profile.network+'/snapshots',import.meta.url));
const parentsInfo=await connection.getAccountInfo(parentsAddress(ctx,campaign),'confirmed');
if(parentsInfo&&existsSync(dir+'/'+campaignArg)){
 const snap=publicSnapshot(buildCampaignSnapshot({directory:dir,campaign:campaignArg,network:profile.network,genesisHash:genesis,parents:identities.parents.map(p=>({mint:p.mint,tokenProgram:p.tokenProgram}))}));
 for(const [index,tree] of snap.parents.entries()){const onChainRoot=parentsInfo.data.subarray(104+index*32,136+index*32).toString('hex');const entry=tree.entries.find(e=>e.owner===ownerArg);const claimInfo=await connection.getAccountInfo(parentClaimAddress(ctx,campaign,index,owner),'confirmed');
  const row={kind:'parent',index,mint:tree.mint,rootMatchesChain:tree.root===onChainRoot,eligible:!!entry,allocationRaw:entry?.allocation||'0',claimed:!!claimInfo};report.claims.push(row);
  if(entry&&!claimInfo&&row.rootMatchesChain)instructions.push(['parent'+index,parentClaimInstruction(ctx,campaign,owner,state.mint,index,owner,BigInt(entry.balance),BigInt(entry.allocation),entry.proof.map(p=>Buffer.from(p,'hex')))]);}
}else report.claims.push({kind:'parent',note:parentsInfo?'no snapshot evidence for this campaign in the repository':'parents not configured on chain'});
// Dev: 1 % at launch plus 2 % linear over three calendar months.
if(state.dev.equals(owner)){const plan=devPlan(state.supply,state.launchedAt),now=Math.floor(Date.now()/1000),unlocked=BigInt(plan.immediateRaw)+unlockedRaw('linear',plan.linearRaw,plan.start,plan.end,now),claimable=unlocked>state.devClaimed?unlocked-state.devClaimed:0n;
 report.claims.push({kind:'dev',totalRaw:plan.totalRaw,claimedRaw:state.devClaimed.toString(),claimableRaw:claimable.toString(),vestingEndUnix:plan.end});if(claimable>0n)instructions.push(['dev',devClaimInstruction(ctx,campaign,state.mint,owner)]);}
report.sendable=instructions.map(([k])=>k);console.log(JSON.stringify(report,null,2));
if(opt('--send')){
 const bytes=Uint8Array.from(JSON.parse(readFileSync(opt('--send'),'utf8')));const signer=Keypair.fromSecretKey(bytes);bytes.fill(0);if(!signer.publicKey.equals(owner))throw Error('Keypair does not belong to the owner');
 if(!instructions.length){console.log('Nothing to claim.');process.exit(0);}
 const destination=getAssociatedTokenAddressSync(state.mint,owner);
 for(const [kind,instruction] of instructions){const tx=new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(owner,destination,owner,state.mint),instruction);const signature=await sendAndConfirmTransaction(connection,tx,[signer],{commitment:'confirmed'});console.log(JSON.stringify({claimed:kind,signature}));}
}
