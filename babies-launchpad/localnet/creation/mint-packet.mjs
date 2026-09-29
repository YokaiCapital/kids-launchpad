// Internal planner, not an HTTP signing endpoint. Callers must load the accepted
// review and owned metadata from trusted storage before constructing this intent.
// No RPC, key generation, inventory access, signatures or broadcasts occur here.
import {PublicKey,SystemProgram,TransactionMessage,VersionedTransaction,ComputeBudgetProgram} from '@solana/web3.js';
import {createInitializeMint2Instruction,createAssociatedTokenAccountIdempotentInstruction,createMintToInstruction,createSetAuthorityInstruction,AuthorityType} from '@solana/spl-token';
import {campaignAddress,launchAuthority,associatedTokenAddress,TOKEN_PROGRAM,WSOL,AMM_CONFIG_TIERS,keyHex} from '../protocol-v2/client.mjs';
import {encodeTerms} from '../protocol-v2/policy.mjs';
import {compactCreateInstruction,compactCreateBody,expandCompactBody,metadataCid,openFundingInstruction,displayHash,SOFT_FLOOR_LAMPORTS_V2} from '../protocol-v3/client.mjs';
import {createMetadataInstruction} from '../token-metadata.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {verifySignature} from '../../shared/solana.mjs';
import {validateKidsMint} from '../mints/leases.mjs';

const key=x=>new PublicKey(x).toBase58();
const hash=/^[a-f0-9]{64}$/;
const integer=(x,max,name)=>{if(typeof x!=='string'||!/^(0|[1-9][0-9]*)$/.test(x)||BigInt(x)>max)throw Error('Invalid '+name);return x;};
const exact=(x,fields)=>{if(!x||Object.keys(x).sort().join(',')!==fields.slice().sort().join(','))throw Error('Unexpected mint intent fields');};
const text=(x,max,name)=>{if(typeof x!=='string'||!x.trim()||Buffer.byteLength(x)>max||/[\x00-\x1f\x7f]/.test(x))throw Error('Invalid '+name);return x;};
export const STANDARD_MINT_SUPPLY='1000000000000000';
const SUPPLY=STANDARD_MINT_SUPPLY;

/** Fixed Standard-v3 mint leg. A blockhash is deliberately NOT part of the
 * immutable intent hash: a reconciled expired attempt may use a later blockhash
 * without changing the inventory's permanent binding. Attempt authorization and
 * generation limits are separately enforced by the durable journal/signing gate. */
/** Version 2 (one creation transaction, 28 September 2026): the mint leg plus the campaign creation, the setup budget
 * and the operating reserve, all approved by one wallet signature. `opensAt` '0' means the chain time when it runs. */
const LAUNCH_FIELDS=['policy','treasury','opensAt','authorityBudgetLamports','reserve','priorityFeeLamports'],POLICY_FIELDS=['policyHash','planHash','softCapLamports','hardCapLamports','fundingDurationSeconds','launchWindowSeconds','ammConfig','ammConfigIndex','tradeFeeBps'];
function validateLaunch(l,p){
  exact(l,LAUNCH_FIELDS);exact(l.policy,POLICY_FIELDS);exact(l.reserve,['payer','lamports']);
  for(const f of ['policyHash','planHash'])if(!hash.test(l.policy[f]||''))throw Error('Invalid launch policy identity');
  const soft=BigInt(integer(l.policy.softCapLamports,(1n<<64n)-1n,'soft cap')),hard=BigInt(integer(l.policy.hardCapLamports,(1n<<64n)-1n,'hard cap'));if(soft<1n||hard<soft)throw Error('Invalid launch caps');
  for(const f of ['fundingDurationSeconds','launchWindowSeconds'])if(!Number.isSafeInteger(l.policy[f])||l.policy[f]<60||l.policy[f]>604800)throw Error('Invalid launch window');
  const tier=AMM_CONFIG_TIERS.find(t=>t.index===l.policy.ammConfigIndex);
  if(!tier||tier.address.toBase58()!==l.policy.ammConfig||!Number.isInteger(l.policy.tradeFeeBps)||BigInt(l.policy.tradeFeeBps)*100n!==tier.tradeFeeRate)throw Error('Unsupported launch AMM policy');
  const taken=[p.creator,p.mint,p.campaign,p.authority,p.programId];
  if(key(l.treasury)!==l.treasury||l.treasury===PublicKey.default.toBase58()||taken.includes(l.treasury))throw Error('Invalid sealed treasury');
  integer(l.opensAt,(1n<<63n)-1n,'opening time');
  if(BigInt(integer(l.authorityBudgetLamports,BigInt(Number.MAX_SAFE_INTEGER),'setup budget'))<1n)throw Error('Setup budget required');
  if(key(l.reserve.payer)!==l.reserve.payer||taken.includes(l.reserve.payer))throw Error('Invalid operating payer');
  if(BigInt(integer(l.reserve.lamports,BigInt(Number.MAX_SAFE_INTEGER),'operating reserve'))<1n)throw Error('Operating reserve required');
  integer(l.priorityFeeLamports,1000000000n,'priority fee');
  metadataCid(p.metadata.uri);
}
/** Version 3 (funding-first accounting, 29 September 2026): one creator transaction opens the funding round (tag 41: the
 * sealed terms, the display commitment and the reserved mint and fee-NFT keys, both signing) and funds the setup budget
 * and the operating reserve. No token exists until the keeper's launch; the mint rent the quote priced (`rentLamports`)
 * is then paid by the keeper from the operating reserve. `fundingFirst.feeNft` is the custody's reserved fee-NFT key. */
