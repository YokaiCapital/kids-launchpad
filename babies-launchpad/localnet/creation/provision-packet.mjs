// Creator-owned setup packets for the isolated Standard v3 pilot. These builders
// never broadcast, choose wallets, alter old terms, or authorize operating spend.
import {PublicKey,SystemProgram,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {createAssociatedTokenAccountIdempotentInstruction} from '@solana/spl-token';
import {createInstruction,associatedTokenAddress,WSOL,RAYDIUM_CPMM,RAYDIUM_LOCK,AMM_CONFIG_TIERS} from '../protocol-v2/client.mjs';
import {SPLIT_STANDARD_V3,SPLIT_POLICY_STANDARD_V3,FEE_WEIGHTS_STANDARD,VESTING_STANDARD_V3,VESTING_RULE_STANDARD_V3} from '../protocol-v2/policy.mjs';
import {mintIntentHash} from './mint-packet.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {verifySignature,encodeBase58} from '../../shared/solana.mjs';
const zero=PublicKey.default.toBase58(),hash=/^[a-f0-9]{64}$/;
const exact=(x,keys)=>{if(!x||Object.keys(x).sort().join(',')!==keys.slice().sort().join(','))throw Error('Unexpected provisioning fields');};
const uint=(value,name)=>{if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(value)||BigInt(value)>(1n<<64n)-1n)throw Error('Invalid '+name);return BigInt(value);};
const positive=(value,name)=>{const n=uint(value,name);if(!n)throw Error('Missing '+name);return n;};
const same=(a,b)=>canonicalHash(a)===canonicalHash(b);

export function createProvisionIntent({mint,policy,treasury,opensAt,authorityBudgetLamports}){
 const intent={version:1,mint:structuredClone(mint),policy:structuredClone(policy),treasury,opensAt,authorityBudgetLamports};
 validate(intent);return intent;
}
function validate(p){
 exact(p,['version','mint','policy','treasury','opensAt','authorityBudgetLamports',...(p.version===2?['generation']:[])]);
 if(p.version===2&&(!Number.isSafeInteger(p.generation)||p.generation<2))throw Error('Invalid setup generation');
 if(![1,2].includes(p.version))throw Error('Unsupported provisioning version');mintIntentHash(p.mint);
 const q=p.policy;
 exact(q,['policyHash','planHash','softCapLamports','hardCapLamports','fundingDurationSeconds','launchWindowSeconds','ammConfig','ammConfigIndex','tradeFeeBps']);
 if(!hash.test(q.policyHash)||!hash.test(q.planHash))throw Error('Provisioning policy identity missing');
 const soft=positive(q.softCapLamports,'soft cap'),hard=positive(q.hardCapLamports,'hard cap');
 if(soft>hard)throw Error('Soft cap exceeds hard cap');
 for(const field of ['fundingDurationSeconds','launchWindowSeconds'])if(!Number.isSafeInteger(q[field])||q[field]<60||q[field]>604800)throw Error('Invalid provisioning duration');
 const tier=AMM_CONFIG_TIERS.find(t=>t.index===q.ammConfigIndex);
 if(!Number.isInteger(q.tradeFeeBps)||q.tradeFeeBps<1||!tier||tier.address.toBase58()!==q.ammConfig||BigInt(q.tradeFeeBps)*100n!==tier.tradeFeeRate)throw Error('Unsupported provisioning AMM policy');
 if(new PublicKey(p.treasury).toBase58()!==p.treasury||p.treasury===zero||[p.mint.campaign,p.mint.authority,p.mint.mint,p.mint.programId].includes(p.treasury))throw Error('Invalid sealed treasury');
 const start=positive(p.opensAt,'opening time');
 if(start+BigInt(q.fundingDurationSeconds+q.launchWindowSeconds)>(1n<<63n)-1n)throw Error('Provisioning time overflow');
 positive(p.authorityBudgetLamports,'authority setup budget');
}
export function provisionIntentHash(intent){validate(intent);return canonicalHash(intent);}
export function provisionTerms(intent){
 validate(intent);const {mint:m,policy:p}=intent,deadline=BigInt(intent.opensAt)+BigInt(p.fundingDurationSeconds);
 // Version-3 Standard economics (owner, 27 September 2026): split policy 3, vesting rule 2; the issuer refuses anything else.
 return {layoutVersion:2,mode:0,decimals:m.decimals,splitPolicy:SPLIT_POLICY_STANDARD_V3,vestingRule:VESTING_RULE_STANDARD_V3,feeRoutingVersion:1,creatorFeeEnabled:0,
  genesis:m.genesisHash,creator:m.creator,nonce:m.nonce,dev:m.creator,treasury:intent.treasury,childMint:m.mint,supply:m.supply,
  opensAt:intent.opensAt,deadline:String(deadline),launchDeadline:String(deadline+BigInt(p.launchWindowSeconds)),soft:p.softCapLamports,hard:p.hardCapLamports,
  ammProgram:RAYDIUM_CPMM,ammConfig:p.ammConfig,ammConfigIndex:p.ammConfigIndex,ammTradeFeeRate:BigInt(p.tradeFeeBps)*100n,
  feeWeights:FEE_WEIGHTS_STANDARD,splitBps:SPLIT_STANDARD_V3,vesting:VESTING_STANDARD_V3,buybackMaxSlippageBps:0,
  lockProgram:RAYDIUM_LOCK,distributionProgram:zero,parentMint:[zero,zero],parentProgram:[zero,zero],parentSlot:[0,0],parentRoot:['00'.repeat(32),'00'.repeat(32)],parentSupply:[0,0],parentEligible:[0,0],parentExpirySeconds:0,parentReferenceConfig:[0,0],
  metadataHash:m.metadata.documentHash,metadataUri:m.metadata.uri};
}
export function provisionTermsHash(intent){return createInstruction(intent.mint.programId,provisionTerms(intent)).hash.toString('hex');}
/** Prepare the empty native custody separately. Including it in create+fund is
 * 1260 bytes; create+fund itself is 1122 bytes, below the 1232-byte wire limit.
 * A duplicate create fails atomically, so the funding transfer cannot repeat. */
