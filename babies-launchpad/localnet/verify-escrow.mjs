import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {Transaction,TransactionInstruction,SystemProgram,sendAndConfirmTransaction,PublicKey} from '@solana/web3.js';
import {escrowContext,campaignAddress,receiptAddress,initInstruction,commitInstruction,refundInstruction,finalizeInstruction,readCampaign,readReceipt,amounts,preparePrelaunch,submitPrelaunch,prelaunchState} from './escrow.mjs';
import {localKey,chainTime} from './dev-vesting.mjs';
const ctx=await escrowContext(),admin=localKey('admin'),alice=localKey('alice'),bob=localKey('bob'),checks=[];
async function send(ix,signer=admin){return sendAndConfirmTransaction(ctx.connection,new Transaction().add(ix),[signer],{commitment:'confirmed'});}
async function rejected(name,ix,signer=admin){await assert.rejects(()=>send(ix,signer));checks.push(name);}
const now=await chainTime(ctx.connection),deadline=now+12,launchDeadline=now+24;
async function fixture(soft,hard){const nonce=randomBytes(8).readBigUInt64LE(),terms={nonce,soft,hard,deadline,launchDeadline},address=campaignAddress(ctx.programId,admin.publicKey,nonce);await send(SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:address,lamports:890880}));await send(initInstruction(ctx,admin.publicKey,terms));return address;}
const failed=await fixture(10000000n,20000000n),oversubscribed=await fixture(10000000n,20000000n);
await send(SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:receiptAddress(ctx.programId,oversubscribed,alice.publicKey),lamports:890880}));
await send(commitInstruction(ctx,failed,alice.publicKey,5000000n,0n),alice);
await send(commitInstruction(ctx,oversubscribed,alice.publicKey,11000001n,0n),alice);
await send(commitInstruction(ctx,oversubscribed,bob.publicKey,20000000n,0n),bob);checks.push('prefunded campaign and receipt PDAs work');
await rejected('duplicate commitment sequence rejected',commitInstruction(ctx,oversubscribed,alice.publicKey,1n,0n),alice);
await rejected('early refund rejected',refundInstruction(ctx,oversubscribed,alice.publicKey));
await rejected('early settlement rejected',finalizeInstruction(ctx,oversubscribed));
const forged=commitInstruction(ctx,oversubscribed,bob.publicKey,1n,1n);forged.keys[2].pubkey=receiptAddress(ctx.programId,oversubscribed,alice.publicKey);await rejected('other-wallet receipt rejected',forged,bob);
await rejected('unknown admin withdrawal instruction rejected',new TransactionInstruction({programId:ctx.programId,keys:[{pubkey:oversubscribed,isSigner:false,isWritable:true},{pubkey:admin.publicKey,isSigner:true,isWritable:true}],data:Buffer.from([4])}));
while(await chainTime(ctx.connection)<deadline)await new Promise(r=>setTimeout(r,500));
await send(finalizeInstruction(ctx,failed));await send(finalizeInstruction(ctx,oversubscribed));
await rejected('late commitment rejected',commitInstruction(ctx,oversubscribed,bob.publicKey,1n,1n),bob);
await rejected('refund redirect rejected',refundInstruction(ctx,oversubscribed,alice.publicKey,admin.publicKey));
const cross=refundInstruction(ctx,oversubscribed,alice.publicKey);cross.keys[1].pubkey=receiptAddress(ctx.programId,failed,alice.publicKey);await rejected('cross-campaign receipt rejected',cross);
let before=await ctx.connection.getBalance(alice.publicKey);
await send(refundInstruction(ctx,failed,alice.publicKey));assert.equal(await ctx.connection.getBalance(alice.publicKey)-before,5000000);checks.push('below-soft-cap full refund paid to participant by keeper');
for(const wallet of [alice,bob]){const c=await readCampaign(ctx,oversubscribed),r=await readReceipt(ctx,oversubscribed,wallet.publicKey),expected=amounts(c,r,await chainTime(ctx.connection)).refundable;before=await ctx.connection.getBalance(wallet.publicKey);await send(refundInstruction(ctx,oversubscribed,wallet.publicKey));assert.equal(BigInt(await ctx.connection.getBalance(wallet.publicKey)-before),expected);}
checks.push('oversubscribed pro-rata excess refunds match exact lamports');
let c=await readCampaign(ctx,oversubscribed);assert.ok(c.total-c.refunded<=c.hard&&c.total-c.refunded>0n);const locked=c.lamports;await send(refundInstruction(ctx,oversubscribed,alice.publicKey));assert.equal((await readCampaign(ctx,oversubscribed)).lamports,locked);checks.push('duplicate refund cannot drain accepted escrow');
while(await chainTime(ctx.connection)<launchDeadline)await new Promise(r=>setTimeout(r,500));
for(const wallet of [alice,bob])await send(refundInstruction(ctx,oversubscribed,wallet.publicKey));
c=await readCampaign(ctx,oversubscribed);assert.equal(c.refunded,c.total);checks.push('missed-launch timeout returns all accepted funds without admin release');
for(const wallet of [alice,bob]){const r=await readReceipt(ctx,oversubscribed,wallet.publicKey);assert.equal(r.refunded,r.committed);}
// Exercise the actual app intent path against the active campaign, with a
// clearly tiny localnet contribution. Never touches a mainnet RPC.
const state=await prelaunchState(alice.publicKey.toBase58()),active=new PublicKey(state.escrowAddress),address=receiptAddress(ctx.programId,active,alice.publicKey);
if(!(await ctx.connection.getAccountInfo(address)))await send(SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:address,lamports:890880}));
const request={action:'commit',amountLamports:'1000000',requestId:randomUUID()};const [intent,again]=await Promise.all([preparePrelaunch(alice.publicKey.toBase58(),request),preparePrelaunch(alice.publicKey.toBase58(),request)]);assert.equal(intent.unsignedTransactionBase64,again.unsignedTransactionBase64);
await assert.rejects(()=>submitPrelaunch(bob.publicKey.toBase58(),{intentId:intent.intentId,local:true}));checks.push('session owner bound to transaction intent');
const changed=Transaction.from(Buffer.from(intent.unsignedTransactionBase64,'base64'));changed.instructions[0].data[1]^=1;changed.sign(alice);await assert.rejects(()=>submitPrelaunch(alice.publicKey.toBase58(),{intentId:intent.intentId,signedTransactionBase64:changed.serialize().toString('base64')}));checks.push('altered signed instruction rejected');
const result=await submitPrelaunch(alice.publicKey.toBase58(),{intentId:intent.intentId,local:true});const retry=await submitPrelaunch(alice.publicKey.toBase58(),{intentId:intent.intentId,local:true});assert.equal(retry.signature,result.signature);checks.push('prefunded receipt works through API; concurrent prepare and submit retry idempotent');
const report={network:'localnet',programId:ctx.programId.toBase58(),genesisHash:ctx.config.genesisHash,checks,fixtures:{failed:failed.toBase58(),oversubscribed:oversubscribed.toBase58()},activeCommitSignature:result.signature};
writeFileSync(fileURLToPath(new URL('./.runtime/escrow-verification.json',import.meta.url)),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report,null,2));
