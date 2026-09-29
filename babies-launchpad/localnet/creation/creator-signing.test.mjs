import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,TransactionMessage,VersionedTransaction,SystemProgram,ComputeBudgetProgram} from '@solana/web3.js';
import {provisionFixture} from '../test/helpers/provision-fixture.mjs';
import {buildMintPacket,createMintIntent} from './mint-packet.mjs';
import {reviewedProvisionPolicy} from './provision-packet.mjs';
import {CREATE_V3_URI_PREFIX} from '../protocol-v3/client.mjs';
import {buildProvisionPacket} from './provision-packet.mjs';
import {buildOperatingFundingPacket} from './operating-proofs.mjs';
import {decodeCreatorPacket,checkedCreatorSignature} from '../../interaction-review/src/public/creator-signing.mjs';
const encode=tx=>Buffer.from(tx.serialize()).toString('base64');
function setup(){const {intent,creator,block}=provisionFixture(),m=intent.mint;return {intent,creator,block,scope:{network:'localnet',genesisHash:m.genesisHash,programId:m.programId,treasury:intent.treasury,mintRentLamports:m.rentLamports,name:m.metadata.name,symbol:m.metadata.symbol,authorityBudgetLamports:intent.authorityBudgetLamports,opensAt:intent.opensAt,...intent.policy}};}
test('browser independently reconstructs each creator packet and exact signatures match backend builders',()=>{
 const {intent,creator,block,scope}=setup();
 for(const stage of ['mint','native-custody','create-campaign']){
  const tx=stage==='mint'?buildMintPacket(intent.mint,block):buildProvisionPacket(intent,stage,block),raw=tx.serialize();
  const result=decodeCreatorPacket(encode(tx),{owner:intent.mint.creator,scope,stage,intent:stage==='mint'?intent.mint:intent});assert.deepEqual(result.message.serialize(),tx.message.serialize());
  result.sign([creator]);assert.equal(checkedCreatorSignature(result,raw),encode(result));
 }
});
test('browser refuses instruction changes, additional transfer, signer changes and mainnet scope',()=>{
 const {intent,creator,block,scope}=setup();
 for(const stage of ['mint','native-custody','create-campaign']){
  const build=()=>stage==='mint'?buildMintPacket(intent.mint,block):buildProvisionPacket(intent,stage,block),options={owner:intent.mint.creator,scope,stage,intent:stage==='mint'?intent.mint:intent};
  const tx=build();for(let i=0;i<tx.message.compiledInstructions.length;i++){
   const changed=VersionedTransaction.deserialize(tx.serialize());changed.message.compiledInstructions[i].data[0]^=1;assert.throws(()=>decodeCreatorPacket(encode(changed),options),/differs/);
  }
  const instructions=TransactionMessage.decompile(tx.message).instructions;instructions.push(SystemProgram.transfer({fromPubkey:creator.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1}));
  const extra=new VersionedTransaction(new TransactionMessage({payerKey:creator.publicKey,recentBlockhash:block.blockhash,instructions}).compileToV0Message());assert.throws(()=>decodeCreatorPacket(encode(extra),options));
  assert.throws(()=>decodeCreatorPacket(encode(tx),{...options,owner:Keypair.generate().publicKey.toBase58()}));
  assert.throws(()=>decodeCreatorPacket(encode(tx),{...options,scope:{...scope,network:'mainnet'}}));
  tx.sign([creator]);assert.throws(()=>decodeCreatorPacket(encode(tx),options),'already signed server offers are refused');
 }
});
test('browser checks reviewed economics, identity, metadata, reserve and all sealed padding bytes',()=>{
 const {intent,block,scope}=setup(),encodeMint=p=>encode(buildMintPacket(p.mint,block)),mintOptions={owner:intent.mint.creator,scope,stage:'mint',intent:intent.mint};
 for(const patch of [{name:'Wrong'},{symbol:'Wrong'},{mintRentLamports:'1'},{genesisHash:Keypair.generate().publicKey.toBase58()},{programId:Keypair.generate().publicKey.toBase58()}])assert.throws(()=>decodeCreatorPacket(encodeMint(intent),{...mintOptions,scope:{...scope,...patch}}));
 const tx=buildProvisionPacket(intent,'create-campaign',block),options={owner:intent.mint.creator,scope,stage:'create-campaign',intent};
 for(const patch of [{authorityBudgetLamports:'1'},{treasury:Keypair.generate().publicKey.toBase58()},{tradeFeeBps:250},{softCapLamports:'1'},{opensAt:'2000000001'},{fundingDurationSeconds:900}])assert.throws(()=>decodeCreatorPacket(encode(tx),{...options,scope:{...scope,...patch}}));
 // Explicitly cover supply, fee rights, vesting, parent fields, future slots and
 // metadata, rather than accepting an opaque server-provided sealed byte string.
 for(const offset of [184,306,314,324,328,329,331,364,396,524,636,644,676,805,807]){
  const changed=VersionedTransaction.deserialize(tx.serialize());changed.message.compiledInstructions[0].data[1+offset-8]^=1;assert.throws(()=>decodeCreatorPacket(encode(changed),options));
 }
});
test('wallet alterations or missing approval cannot be submitted as creator signatures',()=>{
 const {intent,creator,block}=setup(),tx=buildProvisionPacket(intent,'create-campaign',block),raw=tx.serialize();
 assert.throws(()=>checkedCreatorSignature(tx,raw));
 tx.message.recentBlockhash=Keypair.generate().publicKey.toBase58();tx.sign([creator]);assert.throws(()=>checkedCreatorSignature(tx,raw));
 const fresh=buildProvisionPacket(intent,'create-campaign',block),instructions=TransactionMessage.decompile(fresh.message).instructions;instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({units:400000}));
 const added=new VersionedTransaction(new TransactionMessage({payerKey:creator.publicKey,recentBlockhash:block.blockhash,instructions}).compileToV0Message());added.sign([creator]);assert.throws(()=>checkedCreatorSignature(added,raw));
 const mint=buildMintPacket(intent.mint,block),unsigned=mint.serialize();mint.sign([creator]);mint.signatures[1][0]=1;assert.throws(()=>checkedCreatorSignature(mint,unsigned));
});
test('browser reconstructs the operating reserve transfer exactly and refuses another payer, amount, campaign memo or a self-payment',()=>{
 const {intent,creator,block}=setup(),m=intent.mint,payer=Keypair.generate().publicKey.toBase58();
 const fund={genesisHash:m.genesisHash,programId:m.programId,campaign:m.campaign,payer,policy:'creator-funded-v1',creator:m.creator,lamports:'100000000'};
 const scope={network:'localnet',genesisHash:m.genesisHash,programId:m.programId,operatingPayer:payer,operatingReserveLamports:'100000000'};
 const tx=buildOperatingFundingPacket(fund,block),options={owner:m.creator,scope,stage:'operating-reserve',intent:fund};
 const result=decodeCreatorPacket(encode(tx),options);assert.deepEqual(result.message.serialize(),tx.message.serialize());
 result.sign([creator]);assert.equal(checkedCreatorSignature(result,tx.serialize()),encode(result));
 assert.throws(()=>decodeCreatorPacket(encode(tx),{...options,scope:{...scope,operatingReserveLamports:'99999999'}}),/differs/);
 assert.throws(()=>decodeCreatorPacket(encode(tx),{...options,intent:{...fund,lamports:'99999999'}}),/differs/);
 assert.throws(()=>decodeCreatorPacket(encode(tx),{...options,intent:{...fund,payer:m.creator},scope:{...scope,operatingPayer:m.creator}}),/differs/);
 assert.throws(()=>decodeCreatorPacket(encode(buildOperatingFundingPacket({...fund,campaign:Keypair.generate().publicKey.toBase58()},block)),options),/differs/);
 assert.throws(()=>decodeCreatorPacket(encode(buildOperatingFundingPacket({...fund,lamports:'100000001'},block)),options),/differs/);
});
test('the browser checks the review network against the site network: localnet by default, a hosted network only when the site is built for it',()=>{
 const {intent,block,scope}=setup(),tx=buildProvisionPacket(intent,'native-custody',block),options={owner:intent.mint.creator,stage:'native-custody',intent};
 assert.ok(decodeCreatorPacket(encode(tx),{...options,scope}));
 assert.throws(()=>decodeCreatorPacket(encode(tx),{...options,scope:{...scope,network:'mainnet'}}),/differs/);
 assert.ok(decodeCreatorPacket(encode(tx),{...options,scope:{...scope,network:'mainnet'},network:'mainnet'}));
 assert.throws(()=>decodeCreatorPacket(encode(tx),{...options,scope,network:'mainnet'}),/differs/);
 assert.throws(()=>decodeCreatorPacket(encode(tx),{...options,scope:{...scope,network:'testnet'},network:'testnet'}),/differs/);
});

