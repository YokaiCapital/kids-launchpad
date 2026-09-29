// Exercise the external-signature protocol using a funded LOCALNET fixture key.
// The prepare/submit service never receives the private key or a local-sign flag.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {VersionedTransaction} from '@solana/web3.js';
import {localKey} from './dev-vesting.mjs';
import {qualifiedCampaign,postlaunchClaims} from './postlaunch-claims.mjs';
import {preparePostlaunchClaim,submitPostlaunchClaim} from './postlaunch-claim-intents.mjs';
import {getAccount,getAssociatedTokenAddressSync} from '@solana/spl-token';
const {ctx,campaign,state}=await qualifiedCampaign(),wallet=localKey('alice'),owner=wallet.publicKey.toBase58();
assert.equal(ctx.manifest.rpcUrl,'http://127.0.0.1:19099');assert.ok(state.dev.equals(wallet.publicKey),'Fixture dev must be Alice');
const claims=await postlaunchClaims(owner);assert.ok(BigInt(claims.dev.claimableRaw)>0n,'Wait for additional localnet vesting before verification');
const destination=getAssociatedTokenAddressSync(state.mint,wallet.publicKey),before=(await getAccount(ctx.connection,destination)).amount;
const request={campaign:campaign.toBase58(),action:'dev',requestId:randomUUID()},intent=await preparePostlaunchClaim(owner,request);
const tx=VersionedTransaction.deserialize(Buffer.from(intent.unsignedTransactionBase64,'base64'));tx.sign([wallet]);
const result=await submitPostlaunchClaim(owner,{intentId:intent.intentId,signedTransactionBase64:Buffer.from(tx.serialize()).toString('base64')});
const after=(await getAccount(ctx.connection,destination)).amount;assert.ok(after>before);const replay=await submitPostlaunchClaim(owner,{intentId:intent.intentId});assert.equal(replay.signature,result.signature);assert.equal((await getAccount(ctx.connection,destination)).amount,after);
console.log(JSON.stringify({network:'localnet',signature:result.signature,checks:['wallet-signed claim confirmed','recipient token balance increased','replayed intent returns same signature without second payout']}));
