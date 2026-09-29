// A finalized signature is not enough: verify canonical accounts and sealed terms
// before admitting a creator campaign to discovery or financial worker scheduling.
import {PublicKey,SystemProgram} from '@solana/web3.js';
import {unpackAccount} from '@solana/spl-token';
import {associatedTokenAddress,WSOL,TOKEN_PROGRAM,decodeCampaign,createInstruction} from '../protocol-v2/client.mjs';
import {mintResultAddresses,verifyMintResult} from './mint-result.mjs';
import {provisionIntentHash,provisionTerms,provisionTermsHash} from './provision-packet.mjs';
const bad=()=>{throw Object.assign(Error('Provisioned accounts differ from the approved launch'),{code:'PROVISION_RESULT_MISMATCH'});};
const pending=()=>{throw Object.assign(Error('Finalized setup evidence is not available yet'),{code:'PROVISION_RESULT_UNAVAILABLE'});};
export function nativeCustodyAddress(mint){return associatedTokenAddress(mint.authority,WSOL);}
export function verifyNativeCustody(mint,account){
 if(!account)pending();
 if(account.executable||!account.owner.equals(TOKEN_PROGRAM)||account.data.length!==165)bad();
 const a=unpackAccount(nativeCustodyAddress(mint),account,TOKEN_PROGRAM);
 if(!a.isInitialized||a.isFrozen||!a.isNative||!a.mint.equals(WSOL)||!a.owner.equals(new PublicKey(mint.authority))||a.delegate!==null||a.delegatedAmount!==0n||a.closeAuthority!==null)bad();
 // Anyone can donate SOL to this canonical account. A donation is not creator
 // funding or a participant commitment, and is never counted as such here.
 return {address:a.address.toBase58(),amount:String(a.amount)};
}
export function provisionResultAddresses(intent){provisionIntentHash(intent);return [new PublicKey(intent.mint.campaign),new PublicKey(intent.mint.authority),nativeCustodyAddress(intent.mint),...mintResultAddresses(intent.mint)];}
export function verifyProvisionResult(intent,response,{minSlot,campaignRentLamports}){
 provisionIntentHash(intent);
 if(!Number.isSafeInteger(minSlot)||minSlot<0||!Number.isSafeInteger(response?.context?.slot)||response.context.slot<minSlot||!Array.isArray(response.value)||response.value.length!==6||response.value.some(x=>!x))pending();
 if(typeof campaignRentLamports!=='string'||!/^[1-9][0-9]*$/.test(campaignRentLamports))throw Error('Campaign rent evidence required');
 const [campaign,authority,native,...mintAccounts]=response.value;
 if(campaign.executable||!campaign.owner.equals(new PublicKey(intent.mint.programId)))bad();
 let c;try{c=decodeCampaign(campaign.data);}catch{bad();}
 const expected=createInstruction(intent.mint.programId,provisionTerms(intent));
 if(c.state.termsHash!==provisionTermsHash(intent)||!Buffer.from(campaign.data).subarray(8,808).equals(expected.sealed)||c.state.phase!==0||c.state.flags!==0||c.state.launchTime!==0n)bad();
 // Commitments can arrive directly before API discovery. Account for them rather
 // than assuming a newly observed campaign has zero balance or zero receipts.
 if(!Number.isSafeInteger(campaign.lamports)||BigInt(campaign.lamports)<BigInt(campaignRentLamports)+c.state.total||c.state.refunded!==0n||c.state.settledCount!==0n||c.state.settledAccepted!==0n||c.state.participantClaimed!==0n||c.state.devClaimed!==0n||c.state.parentClaimed.some(n=>n!==0n)||c.state.pool.toBase58()!==PublicKey.default.toBase58()||c.state.feeNft.toBase58()!==PublicKey.default.toBase58())bad();
 if(authority.executable||!authority.owner.equals(SystemProgram.programId)||authority.data.length!==0||!Number.isSafeInteger(authority.lamports)||BigInt(authority.lamports)<BigInt(intent.authorityBudgetLamports))bad();
 const custody=verifyNativeCustody(intent.mint,native);
 const mint=verifyMintResult(intent.mint,{context:response.context,value:mintAccounts},{minSlot});
 return {version:1,intentHash:provisionIntentHash(intent),termsHash:c.state.termsHash,slot:response.context.slot,campaign:intent.mint.campaign,authority:intent.mint.authority,authoritySetupLamports:intent.authorityBudgetLamports,nativeCustody:custody.address,mintEvidence:mint};
}
