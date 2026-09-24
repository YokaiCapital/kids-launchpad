// Jupiter v6 parent-buyback routes for the fee keeper (owner decision, 20 Sep 2026: aggregator, not per-pool adapters).
// The program (tag 25) forwards ONLY a `route_v2` whose user accounts are the fee custody accounts, and verifies effects.
// Two builders share one wire format: the mainnet fetcher validates what Jupiter's API returns; the localnet builder
// writes a single Raydium CPMM step for rehearsals on a validator that has Jupiter cloned.
import {PublicKey} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,NATIVE_MINT,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {poolAddresses} from './cpmm.mjs';
import {CPMM,PARENT_AMM_CONFIG} from './atomic-launch.mjs';
export const JUPITER_PROGRAM=new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
export const JUPITER_EVENT_AUTHORITY=PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],JUPITER_PROGRAM)[0];
export const ROUTE_V2_DISCRIMINATOR=Buffer.from('bb64facc31c4af14','hex');
export const SWAP_RAYDIUM_CP=46; // Swap enum index in Jupiter's on-chain IDL (read 20 Sep 2026)
export const MAX_SLIPPAGE_BPS=100,MAX_SLICE_LAMPORTS=500000000n,MAX_STEPS=8;
const u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;},u16=n=>{const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;},u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
/** Encodes route_v2 data: disc | in_amount | quoted_out | slippage_bps | platform_fee_bps | positive_slippage_bps | route_plan vec. */
export function encodeRouteV2({inAmount,quotedOut,slippageBps,platformFeeBps=0,positiveSlippageBps=0,steps}){
 const plan=Buffer.concat([u32(steps.length),...steps.map(s=>Buffer.concat([Buffer.from([s.swap]),u16(s.bps),Buffer.from([s.inputIndex,s.outputIndex])]))]);
 return Buffer.concat([ROUTE_V2_DISCRIMINATOR,u64(inAmount),u64(quotedOut),u16(slippageBps),u16(platformFeeBps),u16(positiveSlippageBps),plan]);
}
/** Reads the route_v2 header the program checks; throws on anything the program would refuse. */
export function decodeRouteV2Header(data,{amount,minOut}){
 if(!Buffer.isBuffer(data)||data.length<34||!data.subarray(0,8).equals(ROUTE_V2_DISCRIMINATOR))throw Error('Not a Jupiter route_v2 instruction');
 const h={inAmount:data.readBigUInt64LE(8),quotedOut:data.readBigUInt64LE(16),slippageBps:data.readUInt16LE(24),platformFeeBps:data.readUInt16LE(26),positiveSlippageBps:data.readUInt16LE(28),steps:data.readUInt32LE(30)};
 if(h.inAmount!==BigInt(amount))throw Error('Route input amount is not the buyback slice');
 if(h.slippageBps>MAX_SLIPPAGE_BPS)throw Error('Route slippage above 1%');
 if(h.platformFeeBps!==0)throw Error('Route carries a platform fee');
 if(h.steps<1||h.steps>MAX_STEPS)throw Error('Route step count out of bounds');
 if(h.quotedOut-h.quotedOut*BigInt(h.slippageBps)/10000n<BigInt(minOut))throw Error('Quoted output minus slippage does not clear the minimum');
 return h;
}
/** Localnet rehearsal route: one RaydiumCP step over the parent's CPMM pool, user accounts = the fee custody accounts. */
export function localnetParentRoute({feeAuthority,parentMint,parentProgram,amount,quotedOut,slippageBps=100}){
 const p=poolAddresses(CPMM,PARENT_AMM_CONFIG,NATIVE_MINT,parentMint),forward=p.mint0.equals(NATIVE_MINT);
 const source=getAssociatedTokenAddressSync(NATIVE_MINT,feeAuthority,true),destination=getAssociatedTokenAddressSync(parentMint,feeAuthority,true,parentProgram);
 const remaining=[[CPMM,false],[feeAuthority,false],[p.authority,false],[PARENT_AMM_CONFIG,false],[p.pool,true],[source,true],[destination,true],[forward?p.vault0:p.vault1,true],[forward?p.vault1:p.vault0,true],[TOKEN_PROGRAM_ID,false],[parentProgram,false],[NATIVE_MINT,false],[parentMint,false],[p.observation,true]];
 return {data:encodeRouteV2({inAmount:amount,quotedOut,slippageBps,steps:[{swap:SWAP_RAYDIUM_CP,bps:10000,inputIndex:0,outputIndex:1}]}),remainingAccounts:remaining.map(([pubkey,isWritable])=>({pubkey,isSigner:false,isWritable})),lookupTables:[],source:'localnet-raydium-cp'};
}
/** Mainnet route from Jupiter's API. Requests a non-shared route for the fee authority and refuses anything the program would. */
export async function fetchJupiterParentRoute({apiBase='https://lite-api.jup.ag/swap/v1',fetchImpl=globalThis.fetch,feeAuthority,parentMint,parentProgram,amount,minOut,slippageBps=100}){
 if(slippageBps>MAX_SLIPPAGE_BPS)throw Error('Slippage above 1%');if(BigInt(amount)>MAX_SLICE_LAMPORTS)throw Error('Slice above 0.5 SOL');
 const q=new URLSearchParams({inputMint:NATIVE_MINT.toBase58(),outputMint:parentMint.toBase58(),amount:String(amount),slippageBps:String(slippageBps),swapMode:'ExactIn',restrictIntermediateTokens:'true',maxAccounts:'40'});
 const quoteRes=await fetchImpl(apiBase+'/quote?'+q,{signal:AbortSignal.timeout(15000)});if(!quoteRes.ok)throw Error('Jupiter quote unavailable ('+quoteRes.status+')');const quote=await quoteRes.json();
 if(quote.inputMint!==NATIVE_MINT.toBase58()||quote.outputMint!==parentMint.toBase58()||String(quote.inAmount)!==String(amount))throw Error('Jupiter quote does not match the request');
 const body={quoteResponse:quote,userPublicKey:feeAuthority.toBase58(),wrapAndUnwrapSol:false,useSharedAccounts:false,asLegacyTransaction:false,dynamicComputeUnitLimit:false,skipUserAccountsRpcCalls:true};
 const swapRes=await fetchImpl(apiBase+'/swap-instructions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});if(!swapRes.ok)throw Error('Jupiter swap instructions unavailable ('+swapRes.status+')');const swap=await swapRes.json();
 if(swap.error)throw Error('Jupiter refused: '+String(swap.error).slice(0,120));
 const ix=swap.swapInstruction;if(!ix||ix.programId!==JUPITER_PROGRAM.toBase58())throw Error('Swap instruction is not Jupiter');
 // Jupiter (skipUserAccountsRpcCalls) lists idempotent token-account creates for the fee authority as setup: the wSOL and
 // parent custody accounts plus any intermediate-token account its route needs. Those are harmless and the keeper
 // creates them itself, rent paid by the operator (the fee authority is a program address and cannot pay). Anything
 // else (a different program, a different owner, a non-idempotent create, cleanup or other instructions) is refused.
 const ATA_PROGRAM='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
 const setup=(swap.setupInstructions??[]).map(si=>{
  if(si.programId!==ATA_PROGRAM||si.data!=='AQ=='||!Array.isArray(si.accounts)||si.accounts.length!==6)throw Error('Jupiter setup instruction is not an idempotent token-account create');
  const [payer,ata,owner,mint,system,tokenProgram]=si.accounts.map(a=>a.pubkey);
  if(owner!==feeAuthority.toBase58())throw Error('Jupiter setup creates a token account for another owner');
  if(system!=='11111111111111111111111111111111'||![TOKEN_PROGRAM_ID.toBase58(),'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(tokenProgram))throw Error('Jupiter setup uses an unknown program');
  const expected=getAssociatedTokenAddressSync(new PublicKey(mint),feeAuthority,true,new PublicKey(tokenProgram)).toBase58();if(expected!==ata)throw Error('Jupiter setup token account is not the fee authority ATA');
  return {mint:new PublicKey(mint),ata:new PublicKey(ata),tokenProgram:new PublicKey(tokenProgram)};
 });
 if(swap.cleanupInstruction||(swap.otherInstructions??[]).length)throw Error('Jupiter wants cleanup or other instructions; refused');
 const data=Buffer.from(ix.data,'base64');decodeRouteV2Header(data,{amount,minOut});
 const accounts=ix.accounts.map(a=>({pubkey:new PublicKey(a.pubkey),isSigner:!!a.isSigner,isWritable:!!a.isWritable}));
 const expectedHead=[feeAuthority,getAssociatedTokenAddressSync(NATIVE_MINT,feeAuthority,true),getAssociatedTokenAddressSync(parentMint,feeAuthority,true,parentProgram),NATIVE_MINT,parentMint,TOKEN_PROGRAM_ID,parentProgram,JUPITER_PROGRAM,JUPITER_EVENT_AUTHORITY,JUPITER_PROGRAM];
 if(accounts.length<expectedHead.length||!expectedHead.every((k,i)=>accounts[i].pubkey.equals(k)))throw Error('Jupiter route does not use the fee custody accounts as its user accounts');
 return {data,setup,remainingAccounts:accounts.slice(expectedHead.length).map(a=>({...a,isSigner:false})),lookupTables:(swap.addressLookupTableAddresses??[]).map(x=>new PublicKey(x)),quotedOut:BigInt(quote.outAmount),quote:{outAmount:String(quote.outAmount),priceImpactPct:String(quote.priceImpactPct??'0')},source:'jupiter-api'};
}
