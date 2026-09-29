// Localnet-only spot-quote fee automation. Not an oracle or MEV-safe mainnet router.
import {createHash} from 'node:crypto';
import {acceptedProgramHash} from './program-lineage.mjs';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {PublicKey,Transaction,TransactionMessage,VersionedTransaction,ComputeBudgetProgram,SystemProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,NATIVE_MINT,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,unpackAccount} from '@solana/spl-token';
import {writeDurableJson} from '../shared/durable-json.mjs';
import {resolvePostlaunchCampaign} from './postlaunch-campaign.mjs';
import {localKey,chainTime} from './dev-vesting.mjs';
import {CPMM,PARENT_AMM_CONFIG,LOCK,LOCK_AUTH,authorityAddress,campaignPoolAddresses,checkPoolPolicy} from './atomic-launch.mjs';
import {burnChildFeesInstruction,buyBurnChildInstruction,childBuybackFloor,CHILD_BUYBACK_MAX_SLICE} from './atomic-fees.mjs';
import {burnExpiredParentReservesInstruction} from './atomic-claims.mjs';
import {parentClaimExpiryUnix,parentsBurnRecord} from './parent-claim-window.mjs';
import {CURRENT_FEATURES,manifestFeatures} from './program-builds.mjs';
import {parentsAddress} from './atomic-claims.mjs';
import {poolAddresses,decodePool,decodeConfig} from './cpmm.mjs';
import {localnetParentRoute,fetchJupiterParentRoute} from './jupiter-route.mjs';
import {networkProfile,scopeFor} from './network.mjs';
const PROFILE=networkProfile();
import {guardBuybackQuote,PRICE_GUARD} from './price-guard.mjs';
import {operatorSigner,toSigner} from './operator-signer.mjs';
/** Parent -> Pyth feed id from the recorded mainnet identities; absent parents have no reference (impact cap and small slice only). */
function parentPythFeed(mint){try{const ids=JSON.parse(readFileSync(new URL('../deployment/MAINNET-IDENTITIES.json',import.meta.url),'utf8'));return ids.parents.find(p=>p.mint===mint.toBase58())?.pythFeedId||null;}catch{return null;}}
import {feeAddresses,initFeesInstruction,collectFeesInstruction,convertFeesInstruction,distributeFeesInstruction,jupiterBuyBurnInstruction,buyBurnInstruction,readFees,boundedQuote} from './atomic-fees.mjs';
import {createOperatorSender} from './operator-journal.mjs';
const defaultFile=fileURLToPath(new URL('./.runtime/active-fee-operator.json',import.meta.url));
const raw=value=>{if(typeof value!=='bigint'||value<0n||value>18446744073709551615n)throw Error('Invalid fee counter');return value;};
/** A parent buyback below this budget costs more in network, routing and account fees than it burns; the budget stays
 * reserved on chain (nothing is lost) until it reaches the threshold. Owner escalation 23 September 2026 (0.0016 SOL
 * buybacks burning 0.00). Override with KIDS_BUYBACK_MIN_LAMPORTS. */
/** Coin-side fees are burned only once their SOL value (quoted on the pool) reaches the harvest threshold (0.0005 SOL,
 * the same as COLLECT_THRESHOLDS.lamports): a burn transaction costs the same base fee whatever the amount. */
export const BURN_MIN_VALUE_LAMPORTS=500_000n;
/** Bounded cost of one keeper operation: base fee for at most two signatures, no priority fee (the keeper sets none), no
 * rent (every token account is created ahead of time; Jupiter routes reuse the fee custody's accounts), plus the price
 * guard's 1 % slippage on the executed amount. A budget is worthwhile when the fixed costs are below 2 % of it. */
export const OPERATION_COST_CEILING_LAMPORTS=2n*5_000n;
export const worthwhileBudget=(lamports,ceiling=OPERATION_COST_CEILING_LAMPORTS)=>BigInt(lamports)*2n/100n>=ceiling;
/** The configured minimum can only raise the floor: whatever KIDS_BUYBACK_MIN_LAMPORTS says, a budget below fifty times
 * the cost ceiling is never spent. */
export const BUYBACK_FLOOR_LAMPORTS=OPERATION_COST_CEILING_LAMPORTS*50n;
/** Slippage for parent buybacks on the Jupiter route, in basis points: KIDS_PARENT_BUYBACK_SLIPPAGE_BPS, default 100.
 * The route (jupiter-route.mjs MAX_SLIPPAGE_BPS) and the on-chain program (fees.rs JUPITER_MAX_SLIPPAGE_BPS) both cap it
 * at 1 %, so more than 100 is refused before signing. The reference-price guard and the impact cap apply on top. */