function validateFundingFirst(f,p){
  exact(f,['feeNft']);
  if(key(f.feeNft)!==f.feeNft||f.feeNft===PublicKey.default.toBase58())throw Error('Invalid fee NFT');
  if([p.creator,p.mint,p.campaign,p.authority,p.programId,p.launch.treasury,p.launch.reserve.payer].includes(f.feeNft))throw Error('Fee NFT must be an independent key');
  if(BigInt(p.launch.policy.softCapLamports)<BigInt(SOFT_FLOOR_LAMPORTS_V2))throw Error('Soft cap below the funding-first floor');
}
export function createMintIntent({preparation,creator,metadata,rentLamports,launch=null,fundingFirst=null}) {
  if(preparation?.programVersion!==3||preparation.state!=='reserved'||preparation.fundingEnabled!==false)throw Error('Reserved v3 preparation required');
  if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(preparation.requestId||'')||!/^[A-Za-z0-9_.:-]{1,128}$/.test(preparation.leaseId||''))throw Error('Invalid mint reservation identity');
  const intent={version:1,programVersion:3,requestId:preparation.requestId,leaseId:preparation.leaseId,
    genesisHash:key(preparation.genesisHash),programId:key(preparation.programId),creator:key(creator),
    nonce:preparation.nonce,campaign:key(preparation.campaign),authority:key(preparation.authority),mint:key(preparation.mint),
    decimals:6,supply:SUPPLY,rentLamports,metadata:{...metadata},...(launch?{version:2,launch:structuredClone(launch)}:{}),...(fundingFirst?{version:3,fundingFirst:structuredClone(fundingFirst)}:{})};
  validate(intent);
  Object.freeze(intent.metadata);return Object.freeze(intent);
}

