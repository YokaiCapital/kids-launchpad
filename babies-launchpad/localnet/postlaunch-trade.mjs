import {createIntentRetention,summarizeIntents} from '../shared/intent-retention.mjs';
import {reconcileSignedIntents} from './chain-reconcile.mjs';
import {acceptedProgramHash} from './program-lineage.mjs';
import {pruneUnissuedTradeQuotes,reserveTradeIntentSlot} from './trade-intent-retention.mjs';
import {writeDurableJson} from '../shared/durable-json.mjs';
import {fileURLToPath} from 'node:url';
import {validateApprovedMessage} from '../shared/approved-message.mjs';
import {verifySignature} from '../shared/solana.mjs';
// Registered localnet pools; fixed RPC, pool and recipient. External ephemeral keys are browser-owned.
import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Keypair,PublicKey,Transaction,VersionedTransaction,SystemProgram,ComputeBudgetProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,NATIVE_MINT,ACCOUNT_SIZE,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createInitializeAccount3Instruction,createCloseAccountInstruction,unpackAccount} from '@solana/spl-token';
import {qualifiedCampaign} from './postlaunch-claims.mjs';
import {localKey} from './dev-vesting.mjs';
import {CPMM,campaignPoolAddresses,checkPoolPolicy} from './atomic-launch.mjs';
import {poolAddresses,decodePool,decodeConfig,swapInstruction} from './cpmm.mjs';
import {encodeBase58} from '../shared/solana.mjs';
const file=new URL('./.runtime/postlaunch-trade-intents.json',import.meta.url);
let intents=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
const locks=new Map(),quoteReservations=new Map();
const save=()=>writeDurableJson(fileURLToPath(file),intents);
async function locked(key,work){if(locks.has(key))return locks.get(key);const p=work();locks.set(key,p);try{return await p;}finally{locks.delete(key);}}
const history=createIntentRetention({file:fileURLToPath(file),service:'postlaunch-trades',intents,persist:save,successField:'confirmed',isBusy:key=>locks.has('execute:'+key)||locks.has('quote:'+key),describe:async (i,key,memo)=>{
 const current=await memo(i.campaign,()=>qualifiedCampaign(i.campaign));validateTradeIdentity(i,current);return {connection:current.ctx.connection,signature:i.signature,lastValidBlockHeight:i.block?.lastValidBlockHeight};
}});
let quoteQueue=Promise.resolve();
const enqueueQuote=work=>{const p=quoteQueue.then(work);quoteQueue=p.catch(()=>{});return p;};
function signerFor(owner){const key=['alice','bob'].map(localKey).find(k=>k.publicKey.toBase58()===owner);if(!key)throw Error('Trading is available only to authenticated local test wallets');return key;}
/** User swaps: slippage is the user's choice (owner, 23 September 2026: default 10 %, editable), bounded to 0.01 %..50 %.
 * Keeper buybacks keep their own guards (active-fee-keeper.mjs); this bound is for user quotes only. */
