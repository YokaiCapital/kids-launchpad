// Bounded service verification: one 0.001 test-SOL commitment, never mainnet.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Transaction} from '@solana/web3.js';
import {provisionActiveLaunch} from './provision-active-launch.mjs';
import {activeContext,activeManifest,readActive,readActiveReceipt,prepareActive,submitActive} from './active-launch.mjs';
import {localKey} from './dev-vesting.mjs';
const before=await provisionActiveLaunch(),again=await provisionActiveLaunch();assert.equal(before.escrowAddress,again.escrowAddress);assert.equal(before.mint,again.mint);
const alice=localKey('alice'),bob=localKey('bob'),owner=alice.publicKey.toBase58(),ctx=await activeContext(),m=activeManifest(ctx),prior=await readActiveReceipt(ctx,m.address,owner);
const input={action:'commit',amountLamports:'1000000',requestId:randomUUID()},intent=await prepareActive(owner,input),same=await prepareActive(owner,input);assert.equal(intent.unsignedTransactionBase64,same.unsignedTransactionBase64);
await assert.rejects(prepareActive(owner,{...input,amountLamports:'2000000'}),/different terms/);
await assert.rejects(submitActive(bob.publicKey.toBase58(),{intentId:intent.intentId,local:true}),/another wallet/);
const tampered=Transaction.from(Buffer.from(intent.unsignedTransactionBase64,'base64'));tampered.instructions[0].data.writeBigUInt64LE(2000000n,1);tampered.sign(alice);
await assert.rejects(submitActive(owner,{intentId:intent.intentId,signedTransactionBase64:tampered.serialize().toString('base64')}),/does not match/);
const submitted=await submitActive(owner,{intentId:intent.intentId,local:true}),retry=await submitActive(owner,{intentId:intent.intentId,local:true});assert.equal(submitted.signature,retry.signature);
const after=await readActiveReceipt(ctx,m.address,owner);assert.equal(after.committed-prior.committed,1000000n);assert.equal(after.sequence-prior.sequence,1n);
await assert.rejects(prepareActive(owner,{action:'refund',requestId:randomUUID()}),/No refund/);
console.log(JSON.stringify({network:'localnet',campaign:m.address,mint:m.mint,signature:submitted.signature,checks:['provision resumes same campaign','request id stable','changed terms rejected','other owner rejected','signed-message tampering rejected','same signed retry returns same receipt','one exact commitment and sequence','premature refund unavailable'],state:await readActive(owner)},null,2));
