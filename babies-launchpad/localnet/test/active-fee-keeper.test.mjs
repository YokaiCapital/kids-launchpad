import {createHash} from 'node:crypto';
import {LOCK} from '../atomic-launch.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {createActiveFeeKeeper,lockedPositionAmount,feePlan,validateActiveFeeIdentity,buybackRefusal,releaseRefusedBuyback} from '../active-fee-keeper.mjs';
const counters=()=>({childPending:0n,totalSol:168n,treasuryPaid:0n,devPaid:0n,parentAAllocated:0n,parentBAllocated:0n,parentASpent:0n,parentBSpent:0n});
function selected(){const admin=Keypair.generate(),mint=Keypair.generate().publicKey,feeNft=Keypair.generate().publicKey,campaign=Keypair.generate().publicKey,programId=Keypair.generate().publicKey,dev=Keypair.generate().publicKey;const value={scope:'active-localnet',ctx:{programId,connection:{rpcEndpoint:'http://127.0.0.1:19099'},manifest:{network:'localnet',rpcUrl:'http://127.0.0.1:19099',genesisHash:'genesis',sha256:'binary'}},campaign,state:{phase:3,mint,feeNft,creator:admin.publicKey,treasury:admin.publicKey,dev}};value.record={network:'localnet',ready:true,address:campaign.toBase58(),mint:mint.toBase58(),feeNft:feeNft.toBase58(),creator:admin.publicKey.toBase58(),treasury:admin.publicKey.toBase58(),dev:dev.toBase58(),genesisHash:'genesis',programId:programId.toBase58(),programSha256:'binary',parentMints:[Keypair.generate().publicKey.toBase58(),Keypair.generate().publicKey.toBase58()]};return {value,admin};}
test('fee plan burns the coin-side fees before cumulative distribution and remaining parent budgets',()=>{
 assert.deepEqual(feePlan({...counters(),childPending:5n}),[{kind:'burn',amount:'5'},{kind:'distribute'}]);
 assert.deepEqual(feePlan({...counters(),treasuryPaid:98n,devPaid:20n,parentAAllocated:25n,parentBAllocated:25n,parentASpent:5n,parentBSpent:25n},undefined,1n),[{kind:'buy-burn',index:0,amount:'20'}]);
 assert.deepEqual(feePlan({...counters(),treasuryPaid:98n,devPaid:20n,parentAAllocated:25n,parentBAllocated:25n,parentASpent:5n,parentBSpent:25n},undefined,5_000_000n),[{kind:'buy-burn-waiting',index:0,amount:'20',minimum:'5000000'}],'a budget below the minimum waits on chain instead of paying fees to burn dust');
});
test('completed budgets are never spent again and rounding dust is retained',()=>{assert.deepEqual(feePlan({...counters(),treasuryPaid:98n,devPaid:20n,parentAAllocated:25n,parentBAllocated:25n,parentASpent:25n,parentBSpent:25n}),[]);assert.deepEqual(feePlan({...counters(),totalSol:1n}),[]);});
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
