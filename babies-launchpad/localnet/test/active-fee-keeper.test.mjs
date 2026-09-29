import {createHash} from 'node:crypto';
import {LOCK} from '../atomic-launch.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {createActiveFeeKeeper,lockedPositionAmount,feePlan,validateActiveFeeIdentity,buybackRefusal,releaseRefusedBuyback,childBuybackSlice,childBuybackGuard,childBuybackMinOut,expiredBurnRefusal,releaseRefusedExpiredBurn,resumedOperationWithheld,EXPIRED_BURN_RETRY_SECONDS} from '../active-fee-keeper.mjs';
import {buyBurnChildInstruction,childBuybackFloor,CHILD_BUYBACK_MAX_SLICE,feeAddresses} from '../atomic-fees.mjs';
import {burnExpiredParentReservesInstruction,parentsAddress} from '../atomic-claims.mjs';
import {AMM_TIERS,CPMM,authorityAddress} from '../atomic-launch.mjs';import {poolAddresses} from '../cpmm.mjs';
import {NATIVE_MINT,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
const counters=()=>({childPending:0n,totalSol:168n,treasuryPaid:0n,devPaid:0n,parentAAllocated:0n,parentBAllocated:0n,parentASpent:0n,parentBSpent:0n});
/** The live build 5 feature list (deployment/MAINNET-IDENTITIES.json): no coin buyback, no claim window. */
const BUILD5=['burn-child-fees','cpmm-config-allowlist','claim-vaults','revoke-at-creation','jupiter-route'];
const BUILD6=['burn-child-fees','cpmm-config-allowlist','claim-vaults','revoke-at-creation','parent-claim-expiry','child-buyback'];
function selected(){const admin=Keypair.generate(),mint=Keypair.generate().publicKey,feeNft=Keypair.generate().publicKey,campaign=Keypair.generate().publicKey,programId=Keypair.generate().publicKey,dev=Keypair.generate().publicKey;const value={scope:'active-localnet',ctx:{programId,connection:{rpcEndpoint:'http://127.0.0.1:19099'},manifest:{network:'localnet',rpcUrl:'http://127.0.0.1:19099',genesisHash:'genesis',sha256:'binary'}},campaign,state:{phase:3,mint,feeNft,creator:admin.publicKey,treasury:admin.publicKey,dev}};value.record={network:'localnet',ready:true,address:campaign.toBase58(),mint:mint.toBase58(),feeNft:feeNft.toBase58(),creator:admin.publicKey.toBase58(),treasury:admin.publicKey.toBase58(),dev:dev.toBase58(),genesisHash:'genesis',programId:programId.toBase58(),programSha256:'binary',parentMints:[Keypair.generate().publicKey.toBase58(),Keypair.generate().publicKey.toBase58()]};return {value,admin};}
test('fee plan burns the coin-side fees before cumulative distribution and remaining parent budgets',()=>{
 assert.deepEqual(feePlan({...counters(),childPending:5n}),[{kind:'burn',amount:'5'},{kind:'distribute'}]);
 assert.deepEqual(feePlan({...counters(),treasuryPaid:98n,devPaid:20n,parentAAllocated:25n,parentBAllocated:25n,parentASpent:5n,parentBSpent:25n},BUILD5,1n),[{kind:'buy-burn',index:0,amount:'20'}]);
 assert.deepEqual(feePlan({...counters(),treasuryPaid:98n,devPaid:20n,parentAAllocated:25n,parentBAllocated:25n,parentASpent:5n,parentBSpent:25n},BUILD5,5_000_000n),[{kind:'buy-burn-waiting',index:0,amount:'20',minimum:'5000000'}],'a budget below the minimum waits on chain instead of paying fees to burn dust');
});
test('build 6 (child-buyback): one buy-burn-child for the combined pending budget, never a parent buy-burn; below the minimum it waits',()=>{
 const live={...counters(),totalSol:16_800_000_000n,treasuryPaid:9_800_000_000n,devPaid:2_000_000_000n,parentAAllocated:2_500_000_000n,parentBAllocated:2_500_000_000n,parentASpent:2_300_000_000n,parentBSpent:100_000_000n};
 assert.deepEqual(feePlan(live,BUILD6),[{kind:'buy-burn-child',amount:'2600000000'}],'allocated A+B minus spent A+B');
 assert.deepEqual(feePlan(live,BUILD5),[{kind:'buy-burn',index:0,amount:'200000000'},{kind:'buy-burn',index:1,amount:'2400000000'}],'build 5 plans exactly as today');
 assert.deepEqual(feePlan(live,BUILD6,3_000_000_000n),[{kind:'buy-burn-child-waiting',amount:'2600000000',minimum:'3000000000'}],'parked: the whole bucket waits');
 assert.deepEqual(feePlan({...live,parentASpent:2_500_000_000n,parentBSpent:2_500_000_000n},BUILD6),[],'nothing pending, nothing planned');
 assert.deepEqual(feePlan({...live,childPending:7n,treasuryPaid:0n},BUILD6).map(x=>x.kind),['burn','distribute','buy-burn-child'],'burn and distribute still come first');
 assert.ok(!feePlan(live,BUILD6).some(x=>x.kind==='buy-burn'||x.kind==='buy-burn-waiting'));
 assert.ok(!feePlan(live,BUILD5).some(x=>x.kind.startsWith('buy-burn-child')));
 assert.deepEqual(feePlan(live),feePlan(live,BUILD6),'the localnet default is the current source (build 6)');
});
test('completed budgets are never spent again and rounding dust is retained',()=>{for(const features of [BUILD5,BUILD6,undefined]){assert.deepEqual(feePlan({...counters(),treasuryPaid:98n,devPaid:20n,parentAAllocated:25n,parentBAllocated:25n,parentASpent:25n,parentBSpent:25n},features),[]);assert.deepEqual(feePlan({...counters(),totalSol:1n},features),[]);}});
test('coin buyback slice: at most 0.5 SOL and at most the pending budget',()=>{
 assert.equal(CHILD_BUYBACK_MAX_SLICE,500_000_000n);
 assert.equal(childBuybackSlice('2600000000'),500_000_000n);assert.equal(childBuybackSlice(120_000_000n),120_000_000n);assert.equal(childBuybackSlice(500_000_000n),500_000_000n);
 assert.throws(()=>childBuybackSlice(0n));assert.throws(()=>childBuybackSlice(-1n));
});
test('coin buyback floor equals the program floor (fees.rs quote_floor host tests) and min_out is never below it',()=>{
 assert.equal(childBuybackFloor({amount:1000n,reserveIn:10000n,reserveOut:10000n,rate:20000n}),883n);
 assert.equal(childBuybackFloor({amount:500_000_000n,reserveIn:10_000_000_000n,reserveOut:400_000_000_000_000n,rate:25000n}),18_407_628_128_724n);
 assert.throws(()=>childBuybackFloor({amount:1n,reserveIn:1_000_000n,reserveOut:1n,rate:25000n}),/too small/,'the fee eats a one-lamport input');
 // boundedQuote's shape on the campaign pool: quote before slippage, reserves after the pool's own fees, net input, rate.
 const q=(amount,reserveIn,reserveOut,rate)=>{const net=amount-(amount*rate+999999n)/1000000n;return {quote:net*reserveOut/(reserveIn+net),minOutput:0n,reserveIn,reserveOut,net,rate};};
 for(const [amount,rIn,rOut,rate] of [[1000n,10000n,10000n,20000n],[500_000_000n,10_000_000_000n,400_000_000_000_000n,25000n],[1001n,10n**9n,10n**15n,25000n],[50_000_000n,1_000_000_000_000n,1_000_000_000_000_000n,25000n]]){
  const quote=q(amount,rIn,rOut,rate),floor=childBuybackFloor({amount,reserveIn:rIn,reserveOut:rOut,rate});
  assert.ok(childBuybackMinOut(quote,amount,100)>=floor,'default 1 % is at least the floor');
  assert.equal(childBuybackMinOut(quote,amount,100),quote.quote-quote.quote/100n>floor?quote.quote-quote.quote/100n:floor);
  assert.ok(childBuybackMinOut(quote,amount,50)>childBuybackMinOut(quote,amount,100),'a stricter slippage raises min_out');
  assert.ok(childBuybackMinOut(quote,amount,1)>=floor);
 }
 assert.throws(()=>childBuybackMinOut(q(1000n,10000n,10000n,20000n),1000n,101),/1 to 100/);assert.throws(()=>childBuybackMinOut(q(1000n,10000n,10000n,20000n),1000n,0));
});
test('coin buyback guard: reserve-based impact cap, no reference price, journaled like the Pyth guard',()=>{
 const ok=childBuybackGuard({net:1_000_000_000n,reserveIn:1_000_000_000_000n});assert.equal(ok.referenceCheck,'pool-reserves');assert.equal(ok.impactBps,9);assert.equal(ok.deviationBps,null);
 assert.throws(()=>childBuybackGuard({net:10_000_000_000n,reserveIn:1_000_000_000_000n}),/price impact 99 bps exceeds the cap/);
 assert.equal(childBuybackGuard({net:5_000_000_000n,reserveIn:1_000_000_000_000n}).impactBps,49);
 assert.throws(()=>childBuybackGuard({net:0n,reserveIn:1n}),/reserves/);assert.throws(()=>childBuybackGuard({}),/reserves/);
 assert.equal(buybackRefusal(Error('Quote price impact 99 bps exceeds the cap')),'price-impact','the tick releases it like a parent refusal');
});
test('tag 27 instruction follows the build-6 account table on the campaign pool; tag 11 the burn table',()=>{
 const programId=Keypair.generate().publicKey,campaign=Keypair.generate().publicKey,keeper=Keypair.generate().publicKey,mint=Keypair.generate().publicKey,ctx={programId};
 const p=poolAddresses(CPMM,AMM_TIERS[1].key,mint,NATIVE_MINT),f=feeAddresses(ctx,campaign,mint),forward=p.mint0.equals(NATIVE_MINT);
 const ix=buyBurnChildInstruction(ctx,campaign,keeper,mint,500_000_000n,123n,1790000000n,p.pool);
 assert.equal(ix.programId,programId);assert.equal(ix.data.length,25);assert.equal(ix.data[0],27);assert.equal(ix.data.readBigUInt64LE(1),500_000_000n);assert.equal(ix.data.readBigUInt64LE(9),123n);assert.equal(ix.data.readBigUInt64LE(17),1790000000n);
 const expected=[[campaign,false,false],[keeper,true,false],[f.state,false,true],[f.authority,false,false],[f.wsol,false,true],[f.child,false,true],[p.pool,false,true],[AMM_TIERS[1].key,false,false],[p.authority,false,false],[forward?p.vault0:p.vault1,false,true],[forward?p.vault1:p.vault0,false,true],[NATIVE_MINT,false,false],[mint,false,true],[p.observation,false,true],[CPMM,false,false],[TOKEN_PROGRAM_ID,false,false]];
 assert.equal(ix.keys.length,16);expected.forEach(([pubkey,isSigner,isWritable],i)=>{assert.ok(ix.keys[i].pubkey.equals(pubkey),'account '+i);assert.equal(ix.keys[i].isSigner,isSigner,'signer '+i);assert.equal(ix.keys[i].isWritable,isWritable,'writable '+i);});
 assert.ok(ix.keys[4].pubkey.equals(getAssociatedTokenAddressSync(NATIVE_MINT,f.authority,true)));assert.ok(ix.keys[5].pubkey.equals(getAssociatedTokenAddressSync(mint,f.authority,true)));
 assert.throws(()=>buyBurnChildInstruction(ctx,campaign,keeper,mint,500_000_001n,1n,1n,p.pool),/out of bounds/);assert.throws(()=>buyBurnChildInstruction(ctx,campaign,keeper,mint,1n,0n,1n,p.pool),/positive/);
 assert.throws(()=>buyBurnChildInstruction(ctx,campaign,keeper,mint,1n,1n,1n,Keypair.generate().publicKey),/canonical/);assert.throws(()=>buyBurnChildInstruction(ctx,campaign,keeper,mint,1n,1n,1n,null),/campaign pool/);
 const burn=burnExpiredParentReservesInstruction(ctx,campaign,mint),authority=authorityAddress(ctx,campaign);
 assert.deepEqual(burn.data,Buffer.from([11]));assert.equal(burn.keys.length,6);assert.ok(!burn.keys.some(k=>k.isSigner),'no signer: the operator only pays the fee');
 [[campaign,false],[parentsAddress(ctx,campaign),true],[authority,false],[mint,true],[getAssociatedTokenAddressSync(mint,authority,true),true],[TOKEN_PROGRAM_ID,false]].forEach(([pubkey,isWritable],i)=>{assert.ok(burn.keys[i].pubkey.equals(pubkey),'account '+i);assert.equal(burn.keys[i].isWritable,isWritable,'writable '+i);});
});
test('a resumed coin buyback below the minimum is withheld like a parent one; tag 11 refusals back off an hour, transport errors retry',()=>{
 assert.match(resumedOperationWithheld({id:'fee:20',kind:'buy-burn-child',amount:'1000'},{attempts:{}}),/below the minimum/);
 assert.equal(resumedOperationWithheld({id:'fee:21',kind:'buy-burn-child',amount:'5000000'},{attempts:{}}),null);
 assert.equal(resumedOperationWithheld({id:'fee:22',kind:'parents-expired-burn'},{attempts:{}}),null);
 assert.equal(expiredBurnRefusal(Error('Simulation failed. \nMessage: Transaction simulation failed: Error processing Instruction 1: custom program error: 0x2e.')),'simulation');
 assert.equal(expiredBurnRefusal(Error('Operator transaction failed: {"InstructionError":[1,{"Custom":46}]}')),'failed');
 assert.equal(expiredBurnRefusal(Error('Simulation failed. \nMessage: Transaction simulation failed: Blockhash not found.')),null);
 assert.equal(expiredBurnRefusal(Error('fetch failed')),null);assert.equal(expiredBurnRefusal(Error('Operator confirmation unresolved; retry saved transaction')),null);
 const journal={attempts:{'fee:9':{signature:'s9',wire:'w',createdAt:500,block:{}}},current:{kind:'parents-expired-burn',id:'fee:9'}};
 releaseRefusedExpiredBurn(journal,journal.current,'simulation',1_792_805_700,()=>2000);
 assert.equal(journal.current,null);assert.equal(journal.parentsExpiredBurnRetryAt,1_792_805_700+EXPIRED_BURN_RETRY_SECONDS);assert.equal(journal.attempts['fee:9'],undefined);assert.equal(journal.attempts['fee:9:500'].closedReason,'refused:simulation');assert.deepEqual(journal.parentsExpiredBurnRefusal,{reason:'simulation',at:2000});
});
test('fee accounting rejects negative, overflow and overpaid budgets',()=>{for(const change of [{childPending:-1n},{totalSol:2n**64n},{treasuryPaid:99n},{parentASpent:1n},{parentBAllocated:26n}])assert.throws(()=>feePlan({...counters(),...change}));});
test('only exact qualified active localnet creator and registered identities accepted',()=>{
 const {value,admin}=selected();assert.equal(validateActiveFeeIdentity(value,admin).campaign,value.record.address);
 for(const change of [{scope:'localnet-rehearsal'},{record:{...value.record,ready:false}},{record:{...value.record,programSha256:'changed'}},{record:{...value.record,feeNft:Keypair.generate().publicKey.toBase58()}},{record:{...value.record,parentMints:[value.record.mint,value.record.parentMints[1]]}},{ctx:{...value.ctx,connection:{rpcEndpoint:'https://api.mainnet-beta.solana.com'}}}])assert.throws(()=>validateActiveFeeIdentity({...value,...change},admin));
 assert.throws(()=>validateActiveFeeIdentity(value,Keypair.generate()),/creator/);
});
test('unavailable active campaign never loads creator key or sends',async()=>{const tick=createActiveFeeKeeper({resolve:async()=>null,getAdmin:()=>assert.fail('must not access key')});assert.deepEqual(await tick(),{status:'unavailable'});});
test('overlapping fee ticks are bounded and failing resolution releases lease',async()=>{
 let release;const wait=new Promise(resolve=>release=resolve);let fail=true;const tick=createActiveFeeKeeper({resolve:async()=>{await wait;if(fail)throw Error('offline');return null;}});
 const first=tick();assert.deepEqual(await tick(),{status:'busy'});release();await assert.rejects(first,/offline/);fail=false;assert.deepEqual(await tick(),{status:'unavailable'});
});
test('collection rate cannot be configured as an unbounded hot loop',()=>{for(const interval of [0,-1,59,NaN,1.5])assert.throws(()=>createActiveFeeKeeper({collectionIntervalSeconds:interval}));});

test('collection bound belongs to the fee NFT position, not aggregate LP custody',()=>{
 const expected={pool:Keypair.generate().publicKey,nft:Keypair.generate().publicKey,owner:Keypair.generate().publicKey,lpMint:Keypair.generate().publicKey,vaultAmount:999n},data=Buffer.alloc(256);
 createHash('sha256').update('account:LockedCpLiquidityState').digest().copy(data,0,0,8);data.writeBigUInt64LE(123n,8);
 for(const [offset,key] of [[64,expected.pool],[96,expected.nft],[128,expected.owner],[160,expected.lpMint]])key.toBuffer().copy(data,offset);
 const info={owner:LOCK,data};assert.equal(lockedPositionAmount(info,expected),123n);
 for(const field of ['pool','nft','owner','lpMint'])assert.throws(()=>lockedPositionAmount(info,{...expected,[field]:Keypair.generate().publicKey}),/identity/);
 assert.throws(()=>lockedPositionAmount(info,{...expected,vaultAmount:122n}),/amount/);
 assert.throws(()=>lockedPositionAmount({...info,owner:Keypair.generate().publicKey},expected),/Invalid/);
 const wrong=Buffer.from(data);wrong[0]^=1;assert.throws(()=>lockedPositionAmount({...info,data:wrong},expected),/Invalid/);
});
test('dust harvests back off (300 s → 1200 → 4800 → … → 6 h); a worthwhile harvest resets to the base interval',async()=>{
 const {nextCollectionDelay}=await import('../active-fee-keeper.mjs');
 assert.equal(nextCollectionDelay({delta:{totalSol:'46',childPending:'37682365'},current:undefined,base:300}),1200);
 assert.equal(nextCollectionDelay({delta:{totalSol:'0'},current:1200,base:300}),4800);assert.equal(nextCollectionDelay({delta:null,current:19200,base:300}),21600);assert.equal(nextCollectionDelay({delta:null,current:21600,base:300}),21600);
 assert.equal(nextCollectionDelay({delta:{totalSol:'500000',childPending:'0'},current:21600,base:300}),300);assert.equal(nextCollectionDelay({delta:{totalSol:'499999',childPending:'99999999999'},current:4800,base:300}),19200,'the coin half alone does not count');
});
test('cost basis: the minimum buyback budget covers the bounded operation cost fifty times over; a burn waits below the value threshold',async()=>{
 const {BUYBACK_MIN_LAMPORTS,OPERATION_COST_CEILING_LAMPORTS,worthwhileBudget,BURN_MIN_VALUE_LAMPORTS,COLLECT_THRESHOLDS}=await import('../active-fee-keeper.mjs');
 assert.equal(OPERATION_COST_CEILING_LAMPORTS,10_000n);assert.ok(BUYBACK_MIN_LAMPORTS>=OPERATION_COST_CEILING_LAMPORTS*50n);
 assert.equal(worthwhileBudget(5_000_000n),true);assert.equal(worthwhileBudget(400_000n),false,'2 % of the budget must cover the fixed costs');
 assert.equal(BURN_MIN_VALUE_LAMPORTS,COLLECT_THRESHOLDS.lamports);
});
test('runtime floor: the configured buyback minimum can only raise the floor; the burn gate compares the quoted value',async()=>{
 const {effectiveBuybackMinimum,BUYBACK_FLOOR_LAMPORTS,burnWorthwhile}=await import('../active-fee-keeper.mjs');
 assert.equal(BUYBACK_FLOOR_LAMPORTS,500_000n);assert.equal(effectiveBuybackMinimum({KIDS_BUYBACK_MIN_LAMPORTS:'1'}),500_000n);assert.equal(effectiveBuybackMinimum({KIDS_BUYBACK_MIN_LAMPORTS:'nonsense'}),500_000n);
 assert.equal(effectiveBuybackMinimum({}),5_000_000n);assert.equal(effectiveBuybackMinimum({KIDS_BUYBACK_MIN_LAMPORTS:'20000000'}),20_000_000n);
 assert.equal(burnWorthwhile(499_999n),false);assert.equal(burnWorthwhile(500_000n),true);
});
test('resumed operations: an already signed one is never re-planned; an unsigned one must pass today\'s policy',async()=>{
 const {resumedOperationWithheld}=await import('../active-fee-keeper.mjs');
 assert.equal(resumedOperationWithheld({id:'fee:7',kind:'buy-burn',amount:'1000'},{attempts:{'fee:7':{signature:'x'}}}),null,'signed: reconciled, not withheld');
 assert.match(resumedOperationWithheld({id:'fee:8',kind:'buy-burn',amount:'1000'},{attempts:{}}),/below the minimum/);
 assert.equal(resumedOperationWithheld({id:'fee:9',kind:'buy-burn',amount:'5000000'},{attempts:{}}),null);
 assert.match(resumedOperationWithheld({id:'fee:10',kind:'burn',amount:'5'},{attempts:{},burnValueLamports:1n}),/below the threshold/);
 assert.equal(resumedOperationWithheld({id:'fee:11',kind:'burn',amount:'5'},{attempts:{},burnValueLamports:600000n}),null);
 assert.equal(resumedOperationWithheld({id:'fee:12',kind:'distribute'},{attempts:{}}),null);
});

test('parent buyback slippage defaults to 1 % and never exceeds the route cap',async()=>{const {parentBuybackSlippageBps}=await import('../active-fee-keeper.mjs');assert.equal(parentBuybackSlippageBps({}),100);assert.equal(parentBuybackSlippageBps({KIDS_PARENT_BUYBACK_SLIPPAGE_BPS:'50'}),50);assert.throws(()=>parentBuybackSlippageBps({KIDS_PARENT_BUYBACK_SLIPPAGE_BPS:'0'}));assert.throws(()=>parentBuybackSlippageBps({KIDS_PARENT_BUYBACK_SLIPPAGE_BPS:'300'}),/1 %/);const {MAX_SLIPPAGE_BPS}=await import('../jupiter-route.mjs');assert.ok(parentBuybackSlippageBps({})<=MAX_SLIPPAGE_BPS);});

test('buybackRefusal classifies only refusals the next tick can re-plan',()=>{
 assert.equal(buybackRefusal(Error('Quote price impact 57 bps exceeds the cap')),'price-impact');
 assert.equal(buybackRefusal(Error('Jupiter quote unavailable (429)')),'jupiter-quote');
 assert.equal(buybackRefusal(Error('Jupiter quote does not match the request')),'jupiter-quote');
 assert.equal(buybackRefusal(Error('Simulation failed. \nMessage: Transaction simulation failed: Error processing Instruction 3: custom program error: 0x1.')),'simulation');
 assert.equal(buybackRefusal(Error('Simulation failed. \nMessage: Transaction simulation failed: Blockhash not found.')),null);
 assert.equal(buybackRefusal(Error('Operator confirmation unresolved; retry saved transaction')),null);
 assert.equal(buybackRefusal(Error('fetch failed')),null);
});
test('a refused coin buyback is released under the child bucket and leaves the parent turn marker alone',()=>{
 const journal={attempts:{'fee:30':{signature:'sig30',wire:'w',createdAt:10,block:{}}},current:{kind:'buy-burn-child',id:'fee:30',amount:'2600000000'},lastBuybackParent:0,buybackRefusals:{1:2}};
 releaseRefusedBuyback(journal,journal.current,'simulation',()=>4000);
 assert.equal(journal.current,null);assert.equal(journal.lastBuybackParent,0,'untouched');assert.equal(journal.attempts['fee:30'],undefined);assert.equal(journal.attempts['fee:30:10'].closedReason,'refused:simulation');
 assert.deepEqual(journal.buybackRefusals,{1:2,child:1});assert.deepEqual(journal.lastBuybackRefusal,{parent:'child',reason:'simulation',at:4000});
});
test('releaseRefusedBuyback passes the turn, clears the operation and keeps the refused packet under a closed key',()=>{
 const journal={attempts:{'fee:7':{signature:'sig7',wire:'w',createdAt:1000,block:{}}},current:{kind:'buy-burn',index:1,id:'fee:7'},lastBuybackParent:0};
 releaseRefusedBuyback(journal,journal.current,'simulation',()=>2000);
 assert.equal(journal.current,null);
 assert.equal(journal.lastBuybackParent,1);
 assert.equal(journal.attempts['fee:7'],undefined);
 assert.equal(journal.attempts['fee:7:1000'].closedReason,'refused:simulation');
 assert.equal(journal.attempts['fee:7:1000'].signature,'sig7');
 assert.deepEqual(journal.buybackRefusals,{1:1});
 assert.deepEqual(journal.lastBuybackRefusal,{parent:1,reason:'simulation',at:2000});
 const confirmed={attempts:{'fee:8':{signature:'sig8',confirmed:true,createdAt:1}},current:{kind:'buy-burn',index:0,id:'fee:8'}};
 releaseRefusedBuyback(confirmed,confirmed.current,'price-impact',()=>3000);
 assert.equal(confirmed.attempts['fee:8'].confirmed,true,'a confirmed attempt is never moved');
 assert.equal(confirmed.lastBuybackParent,0);
});
