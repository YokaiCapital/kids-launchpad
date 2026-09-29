// Fixed localnet fee-account layouts; all quantities are raw integer units.
import {PublicKey,TransactionInstruction,SystemProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,NATIVE_MINT,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {CPMM,LOCK,LOCK_AUTH,PARENT_AMM_CONFIG,u64,campaignPoolAddresses} from './atomic-launch.mjs';
/** The campaign's own pool when its address is known (tier taken from the pool), otherwise a parent's pool on the parent tier. */
function routePool(mintA,mintB,ownMint,ownPool){return ownPool?campaignPoolAddresses(ownMint,ownPool):{...poolAddresses(CPMM,PARENT_AMM_CONFIG,mintA,mintB),config:PARENT_AMM_CONFIG};}
import {poolAddresses} from './cpmm.mjs';
const ata=(mint,owner,program=TOKEN_PROGRAM_ID)=>getAssociatedTokenAddressSync(mint,owner,true,program);
/** A parent mint's token program is its account owner (classic or Token-2022); anything else is refused. */
export const tokenProgramOf=info=>{if(!info)throw Error('Mint account missing');if(info.owner.equals(TOKEN_2022_PROGRAM_ID))return TOKEN_2022_PROGRAM_ID;if(info.owner.equals(TOKEN_PROGRAM_ID))return TOKEN_PROGRAM_ID;throw Error('Mint is not owned by a token program');};
const pda=(program,...seeds)=>PublicKey.findProgramAddressSync(seeds.map(s=>typeof s==='string'?Buffer.from(s):s.toBuffer()),program)[0];
export function feeAddresses(ctx,campaign,mint){return {state:pda(ctx.programId,'fees',campaign),authority:pda(ctx.programId,'fee_authority',campaign),child:ata(mint,pda(ctx.programId,'fee_authority',campaign)),wsol:ata(NATIVE_MINT,pda(ctx.programId,'fee_authority',campaign))};}
function instructionFor(ctx,campaign,keeper,mint,tag,extra,body=Buffer.alloc(0)){
 const f=feeAddresses(ctx,campaign,mint),common=[[campaign,false,false],[keeper,true,tag===20],[f.state,false,true],[f.authority,false,false]];
 return new TransactionInstruction({programId:ctx.programId,keys:[...common,...extra].map(([pubkey,isSigner,isWritable])=>({pubkey,isSigner,isWritable})),data:Buffer.concat([Buffer.from([tag]),body])});
}
/** Tag 26: burn `amount` of the coin-side fees held by the fee authority (owner decision, 23 September 2026). */
export function burnChildFeesInstruction(ctx,campaign,keeper,mint,amount){const f=feeAddresses(ctx,campaign,mint);return instructionFor(ctx,campaign,keeper,mint,26,[[ata(mint,f.authority),false,true],[mint,false,true],[TOKEN_PROGRAM_ID,false,false]],u64(amount));}
export function initFeesInstruction(ctx,campaign,keeper,mint){return instructionFor(ctx,campaign,keeper,mint,20,[[SystemProgram.programId,false,false]]);}
export function collectFeesInstruction(ctx,campaign,keeper,mint,nft,maxLiquidity,pool){
 const f=feeAddresses(ctx,campaign,mint),p=campaignPoolAddresses(mint,pool);
 return instructionFor(ctx,campaign,keeper,mint,21,[[f.child,false,true],[f.wsol,false,true],[ata(nft,campaign),false,true],[pda(LOCK,'locked_liquidity',nft),false,true],[p.pool,false,true],[p.lpMint,false,true],[p.vault0,false,true],[p.vault1,false,true],[p.mint0,false,false],[p.mint1,false,false],[ata(p.lpMint,LOCK_AUTH),false,true],[CPMM,false,false],[p.authority,false,false],[LOCK,false,false],[LOCK_AUTH,false,false],[TOKEN_PROGRAM_ID,false,false],[TOKEN_2022_PROGRAM_ID,false,false],[new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),false,false]],u64(maxLiquidity));
}
export function convertFeesInstruction(ctx,campaign,keeper,mint,amount,minOutput,expiry,pool){return swapFeesInstruction(ctx,campaign,keeper,mint,mint,NATIVE_MINT,amount,minOutput,expiry,undefined,TOKEN_PROGRAM_ID,pool);}
/** parentProgram: the parent mint's token program (tokenProgramOf(mint account)); it becomes account 17, checked on chain against the mint owner. */
export function buyBurnInstruction(ctx,campaign,keeper,mint,parentMint,parentIndex,amount,minOutput,expiry,parentProgram=TOKEN_PROGRAM_ID){return swapFeesInstruction(ctx,campaign,keeper,mint,NATIVE_MINT,parentMint,amount,minOutput,expiry,parentIndex,parentProgram);}
function swapFeesInstruction(ctx,campaign,keeper,mint,inputMint,outputMint,amount,minOutput,expiry,parentIndex,outputProgram=TOKEN_PROGRAM_ID,ownPool){
 const parent=parentIndex!==undefined;if(!parent&&!ownPool)throw Error('Fee conversion needs the campaign pool');
 const f=feeAddresses(ctx,campaign,mint),p=routePool(inputMint,outputMint,mint,parent?null:ownPool),forward=p.mint0.equals(inputMint);
 if(!parent&&!outputProgram.equals(TOKEN_PROGRAM_ID))throw Error('Fee conversion output is WSOL under the classic token program');
 const extra=[[ata(inputMint,f.authority),false,true],[ata(outputMint,f.authority,outputProgram),false,true],[p.pool,false,true],[p.config,false,false],[p.authority,false,false],[forward?p.vault0:p.vault1,false,true],[forward?p.vault1:p.vault0,false,true],[inputMint,false,false],[outputMint,false,parent],[p.observation,false,true],[CPMM,false,false],[TOKEN_PROGRAM_ID,false,false]];
 if(parent)extra.push([pda(ctx.programId,'parents',campaign),false,false],[outputProgram,false,false]);
 return instructionFor(ctx,campaign,keeper,mint,parent?24:22,extra,Buffer.concat([...(parent?[Buffer.from([parentIndex])]:[]),u64(amount),u64(minOutput),u64(expiry)]));
}
/** Program build 6 limits for tag 27 (programs/atomic-launch/src/fees.rs): one slice at most 0.5 SOL, fill at most 1 % under the spot quote. */
export const CHILD_BUYBACK_MAX_SLICE=500_000_000n,CHILD_BUYBACK_MAX_SLIPPAGE_BPS=100n;
/** Tag 27: buy the coin with `amount` lamports of the parents' buyback budget on the campaign's own pool and burn what
 * arrives. Account order per the build-6 table: 4 WSOL custody, 5 coin custody, 6 pool, 7 config, 8 CPMM vault authority,
 * 9 WSOL vault, 10 coin vault, 11 WSOL mint, 12 coin mint (writable, burned), 13 observation, 14 CPMM, 15 Token. */
