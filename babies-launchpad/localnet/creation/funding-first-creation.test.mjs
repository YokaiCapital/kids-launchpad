// The funding-first creation service end to end over PostgreSQL and the real encrypted mint inventory, on a mocked ledger:
// one opening approval (the creator), the custody's co-signature (reserved mint and fee NFT), broadcast of the exact bytes,
// the finalized opening evidence (immutable commitments), registration; an expired opening is recovered by re-offering the
// exact same sealed intent one generation later (the custody chains its second signature on the first); the admission
// flag admits new rounds only: it never changes a sealed plan and never closes the custody route for an accepted opening.
import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';import {mkdtempSync,chmodSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import pg from 'pg';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {createCreationStore} from './store.mjs';
import {createMetadataPublisher} from './publication.mjs';
import {createLocalCreatorServices} from './services.mjs';
import {mintIntentHash} from './mint-packet.mjs';
import {contentHash} from './pinata.mjs';
import {PINATA_GATEWAY} from '../token-metadata.mjs';
import {provisionFixture} from '../test/helpers/provision-fixture.mjs';
import {openingEvidence,kidsVanityKeypairs,kidsVanityKeysAvailable} from '../test/helpers/funding-first-fixture.mjs';
import {SqliteVanityMintInventory} from '../../kids-mint-worker/vendor/packages/launcher-sdk/src/mint-inventory.js';
import {SqliteLaunchExecutionStore} from '../../kids-mint-worker/vendor/packages/launcher-sdk/src/sqlite-execution-store.js';
import {verifySignature,encodeBase58} from '../../shared/solana.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,address=()=>Keypair.generate().publicKey.toBase58();
test('funding-first creation service: opening approval, custody co-signature, finalized opening evidence, registration; recovery re-signs the exact intent; the admission flag never changes a sealed plan',{skip:!url||!kidsVanityKeysAvailable()},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1}),dir=mkdtempSync(join(tmpdir(),'kids-ff-creation-'));chmodSync(dir,0o700);let pool,inventory;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  inventory=new SqliteVanityMintInventory({databasePath:join(dir,'inventory.sqlite'),executionStore:new SqliteLaunchExecutionStore(join(dir,'executions.sqlite')),keyId:'test-v1',encryptionKey:randomBytes(32),fallbackToOrdinaryMint:false});
  for(const kp of kidsVanityKeypairs(3)){const mint=kp.publicKey.toBase58(),sealed=inventory.encrypt(Buffer.from(kp.secretKey),mint);inventory.db.prepare("INSERT INTO kids_mints VALUES(?,?,?,?,'available',?,NULL)").run(mint,sealed.nonce,sealed.ciphertext,sealed.tag,new Date().toISOString());}
  const creator=Keypair.generate(),owner=creator.publicKey.toBase58(),{quote}=provisionFixture();
  const config={mode:'localnet-rehearsal',programVersion:3,rpcUrl:'http://127.0.0.1:19199',pilotCreator:owner,genesisHash:address(),programId:address(),policyHash:'a'.repeat(64),planHash:'b'.repeat(64),treasury:address(),oneTransaction:true,operatingPayer:address(),operatingReserveLamports:'100000000',priorityFeeLamports:'10000',fundingFirst:true};
  // The ledger: blockhashes, signature statuses and finalized accounts are scripted; a landed opening answers with its evidence.
  const landed=new Map(),statuses=new Map(),sends=[],packets=new Map();let height=100,block={blockhash:address(),lastValidBlockHeight:150,observedSlot:50};
  const connection={rpcEndpoint:config.rpcUrl,getGenesisHash:async()=>config.genesisHash,getMinimumBalanceForRentExemption:async()=>1461600,
   getLatestBlockhash:async()=>block,getLatestBlockhashAndContext:async()=>({context:{slot:block.observedSlot},value:block}),isBlockhashValid:async()=>({value:true}),
   getFirstAvailableBlock:async()=>1,getEpochInfo:async()=>({blockHeight:height,absoluteSlot:200}),
   getSignatureStatuses:async([signature])=>({context:{slot:210},value:[statuses.get(signature)??null]}),
   sendRawTransaction:async bytes=>{const tx=VersionedTransaction.deserialize(Buffer.from(bytes)),signature=encodeBase58(tx.signatures[0]);sends.push(signature);packets.set(signature,tx);return signature;},
   // The finalized transaction as the reserve proof reader needs it: the exact message and signatures, balances over the
   // static keys with the reserve amount landed on the keeper payer.
   getTransaction:async(signature,{commitment})=>{assert.equal(commitment,'finalized');const tx=packets.get(signature),status=statuses.get(signature);if(!tx||status?.confirmationStatus!=='finalized')return null;const keys=tx.message.staticAccountKeys.map(String),pre=keys.map(()=>5000000000),post=pre.slice();const payer=keys.indexOf(config.operatingPayer);post[payer]+=100000000;post[0]-=100000000+5000;return {slot:status.slot,meta:{err:null,fee:5000,preBalances:pre,postBalances:post,loadedAddresses:{writable:[],readonly:[]}},transaction:{message:tx.message,signatures:tx.signatures.map(encodeBase58)}};},
   getMultipleAccountsInfoAndContext:async(keys,{commitment,minContextSlot})=>{assert.equal(commitment,'finalized');const intent=landed.get(String(keys[0]));return {context:{slot:Math.max(minContextSlot??0,210)},value:intent?openingEvidence(intent,'1800000000').response.value:keys.map(()=>null)};}};
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]),sha=contentHash(bytes),receipt=input=>{const cid=input.cid??'Qm'+(input.stage==='image'?'a':'b').repeat(44);return {cid,uri:PINATA_GATEWAY+cid,inputHash:input.inputHash};};
  const publisher=createMetadataPublisher({registry,config,limits:{ownerPins:40,globalPins:40,ownerBytes:100000,globalBytes:100000},loadOwnedImage:async()=>({owner,assetId:'owned-pfp',sanitized:true,sha256:sha,bytes,contentType:'image/png'}),provider:{publish:async input=>receipt(input),recover:async input=>receipt(input)}});
  const store=createCreationStore(registry);
  async function accept(draftId,name,symbol){
   const draft={name,symbol,description:'Creator-approved text.',pfp:{assetId:'owned-pfp',sha256:sha},start:'after-creation'};
   await registry.drafts.save({creator:owner,id:draftId,revision:0,body:draft});
   const q=await store.issue({owner,draftId,revision:1,draftHash:canonicalHash(draft),descriptorHash:canonicalHash({draftId}),requestKey:draftId,body:{genesisHash:config.genesisHash,programId:config.programId,policyHash:config.policyHash,planHash:config.planHash,terms:quote.terms,costs:{lines:[{item:'mint account rent',lamports:'1461600'}]},authorityFunding:{amountLamports:'300000000'},operatingReserveLamports:'100000000',fundingEnabled:false,publicationConsent:true}});
   return (await store.accept({owner,quoteId:q.id})).id;
  }
  const compose=cfg=>createLocalCreatorServices({registry,connection,config:cfg,inventory,publisher});
  // Reservation, then publication + seal, until the wallet stage is reached (publication may answer pending while it works).
  async function reach(services,requestId){
   const input={requestId};assert.equal((await services.flow.status(owner,input)).stage,'reservation');await services.flow.prepare(owner,input);
   for(let i=0;i<40&&(await services.flow.status(owner,input)).stage==='publication';i++)await services.flow.prepare(owner,input);
   const s=await services.flow.status(owner,input);assert.equal(s.stage,'launch');assert.equal(s.action,'prepare');return s;
  }
  const approve=async(services,requestId)=>{
   const offer=await services.flow.prepare(owner,{requestId});assert.equal(offer.result.action,'sign-launch');
   const tx=VersionedTransaction.deserialize(Buffer.from(offer.result.transactionBase64,'base64'));assert.equal(tx.signatures.length,3);assert.equal(tx.message.header.numRequiredSignatures,3);tx.sign([creator]);
   await services.flow.submit(owner,{requestId,stage:'launch',offerId:offer.result.offerId,transactionBase64:Buffer.from(tx.serialize()).toString('base64')});
   const s=await services.flow.status(owner,{requestId});assert.equal(s.state,'prepared');assert.equal(s.action,'resume');return offer;
  };
  const custodySteps=mint=>inventory.fundingFirstCustody(mint).signatures.map(x=>x.step+':'+x.generation);
  const services=compose(config);
  // --- One opening approval: both key bindings and the sealed intent are durable before the offer.
  const one=await accept('one','Funding first','FIRST');
  const s1=await reach(services,one);assert.equal(s1.fundingFirst,true);assert.equal(s1.creationMode,'single');assert.deepEqual(s1.signatures,{});
  const intent=await services.mintPlans.load(one);assert.equal(intent.version,3);
  const custody=inventory.fundingFirstCustody(intent.mint);assert.equal(custody.feeNft,intent.fundingFirst.feeNft);assert.equal(custody.campaign,intent.campaign);assert.equal(custody.requestId,one);assert.deepEqual(custody.signatures,[]);
  assert.equal(inventory.db.prepare('SELECT COUNT(*) n FROM kids_fee_nft_keys').get().n,1,'the fee-NFT key is durable before any offer');
  assert.deepEqual(await services.mintPlans.load(one),intent,'the sealed plan reads back unchanged');
  const offer=await approve(services,one);assert.equal(offer.result.review.feeNft,intent.fundingFirst.feeNft);assert.equal(offer.result.review.accounting,'funding-first');assert.equal(offer.result.review.tokenCreatedAtOpening,false);
  // Resume: the custody co-signs (mint + fee NFT) the exact offer, the packet is captured, then broadcast with its exact bytes.
  await services.flow.resume(owner,{requestId:one});
  const row=await services.mintApprovals.read(one);assert.equal(row.status,'signed');
  const signed=VersionedTransaction.deserialize(Buffer.from(row.signedBase64,'base64')),message=Buffer.from(signed.message.serialize());
  assert.ok(verifySignature(owner,message,signed.signatures[0])&&verifySignature(intent.mint,message,signed.signatures[1])&&verifySignature(intent.fundingFirst.feeNft,message,signed.signatures[2]),'creator, reserved mint and reserved fee NFT signed the exact offer');
  assert.deepEqual(sends,[row.signature]);assert.deepEqual(custodySteps(intent.mint),['opening:0']);
  assert.equal((await services.flow.status(owner,{requestId:one})).state,'signed');
  // Finalized: the immutable opening commitments are the evidence; registration records the accounting version and fee NFT.
  statuses.set(row.signature,{confirmationStatus:'finalized',slot:205,err:null});landed.set(intent.campaign,intent);
  await services.flow.resume(owner,{requestId:one});
  const minted=await services.mintApprovals.read(one);assert.equal(minted.status,'finalized');assert.equal(minted.result.mintEvidence.accountingVersion,2);assert.equal(minted.result.mintEvidence.tokenCreated,false);assert.equal(minted.result.mintEvidence.feeNft,intent.fundingFirst.feeNft);assert.equal(minted.result.mintEvidence.opensAt,'1800000000');
  let s=await services.flow.status(owner,{requestId:one});assert.equal(s.stage,'registration');assert.equal(s.action,'resume');assert.equal(s.signatures.launch,row.signature);
  await services.flow.resume(owner,{requestId:one});
  // The operating reserve rode in the opening: credited once from the finalized packet's own proof, no other approval.
  s=await services.flow.status(owner,{requestId:one});assert.equal(s.stage,'operating-reserve');assert.equal(s.state,'pending');assert.equal(s.action,'resume');assert.equal(s.reason,'credit-from-creation');assert.equal(s.review.operatingReserveLamports,'100000000');
  await services.flow.resume(owner,{requestId:one});
  s=await services.flow.status(owner,{requestId:one});assert.equal(s.stage,'complete');assert.equal(s.state,'funded');assert.deepEqual(s.operatingReserve,{lamports:'100000000',payer:config.operatingPayer,signature:row.signature});assert.deepEqual(s.signatures,{launch:row.signature,'operating-reserve':row.signature});
  const receipts=async signature=>Number((await registry.query('SELECT COUNT(*) n FROM operating_funding_receipts WHERE signature=?',[signature])).rows[0].n);
  assert.equal(await receipts(row.signature),1,'the accepted amount is credited once');
  // A lost response or a replayed resume credits nothing twice and asks for no transfer or approval.
  await services.flow.resume(owner,{requestId:one});await services.operatingReserve.creditFromCreation(owner,{requestId:one,signature:row.signature,transactionBase64:row.signedBase64,block:row.prepared.block});
  assert.equal(await receipts(row.signature),1);assert.equal((await services.flow.status(owner,{requestId:one})).state,'funded');
  const campaign=await registry.campaigns.get({genesisHash:config.genesisHash,programId:config.programId,campaign:intent.campaign});
  assert.equal(campaign.mint,intent.mint);assert.equal(campaign.terms.accountingVersion,2);assert.equal(campaign.terms.feeNft,intent.fundingFirst.feeNft);assert.equal(campaign.terms.creationSignature,row.signature);
  assert.equal(sends.length,1,'nothing else was broadcast');assert.equal((await registry.mintLeases.get(intent.leaseId)).state,'consumed');
  // Metadata: sealed with the locally computed content ids at the click (no provider call on the creator's path), the
  // campaign's URI is the sealed document, and the background pin confirms both afterwards.
  const pinRows=async()=>(await registry.query('SELECT stage,state,cid FROM creation_publications WHERE request_id=? ORDER BY stage',[one])).rows;
  let pins=await pinRows();assert.deepEqual(pins.map(p=>p.state),['sealed','sealed']);assert.equal(PINATA_GATEWAY+pins[0].cid,intent.metadata.uri);
  assert.deepEqual((await services.flow.status(owner,{requestId:one})).publication,{uri:intent.metadata.uri,image:'sealed',document:'sealed'});
  while(await publisher.tickSealed());pins=await pinRows();assert.deepEqual(pins.map(p=>p.state),['published','published']);assert.equal(PINATA_GATEWAY+pins[0].cid,intent.metadata.uri);
  assert.equal((await services.flow.status(owner,{requestId:one})).publication.document,'published');
  // --- Recovery: an opening that expires unseen pauses for explicit recovery; the same sealed intent is re-offered one
  // generation later and the custody chains its second signature on the first. The admission flag is off meanwhile.
  const two=await accept('two','Second round','SECOND');
  await reach(services,two);const intent2=await services.mintPlans.load(two);assert.equal(intent2.version,3);
  const offer2=await approve(services,two);await services.flow.resume(owner,{requestId:two});
  const first=await services.mintApprovals.read(two);assert.equal(first.status,'signed');assert.deepEqual(custodySteps(intent2.mint),['opening:0']);assert.equal(sends.length,2);
  height=151;await services.flow.resume(owner,{requestId:two});
  s=await services.flow.status(owner,{requestId:two});assert.equal(s.state,'expired');assert.equal(s.action,'recover');
  const recovered=await services.flow.recover(owner,{requestId:two,stage:'launch',expectedSignature:first.signature});assert.equal(recovered.result.status,'review-required');assert.equal(recovered.result.generation,1);
  const closed=compose({...config,fundingFirst:false});
  s=await closed.flow.status(owner,{requestId:two});assert.equal(s.fundingFirst,true);assert.equal(s.state,'review-required');assert.equal(s.action,'prepare');
  block={blockhash:address(),lastValidBlockHeight:400,observedSlot:60};
  const offer3=await approve(closed,two);assert.notEqual(offer3.result.offerId,offer2.result.offerId);assert.equal(offer3.result.review.feeNft,intent2.fundingFirst.feeNft);
  assert.deepEqual(await closed.mintPlans.load(two),intent2,'the sealed intent, its quote, reserve and fee NFT are unchanged by the flag');
  await closed.flow.resume(owner,{requestId:two});
  const second=await closed.mintApprovals.read(two);assert.equal(second.attempt,2);assert.equal(second.status,'signed');assert.notEqual(second.signature,first.signature);
  assert.deepEqual(custodySteps(intent2.mint),['opening:0','opening:1'],'the custody chained its second opening signature on the first');
  const stx=VersionedTransaction.deserialize(Buffer.from(second.signedBase64,'base64')),m2=Buffer.from(stx.message.serialize());
  assert.ok(verifySignature(owner,m2,stx.signatures[0])&&verifySignature(intent2.mint,m2,stx.signatures[1])&&verifySignature(intent2.fundingFirst.feeNft,m2,stx.signatures[2]));
  assert.equal(sends.length,3);assert.equal(sends[2],second.signature);
  statuses.set(second.signature,{confirmationStatus:'finalized',slot:305,err:null});landed.set(intent2.campaign,intent2);
  await closed.flow.resume(owner,{requestId:two});await closed.flow.resume(owner,{requestId:two});await closed.flow.resume(owner,{requestId:two});
  s=await closed.flow.status(owner,{requestId:two});assert.equal(s.stage,'complete');assert.equal(s.state,'funded');assert.equal(s.signatures.launch,second.signature);assert.equal(s.signatures['operating-reserve'],second.signature);assert.equal(await receipts(second.signature),1);assert.equal(await receipts(first.signature),0,'the expired opening credited nothing');
  assert.equal(mintIntentHash(await closed.mintPlans.load(two)),mintIntentHash(intent2));
  // --- A new request under the flag turned off seals a version-2 plan: no custody key is reserved for it.
  const three=await accept('three','Third round','THIRD');
  const s3=await reach(closed,three);assert.equal(s3.fundingFirst,false);const intent3=await closed.mintPlans.load(three);assert.equal(intent3.version,2);
  assert.equal(inventory.fundingFirstCustody(intent3.mint),null);assert.equal(inventory.db.prepare('SELECT COUNT(*) n FROM kids_fee_nft_keys').get().n,2);
  assert.equal((await closed.flow.prepare(owner,{requestId:three})).result.review.accounting,undefined);
 }finally{try{inventory?.close();}catch{}if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();rmSync(dir,{recursive:true,force:true});}
});