export function buildProvisionPacket(intent,stage,block){
 validate(intent);
 if(!['native-custody','create-campaign'].includes(stage))throw Error('Unknown provisioning stage');
 if(!Number.isSafeInteger(block?.lastValidBlockHeight)||block.lastValidBlockHeight<1||new PublicKey(block.blockhash).toBase58()!==block.blockhash)throw Error('Invalid provisioning block');
 const m=intent.mint,creator=new PublicKey(m.creator),authority=new PublicKey(m.authority);
 const instructions=stage==='native-custody'?
  [createAssociatedTokenAccountIdempotentInstruction(creator,associatedTokenAddress(authority,WSOL),authority,WSOL)]:
  [createInstruction(m.programId,provisionTerms(intent)).instruction,SystemProgram.transfer({fromPubkey:creator,toPubkey:authority,lamports:BigInt(intent.authorityBudgetLamports)})];
 const tx=new VersionedTransaction(new TransactionMessage({payerKey:creator,recentBlockhash:block.blockhash,instructions}).compileToV0Message());
 if(tx.message.header.numRequiredSignatures!==1||!tx.message.staticAccountKeys[0].equals(creator)||tx.serialize().length>1232)throw Error('Unsupported provisioning packet');
 return tx;
}
export function verifyProvisionApproval(intent,stage,block,encoded){
 if(typeof encoded!=='string'||!encoded.length||encoded.length>1644)throw Error('Invalid provisioning approval');
 const bytes=Buffer.from(encoded,'base64');if(bytes.toString('base64')!==encoded||bytes.length>1232)throw Error('Invalid provisioning approval');
 const tx=VersionedTransaction.deserialize(bytes),expected=buildProvisionPacket(intent,stage,block),message=expected.message.serialize();
 if(tx.version!==0||!Buffer.from(tx.serialize()).equals(bytes)||!Buffer.from(tx.message.serialize()).equals(Buffer.from(message))||tx.signatures.length!==1||!verifySignature(intent.mint.creator,message,tx.signatures[0]))throw Error('Wallet changed the approved provisioning transaction');
 return {intentHash:provisionIntentHash(intent),stage,signature:encodeBase58(tx.signatures[0]),transactionBase64:encoded};
}
/** Map only the reviewed Standard policy. Never carry unrecognized future LP/MM
 * mechanics through the legacy terms encoder where they would be silently lost. */
export function reviewedProvisionPolicy(quote){
 const q=quote?.terms;
 exact(q,['policyVersion','mode','parents','supplySplitBps','solFeeRouting','softCapLamports','hardCapLamports','fundingDurationSeconds','launchWindowSeconds','feePolicy','devVesting','tokenSideFees','platformCreationChargeLamports','operating']);
 if(q.mode!=='standard'||q.parents!==0||!same(q.supplySplitBps,{participants:4750,liquidity:4750,dev:500})||!same(q.solFeeRouting,{denominator:168,treasury:148,dev:20})||!same(q.devVesting,{immediateBps:150,linearBps:350,vestingMonths:3})||q.tokenSideFees!=='burn'||q.platformCreationChargeLamports!=='0')throw Error('Unsupported reviewed provisioning economics');
 // The operating reserve (option 1) is reviewed with the quote but is not a sealed on-chain term: it is funded by a
 // separate creator approval after registration. Only the sealed numbers of 27 September 2026 are accepted here.
 if(q.operating!==null&&!same(q.operating,{reserveLamports:'100000000',floorLamports:'20000000',refillBps:1000,returnUnusedOnRefund:true}))throw Error('Unsupported reviewed operating reserve');
 exact(q.feePolicy,['ammProgram','ammConfig','ammConfigIndex','tradeFeeBps','creatorFeeEnabled']);
 if(q.feePolicy.ammProgram!==RAYDIUM_CPMM.toBase58()||q.feePolicy.creatorFeeEnabled!==false)throw Error('Unsupported reviewed fee policy');
 return {policyHash:quote.policyHash,planHash:quote.planHash,softCapLamports:q.softCapLamports,hardCapLamports:q.hardCapLamports,fundingDurationSeconds:q.fundingDurationSeconds,launchWindowSeconds:q.launchWindowSeconds,ammConfig:q.feePolicy.ammConfig,ammConfigIndex:q.feePolicy.ammConfigIndex,tradeFeeBps:q.feePolicy.tradeFeeBps};
}
