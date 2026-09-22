import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {Keypair,Transaction,TransactionInstruction,SystemProgram,ComputeBudgetProgram,AddressLookupTableProgram,TransactionMessage,VersionedTransaction,sendAndConfirmTransaction} from '@solana/web3.js';
import {NATIVE_MINT,getOrCreateAssociatedTokenAccount,createMint,mintTo,setAuthority,AuthorityType,getAccount,getMint,burn} from '@solana/spl-token';
import {atomicContext,campaignAddress,authorityAddress,initInstruction,commitInstruction,settleInstruction,refundInstruction,launchInstruction,readCampaign,CPMM,LOCK} from './atomic-launch.mjs';
import {localKey,chainTime} from './dev-vesting.mjs';
import {decodePool} from './cpmm.mjs';
import {participantClaimInstruction,devClaimInstruction,configureParentsInstruction,parentClaimInstruction,parentTree,parentClaimAddress} from './atomic-claims.mjs';
import {threeMonthsAfter} from './vesting-plan.mjs';
import {captureLocalParentSnapshot,publicSnapshot} from './parent-snapshot.mjs';
import {createToken2022Parent,revokeToken2022Authorities} from './token2022-fixture.mjs';
// KIDS_PARENT_B_TOKEN_2022=1 makes the second parent a Token-2022 mint shaped like Buttcoin (metadata pointer + metadata, authorities revoked).
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
const good=launchInstruction(ctx,campaign,admin.publicKey,mint,nft.publicKey),lateFailure=launchInstruction(ctx,campaign,poor.publicKey,mint,nft.publicKey),p=good.addresses;
const nativeVault=p.mint0.equals(NATIVE_MINT)?p.vault0:p.vault1;
await send(SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:nativeVault,lamports:(await c.getMinimumBalanceForRentExemption(165))+1}));
const [createTable,tableAddress]=AddressLookupTableProgram.createLookupTable({authority:admin.publicKey,payer:admin.publicKey,recentSlot:await c.getSlot('finalized')});await send(createTable);
const addresses=[...new Map([...good.instruction.keys,...lateFailure.instruction.keys].map(k=>[k.pubkey.toBase58(),k.pubkey])).values()];
for(let i=0;i<addresses.length;i+=20)await send(AddressLookupTableProgram.extendLookupTable({lookupTable:tableAddress,authority:admin.publicKey,payer:admin.publicKey,addresses:addresses.slice(i,i+20)}));
const table=(await c.getAddressLookupTable(tableAddress)).value;while(await c.getSlot('confirmed')<=table.state.lastExtendedSlot)await new Promise(r=>setTimeout(r,200));
async function launch(ix,extra=[]){const block=await c.getLatestBlockhash('confirmed'),msg=new TransactionMessage({payerKey:admin.publicKey,recentBlockhash:block.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1200000}),ix]}).compileToV0Message([table]),tx=new VersionedTransaction(msg);tx.sign([admin,nft,...extra]);const signature=await c.sendTransaction(tx);const r=await c.confirmTransaction({...block,signature},'confirmed');assert.equal(r.value.err,null);return signature;}
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
await send(initInstruction(ctx,admin.publicKey,{nonce,soft:1000000000n,hard:3000000000n,deadline,launchDeadline,mint,supply,dev:alice.publicKey,treasury:admin.publicKey}));
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
assert.equal((await getAccount(c,child.address)).amount,supply-base);assert.equal((await getAccount(c,wsol.address)).amount,12345n);assert.equal((await getAccount(c,p.lp)).amount,0n);const locked=await getAccount(c,p.lockVault);assert.ok(locked.amount>0n);const feeKey=await getAccount(c,p.feeNft);assert.ok(feeKey.owner.equals(campaign));assert.equal(feeKey.amount,1n);assert.equal((await getMint(c,nft.publicKey)).supply,1n);const childMint=await getMint(c,mint);assert.equal(childMint.mintAuthority,null);assert.equal(childMint.freezeAuthority,null);
const rent=BigInt(await c.getMinimumBalanceForRentExemption(384));assert.equal(state.lamports,rent+500000000n+777n);
const bobBefore=await c.getBalance(bob.publicKey);await send(refundInstruction(ctx,campaign,bob.publicKey));assert.equal(await c.getBalance(bob.publicKey)-bobBefore,500000000);await send(refundInstruction(ctx,campaign,bob.publicKey));state=await readCampaign(ctx,campaign);assert.equal(state.refunded,1000000000n);assert.equal(state.lamports,rent+777n);
await reject('repeated launch',()=>launch(good.instruction),ctx.programId,/custom program error: 0x15/);
// Claims consume the remaining token reserve only after the atomic launch.
await reject('participant destination substitution',()=>send(participantClaimInstruction(ctx,campaign,mint,alice.publicKey,destinations[2])),ctx.programId,/custom program error/);
await reject('dev destination substitution',()=>send(devClaimInstruction(ctx,campaign,mint,alice.publicKey,destinations[2])),ctx.programId,/custom program error/);
for(const [i,owner] of [alice,bob].entries()){
 const claim=participantClaimInstruction(ctx,campaign,mint,owner.publicKey);await send(claim);assert.equal((await getAccount(c,destinations[i])).amount,217500000000000n);
 await send(claim);assert.equal((await getAccount(c,destinations[i])).amount,217500000000000n);
}
const claimedParents=[];
for(let index=0;index<2;index++)for(const entry of parentTrees[index].entries){
 const owner=new (await import('@solana/web3.js')).PublicKey(entry.owner),destination=destinations[owner.equals(alice.publicKey)?0:1];
 const build=(overrides={})=>parentClaimInstruction(ctx,campaign,admin.publicKey,mint,index,owner,overrides.balance??entry.balance,overrides.allocation??entry.allocation,overrides.proof??entry.proof,overrides.destination??destination);
 await reject('forged parent allocation '+index,()=>send(build({allocation:entry.allocation+1n})),ctx.programId,/custom program error/);
 await reject('parent destination substitution '+index,()=>send(build({destination:destinations[2]})),ctx.programId,/custom program error/);
 if(entry.proof.length){const proof=entry.proof.map(p=>Buffer.from(p));proof[0][0]^=1;await reject('altered Merkle sibling '+index,()=>send(build({proof})),ctx.programId,/custom program error/);}
 await send(SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:parentClaimAddress(ctx,campaign,index,owner),lamports:await c.getMinimumBalanceForRentExemption(0)}));
 const before=(await getAccount(c,destination)).amount;await send(build());assert.equal((await getAccount(c,destination)).amount-before,entry.allocation);await send(build());assert.equal((await getAccount(c,destination)).amount-before,entry.allocation);
 claimedParents.push({parent:index,owner:entry.owner,amount:entry.allocation.toString()});
}
// Alice is below the 0.05% threshold for parent B, even when offering Bob's proof.
await reject('below threshold parent holder',()=>send(parentClaimInstruction(ctx,campaign,admin.publicKey,mint,1,alice.publicKey,400000000000n,1n,[])),ctx.programId,/custom program error/);
// Holders burning their own tokens must not block later claims.
await burn(c,admin,destinations[1],mint,bob,100n);
const beforeDev=(await getAccount(c,destinations[0])).amount;const claimTimeBefore=await chainTime(c);await send(devClaimInstruction(ctx,campaign,mint,alice.publicKey));const claimTimeAfter=await chainTime(c);
const end=threeMonthsAfter(state.launchedAt),devMin=10000000000000n+20000000000000n*BigInt(claimTimeBefore-state.launchedAt)/BigInt(end-state.launchedAt),devMax=10000000000000n+20000000000000n*BigInt(claimTimeAfter-state.launchedAt)/BigInt(end-state.launchedAt);
const devPaid=(await getAccount(c,destinations[0])).amount-beforeDev;assert.ok(devPaid>=devMin&&devPaid<=devMax);assert.ok(devPaid<30000000000000n);
const afterClaim=await readCampaign(ctx,campaign);assert.equal(afterClaim.devClaimed,devPaid);
await send(devClaimInstruction(ctx,campaign,mint,alice.publicKey));const repeatedDev=(await getAccount(c,destinations[0])).amount-beforeDev;const latestClaim=await readCampaign(ctx,campaign);assert.equal(latestClaim.devClaimed,repeatedDev);assert.ok(repeatedDev-devPaid<10000000000000n,'repeat dev claim cannot repay immediate1%');
assert.equal((await getAccount(c,child.address)).amount,30000000000000n-repeatedDev);
const claimChecks=['participant43.5% paid from program custody','participant/dev destination substitution rejected','claims blocked before successful pool launch','immutable pre-commit parent snapshots','eligible parent holders claim both5% reserves with proof checks','below0.05% holder rejected','participant/parent replay cannot double-pay','dev1% plus elapsed2% linear starts at actual pool launch','remaining token custody equals unvested dev allocation','commit rejected until immutable parent configuration exists','single finalized bank snapshot supplies and balances','altered Merkle sibling rejected','prefunded parent-claim PDA cannot block payout','voluntary token burns cannot block remaining claims','repeat dev claim pays only newly vested tokens'];
const report={network:'localnet',rpcUrl:ctx.manifest.rpcUrl,genesisHash:ctx.manifest.genesisHash,programId:ctx.programId.toBase58(),programSha256:ctx.manifest.sha256,parentMints:parentMints.map(m=>m.toBase58()),parentPrograms:parentSnapshot.parents.map(p=>p.tokenProgram),claims:{parentClaims:claimedParents,devPaidRaw:devPaid.toString(),vestingStart:state.launchedAt,vestingEnd:end},campaign:campaign.toBase58(),mint:mint.toBase58(),pool:p.pool.toBase58(),feeNft:nft.publicKey.toBase58(),feeNftOwner:campaign.toBase58(),signature,committedLamports:'4000000000',acceptedLamports:'3000000000',refundedLamports:'1000000000',lpLocked:locked.amount.toString(),rejectionEvidence,checks:['real escrow commitments and complete receipt settlement','early launch and incomplete settlement rejected','canonical config enforced','failed downstream lock rolls back pool, escrow transfer and mint authority changes','exact accepted SOL funds pool with 43.5% token supply','all issued LP locked in canonical Burn & Earn','Fee Key owned by campaign PDA','mint and freeze authorities revoked','refunds work before and after launch and are idempotent','campaign and WSOL donations excluded from allocation; predicted native vault donation cannot block launch','repeat launch rejected',...claimChecks],limitations:['local development program remains upgradeable','fee collection/router qualification runs separately','parent snapshot roots require an authenticated, reproducible publisher; not trustless balance proofs','upstream Burn & Earn source is closed']};
writeFileSync(new URL('./.runtime/atomic-launch-verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report,null,2));
