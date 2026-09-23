import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {Keypair,PublicKey,Transaction,TransactionInstruction,SystemProgram,ComputeBudgetProgram,AddressLookupTableProgram,TransactionMessage,VersionedTransaction,sendAndConfirmTransaction} from '@solana/web3.js';
import {NATIVE_MINT,getOrCreateAssociatedTokenAccount,createMint,mintTo,setAuthority,AuthorityType,getAccount,getMint,burn,transfer} from '@solana/spl-token';
import {atomicContext,campaignAddress,authorityAddress,initInstruction,commitInstruction,settleInstruction,refundInstruction,launchInstruction,readCampaign,CPMM,LOCK} from './atomic-launch.mjs';
import {localKey,chainTime} from './dev-vesting.mjs';
import {decodePool} from './cpmm.mjs';
import {participantClaimInstruction,devClaimInstruction,configureParentsInstruction,parentClaimInstruction,parentTree,parentClaimAddress} from './atomic-claims.mjs';
import {threeMonthsAfter} from './vesting-plan.mjs';
import {captureLocalParentSnapshot,publicSnapshot} from './parent-snapshot.mjs';
import {createToken2022Parent,revokeToken2022Authorities} from './token2022-fixture.mjs';
// KIDS_PARENT_B_TOKEN_2022=1 makes the second parent a Token-2022 mint shaped like Buttcoin (metadata pointer + metadata, authorities revoked).
import {distributionProgramFor,distributionAddress,vaultAddress,decodeDistribution,distributionSummary,claimParticipantInstruction,claimParentInstruction,claimDevInstruction,burnExpiredInstruction,sweepDonationInstruction,PARENT_EXPIRY_SECONDS} from './distribution.mjs';
import {receiptAddress as launchReceiptAddress} from './atomic-launch.mjs';
const PARENT_B_TOKEN_2022=process.env.KIDS_PARENT_B_TOKEN_2022==='1';
const ctx=await atomicContext(),c=ctx.connection,admin=localKey('admin'),alice=localKey('alice'),bob=localKey('bob'),poor=Keypair.generate(),nft=Keypair.generate();
const send=(ix,signers=[admin])=>sendAndConfirmTransaction(c,new Transaction().add(ix),signers,{commitment:'confirmed'});
const rejectionEvidence=[];
async function reject(name,action,program,reason){let error;try{await action();}catch(e){error=e;}assert.ok(error,name+' must fail');const logs=error.transactionLogs;assert.ok(Array.isArray(logs),name+' must fail on chain, not transport');assert.ok(logs.some(l=>l.startsWith('Program '+program+' failed:')),name+' reached expected program: '+logs.join('\n'));assert.match(logs.join('\n'),reason);rejectionEvidence.push({name,errors:logs.filter(l=>/error|failed/i.test(l))});}
for(const owner of [alice,bob])if(await c.getBalance(owner.publicKey)<5000000000){const s=await c.requestAirdrop(owner.publicKey,10000000000);await c.confirmTransaction(s,'confirmed');}
const nonce=randomBytes(8).readBigUInt64LE(),campaign=campaignAddress(ctx.programId,admin.publicKey,nonce),authority=authorityAddress(ctx,campaign),supply=1000000000000000n;
const mint=await createMint(c,admin,admin.publicKey,admin.publicKey,6),child=await getOrCreateAssociatedTokenAccount(c,admin,mint,authority,true),wsol=await getOrCreateAssociatedTokenAccount(c,admin,NATIVE_MINT,authority,true);
await mintTo(c,admin,mint,child.address,admin,supply);
await setAuthority(c,admin,mint,admin,AuthorityType.MintTokens,authority);await setAuthority(c,admin,mint,admin,AuthorityType.FreezeAccount,authority);
await send(SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:authority,lamports:300000000}));
await send(SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:poor.publicKey,lamports:1000000}));
await send(SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:wsol.address,lamports:12345}));
const distributionProgram=distributionProgramFor('localnet');if(!distributionProgram)throw Error('Deploy kids-distribution on the localnet first (node localnet/kids-distribution-deploy.mjs)');
const good=launchInstruction(ctx,campaign,admin.publicKey,mint,nft.publicKey,distributionProgram),lateFailure=launchInstruction(ctx,campaign,poor.publicKey,mint,nft.publicKey,distributionProgram),p=good.addresses;
const nativeVault=p.mint0.equals(NATIVE_MINT)?p.vault0:p.vault1;
// The four vault token accounts exist before the launch (activation does not create accounts: the launch packet is near the nested-instruction limit).
for(const [k,authorityK] of p.vaults.authorities.entries())assert.ok((await getOrCreateAssociatedTokenAccount(c,admin,mint,authorityK,true)).address.equals(p.vaults.accounts[k]));
await send(SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:nativeVault,lamports:(await c.getMinimumBalanceForRentExemption(165))+1}));
const [createTable,tableAddress]=AddressLookupTableProgram.createLookupTable({authority:admin.publicKey,payer:admin.publicKey,recentSlot:await c.getSlot('finalized')});await send(createTable);
const addresses=[...new Map([...good.instruction.keys,...lateFailure.instruction.keys].map(k=>[k.pubkey.toBase58(),k.pubkey])).values()];
for(let i=0;i<addresses.length;i+=20)await send(AddressLookupTableProgram.extendLookupTable({lookupTable:tableAddress,authority:admin.publicKey,payer:admin.publicKey,addresses:addresses.slice(i,i+20)}));
const table=(await c.getAddressLookupTable(tableAddress)).value;while(await c.getSlot('confirmed')<=table.state.lastExtendedSlot)await new Promise(r=>setTimeout(r,200));
async function launch(ix,extra=[]){const block=await c.getLatestBlockhash('confirmed'),msg=new TransactionMessage({payerKey:admin.publicKey,recentBlockhash:block.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),ix]}).compileToV0Message([table]),tx=new VersionedTransaction(msg);tx.sign([admin,nft,...extra]);const signature=await c.sendTransaction(tx);const r=await c.confirmTransaction({...block,signature},'confirmed');assert.equal(r.value.err,null);return signature;}
const parentMints=[],parentTrees=[];
for(let index=0;index<2;index++){
 const amounts=index===0?[600000000000000n,400000000000000n]:[400000000000n,999600000000000n];
 let parentMint;
 if(index===1&&PARENT_B_TOKEN_2022){parentMint=await createToken2022Parent(c,admin,{holders:[{owner:alice.publicKey,amount:amounts[0]},{owner:bob.publicKey,amount:amounts[1]}]});await revokeToken2022Authorities(c,admin,parentMint);}
 else{parentMint=await createMint(c,admin,admin.publicKey,null,6);for(const [i,owner] of [alice,bob].entries()){const token=await getOrCreateAssociatedTokenAccount(c,admin,parentMint,owner.publicKey);await mintTo(c,admin,parentMint,token.address,admin,amounts[i]);}}
 parentMints.push(parentMint);
 parentTrees.push(parentTree(campaign,index,supply,[{owner:alice.publicKey,balance:amounts[0]},{owner:bob.publicKey,balance:amounts[1]}]));
}
const finalizingSlot=await c.getSlot('confirmed');const snapshotWait=Date.now();
while(await c.getSlot('finalized')<finalizingSlot){if(Date.now()-snapshotWait>30000)throw Error('Snapshot finalization stalled');await new Promise(r=>setTimeout(r,250));}
const parentSnapshot=await captureLocalParentSnapshot(ctx,campaign,parentMints);
parentTrees.splice(0,parentTrees.length,...parentSnapshot.parents);const snapshotSlot=parentSnapshot.slot;
writeFileSync(new URL('./.runtime/parent-snapshot-'+campaign.toBase58()+'.json',import.meta.url),JSON.stringify(publicSnapshot(parentSnapshot),null,2)+'\n',{mode:0o600});
const destinations=[];for(const owner of [alice,bob,admin])destinations.push((await getOrCreateAssociatedTokenAccount(c,admin,mint,owner.publicKey)).address);
const now=await chainTime(c),deadline=now+18,launchDeadline=now+180;
await send(initInstruction(ctx,admin.publicKey,{nonce,soft:1000000000n,hard:3000000000n,deadline,launchDeadline,mint,supply,dev:alice.publicKey,treasury:admin.publicKey},distributionProgram));
const configureParents=configureParentsInstruction(ctx,campaign,admin.publicKey,parentMints,parentTrees.map(t=>t.root),snapshotSlot,parentTrees.map(t=>t.eligibleBalance));
await reject('commit before parent configuration',()=>send(commitInstruction(ctx,campaign,alice.publicKey,2000000000n,0n),[alice]),ctx.programId,/custom program error: 0x16/);
await send(configureParents);
await reject('parent snapshot is immutable',()=>send(configureParents),ctx.programId,/instruction requires an uninitialized account/i);
await send(SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:campaign,lamports:777}));
for(const owner of [alice,bob])await send(commitInstruction(ctx,campaign,owner.publicKey,2000000000n,0n),[owner]);
await reject('participant claim before launch',()=>send(participantClaimInstruction(ctx,campaign,mint,alice.publicKey)),ctx.programId,/custom program error/);
await reject('dev claim before launch',()=>send(devClaimInstruction(ctx,campaign,mint,alice.publicKey)),ctx.programId,/custom program error/);
await reject('parent snapshot cannot change after commits',()=>send(configureParents),ctx.programId,/custom program error/);
await reject('launch before funding closes',()=>launch(good.instruction),ctx.programId,/custom program error: 0x15/);
while(await chainTime(c)<deadline)await new Promise(r=>setTimeout(r,250));
await send(settleInstruction(ctx,campaign,alice.publicKey));
await reject('incomplete settlement',()=>launch(good.instruction),ctx.programId,/custom program error: 0x15/);
await send(settleInstruction(ctx,campaign,bob.publicKey));
let state=await readCampaign(ctx,campaign);assert.equal(state.total,4000000000n);assert.equal(state.settledAccepted,3000000000n);
await send(refundInstruction(ctx,campaign,alice.publicKey));state=await readCampaign(ctx,campaign);assert.equal(state.refunded,500000000n);
const badKeys=good.instruction.keys.map((k,i)=>i===16?{...k,pubkey:SystemProgram.programId}:k);
await reject('wrong AMM config',()=>launch(new TransactionInstruction({programId:ctx.programId,keys:badKeys,data:good.instruction.data})),ctx.programId,/custom program error: 0x15/);
const before=await readCampaign(ctx,campaign),beforeAuthority=await c.getBalance(authority),beforeWsol=await getAccount(c,wsol.address);
await reject('lock payer cannot fund NFT rent',()=>launch(lateFailure.instruction,[poor]),LOCK,/insufficient lamports|insufficient funds/i);
assert.equal(await c.getAccountInfo(p.pool),null);assert.equal(await c.getAccountInfo(nft.publicKey),null);assert.equal((await readCampaign(ctx,campaign)).lamports,before.lamports);assert.equal(await c.getBalance(authority),beforeAuthority);assert.equal((await getAccount(c,wsol.address)).amount,beforeWsol.amount);assert.ok((await getMint(c,mint)).mintAuthority.equals(authority));assert.equal((await readCampaign(ctx,campaign)).phase,before.phase);
const signature=await launch(good.instruction);state=await readCampaign(ctx,campaign);assert.equal(state.phase,3);assert.ok(state.launchedAt>=deadline);assert.ok(state.pool.equals(p.pool));assert.ok(state.feeNft.equals(nft.publicKey));
assert.equal(decodePool(await c.getAccountInfo(p.pool),CPMM,p).creatorFeesEnabled,false);
const base=supply*435n/1000n,vault0=await getAccount(c,p.vault0),vault1=await getAccount(c,p.vault1);assert.equal(vault0.amount,p.mint0.equals(mint)?base:3000000001n);assert.equal(vault1.amount,p.mint1.equals(mint)?base:3000000001n);
assert.equal((await getAccount(c,child.address)).amount,0n,'custody is empty: everything beyond the pool sits in the vaults');assert.equal((await getAccount(c,wsol.address)).amount,12345n);assert.equal((await getAccount(c,p.lp)).amount,0n);const locked=await getAccount(c,p.lockVault);assert.ok(locked.amount>0n);const feeKey=await getAccount(c,p.feeNft);assert.ok(feeKey.owner.equals(campaign));assert.equal(feeKey.amount,1n);assert.equal((await getMint(c,nft.publicKey)).supply,1n);const childMint=await getMint(c,mint);assert.equal(childMint.mintAuthority,null);assert.equal(childMint.freezeAuthority,null);
const rent=BigInt(await c.getMinimumBalanceForRentExemption(384));assert.equal(state.lamports,rent+500000000n+777n);
const bobBefore=await c.getBalance(bob.publicKey);await send(refundInstruction(ctx,campaign,bob.publicKey));assert.equal(await c.getBalance(bob.publicKey)-bobBefore,500000000);await send(refundInstruction(ctx,campaign,bob.publicKey));state=await readCampaign(ctx,campaign);assert.equal(state.refunded,1000000000n);assert.equal(state.lamports,rent+777n);
await reject('repeated launch',()=>launch(good.instruction),ctx.programId,/custom program error: 0x15/);
// ---- Claim vaults (kids-distribution): funded and activated inside the launch above.
const dp=distributionProgram,dist=decodeDistribution(await c.getAccountInfo(distributionAddress(dp,campaign)),dp);
assert.ok(dist.activated&&dist.campaign.equals(campaign)&&dist.mint.equals(mint)&&dist.launchProgram.equals(ctx.programId)&&dist.dev.equals(alice.publicKey));
assert.equal(dist.supply,supply);assert.equal(dist.settledAccepted,state.settledAccepted);assert.equal(dist.launchTime,state.launchedAt);assert.equal(dist.parentExpiry,state.launchedAt+PARENT_EXPIRY_SECONDS);
const expectedAllocation=[supply*4350n/10000n,supply*500n/10000n,supply*500n/10000n,supply*300n/10000n];assert.deepEqual(dist.allocation,expectedAllocation);
for(const k of [0,1,2,3])assert.equal((await getAccount(c,vaultAddress(dp,campaign,k,mint))).amount,expectedAllocation[k],'vault '+k+' funded exactly');
assert.deepEqual(dist.roots,parentTrees.map(t=>Buffer.from(t.root).toString('hex')));
assert.ok(state.distributionActivated&&state.distributionProgram.equals(dp));
// Old custody claim paths are closed for this campaign (error 40 = 0x28).
await reject('old participant claim path after activation',()=>send(participantClaimInstruction(ctx,campaign,mint,alice.publicKey)),ctx.programId,/custom program error: 0x28/);
await reject('old dev claim path after activation',()=>send(devClaimInstruction(ctx,campaign,mint,alice.publicKey)),ctx.programId,/custom program error: 0x28/);
// Participants claim from vault 0, proportionally, once.
const claimP=owner=>claimParticipantInstruction({programId:dp,launchProgramId:ctx.programId,campaign,mint,owner:owner.publicKey,receipt:launchReceiptAddress(ctx.programId,campaign,owner.publicKey)});
for(const [i,owner] of [alice,bob].entries()){await send(claimP(owner),[owner]);assert.equal((await getAccount(c,destinations[i])).amount,217500000000000n);await send(claimP(owner),[owner]);assert.equal((await getAccount(c,destinations[i])).amount,217500000000000n,'second claim pays nothing');}
await reject('participant claim with another owner\'s receipt',()=>send(claimParticipantInstruction({programId:dp,launchProgramId:ctx.programId,campaign,mint,owner:alice.publicKey,receipt:launchReceiptAddress(ctx.programId,campaign,bob.publicKey)}),[alice]),dp,/custom program error/);
// Parents claim from their own vault inside the window; forged leaves and proofs are refused; a repeat pays nothing.
const claimedParents=[];
for(let index=0;index<2;index++)for(const entry of parentTrees[index].entries){
 const owner=new PublicKey(entry.owner),signer=owner.equals(alice.publicKey)?alice:bob,destination=destinations[owner.equals(alice.publicKey)?0:1];
 const build=(o={})=>claimParentInstruction({programId:dp,campaign,mint,owner,index,balance:o.balance??entry.balance,allocation:o.allocation??entry.allocation,proof:(o.proof??entry.proof).map(p=>Buffer.from(p))});
 await reject('forged parent allocation '+index,()=>send(build({allocation:entry.allocation+1n}),[signer]),dp,/custom program error/);
 if(entry.proof.length){const proof=entry.proof.map(p=>Buffer.from(p));proof[0][0]^=1;await reject('altered Merkle sibling '+index,()=>send(build({proof}),[signer]),dp,/custom program error/);}
 const before=(await getAccount(c,destination)).amount;await send(build(),[signer]);assert.equal((await getAccount(c,destination)).amount-before,entry.allocation);await send(build(),[signer]);assert.equal((await getAccount(c,destination)).amount-before,entry.allocation);
 claimedParents.push({parent:index,owner:entry.owner,amount:entry.allocation.toString()});
}
await reject('below threshold parent holder',()=>send(claimParentInstruction({programId:dp,campaign,mint,owner:alice.publicKey,index:1,balance:400000000000n,allocation:1n,proof:[]}),[alice]),dp,/custom program error/);
// Burning an expired parent vault is refused while the window is open; sweeping with nothing above the debt is a no-op.
await reject('burn before expiry',()=>send(burnExpiredInstruction({programId:dp,campaign,mint,index:0})),dp,/custom program error/);
await send(sweepDonationInstruction({programId:dp,campaign,mint,purpose:0}));
// A donation into a vault is burned by the sweep, never distributed.
await mintToVault();
async function mintToVault(){const v=vaultAddress(dp,campaign,3,mint);const before=(await getAccount(c,v)).amount;await transfer(c,admin,destinations[1],v,bob,1000n);assert.equal((await getAccount(c,v)).amount,before+1000n);const supplyBefore=(await getMint(c,mint)).supply;await send(sweepDonationInstruction({programId:dp,campaign,mint,purpose:3}));assert.equal((await getAccount(c,v)).amount,before);assert.equal((await getMint(c,mint)).supply,supplyBefore-1000n,'the donation is burned');}
// Dev: 1 % now plus the vested part, from vault 3; entitlements use the original supply even after burns.
const beforeDev=(await getAccount(c,destinations[0])).amount;const t0=await chainTime(c);await send(claimDevInstruction({programId:dp,campaign,mint,dev:alice.publicKey}),[alice]);const t1=await chainTime(c);
const end=threeMonthsAfter(state.launchedAt),devMin=10000000000000n+20000000000000n*BigInt(t0-state.launchedAt)/BigInt(end-state.launchedAt),devMax=10000000000000n+20000000000000n*BigInt(t1-state.launchedAt)/BigInt(end-state.launchedAt);
const devPaid=(await getAccount(c,destinations[0])).amount-beforeDev;assert.ok(devPaid>=devMin&&devPaid<=devMax,'dev paid within the vesting window');
const after=decodeDistribution(await c.getAccountInfo(distributionAddress(dp,campaign)),dp);assert.equal(after.claimed[3],devPaid);assert.equal(after.claimed[0],435000000000000n);assert.equal(after.claimed[1]+after.claimed[2],claimedParents.reduce((s,x)=>s+BigInt(x.amount),0n));
const summary=distributionSummary(after,await chainTime(c));assert.equal(summary.parentWindowOpen,true);
const report={network:'localnet',programId:ctx.programId.toBase58(),programSha256:ctx.manifest.sha256,distributionProgram:dp.toBase58(),campaign:campaign.toBase58(),mint:mint.toBase58(),launchSignature:signature,vaults:[0,1,2,3].map(k=>vaultAddress(dp,campaign,k,mint).toBase58()),allocation:expectedAllocation.map(String),claimed:after.claimed.map(String),parentExpiry:new Date(after.parentExpiry*1000).toISOString(),claimedParents,devPaid:devPaid.toString(),checks:['vaults funded exactly inside the launch','old claim paths refused (0x28)','participant, parent and dev claims from the matching vault, repeats pay nothing','forged leaf, altered proof, foreign receipt, below-threshold refused','burn before expiry refused','donation swept to burn, supply reduced by exactly the donation'],verifiedAt:new Date().toISOString()};
writeFileSync(new URL('./.runtime/distribution-launch-verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report,null,2));
