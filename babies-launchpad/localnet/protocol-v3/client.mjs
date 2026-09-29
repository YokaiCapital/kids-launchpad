// Only a manifest explicitly identifying the new v3 program may use this adapter.
// v3 retains the v2 account layout; layoutVersion is NOT the program version.
import {TransactionInstruction,SystemProgram} from '@solana/web3.js';
import {createHash} from 'node:crypto';
import {toKey,launchAuthority,launchInstruction,receiptAddress,associatedTokenAddress,TOKEN_PROGRAM} from '../protocol-v2/client.mjs';
import {metadataAddress} from '../token-metadata.mjs';
export const PROGRAM_VERSION=3;
export const RETURN_SETUP_TAG=27;
export function returnSetupInstruction(programId,campaign,creator,genesisHash){
 const key=toKey(campaign);
 return new TransactionInstruction({programId:toKey(programId),keys:[
  {pubkey:key,isSigner:false,isWritable:false},
  {pubkey:launchAuthority(programId,key),isSigner:false,isWritable:true},
  {pubkey:toKey(creator),isSigner:false,isWritable:true},
  {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
 ],data:Buffer.concat([Buffer.from([RETURN_SETUP_TAG]),toKey(genesisHash).toBuffer()])});
}

// Compact creation (tag 40, one creator transaction, 28 September 2026). The body carries only what a Standard
// version-3 campaign cannot derive: genesis, nonce, child mint, opening (0 = the chain's time when the transaction
// runs), the two windows, the caps, the AMM tier index, the metadata hash and the CID of the metadata document. The
// program expands it to the full sealed terms (`expand_create_v3` in programs/kids-launch-v3) and runs the version-2
// create on them, so the campaign stores the same 800 sealed bytes a full create would.
import {PublicKey as Key} from '@solana/web3.js';
import {campaignAddress,keyHex,AMM_CONFIG_TIERS,RAYDIUM_CPMM,RAYDIUM_LOCK} from '../protocol-v2/client.mjs';
import {LAYOUT_VERSION,MODE_STANDARD,SPLIT_POLICY_STANDARD_V3,VESTING_RULE_STANDARD_V3,SPLIT_STANDARD_V3,VESTING_STANDARD_V3,FEE_WEIGHTS_STANDARD,FEE_ROUTING_VERSION_1,METADATA_URI_MAX} from '../protocol-v2/policy.mjs';
export const CREATE_V3_TAG=40;
export const CREATE_V3_URI_PREFIX='https://gateway.pinata.cloud/ipfs/';
export const CREATE_V3_FIXED_LEN=139;
/** Bounds the program seals (review of 28 September 2026, L3): each window at most 30 days, a scheduled opening at most
 * 30 days after the chain's time. The hosted quote is tighter (60 s to 7 days). */
export const CREATE_V3_MAX_WINDOW_SECONDS=2592000;
export const CREATE_V3_MAX_SCHEDULE_SECONDS=2592000;
/** Custom error codes of the version-3 program (100 to 104; the version-2 codes stop at 92). */
export const ERRORS_V3=Object.freeze({setupNotTerminal:100,setupAccount:101,pilotCreator:102,economics:103,createBody:104,accountingVersion:105,openBody:106,receiptLimit:107});
const ERROR_NAMES_V3=Object.freeze(Object.fromEntries(Object.entries(ERRORS_V3).map(([k,v])=>[v,k])));
/** Plain name of a version-3 custom error code, or null for a code this program does not define. */
export function programErrorNameV3(code){return ERROR_NAMES_V3[Number(code)]??null;}
export const STANDARD_V3_SUPPLY='1000000000000000';
export const STANDARD_V3_DECIMALS=6;
const BASE58=/^[1-9A-HJ-NP-Za-km-z]{1,64}$/,DECIMAL=/^(0|[1-9][0-9]{0,19})$/;
const u64=(x,name)=>{if(typeof x!=='string'&&typeof x!=='bigint'&&typeof x!=='number')throw Error('Invalid '+name);const n=BigInt(x);if(n<0n||n>(1n<<64n)-1n)throw Error('Invalid '+name);const b=Buffer.alloc(8);b.writeBigUInt64LE(n);return b;};
const u32=(x,name)=>{const n=Number(x);if(!Number.isInteger(n)||n<1||n>0xffffffff)throw Error('Invalid '+name);const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const u16=(x,name)=>{const n=Number(x);if(!Number.isInteger(n)||n<0||n>0xffff)throw Error('Invalid '+name);const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;};
/** The CID of a metadata URI the program would reconstruct, or an error. */
export function metadataCid(uri){
 if(typeof uri!=='string'||!uri.startsWith(CREATE_V3_URI_PREFIX))throw Error('Metadata URI is not on the sealed gateway');
 const cid=uri.slice(CREATE_V3_URI_PREFIX.length);if(!BASE58.test(cid)||CREATE_V3_URI_PREFIX.length+cid.length>METADATA_URI_MAX)throw Error('Metadata CID is not a base58 identifier');
 return cid;
}
/** Body bytes (without the tag). `opensAt` '0' means "when the transaction runs". */
export function compactCreateBody({genesisHash,nonce,childMint,opensAt,fundingDurationSeconds,launchWindowSeconds,softCapLamports,hardCapLamports,ammConfigIndex,metadataHash,metadataUri}){
 const genesis=new Key(genesisHash).toBuffer(),mint=new Key(childMint).toBuffer();
 if(typeof metadataHash!=='string'||!/^[a-f0-9]{64}$/.test(metadataHash))throw Error('Invalid metadata hash');
 if(!AMM_CONFIG_TIERS.some(t=>t.index===Number(ammConfigIndex)))throw Error('Unsupported AMM tier');
 if(typeof opensAt!=='string'||!DECIMAL.test(opensAt)||BigInt(opensAt)>(1n<<63n)-1n)throw Error('Invalid opening time');
 for(const [n,label] of [[fundingDurationSeconds,'funding window'],[launchWindowSeconds,'launch window']])if(!Number.isSafeInteger(Number(n))||Number(n)<1||Number(n)>CREATE_V3_MAX_WINDOW_SECONDS)throw Error('The '+label+' must be between 1 second and 30 days');
 const cid=metadataCid(metadataUri);
 const body=Buffer.concat([genesis,u64(nonce,'nonce'),mint,u64(opensAt,'opensAt'),u32(fundingDurationSeconds,'funding window'),u32(launchWindowSeconds,'launch window'),u64(softCapLamports,'soft cap'),u64(hardCapLamports,'hard cap'),u16(ammConfigIndex,'AMM tier'),Buffer.from(metadataHash,'hex'),Buffer.from([cid.length]),Buffer.from(cid,'ascii')]);
 if(body.length!==CREATE_V3_FIXED_LEN+cid.length)throw Error('Compact body size mismatch');
 return body;
}
/** What the program expands a body to, as a terms object (32-byte fields as hex, amounts as decimal strings). */
export function expandCompactBody(body,{creator,now}){
 if(!Buffer.isBuffer(body)||body.length<CREATE_V3_FIXED_LEN)throw Error('Compact body too short');
 const cidLen=body[138];if(cidLen<1||cidLen>64||body.length!==CREATE_V3_FIXED_LEN+cidLen)throw Error('Compact body length differs from its CID');
 const cid=body.subarray(CREATE_V3_FIXED_LEN).toString('ascii');if(!BASE58.test(cid))throw Error('Compact body CID is not base58');
 const opensRaw=body.readBigUInt64LE(72);if(opensRaw>(1n<<63n)-1n)throw Error('Opening time beyond range');
 const opensAt=opensRaw===0n?BigInt(now):opensRaw;if(opensAt<=0n)throw Error('Opening time must be positive');
 const funding=BigInt(body.readUInt32LE(80)),window=BigInt(body.readUInt32LE(84));if(funding===0n||window===0n)throw Error('Zero window');
 if(funding>BigInt(CREATE_V3_MAX_WINDOW_SECONDS)||window>BigInt(CREATE_V3_MAX_WINDOW_SECONDS))throw Error('A window over 30 days is refused by the program');
 if(opensRaw!==0n&&opensAt>BigInt(now)+BigInt(CREATE_V3_MAX_SCHEDULE_SECONDS))throw Error('A scheduled opening more than 30 days ahead is refused by the program');
 const deadline=opensAt+funding,launchDeadline=deadline+window;if(launchDeadline>(1n<<63n)-1n)throw Error('Deadline overflow');
 const index=body.readUInt16LE(104),tier=AMM_CONFIG_TIERS.find(t=>t.index===index);if(!tier)throw Error('Unsupported AMM tier');
 const creatorHex=keyHex(creator);
 return {layoutVersion:LAYOUT_VERSION,mode:MODE_STANDARD,decimals:STANDARD_V3_DECIMALS,splitPolicy:SPLIT_POLICY_STANDARD_V3,vestingRule:VESTING_RULE_STANDARD_V3,feeRoutingVersion:FEE_ROUTING_VERSION_1,creatorFeeEnabled:0,
  genesis:body.subarray(0,32).toString('hex'),creator:creatorHex,nonce:String(body.readBigUInt64LE(32)),dev:creatorHex,treasury:null,childMint:body.subarray(40,72).toString('hex'),supply:STANDARD_V3_SUPPLY,
  opensAt:String(opensAt),deadline:String(deadline),launchDeadline:String(launchDeadline),soft:String(body.readBigUInt64LE(88)),hard:String(body.readBigUInt64LE(96)),
  ammProgram:keyHex(RAYDIUM_CPMM),ammConfig:keyHex(tier.address),ammConfigIndex:index,ammTradeFeeRate:String(tier.tradeFeeRate),
  feeWeights:{...FEE_WEIGHTS_STANDARD},splitBps:{...SPLIT_STANDARD_V3},vesting:{...VESTING_STANDARD_V3},buybackMaxSlippageBps:0,
  lockProgram:keyHex(RAYDIUM_LOCK),distributionProgram:'00'.repeat(32),parentMint:['00'.repeat(32),'00'.repeat(32)],parentProgram:['00'.repeat(32),'00'.repeat(32)],parentSlot:['0','0'],parentRoot:['00'.repeat(32),'00'.repeat(32)],parentSupply:['0','0'],parentEligible:['0','0'],parentExpirySeconds:'0',parentReferenceConfig:[0,0],
  metadataHash:body.subarray(106,138).toString('hex'),metadataUri:CREATE_V3_URI_PREFIX+cid};
}
/** Tag 40 instruction: the same four accounts as the full create (creator signer, campaign PDA, System, AMM config). */
export function compactCreateInstruction(programId,fields){
 const body=compactCreateBody(fields),creator=new Key(fields.creator),campaign=campaignAddress(programId,creator,fields.nonce),tier=AMM_CONFIG_TIERS.find(t=>t.index===Number(fields.ammConfigIndex));
 const keys=[{pubkey:creator,isSigner:true,isWritable:true},{pubkey:campaign,isSigner:false,isWritable:true},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:tier.address,isSigner:false,isWritable:false}];
 return {instruction:new TransactionInstruction({programId:toKey(programId),keys,data:Buffer.concat([Buffer.from([CREATE_V3_TAG]),body])}),campaign,body};
}

// --- Funding-first accounting (version 2), increment 1: the funding-only opening (tag 41) ---
export const OPEN_FUNDING_TAG=41;
export const ACCOUNTING_VERSION_FUNDING_FIRST=2;
export const MAX_RECEIPTS_V2=65535;
export const MIN_COMMIT_LAMPORTS_V2='1000000';
export const SOFT_FLOOR_LAMPORTS_V2='6553500';
export const COLLATERAL_LAMPORTS_V2='65535';
export const EXT_LEN=256,RESERVATION_LEN=72;
export const OFF_ACCOUNTING_VERSION=992;
const EXT_OFFSETS=Object.freeze({campaign:8,termsHash:40,mint:72,feeNft:104,displayHash:136,version:168,sealed:169,sealedReceipts:172,sealedTotal:176,acceptedTarget:184,accountedCount:192,claimsPaid:196,accountedAccepted:200,collateralReturned:208});
export function extAddress(programId,campaign){return Key.findProgramAddressSync([Buffer.from('ext'),toKey(campaign).toBuffer()],toKey(programId))[0];}
export function mintReservationAddress(programId,mint){return Key.findProgramAddressSync([Buffer.from('mint'),toKey(mint).toBuffer()],toKey(programId))[0];}
export function nftReservationAddress(programId,feeNft){return Key.findProgramAddressSync([Buffer.from('nft'),toKey(feeNft).toBuffer()],toKey(programId))[0];}
/** The on-chain display commitment: sha256(borsh(name) || borsh(symbol) || borsh(uri)), u32 LE length + UTF-8 for each. */
export function displayHash({name,symbol,uri}){
 const borsh=v=>{const b=Buffer.from(String(v),'utf8');const l=Buffer.alloc(4);l.writeUInt32LE(b.length);return Buffer.concat([l,b]);};
 if(Buffer.byteLength(name)>32||Buffer.byteLength(symbol)>10||Buffer.byteLength(uri)>METADATA_URI_MAX)throw Error('Display field too long');
 return createHash('sha256').update(Buffer.concat([borsh(name),borsh(symbol),borsh(uri)])).digest('hex');
}
/** Tag 41 body: the compact creation body, then the display hash (32) and the fee-NFT mint address (32). */
export function openFundingBody(fields){
 if(typeof fields.displayHash!=='string'||!/^[a-f0-9]{64}$/.test(fields.displayHash))throw Error('Invalid display hash');
 if(BigInt(fields.softCapLamports)<BigInt(SOFT_FLOOR_LAMPORTS_V2))throw Error('Soft cap below the funding-first floor');
 return Buffer.concat([compactCreateBody(fields),Buffer.from(fields.displayHash,'hex'),new Key(fields.feeNft).toBuffer()]);
}
/** Accounts: creator (signer), campaign, ext, mint reservation, fee-NFT reservation, child mint (signer), fee NFT (signer), System, AMM config. */
export function openFundingInstruction(programId,fields){
 const body=openFundingBody(fields),creator=new Key(fields.creator),campaign=campaignAddress(programId,creator,fields.nonce),tier=AMM_CONFIG_TIERS.find(t=>t.index===Number(fields.ammConfigIndex));
 const mint=new Key(fields.childMint),feeNft=new Key(fields.feeNft);
 const keys=[{pubkey:creator,isSigner:true,isWritable:true},{pubkey:campaign,isSigner:false,isWritable:true},{pubkey:extAddress(programId,campaign),isSigner:false,isWritable:true},{pubkey:mintReservationAddress(programId,mint),isSigner:false,isWritable:true},{pubkey:nftReservationAddress(programId,feeNft),isSigner:false,isWritable:true},{pubkey:mint,isSigner:true,isWritable:false},{pubkey:feeNft,isSigner:true,isWritable:false},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:tier.address,isSigner:false,isWritable:false}];
 return {instruction:new TransactionInstruction({programId:toKey(programId),keys,data:Buffer.concat([Buffer.from([OPEN_FUNDING_TAG]),body])}),campaign,body};
}
export function decodeExt(data){
 const d=Buffer.from(data);if(d.length!==EXT_LEN||d.subarray(0,8).toString()!=='KIDSEXT2')throw Error('Invalid extension account');
 const key=at=>new Key(d.subarray(at,at+32)).toBase58(),hex=at=>d.subarray(at,at+32).toString('hex'),u64=at=>d.readBigUInt64LE(at).toString();
 return {campaign:key(EXT_OFFSETS.campaign),termsHash:hex(EXT_OFFSETS.termsHash),mint:key(EXT_OFFSETS.mint),feeNft:key(EXT_OFFSETS.feeNft),displayHash:hex(EXT_OFFSETS.displayHash),version:d[EXT_OFFSETS.version],sealed:d[EXT_OFFSETS.sealed]!==0,sealedReceipts:d.readUInt32LE(EXT_OFFSETS.sealedReceipts),sealedTotal:u64(EXT_OFFSETS.sealedTotal),acceptedTarget:u64(EXT_OFFSETS.acceptedTarget),accountedCount:d.readUInt32LE(EXT_OFFSETS.accountedCount),claimsPaid:d.readUInt32LE(EXT_OFFSETS.claimsPaid),accountedAccepted:u64(EXT_OFFSETS.accountedAccepted),collateralReturned:u64(EXT_OFFSETS.collateralReturned)};
}
export function decodeReservation(data){const d=Buffer.from(data);if(d.length!==RESERVATION_LEN||d.subarray(0,8).toString()!=='KIDSRSV2')throw Error('Invalid reservation account');return {campaign:new Key(d.subarray(8,40)).toBase58(),key:new Key(d.subarray(40,72)).toBase58()};}