function validate(p) {
  exact(p,['version','programVersion','requestId','leaseId','genesisHash','programId','creator','nonce','campaign','authority','mint','decimals','supply','rentLamports','metadata',...(p?.version>=2?['launch']:[]),...(p?.version===3?['fundingFirst']:[])]);
  if(![1,2,3].includes(p.version)||p.programVersion!==3||p.decimals!==6||p.supply!==SUPPLY)throw Error('Unsupported mint policy');
  for(const field of ['requestId','leaseId'])if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(p[field]||''))throw Error('Invalid mint reservation identity');
  for(const field of ['genesisHash','programId','creator','campaign','authority','mint'])if(key(p[field])!==p[field]||p[field]===PublicKey.default.toBase58())throw Error('Invalid '+field);
  integer(p.nonce,(1n<<64n)-1n,'nonce');integer(p.rentLamports,BigInt(Number.MAX_SAFE_INTEGER),'rent');
  if(BigInt(p.rentLamports)===0n)throw Error('Mint rent required');
  validateKidsMint(p.mint);
  if(new Set([p.creator,p.mint,p.programId,p.campaign,p.authority]).size!==5)throw Error('Independent kids mint required');
  if(campaignAddress(p.programId,p.creator,p.nonce).toBase58()!==p.campaign||launchAuthority(p.programId,p.campaign).toBase58()!==p.authority)throw Error('Mint custody differs from preparation');
  exact(p.metadata,['name','symbol','uri','documentHash']);
  text(p.metadata.name,32,'name');text(p.metadata.symbol,10,'symbol');text(p.metadata.uri,128,'metadata URI');
  if(/\s/.test(p.metadata.symbol)||!hash.test(p.metadata.documentHash||''))throw Error('Invalid immutable metadata');
  const uri=new URL(p.metadata.uri);
  if(uri.protocol!=='https:'||uri.username||uri.password||uri.hash||!uri.hostname.includes('.')||!/^[\x21-\x7e]+$/.test(p.metadata.uri))throw Error('Invalid immutable metadata URI');
  if(p.version>=2)validateLaunch(p.launch,p);
  if(p.version===3)validateFundingFirst(p.fundingFirst,p);
}
/** The provisioning intent a version-2 mint intent stands for, once the opening time is known (the chain's, for '0'). */
export function provisionIntentFromMint(intent,opensAt=null){
  validate(intent);if(intent.version<2)throw Error('Provisioning intent needs a one-transaction mint intent');
  const at=opensAt??intent.launch.opensAt;integer(at,(1n<<63n)-1n,'opening time');if(BigInt(at)<1n)throw Error('Opening time unknown until the creation is finalized');
  return {version:1,mint:structuredClone(intent),policy:structuredClone(intent.launch.policy),treasury:intent.launch.treasury,opensAt:String(BigInt(at)),authorityBudgetLamports:intent.launch.authorityBudgetLamports};
}
/** The fields of the compact creation instruction of a version-2 intent. */
export function launchCreateFields(intent){
  validate(intent);if(intent.version<2)throw Error('Compact creation needs a one-transaction mint intent');const l=intent.launch,p=l.policy;
  return {creator:intent.creator,genesisHash:intent.genesisHash,nonce:intent.nonce,childMint:intent.mint,opensAt:l.opensAt,fundingDurationSeconds:p.fundingDurationSeconds,launchWindowSeconds:p.launchWindowSeconds,softCapLamports:p.softCapLamports,hardCapLamports:p.hardCapLamports,ammConfigIndex:p.ammConfigIndex,metadataHash:intent.metadata.documentHash,metadataUri:intent.metadata.uri};
}
/** The 800 sealed bytes the program writes for a version-2 intent, given the opening time it used. */
export function expectedSealedTerms(intent,opensAt){
  const fields=launchCreateFields(intent);integer(opensAt,(1n<<63n)-1n,'opening time');if(BigInt(opensAt)<1n)throw Error('Opening time must be positive');
  if(fields.opensAt!=='0'&&fields.opensAt!==String(BigInt(opensAt)))throw Error('Opening time differs from the sealed schedule');
  const expanded=expandCompactBody(compactCreateBody(fields),{creator:intent.creator,now:String(BigInt(opensAt))});
  return Buffer.from(encodeTerms({...expanded,treasury:keyHex(intent.launch.treasury)}));
}
/** The fields of the funding-first opening instruction (tag 41) of a version-3 intent: the compact creation fields, the
 * display commitment sha256(borsh(name) || borsh(symbol) || borsh(uri)) and the reserved fee-NFT key. */
export function openFundingFields(intent){
  validate(intent);if(intent.version!==3)throw Error('Funding-first opening needs a version-3 mint intent');
  return {...launchCreateFields(intent),displayHash:displayHash({name:intent.metadata.name,symbol:intent.metadata.symbol,uri:intent.metadata.uri}),feeNft:intent.fundingFirst.feeNft};
}
/** Priority fee per compute unit derived from the plan's per-transaction cap over the default 1.4 million units. */
export const priorityMicroLamports=lamports=>Math.max(1,Math.floor(Number(lamports)*1000000/1400000));

export function mintIntentHash(intent){validate(intent);return canonicalHash(intent);}

/** Rebuild on the signer from trusted intent + journaled attempt, never from
 * instructions supplied by a browser. Only the creator and reserved mint sign. */