export function parentBuybackSlippageBps(env=process.env){const n=Number(env.KIDS_PARENT_BUYBACK_SLIPPAGE_BPS||'100');if(!Number.isInteger(n)||n<1||n>100)throw Error('KIDS_PARENT_BUYBACK_SLIPPAGE_BPS must be an integer from 1 to 100 (the route and the program cap slippage at 1 %)');return n;}
export function effectiveBuybackMinimum(env=process.env){let v=0n;try{v=BigInt(env.KIDS_BUYBACK_MIN_LAMPORTS||'5000000');}catch{v=0n;}return v>BUYBACK_FLOOR_LAMPORTS?v:BUYBACK_FLOOR_LAMPORTS;}
export const BUYBACK_MIN_LAMPORTS=effectiveBuybackMinimum();
export const burnWorthwhile=(valueLamports,minimum=BURN_MIN_VALUE_LAMPORTS)=>BigInt(valueLamports)>=minimum;
/** A resumed operation (journal.current after a restart) that was already signed is reconciled by the sender and never
 * re-planned or retried to enforce a newer threshold. One that was never signed must pass today's policy before signing:
 * returns null when allowed, else the reason it is withheld. `burnValueLamports` is the quoted value for a burn. */
export function resumedOperationWithheld(operation,{attempts={},burnValueLamports=null,minBuyback=BUYBACK_MIN_LAMPORTS}={}){
 if(!operation)return null;if(attempts[operation.id])return null;
 if((operation.kind==='buy-burn'||operation.kind==='buy-burn-child')&&BigInt(operation.amount||0)<minBuyback)return 'buyback budget below the minimum';
 if(operation.kind==='burn'&&burnValueLamports!==null&&!burnWorthwhile(burnValueLamports))return 'burn value below the threshold';
 return null;
}

export function feePlan(state,features=CURRENT_FEATURES,minBuyback=BUYBACK_MIN_LAMPORTS){
 for(const name of ['childPending','totalSol','treasuryPaid','devPaid','parentAAllocated','parentBAllocated','parentASpent','parentBSpent'])raw(state[name]);
 const treasury=state.totalSol*98n/168n,dev=state.totalSol*20n/168n,parent=state.totalSol*25n/168n;
 if(state.treasuryPaid>treasury||state.devPaid>dev||state.parentAAllocated>parent||state.parentBAllocated>parent||state.parentASpent>state.parentAAllocated||state.parentBSpent>state.parentBAllocated)throw Error('Fee counter accounting mismatch');
 const plan=[];if(state.childPending>0n)plan.push({kind:features.includes('burn-child-fees')?'burn':'convert',amount:state.childPending.toString()});
 if(state.treasuryPaid<treasury||state.devPaid<dev||state.parentAAllocated<parent||state.parentBAllocated<parent)plan.push({kind:'distribute'});
 // Program build 6 ('child-buyback'): the two parent budgets are one budget that buys and burns the coin itself (tag 27),
 // so the plan carries one buy-burn-child item for the combined pending budget and never a parent buy-burn (tags 24 and
 // 25 are refused by that build). Earlier builds keep one buy-burn per parent, unchanged.
 if(features.includes('child-buyback')){
  const budget=(state.parentAAllocated-state.parentASpent)+(state.parentBAllocated-state.parentBSpent);
  if(budget>=minBuyback)plan.push({kind:'buy-burn-child',amount:budget.toString()});else if(budget>0n)plan.push({kind:'buy-burn-child-waiting',amount:budget.toString(),minimum:minBuyback.toString()});
  return plan;
 }
 for(const index of [0,1]){const budget=index?state.parentBAllocated-state.parentBSpent:state.parentAAllocated-state.parentASpent;if(budget>=minBuyback)plan.push({kind:'buy-burn',index,amount:budget.toString()});else if(budget>0n)plan.push({kind:'buy-burn-waiting',index,amount:budget.toString(),minimum:minBuyback.toString()});}
 return plan;
}
/** Coin buyback (tag 27): one slice, at most 0.5 SOL and at most the combined pending budget. */
export function childBuybackSlice(budgetLamports,max=CHILD_BUYBACK_MAX_SLICE){const budget=raw(BigInt(budgetLamports));if(budget<=0n)throw Error('Coin buyback budget is empty');return budget>max?max:budget;}
/** Reserve-based guard for a coin buyback quote (boundedQuote on the campaign's own pool). The coin has no reference
 * price, so only the impact cap applies (price-guard.mjs PRICE_GUARD.maxImpactBps): the net input over the input
 * reserve plus it, which is how far the fill sits under the spot price. The result is journaled like the Pyth guard. */
export function childBuybackGuard(quote,{maxImpactBps=PRICE_GUARD.maxImpactBps}={}){
 if(typeof quote?.net!=='bigint'||typeof quote?.reserveIn!=='bigint'||quote.net<=0n||quote.reserveIn<=0n)throw Error('Quote has no reserves');
 const impactBps=Number(quote.net*10000n/(quote.reserveIn+quote.net));
 if(impactBps>maxImpactBps)throw Error('Quote price impact '+impactBps+' bps exceeds the cap');
 return {referenceCheck:'pool-reserves',impactBps,deviationBps:null,note:'the coin has no reference price; the floor is the pool reserves after the fee, less 1 %'};
}
/** min_out for tag 27: never under the program floor (spot quote less the sealed 1 %); stricter when the configured
 * slippage (KIDS_PARENT_BUYBACK_SLIPPAGE_BPS, at most 100) is lower. */
export function childBuybackMinOut(quote,amount,slippageBps=100){
 const floor=childBuybackFloor({amount,reserveIn:quote.reserveIn,reserveOut:quote.reserveOut,rate:quote.rate});
 const bps=BigInt(slippageBps);if(bps<1n||bps>100n)throw Error('Coin buyback slippage must be 1 to 100 bps');
 const strict=quote.quote-quote.quote*bps/10000n;return strict>floor?strict:floor;
}
/** A tag 11 send the program refused (window still open by the chain clock, or any other program error) is released and
 * retried an hour later; a transport error keeps the existing behaviour (rethrow, the same operation resumes). */