// --- Funding-first launch (tag 42): the 29 tag-6 accounts (child mint signs), then extension, child metadata, mint and NFT reservations ---
export const LAUNCH_V2_TAG=42;
export const ERRORS_V3_LAUNCH=Object.freeze({launchV2:108});
export function launchDisplayData({name,symbol,uri}){
 const borsh=v=>{const b=Buffer.from(String(v),'utf8');const l=Buffer.alloc(4);l.writeUInt32LE(b.length);return Buffer.concat([l,b]);};
 if(!name||Buffer.byteLength(name)>32||!symbol||Buffer.byteLength(symbol)>10||!uri||Buffer.byteLength(uri)>METADATA_URI_MAX)throw Error('Display field out of bounds');
 return Buffer.concat([borsh(name),borsh(symbol),borsh(uri)]);
}
export const LAUNCH_V2_ACCOUNTS=33,LOOKUP_TABLE_CHUNK=20;
/** A lookup-table account's state as the runtime lays it out (56-byte meta, then 32-byte entries). */
export function decodeLookupTable(data){
 const d=Buffer.from(data);if(d.length<56||(d.length-56)%32)throw Error('Invalid lookup table account');
 const authority=d[21]===1?new Key(d.subarray(22,54)):null,addresses=[];for(let at=56;at<d.length;at+=32)addresses.push(new Key(d.subarray(at,at+32)));
 return {deactivationSlot:d.readBigUInt64LE(4),lastExtendedSlot:Number(d.readBigUInt64LE(12)),authority,addresses};
}
/** The keeper's lookup table for a funding-first launch holds exactly the launch template's non-signer accounts, in template
 * order, each once; the display does not affect the accounts, so any display yields the same list. */
