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
