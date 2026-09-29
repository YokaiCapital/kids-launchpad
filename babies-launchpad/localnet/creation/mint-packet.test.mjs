import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,TransactionMessage,VersionedTransaction,SystemProgram} from '@solana/web3.js';
import {decodeMintToInstruction,decodeSetAuthorityInstruction,AuthorityType} from '@solana/spl-token';
import {campaignAddress,launchAuthority,associatedTokenAddress} from '../protocol-v2/client.mjs';
import {createMintIntent,buildMintPacket,mintIntentHash,verifyMintApproval} from './mint-packet.mjs';
import {decodeMetadataInstruction} from '../token-metadata.mjs';
const mint='7e2g1HXJQPCMLED6PQZhHwzYw9iGemwPuUc5FAFMkids';
function fixture(){
 const owner=Keypair.generate(),programId=Keypair.generate().publicKey.toBase58(),nonce='123',campaign=campaignAddress(programId,owner.publicKey,nonce).toBase58();
 const input={preparation:{programVersion:3,state:'reserved',fundingEnabled:false,requestId:'request',leaseId:'lease',genesisHash:Keypair.generate().publicKey.toBase58(),programId,nonce,campaign,authority:launchAuthority(programId,campaign).toBase58(),mint},creator:owner.publicKey.toBase58(),metadata:{name:'Shartcoin',symbol:'Shartcoin',uri:'https://kids.fun/rehearsal/metadata.json',documentHash:'ab'.repeat(32)},rentLamports:'1461600'};
 return {owner,input,intent:createMintIntent(input),block:{blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100}};
}
test('creator mint leg fixes all supply to campaign custody, immutable metadata and revoked authorities',()=>{
 const {intent,block}=fixture(),tx=buildMintPacket(intent,block),ix=TransactionMessage.decompile(tx.message).instructions;
 assert.equal(tx.message.header.numRequiredSignatures,2);assert.equal(ix.length,6);
 const mintTo=decodeMintToInstruction(ix[3]);assert.equal(mintTo.data.amount,1000000000000000n);
 assert.equal(mintTo.keys.destination.pubkey.toBase58(),associatedTokenAddress(intent.authority,intent.mint).toBase58());
 const metadata=decodeMetadataInstruction(ix[4].data);assert.equal(metadata.symbol,'Shartcoin');assert.equal(metadata.isMutable,false);assert.equal(metadata.sellerFee,0);assert.equal(metadata.creators,0);
 const revoke=decodeSetAuthorityInstruction(ix[5]);assert.equal(revoke.data.authorityType,AuthorityType.MintTokens);assert.equal(revoke.data.newAuthority,null);
 const mintInit=ix[1].data;assert.equal(mintInit[0],20);assert.equal(mintInit[1],6);assert.equal(mintInit[34],0,'no freeze authority from initialization');
 assert.ok(tx.serialize().length<=1232);
});
test('max UTF-8 branding and sealed URI fit one transaction with two signatures',()=>{
 const {input,block}=fixture();input.metadata={name:'😀'.repeat(8),symbol:'ABCDEFGHIJ',uri:'https://kids.fun/'+ 'a'.repeat(111),documentHash:'cd'.repeat(32)};
 const tx=buildMintPacket(createMintIntent(input),block);assert.ok(tx.serialize().length<=1232);
});
test('immutable intent survives JSON reload and attempt blockhash changes',()=>{
 const {intent,block}=fixture(),reloaded=JSON.parse(JSON.stringify(intent));
 assert.equal(mintIntentHash(reloaded),mintIntentHash(intent));
 assert.deepEqual(buildMintPacket(reloaded,block).serialize(),buildMintPacket(intent,block).serialize());
 assert.notDeepEqual(buildMintPacket(intent,{...block,blockhash:Keypair.generate().publicKey.toBase58()}).serialize(),buildMintPacket(intent,block).serialize());
 assert.equal(mintIntentHash(intent),mintIntentHash(reloaded));
});
test('fails closed on changed custody, version, supply, reservation and metadata',()=>{
 const {input,intent,block}=fixture();
 for(const patch of [{state:'signed'},{programVersion:2},{fundingEnabled:true},{campaign:Keypair.generate().publicKey.toBase58()},{authority:Keypair.generate().publicKey.toBase58()},{mint:input.creator},{nonce:'0123'}])assert.throws(()=>createMintIntent({...input,preparation:{...input.preparation,...patch}}));
 for(const patch of [{supply:'1'},{decimals:9},{version:2},{extra:true},{rentLamports:'1e7'},{rentLamports:'0'},{genesisHash:SystemProgram.programId.toBase58()}])assert.throws(()=>buildMintPacket({...intent,...patch},block));
 for(const patch of [{name:'😀'.repeat(9)},{symbol:'A B'},{uri:'javascript:alert(1)'},{uri:'https://user:pass@kids.fun/a'},{uri:'https://kids.fun/a#other'},{uri:'https://kids.fun/é'},{documentHash:'123'},{mutable:true}])assert.throws(()=>createMintIntent({...input,metadata:{...input.metadata,...patch}}));
 assert.throws(()=>buildMintPacket(intent,{...block,lastValidBlockHeight:0}));
});
test('creator-first approval must be exact, canonical and correctly signed',()=>{
 const {owner,intent,block}=fixture(),tx=buildMintPacket(intent,block),encoded=()=>Buffer.from(tx.serialize()).toString('base64');
 assert.throws(()=>verifyMintApproval(intent,block,encoded()),/creator-first/);
 tx.sign([owner]);const result=verifyMintApproval(intent,block,encoded());assert.equal(result.intentHash,mintIntentHash(intent));
 assert.throws(()=>verifyMintApproval(intent,block,encoded()+'\n'),/encoding/);
 assert.throws(()=>verifyMintApproval(intent,block,Buffer.concat([Buffer.from(tx.serialize()),Buffer.from([0])]).toString('base64')),/changed/);
 tx.signatures[1][0]=1;assert.throws(()=>verifyMintApproval(intent,block,encoded()),/creator-first/);tx.signatures[1][0]=0;
 tx.signatures[0][0]^=1;assert.throws(()=>verifyMintApproval(intent,block,encoded()),/creator-first/);
});
test('wallet-signed added transfer or replacement blockhash cannot pass the signer gate',()=>{
 const {owner,intent,block}=fixture(),tx=buildMintPacket(intent,block),message=TransactionMessage.decompile(tx.message);
 message.instructions.push(SystemProgram.transfer({fromPubkey:owner.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1}));
 const changed=new VersionedTransaction(message.compileToV0Message());changed.sign([owner]);
 assert.throws(()=>verifyMintApproval(intent,block,Buffer.from(changed.serialize()).toString('base64')),/changed/);
 const otherBlock={...block,blockhash:Keypair.generate().publicKey.toBase58()},other=buildMintPacket(intent,otherBlock);other.sign([owner]);
 assert.throws(()=>verifyMintApproval(intent,block,Buffer.from(other.serialize()).toString('base64')),/changed/);
});
