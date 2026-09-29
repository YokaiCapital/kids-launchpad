// Finalized creation evidence, before campaign provisioning can move the supply.
// A signature alone does not prove the expected mint, custody or metadata exists.
import {PublicKey} from '@solana/web3.js';
import {unpackMint,unpackAccount} from '@solana/spl-token';
import {associatedTokenAddress,TOKEN_PROGRAM,WSOL,decodeCampaign} from '../protocol-v2/client.mjs';
import {termsHash} from '../protocol-v2/policy.mjs';
import {SystemProgram} from '@solana/web3.js';
import {metadataAddress,METADATA_PROGRAM} from '../token-metadata.mjs';
import {mintIntentHash,expectedSealedTerms} from './mint-packet.mjs';
import {extAddress,mintReservationAddress,nftReservationAddress,decodeExt,decodeReservation,displayHash,OFF_ACCOUNTING_VERSION,ACCOUNTING_VERSION_FUNDING_FIRST} from '../protocol-v3/client.mjs';

export function mintResultAddresses(intent){
 mintIntentHash(intent);
 if(intent.version===3){
  // Funding-first opening: the record, the extension, both reservations and the funded launch authority exist; the
  // reserved mint and fee-NFT addresses must still be plain system addresses (no token exists until the launch).
  const campaign=new PublicKey(intent.campaign),mint=new PublicKey(intent.mint),feeNft=new PublicKey(intent.fundingFirst.feeNft);
  return [campaign,extAddress(intent.programId,campaign),mintReservationAddress(intent.programId,mint),nftReservationAddress(intent.programId,feeNft),new PublicKey(intent.authority),mint,feeNft];
 }
 const base=[new PublicKey(intent.mint),associatedTokenAddress(intent.authority,intent.mint),metadataAddress(intent.mint)];
 // Version 2 (one creation transaction): the campaign, the program's SOL custody and the funded launch authority too.
 return intent.version===2?[...base,new PublicKey(intent.campaign),associatedTokenAddress(intent.authority,WSOL),new PublicKey(intent.authority)]:base;
}

const OPENING_COMMITMENTS=4;
/** Finalized funding-first opening evidence: the immutable commitments only. The version-2 record holds exactly the sealed
 * terms (and its accounting marker), the extension names this campaign, terms hash, mint, fee NFT and display commitment,
 * and both reservations name this campaign and key. The current phase, the extension's sealed totals, the reserved
 * addresses (a token once launched) and the authority's balance are lifecycle state read elsewhere: a delayed recovery
 * after the round closed, refunded or launched must still recognise its own opening and never ask for another one. */
function verifyOpeningResult(intent,response,{minSlot}){
 const addresses=mintResultAddresses(intent),bad=()=>{throw Object.assign(Error('Finalized opening accounts differ from the approved creation'),{code:'MINT_RESULT_MISMATCH'});};
 if(!Number.isSafeInteger(minSlot)||minSlot<0||!Number.isSafeInteger(response?.context?.slot)||response.context.slot<minSlot||!Array.isArray(response.value)||response.value.length!==addresses.length||response.value.slice(0,OPENING_COMMITMENTS).some(a=>!a))throw Object.assign(Error('Finalized opening evidence is not available yet'),{code:'MINT_RESULT_UNAVAILABLE'});
 const [campaign,ext,mintRes,nftRes]=response.value,program=new PublicKey(intent.programId);
 if([campaign,ext,mintRes,nftRes].some(a=>a.executable||!a.owner.equals(program)))bad();
 const record=Buffer.from(campaign.data);let c;try{c=decodeCampaign(record);}catch{bad();}
 if(record.length!==1024||record[OFF_ACCOUNTING_VERSION]!==ACCOUNTING_VERSION_FUNDING_FIRST)bad();
 const opensAt=String(c.terms.opensAt);if(!/^[1-9][0-9]*$/.test(opensAt)||(intent.launch.opensAt!=='0'&&opensAt!==intent.launch.opensAt))bad();
 let expected;try{expected=expectedSealedTerms(intent,opensAt);}catch{bad();}
 if(!record.subarray(8,808).equals(expected)||c.state.termsHash!==termsHash(expected).toString('hex'))bad();
 let e;try{e=decodeExt(ext.data);}catch{bad();}
 const display=displayHash({name:intent.metadata.name,symbol:intent.metadata.symbol,uri:intent.metadata.uri});
 if(e.campaign!==intent.campaign||e.termsHash!==c.state.termsHash||e.mint!==intent.mint||e.feeNft!==intent.fundingFirst.feeNft||e.displayHash!==display||e.version!==ACCOUNTING_VERSION_FUNDING_FIRST)bad();
 let mr,nr;try{mr=decodeReservation(mintRes.data);nr=decodeReservation(nftRes.data);}catch{bad();}
 if(mr.campaign!==intent.campaign||mr.key!==intent.mint||nr.campaign!==intent.campaign||nr.key!==intent.fundingFirst.feeNft)bad();
 return {version:1,intentHash:mintIntentHash(intent),slot:response.context.slot,mint:intent.mint,tokenCreated:false,accountingVersion:ACCOUNTING_VERSION_FUNDING_FIRST,feeNft:intent.fundingFirst.feeNft,extension:addresses[1].toBase58(),mintReservation:addresses[2].toBase58(),feeNftReservation:addresses[3].toBase58(),displayHash:display,observedPhase:c.state.phase,
  campaign:intent.campaign,termsHash:c.state.termsHash,opensAt,deadline:String(c.terms.deadline),launchDeadline:String(c.terms.launchDeadline),sealedTermsBase64:expected.toString('base64'),authority:intent.authority,authoritySetupLamports:intent.launch.authorityBudgetLamports,reserve:{payer:intent.launch.reserve.payer,lamports:intent.launch.reserve.lamports}};
}