export function buyBurnChildInstruction(ctx,campaign,keeper,mint,amount,minOutput,expiry,pool){
 if(!pool)throw Error('Coin buyback needs the campaign pool');
 const a=BigInt(amount),m=BigInt(minOutput);if(a<=0n||a>CHILD_BUYBACK_MAX_SLICE)throw Error('Coin buyback slice out of bounds');if(m<=0n)throw Error('Coin buyback minimum must be positive');
 const f=feeAddresses(ctx,campaign,mint),p=campaignPoolAddresses(mint,pool),forward=p.mint0.equals(NATIVE_MINT);
 const extra=[[f.wsol,false,true],[f.child,false,true],[p.pool,false,true],[p.config,false,false],[p.authority,false,false],[forward?p.vault0:p.vault1,false,true],[forward?p.vault1:p.vault0,false,true],[NATIVE_MINT,false,false],[mint,false,true],[p.observation,false,true],[CPMM,false,false],[TOKEN_PROGRAM_ID,false,false]];
 return instructionFor(ctx,campaign,keeper,mint,27,extra,Buffer.concat([u64(a),u64(m),u64(expiry)]));
}
/** The program's floor for tag 27 (fees.rs quote_floor): constant product after the pool fee, less the sealed 1 %, at least 1. */
export function childBuybackFloor({amount,reserveIn,reserveOut,rate}){
 const input=BigInt(amount),rIn=BigInt(reserveIn),rOut=BigInt(reserveOut),r=BigInt(rate);
 if(input<=0n||rIn<=0n||rOut<=0n||r>=1_000_000n)throw Error('Quote floor unavailable');
 const net=input-(input*r+999_999n)/1_000_000n;if(net<=0n)throw Error('Trade too small');
 const quote=net*rOut/(rIn+net);if(quote<=0n)throw Error('Trade too small');
 const floor=quote*(10_000n-CHILD_BUYBACK_MAX_SLIPPAGE_BPS)/10_000n;return floor>1n?floor:1n;
}
export function distributeFeesInstruction(ctx,campaign,keeper,mint,treasury,dev){const f=feeAddresses(ctx,campaign,mint);return instructionFor(ctx,campaign,keeper,mint,23,[[f.wsol,false,true],[ata(NATIVE_MINT,treasury),false,true],[ata(NATIVE_MINT,dev),false,true],[TOKEN_PROGRAM_ID,false,false]]);}
export async function readFees(ctx,campaign,mint){
 const f=feeAddresses(ctx,campaign,mint),account=await ctx.connection.getAccountInfo(f.state);
 if(!account||!account.owner.equals(ctx.programId)||account.data.length!==128||account.data.subarray(0,8).toString()!=='KIDSFEE1'||!new PublicKey(account.data.subarray(8,40)).equals(campaign))throw Error('Invalid fee account');
 const names=['childPending','totalSol','treasuryPaid','devPaid','parentAAllocated','parentBAllocated','parentASpent','parentBSpent','parentABurned','parentBBurned','childBurned'];return Object.fromEntries(names.map((name,i)=>[name,account.data.readBigUInt64LE(40+i*8)]));
}
export async function boundedQuote(connection,inputMint,outputMint,amount,ownPool=null){
 const ownMint=inputMint.equals(NATIVE_MINT)?outputMint:inputMint,p=routePool(inputMint,outputMint,ownMint,ownPool),[pool,config,v0,v1]=await Promise.all([connection.getAccountInfo(p.pool),connection.getAccountInfo(p.config),connection.getAccountInfo(p.vault0),connection.getAccountInfo(p.vault1)]);
 if(!pool||!config||!v0||!v1)throw Error('Pool unavailable');
 const d=pool.data,fees0=d.readBigUInt64LE(341)+d.readBigUInt64LE(357)+d.readBigUInt64LE(397),fees1=d.readBigUInt64LE(349)+d.readBigUInt64LE(365)+d.readBigUInt64LE(405),r0=v0.data.readBigUInt64LE(64)-fees0,r1=v1.data.readBigUInt64LE(64)-fees1;
 const forward=p.mint0.equals(inputMint),reserveIn=forward?r0:r1,reserveOut=forward?r1:r0,rate=config.data.readBigUInt64LE(12),net=amount-(amount*rate+999999n)/1000000n;
 const quote=net*reserveOut/(reserveIn+net);if(quote<=0n)throw Error('Trade too small');return {quote,minOutput:quote*99n/100n||1n,pool:p,reserveIn,reserveOut,net,rate};
}
/** Tag 25: buy-and-burn through Jupiter. Fixed accounts 0..12, then the route's remaining accounts verbatim. */
export function jupiterBuyBurnInstruction(ctx,campaign,keeper,mint,parentMint,parentIndex,amount,minOutput,expiry,parentProgram,route){
 const f=feeAddresses(ctx,campaign,mint);
 const {JUPITER_PROGRAM,JUPITER_EVENT_AUTHORITY}=jupiterConstants();
 const extra=[[ata(NATIVE_MINT,f.authority),false,true],[ata(parentMint,f.authority,parentProgram),false,true],[pda(ctx.programId,'parents',campaign),false,false],[parentMint,false,true],[NATIVE_MINT,false,false],[TOKEN_PROGRAM_ID,false,false],[parentProgram,false,false],[JUPITER_PROGRAM,false,false],[JUPITER_EVENT_AUTHORITY,false,false]];
 const instruction=instructionFor(ctx,campaign,keeper,mint,25,extra,Buffer.concat([Buffer.from([parentIndex]),u64(amount),u64(minOutput),u64(expiry),route.data]));
 instruction.keys.push(...route.remainingAccounts.map(a=>({pubkey:a.pubkey,isSigner:false,isWritable:!!a.isWritable})));
 return instruction;
}
let jupiter;function jupiterConstants(){if(!jupiter){const P=new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');jupiter={JUPITER_PROGRAM:P,JUPITER_EVENT_AUTHORITY:PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],P)[0]};}return jupiter;}
