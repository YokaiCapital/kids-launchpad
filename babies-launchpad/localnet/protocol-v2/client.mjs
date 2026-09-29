// JavaScript client of programs/kids-launch-v2: instruction builders with the exact account orders of the README,
// PDA derivations, and decoders for the campaign, receipt and fee-state layouts. Amounts are BigInt; 32-byte fields
// accept a PublicKey, a base58 string, a hex string or a Buffer. policy.mjs stays the single terms encoder: the
// create body here is its `encodeTerms` output, and `decodeCampaign` re-checks the stored hash exactly as the
// program's `Campaign::decode` does (a campaign whose sealed bytes no longer hash to the stored value is unreadable).
import {createHash} from 'node:crypto';
import {PublicKey,TransactionInstruction,SystemProgram,SYSVAR_RENT_PUBKEY} from '@solana/web3.js';
import {encodeTerms,termsHash,OFFSETS,CAMPAIGN_LEN,RECEIPT_LEN,LAYOUT_VERSION,SEALED_START,SEALED_END,METADATA_URI_MAX,u64 as toU64,i64 as toI64,split,splitForPolicy} from './policy.mjs';

export const TAGS=Object.freeze({create:0,commit:1,finalize:2,refund:3,settle:4,assertReady:5,launch:6,claimParticipant:7,claimDev:8,feesInit:20,feesCollect:21,feesRotateOperator:22,feesDistribute:23,feesBuyBurn:25,feesBurnChild:26});
export const CAMPAIGN_MAGIC=Buffer.from('KIDSLV2C');
export const RECEIPT_MAGIC=Buffer.from('KIDSLV2R');
export const FEE_STATE_MAGIC=Buffer.from('KIDSFEE2');
export const FEE_STATE_LEN=160;
export const COMMIT_BODY_LEN=48;
export const LAUNCH_ACCOUNTS=29;
export const TOKEN_PROGRAM=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM=new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM=new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const WSOL=new PublicKey('So11111111111111111111111111111111111111112');
export const RAYDIUM_CPMM=new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
export const RAYDIUM_LOCK=new PublicKey('LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE');
export const CPMM_CREATE_POOL_FEE_RECEIVER=new PublicKey('DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8');
export const METADATA_PROGRAM=new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
export const MEMO_PROGRAM=new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const JUPITER_PROGRAM=new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
/** Approved AMM config tiers (index, address, trade fee per 1,000,000): index 2 on the localnet clone, index 7 on mainnet. */
export const AMM_CONFIG_TIERS=Object.freeze([Object.freeze({index:2,address:new PublicKey('2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5'),tradeFeeRate:20000n}),Object.freeze({index:7,address:new PublicKey('ESLj2Rzmvn3RhDo4Z18hY1wYmGyC9xM4ZtRXhvoFkDAi'),tradeFeeRate:25000n})]);
/** Program error codes (lib.rs), by name. */
export const ERRORS=Object.freeze({termsInvalid:1,fundingClosed:2,zeroAmount:3,receiptSequence:4,beforeDeadline:5,refundDestination:6,overflow:10,settlementCount:11,notReady:12,networkMismatch:13,fundingNotOpenYet:14,opensAtInPast:15,modeParents:16,policyTable:17,ammConfig:18,accountCount:19,metadata:20,claimInvalid:30,notLaunched:31,notYetClaimable:32,distributionActivated:40,distributionProgramInvalid:41,feeAccount:60,feeArithmetic:61,feeOperator:63,feeRoute:64,feePriceFloor:65,feeReference:66,parentMint:70,parentMintExtension:71,childMint:72,launchAccount:80,launchVerify:81,launchFunds:82,distributionNotWired:90,familyNotAvailable:91,treasuryNotPlatform:92});