export function verifyMintResult(intent,response,{minSlot}){
 if(intent.version===3)return verifyOpeningResult(intent,response,{minSlot});
 const addresses=mintResultAddresses(intent),bad=()=>{throw Object.assign(Error('Finalized mint accounts differ from the approved creation'),{code:'MINT_RESULT_MISMATCH'});};
 if(!Number.isSafeInteger(minSlot)||minSlot<0||!Number.isSafeInteger(response?.context?.slot)||response.context.slot<minSlot||!Array.isArray(response.value)||response.value.length!==addresses.length||response.value.some(a=>!a))throw Object.assign(Error('Finalized mint evidence is not available yet'),{code:'MINT_RESULT_UNAVAILABLE'});
 const [mi,ci,md]=response.value;
 // Classic SPL only: extensions, token taxes and delegate/close rights were not approved.
 if(mi.executable||ci.executable||md.executable||mi.data.length!==82||ci.data.length!==165||!mi.owner.equals(TOKEN_PROGRAM)||!ci.owner.equals(TOKEN_PROGRAM)||!md.owner.equals(METADATA_PROGRAM))bad();
 const mint=unpackMint(addresses[0],mi,TOKEN_PROGRAM),custody=unpackAccount(addresses[1],ci,TOKEN_PROGRAM);
 if(!mint.isInitialized||mint.decimals!==intent.decimals||mint.supply!==BigInt(intent.supply)||mint.mintAuthority!==null||mint.freezeAuthority!==null||!custody.isInitialized||custody.isFrozen||custody.isNative||!custody.mint.equals(addresses[0])||!custody.owner.equals(new PublicKey(intent.authority))||custody.amount!==BigInt(intent.supply)||custody.delegate!==null||custody.delegatedAmount!==0n||custody.closeAuthority!==null)bad();
 const data=Buffer.from(md.data);let at=0;
 const take=n=>{if(at+n>data.length)bad();const b=data.subarray(at,at+n);at+=n;return b;};
 const byte=()=>take(1)[0];
 const string=max=>{const n=take(4).readUInt32LE();if(n>max)bad();const bytes=take(n),s=bytes.toString('utf8');if(!Buffer.from(s).equals(bytes))bad();return s.replace(/\0+$/,'');};
 if(byte()!==4||!new PublicKey(take(32)).equals(new PublicKey(intent.creator))||!new PublicKey(take(32)).equals(addresses[0]))bad();
 if(string(32)!==intent.metadata.name||string(10)!==intent.metadata.symbol||string(200)!==intent.metadata.uri||take(2).readUInt16LE()!==0||byte()!==0||byte()!==0||byte()!==0)bad();
 // Above: no creators, primary sale false, immutable. Remaining optional fields
 // are Metaplex's canonical defaults and cannot grant mutation of this metadata.
 const evidence={version:1,intentHash:mintIntentHash(intent),slot:response.context.slot,mint:intent.mint,custody:addresses[1].toBase58(),metadata:addresses[2].toBase58(),supply:intent.supply,decimals:intent.decimals,mintAuthority:null,freezeAuthority:null,immutableMetadata:true};
 if(intent.version!==2)return evidence;
 // One creation transaction: the campaign holds exactly the sealed terms the compact body expands to (with the chain's
 // opening time when the schedule said 'at creation'), the SOL custody exists, and the launch authority holds the budget.
 const [campaign,native,authority]=response.value.slice(3);
 if(campaign.executable||!campaign.owner.equals(new PublicKey(intent.programId))||native.executable||authority.executable)bad();
 let c;try{c=decodeCampaign(Buffer.from(campaign.data));}catch{bad();}
 const opensAt=String(c.terms.opensAt);if(!/^[1-9][0-9]*$/.test(opensAt)||(intent.launch.opensAt!=='0'&&opensAt!==intent.launch.opensAt))bad();
 const expected=expectedSealedTerms(intent,opensAt);
 if(!Buffer.from(campaign.data).subarray(8,808).equals(expected)||c.state.termsHash!==termsHash(expected).toString('hex')||c.state.phase!==0||c.state.flags!==0||c.state.launchTime!==0n)bad();
 if(!native.owner.equals(TOKEN_PROGRAM)||native.data.length!==165)bad();
 const wsol=unpackAccount(addresses[4],native,TOKEN_PROGRAM);
 if(!wsol.isInitialized||!wsol.isNative||!wsol.mint.equals(WSOL)||!wsol.owner.equals(new PublicKey(intent.authority)))bad();
 if(!authority.owner.equals(SystemProgram.programId)||authority.data.length!==0||!Number.isSafeInteger(authority.lamports)||BigInt(authority.lamports)<BigInt(intent.launch.authorityBudgetLamports))bad();
 return {...evidence,campaign:intent.campaign,termsHash:c.state.termsHash,opensAt,deadline:String(c.terms.deadline),launchDeadline:String(c.terms.launchDeadline),sealedTermsBase64:expected.toString('base64'),authority:intent.authority,authoritySetupLamports:intent.launch.authorityBudgetLamports,nativeCustody:addresses[4].toBase58(),reserve:{payer:intent.launch.reserve.payer,lamports:intent.launch.reserve.lamports}};
}