export function launchTableAddresses(programId,campaign,terms,feeNft){
 // The keeper signs, so it is never a table entry; a placeholder that cannot collide with a template account stands in.
 const placeholder=Key.findProgramAddressSync([Buffer.from('lookup-table-placeholder')],toKey(programId))[0];
 const {instruction}=launchFundingFirstInstruction(programId,campaign,terms,placeholder,toKey(feeNft),{name:'x',symbol:'x',uri:'x'});
 return [...new Set(instruction.keys.filter(k=>!k.isSigner).map(k=>k.pubkey.toBase58()))].map(k=>new Key(k));
}
/** The inverse of launchDisplayData for a reader: exact canonical bytes (three length-prefixed UTF-8 fields, nothing else). */
export function parseLaunchDisplayData(data){
 const d=Buffer.from(data);let at=0;
 const read=max=>{if(d.length<at+4)throw Error('Display data truncated');const n=d.readUInt32LE(at);at+=4;if(n===0||n>max||d.length<at+n)throw Error('Display field out of bounds');const s=d.subarray(at,at+n).toString('utf8');if(Buffer.byteLength(s)!==n)throw Error('Display field is not UTF-8');at+=n;return s;};
 const display={name:read(32),symbol:read(10),uri:read(METADATA_URI_MAX)};
 if(at!==d.length||!launchDisplayData(display).equals(d))throw Error('Display data is not canonical');
 return display;
}
export function launchFundingFirstInstruction(programId,campaign,terms,keeper,feeNft,display){
 const base=launchInstruction(programId,campaign,terms,keeper,feeNft);
 const keys=base.instruction.keys.map((k,i)=>i===3?{...k,isSigner:true}:k);
 const mint=toKey(terms.childMint);
 keys.push({pubkey:extAddress(programId,campaign),isSigner:false,isWritable:true},{pubkey:metadataAddress(mint),isSigner:false,isWritable:true},{pubkey:mintReservationAddress(programId,mint),isSigner:false,isWritable:false},{pubkey:nftReservationAddress(programId,feeNft),isSigner:false,isWritable:false});
 return {instruction:new TransactionInstruction({programId:toKey(programId),keys,data:Buffer.concat([Buffer.from([LAUNCH_V2_TAG]),launchDisplayData(display)])}),addresses:base.addresses};
}