export const SLIPPAGE_BPS={min:1,max:5000,default:1000};
export function validSlippageBps(bps){return Number.isInteger(bps)&&bps>=SLIPPAGE_BPS.min&&bps<=SLIPPAGE_BPS.max;}
/** `tradeRate` is the pool's trade fee in Raydium units (per 1,000,000: 20000 = 2 %, 25000 = 2.5 %), read from its config. */
export function tradeMath(amount,reserveIn,reserveOut,slippageBps,tradeRate=20000n){
 if(typeof amount!=='bigint'||amount<=0n||amount>18446744073709551615n||reserveIn<=0n||reserveOut<=0n)throw Error('Invalid raw trade amount or reserves');
 if(!validSlippageBps(slippageBps))throw Error('Slippage must be between 0.01 % and 50 %');
 if(typeof tradeRate!=='bigint'||tradeRate<=0n||tradeRate>=1000000n)throw Error('Invalid pool trade rate');
 const fee=(amount*tradeRate+999999n)/1000000n,net=amount-fee,output=net*reserveOut/(reserveIn+net),minimum=output*BigInt(10000-slippageBps)/10000n;
 if(net<=0n||minimum<=0n)throw Error('Trade too small');return{fee,output,minimum};
}
export function validateTradeInput(input){
 if(!['buy','sell'].includes(input.side)||typeof input.amountRaw!=='string'||! /^[1-9][0-9]{0,19}$/.test(input.amountRaw))throw Error('Use a positive exact raw-unit amount and buy or sell');
 if(!/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId||''))throw Error('A unique request ID is required');
 if(!validSlippageBps(input.slippageBps))throw Error('Slippage must be between 0.01 % and 50 %');
 if(BigInt(input.amountRaw)>18446744073709551615n)throw Error('Amount exceeds u64');
}
async function reserves(ctx,state){
 const p=campaignPoolAddresses(state.mint,state.pool);
 const infos=await ctx.connection.getMultipleAccountsInfo([p.pool,p.config,p.vault0,p.vault1],'confirmed');
 const decoded=decodePool(infos[0],CPMM,p),fee=decodeConfig(infos[1],CPMM);
 if((decoded.status&4)!==0)throw Error('Pool is not open for swaps');try{checkPoolPolicy(decoded,fee,p.config);}catch{throw Error('Pool configuration is not an approved fee tier');}
 const vaults=[p.vault0,p.vault1].map((v,i)=>unpackAccount(v,infos[i+2],TOKEN_PROGRAM_ID));
 for(let i=0;i<2;i++)if(!vaults[i].owner.equals(p.authority)||!vaults[i].mint.equals(i?p.mint1:p.mint0)||vaults[i].isFrozen)throw Error('Pool vault mismatch');
 const d=infos[0].data;const a=vaults[0].amount-d.readBigUInt64LE(341)-d.readBigUInt64LE(357)-d.readBigUInt64LE(397),b=vaults[1].amount-d.readBigUInt64LE(349)-d.readBigUInt64LE(365)-d.readBigUInt64LE(405);
 return{p,a,b};
}
function publicIntent(i){return Object.fromEntries(['intentId','slippageBps','campaign','owner','side','inputRaw','outputRaw','minOutputRaw','feeRaw','expiresAt','decimalsIn','decimalsOut','signature','mint','pool','programId','genesisHash'].filter(k=>i[k]!==undefined).map(k=>[k,i[k]]));}
const fmt=(raw,decimals)=>{const s=raw.toString().padStart(decimals+1,'0');const whole=s.slice(0,-decimals),frac=s.slice(-decimals).replace(/0+$/,'');return whole+(frac?'.'+frac:'');};
/** Refuse a quote the wallet cannot pay for, in plain words, before anything is signed. Buys keep 0.01 SOL for fees and the temporary wrapped-SOL account. */
export async function assertTradeBalance(connection,owner,side,amountRaw,mint){
 const wallet=new PublicKey(owner);
 if(side==='buy'){const balance=BigInt(await connection.getBalance(wallet,'confirmed')),reserve=10000000n;if(amountRaw+reserve>balance){const max=balance>reserve?balance-reserve:0n;throw Error('You have '+fmt(balance,9)+' SOL on the test ledger. Enter at most '+fmt(max,9)+' SOL to leave room for network fees.');}return;}
 const ata=getAssociatedTokenAddressSync(new PublicKey(mint),wallet,false,TOKEN_PROGRAM_ID);const info=await connection.getTokenAccountBalance(ata,'confirmed').catch(()=>null);const held=BigInt(info?.value?.amount||'0');
 if(amountRaw>held)throw Error(held===0n?'You hold no $Shartcoin in this wallet yet. Claim first, or buy some.':'You hold '+fmt(held,6)+' $Shartcoin. Enter at most that amount.');
}
export async function quotePostlaunchTrade(owner,input){
 validateTradeInput(input);if(new PublicKey(owner).toBase58()!==owner)throw Error('Invalid wallet');
 const descriptor=JSON.stringify([owner,input.campaign,input.side,input.amountRaw,input.slippageBps]);
 const id=createHash('sha256').update(owner+':'+input.requestId).digest('hex');
 const result=await enqueueQuote(()=>locked('quote:'+id,async()=>{
  if(pruneUnissuedTradeQuotes(intents,Date.now(),key=>locks.has('execute:'+key)))save();
  const old=history.lookup(id);if(old){if(old.descriptor!==descriptor)throw Error('Request ID already belongs to different trade terms');validateTradeIdentity(old,await qualifiedCampaign(old.campaign));return publicIntent(old);}
  await history.compact();
  const release=reserveTradeIntentSlot(intents,quoteReservations,owner);
  try{
  const {ctx,campaign,state}=await qualifiedCampaign(input.campaign);if(input.campaign!==campaign.toBase58())throw Error('Launch changed; refresh the coin');
  const {p,a,b}=await reserves(ctx,state),inputMint=input.side==='buy'?NATIVE_MINT:state.mint,forward=p.mint0.equals(inputMint);
  await assertTradeBalance(ctx.connection,owner,input.side,BigInt(input.amountRaw),state.mint);
  const math=tradeMath(BigInt(input.amountRaw),forward?a:b,forward?b:a,input.slippageBps,p.tier.trade);
  const intent={intentId:id,descriptor,campaign:campaign.toBase58(),owner,side:input.side,slippageBps:input.slippageBps,inputRaw:input.amountRaw,outputRaw:math.output.toString(),minOutputRaw:math.minimum.toString(),feeRaw:math.fee.toString(),expiresAt:Date.now()+30000,decimalsIn:input.side==='buy'?9:6,decimalsOut:input.side==='buy'?6:9,genesisHash:ctx.manifest.genesisHash,programSha256:ctx.manifest.sha256,programId:ctx.programId.toBase58(),mint:state.mint.toBase58(),pool:state.pool.toBase58()};
  intents[id]=intent;save();return publicIntent(intent);
  }finally{release();}
 }));
 if(history.lookup(id)?.descriptor!==descriptor)throw Error('Request ID already belongs to different trade terms');
 return result;
}
export async function executePostlaunchTrade(owner,{intentId}){
 const i=history.lookup(intentId);if(!i||i.owner!==owner)throw Error('Trade intent belongs to another wallet or is unavailable');
 return locked('execute:'+intentId,async()=>{
  if(i.executionMode==='external')throw Error('This quote requires an external wallet signature');
  i.executionMode='local';
  const signer=signerFor(owner),{ctx,campaign,state}=await qualifiedCampaign(i.campaign);
  validateTradeIdentity(i,{ctx,campaign,state});
  if(i.archivedProof&&i.archivedProof.kind!=='finalized-success')throw Error('Trade failed or expired; request a fresh quote');
  if(i.confirmed)return publicIntent(i);
  if(i.signature){const status=(await ctx.connection.getSignatureStatuses([i.signature],{searchTransactionHistory:true})).value[0];if(status?.err)throw Error('Trade failed on chain; this intent cannot be reused');if(status&&['confirmed','finalized'].includes(status.confirmationStatus)){i.confirmed=true;save();return publicIntent(i);}if(Date.now()>i.expiresAt)throw Error('Trade outcome pending or quote expired; retain this intent and check again, do not automatically replace it');}
  if(!i.signed){
   if(Date.now()>i.expiresAt)throw Error('Quote expired. Request a fresh quote');
   const {p}=await reserves(ctx,state),ephemeral=Keypair.generate(),rent=await ctx.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE),child=getAssociatedTokenAddressSync(state.mint,signer.publicKey),amount=BigInt(i.inputRaw);
   const funding=BigInt(rent)+(i.side==='buy'?amount:0n);if(funding>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Local SOL funding exceeds safe transfer range');
   const tx=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:180000}),createAssociatedTokenAccountIdempotentInstruction(signer.publicKey,child,signer.publicKey,state.mint),SystemProgram.createAccount({fromPubkey:signer.publicKey,newAccountPubkey:ephemeral.publicKey,lamports:Number(funding),space:ACCOUNT_SIZE,programId:TOKEN_PROGRAM_ID}),createInitializeAccount3Instruction(ephemeral.publicKey,NATIVE_MINT,signer.publicKey));
   const instruction=swapInstruction({programId:CPMM,ammConfig:p.config},p,signer.publicKey,i.side==='buy'?NATIVE_MINT:state.mint,amount,BigInt(i.minOutputRaw));
   instruction.keys[i.side==='buy'?4:5].pubkey=ephemeral.publicKey;
   tx.add(instruction,createCloseAccountInstruction(ephemeral.publicKey,signer.publicKey,signer.publicKey));
   i.block=await ctx.connection.getLatestBlockhash('confirmed');tx.feePayer=signer.publicKey;tx.recentBlockhash=i.block.blockhash;tx.sign(signer,ephemeral);
   if(Date.now()>i.expiresAt)throw Error('Quote expired during preparation');
   i.signed=tx.serialize().toString('base64');i.signature=encodeBase58(tx.signature);save();
  }
  // Never recreate signed bytes, even after transport errors or process restart.
  if(Date.now()>i.expiresAt)throw Error('Quote expired before broadcast; retain the intent for outcome reconciliation');
  save();
  await ctx.connection.sendRawTransaction(Buffer.from(i.signed,'base64'),{skipPreflight:false,maxRetries:0});
  const confirmed=await ctx.connection.confirmTransaction({...i.block,signature:i.signature},'confirmed');if(confirmed.value.err)throw Error('Trade rejected on chain');
  i.confirmed=true;save();return publicIntent(i);
 });
}