export function expiredBurnRefusal(error){const m=String(error?.message||error);
 if(/Transaction simulation failed|Simulation failed/i.test(m)&&!/Blockhash not found/i.test(m))return 'simulation';
 if(/Operator transaction failed/i.test(m))return 'failed';
 return null;}
export const EXPIRED_BURN_RETRY_SECONDS=3600;
export function validateActiveFeeIdentity(selected,admin){
 const {ctx,campaign,state,record}=selected;
 if(selected.scope!==scopeFor(PROFILE)||ctx.manifest.network!==PROFILE.network||ctx.manifest.rpcUrl!==PROFILE.rpcLabel||ctx.connection.rpcEndpoint!==PROFILE.rpcUrl||record.network!==PROFILE.network||record.ready!==true||state.phase!==3)throw Error('Fee keeper requires a qualified active localnet campaign');
 if(!state.creator.equals(admin.publicKey)||record.creator!==admin.publicKey.toBase58())throw Error('Only the registered local creator may run fees');
 if(record.address!==campaign.toBase58()||record.mint!==state.mint.toBase58()||record.feeNft!==state.feeNft.toBase58()||record.genesisHash!==ctx.manifest.genesisHash||record.programId!==ctx.programId.toBase58()||!acceptedProgramHash(ctx.manifest,record.programSha256)||record.dev!==state.dev.toBase58()||record.treasury!==state.treasury.toBase58())throw Error('Active fee registry identity mismatch');
 const parents=record.parentMints;if(!Array.isArray(parents)||parents.length!==2||parents[0]===parents[1])throw Error('Two registered parents required');
 for(const parent of parents)if([state.mint.toBase58(),NATIVE_MINT.toBase58()].includes(new PublicKey(parent).toBase58()))throw Error('Invalid registered parent');
 return {campaign:campaign.toBase58(),genesisHash:ctx.manifest.genesisHash,programId:ctx.programId.toBase58(),mint:state.mint.toBase58(),feeNft:state.feeNft.toBase58(),parents:[...parents],creator:record.creator,dev:record.dev,treasury:record.treasury};
}
// Raydium CPI interface pinned at115df2779d53bacc7db9d0be2773a4b48a6d372b:
// programs/locking-cpi/src/states.rs (Anchor/Borsh, no native struct padding).
export function lockedPositionAmount(info,{pool,nft,owner,lpMint,vaultAmount}){
 const d=info?.data,discriminator=createHash('sha256').update('account:LockedCpLiquidityState').digest().subarray(0,8);
 if(!info?.owner.equals(LOCK)||d?.length!==256||!d.subarray(0,8).equals(discriminator))throw Error('Invalid locked liquidity position');
 for(const [offset,key] of [[64,pool],[96,nft],[128,owner],[160,lpMint]])if(!d.subarray(offset,offset+32).equals(key.toBuffer()))throw Error('Locked position identity mismatch');
 const amount=d.readBigUInt64LE(8);if(amount===0n||amount>vaultAmount)throw Error('Locked position amount unavailable');return amount;
}
/** The campaign's own pool (its recorded pool decides the tier) or a parent's SOL pool on the parent tier. */
async function canonicalRoute(ctx,mint,ownPool=null){
 const p=ownPool?campaignPoolAddresses(mint,ownPool):{...poolAddresses(CPMM,PARENT_AMM_CONFIG,mint,NATIVE_MINT),config:PARENT_AMM_CONFIG};
 const infos=await ctx.connection.getMultipleAccountsInfo([p.pool,p.config,p.vault0,p.vault1],'confirmed'),pool=decodePool(infos[0],CPMM,p),config=decodeConfig(infos[1],CPMM);
 if((pool.status&4)!==0||config.disabled)throw Error('Canonical fee route unavailable');checkPoolPolicy(pool,config,p.config);
 for(const [i,address] of [p.vault0,p.vault1].entries()){const token=unpackAccount(address,infos[i+2],i?pool.program1:pool.program0);if(!token.owner.equals(p.authority)||!token.mint.equals(i?p.mint1:p.mint0)||token.isFrozen||token.delegate||token.closeAuthority)throw Error('Canonical fee route vault mismatch');}
 return {...p,program0:pool.program0,program1:pool.program1};
}
/** Token program of each mint the keeper touches: the mint account's owner (classic or Token-2022). */
async function tokenPrograms(connection,mints){const infos=await connection.getMultipleAccountsInfo(mints,'confirmed');const out=new Map();mints.forEach((m,i)=>{const info=infos[i];if(!info)throw Error('Mint account missing: '+m.toBase58());const program=info.owner.equals(TOKEN_2022_PROGRAM_ID)?TOKEN_2022_PROGRAM_ID:info.owner.equals(TOKEN_PROGRAM_ID)?TOKEN_PROGRAM_ID:null;if(!program)throw Error('Mint is not owned by a token program: '+m.toBase58());out.set(m.toBase58(),program);});return out;}
/** A collect that fails because the accrued fees round to zero LP tokens is not an error to retry every tick. */
/** Fee harvesting redeems the accrued fee share of the locked LP position (Raydium CollectCpFees then Withdraw): each
 * collect moves a few LP units into the fee custody. A collect that harvests less than the thresholds is dust (network
 * fees paid for no value); the next collect is then delayed with a growing backoff, reset by the first worthwhile harvest.
 * Repeated no-op collections were verified on the live pool on 23 September 2026. */
