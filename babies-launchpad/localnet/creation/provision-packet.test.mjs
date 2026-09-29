import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,PublicKey,SystemProgram,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {createAssociatedTokenAccountIdempotentInstruction} from '@solana/spl-token';
import {buildProvisionPacket,verifyProvisionApproval,provisionTerms,provisionTermsHash,reviewedProvisionPolicy} from './provision-packet.mjs';
import {createInstruction,associatedTokenAddress,WSOL} from '../protocol-v2/client.mjs';
const address=()=>Keypair.generate().publicKey.toBase58();
import {provisionFixture} from '../test/helpers/provision-fixture.mjs';
test('provisioning binds immutable metadata, fixed economics and exact schedule without future mechanics',()=>{
 const {intent,quote}=provisionFixture(),terms=provisionTerms(intent);
 assert.deepEqual(terms.splitBps,{participants:4750,liquidity:4750,parentA:0,parentB:0,dev:500});assert.equal(terms.splitPolicy,3);assert.equal(terms.vestingRule,2);assert.deepEqual(terms.vesting,{instantBps:150,linearBps:350,months:3});assert.equal(terms.dev,intent.mint.creator);assert.equal(terms.creatorFeeEnabled,0);assert.equal(terms.metadataHash,intent.mint.metadata.documentHash);assert.equal(terms.deadline,String(2_000_000_000+intent.policy.fundingDurationSeconds));assert.equal(terms.launchDeadline,String(2_000_000_000+intent.policy.fundingDurationSeconds+intent.policy.launchWindowSeconds));
 for(const mutate of [q=>q.terms.supplySplitBps.dev=600,q=>q.terms.solFeeRouting.dev=30,q=>q.terms.platformCreationChargeLamports='1',q=>q.terms.mode='family',q=>q.terms.liquidityPolicy='recycle',q=>q.terms.feePolicy.creatorFeeEnabled=true,q=>q.terms.tokenSideFees='sell']){const q=structuredClone(quote);mutate(q);assert.throws(()=>reviewedProvisionPolicy(q));}
 for(const mutate of [p=>p.policy.hardCapLamports='1',p=>p.policy.tradeFeeBps=250,p=>p.policy.fundingDurationSeconds=0,p=>p.authorityBudgetLamports='-1',p=>p.treasury=p.mint.authority,p=>p.opensAt='9223372036854775807',p=>p.mint.metadata.uri='javascript:x',p=>p.liquidityPolicy='recycle']){const p=structuredClone(intent);mutate(p);assert.throws(()=>provisionTerms(p));}
});
test('two creator-only packets fit wire limit; create and PDA funding remain atomic',()=>{
 const {intent,block}=provisionFixture(),m=intent.mint,prep=buildProvisionPacket(intent,'native-custody',block),create=buildProvisionPacket(intent,'create-campaign',block);
 assert.equal(create.serialize().length,1122);assert.ok(prep.serialize().length<1232);assert.equal(create.message.header.numRequiredSignatures,1);assert.equal(create.message.compiledInstructions.length,2);
 const ix=create.message.compiledInstructions[1],keys=create.message.staticAccountKeys;assert.equal(keys[ix.programIdIndex].toBase58(),SystemProgram.programId.toBase58());assert.equal(keys[ix.accountKeyIndexes[0]].toBase58(),m.creator);assert.equal(keys[ix.accountKeyIndexes[1]].toBase58(),m.authority);assert.equal(Buffer.from(ix.data).readBigUInt64LE(4),300000000n);
 const all=[createAssociatedTokenAccountIdempotentInstruction(new PublicKey(m.creator),associatedTokenAddress(m.authority,WSOL),new PublicKey(m.authority),WSOL),createInstruction(m.programId,provisionTerms(intent)).instruction,SystemProgram.transfer({fromPubkey:new PublicKey(m.creator),toPubkey:new PublicKey(m.authority),lamports:300000000n})];
 const oversized=new VersionedTransaction(new TransactionMessage({payerKey:new PublicKey(m.creator),recentBlockhash:block.blockhash,instructions:all}).compileToV0Message());assert.equal(oversized.serialize().length,1260);
 assert.equal(provisionTermsHash(intent).length,64);
});
test('approval rejects unsigned, wrong-wallet, altered budget, extra transfer and stale block substitution',()=>{
 const {intent,creator,block}=provisionFixture();
 for(const stage of ['native-custody','create-campaign']){
  const tx=buildProvisionPacket(intent,stage,block),encode=()=>Buffer.from(tx.serialize()).toString('base64');assert.throws(()=>verifyProvisionApproval(intent,stage,block,encode()));tx.sign([creator]);const signed=encode();assert.equal(verifyProvisionApproval(intent,stage,block,signed).stage,stage);
  assert.throws(()=>verifyProvisionApproval(intent,stage,{...block,blockhash:address()},signed));assert.throws(()=>verifyProvisionApproval(intent,stage,block,signed+'\n'));
  tx.signatures[0][0]^=1;assert.throws(()=>verifyProvisionApproval(intent,stage,block,encode()));
 }
 const changed=structuredClone(intent);changed.authorityBudgetLamports='300000001';const malicious=buildProvisionPacket(changed,'create-campaign',block);malicious.sign([creator]);assert.throws(()=>verifyProvisionApproval(intent,'create-campaign',block,Buffer.from(malicious.serialize()).toString('base64')));
 const tx=buildProvisionPacket(intent,'create-campaign',block);tx.message.compiledInstructions.push(tx.message.compiledInstructions[1]);tx.sign([creator]);assert.throws(()=>verifyProvisionApproval(intent,'create-campaign',block,Buffer.from(tx.serialize()).toString('base64')));
});
