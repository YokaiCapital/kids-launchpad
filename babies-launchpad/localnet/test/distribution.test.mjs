import test from 'node:test';import assert from 'node:assert/strict';import {Keypair,PublicKey} from '@solana/web3.js';
import {distributionAddress,vaultAuthority,vaultAddress,claimReceiptAddress,decodeDistribution,distributionSummary,claimParticipantInstruction,claimParentInstruction,claimDevInstruction,burnExpiredInstruction,sweepDonationInstruction,OFF,DISTRIBUTION_LEN,PARENT_EXPIRY_SECONDS} from '../distribution.mjs';
const pk=()=>Keypair.generate().publicKey;const programId=pk(),campaign=pk(),mint=pk(),owner=pk();
function account(){const d=Buffer.alloc(DISTRIBUTION_LEN);d.write('KIDSDST1',0);campaign.toBuffer().copy(d,OFF.campaign);mint.toBuffer().copy(d,OFF.mint);d.writeBigUInt64LE(1000000000000000n,OFF.supply);d.writeBigInt64LE(1000n,OFF.launchTime);d.writeBigInt64LE(1000n+BigInt(PARENT_EXPIRY_SECONDS),OFF.parentExpiry);
 [435000000000000n,50000000000000n,50000000000000n,30000000000000n].forEach((a,k)=>d.writeBigUInt64LE(a,OFF.allocation+8*k));d.writeBigUInt64LE(5n,OFF.claimed+8);d.writeBigUInt64LE(7n,OFF.burned);d[OFF.flags]=1|2;return {owner:programId,data:d};}
test('addresses are bound to program, campaign, purpose and owner',()=>{
 assert.notEqual(vaultAuthority(programId,campaign,1).toBase58(),vaultAuthority(programId,campaign,2).toBase58());
 assert.notEqual(distributionAddress(programId,campaign).toBase58(),distributionAddress(pk(),campaign).toBase58());
 assert.notEqual(claimReceiptAddress(programId,campaign,1,owner).toBase58(),claimReceiptAddress(programId,campaign,1,pk()).toBase58());
 assert.ok(!PublicKey.isOnCurve(vaultAuthority(programId,campaign,0).toBytes()));assert.ok(vaultAddress(programId,campaign,0,mint));
});
test('decoder reads allocations, counters, flags and the parent window',()=>{
 const dist=decodeDistribution(account(),programId);assert.equal(dist.allocation[0],435000000000000n);assert.equal(dist.claimed[1],5n);assert.equal(dist.burned[0],7n);assert.equal(dist.activated,true);assert.deepEqual(dist.parentBurned,[true,false]);
 const s=distributionSummary(dist,1000+PARENT_EXPIRY_SECONDS-1);assert.equal(s.parentWindowOpen,true);assert.equal(s.remaining[1],50000000000000n-5n-7n);
 assert.equal(distributionSummary(dist,1000+PARENT_EXPIRY_SECONDS).parentExpired,true);assert.equal(distributionSummary(dist,999).parentWindowOpen,false);
 assert.throws(()=>decodeDistribution({owner:pk(),data:account().data},programId),/Not a distribution/);
});
test('instruction builders: tags, bodies and signer flags',()=>{
 const p=claimParticipantInstruction({programId,campaign,mint,owner,receipt:pk()});assert.equal(p.data[0],1);assert.equal(p.keys.length,10);assert.ok(p.keys[0].isSigner&&p.keys[0].pubkey.equals(owner));
 const proof=[Buffer.alloc(32,1),Buffer.alloc(32,2)];const c=claimParentInstruction({programId,campaign,mint,owner,index:1,balance:10n,allocation:3n,proof});assert.equal(c.data.length,2+8+8+1+64);assert.equal(c.data[1],1);assert.equal(c.data[18],2);assert.ok(c.keys[4].pubkey.equals(vaultAuthority(programId,campaign,2)));
 const d=claimDevInstruction({programId,campaign,mint,dev:owner});assert.equal(d.data[0],3);assert.equal(d.keys.length,7);
 const b=burnExpiredInstruction({programId,campaign,mint,index:1});assert.deepEqual([...b.data],[4,1]);assert.ok(b.keys[2].pubkey.equals(vaultAuthority(programId,campaign,2)));assert.ok(b.keys.every(k=>!k.isSigner),'burn needs no signer');
 const s=sweepDonationInstruction({programId,campaign,mint,purpose:3});assert.deepEqual([...s.data],[5,3]);assert.throws(()=>burnExpiredInstruction({programId,campaign,mint,index:2}),/index/);
});
test('launch builders: init records the program as an optional fourth account; launch carries 29 or 40 accounts in the documented order',async()=>{
 const {initInstruction,launchInstruction,campaignAddress}=await import('../atomic-launch.mjs');
 const ctx={programId:pk()},creator=pk(),terms={nonce:7n,soft:1n,hard:2n,deadline:3,launchDeadline:4,mint:pk(),supply:5n,dev:pk(),treasury:pk()};
 assert.equal(initInstruction(ctx,creator,terms).keys.length,3);const withProgram=initInstruction(ctx,creator,terms,programId);assert.equal(withProgram.keys.length,4);assert.ok(withProgram.keys[3].pubkey.equals(programId)&&!withProgram.keys[3].isWritable);
 const camp=campaignAddress(ctx.programId,creator,7n),nft=pk();
 const plain=launchInstruction(ctx,camp,creator,mint,nft);assert.equal(plain.instruction.keys.length,29);assert.equal(plain.addresses.vaults,null);
 const full=launchInstruction(ctx,camp,creator,mint,nft,programId);const k=full.instruction.keys;assert.equal(k.length,40);
 assert.ok(k[29].pubkey.equals(programId)&&!k[29].isWritable);assert.ok(k[31].pubkey.equals(distributionAddress(programId,camp))&&k[31].isWritable);
 for(const p of [0,1,2,3]){assert.ok(k[32+p].pubkey.equals(vaultAuthority(programId,camp,p))&&!k[32+p].isWritable);assert.ok(k[36+p].pubkey.equals(vaultAddress(programId,camp,p,mint))&&k[36+p].isWritable);}
});
test('campaign decoder exposes the recorded distribution program and the activation flag',async()=>{
 const {readCampaign,campaignAddress}=await import('../atomic-launch.mjs');const creator=pk(),ctx={programId:pk()};const camp=campaignAddress(ctx.programId,creator,9n);
 const d=Buffer.alloc(384);d.write('KIDSESC3',0);creator.toBuffer().copy(d,8);d.writeBigUInt64LE(9n,40);programId.toBuffer().copy(d,312);d[344]=1;
 const state=await readCampaign({programId:ctx.programId,connection:{getAccountInfo:async()=>({owner:ctx.programId,data:d,lamports:1})}},camp);
 assert.ok(state.distributionProgram.equals(programId));assert.equal(state.distributionActivated,true);
 d.fill(0,312,345);const none=await readCampaign({programId:ctx.programId,connection:{getAccountInfo:async()=>({owner:ctx.programId,data:d,lamports:1})}},camp);assert.equal(none.distributionProgram,null);assert.equal(none.distributionActivated,false);
});
