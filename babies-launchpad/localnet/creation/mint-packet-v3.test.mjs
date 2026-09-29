// Version-3 creation packet (funding-first accounting, 29 September 2026): one creator transaction opens the funding round
// with the reserved mint and fee-NFT keys co-signing, funds the setup budget and the operating reserve, creates no token;
// the finalized opening evidence proves the record, the extension, both reservations and the funded authority.
import test from 'node:test';import assert from 'node:assert/strict';
import {Keypair,PublicKey,SystemProgram,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {createMintIntent,buildMintPacket,verifyMintApproval,mintIntentHash,expectedSealedTerms,openFundingFields,mintPacketSigners,provisionIntentFromMint} from './mint-packet.mjs';
import {mintResultAddresses,verifyMintResult} from './mint-result.mjs';
import {reviewedProvisionPolicy,provisionTerms,createProvisionIntent} from './provision-packet.mjs';
import {provisionFixture} from '../test/helpers/provision-fixture.mjs';
import {CREATE_V3_URI_PREFIX,OPEN_FUNDING_TAG,openFundingBody,displayHash,extAddress,mintReservationAddress,nftReservationAddress,EXT_LEN,RESERVATION_LEN,OFF_ACCOUNTING_VERSION,ACCOUNTING_VERSION_FUNDING_FIRST,SOFT_FLOOR_LAMPORTS_V2} from '../protocol-v3/client.mjs';
import {campaignAddress,launchAuthority,createInstruction,CAMPAIGN_MAGIC,TOKEN_PROGRAM} from '../protocol-v2/client.mjs';
import {CAMPAIGN_LEN,termsHash} from '../protocol-v2/policy.mjs';
const cid='QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco',key=()=>Keypair.generate().publicKey.toBase58(),mint='7e2g1HXJQPCMLED6PQZhHwzYw9iGemwPuUc5FAFMkids';
function fixture({name='Funding first',symbol='FIRST',uri=CREATE_V3_URI_PREFIX+cid,opensAt='0'}={}){
 const {quote}=provisionFixture(),owner=Keypair.generate(),programId=key(),nonce='123',campaign=campaignAddress(programId,owner.publicKey,nonce).toBase58(),feeNft=key(),treasury=key(),payer=key();
 const preparation={programVersion:3,state:'reserved',fundingEnabled:false,requestId:'request-3',leaseId:'lease-3',genesisHash:key(),programId,nonce,campaign,authority:launchAuthority(programId,campaign).toBase58(),mint};
 const policy={...reviewedProvisionPolicy(quote)};if(BigInt(policy.softCapLamports)<BigInt(SOFT_FLOOR_LAMPORTS_V2)){policy.softCapLamports=SOFT_FLOOR_LAMPORTS_V2;if(BigInt(policy.hardCapLamports)<BigInt(policy.softCapLamports))policy.hardCapLamports=policy.softCapLamports;}
 const launch={policy,treasury,opensAt,authorityBudgetLamports:'300000000',reserve:{payer,lamports:'100000000'},priorityFeeLamports:'10000'};
 const metadata={name,symbol,uri,documentHash:'ab'.repeat(32)};
 const make=(over={})=>createMintIntent({preparation,creator:owner.publicKey.toBase58(),rentLamports:'1461600',metadata,launch,fundingFirst:{feeNft},...over});
 return {owner,programId,campaign,feeNft,treasury,payer,preparation,launch,metadata,policy,make,block:{blockhash:key(),lastValidBlockHeight:150}};
}
const evidenceFor=(intent,opensAt,over={})=>{
 const expected=expectedSealedTerms(intent,opensAt),campaign=new PublicKey(intent.campaign),program=new PublicKey(intent.programId);
 const record=Buffer.alloc(CAMPAIGN_LEN);CAMPAIGN_MAGIC.copy(record);expected.copy(record,8);termsHash(expected).copy(record,808);record[OFF_ACCOUNTING_VERSION]=ACCOUNTING_VERSION_FUNDING_FIRST;
 const ext=Buffer.alloc(EXT_LEN);Buffer.from('KIDSEXT2').copy(ext);campaign.toBuffer().copy(ext,8);termsHash(expected).copy(ext,40);new PublicKey(intent.mint).toBuffer().copy(ext,72);new PublicKey(intent.fundingFirst.feeNft).toBuffer().copy(ext,104);Buffer.from(displayHash({name:intent.metadata.name,symbol:intent.metadata.symbol,uri:intent.metadata.uri}),'hex').copy(ext,136);ext[168]=ACCOUNTING_VERSION_FUNDING_FIRST;
 const reservation=k=>{const b=Buffer.alloc(RESERVATION_LEN);Buffer.from('KIDSRSV2').copy(b);campaign.toBuffer().copy(b,8);new PublicKey(k).toBuffer().copy(b,40);return b;};
 const owned=data=>({owner:program,executable:false,lamports:1000000,data});
 const value=[owned(record),owned(ext),owned(reservation(intent.mint)),owned(reservation(intent.fundingFirst.feeNft)),{owner:SystemProgram.programId,executable:false,lamports:300000000,data:Buffer.alloc(0)},null,null];
 return {record,ext,expected,response:{context:{slot:10},value:Object.assign(value,over)}};
};
test('the funding-first opening packet: four instructions, three signers (creator, mint, fee NFT), the tag-41 body, the setup budget and the reserve; fits at the longest branding',()=>{
 const f=fixture(),intent=f.make(),tx=buildMintPacket(intent,f.block),bytes=tx.serialize();
 assert.equal(intent.version,3);assert.deepEqual(mintPacketSigners(intent),[intent.creator,intent.mint,f.feeNft]);
 assert.equal(tx.message.header.numRequiredSignatures,3);assert.equal(tx.message.compiledInstructions.length,4);assert.ok(bytes.length<=1232,'packet is '+bytes.length+' bytes');
 assert.deepEqual(tx.message.staticAccountKeys.slice(0,3).map(String),[intent.creator,intent.mint,f.feeNft],'the creator pays and signs first, then the reserved mint, then the reserved fee NFT');
 const ix=tx.message.compiledInstructions,keys=tx.message.staticAccountKeys;
 assert.equal(String(keys[ix[1].programIdIndex]),intent.programId);assert.equal(ix[1].data[0],OPEN_FUNDING_TAG);
 const body=Buffer.from(ix[1].data.subarray(1)),fields=openFundingFields(intent);
 assert.deepEqual(body,openFundingBody(fields));assert.equal(new PublicKey(body.subarray(-32)).toBase58(),f.feeNft);assert.equal(body.subarray(-64,-32).toString('hex'),displayHash({name:intent.metadata.name,symbol:intent.metadata.symbol,uri:intent.metadata.uri}));
 assert.equal(fields.childMint,intent.mint);assert.equal(fields.metadataUri,intent.metadata.uri);
 const decoded=TransactionMessage.decompile(tx.message).instructions;
 assert.equal(decoded.length,4);assert.ok(decoded[2].programId.equals(SystemProgram.programId)&&decoded[2].keys[1].pubkey.toBase58()===intent.authority&&Buffer.from(decoded[2].data).readBigUInt64LE(4)===300000000n,'the setup budget goes to the launch authority');
 assert.ok(decoded[3].programId.equals(SystemProgram.programId)&&decoded[3].keys[1].pubkey.toBase58()===f.payer&&Buffer.from(decoded[3].data).readBigUInt64LE(4)===100000000n,'the operating reserve goes to the keeper payer');
 assert.ok(!decoded.some(i=>i.programId.equals(TOKEN_PROGRAM)),'no token instruction: the token does not exist until the launch');
 const big=fixture({name:'A'.repeat(32),symbol:'B'.repeat(10),uri:CREATE_V3_URI_PREFIX+'z'.repeat(64)}).make();
 const bigTx=buildMintPacket(big,f.block);assert.ok(bigTx.serialize().length<=1232,'longest branding fits: '+bigTx.serialize().length+' bytes');
 assert.equal(mintIntentHash(JSON.parse(JSON.stringify(intent))),mintIntentHash(intent));
});
test('approval: the creator signs first with both custody slots empty; wallet changes, custody pre-signing and a two-signer packet are refused',()=>{
 const f=fixture(),intent=f.make(),tx=buildMintPacket(intent,f.block),encoded=()=>Buffer.from(tx.serialize()).toString('base64');
 assert.throws(()=>verifyMintApproval(intent,f.block,encoded()),/creator-first/);
 tx.sign([f.owner]);const approval=verifyMintApproval(intent,f.block,encoded());
 assert.equal(approval.intentHash,mintIntentHash(intent));assert.equal(approval.feeNft,f.feeNft);assert.equal(approval.campaign,intent.campaign);assert.equal(approval.requestId,'request-3');assert.equal(approval.genesisHash,intent.genesisHash);assert.equal(approval.programId,intent.programId);assert.deepEqual(approval.lookupTables,[]);
 for(const slot of [1,2]){tx.signatures[slot][0]=1;assert.throws(()=>verifyMintApproval(intent,f.block,encoded()),/creator-first/,'custody slot '+slot+' must be empty');tx.signatures[slot][0]=0;}
 tx.signatures[0][0]^=1;assert.throws(()=>verifyMintApproval(intent,f.block,encoded()),/creator-first/);tx.signatures[0][0]^=1;
 const message=TransactionMessage.decompile(tx.message);message.instructions.push(SystemProgram.transfer({fromPubkey:f.owner.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1}));
 const changed=new VersionedTransaction(message.compileToV0Message());changed.sign([f.owner]);assert.throws(()=>verifyMintApproval(intent,f.block,Buffer.from(changed.serialize()).toString('base64')),/changed/);
 const two=Buffer.concat([Buffer.from([2]),Buffer.from(tx.signatures[0]),Buffer.from(tx.signatures[1]),Buffer.from(tx.message.serialize())]).toString('base64');assert.throws(()=>verifyMintApproval(intent,f.block,two),'a packet with two signature slots is not the opening packet');
 const v2=f.make({fundingFirst:null});assert.equal(v2.version,2);assert.throws(()=>verifyMintApproval(v2,f.block,encoded()),/changed/,'a version-2 intent never accepts the opening packet');
});
test('validation: the fee NFT is an independent key, the soft cap reaches the funding-first floor, funding first needs the one-transaction launch',()=>{
 const f=fixture();
 assert.throws(()=>f.make({fundingFirst:{feeNft:mint}}),/independent/);assert.throws(()=>f.make({fundingFirst:{feeNft:f.owner.publicKey.toBase58()}}),/independent/);
 assert.throws(()=>f.make({fundingFirst:{feeNft:f.treasury}}),/independent/);assert.throws(()=>f.make({fundingFirst:{feeNft:f.payer}}),/independent/);
 assert.throws(()=>f.make({fundingFirst:{feeNft:'1'.repeat(30)}}),/fee NFT|public key/i);assert.throws(()=>f.make({fundingFirst:{feeNft:f.feeNft,extra:1}}),/fields/);
 assert.throws(()=>f.make({launch:{...f.launch,policy:{...f.policy,softCapLamports:String(BigInt(SOFT_FLOOR_LAMPORTS_V2)-1n)}}}),/floor/);
 assert.throws(()=>createMintIntent({preparation:f.preparation,creator:f.owner.publicKey.toBase58(),rentLamports:'1461600',metadata:f.metadata,fundingFirst:{feeNft:f.feeNft}}),/fields/,'funding first without the launch terms');
 const intent=f.make();assert.notEqual(mintIntentHash({...intent,fundingFirst:{feeNft:key()}}),mintIntentHash(intent),'the fee NFT is part of the immutable intent');
 const derived=provisionIntentFromMint(intent,'1800000000');assert.equal(derived.mint.version,3);assert.equal(derived.opensAt,'1800000000');
});
test('the sealed terms of a version-3 intent equal a full create for the same opening time (the program seals the same 800 bytes as tag 40)',()=>{
 const f=fixture(),intent=f.make(),opensAt='1800000000',expected=expectedSealedTerms(intent,opensAt);
 const v1=createMintIntent({preparation:f.preparation,creator:f.owner.publicKey.toBase58(),rentLamports:'1461600',metadata:f.metadata});
 const full=createInstruction(intent.programId,provisionTerms(createProvisionIntent({mint:v1,policy:f.policy,treasury:f.treasury,opensAt,authorityBudgetLamports:'300000000'})));
 assert.deepEqual(Buffer.from(full.sealed),expected);
});
test('finalized opening evidence: the immutable commitments (record, extension, both reservations); lifecycle state after the opening is accepted; deviations mismatch, absence is unavailable',()=>{
 const f=fixture(),intent=f.make(),opensAt='1800000000',addresses=mintResultAddresses(intent);
 assert.equal(addresses.length,7);assert.deepEqual(addresses.map(String),[intent.campaign,String(extAddress(intent.programId,intent.campaign)),String(mintReservationAddress(intent.programId,intent.mint)),String(nftReservationAddress(intent.programId,f.feeNft)),intent.authority,intent.mint,f.feeNft]);
 const {expected,response}=evidenceFor(intent,opensAt),evidence=verifyMintResult(intent,response,{minSlot:5});
 assert.equal(evidence.accountingVersion,2);assert.equal(evidence.tokenCreated,false);assert.equal(evidence.feeNft,f.feeNft);assert.equal(evidence.campaign,intent.campaign);assert.equal(evidence.opensAt,opensAt);assert.equal(evidence.sealedTermsBase64,expected.toString('base64'));assert.equal(evidence.termsHash,termsHash(expected).toString('hex'));assert.equal(evidence.intentHash,mintIntentHash(intent));assert.equal(evidence.slot,10);assert.equal(evidence.authoritySetupLamports,'300000000');assert.deepEqual(evidence.reserve,{payer:f.payer,lamports:'100000000'});assert.equal(evidence.version,1);
 const mismatch=(over,label)=>assert.throws(()=>verifyMintResult(intent,evidenceFor(intent,opensAt,over).response,{minSlot:5}),{code:'MINT_RESULT_MISMATCH'},label);
 const {record,ext}=evidenceFor(intent,opensAt);
 const flipped=(buffer,at)=>{const b=Buffer.from(buffer);b[at]^=1;return b;};
 mismatch({1:{owner:new PublicKey(intent.programId),executable:false,lamports:1,data:flipped(ext,136)}},'another display commitment');
 mismatch({1:{owner:new PublicKey(intent.programId),executable:false,lamports:1,data:flipped(ext,104)}},'another fee NFT in the extension');
 mismatch({0:{owner:new PublicKey(intent.programId),executable:false,lamports:1,data:(()=>{const b=Buffer.from(record);b[OFF_ACCOUNTING_VERSION]=1;return b;})()}},'a per-receipt record');
 mismatch({2:{owner:new PublicKey(intent.programId),executable:false,lamports:1,data:(()=>{const b=Buffer.from(evidenceFor(intent,opensAt).response.value[2].data);b[40]^=1;return b;})()}},'a mint reservation for another key');
 mismatch({3:{owner:SystemProgram.programId,executable:false,lamports:1,data:evidenceFor(intent,opensAt).response.value[3].data}},'a reservation not owned by the program');
 // Lifecycle state after the opening is not a deviation: a delayed recovery after the round launched (a token at the reserved
 // mint, the extension sealed, the setup budget spent) or after it closed must still recognise its own opening.
 const later=evidenceFor(intent,opensAt,{5:{owner:TOKEN_PROGRAM,executable:false,lamports:1461600,data:Buffer.alloc(82)},6:{owner:TOKEN_PROGRAM,executable:false,lamports:1461600,data:Buffer.alloc(82)},4:{owner:SystemProgram.programId,executable:false,lamports:0,data:Buffer.alloc(0)}});later.response.value[1].data[169]=1;
 assert.equal(verifyMintResult(intent,later.response,{minSlot:5}).intentHash,mintIntentHash(intent),'after the launch the opening is still recognised');
 assert.equal(verifyMintResult(intent,evidenceFor(intent,opensAt,{4:null,5:null,6:null}).response,{minSlot:5}).accountingVersion,2,'the authority and the reserved addresses may be absent');
 assert.throws(()=>verifyMintResult(intent,evidenceFor(intent,opensAt,{1:null}).response,{minSlot:5}),{code:'MINT_RESULT_UNAVAILABLE'},'a missing extension is not evidence yet');
 assert.throws(()=>verifyMintResult(intent,evidenceFor(intent,opensAt).response,{minSlot:11}),{code:'MINT_RESULT_UNAVAILABLE'},'an older slot than required');
 const at5=f.make({launch:{...f.launch,opensAt:'1800000005'}}),at6=f.make({launch:{...f.launch,opensAt:'1800000006'}});
 assert.throws(()=>verifyMintResult(at6,evidenceFor(at5,'1800000005').response,{minSlot:5}),{code:'MINT_RESULT_MISMATCH'},'a record sealed for another scheduled opening time');
 assert.equal(verifyMintResult(at5,evidenceFor(at5,'1800000005').response,{minSlot:5}).opensAt,'1800000005');
});