export function buildExternalTrade(i,{state,p},wrappedAccount,rent){
 const owner=new PublicKey(i.owner),wrapped=new PublicKey(wrappedAccount),amount=BigInt(i.inputRaw),child=getAssociatedTokenAddressSync(state.mint,owner);
 if(wrapped.equals(owner)||wrapped.equals(child)||wrapped.equals(state.mint)||!PublicKey.isOnCurve(wrapped.toBytes()))throw Error('A distinct ephemeral signing account is required');
 const funding=BigInt(rent)+(i.side==='buy'?amount:0n);if(!Number.isSafeInteger(rent)||rent<0||funding>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Trade funding exceeds safe range');
 const tx=new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(owner,child,owner,state.mint),SystemProgram.createAccount({fromPubkey:owner,newAccountPubkey:wrapped,lamports:Number(funding),space:ACCOUNT_SIZE,programId:TOKEN_PROGRAM_ID}),createInitializeAccount3Instruction(wrapped,NATIVE_MINT,owner));
 const instruction=swapInstruction({programId:CPMM,ammConfig:p.config},p,owner,i.side==='buy'?NATIVE_MINT:state.mint,amount,BigInt(i.minOutputRaw));instruction.keys[i.side==='buy'?4:5].pubkey=wrapped;
 tx.add(instruction,createCloseAccountInstruction(wrapped,owner,owner));return tx;
}
export function validateSignedTrade(raw,unsigned,owner,wrappedAccount){
 if(typeof raw!=='string'||raw.length>8000)throw Error('Signed trade transaction required');
 const tx=VersionedTransaction.deserialize(Buffer.from(raw,'base64')),approved=VersionedTransaction.deserialize(Buffer.from(unsigned,'base64'));
 validateApprovedMessage(tx.message,approved.message);
 const keys=tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures).map(k=>k.toBase58());
 if(keys.length!==2||keys[0]!==owner||keys[1]!==wrappedAccount||!keys.every((key,i)=>verifySignature(key,tx.message.serialize(),tx.signatures[i])))throw Error('Both wallet and temporary account must sign the approved trade');
 return tx;
}
function validateTradeIdentity(i,{ctx,campaign,state}){
 if(i.campaign!==campaign.toBase58()||i.genesisHash!==ctx.manifest.genesisHash||!acceptedProgramHash(ctx.manifest,i.programSha256)||i.programId!==ctx.programId.toBase58()||i.mint!==state.mint.toBase58()||i.pool!==state.pool.toBase58())throw Error('Trade campaign, pool or localnet identity changed');
}
export async function preparePostlaunchTrade(owner,{intentId,wrappedAccount}){
 const i=history.lookup(intentId);if(!i||i.owner!==owner)throw Error('Trade intent belongs to another wallet or is unavailable');
 return locked('execute:'+intentId,async()=>{
  const current=await qualifiedCampaign(i.campaign);validateTradeIdentity(i,current);
  if(i.archivedProof&&i.archivedProof.kind!=='finalized-success')throw Error('Trade failed or expired; request a fresh quote');
  if(i.executionMode==='local')throw Error('This quote is already assigned to local execution');
  if(i.wrappedAccount&&i.wrappedAccount!==wrappedAccount)throw Error('Temporary account cannot change on retry');
  if(Date.now()>i.expiresAt&&!i.signed)throw Error('Quote expired. Request a fresh quote');
  if(!i.unsignedTransactionBase64){
   const {ctx,state}=current,{p}=await reserves(ctx,state),rent=await ctx.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
   const tx=buildExternalTrade(i,{state,p},wrappedAccount,rent);
   if(await ctx.connection.getAccountInfo(new PublicKey(wrappedAccount)))throw Error('Temporary account already exists');
   i.block=await ctx.connection.getLatestBlockhash('confirmed');tx.feePayer=new PublicKey(owner);tx.recentBlockhash=i.block.blockhash;
   i.executionMode='external';i.wrappedAccount=wrappedAccount;i.rentLamports=String(rent);i.unsignedTransactionBase64=tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');
  }
  save();return {...publicIntent(i),wrappedAccount:i.wrappedAccount,rentLamports:i.rentLamports,unsignedTransactionBase64:i.unsignedTransactionBase64};
 });
}
export async function submitPostlaunchTrade(owner,input){
 const i=history.lookup(input.intentId);if(!i||i.owner!==owner||i.executionMode!=='external'||!i.unsignedTransactionBase64)throw Error('Prepared wallet-signed trade unavailable');
 if(input.local!==undefined)throw Error('External trades require wallet signatures');
 return locked('execute:'+i.intentId,async()=>{
  const current=await qualifiedCampaign(i.campaign);validateTradeIdentity(i,current);const {connection}=current.ctx;
  if(i.archivedProof&&i.archivedProof.kind!=='finalized-success')throw Error('Trade failed or expired; request a fresh quote');
  if(i.confirmed)return publicIntent(i);
  if(i.signature){const status=(await connection.getSignatureStatuses([i.signature],{searchTransactionHistory:true})).value[0];if(status?.err)throw Error('Trade failed on chain; this intent cannot be reused');if(status&&['confirmed','finalized'].includes(status.confirmationStatus)){i.confirmed=true;save();return publicIntent(i);}}
  // A quote expires at submission, not at inclusion. Slippage min-out is enforced on chain.
  if(Date.now()>i.expiresAt)throw Error(i.signature?'Trade outcome pending or quote expired; retain this intent for reconciliation':'Quote expired. Request a fresh quote');
  if(!i.signed){const tx=validateSignedTrade(input.signedTransactionBase64,i.unsignedTransactionBase64,owner,i.wrappedAccount);i.signed=Buffer.from(tx.serialize()).toString('base64');i.signature=encodeBase58(tx.signatures[0]);}
  save(); // Required again even if a prior durable write threw after in-memory assignment.
  const signature=await connection.sendRawTransaction(Buffer.from(i.signed,'base64'),{skipPreflight:false,maxRetries:0});if(signature!==i.signature)throw Error('Unexpected trade signature from RPC');
  const result=await connection.confirmTransaction({...i.block,signature},'confirmed');if(result.value.err)throw Error('Trade rejected on chain');i.confirmed=true;save();return publicIntent(i);
 });
}
/** Startup reconciliation (docs/ENGINEERING-RULES.md): classify every finalized outcome against the chain before writes reopen. */
export async function reconcile(){const first=Object.values(intents).find(i=>i&&typeof i==='object'&&i.campaign);if(!first)return {service:'postlaunch-trades',hot:Object.keys(intents).length,signed:0,checked:0,unresolvedSigned:0,complete:true};const current=await qualifiedCampaign(first.campaign);const summary=await reconcileSignedIntents({service:'postlaunch-trades',intents,connection:current.ctx.connection,successField:'confirmed',persist:save});await history.compact();return summary;}