// One creation transaction (28 September 2026): the browser rebuilds all eleven instructions from the reviewed launch.
function oneSetup(over={}){
 const {intent:v1,creator,block,quote}=provisionFixture(),m=v1.mint,payer=Keypair.generate().publicKey.toBase58();
 const intent=createMintIntent({preparation:{programVersion:3,state:'reserved',fundingEnabled:false,requestId:m.requestId,leaseId:m.leaseId,genesisHash:m.genesisHash,programId:m.programId,campaign:m.campaign,authority:m.authority,nonce:m.nonce,mint:m.mint},creator:m.creator,rentLamports:m.rentLamports,metadata:{...m.metadata,uri:CREATE_V3_URI_PREFIX+'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco'},
  launch:{policy:reviewedProvisionPolicy(quote),treasury:v1.treasury,opensAt:'0',authorityBudgetLamports:'300000000',reserve:{payer,lamports:'100000000'},priorityFeeLamports:'10000',...over}});
 const scope={network:'localnet',genesisHash:m.genesisHash,programId:m.programId,treasury:v1.treasury,mintRentLamports:m.rentLamports,name:m.metadata.name,symbol:m.metadata.symbol,authorityBudgetLamports:'300000000',opensAt:intent.launch.opensAt,operatingPayer:payer,operatingReserveLamports:'100000000',...intent.launch.policy};
 return {intent,v1,creator,block,scope,payer};
}
test('browser reconstructs the one creation transaction (eleven instructions, one approval) and exact signatures match the backend builder',()=>{
 for(const opensAt of ['0','1800000000']){
  const {intent,creator,block,scope}=oneSetup({opensAt}),tx=buildMintPacket(intent,block),raw=tx.serialize(),options={owner:intent.creator,scope,stage:'launch',intent};
  assert.equal(tx.message.compiledInstructions.length,11);assert.equal(tx.message.header.numRequiredSignatures,2);
  const result=decodeCreatorPacket(encode(tx),options);assert.deepEqual(result.message.serialize(),tx.message.serialize());
  result.sign([creator]);assert.equal(checkedCreatorSignature(result,raw),encode(result));
 }
});
test('browser refuses every change to the one creation transaction, a stage mix-up and a launch that differs from the review',()=>{
 const {intent,v1,creator,block,scope,payer}=oneSetup(),tx=buildMintPacket(intent,block),options={owner:intent.creator,scope,stage:'launch',intent};
 for(let i=0;i<tx.message.compiledInstructions.length;i++){
  const changed=VersionedTransaction.deserialize(tx.serialize()),data=changed.message.compiledInstructions[i].data;data[data.length-1]^=1;assert.throws(()=>decodeCreatorPacket(encode(changed),options),/differs/);
 }
 const instructions=TransactionMessage.decompile(tx.message).instructions;instructions.push(SystemProgram.transfer({fromPubkey:creator.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1}));
 const extra=new VersionedTransaction(new TransactionMessage({payerKey:creator.publicKey,recentBlockhash:block.blockhash,instructions}).compileToV0Message());assert.throws(()=>decodeCreatorPacket(encode(extra),options));
 // A priority fee raised by the wallet or the server would change the first instruction; the exact bytes are the review.
 const raised=VersionedTransaction.deserialize(tx.serialize());raised.message.compiledInstructions[0].data[1]^=1;assert.throws(()=>decodeCreatorPacket(encode(raised),options),/differs/);
 assert.throws(()=>decodeCreatorPacket(encode(tx),{...options,stage:'mint'}),'a one-transaction intent is not a token-only offer');
 assert.throws(()=>decodeCreatorPacket(encode(buildMintPacket(v1.mint,block)),{...options,intent:v1.mint}),'a token-only intent is not a one-transaction offer');
 assert.throws(()=>decodeCreatorPacket(encode(tx),{...options,owner:Keypair.generate().publicKey.toBase58()}));
 assert.throws(()=>decodeCreatorPacket(encode(tx),{...options,scope:{...scope,network:'mainnet'}}));
 const other=Keypair.generate().publicKey.toBase58();
 for(const patch of [{operatingReserveLamports:'1'},{operatingPayer:other},{opensAt:'1800000000'},{softCapLamports:'1'},{hardCapLamports:'1'},{treasury:other},{authorityBudgetLamports:'1'},{tradeFeeBps:250},{fundingDurationSeconds:900},{name:'Wrong'},{symbol:'Wrong'},{mintRentLamports:'1'}])assert.throws(()=>decodeCreatorPacket(encode(tx),{...options,scope:{...scope,...patch}}),/differs/,JSON.stringify(patch));
 // The reserve may never flow back to the creator, whatever the server offers.
 const self=structuredClone(intent);self.launch.reserve.payer=intent.creator;assert.throws(()=>decodeCreatorPacket(encode(tx),{...options,intent:self,scope:{...scope,operatingPayer:intent.creator}}),/differs/);
 const gateway=structuredClone(intent);gateway.metadata.uri='https://example.com/metadata.json';assert.throws(()=>decodeCreatorPacket(encode(tx),{...options,intent:gateway}),/differs/);
 assert.equal(payer,intent.launch.reserve.payer);
});
// Funding-first accounting (29 September 2026): the opening packet (tag 41 with the reserved mint and fee NFT co-signing, the
// setup budget and the operating reserve; no token) is reconstructed by the browser from the review alone.
function fundingSetup(over={}){
 const base=oneSetup(over),m=base.intent,feeNft=Keypair.generate().publicKey.toBase58();
 const intent=createMintIntent({preparation:{programVersion:3,state:'reserved',fundingEnabled:false,requestId:m.requestId,leaseId:m.leaseId,genesisHash:m.genesisHash,programId:m.programId,campaign:m.campaign,authority:m.authority,nonce:m.nonce,mint:m.mint},creator:m.creator,rentLamports:m.rentLamports,metadata:m.metadata,launch:m.launch,fundingFirst:{feeNft}});
 return {...base,intent,feeNft,scope:{...base.scope,feeNft}};
}
test('browser reconstructs the funding-first opening (four instructions, three signature slots, no token) and exact signatures match the backend builder',()=>{
 for(const opensAt of ['0','1800000000']){
  const {intent,creator,block,scope}=fundingSetup({opensAt}),tx=buildMintPacket(intent,block),raw=tx.serialize(),options={owner:intent.creator,scope,stage:'launch',intent};
  assert.equal(intent.version,3);assert.equal(tx.message.compiledInstructions.length,4);assert.equal(tx.message.header.numRequiredSignatures,3);
  const result=decodeCreatorPacket(encode(tx),options);assert.deepEqual(result.message.serialize(),tx.message.serialize());
  result.sign([creator]);assert.equal(checkedCreatorSignature(result,raw),encode(result));
 }
});
test('browser refuses every change to the opening, a fee NFT other than the reviewed one, a soft cap under the floor, a version-2 offer for a funding-first review and a pre-signed offer',()=>{
 const {intent,creator,block,scope}=fundingSetup(),tx=buildMintPacket(intent,block),options={owner:intent.creator,scope,stage:'launch',intent};
 for(let i=0;i<tx.message.compiledInstructions.length;i++){const changed=VersionedTransaction.deserialize(tx.serialize()),data=changed.message.compiledInstructions[i].data;data[data.length-1]^=1;assert.throws(()=>decodeCreatorPacket(encode(changed),options),/differs/);}
 const other=Keypair.generate().publicKey.toBase58();
 assert.throws(()=>decodeCreatorPacket(encode(tx),{...options,scope:{...scope,feeNft:other}}),/differs/,'the review names another fee NFT');
 const swapped=structuredClone(intent);swapped.fundingFirst.feeNft=other;assert.throws(()=>decodeCreatorPacket(encode(tx),{...options,intent:swapped,scope:{...scope,feeNft:other}}),/differs/,'the packet binds the sealed fee NFT');
 const low=structuredClone(intent);low.launch.policy.softCapLamports='6553499';assert.throws(()=>decodeCreatorPacket(encode(tx),{...options,intent:low,scope:{...scope,softCapLamports:'6553499'}}),/differs/,'a soft cap under the funding-first floor');
 for(const patch of [{operatingReserveLamports:'1'},{operatingPayer:other},{treasury:other},{authorityBudgetLamports:'1'},{name:'Wrong'},{symbol:'Wrong'}])assert.throws(()=>decodeCreatorPacket(encode(tx),{...options,scope:{...scope,...patch}}),/differs/,JSON.stringify(patch));
 const v2=oneSetup();assert.throws(()=>decodeCreatorPacket(encode(buildMintPacket(v2.intent,block)),options),/differs/,'a version-2 creation is not the reviewed opening');
 assert.throws(()=>decodeCreatorPacket(encode(tx),{...options,intent:v2.intent,scope:v2.scope}),/differs/,'the opening is not a version-2 creation');
 const missing=structuredClone(intent);delete missing.fundingFirst;assert.throws(()=>decodeCreatorPacket(encode(tx),{...options,intent:missing}),/differs/);
 tx.sign([creator]);assert.throws(()=>decodeCreatorPacket(encode(tx),options),/differs/,'already signed server offers are refused');
});