/** Any 32-byte key form to a PublicKey. */
export function toKey(value,name='key'){
 if(value instanceof PublicKey)return value;
 if(Buffer.isBuffer(value)||value instanceof Uint8Array){if(value.length!==32)throw new RangeError(name+' must be 32 bytes');return new PublicKey(value);}
 if(typeof value==='string'){if(/^[0-9a-fA-F]{64}$/.test(value))return new PublicKey(Buffer.from(value,'hex'));return new PublicKey(value);}
 throw new TypeError(name+' must be a PublicKey, base58, hex or 32 bytes');
}
export const keyHex=value=>Buffer.from(toKey(value).toBytes()).toString('hex');
const u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(toU64(n));return b;};
const i64=n=>{const b=Buffer.alloc(8);b.writeBigInt64LE(toI64(n));return b;};
const meta=(pubkey,isSigner,isWritable)=>({pubkey:toKey(pubkey),isSigner,isWritable});
const ix=(programId,keys,data)=>new TransactionInstruction({programId:toKey(programId),keys,data});
const pda=(seeds,program)=>PublicKey.findProgramAddressSync(seeds,toKey(program));
const nonceBytes=nonce=>u64(nonce);

// PDAs of this program.
export function campaignAddress(programId,creator,nonce){return pda([Buffer.from('campaign'),toKey(creator).toBuffer(),nonceBytes(nonce)],programId)[0];}
export function campaignAddressAndBump(programId,creator,nonce){return pda([Buffer.from('campaign'),toKey(creator).toBuffer(),nonceBytes(nonce)],programId);}
export function receiptAddress(programId,campaign,owner){return pda([Buffer.from('commitment'),toKey(campaign).toBuffer(),toKey(owner).toBuffer()],programId)[0];}
export function launchAuthority(programId,campaign){return pda([Buffer.from('launch_authority'),toKey(campaign).toBuffer()],programId)[0];}
export function feeStateAddress(programId,campaign){return pda([Buffer.from('fees'),toKey(campaign).toBuffer()],programId)[0];}
export function feeAuthority(programId,campaign){return pda([Buffer.from('fee_authority'),toKey(campaign).toBuffer()],programId)[0];}
// Foreign PDAs the launch and the fee cycle touch.
export function associatedTokenAddress(owner,mint,tokenProgram=TOKEN_PROGRAM){return pda([toKey(owner).toBuffer(),toKey(tokenProgram).toBuffer(),toKey(mint).toBuffer()],ASSOCIATED_TOKEN_PROGRAM)[0];}
export function ammConfigAddress(ammProgram,index){const b=Buffer.alloc(2);b.writeUInt16BE(index);return pda([Buffer.from('amm_config'),b],ammProgram)[0];}
export function cpmmAddresses(ammProgram,ammConfig,childMint){
 const mint=toKey(childMint);const [mint0,mint1]=[mint,WSOL].sort((a,b)=>Buffer.compare(a.toBuffer(),b.toBuffer()));
 const pool=pda([Buffer.from('pool'),toKey(ammConfig).toBuffer(),mint0.toBuffer(),mint1.toBuffer()],ammProgram)[0];
 return {mint0,mint1,pool,authority:pda([Buffer.from('vault_and_lp_mint_auth_seed')],ammProgram)[0],lpMint:pda([Buffer.from('pool_lp_mint'),pool.toBuffer()],ammProgram)[0],vault0:pda([Buffer.from('pool_vault'),pool.toBuffer(),mint0.toBuffer()],ammProgram)[0],vault1:pda([Buffer.from('pool_vault'),pool.toBuffer(),mint1.toBuffer()],ammProgram)[0],observation:pda([Buffer.from('observation'),pool.toBuffer()],ammProgram)[0]};
}
export function lockAuthority(lockProgram){return pda([Buffer.from('lock_cp_authority_seed')],lockProgram)[0];}
export function lockedLiquidityAddress(lockProgram,feeNft){return pda([Buffer.from('locked_liquidity'),toKey(feeNft).toBuffer()],lockProgram)[0];}
export function metadataAddress(mint){return pda([Buffer.from('metadata'),METADATA_PROGRAM.toBuffer(),toKey(mint).toBuffer()],METADATA_PROGRAM)[0];}
export function jupiterEventAuthority(){return pda([Buffer.from('__event_authority')],JUPITER_PROGRAM)[0];}
/** Every launch-related address of a campaign, from its sealed terms and a fee NFT mint. */
export function launchAddresses(programId,campaign,terms,feeNft){
 const authority=launchAuthority(programId,campaign),p=cpmmAddresses(terms.ammProgram,terms.ammConfig,terms.childMint),lockAuth=lockAuthority(terms.lockProgram);
 return {mint0:p.mint0,mint1:p.mint1,pool:p.pool,ammAuthority:p.authority,lpMint:p.lpMint,vault0:p.vault0,vault1:p.vault1,observation:p.observation,authority,child:associatedTokenAddress(authority,terms.childMint),wsol:associatedTokenAddress(authority,WSOL),lp:associatedTokenAddress(authority,p.lpMint),lockAuthority:lockAuth,lockVault:associatedTokenAddress(lockAuth,p.lpMint),feeNft:toKey(feeNft),feeNftAccount:associatedTokenAddress(campaign,feeNft),locked:lockedLiquidityAddress(terms.lockProgram,feeNft),metadata:metadataAddress(feeNft)};
}

