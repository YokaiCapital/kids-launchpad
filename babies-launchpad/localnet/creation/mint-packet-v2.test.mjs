import test from 'node:test';import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {createMintIntent,buildMintPacket,verifyMintApproval,mintIntentHash,expectedSealedTerms,provisionIntentFromMint,launchCreateFields} from './mint-packet.mjs';
import {mintResultAddresses} from './mint-result.mjs';
import {reviewedProvisionPolicy,provisionTerms,createProvisionIntent,provisionIntentHash} from './provision-packet.mjs';
import {provisionFixture} from '../test/helpers/provision-fixture.mjs';
import {createInstruction} from '../protocol-v2/client.mjs';
import {CREATE_V3_URI_PREFIX,CREATE_V3_TAG} from '../protocol-v3/client.mjs';
const cid='QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco';
function intentFor({name,symbol,opensAt='0'}){
 const {intent:v1,quote}=provisionFixture(),m=v1.mint;
 return {v1,quote,payer:Keypair.generate().publicKey.toBase58(),intent:createMintIntent({preparation:{programVersion:3,state:'reserved',fundingEnabled:false,requestId:m.requestId,leaseId:m.leaseId,genesisHash:m.genesisHash,programId:m.programId,campaign:m.campaign,authority:m.authority,nonce:m.nonce,mint:m.mint},creator:m.creator,rentLamports:m.rentLamports,metadata:{name,symbol,uri:CREATE_V3_URI_PREFIX+cid,documentHash:m.metadata.documentHash},
  launch:{policy:reviewedProvisionPolicy(quote),treasury:v1.treasury,opensAt,authorityBudgetLamports:'300000000',reserve:{payer:'11111111111111111111111111111112',lamports:'100000000'},priorityFeeLamports:'10000'}})};
}
test('one creation transaction fits the wire limit at the longest name and ticker, with two signers and eleven instructions',()=>{
 const {intent}=intentFor({name:'A'.repeat(32),symbol:'B'.repeat(10)}),block={blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:150};
 const tx=buildMintPacket(intent,block),bytes=tx.serialize();
 assert.ok(bytes.length<=1232,'packet is '+bytes.length+' bytes');assert.ok(bytes.length>1100,'sanity: the packet carries everything ('+bytes.length+' bytes)');
 assert.equal(tx.message.header.numRequiredSignatures,2);assert.equal(tx.message.compiledInstructions.length,11);
 const program=tx.message.staticAccountKeys[tx.message.compiledInstructions[8].programIdIndex].toBase58();assert.equal(program,intent.programId);
 assert.equal(tx.message.compiledInstructions[8].data[0],CREATE_V3_TAG,'ninth instruction is the compact campaign creation');
 assert.equal(mintResultAddresses(intent).length,6);
 assert.equal(intent.version,2);assert.match(mintIntentHash(intent),/^[a-f0-9]{64}$/);
});
test('the sealed terms of a version-2 intent equal a full create for the same opening time, and the provisioning intent derives from it',()=>{
 const {intent,v1,quote}=intentFor({name:'Local coin',symbol:'LocalCoin'});
 const opensAt='1800000000',expected=expectedSealedTerms(intent,opensAt);
 const mint={...v1.mint,metadata:{...v1.mint.metadata,uri:CREATE_V3_URI_PREFIX+cid}};
 const full=createInstruction(v1.mint.programId,provisionTerms(createProvisionIntent({mint,policy:reviewedProvisionPolicy(quote),treasury:v1.treasury,opensAt,authorityBudgetLamports:'300000000'})));
 assert.deepEqual(Buffer.from(full.sealed),expected);
 const derived=provisionIntentFromMint(intent,opensAt);assert.equal(derived.opensAt,opensAt);assert.equal(derived.authorityBudgetLamports,'300000000');assert.match(provisionIntentHash(derived),/^[a-f0-9]{64}$/);
 assert.throws(()=>provisionIntentFromMint(intent),/unknown until/,'opening time 0 needs the chain value');
 assert.throws(()=>expectedSealedTerms(intentFor({name:'x',symbol:'y',opensAt:'1800000005'}).intent,'1800000000'),/differs/);
 assert.equal(launchCreateFields(intent).opensAt,'0');
});
test('version-2 intent validation: gateway metadata, reserve and treasury identities, windows and caps',()=>{
 const {intent:v1,quote}=provisionFixture(),m=v1.mint;
 const make=(over={},launchOver={})=>createMintIntent({preparation:{programVersion:3,state:'reserved',fundingEnabled:false,requestId:m.requestId,leaseId:m.leaseId,genesisHash:m.genesisHash,programId:m.programId,campaign:m.campaign,authority:m.authority,nonce:m.nonce,mint:m.mint},creator:m.creator,rentLamports:m.rentLamports,metadata:{...m.metadata,uri:CREATE_V3_URI_PREFIX+cid,...over},
  launch:{policy:reviewedProvisionPolicy(quote),treasury:v1.treasury,opensAt:'0',authorityBudgetLamports:'300000000',reserve:{payer:'11111111111111111111111111111112',lamports:'100000000'},priorityFeeLamports:'10000',...launchOver}});
 assert.equal(make().version,2);
 assert.throws(()=>make({uri:'https://example.com/x.json'}),/gateway/);
 assert.throws(()=>make({},{reserve:{payer:m.creator,lamports:'1'}}),/operating payer/);
 assert.throws(()=>make({},{reserve:{payer:'11111111111111111111111111111112',lamports:'0'}}),/reserve/);
 assert.throws(()=>make({},{treasury:m.mint}),/treasury/);
 assert.throws(()=>make({},{authorityBudgetLamports:'0'}),/budget/);
 assert.throws(()=>make({},{opensAt:'-5'}),/opening/);
 assert.throws(()=>make({},{extra:1}),/fields/);
 const {intent}=intentFor({name:'n',symbol:'s'}),block={blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:5};
 const tx=buildMintPacket(intent,block);const encoded=Buffer.from(tx.serialize()).toString('base64');
 assert.throws(()=>verifyMintApproval(intent,block,encoded),/creator-first/,'an unsigned packet is not an approval');
});