// --- Funding-first bookkeeping and payouts (tags 43..47), all without a body ---
export const CLAIM_V2_TAG=43,REFUND_V2_TAG=44,CLOSE_V2_TAG=45,ACCOUNT_V2_TAG=46,RETURN_COLLATERAL_V2_TAG=47;
const ixOf=(programId,keys,tag)=>new TransactionInstruction({programId:toKey(programId),keys,data:Buffer.from([tag])});
const meta=(pubkey,isSigner,isWritable)=>({pubkey:toKey(pubkey),isSigner,isWritable});
export function closeV2Instruction(programId,campaign){return ixOf(programId,[meta(campaign,false,true),meta(extAddress(programId,campaign),false,true)],CLOSE_V2_TAG);}
export function refundV2Instruction(programId,campaign,owner){return ixOf(programId,[meta(campaign,false,true),meta(receiptAddress(programId,campaign,owner),false,true),meta(owner,false,true),meta(extAddress(programId,campaign),false,true)],REFUND_V2_TAG);}
export function accountV2Instruction(programId,campaign,owner){return ixOf(programId,[meta(campaign,false,false),meta(receiptAddress(programId,campaign,owner),false,true),meta(extAddress(programId,campaign),false,true)],ACCOUNT_V2_TAG);}
export function returnCollateralV2Instruction(programId,campaign,creator){return ixOf(programId,[meta(campaign,false,true),meta(extAddress(programId,campaign),false,true),meta(creator,false,true)],RETURN_COLLATERAL_V2_TAG);}
/** Accounts as tag 7 (campaign, receipt, launch authority, child mint, custody, the owner's ATA, Token) plus the extension. */
export function claimV2Instruction(programId,campaign,childMint,owner){
 const authority=launchAuthority(programId,campaign),mint=toKey(childMint);
 return ixOf(programId,[meta(campaign,false,true),meta(receiptAddress(programId,campaign,owner),false,true),meta(authority,false,false),meta(mint,false,false),meta(associatedTokenAddress(authority,mint),false,true),meta(associatedTokenAddress(toKey(owner),mint),false,true),meta(TOKEN_PROGRAM,false,false),meta(extAddress(programId,campaign),false,true)],CLAIM_V2_TAG);
}