// Instruction builders. Account tables are the README's; a builder never reorders or omits an account.
/** Tag 0. `terms` is the policy.mjs terms object (32-byte fields as hex, base58 or keys). */
export function createInstruction(programId,terms){
 const sealed=encodeTerms(normalizeTerms(terms));
 const creator=toKey(terms.creator),campaign=campaignAddress(programId,creator,terms.nonce);
 const keys=[meta(creator,true,true),meta(campaign,false,true),meta(SystemProgram.programId,false,false),meta(terms.ammConfig,false,false)];
 if(!isZero(terms.distributionProgram))keys.push(meta(terms.distributionProgram,false,false));
 if(Number(terms.mode)===1)for(const m of terms.parentMint)keys.push(meta(m,false,false));
 return {instruction:ix(programId,keys,Buffer.concat([Buffer.from([TAGS.create]),sealed])),campaign,sealed,hash:termsHash(sealed)};
}
/** Tag 1. Body: genesis hash, amount, receipt sequence. Signed by the owner, who pays the amount and the receipt rent. */
export function commitInstruction(programId,campaign,owner,genesisHash,amount,sequence){
 const body=Buffer.concat([Buffer.from([TAGS.commit]),toKey(genesisHash).toBuffer(),u64(amount),u64(sequence)]);
 return ix(programId,[meta(owner,true,true),meta(campaign,false,true),meta(receiptAddress(programId,campaign,owner),false,true),meta(SystemProgram.programId,false,false)],body);
}
export function finalizeInstruction(programId,campaign){return ix(programId,[meta(campaign,false,true)],Buffer.from([TAGS.finalize]));}
/** Tag 3. Permissionless; the destination must be the receipt owner. */
export function refundInstruction(programId,campaign,owner){return ix(programId,[meta(campaign,false,true),meta(receiptAddress(programId,campaign,owner),false,true),meta(owner,false,true)],Buffer.from([TAGS.refund]));}
export function settleInstruction(programId,campaign,owner){return ix(programId,[meta(campaign,false,true),meta(receiptAddress(programId,campaign,owner),false,true)],Buffer.from([TAGS.settle]));}
export function assertReadyInstruction(programId,campaign){return ix(programId,[meta(campaign,false,false)],Buffer.from([TAGS.assertReady]));}
/** Tag 6. `keeper` signs and pays the lock rent; `feeNft` is a fresh mint keypair's public key (it signs too). */
export function launchInstruction(programId,campaign,terms,keeper,feeNft){
 const a=launchAddresses(programId,campaign,terms,feeNft);
 const spec=[[campaign,false,true],[keeper,true,true],[a.authority,false,true],[terms.childMint,false,true],[a.child,false,true],[a.wsol,false,true],[feeNft,true,true],[a.feeNftAccount,false,true],[a.locked,false,true],[a.lockVault,false,true],[a.metadata,false,true],[TOKEN_PROGRAM,false,false],[ASSOCIATED_TOKEN_PROGRAM,false,false],[SystemProgram.programId,false,false],[SYSVAR_RENT_PUBKEY,false,false],[terms.ammProgram,false,false],[terms.ammConfig,false,false],[a.ammAuthority,false,false],[a.pool,false,true],[a.lpMint,false,true],[a.lp,false,true],[a.vault0,false,true],[a.vault1,false,true],[CPMM_CREATE_POOL_FEE_RECEIVER,false,true],[a.observation,false,true],[terms.lockProgram,false,false],[a.lockAuthority,false,false],[METADATA_PROGRAM,false,false],[WSOL,false,false]];
 if(spec.length!==LAUNCH_ACCOUNTS)throw Error('launch account table must have '+LAUNCH_ACCOUNTS+' entries');
 return {instruction:ix(programId,spec.map(([k,s,w])=>meta(k,s,w)),Buffer.from([TAGS.launch])),addresses:a};
}
/** Tag 7. Pays the receipt owner's associated token account. Permissionless (anyone may pay the fee). */
export function claimParticipantInstruction(programId,campaign,childMint,owner){
 const authority=launchAuthority(programId,campaign);
 return ix(programId,[meta(campaign,false,true),meta(receiptAddress(programId,campaign,owner),false,true),meta(authority,false,false),meta(childMint,false,false),meta(associatedTokenAddress(authority,childMint),false,true),meta(associatedTokenAddress(owner,childMint),false,true),meta(TOKEN_PROGRAM,false,false)],Buffer.from([TAGS.claimParticipant]));
}
/** Tag 8. Pays the sealed dev's associated token account (cumulative vesting). */
export function claimDevInstruction(programId,campaign,childMint,dev){
 const authority=launchAuthority(programId,campaign);
 return ix(programId,[meta(campaign,false,true),meta(authority,false,false),meta(childMint,false,false),meta(associatedTokenAddress(authority,childMint),false,true),meta(associatedTokenAddress(dev,childMint),false,true),meta(TOKEN_PROGRAM,false,false)],Buffer.from([TAGS.claimDev]));
}
const feeCommon=(programId,campaign,caller,callerSigns,callerWritable)=>[meta(campaign,false,false),meta(caller,callerSigns,callerWritable),meta(feeStateAddress(programId,campaign),false,true),meta(feeAuthority(programId,campaign),false,false)];
/** Tag 20, signed by the sealed treasury (pays the fee state rent). Body: the operator key. */
export function feesInitInstruction(programId,campaign,treasury,operator){return ix(programId,[...feeCommon(programId,campaign,treasury,true,true),meta(SystemProgram.programId,false,false)],Buffer.concat([Buffer.from([TAGS.feesInit]),toKey(operator).toBuffer()]));}
/** Tag 22, signed by the sealed treasury. Body: the new operator key. */
export function feesRotateOperatorInstruction(programId,campaign,treasury,operator){return ix(programId,feeCommon(programId,campaign,treasury,true,false),Buffer.concat([Buffer.from([TAGS.feesRotateOperator]),toKey(operator).toBuffer()]));}
/** Tag 21, permissionless. Body: fee_lp_amount u64 > 0. `campaign` state supplies the recorded pool and fee NFT. */
export function feesCollectInstruction(programId,campaign,terms,state,caller,feeLpAmount){
 const authority=feeAuthority(programId,campaign),p=cpmmAddresses(terms.ammProgram,terms.ammConfig,terms.childMint),lockAuth=lockAuthority(terms.lockProgram);
 if(!p.pool.equals(toKey(state.pool)))throw Error('recorded pool is not the canonical pool of the sealed terms');
 const keys=[...feeCommon(programId,campaign,caller,false,false),meta(associatedTokenAddress(authority,terms.childMint),false,true),meta(associatedTokenAddress(authority,WSOL),false,true),meta(associatedTokenAddress(campaign,state.feeNft),false,true),meta(lockedLiquidityAddress(terms.lockProgram,state.feeNft),false,true),meta(p.pool,false,true),meta(p.lpMint,false,true),meta(p.vault0,false,true),meta(p.vault1,false,true),meta(p.mint0,false,false),meta(p.mint1,false,false),meta(associatedTokenAddress(lockAuth,p.lpMint),false,true),meta(terms.ammProgram,false,false),meta(p.authority,false,false),meta(terms.lockProgram,false,false),meta(lockAuth,false,false),meta(TOKEN_PROGRAM,false,false),meta(TOKEN_2022_PROGRAM,false,false),meta(MEMO_PROGRAM,false,false)];
 if(toU64(feeLpAmount)===0n)throw new RangeError('feeLpAmount must be positive');
 return ix(programId,keys,Buffer.concat([Buffer.from([TAGS.feesCollect]),u64(feeLpAmount)]));
}
/** Tag 23, permissionless, no body. */
export function feesDistributeInstruction(programId,campaign,terms,caller){
 const authority=feeAuthority(programId,campaign);
 return ix(programId,[...feeCommon(programId,campaign,caller,false,false),meta(associatedTokenAddress(authority,WSOL),false,true),meta(associatedTokenAddress(terms.treasury,WSOL),false,true),meta(associatedTokenAddress(terms.dev,WSOL),false,true),meta(TOKEN_PROGRAM,false,false)],Buffer.from([TAGS.feesDistribute]));
}
/** Tag 25, Family only, signed by the recorded operator. `route` is the Jupiter route or route_v2 instruction data
 * verbatim and `remainingAccounts` its remaining accounts as Jupiter's API listed them ({pubkey, isWritable}). There is
 * no Jupiter clone on the localnet, so this builder is checked for layout only. */
