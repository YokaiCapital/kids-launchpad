// Isolated registries and journals, existing isolated local validator; never replaces
// the application's active campaign. Uses real production adapters and programs.
import assert from 'node:assert/strict';
import {existsSync,realpathSync,mkdtempSync,mkdirSync,readdirSync,copyFileSync,symlinkSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {Keypair,PublicKey,Transaction,SystemProgram,ComputeBudgetProgram} from '@solana/web3.js';
import {NATIVE_MINT,getMint,getAccount,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createSyncNativeInstruction} from '@solana/spl-token';
import {atomicContext,campaignAddress,readCampaign,launchInstruction,CPMM,AMM_CONFIG} from './atomic-launch.mjs';
import {localKey,chainTime} from './dev-vesting.mjs';
import {provisionActiveLaunch} from './provision-active-launch.mjs';
import {readActive,prepareActive,submitActive,settleActive,activeManifestPath,saveActiveFile} from './active-launch.mjs';
import {launchActive} from './launch-active.mjs';
import {createActiveLifecycleKeeper} from './active-keeper.mjs';
import {claimPostlaunch,postlaunchClaims} from './postlaunch-claims.mjs';
import {createActiveFeeKeeper} from './active-fee-keeper.mjs';
import {feeAddresses,readFees,boundedQuote} from './atomic-fees.mjs';
import {poolAddresses,swapInstruction} from './cpmm.mjs';
import {createOperatorSender} from './operator-journal.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const protectedNames=['active-launch.json','active-launch-intents.json','active-launch-operator.json','active-settlement-operator.json','postlaunch-claim-intents.json','postlaunch-trade-intents.json','active-fee-operator.json'];
const registryHashes=()=>Object.fromEntries(protectedNames.map(name=>{const path=join(here,'.runtime',name);return [name,existsSync(path)?createHash('sha256').update(readFileSync(path)).digest('hex'):null];}));
if(process.argv[2]!=='--fixture'){
 const reports=[],beforeHashes=registryHashes();
 for(const mode of ['success','below-soft']){
  const box=mkdtempSync(join(tmpdir(),'kids-lifecycle-')),target=join(box,'localnet');mkdirSync(target);mkdirSync(join(target,'.runtime'),{mode:0o700});
  try{
   for(const name of readdirSync(here))if(name.endsWith('.mjs'))copyFileSync(join(here,name),join(target,name));
   for(const name of ['node_modules'])symlinkSync(join(here,name),join(target,name));
   for(const name of ['shared','protocol','interaction-review'])symlinkSync(join(here,'..',name),join(box,name));
   for(const name of ['admin.json','alice.json','bob.json','atomic-launch-program.json','atomic-launch-verification.json'])copyFileSync(join(here,'.runtime',name),join(target,'.runtime',name));
   await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[join(target,'qualify-active-lifecycle.mjs'),'--fixture',mode],{stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Lifecycle fixture failed: '+mode+' ('+code+')')));});
   reports.push(JSON.parse(readFileSync(join(target,'.runtime/qualification-result.json'))));
   assert.deepEqual(registryHashes(),beforeHashes,'Original active registries or journals changed during qualification');
  }finally{rmSync(box,{recursive:true,force:true});}
 }
 saveActiveFile(join(here,'.runtime/active-lifecycle-qualification.json'),{verifiedAt:new Date().toISOString(),network:'localnet',isolation:'Separate campaign registries; shared localnet validator, admin/alice/bob SOL balances, parent pool reserves and burned parent mint supplies',originalRegistryHashes:beforeHashes,originalRegistriesUnchanged:true,reports});
 console.log(JSON.stringify({qualified:reports.map(r=>r.mode),checks:reports.reduce((n,r)=>n+r.checks.length,0)}));
}else{
 const mode=process.argv[3];if(!['success','below-soft'].includes(mode)||!here.startsWith(join(realpathSync(tmpdir()),'kids-lifecycle-')))throw Error('Only a disposable qualification directory is permitted');
 const ctx=await atomicContext(),c=ctx.connection,admin=localKey('admin'),alice=localKey('alice'),bob=localKey('bob');
 const prior=JSON.parse(readFileSync(join(here,'.runtime/atomic-launch-verification.json'))),mint=Keypair.generate(),nft=Keypair.generate(),nonce=randomBytes(8).readBigUInt64LE(),now=await chainTime(c);
 const m={version:3,network:'localnet',rpcUrl:'http://127.0.0.1:19099',programId:ctx.programId.toBase58(),programSha256:ctx.manifest.sha256,genesisHash:ctx.manifest.genesisHash,creator:admin.publicKey.toBase58(),nonce:nonce.toString(),address:campaignAddress(ctx.programId,admin.publicKey,nonce).toBase58(),mint:mint.publicKey.toBase58(),feeNft:nft.publicKey.toBase58(),supply:'1000000000000000',soft:'100000000000',hard:'500000000000',deadline:now+45,launchDeadline:now+45+86400,dev:alice.publicKey.toBase58(),treasury:admin.publicKey.toBase58(),parentMints:prior.parentMints,ready:false};
 saveActiveFile(join(here,'.runtime/active-launch-setup-keys.json'),{mint:[...mint.secretKey],nft:[...nft.secretKey]});saveActiveFile(activeManifestPath,m);
 await provisionActiveLaunch();const evidence={commitments:[],participantClaims:[],parentClaims:[]};const checks=['actual active provisioner, canonical economics and separate registry'];
 for(const [wallet,amount] of (mode==='success'?[[alice,600n],[bob,400n]]:[[alice,1n]])){
  const funding=await c.requestAirdrop(wallet.publicKey,Number((amount+2n)*1000000000n));await c.confirmTransaction(funding,'confirmed');
  const intent=await prepareActive(wallet.publicKey.toBase58(),{action:'commit',amountLamports:(amount*1000000000n).toString(),requestId:randomUUID()});
  const result=await submitActive(wallet.publicKey.toBase58(),{intentId:intent.intentId,local:true});assert.equal((await submitActive(wallet.publicKey.toBase58(),{intentId:intent.intentId,local:true})).signature,result.signature);
  evidence.commitments.push({owner:wallet.publicKey.toBase58(),amountLamports:(amount*1000000000n).toString(),intentId:intent.intentId,signature:result.signature});
 }
 checks.push('actual prepared commitments and identical retry receipts');
 const limit=Date.now()+90000;while(await chainTime(c)<m.deadline){if(Date.now()>limit)throw Error('Clock stalled');await new Promise(r=>setTimeout(r,500));}
 const tick=createActiveLifecycleKeeper({read:readActive,settle:settleActive,launch:launchActive});for(let attempt=0;;attempt++){try{await tick();break;}catch(error){if(attempt>=6)throw error;console.error('Retrying lifecycle after recoverable RPC failure:',error.message);await new Promise(r=>setTimeout(r,15000));}}await tick();
 const state=await readActive(),onchain=await readCampaign(ctx,m.address);
 if(mode==='success'){
  assert.equal(state.phase,'launched');assert.equal(state.settledAcceptedLamports,'500000000000');assert.equal(state.refundedLamports,'500000000000');
  assert.equal((await launchActive()).alreadyLaunched,true);checks.push('keeper closes, settles, refunds excess and launches once');
  const info=await getMint(c,mint.publicKey);assert.equal(info.mintAuthority,null);assert.equal(info.freezeAuthority,null);
  const addresses=launchInstruction(ctx,new PublicKey(m.address),admin.publicKey,mint.publicKey,nft.publicKey).addresses;
  const feeKey=await getAccount(c,addresses.feeNft);assert.equal(feeKey.amount,1n);assert.equal(feeKey.owner.toBase58(),m.address);const locked=await getAccount(c,addresses.lockVault);assert.ok(locked.amount>0n);evidence.custody={pool:onchain.pool.toBase58(),mint:m.mint,feeNft:m.feeNft,feeKeyAccount:addresses.feeNft.toBase58(),feeKeyOwner:feeKey.owner.toBase58(),feeKeyAmount:feeKey.amount.toString(),lockVault:addresses.lockVault.toBase58(),lockedLpRaw:locked.amount.toString(),mintAuthority:info.mintAuthority,freezeAuthority:info.freezeAuthority};checks.push('mint/freeze revoked; permanent lock vault funded; fee key in campaign custody');
  for(const owner of [alice,bob]){const receipt=await claimPostlaunch(owner.publicKey.toBase58(),{action:'participant',campaign:m.address});const claims=await postlaunchClaims(owner.publicKey.toBase58(),m.address);assert.equal(claims.participant.allocatedRaw,claims.participant.claimedRaw);evidence.participantClaims.push({owner:owner.publicKey.toBase58(),signature:receipt.signature,...claims.participant});await assert.rejects(claimPostlaunch(owner.publicKey.toBase58(),{action:'participant',campaign:m.address}),/No participant tokens/);}
  checks.push('both participants claim exactly once through active resolver');
  for(const index of [0,1]){
   const action=index?'parentB':'parentA';let claimed=0n,count=0;
   for(const wallet of [alice,bob]){
    const owner=wallet.publicKey.toBase58(),before=(await postlaunchClaims(owner,m.address)).parents[index];if(!before.eligible)continue;assert.ok(BigInt(before.allocationRaw)>0n);const account=getAssociatedTokenAddressSync(mint.publicKey,wallet.publicKey),balanceBefore=(await getAccount(c,account)).amount;
    const receipt=await claimPostlaunch(owner,{action,campaign:m.address}),after=(await postlaunchClaims(owner,m.address)).parents[index];assert.equal(after.claimedRaw,after.allocationRaw);const received=(await getAccount(c,account)).amount-balanceBefore;assert.equal(received,BigInt(after.claimedRaw)-BigInt(before.claimedRaw));
    await assert.rejects(claimPostlaunch(owner,{action,campaign:m.address}),/No parent tokens/);claimed+=BigInt(after.claimedRaw);count++;evidence.parentClaims.push({parentIndex:index,parentMint:m.parentMints[index],owner,signature:receipt.signature,allocatedRaw:after.allocationRaw,claimedRaw:after.claimedRaw,receivedRaw:received.toString()});
   }
   assert.ok(count>0,'Each parent community must exercise a funded claim');assert.ok(claimed<=BigInt(m.supply)/20n);
  }
  checks.push('both parent communities claim eligible allocations once; replay rejected; each stays within 5% supply');
  const devReceipt=await claimPostlaunch(alice.publicKey.toBase58(),{action:'dev',campaign:m.address});evidence.devClaim={owner:alice.publicKey.toBase58(),signature:devReceipt.signature,...(await postlaunchClaims(alice.publicKey.toBase58(),m.address)).dev};assert.ok(BigInt((await postlaunchClaims(alice.publicKey.toBase58(),m.address)).dev.claimedRaw)>=10000000000000n);checks.push('dev launch unlock claim resolves active campaign');
  // Generate real fees only in this new child pool; parent routes already exist.
  const marketJournal={attempts:{}},marketSend=createOperatorSender({connection:c,journal:marketJournal,persist:()=>saveActiveFile(join(here,'.runtime/qualification-market.json'),marketJournal)});
  const transact=(id,...instructions)=>marketSend(id,block=>{const tx=new Transaction({feePayer:admin.publicKey,...block}).add(ComputeBudgetProgram.setComputeUnitLimit({units:1200000}),...instructions);tx.sign(admin);return tx;});
  const ensure=async(tokenMint,owner)=>{const address=getAssociatedTokenAddressSync(tokenMint,owner,true);if(!await c.getAccountInfo(address))await transact('ata:'+address,createAssociatedTokenAccountIdempotentInstruction(admin.publicKey,address,owner,tokenMint));return address;};
  const adminSol=await ensure(NATIVE_MINT,admin.publicKey),adminChild=await ensure(mint.publicKey,admin.publicKey),devSol=await ensure(NATIVE_MINT,alice.publicKey),own=poolAddresses(CPMM,AMM_CONFIG,mint.publicKey,NATIVE_MINT),cpmm={programId:CPMM,ammConfig:AMM_CONFIG};
  const poolOpen=Number((await c.getAccountInfo(own.pool)).data.readBigUInt64LE(373)),openLimit=Date.now()+30000;while(await chainTime(c)<poolOpen){if(Date.now()>openLimit)throw Error('Pool open clock stalled');await new Promise(r=>setTimeout(r,250));}
  await transact('fund-test-swap',SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:adminSol,lamports:300000000}),createSyncNativeInstruction(adminSol));
  const childBefore=(await getAccount(c,adminChild)).amount,buyQuote=await boundedQuote(c,NATIVE_MINT,mint.publicKey,300000000n);
  const buySignature=await transact('buy-child',swapInstruction(cpmm,own,admin.publicKey,NATIVE_MINT,300000000n,buyQuote.minOutput));
  const bought=(await getAccount(c,adminChild)).amount-childBefore,sold=bought/4n;assert.ok(sold>0n);
  const sellQuote=await boundedQuote(c,mint.publicKey,NATIVE_MINT,sold),sellSignature=await transact('sell-child',swapInstruction(cpmm,own,admin.publicKey,mint.publicKey,sold,sellQuote.minOutput));
  const treasuryBefore=(await getAccount(c,adminSol)).amount,devBefore=(await getAccount(c,devSol)).amount,parents=m.parentMints.map(x=>new PublicKey(x)),parentSupplyBefore=await Promise.all(parents.map(async p=>(await getMint(c,p,'confirmed',(await c.getAccountInfo(p)).owner)).supply));
  const feeTick=createActiveFeeKeeper({collectionIntervalSeconds:3600}),feeReceipts=[],feeAddr=feeAddresses(ctx,new PublicKey(m.address),mint.publicKey);let routed;
  for(let i=0;i<24;i++){
   const receipt=await feeTick();feeReceipts.push(receipt);
   if(await c.getAccountInfo(feeAddr.state)){
    const candidate=await readFees(ctx,new PublicKey(m.address),mint.publicKey);
    if(candidate.totalSol>0n&&candidate.childPending===0n&&candidate.parentABurned>0n&&candidate.parentBBurned>0n&&candidate.parentASpent===candidate.parentAAllocated&&candidate.parentBSpent===candidate.parentBAllocated){routed=candidate;break;}
   }
  }
  assert.ok(routed,'Fee keeper must complete both parent burns within24 operations');
  assert.equal((await getAccount(c,adminSol)).amount-treasuryBefore,routed.totalSol*98n/168n);assert.equal((await getAccount(c,devSol)).amount-devBefore,routed.totalSol*20n/168n);
  assert.equal(routed.parentAAllocated,routed.totalSol*25n/168n);assert.equal(routed.parentBAllocated,routed.totalSol*25n/168n);
  const parentSupplyAfter=await Promise.all(parents.map(async p=>(await getMint(c,p,'confirmed',(await c.getAccountInfo(p)).owner)).supply));assert.equal(parentSupplyBefore[0]-parentSupplyAfter[0],routed.parentABurned);assert.equal(parentSupplyBefore[1]-parentSupplyAfter[1],routed.parentBBurned);
  const beforeReplay=JSON.stringify(routed,(_,v)=>typeof v==='bigint'?v.toString():v);assert.equal((await feeTick()).status,'idle');assert.equal(JSON.stringify(await readFees(ctx,new PublicKey(m.address),mint.publicKey),(_,v)=>typeof v==='bigint'?v.toString():v),beforeReplay);
  // The next fixture snapshots finalized parent supplies. Do not start it while
  // these burns only exist at confirmed commitment.
  const finalizationDeadline=Date.now()+120000;
  const burnSignatures=feeReceipts.filter(r=>r.operation==='buy-burn').map(r=>r.signature);
  for(;;){const statuses=await c.getSignatureStatuses(burnSignatures,{searchTransactionHistory:true});if(statuses.value.every(s=>s?.confirmationStatus==='finalized'&&!s.err))break;if(Date.now()>finalizationDeadline)throw Error('Parent burns did not finalize before next snapshot');await new Promise(r=>setTimeout(r,1000));}
  evidence.fees={buySignature,sellSignature,operations:feeReceipts,state:Object.fromEntries(Object.entries(routed).map(([k,v])=>[k,v.toString()])),parentBurns:parents.map((p,i)=>({mint:p.toBase58(),beforeSupplyRaw:parentSupplyBefore[i].toString(),afterSupplyRaw:parentSupplyAfter[i].toString(),burnedRaw:(parentSupplyBefore[i]-parentSupplyAfter[i]).toString()}))};
  checks.push('actual active fee keeper collects child/SOL trading earnings, converts, pays98:20:25:25, buys and burns both parents; repeat tick idle');

 }else{
  assert.equal(state.phase,'failed');assert.equal(state.refundedLamports,state.totalLamports);assert.equal(onchain.phase,2);assert.equal(state.pool,null);await assert.rejects(launchActive(),/not fully settled/);checks.push('below-soft campaign fully refunds; repeat keeper safe; launch rejected');
 }
 const attempts=name=>{const path=join(here,'.runtime',name);if(!existsSync(path))return [];return Object.entries(JSON.parse(readFileSync(path)).attempts||{}).map(([operation,row])=>({operation,signature:row.signature,confirmed:row.confirmed===true,closedReason:row.closedReason||null}));};
 evidence.operatorTransactions=attempts('active-launch-operator.json');evidence.settlementTransactions=attempts('active-settlement-operator.json');
 const finalManifest=JSON.parse(readFileSync(activeManifestPath));evidence.launchSignature=finalManifest.launchSignature||null;evidence.finalState=state;
 const result={mode,network:'localnet',mint:m.mint,pool:onchain.phase===3?onchain.pool.toBase58():null,evidence,campaign:m.address,programId:m.programId,programSha256:m.programSha256,genesisHash:m.genesisHash,checks};saveActiveFile(join(here,'.runtime/qualification-result.json'),result);console.log(JSON.stringify(result));
}
