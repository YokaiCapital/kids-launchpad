// Genuine upstream binary rehearsal on a separate cloned LOCAL validator.
// No production RPC is used for signing or transactions.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Connection,Keypair,PublicKey,Transaction,TransactionInstruction,SystemProgram,SYSVAR_RENT_PUBKEY,ComputeBudgetProgram,AddressLookupTableProgram,TransactionMessage,VersionedTransaction,sendAndConfirmTransaction} from '@solana/web3.js';
import {NATIVE_MINT,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,createMint,getOrCreateAssociatedTokenAccount,getAssociatedTokenAddressSync,mintTo,getAccount,getMint,createSyncNativeInstruction,createTransferInstruction,createSetAuthorityInstruction,AuthorityType} from '@solana/spl-token';
import {decodeConfig,decodePool,initializePoolInstruction,discriminator,swapInstruction} from './cpmm.mjs';
const c=new Connection('http://127.0.0.1:19099','confirmed'),owner=Keypair.generate(),nft=Keypair.generate();
const programId=new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'),lock=new PublicKey('LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE'),auth=new PublicKey('3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH'),metadata=new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'),ammConfig=new PublicKey('2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5');
const rejectionEvidence=[];
async function rejectsOnChain(name,action,program,reason){let error;try{await action();}catch(e){error=e;}assert.ok(error,name+' must fail');const logs=error.transactionLogs;assert.ok(Array.isArray(logs),name+' must fail in simulation, not transport');assert.ok(logs.some(l=>l.startsWith('Program '+program+' failed:')),name+' must reach expected program');assert.match(logs.join('\n'),reason);rejectionEvidence.push({name,errors:logs.filter(l=>/error|failed/i.test(l))});}
const genesisHash=await c.getGenesisHash();assert.notEqual(genesisHash,'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
const programs=[];for(const id of [programId,lock,metadata]){
 const account=await c.getAccountInfo(id);assert.ok(account?.executable);assert.equal(account.owner.toBase58(),'BPFLoaderUpgradeab1e11111111111111111111111');assert.equal(account.data.readUInt32LE(0),2);
 const address=new PublicKey(account.data.subarray(4,36)),data=await c.getAccountInfo(address);assert.equal(data.data.readUInt32LE(0),3);
 programs.push({programId:id.toBase58(),programData:address.toBase58(),deploySlot:data.data.readBigUInt64LE(4).toString(),upgradeAuthority:data.data[12]?new PublicKey(data.data.subarray(13,45)).toBase58():null,accountBinarySha256:createHash('sha256').update(data.data.subarray(45)).digest('hex')});
}
const fee=decodeConfig(await c.getAccountInfo(ammConfig),programId);assert.equal(fee.trade,20000n);assert.equal(fee.protocol,120000n);assert.equal(fee.fund,40000n);assert.equal(fee.disabled,false);// The canonical config has a dormant creator rate; legacy initialize must disable it on the pool.
assert.equal(fee.creator,500n);
const airdrop=await c.requestAirdrop(owner.publicKey,100000000000);await c.confirmTransaction(airdrop,'confirmed');
const mint=await createMint(c,owner,owner.publicKey,null,6),source=await getOrCreateAssociatedTokenAccount(c,owner,mint,owner.publicKey),wsol=await getOrCreateAssociatedTokenAccount(c,owner,NATIVE_MINT,owner.publicKey);
await mintTo(c,owner,mint,source.address,owner,435000000000000n);await sendAndConfirmTransaction(c,new Transaction().add(SystemProgram.transfer({fromPubkey:owner.publicKey,toPubkey:wsol.address,lamports:10000000000}),createSyncNativeInstruction(wsol.address)),[owner]);
const ctx={programId,ammConfig,manifest:{feeAccount:'DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8'}};
const {addresses:p,instruction}=initializePoolInstruction(ctx,owner.publicKey,mint,NATIVE_MINT,435000000000000n,10000000000n);
function sqrt(n){let x=n,y=(x+1n)/2n;while(y<x){x=y;y=(x+n/x)/2n;}return x;}
const lp=getAssociatedTokenAddressSync(p.lpMint,owner.publicKey),amount=sqrt(435000000000000n*10000000000n)-100n;
const nftAccount=getAssociatedTokenAddressSync(nft.publicKey,owner.publicKey),lockedPda=PublicKey.findProgramAddressSync([Buffer.from('locked_liquidity'),nft.publicKey.toBuffer()],lock)[0],lockedVault=getAssociatedTokenAddressSync(p.lpMint,auth,true),metadataPda=PublicKey.findProgramAddressSync([Buffer.from('metadata'),metadata.toBuffer(),nft.publicKey.toBuffer()],metadata)[0];
const spec=[[auth,false,false],[owner.publicKey,true,true],[owner.publicKey,true,false],[owner.publicKey,false,false],[nft.publicKey,true,true],[nftAccount,false,true],[p.pool,false,false],[lockedPda,false,true],[p.lpMint,false,false],[lp,false,true],[lockedVault,false,true],[p.vault0,false,true],[p.vault1,false,true],[metadataPda,false,true],[SYSVAR_RENT_PUBKEY,false,false],[SystemProgram.programId,false,false],[TOKEN_PROGRAM_ID,false,false],[ASSOCIATED_TOKEN_PROGRAM_ID,false,false],[metadata,false,false]];
const data=Buffer.alloc(17);discriminator('global:lock_cp_liquidity').copy(data);data.writeBigUInt64LE(amount,8);data[16]=0;
const ix=new TransactionInstruction({programId:lock,data,keys:spec.map(([pubkey,isSigner,isWritable])=>({pubkey,isSigner,isWritable}))});
const revoke=createSetAuthorityInstruction(mint,owner.publicKey,AuthorityType.MintTokens,null);
const [createTable,tableAddress]=AddressLookupTableProgram.createLookupTable({authority:owner.publicKey,payer:owner.publicKey,recentSlot:await c.getSlot('finalized')});
await sendAndConfirmTransaction(c,new Transaction().add(createTable),[owner]);
const addresses=[...new Map([instruction,ix,revoke].flatMap(ix=>[ix.programId,...ix.keys.map(k=>k.pubkey)]).map(k=>[k.toBase58(),k])).values()];
for(let i=0;i<addresses.length;i+=20)await sendAndConfirmTransaction(c,new Transaction().add(AddressLookupTableProgram.extendLookupTable({lookupTable:tableAddress,authority:owner.publicKey,payer:owner.publicKey,addresses:addresses.slice(i,i+20)})),[owner]);
const table=(await c.getAddressLookupTable(tableAddress)).value;
while(await c.getSlot('confirmed')<=table.state.lastExtendedSlot)await new Promise(r=>setTimeout(r,300));
async function atomic(lockIx){const block=await c.getLatestBlockhash('confirmed'),message=new TransactionMessage({payerKey:owner.publicKey,recentBlockhash:block.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:600000}),instruction,lockIx,revoke]}).compileToV0Message([table]),tx=new VersionedTransaction(message);tx.sign([owner,nft]);const signature=await c.sendTransaction(tx);const result=await c.confirmTransaction({...block,signature},'confirmed');assert.equal(result.value.err,null);return signature;}
const badData=Buffer.from(data);badData.writeBigUInt64LE(amount+1n,8);const bad=new TransactionInstruction({programId:lock,keys:ix.keys,data:badData});
await rejectsOnChain('excess LP lock',()=>atomic(bad),lock,/Error Code: RequireGteViolated\. Error Number: 2506/);assert.equal(await c.getAccountInfo(p.pool),null);assert.ok((await getMint(c,mint)).mintAuthority.equals(owner.publicKey));
const lockSignature=await atomic(ix),createSignature=lockSignature;
assert.equal((await getMint(c,mint)).mintAuthority,null);assert.equal(decodePool(await c.getAccountInfo(p.pool),programId,p).creatorFeesEnabled,false);
assert.equal((await getAccount(c,lp)).amount,0n);const custody=await getAccount(c,lockedVault);assert.equal(custody.amount,amount);assert.ok(custody.owner.equals(auth));assert.equal((await getAccount(c,nftAccount)).amount,1n);const nftState=await getMint(c,nft.publicKey);assert.equal(nftState.supply,1n);assert.equal(nftState.mintAuthority,null);assert.ok((await c.getAccountInfo(lockedPda)).owner.equals(lock));
// Generate real fees after the principal is locked, then qualify Fee Key access.
const openTime=Number((await c.getAccountInfo(p.pool)).data.readBigUInt64LE(373));
while(Number((await c.getAccountInfo(new PublicKey('SysvarC1ock11111111111111111111111111111111'))).data.readBigInt64LE(32))<openTime)await new Promise(r=>setTimeout(r,500));
await sendAndConfirmTransaction(c,new Transaction().add(SystemProgram.transfer({fromPubkey:owner.publicKey,toPubkey:wsol.address,lamports:1000000000}),createSyncNativeInstruction(wsol.address)),[owner]);
const swapSignature=await sendAndConfirmTransaction(c,new Transaction().add(swapInstruction(ctx,p,owner.publicKey,NATIVE_MINT,1000000000n,1n)),[owner]);
await rejectsOnChain('LP owner mismatch',()=>sendAndConfirmTransaction(c,new Transaction().add(createTransferInstruction(lockedVault,lp,owner.publicKey,1n)),[owner]),TOKEN_PROGRAM_ID,/owner does not match|owner mismatch/i);
const collect=(claimant)=>{
 const spec=[[auth,false,false],[claimant,true,false],[nftAccount,false,true],[lockedPda,false,true],[programId,false,false],[p.authority,false,false],[p.pool,false,true],[p.lpMint,false,true],[getAssociatedTokenAddressSync(p.mint0,owner.publicKey),false,true],[getAssociatedTokenAddressSync(p.mint1,owner.publicKey),false,true],[p.vault0,false,true],[p.vault1,false,true],[p.mint0,false,false],[p.mint1,false,false],[lockedVault,false,true],[TOKEN_PROGRAM_ID,false,false],[TOKEN_2022_PROGRAM_ID,false,false],[new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),false,false]];
 const data=Buffer.alloc(16);Buffer.from([8,30,51,199,209,184,247,133]).copy(data);data.writeBigUInt64LE(1000000n,8);
 return new TransactionInstruction({programId:lock,data,keys:spec.map(([pubkey,isSigner,isWritable])=>({pubkey,isSigner,isWritable}))});
};
const attacker=Keypair.generate();
await rejectsOnChain('Fee Key owner mismatch',()=>sendAndConfirmTransaction(c,new Transaction({feePayer:owner.publicKey}).add(collect(attacker.publicKey)),[owner,attacker]),lock,/owner|constraint.*token/i);
const beforeClaimToken=(await getAccount(c,source.address)).amount,beforeClaimSol=(await getAccount(c,wsol.address)).amount;
const collectSignature=await sendAndConfirmTransaction(c,new Transaction().add(collect(owner.publicKey)),[owner]);
assert.ok((await getAccount(c,source.address)).amount>beforeClaimToken);assert.ok((await getAccount(c,wsol.address)).amount>beforeClaimSol);
const result={network:'localnet',rpcUrl:'http://127.0.0.1:19099',genesisHash,configuredCreatorFeePpm:Number(fee.creator),poolCreatorFeeEnabled:false,rejectionEvidence,clonedPrograms:programs,pool:p.pool.toBase58(),mint:mint.toBase58(),feeNft:nft.publicKey.toBase58(),lockedLiquidity:lockedPda.toBase58(),lockedLpVault:lockedVault.toBase58(),lpLocked:amount.toString(),createSignature,lockSignature,swapSignature,collectSignature,checks:['actual canonical cloned CPMM and locking executables','pool initialization, full LP lock and mint authority revocation in one transaction','failed lock rolls back pool creation and authority changes','2% config read from cloned account','all received LP transferred to locking program custody','Fee Key NFT minted once with mint authority revoked','swap after lock generates claimable fees','direct LP withdrawal rejected','unauthorized fee collection rejected','Fee Key holder receives token and SOL fees'],limitations:['upstream lock source is closed; clone metadata is not production upgrade-authority evidence','fixture uses direct wallet Fee Key custody; KIDS program custody, treasury/dev distribution and parent buyback/burn not integrated','atomic pool-and-lock qualified separately; accepted escrow SOL settlement still not integrated']};
writeFileSync(new URL('./.runtime/burn-earn-verification.json',import.meta.url),JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result,null,2));
