// Bounded localnet fixture; never modifies the active application campaign.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Transaction,sendAndConfirmTransaction} from '@solana/web3.js';
import {escrowContext,campaignAddress,initInstruction,commitInstruction,settleInstruction,readyInstruction,refundInstruction,readCampaign,readReceipt,isFundingReady} from './launch-escrow.mjs';
import {localKey,chainTime} from './dev-vesting.mjs';
const ctx=await escrowContext(),admin=localKey('admin'),alice=localKey('alice'),bob=localKey('bob');
const send=ix=>sendAndConfirmTransaction(ctx.connection,new Transaction().add(ix),[admin],{commitment:'confirmed'});
const now=await chainTime(ctx.connection),deadline=now+10,launchDeadline=now+20,nonce=randomBytes(8).readBigUInt64LE(),address=campaignAddress(ctx.programId,admin.publicKey,nonce);
await send(initInstruction(ctx,admin.publicKey,{nonce,soft:1n,hard:3n,deadline,launchDeadline}));
for(const owner of [alice,bob])await sendAndConfirmTransaction(ctx.connection,new Transaction().add(commitInstruction(ctx,address,owner.publicKey,2n,0n)),[owner],{commitment:'confirmed'});
assert.equal((await readCampaign(ctx,address)).receiptCount,2n);
await assert.rejects(()=>send(settleInstruction(ctx,address,alice.publicKey)));
while(await chainTime(ctx.connection)<deadline)await new Promise(r=>setTimeout(r,250));
await send(settleInstruction(ctx,address,alice.publicKey));
await send(settleInstruction(ctx,address,alice.publicKey));
assert.equal((await readCampaign(ctx,address)).settledReceiptCount,1n);
await assert.rejects(()=>send(readyInstruction(ctx,address)));
await send(settleInstruction(ctx,address,bob.publicKey));
const settled=await readCampaign(ctx,address);assert.equal(settled.settledAccepted,2n);assert.equal(settled.total-settled.settledAccepted,2n);assert.ok(isFundingReady(settled,await chainTime(ctx.connection)));
await send(readyInstruction(ctx,address));
for(const owner of [alice,bob]){const receipt=await readReceipt(ctx,address,owner.publicKey);assert.equal(receipt.accepted,1n);assert.ok(receipt.settled);await send(refundInstruction(ctx,address,owner.publicKey));}
assert.equal((await readCampaign(ctx,address)).refunded,2n);
while(await chainTime(ctx.connection)<launchDeadline)await new Promise(r=>setTimeout(r,250));
await assert.rejects(()=>send(readyInstruction(ctx,address)));
for(const owner of [alice,bob])await send(refundInstruction(ctx,address,owner.publicKey));
assert.equal((await readCampaign(ctx,address)).refunded,4n);
console.log(JSON.stringify({programId:ctx.programId.toBase58(),campaign:address.toBase58(),checks:['registered receipt count','early settlement rejected','idempotent settlement','incomplete readiness rejected','exact aggregate retains refund dust','per-receipt frozen acceptance','pro-rata refunds','launch-timeout full refunds','expired readiness rejected']}));