export function feesBuyBurnInstruction(programId,campaign,terms,operator,{parent,amount,minOut,expiry,route,remainingAccounts=[]}){
 if(![0,1].includes(parent))throw new RangeError('parent must be 0 or 1');
 const authority=feeAuthority(programId,campaign),parentMint=toKey(terms.parentMint[parent]),parentProgram=toKey(terms.parentProgram[parent]);
 const referenceIndex=Number(terms.parentReferenceConfig[parent]);if(!(referenceIndex>=1))throw new RangeError('the parent has no sealed reference pool');
 const config=ammConfigAddress(terms.ammProgram,referenceIndex-1);
 const [m0,m1]=[parentMint,WSOL].sort((a,b)=>Buffer.compare(a.toBuffer(),b.toBuffer()));
 const pool=pda([Buffer.from('pool'),config.toBuffer(),m0.toBuffer(),m1.toBuffer()],terms.ammProgram)[0];
 const vault=m=>pda([Buffer.from('pool_vault'),pool.toBuffer(),m.toBuffer()],terms.ammProgram)[0];
 const keys=[...feeCommon(programId,campaign,operator,true,false),meta(associatedTokenAddress(authority,WSOL),false,true),meta(associatedTokenAddress(authority,parentMint,parentProgram),false,true),meta(parentMint,false,true),meta(WSOL,false,false),meta(TOKEN_PROGRAM,false,false),meta(parentProgram,false,false),meta(JUPITER_PROGRAM,false,false),meta(jupiterEventAuthority(),false,false),meta(config,false,false),meta(pool,false,false),meta(vault(parentMint),false,false),meta(vault(WSOL),false,false),...remainingAccounts.map(r=>meta(r.pubkey,false,!!r.isWritable))];
 const routeBytes=Buffer.from(route);if(routeBytes.length<34)throw new RangeError('route data too short');
 return ix(programId,keys,Buffer.concat([Buffer.from([TAGS.feesBuyBurn,parent]),u64(amount),u64(minOut),i64(expiry),routeBytes]));
}
/** Tag 26, permissionless. Body: amount u64. */
export function feesBurnChildInstruction(programId,campaign,terms,caller,amount){
 const authority=feeAuthority(programId,campaign);
 return ix(programId,[...feeCommon(programId,campaign,caller,false,false),meta(associatedTokenAddress(authority,terms.childMint),false,true),meta(terms.childMint,false,true),meta(TOKEN_PROGRAM,false,false)],Buffer.concat([Buffer.from([TAGS.feesBurnChild]),u64(amount)]));
}