// The SOL half of a harvest is worth the same as the coin half at the pool price, so the SOL side alone measures value.
export const COLLECT_THRESHOLDS=Object.freeze({lamports:500_000n,maxBackoffSeconds:6*3600});
export function nextCollectionDelay({delta,current,base,max=COLLECT_THRESHOLDS.maxBackoffSeconds}){
 const sol=BigInt(delta?.totalSol||0n);
 if(sol>=COLLECT_THRESHOLDS.lamports)return base;
 return Math.min(max,Math.max(base,(Number(current)||base)*4));
}
/** A parent buyback the tick could not place: the quote was refused (price impact over the cap after halving, Jupiter
 * unavailable or inconsistent) or the RPC refused the signed packet at preflight (nothing was broadcast). Returns the
 * category, or null for every other error (those keep the existing behaviour: rethrow, retry the same operation). */
export function buybackRefusal(error){const m=String(error?.message||error);
 if(/price impact/i.test(m))return 'price-impact';
 if(/Jupiter (quote|swap instructions) unavailable|Jupiter quote (does not match|too small)|Jupiter route/i.test(m))return 'jupiter-quote';
 if(/Transaction simulation failed|Simulation failed/i.test(m)&&!/Blockhash not found/i.test(m))return 'simulation';
 return null;}
/** Release a refused buyback so the next tick starts fresh and the OTHER parent takes the next turn (24 Sep 2026: a
 * Buttcoin packet refused at preflight was resumed every tick and Fartcoin never ran). A signed but refused packet is
 * kept in the journal under a closed key, never deleted. */
export function releaseRefusedBuyback(journal,operation,reason,now=Date.now){
 const old=journal.attempts?.[operation.id];
 if(old&&!old.confirmed){journal.attempts[operation.id+':'+old.createdAt]={...old,closedReason:'refused:'+reason};delete journal.attempts[operation.id];}
 // The coin buyback (build 6) has no turn to pass: its bucket is 'child' and the parent turn marker is left alone.
 const bucket=operation.kind==='buy-burn-child'?'child':operation.index;
 journal.current=null;if(operation.kind!=='buy-burn-child')journal.lastBuybackParent=operation.index;
 const counts=journal.buybackRefusals||{};counts[bucket]=(counts[bucket]||0)+1;journal.buybackRefusals=counts;journal.lastBuybackRefusal={parent:bucket,reason,at:now()};
 return journal;}
/** Release a refused tag 11 (kept under a closed key like a refused buyback) and schedule the next try. */
export function releaseRefusedExpiredBurn(journal,operation,reason,chainNow,now=Date.now){
 const old=journal.attempts?.[operation.id];
 if(old&&!old.confirmed){journal.attempts[operation.id+':'+old.createdAt]={...old,closedReason:'refused:'+reason};delete journal.attempts[operation.id];}
 journal.current=null;journal.parentsExpiredBurnRetryAt=chainNow+EXPIRED_BURN_RETRY_SECONDS;journal.parentsExpiredBurnRefusal={reason,at:now()};
 return journal;}