export function buildMintPacket(intent,block) {
  validate(intent);
  if(!Number.isSafeInteger(block?.lastValidBlockHeight)||block.lastValidBlockHeight<1||key(block.blockhash)!==block.blockhash)throw Error('Invalid mint attempt block');
  const creator=new PublicKey(intent.creator),mint=new PublicKey(intent.mint),authority=new PublicKey(intent.authority);
  const custody=associatedTokenAddress(authority,mint);
  const mintLeg=[
    SystemProgram.createAccount({fromPubkey:creator,newAccountPubkey:mint,lamports:Number(intent.rentLamports),space:82,programId:TOKEN_PROGRAM}),
    createInitializeMint2Instruction(mint,6,creator,null),
    createAssociatedTokenAccountIdempotentInstruction(creator,custody,authority,mint),
    createMintToInstruction(mint,custody,creator,BigInt(intent.supply)),
    createMetadataInstruction({mint,mintAuthority:creator,payer:creator,...intent.metadata}),
    createSetAuthorityInstruction(mint,creator,AuthorityType.MintTokens,null),
  ];
  // Version 3: one transaction opens the funding round. A priority fee, the tag-41 opening (creator, reserved mint and
  // reserved fee NFT sign; the program seals the terms, writes the extension and both reservations and takes the rounding
  // collateral), the setup budget for the launch authority and the operating reserve for the keeper. No token yet.
  // Version 2: one transaction. A priority fee, the mint leg, the program's SOL custody, the compact campaign creation,
  // the setup budget for the launch authority and the operating reserve for the keeper. Atomic: nothing lands alone.
  const instructions=intent.version===3?[
    ComputeBudgetProgram.setComputeUnitPrice({microLamports:priorityMicroLamports(intent.launch.priorityFeeLamports)}),
    openFundingInstruction(intent.programId,openFundingFields(intent)).instruction,
    SystemProgram.transfer({fromPubkey:creator,toPubkey:authority,lamports:BigInt(intent.launch.authorityBudgetLamports)}),
    SystemProgram.transfer({fromPubkey:creator,toPubkey:new PublicKey(intent.launch.reserve.payer),lamports:BigInt(intent.launch.reserve.lamports)}),
  ]:intent.version===2?[
    ComputeBudgetProgram.setComputeUnitPrice({microLamports:priorityMicroLamports(intent.launch.priorityFeeLamports)}),
    ...mintLeg,
    createAssociatedTokenAccountIdempotentInstruction(creator,associatedTokenAddress(authority,WSOL),authority,WSOL),
    compactCreateInstruction(intent.programId,launchCreateFields(intent)).instruction,
    SystemProgram.transfer({fromPubkey:creator,toPubkey:authority,lamports:BigInt(intent.launch.authorityBudgetLamports)}),
    SystemProgram.transfer({fromPubkey:creator,toPubkey:new PublicKey(intent.launch.reserve.payer),lamports:BigInt(intent.launch.reserve.lamports)}),
  ]:mintLeg;
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:creator,recentBlockhash:block.blockhash,instructions}).compileToV0Message());
  // Signers: the creator (payer) first, then the reserved mint, then (version 3) the reserved fee NFT; nothing else signs.
  const signers=mintPacketSigners(intent);
  if(tx.message.header.numRequiredSignatures!==signers.length||signers.some((k,i)=>!tx.message.staticAccountKeys[i].equals(new PublicKey(k)))||tx.serialize().length>1232)throw Error(intent.version>=2?'The creation transaction does not fit in one packet ('+tx.serialize().length+' bytes)':'Unsupported mint packet');
  return tx;
}

/** The signer order of a creation packet: creator, reserved mint and, for a funding-first opening, the reserved fee NFT. */
export function mintPacketSigners(intent){return intent.version===3?[intent.creator,intent.mint,intent.fundingFirst.feeNft]:[intent.creator,intent.mint];}
/** Exact message and valid creator approval; the reserved mint (and, for version 3, the reserved fee NFT) must still be
 * unsigned at this boundary. No wallet-added transfer or authority is accepted. */
export function verifyMintApproval(intent,block,encoded) {
  if(typeof encoded!=='string'||encoded.length>1644||!encoded.length)throw Error('Invalid mint approval encoding');
  const bytes=Buffer.from(encoded,'base64');
  if(bytes.toString('base64')!==encoded||bytes.length>1232)throw Error('Invalid mint approval encoding');
  const tx=VersionedTransaction.deserialize(bytes),expected=buildMintPacket(intent,block),signers=mintPacketSigners(intent);
  if(tx.version!==0||!Buffer.from(tx.serialize()).equals(bytes)||!Buffer.from(tx.message.serialize()).equals(Buffer.from(expected.message.serialize()))||tx.signatures.length!==signers.length)throw Error('Wallet changed the approved mint transaction');
  if(!verifySignature(intent.creator,tx.message.serialize(),tx.signatures[0])||tx.signatures.slice(1).some(s=>s.some(x=>x!==0)))throw Error('Invalid creator-first mint approval');
  // A version-3 approval also names what the custody's opening signer verifies against its own reservation.
  return {intentHash:mintIntentHash(intent),message:expected.message.serialize(),packet:encoded,creator:intent.creator,mint:intent.mint,lookupTables:[],...(intent.version===3?{feeNft:intent.fundingFirst.feeNft,genesisHash:intent.genesisHash,programId:intent.programId,campaign:intent.campaign,requestId:intent.requestId}:{})};
}