// Decoders.
const isZero=v=>v==null||toKey(v).equals(PublicKey.default);
const hex32=v=>Buffer.isBuffer(v)||v instanceof Uint8Array?Buffer.from(v).toString('hex'):String(v);
/** Terms with every 32-byte field as hex so policy.mjs can encode them; keys in any form are accepted. */
export function normalizeTerms(t){
 const h=v=>keyHex(v);
 return {...t,genesis:h(t.genesis),creator:h(t.creator),dev:h(t.dev),treasury:h(t.treasury),childMint:h(t.childMint),ammProgram:h(t.ammProgram),ammConfig:h(t.ammConfig),lockProgram:h(t.lockProgram),distributionProgram:h(t.distributionProgram??PublicKey.default),parentMint:(t.parentMint??[PublicKey.default,PublicKey.default]).map(h),parentProgram:(t.parentProgram??[PublicKey.default,PublicKey.default]).map(h),parentRoot:(t.parentRoot??['00'.repeat(32),'00'.repeat(32)]).map(hex32),parentSlot:t.parentSlot??[0,0],parentSupply:t.parentSupply??[0,0],parentEligible:t.parentEligible??[0,0],parentExpirySeconds:t.parentExpirySeconds??0,parentReferenceConfig:t.parentReferenceConfig??[0,0],metadataHash:hex32(t.metadataHash)};
}
/** Reads the sealed region of a full campaign buffer (bytes 8..808). Keys come back as PublicKey, amounts as BigInt. */
export function decodeTerms(d){
 if(d.length<SEALED_END)throw Error('campaign buffer too short');
 const o=OFFSETS,key=at=>new PublicKey(d.subarray(at,at+32)),hex=at=>d.subarray(at,at+32).toString('hex');
 const uriLen=d[o.metadataUriLen];
 return {layoutVersion:d.readUInt16LE(o.layoutVersion),mode:d[o.mode],decimals:d[o.decimals],splitPolicy:d[o.splitPolicy],vestingRule:d[o.vestingRule],feeRoutingVersion:d[o.feeRoutingVersion],creatorFeeEnabled:d[o.creatorFeeEnabled],
  genesis:hex(o.genesis),creator:key(o.creator),nonce:d.readBigUInt64LE(o.nonce),dev:key(o.dev),treasury:key(o.treasury),childMint:key(o.childMint),supply:d.readBigUInt64LE(o.supply),
  opensAt:d.readBigInt64LE(o.opensAt),deadline:d.readBigInt64LE(o.deadline),launchDeadline:d.readBigInt64LE(o.launchDeadline),soft:d.readBigUInt64LE(o.soft),hard:d.readBigUInt64LE(o.hard),
  ammProgram:key(o.ammProgram),ammConfig:key(o.ammConfig),ammTradeFeeRate:d.readBigUInt64LE(o.ammTradeFeeRate),ammConfigIndex:d.readUInt16LE(o.ammConfigIndex),
  feeWeights:{treasury:d.readUInt16LE(o.feeWeights),dev:d.readUInt16LE(o.feeWeights+2),parentA:d.readUInt16LE(o.feeWeights+4),parentB:d.readUInt16LE(o.feeWeights+6)},
  splitBps:{participants:d.readUInt16LE(o.splitBps),liquidity:d.readUInt16LE(o.splitBps+2),parentA:d.readUInt16LE(o.splitBps+4),parentB:d.readUInt16LE(o.splitBps+6),dev:d.readUInt16LE(o.splitBps+8)},
  vesting:{instantBps:d.readUInt16LE(o.vestingInstantBps),linearBps:d.readUInt16LE(o.vestingLinearBps),months:d[o.vestingMonths]},buybackMaxSlippageBps:d.readUInt16LE(o.buybackMaxSlippageBps),
  lockProgram:key(o.lockProgram),distributionProgram:key(o.distributionProgram),
  parentMint:[key(o.parentMint),key(o.parentMint+32)],parentProgram:[key(o.parentProgram),key(o.parentProgram+32)],parentSlot:[d.readBigUInt64LE(o.parentSlot),d.readBigUInt64LE(o.parentSlot+8)],parentRoot:[hex(o.parentRoot),hex(o.parentRoot+32)],
  parentSupply:[d.readBigUInt64LE(o.parentSupply),d.readBigUInt64LE(o.parentSupply+8)],parentEligible:[d.readBigUInt64LE(o.parentEligible),d.readBigUInt64LE(o.parentEligible+8)],parentExpirySeconds:d.readBigUInt64LE(o.parentExpirySeconds),
  metadataHash:hex(o.metadataHash),metadataUri:d.subarray(o.metadataUri,o.metadataUri+uriLen).toString('ascii'),parentReferenceConfig:[d[o.parentReferenceConfig],d[o.parentReferenceConfig+1]]};
}
/** The campaign account: magic, layout version and the stored terms hash are checked as `Campaign::decode` does. */
export function decodeCampaign(data){
 const d=Buffer.from(data);
 if(d.length!==CAMPAIGN_LEN||!d.subarray(0,8).equals(CAMPAIGN_MAGIC))throw Error('not a kids-launch-v2 campaign account');
 const terms=decodeTerms(d);if(terms.layoutVersion!==LAYOUT_VERSION)throw Error('unsupported campaign layout version '+terms.layoutVersion);
 const o=OFFSETS,storedHash=d.subarray(o.termsHash,o.termsHash+32);
 if(!storedHash.equals(termsHash(d.subarray(SEALED_START,SEALED_END))))throw Error('campaign terms hash mismatch: the sealed bytes were altered');
 const state={termsHash:storedHash.toString('hex'),phase:d[o.phase],bump:d[o.bump],flags:d[o.flags],total:d.readBigUInt64LE(o.total),refunded:d.readBigUInt64LE(o.refunded),receiptCount:d.readBigUInt64LE(o.receiptCount),settledCount:d.readBigUInt64LE(o.settledCount),settledAccepted:d.readBigUInt64LE(o.settledAccepted),participantClaimed:d.readBigUInt64LE(o.participantClaimed),devClaimed:d.readBigUInt64LE(o.devClaimed),parentClaimed:[d.readBigUInt64LE(o.parentClaimed),d.readBigUInt64LE(o.parentClaimed+8)],launchTime:d.readBigInt64LE(o.launchTime),pool:new PublicKey(d.subarray(o.pool,o.pool+32)),feeNft:new PublicKey(d.subarray(o.feeNft,o.feeNft+32))};
 return {terms,state,split:split(terms.supply,splitForPolicy(terms.splitPolicy)??terms.splitBps)};
}
export function decodeReceipt(data){
 const d=Buffer.from(data);
 if(d.length!==RECEIPT_LEN||!d.subarray(0,8).equals(RECEIPT_MAGIC))throw Error('not a kids-launch-v2 receipt account');
 // `accounted` (byte 115): funding-first accounting version 2, set exactly once by tag 46; always 0 on a per-receipt record.
 return {campaign:new PublicKey(d.subarray(8,40)),owner:new PublicKey(d.subarray(40,72)),committed:d.readBigUInt64LE(72),refunded:d.readBigUInt64LE(80),sequence:d.readBigUInt64LE(88),accepted:d.readBigUInt64LE(96),claimedTokens:d.readBigUInt64LE(104),bump:d[112],settled:d[113]!==0,claimed:d[114]!==0,accounted:d[115]!==0};
}
export function decodeFeeState(data,campaign){
 const d=Buffer.from(data);
 if(d.length!==FEE_STATE_LEN||!d.subarray(0,8).equals(FEE_STATE_MAGIC))throw Error('not a kids-launch-v2 fee state account');
 if(campaign&&!new PublicKey(d.subarray(8,40)).equals(toKey(campaign)))throw Error('fee state belongs to another campaign');
 const at=i=>d.readBigUInt64LE(40+8*i);
 return {campaign:new PublicKey(d.subarray(8,40)),coinPending:at(0),solCollected:at(1),treasuryPaid:at(2),devPaid:at(3),parentAllocated:[at(4),at(5)],parentSpent:[at(6),at(7)],parentBurned:[at(8),at(9)],coinBurned:at(10),operator:new PublicKey(d.subarray(128,160))};
}
/** getProgramAccounts filters that select every receipt of one campaign (size, magic, campaign). */
export function receiptFilters(campaign){return [{dataSize:RECEIPT_LEN},{memcmp:{offset:0,bytes:bs58(RECEIPT_MAGIC)}},{memcmp:{offset:8,bytes:toKey(campaign).toBase58()}}];}
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58(bytes){let n=BigInt('0x'+Buffer.from(bytes).toString('hex')),out='';while(n>0n){out=B58[Number(n%58n)]+out;n/=58n;}for(const b of bytes){if(b!==0)break;out='1'+out;}return out;}
export const sha256=bytes=>createHash('sha256').update(bytes).digest();
export {METADATA_URI_MAX,CAMPAIGN_LEN,RECEIPT_LEN};