export function isNothingToCollect(operation,error){return operation?.kind==='collect'&&/0x1776|ZeroTradingTokens/.test(String(error?.message||error));}
/** Counter changes caused by one confirmed fee operation (strings, only the counters that moved). */
export function feeDelta(before,after){if(!before||!after)return null;const out={};for(const k of Object.keys(after)){const d=BigInt(after[k])-BigInt(before[k]||0n);if(d!==0n)out[k]=d.toString();}return out;}
/** Durable, bounded list of confirmed fee operations so the site can show every buyback and burn with its signature. */
export function appendFeeEvent(journal,event){journal.history=[...(journal.history||[]),event].slice(-500);return journal.history;}
export function createActiveFeeKeeper({resolve=()=>resolvePostlaunchCampaign('active'),getAdmin=()=>operatorSigner(),file=defaultFile,collectionIntervalSeconds=300}={}){
 if(!Number.isSafeInteger(collectionIntervalSeconds)||collectionIntervalSeconds<60)throw Error('Fee collection interval must be at least60 seconds');
 let running=false;
 return async function tick(){
  if(running)return {status:'busy'};running=true;
  try{
   const selected=await resolve();if(!selected)return {status:'unavailable'};
   const admin=toSigner(await getAdmin()),identity=validateActiveFeeIdentity(selected,admin),{ctx,campaign,state}=selected,c=ctx.connection,mint=state.mint,parents=identity.parents.map(s=>new PublicKey(s)),f=feeAddresses(ctx,campaign,mint);
   const parentInfo=await c.getAccountInfo(parentsAddress(ctx,campaign));
   if(!parentInfo||!parentInfo.owner.equals(ctx.programId)||parentInfo.data.length!==256||parentInfo.data.subarray(0,8).toString()!=='KIDSPAR1'||!parentInfo.data.subarray(8,40).equals(campaign.toBuffer())||parents.some((p,i)=>!parentInfo.data.subarray(40+i*32,72+i*32).equals(p.toBuffer())))throw Error('On-chain parent registration mismatch');
   // Validate every route before collection: never silently redirect a missing parent pool.
   const features=manifestFeatures(ctx.manifest),childBuyback=features.includes('child-buyback');
   const own=await canonicalRoute(ctx,mint,state.pool);if(!own.pool.equals(state.pool))throw Error('Active fee pool mismatch');
   // On a build that buys the coin itself (build 6) no parent pool is ever traded, so none is required to exist.
   if(!childBuyback)for(const parent of parents)await canonicalRoute(ctx,parent);
   const journal=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{identity,sequence:0,attempts:{},lastCollectedAt:null,current:null};
   if(JSON.stringify(journal.identity)!==JSON.stringify(identity))throw Error('Active fee journal identity changed');
   const persist=()=>writeDurableJson(file,journal),send=createOperatorSender({connection:c,journal,persist});
   const programs=await tokenPrograms(c,[mint,NATIVE_MINT,...parents]);if(!programs.get(mint.toBase58()).equals(TOKEN_PROGRAM_ID))throw Error('Child mint must be a classic token');
   const programOf=m=>programs.get(m.toBase58());
   const atas=[[mint,f.authority],[NATIVE_MINT,f.authority],[NATIVE_MINT,state.treasury],[NATIVE_MINT,state.dev],...[...parents].map(p=>[p,f.authority])];
   let operation=journal.current,now=await chainTime(c);
   if(operation&&!journal.attempts[operation.id]){let burnValue=null;if(operation.kind==='burn'){try{burnValue=(await boundedQuote(c,mint,NATIVE_MINT,BigInt(operation.amount),state.pool)).quote;}catch(error){if(error.message!=='Trade too small')throw error;burnValue=0n;}}
    const withheld=resumedOperationWithheld(operation,{attempts:journal.attempts,burnValueLamports:burnValue});if(withheld){console.log(JSON.stringify({event:'resumed-operation-withheld',campaign:identity.campaign,id:operation.id,kind:operation.kind,reason:withheld}));journal.current=null;persist();operation=null;}}
   if(!operation){
    // Program build 6 ('parent-claim-expiry'): once the window has closed, send tag 11 once. The chain record (KIDSPAR1
    // offset 240) is the guard against a second send; a refused send backs off an hour, a transport error resumes.
    if(features.includes('parent-claim-expiry')){const expiry=parentClaimExpiryUnix(state.launchedAt,features),record=parentsBurnRecord(parentInfo.data);if(expiry!==null&&now>=expiry&&record.burnedAtUnix===null&&!(journal.parentsExpiredBurnRetryAt>now))operation={kind:'parents-expired-burn'};}
    const feeInfo=operation?null:await c.getAccountInfo(f.state);
    if(operation){}
    else if(!feeInfo||feeInfo.owner.equals(SystemProgram.programId)&&feeInfo.data.length===0)operation={kind:'init'};
    else{
     await readFees(ctx,campaign,mint); // Existing state must be valid, not just present.
     for(const [index,[tokenMint,owner]] of atas.entries()){
      const address=getAssociatedTokenAddressSync(tokenMint,owner,true,programOf(tokenMint)),info=await c.getAccountInfo(address);
      if(!info||info.owner.equals(SystemProgram.programId)&&info.data.length===0){operation={kind:'ata',index};break;}
      const account=unpackAccount(address,info,programOf(tokenMint));if(!account.owner.equals(owner)||!account.mint.equals(tokenMint)||account.isFrozen||account.delegate||account.closeAuthority)throw Error('Fee custody ATA mismatch');
     }
     if(!operation){
      const plan=feePlan(await readFees(ctx,campaign,mint),features);
      const collectDelay=journal.collectDelaySeconds||collectionIntervalSeconds,collectDue=journal.lastCollectedAt===null||now-journal.lastCollectedAt>=collectDelay;
      // Both parents take turns: after a slice for one parent the other parent's slice comes first next time, so a
      // large budget on one side never starves the other (24 Sep 2026: Fartcoin ran 40 slices before Buttcoin's first).
      if(plan.filter(x=>x.kind==='buy-burn').length===2&&journal.lastBuybackParent===0){const i=plan.findIndex(x=>x.kind==='buy-burn'&&x.index===1),j=plan.findIndex(x=>x.kind==='buy-burn'&&x.index===0);if(i>j){const [b]=plan.splice(i,1);plan.splice(j,0,b);}}
      for(const item of plan){if(item.kind==='buy-burn-waiting'){console.log(JSON.stringify({event:'buyback-waiting-for-budget',campaign:identity.campaign,parent:item.index,budgetLamports:item.amount,minimumLamports:item.minimum}));continue;}
       if(item.kind==='buy-burn-child-waiting'){console.log(JSON.stringify({event:'buyback-waiting-for-budget',campaign:identity.campaign,parent:'child',budgetLamports:item.amount,minimumLamports:item.minimum}));continue;}
       if(item.kind==='burn'){let value=null;try{value=(await boundedQuote(c,mint,NATIVE_MINT,BigInt(item.amount),state.pool)).quote;}catch(error){if(error.message!=='Trade too small')throw error;value=0n;}if(!burnWorthwhile(value)){console.log(JSON.stringify({event:'burn-waiting-for-value',campaign:identity.campaign,childPendingRaw:item.amount,valueLamports:value.toString(),minimumLamports:BURN_MIN_VALUE_LAMPORTS.toString()}));continue;}operation=item;break;}
       if(item.kind==='distribute'){operation=item;break;}
       // A parent buyback on a Jupiter route is quoted by Jupiter when it runs; the canonical CPMM pool (empty for both parents
       // on mainnet) must not decide whether the slice is attempted.
       // A due collection comes before the parent buybacks: with hundreds of small slices queued, the buybacks would
       // otherwise keep the harvest, and the treasury and dev payouts that follow it, waiting for hours (24 Sep 2026:
       // no collection between 12:07 and the 16:28 restart while the buyback queue held the keeper).
       if((item.kind==='buy-burn'||item.kind==='buy-burn-child')&&collectDue){operation={kind:'collect'};break;}
       // The coin buyback is quoted on the campaign's own pool; a slice the pool cannot price is not attempted.
       if(item.kind==='buy-burn-child'){try{await boundedQuote(c,NATIVE_MINT,mint,childBuybackSlice(item.amount),state.pool);operation=item;break;}catch(error){if(error.message!=='Trade too small')throw error;continue;}}
       if(item.kind==='buy-burn'&&(process.env.KIDS_PARENT_BUYBACK_ROUTE||'cpmm')!=='cpmm'){operation=item;break;}
       try{await boundedQuote(c,item.kind==='convert'?mint:NATIVE_MINT,item.kind==='convert'?NATIVE_MINT:parents[item.index],BigInt(item.amount));operation=item;break;}catch(error){if(error.message!=='Trade too small')throw error;}}
      if(!operation&&collectDue)operation={kind:'collect'};
     }
    }
    if(!operation)return {status:'idle'};
    if(!Number.isSafeInteger(journal.sequence)||journal.sequence<0)throw Error('Invalid fee journal sequence');
    journal.current={...operation,id:'fee:'+journal.sequence++};persist();operation=journal.current;
   }
   try{
   let instruction,lookupTables=[];let setupInstructions=[];
   if(operation.kind==='init')instruction=initFeesInstruction(ctx,campaign,admin.publicKey,mint);
   else if(operation.kind==='ata'){
    const pair=atas[operation.index];if(!pair)throw Error('Invalid ATA operation');const [tokenMint,owner]=pair;instruction=createAssociatedTokenAccountIdempotentInstruction(admin.publicKey,getAssociatedTokenAddressSync(tokenMint,owner,true,programOf(tokenMint)),owner,tokenMint,programOf(tokenMint));
   }else if(operation.kind==='collect'){
    const vault=getAssociatedTokenAddressSync(own.lpMint,LOCK_AUTH,true),account=unpackAccount(vault,await c.getAccountInfo(vault),TOKEN_PROGRAM_ID);if(!account.owner.equals(LOCK_AUTH)||!account.mint.equals(own.lpMint)||account.amount===0n||account.isFrozen||account.delegate||account.closeAuthority)throw Error('Locked liquidity custody unavailable');
    const position=PublicKey.findProgramAddressSync([Buffer.from('locked_liquidity'),state.feeNft.toBuffer()],LOCK)[0];
    const amount=lockedPositionAmount(await c.getAccountInfo(position),{pool:own.pool,nft:state.feeNft,owner:authorityAddress(ctx,campaign),lpMint:own.lpMint,vaultAmount:account.amount});
    instruction=collectFeesInstruction(ctx,campaign,admin.publicKey,mint,state.feeNft,amount,state.pool);
   }else if(operation.kind==='distribute')instruction=distributeFeesInstruction(ctx,campaign,admin.publicKey,mint,state.treasury,state.dev);
   else if(operation.kind==='burn'){instruction=burnChildFeesInstruction(ctx,campaign,admin.publicKey,mint,BigInt(operation.amount));}
   else if(operation.kind==='parents-expired-burn'){if(!features.includes('parent-claim-expiry'))throw Error('Live program has no parent claim window');instruction=burnExpiredParentReservesInstruction(ctx,campaign,mint);}
   else if(operation.kind==='buy-burn-child'){
    // Program build 6, tag 27: the combined parent budget buys the coin on its own pool and burns it. One slice of at most
    // 0.5 SOL; the quote, the reserve-based impact guard (halving down to 0.05 SOL like the routed path), the floor and
    // the journal all use the executed slice. No Pyth reference: the coin has none.
    if(!childBuyback)throw Error('Live program has no coin buyback');
    const budget=raw(BigInt(operation.amount));let slice=childBuybackSlice(budget),quote=null,guard=null;const expiry=await chainTime(c)+90,slippageBps=parentBuybackSlippageBps();
    for(let attempt=0;attempt<4;attempt++){quote=await boundedQuote(c,NATIVE_MINT,mint,slice,state.pool);try{guard=childBuybackGuard(quote);break;}catch(error){if(!/price impact/i.test(String(error.message))||slice<=100000000n)throw error;slice=slice/2n;console.log(JSON.stringify({event:'buyback-slice-reduced',campaign:identity.campaign,parent:'child',sliceLamports:slice.toString(),reason:String(error.message).slice(0,80)}));}}
    if(!guard)throw Error('Quote price impact exceeds the cap');
    const minOutput=childBuybackMinOut(quote,slice,slippageBps);
    operation.priceGuard=guard;operation.slippageBps=slippageBps;operation.slice=slice.toString();operation.executedAmount=slice.toString();operation.minOutput=minOutput.toString();operation.quotedOut=quote.quote.toString();
    instruction=buyBurnChildInstruction(ctx,campaign,admin.publicKey,mint,slice,minOutput,expiry,state.pool);
   }
   else if(operation.kind==='convert'||operation.kind==='buy-burn'){
    if(operation.kind==='buy-burn'&&![0,1].includes(operation.index))throw Error('Invalid parent index');
    const amount=raw(BigInt(operation.amount)),input=operation.kind==='convert'?mint:NATIVE_MINT,output=operation.kind==='convert'?NATIVE_MINT:parents[operation.index],expiry=await chainTime(c)+90;
    // Parent buybacks: KIDS_PARENT_BUYBACK_ROUTE = 'cpmm' (direct canonical pool, tag 24), 'jupiter-localnet' (Jupiter over the
    // parent's CPMM pool on a validator with Jupiter cloned) or 'jupiter' (Jupiter API route, mainnet). Slices are capped at 0.5 SOL.
    const routeMode=process.env.KIDS_PARENT_BUYBACK_ROUTE||'cpmm';
    // One executed amount per operation: the quote, the price guard, the instruction and the journal all use it.
    operation.executedAmount=amount.toString();
    if(operation.kind==='convert'){const quote=await boundedQuote(c,input,output,amount,state.pool);instruction=convertFeesInstruction(ctx,campaign,admin.publicKey,mint,amount,quote.minOutput,expiry,state.pool);}
    else if(routeMode==='cpmm'){const quote=await boundedQuote(c,input,output,amount);instruction=buyBurnInstruction(ctx,campaign,admin.publicKey,mint,output,operation.index,amount,quote.minOutput,expiry,programOf(output));}
    else{
     const slice=amount>500000000n?500000000n:amount;let route,minOutput,executed=slice;
     if(routeMode==='jupiter-localnet'){const quote=await boundedQuote(c,input,output,slice);minOutput=quote.minOutput;route=localnetParentRoute({feeAuthority:f.authority,parentMint:output,parentProgram:programOf(output),amount:slice,quotedOut:quote.quote});}
     else if(routeMode==='jupiter'){
      const feed=parentPythFeed(output);let guardedSlice=feed?slice:(slice>100000000n?100000000n:slice);executed=guardedSlice;
      const slippageBps=parentBuybackSlippageBps();
      route=await fetchJupiterParentRoute({apiBase:process.env.KIDS_JUPITER_API||undefined,feeAuthority:f.authority,parentMint:output,parentProgram:programOf(output),amount:guardedSlice,minOut:1n,slippageBps});
      const decimals=(await c.getParsedAccountInfo(output)).value?.data?.parsed?.info?.decimals;if(!Number.isInteger(decimals))throw Error('Parent decimals unreadable');
      // Reference-price guard (price-guard.mjs): Pyth on-chain feeds when the parent has one, impact cap always; the result is journaled.
      // Thin routes: when the quote's impact exceeds the cap, halve the slice (down to 0.05 SOL) and re-quote in the same
      // tick instead of stalling; the smaller slice is what gets executed and journaled.
      let guard=null;for(let attempt=0;attempt<4;attempt++){try{guard=await guardBuybackQuote(c,{quote:route.quote,amountLamports:guardedSlice,parentDecimals:decimals,parentFeed:feed});break;}catch(error){if(!/price impact/i.test(String(error.message))||guardedSlice<=100000000n)throw error;guardedSlice=guardedSlice/2n;executed=guardedSlice;console.log(JSON.stringify({event:'buyback-slice-reduced',campaign:identity.campaign,parent:operation.index,sliceLamports:guardedSlice.toString(),reason:String(error.message).slice(0,80)}));route=await fetchJupiterParentRoute({apiBase:process.env.KIDS_JUPITER_API||undefined,feeAuthority:f.authority,parentMint:output,parentProgram:programOf(output),amount:guardedSlice,minOut:1n,slippageBps});}}
      operation.priceGuard=guard;
      minOutput=route.quotedOut-route.quotedOut*BigInt(slippageBps)/10000n;if(minOutput<1n)throw Error('Jupiter quote too small');operation.slippageBps=slippageBps;
      if(guardedSlice!==slice)operation.sliceReducedNoReference=true;
     }
     else throw Error('Unknown parent buyback route mode');
     operation.slice=executed.toString();operation.executedAmount=executed.toString();lookupTables=route.lookupTables;
     // Token accounts the route needs for the fee authority (wSOL, the parent, an intermediate token): created in the same
     // transaction, idempotently, rent paid by the operator; the signer allows creates owned by the fee authority.
     setupInstructions=(route.setup||[]).map(x=>createAssociatedTokenAccountIdempotentInstruction(admin.publicKey,x.ata,f.authority,x.mint,x.tokenProgram));if(setupInstructions.length)operation.setupAccounts=(route.setup||[]).map(x=>x.ata.toBase58());
     const sliceUsed=executed;
     instruction=jupiterBuyBurnInstruction(ctx,campaign,admin.publicKey,mint,output,operation.index,sliceUsed,minOutput,expiry,programOf(output),route);
    }
   }else throw Error('Unknown fee operation');
   const tables=lookupTables.length?await Promise.all(lookupTables.map(async address=>{const t=(await c.getAddressLookupTable(address)).value;if(!t)throw Error('Route lookup table missing');return t;})):[];
   const before=await readFees(ctx,campaign,mint).catch(()=>null);
   let signature;
   try{signature=await send(operation.id,async(block,operationId)=>{
    if(!tables.length){const tx=new Transaction({feePayer:admin.publicKey,...block}).add(ComputeBudgetProgram.setComputeUnitLimit({units:1200000}),...setupInstructions,instruction);await admin.sign(tx,{operationId});return tx;}
    const message=new TransactionMessage({payerKey:admin.publicKey,recentBlockhash:block.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1200000}),...setupInstructions,instruction]}).compileToV0Message(tables);const tx=new VersionedTransaction(message);await admin.sign(tx,{operationId});return tx;});
   }catch(error){
    // Accrued pool fees too small to withdraw (CPMM ZeroTradingTokens): nothing to collect yet. Release the operation and
    // wait a full interval instead of retrying the same transaction every tick.
    if(isNothingToCollect(operation,error)){journal.current=null;journal.lastCollectedAt=await chainTime(c);journal.collectDelaySeconds=nextCollectionDelay({delta:null,current:journal.collectDelaySeconds,base:collectionIntervalSeconds});persist();console.log(JSON.stringify({event:'fees-nothing-to-collect',campaign:identity.campaign}));return {status:'nothing-to-collect',campaign:identity.campaign};}
    throw error;
   }
   const after=await readFees(ctx,campaign,mint).catch(()=>null);let delta=feeDelta(before,after);
   // Tag 11 moves no fee counter: its record is the burned amounts tag 11 wrote in the parents account.
   if(operation.kind==='parents-expired-burn'){const record=parentsBurnRecord((await c.getAccountInfo(parentsAddress(ctx,campaign))).data);delta={parentAUnclaimedBurned:record.burnedRaw[0].toString(),parentBUnclaimedBurned:record.burnedRaw[1].toString()};journal.parentsExpiredBurn={signature,at:record.burnedAtUnix,burnedRaw:record.burnedRaw.map(String)};}
   appendFeeEvent(journal,{id:operation.id,kind:operation.kind,index:operation.index??null,amount:operation.executedAmount??operation.slice??operation.amount??null,budget:operation.amount??null,signature,at:await chainTime(c),delta});
   if(operation.kind==='buy-burn'){journal.lastBuybackParent=operation.index;persist();}
   // Running totals of the coin bucket (build 6): the fee counters mix parent purchases before the upgrade and the
   // coin-side burns of tag 26, so the site reads the coin buyback's own SOL and burned coins from here.
   if(operation.kind==='buy-burn-child'){const t=journal.childBuyback||{spentLamports:'0',boughtAndBurnedRaw:'0',slices:0};t.spentLamports=(BigInt(t.spentLamports)+BigInt(delta?.parentASpent||0)+BigInt(delta?.parentBSpent||0)).toString();t.boughtAndBurnedRaw=(BigInt(t.boughtAndBurnedRaw)+BigInt(delta?.childBurned||0)).toString();t.slices+=1;t.lastSignature=signature;journal.childBuyback=t;persist();}
   if(operation.kind==='collect'){journal.lastCollectedAt=await chainTime(c);journal.collectDelaySeconds=nextCollectionDelay({delta:feeDelta(before,after),current:journal.collectDelaySeconds,base:collectionIntervalSeconds});if(journal.collectDelaySeconds>collectionIntervalSeconds)console.log(JSON.stringify({event:'fees-collect-backoff',campaign:identity.campaign,nextInSeconds:journal.collectDelaySeconds}));}journal.current=null;persist();
   return {status:'completed',operation:operation.kind,signature,campaign:identity.campaign};
   }catch(error){
    if(operation.kind==='parents-expired-burn'){const reason=expiredBurnRefusal(error);if(!reason)throw error;releaseRefusedExpiredBurn(journal,operation,reason,await chainTime(c));persist();console.log(JSON.stringify({event:'parents-expired-burn-refused',campaign:identity.campaign,reason,retryAt:journal.parentsExpiredBurnRetryAt,detail:String(error.message).replace(/\s+/g,' ').slice(0,160)}));return {status:'parents-expired-burn-refused',reason,campaign:identity.campaign};}
    const reason=operation.kind==='buy-burn'||operation.kind==='buy-burn-child'?buybackRefusal(error):null;if(!reason)throw error;
    releaseRefusedBuyback(journal,operation,reason);persist();
    const parent=operation.kind==='buy-burn-child'?'child':operation.index;
    console.log(JSON.stringify({event:'buyback-refused',campaign:identity.campaign,parent,reason,detail:String(error.message).replace(/\s+/g,' ').slice(0,160)}));
    return {status:'buyback-refused',parent,reason,campaign:identity.campaign};
   }
  }finally{running=false;}
 };
}
