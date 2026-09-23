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
import {burnChildFeesInstruction} from './atomic-fees.mjs';
import {CURRENT_FEATURES,manifestFeatures} from './program-builds.mjs';
import {parentsAddress} from './atomic-claims.mjs';
import {poolAddresses,decodePool,decodeConfig} from './cpmm.mjs';
import {localnetParentRoute,fetchJupiterParentRoute} from './jupiter-route.mjs';
import {networkProfile,scopeFor} from './network.mjs';
const PROFILE=networkProfile();
import {guardBuybackQuote} from './price-guard.mjs';
import {operatorSigner,toSigner} from './operator-signer.mjs';
/** Parent -> Pyth feed id from the recorded mainnet identities; absent parents have no reference (impact cap and small slice only). */
function parentPythFeed(mint){try{const ids=JSON.parse(readFileSync(new URL('../deployment/MAINNET-IDENTITIES.json',import.meta.url),'utf8'));return ids.parents.find(p=>p.mint===mint.toBase58())?.pythFeedId||null;}catch{return null;}}
import {feeAddresses,initFeesInstruction,collectFeesInstruction,convertFeesInstruction,distributeFeesInstruction,jupiterBuyBurnInstruction,buyBurnInstruction,readFees,boundedQuote} from './atomic-fees.mjs';
import {createOperatorSender} from './operator-journal.mjs';
const defaultFile=fileURLToPath(new URL('./.runtime/active-fee-operator.json',import.meta.url));
const raw=value=>{if(typeof value!=='bigint'||value<0n||value>18446744073709551615n)throw Error('Invalid fee counter');return value;};
export function feePlan(state,features=CURRENT_FEATURES){
 for(const name of ['childPending','totalSol','treasuryPaid','devPaid','parentAAllocated','parentBAllocated','parentASpent','parentBSpent'])raw(state[name]);
 const treasury=state.totalSol*98n/168n,dev=state.totalSol*20n/168n,parent=state.totalSol*25n/168n;
 if(state.treasuryPaid>treasury||state.devPaid>dev||state.parentAAllocated>parent||state.parentBAllocated>parent||state.parentASpent>state.parentAAllocated||state.parentBSpent>state.parentBAllocated)throw Error('Fee counter accounting mismatch');
 const plan=[];if(state.childPending>0n)plan.push({kind:features.includes('burn-child-fees')?'burn':'convert',amount:state.childPending.toString()});
 if(state.treasuryPaid<treasury||state.devPaid<dev||state.parentAAllocated<parent||state.parentBAllocated<parent)plan.push({kind:'distribute'});
 for(const index of [0,1]){const budget=index?state.parentBAllocated-state.parentBSpent:state.parentAAllocated-state.parentASpent;if(budget>0n)plan.push({kind:'buy-burn',index,amount:budget.toString()});}
 return plan;
}
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
   const own=await canonicalRoute(ctx,mint,state.pool);if(!own.pool.equals(state.pool))throw Error('Active fee pool mismatch');for(const parent of parents)await canonicalRoute(ctx,parent);
   const journal=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{identity,sequence:0,attempts:{},lastCollectedAt:null,current:null};
   if(JSON.stringify(journal.identity)!==JSON.stringify(identity))throw Error('Active fee journal identity changed');
   const persist=()=>writeDurableJson(file,journal),send=createOperatorSender({connection:c,journal,persist});
   const programs=await tokenPrograms(c,[mint,NATIVE_MINT,...parents]);if(!programs.get(mint.toBase58()).equals(TOKEN_PROGRAM_ID))throw Error('Child mint must be a classic token');
   const programOf=m=>programs.get(m.toBase58());
   const atas=[[mint,f.authority],[NATIVE_MINT,f.authority],[NATIVE_MINT,state.treasury],[NATIVE_MINT,state.dev],...[...parents].map(p=>[p,f.authority])];
   let operation=journal.current,now=await chainTime(c);
   if(!operation){
    const feeInfo=await c.getAccountInfo(f.state);
    if(!feeInfo||feeInfo.owner.equals(SystemProgram.programId)&&feeInfo.data.length===0)operation={kind:'init'};
    else{
     await readFees(ctx,campaign,mint); // Existing state must be valid, not just present.
     for(const [index,[tokenMint,owner]] of atas.entries()){
      const address=getAssociatedTokenAddressSync(tokenMint,owner,true,programOf(tokenMint)),info=await c.getAccountInfo(address);
      if(!info||info.owner.equals(SystemProgram.programId)&&info.data.length===0){operation={kind:'ata',index};break;}
      const account=unpackAccount(address,info,programOf(tokenMint));if(!account.owner.equals(owner)||!account.mint.equals(tokenMint)||account.isFrozen||account.delegate||account.closeAuthority)throw Error('Fee custody ATA mismatch');
     }
     if(!operation){
      const plan=feePlan(await readFees(ctx,campaign,mint),manifestFeatures(ctx.manifest));
      for(const item of plan){if(item.kind==='distribute'||item.kind==='burn'){operation=item;break;}try{await boundedQuote(c,item.kind==='convert'?mint:NATIVE_MINT,item.kind==='convert'?NATIVE_MINT:parents[item.index],BigInt(item.amount));operation=item;break;}catch(error){if(error.message!=='Trade too small')throw error;}}
      if(!operation&&(journal.lastCollectedAt===null||now-journal.lastCollectedAt>=collectionIntervalSeconds))operation={kind:'collect'};
     }
    }
    if(!operation)return {status:'idle'};
    if(!Number.isSafeInteger(journal.sequence)||journal.sequence<0)throw Error('Invalid fee journal sequence');
    journal.current={...operation,id:'fee:'+journal.sequence++};persist();operation=journal.current;
   }
   let instruction,lookupTables=[];
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
      const feed=parentPythFeed(output);const guardedSlice=feed?slice:(slice>100000000n?100000000n:slice);executed=guardedSlice;
      route=await fetchJupiterParentRoute({apiBase:process.env.KIDS_JUPITER_API||undefined,feeAuthority:f.authority,parentMint:output,parentProgram:programOf(output),amount:guardedSlice,minOut:1n,slippageBps:100});
      const decimals=(await c.getParsedAccountInfo(output)).value?.data?.parsed?.info?.decimals;if(!Number.isInteger(decimals))throw Error('Parent decimals unreadable');
      // Reference-price guard (price-guard.mjs): Pyth on-chain feeds when the parent has one, impact cap always; the result is journaled.
      operation.priceGuard=await guardBuybackQuote(c,{quote:route.quote,amountLamports:guardedSlice,parentDecimals:decimals,parentFeed:feed});
      minOutput=route.quotedOut-route.quotedOut*100n/10000n;if(minOutput<1n)throw Error('Jupiter quote too small');
      if(guardedSlice!==slice)operation.sliceReducedNoReference=true;
     }
     else throw Error('Unknown parent buyback route mode');
     operation.slice=executed.toString();operation.executedAmount=executed.toString();lookupTables=route.lookupTables;
     const sliceUsed=executed;
     instruction=jupiterBuyBurnInstruction(ctx,campaign,admin.publicKey,mint,output,operation.index,sliceUsed,minOutput,expiry,programOf(output),route);
    }
   }else throw Error('Unknown fee operation');
   const tables=lookupTables.length?await Promise.all(lookupTables.map(async address=>{const t=(await c.getAddressLookupTable(address)).value;if(!t)throw Error('Route lookup table missing');return t;})):[];
   const before=await readFees(ctx,campaign,mint).catch(()=>null);
   let signature;
   try{signature=await send(operation.id,async(block,operationId)=>{
    if(!tables.length){const tx=new Transaction({feePayer:admin.publicKey,...block}).add(ComputeBudgetProgram.setComputeUnitLimit({units:1200000}),instruction);await admin.sign(tx,{operationId});return tx;}
    const message=new TransactionMessage({payerKey:admin.publicKey,recentBlockhash:block.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1200000}),instruction]}).compileToV0Message(tables);const tx=new VersionedTransaction(message);await admin.sign(tx,{operationId});return tx;});
   }catch(error){
    // Accrued pool fees too small to withdraw (CPMM ZeroTradingTokens): nothing to collect yet. Release the operation and
    // wait a full interval instead of retrying the same transaction every tick.
    if(isNothingToCollect(operation,error)){journal.current=null;journal.lastCollectedAt=await chainTime(c);persist();console.log(JSON.stringify({event:'fees-nothing-to-collect',campaign:identity.campaign}));return {status:'nothing-to-collect',campaign:identity.campaign};}
    throw error;
   }
   const after=await readFees(ctx,campaign,mint).catch(()=>null);appendFeeEvent(journal,{id:operation.id,kind:operation.kind,index:operation.index??null,amount:operation.executedAmount??operation.slice??operation.amount??null,budget:operation.amount??null,signature,at:await chainTime(c),delta:feeDelta(before,after)});
   if(operation.kind==='collect')journal.lastCollectedAt=await chainTime(c);journal.current=null;persist();
   return {status:'completed',operation:operation.kind,signature,campaign:identity.campaign};
  }finally{running=false;}
 };
}
