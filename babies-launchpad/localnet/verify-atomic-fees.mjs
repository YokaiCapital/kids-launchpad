// Real canonical-program localnet fee collection, routing and parent burns.
import assert from 'node:assert/strict';
import {acceptedProgramHash} from './program-lineage.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
import {PublicKey,Transaction,TransactionInstruction,SystemProgram,ComputeBudgetProgram,sendAndConfirmTransaction} from '@solana/web3.js';
import {NATIVE_MINT,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getOrCreateAssociatedTokenAccount,getAccount,getMint,createSyncNativeInstruction,transfer} from '@solana/spl-token';
import {atomicContext,readCampaign,CPMM,AMM_CONFIG,POOL_FEE} from './atomic-launch.mjs';
import {feeAddresses,initFeesInstruction,collectFeesInstruction,convertFeesInstruction,distributeFeesInstruction,buyBurnInstruction,jupiterBuyBurnInstruction,readFees,boundedQuote} from './atomic-fees.mjs';
import {localnetParentRoute,JUPITER_PROGRAM} from './jupiter-route.mjs';
// KIDS_PARENT_BUYBACK_ROUTE=jupiter-localnet drives both parent buybacks through the cloned Jupiter program (tag 25) instead of the direct CPMM call (tag 24).
const JUPITER_ROUTE=process.env.KIDS_PARENT_BUYBACK_ROUTE==='jupiter-localnet';
import {initializePoolInstruction,swapInstruction,poolAddresses} from './cpmm.mjs';
import {localKey,chainTime} from './dev-vesting.mjs';
const ctx=await atomicContext(),c=ctx.connection,admin=localKey('admin'),alice=localKey('alice'),bob=localKey('bob');
const fixture=JSON.parse(readFileSync(new URL('./.runtime/atomic-launch-verification.json',import.meta.url)));
assert.equal(fixture.genesisHash,ctx.manifest.genesisHash);assert.equal(fixture.programId,ctx.programId.toBase58());assert.ok(acceptedProgramHash(ctx.manifest,fixture.programSha256),'fixture program hash must be current or in the lineage');
const campaign=new PublicKey(fixture.campaign),mint=new PublicKey(fixture.mint),nft=new PublicKey(fixture.feeNft),parents=fixture.parentMints.map(s=>new PublicKey(s)),campaignState=await readCampaign(ctx,campaign),f=feeAddresses(ctx,campaign,mint);
const send=(ix,signers=[admin])=>sendAndConfirmTransaction(c,new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:1200000}),ix),signers,{commitment:'confirmed'});
const rejectionEvidence=[];
async function reject(name,action){let error;try{await action();}catch(e){error=e;}assert.ok(error,name+' must fail');let logs=error.transactionLogs;if(!logs&&typeof error.getLogs==='function')logs=await error.getLogs(c);assert.ok(Array.isArray(logs)&&logs.some(l=>l.includes(' failed:')),name+' must be an on-chain rejection');rejectionEvidence.push({name,errors:logs.filter(l=>/failed:|Error Code:|Error: /i.test(l))});}
// Each parent's token program is read from its mint account, never assumed (parent B may be Token-2022).
const parentPrograms=await Promise.all(parents.map(async p=>{const info=await c.getAccountInfo(p);if(!info)throw Error('Parent mint missing');if(info.owner.equals(TOKEN_2022_PROGRAM_ID))return TOKEN_2022_PROGRAM_ID;if(info.owner.equals(TOKEN_PROGRAM_ID))return TOKEN_PROGRAM_ID;throw Error('Parent mint not owned by a token program');}));
const programOf=m=>{const i=parents.findIndex(p=>p.equals(m));return i>=0?parentPrograms[i]:TOKEN_PROGRAM_ID;};
async function ensure(m,owner){return (await getOrCreateAssociatedTokenAccount(c,admin,m,owner,true,'confirmed',undefined,programOf(m))).address;}
const account=(address,m)=>getAccount(c,address,'confirmed',programOf(m)),mintInfo=m=>getMint(c,m,'confirmed',programOf(m));
const own=poolAddresses(CPMM,AMM_CONFIG,mint,NATIVE_MINT),cpmm={programId:CPMM,ammConfig:AMM_CONFIG,manifest:{feeAccount:POOL_FEE.toBase58()}};
const adminSol=await ensure(NATIVE_MINT,admin.publicKey),adminChild=await ensure(mint,admin.publicKey);
await ensure(mint,f.authority);await ensure(NATIVE_MINT,f.authority);await ensure(NATIVE_MINT,campaignState.dev);await ensure(NATIVE_MINT,campaignState.treasury);
for(let i=0;i<2;i++){
 const holder=i===0?alice:bob,source=await ensure(parents[i],holder.publicKey),destination=await ensure(parents[i],admin.publicKey);
 await transfer(c,admin,source,destination,holder,1000000000000n,[],undefined,programOf(parents[i]));
 await send(SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:adminSol,lamports:10000000000}));await send(createSyncNativeInstruction(adminSol));
 const {instruction}=initializePoolInstruction(cpmm,admin.publicKey,parents[i],NATIVE_MINT,1000000000000n,10000000000n,{[parents[i].toBase58()]:programOf(parents[i])});await send(instruction);
 const feeParent=await ensure(parents[i],f.authority);
 // Unsolicited tokens are not counted as purchased and must not be burned.
 await transfer(c,admin,source,feeParent,holder,123n,[],undefined,programOf(parents[i]));
}
const opens=await Promise.all([own,...parents.map(p=>poolAddresses(CPMM,AMM_CONFIG,p,NATIVE_MINT))].map(async p=>Number((await c.getAccountInfo(p.pool)).data.readBigUInt64LE(373))));
while(await chainTime(c)<Math.max(...opens))await new Promise(r=>setTimeout(r,250));
await send(SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:adminSol,lamports:300000000}));await send(createSyncNativeInstruction(adminSol));
await send(swapInstruction(cpmm,own,admin.publicKey,NATIVE_MINT,300000000n,1n));
const sold=(await getAccount(c,adminChild)).amount/4n;await send(swapInstruction(cpmm,own,admin.publicKey,mint,sold,1n));
await send(initFeesInstruction(ctx,campaign,admin.publicKey,mint));
const collect=collectFeesInstruction(ctx,campaign,admin.publicKey,mint,nft,BigInt(fixture.lpLocked));
await reject('non-creator cannot collect',()=>send(collectFeesInstruction(ctx,campaign,bob.publicKey,mint,nft,BigInt(fixture.lpLocked)),[bob]));
const collectSignature=await send(collect);let state=await readFees(ctx,campaign,mint);assert.ok(state.childPending>0n&&state.totalSol>0n);const collected={child:state.childPending,sol:state.totalSol};
const quote=await boundedQuote(c,mint,NATIVE_MINT,state.childPending),expiry=await chainTime(c)+90;
await reject('expired conversion quote',async()=>send(convertFeesInstruction(ctx,campaign,admin.publicKey,mint,state.childPending,quote.minOutput,await chainTime(c)-1)));
await reject('unsafe minimum output',()=>send(convertFeesInstruction(ctx,campaign,admin.publicKey,mint,state.childPending,1n,expiry)));
const conversionSignature=await send(convertFeesInstruction(ctx,campaign,admin.publicKey,mint,state.childPending,quote.minOutput,expiry));state=await readFees(ctx,campaign,mint);assert.equal(state.childPending,0n);assert.ok(state.totalSol>collected.sol);
const treasury=await ensure(NATIVE_MINT,campaignState.treasury),dev=await ensure(NATIVE_MINT,campaignState.dev),beforeTreasury=(await getAccount(c,treasury)).amount,beforeDev=(await getAccount(c,dev)).amount;
const distribution=distributeFeesInstruction(ctx,campaign,admin.publicKey,mint,campaignState.treasury,campaignState.dev);
const redirected=new TransactionInstruction({programId:distribution.programId,data:distribution.data,keys:distribution.keys.map((k,i)=>i===5?{...k,pubkey:dev}:k)});
await reject('treasury redirection rejected',()=>send(redirected));
const distributionSignature=await send(distribution);state=await readFees(ctx,campaign,mint);
assert.equal((await getAccount(c,treasury)).amount-beforeTreasury,state.totalSol*98n/168n);assert.equal((await getAccount(c,dev)).amount-beforeDev,state.totalSol*20n/168n);assert.equal(state.parentAAllocated,state.totalSol*25n/168n);assert.equal(state.parentBAllocated,state.totalSol*25n/168n);
const paidTreasury=(await getAccount(c,treasury)).amount,paidDev=(await getAccount(c,dev)).amount;await send(distribution);assert.equal((await getAccount(c,treasury)).amount,paidTreasury);assert.equal((await getAccount(c,dev)).amount,paidDev);
const burns=[];
for(let i=0;i<2;i++){
 state=await readFees(ctx,campaign,mint);const amount=i===0?state.parentAAllocated-state.parentASpent:state.parentBAllocated-state.parentBSpent;assert.ok(amount>0n);
 const q=await boundedQuote(c,NATIVE_MINT,parents[i],amount),expiry=await chainTime(c)+90,feeParent=await ensure(parents[i],f.authority),beforeMint=await mintInfo(parents[i]),beforeToken=(await account(feeParent,parents[i])).amount,beforeState=await readFees(ctx,campaign,mint),beforeSol=(await getAccount(c,f.wsol)).amount;
 const buy=(minOut,program=programOf(parents[i]),quoted=q.quote)=>JUPITER_ROUTE?jupiterBuyBurnInstruction(ctx,campaign,admin.publicKey,mint,parents[i],i,amount,minOut,expiry,program,localnetParentRoute({feeAuthority:f.authority,parentMint:parents[i],parentProgram:program,amount,quotedOut:quoted})):buyBurnInstruction(ctx,campaign,admin.publicKey,mint,parents[i],i,amount,minOut,expiry,program);
 if(JUPITER_ROUTE){assert.ok(await c.getAccountInfo(JUPITER_PROGRAM),'Jupiter program must be present on this localnet');
  await reject('route quoted below the minimum is refused before any swap '+i,()=>send(buy(q.minOutput,programOf(parents[i]),q.minOutput-1n)));
  await reject('slice above the 0.5 SOL cap is refused '+i,()=>send(jupiterBuyBurnInstruction(ctx,campaign,admin.publicKey,mint,parents[i],i,500000001n,1n,expiry,programOf(parents[i]),localnetParentRoute({feeAuthority:f.authority,parentMint:parents[i],parentProgram:programOf(parents[i]),amount:500000001n,quotedOut:1n}))));}
 await reject('impossible swap rolls back parent '+i,()=>send(buy(18446744073709551615n,programOf(parents[i]),18446744073709551615n)));
 assert.deepEqual(await readFees(ctx,campaign,mint),beforeState);assert.equal((await mintInfo(parents[i])).supply,beforeMint.supply);assert.equal((await getAccount(c,f.wsol)).amount,beforeSol);
 const wrongProgram=programOf(parents[i]).equals(TOKEN_PROGRAM_ID)?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID;
 await reject('wrong parent token program rejected '+i,()=>send(buy(q.minOutput,wrongProgram)));
 const signature=await send(buy(q.minOutput));
 const afterMint=await mintInfo(parents[i]),burned=beforeMint.supply-afterMint.supply;assert.ok(burned>=q.minOutput);assert.equal((await account(feeParent,parents[i])).amount,beforeToken);
 state=await readFees(ctx,campaign,mint);assert.equal(i===0?state.parentASpent:state.parentBSpent,amount);assert.equal(i===0?state.parentABurned:state.parentBBurned,burned);
 await reject('spent parent budget cannot replay '+i,()=>send(buy(q.minOutput)));
 burns.push({parent:i,mint:parents[i].toBase58(),tokenProgram:programOf(parents[i]).equals(TOKEN_2022_PROGRAM_ID)?'token-2022':'spl-token',route:JUPITER_ROUTE?'jupiter-route_v2-raydium-cp':'cpmm-direct',spentLamports:amount.toString(),burnedRaw:burned.toString(),signature});
}
state=await readFees(ctx,campaign,mint);const dust=state.totalSol-state.treasuryPaid-state.devPaid-state.parentASpent-state.parentBSpent;assert.ok(dust<=3n);assert.equal((await getAccount(c,f.wsol)).amount,dust);
const report={network:'localnet',rpcUrl:ctx.manifest.rpcUrl,genesisHash:ctx.manifest.genesisHash,programId:ctx.programId.toBase58(),programSha256:ctx.manifest.sha256,campaign:campaign.toBase58(),collectSignature,conversionSignature,distributionSignature,collected:Object.fromEntries(Object.entries(collected).map(([k,v])=>[k,v.toString()])),state:Object.fromEntries(Object.entries(state).map(([k,v])=>[k,v.toString()])),burns,rejectionEvidence,checks:['campaign PDA Fee Key collects real canonical locked LP earnings','child earnings converted into actual WSOL proceeds','98:20:25:25 cumulative routing and idempotent payouts','fixed treasury/dev destinations enforced','creator keeper, quote expiry and minimum-output bounds enforced','each parent bought through canonical pool and received tokens burned atomically','swap failure preserves budget and mint supply','spent budgets cannot replay','unsolicited parent tokens not burned; rounding dust retained'],limitations:['creator keeper selects timing; spot quote bound is not an external oracle or manipulation protection','parent pools use configured canonical CPMM index2 only','local program upgradeable; upstream locking source closed']};
writeFileSync(new URL('./.runtime/atomic-fees-verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report,null,2));
