import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {Keypair,PublicKey,Transaction,sendAndConfirmTransaction} from '@solana/web3.js';
import {atomicContext,campaignAddress,initInstruction,commitInstruction,finalizeInstruction,refundInstruction,settleInstruction,readyInstruction,readCampaign} from './atomic-launch.mjs';
import {configureParentsInstruction} from './atomic-claims.mjs';
import {captureLocalParentSnapshot} from './parent-snapshot.mjs';
import {localKey,chainTime} from './dev-vesting.mjs';
const ctx=await atomicContext(),c=ctx.connection,admin=localKey('admin'),alice=localKey('alice'),bob=localKey('bob');
const previous=JSON.parse(readFileSync(new URL('./.runtime/atomic-launch-verification.json',import.meta.url))),parents=previous.parentMints.map(x=>new PublicKey(x));
const send=(instruction,signers=[admin])=>sendAndConfirmTransaction(c,new Transaction().add(instruction),signers,{commitment:'confirmed'});
async function rejected(fn){try{await fn();assert.fail('Expected chain rejection');}catch(e){assert.ok(e.transactionLogs?.some(l=>l.startsWith('Program '+ctx.programId+' failed:')),'Must reject on-chain');}}
async function until(timestamp){const begin=Date.now();while(await chainTime(c)<timestamp){if(Date.now()-begin>60000)throw Error('Local clock stalled');await new Promise(r=>setTimeout(r,250));}}
const checks=[];
for(const timeout of [false,true]){
 const nonce=randomBytes(8).readBigUInt64LE(),campaign=campaignAddress(ctx.programId,admin.publicKey,nonce),snap=await captureLocalParentSnapshot(ctx,campaign,parents),now=await chainTime(c),deadline=now+8,launchDeadline=deadline+8;
 await send(initInstruction(ctx,admin.publicKey,{nonce,soft:1000000000n,hard:3000000000n,deadline,launchDeadline,mint:Keypair.generate().publicKey,supply:1000000000000000n,dev:alice.publicKey,treasury:admin.publicKey}));
 await send(configureParentsInstruction(ctx,campaign,admin.publicKey,parents,snap.parents.map(p=>p.root),snap.slot,snap.parents.map(p=>p.eligibleBalance)));
 const amount=timeout?2000000000n:500000000n,owners=timeout?[alice,bob]:[alice];
 for(const owner of owners)await send(commitInstruction(ctx,campaign,owner.publicKey,amount,0n),[owner]);
 const funded=await readCampaign(ctx,campaign);
 await rejected(()=>send(commitInstruction(ctx,campaign,alice.publicKey,1n,0n),[alice]));assert.equal((await readCampaign(ctx,campaign)).total,funded.total);
 await rejected(()=>send(refundInstruction(ctx,campaign,alice.publicKey)));
 await until(deadline);await send(finalizeInstruction(ctx,campaign));
 if(timeout){
  for(const owner of owners)await send(settleInstruction(ctx,campaign,owner.publicKey));
  await send(readyInstruction(ctx,campaign));
  const before=await c.getBalance(alice.publicKey);await send(refundInstruction(ctx,campaign,alice.publicKey));assert.equal(await c.getBalance(alice.publicKey)-before,500000000);
  await until(launchDeadline);await send(finalizeInstruction(ctx,campaign));
 }
 await rejected(()=>send(readyInstruction(ctx,campaign)));
 for(const owner of owners){const already=timeout&&owner===alice?500000000n:0n,before=await c.getBalance(owner.publicKey);await send(refundInstruction(ctx,campaign,owner.publicKey));assert.equal(BigInt(await c.getBalance(owner.publicKey)-before),amount-already);await send(refundInstruction(ctx,campaign,owner.publicKey));assert.equal(BigInt(await c.getBalance(owner.publicKey)-before),amount-already);}
 const after=await readCampaign(ctx,campaign);assert.equal(after.phase,2);assert.equal(after.refunded,after.total);assert.equal(after.lamports,BigInt(await c.getMinimumBalanceForRentExemption(384)));
 checks.push(timeout?'missed launch fully refunds after earlier excess payout; replay safe':'below soft cap fully refunds; replay safe');
}
const report={network:'localnet',programId:ctx.programId.toBase58(),programSha256:ctx.manifest.sha256,checks:[...checks,'repeated commitment sequence rejected without increasing escrow','refund before funding close rejected','failed campaigns cannot launch and preserve rent'],verifiedAt:new Date().toISOString()};
writeFileSync(new URL('./.runtime/atomic-failure-verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report,null,2));
