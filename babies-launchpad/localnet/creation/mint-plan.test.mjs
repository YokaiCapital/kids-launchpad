import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {createCreationStore} from './store.mjs';
import {createPreparationService} from './preparation.mjs';
import {createMintLeases} from '../mints/leases.mjs';
import {fakeInventory} from '../test/helpers/mint-inventory-fixture.mjs';
import {createMetadataPublisher} from './publication.mjs';
import {createMintPlanService} from './mint-plan.mjs';
import {contentHash} from './pinata.mjs';
import {PINATA_GATEWAY} from '../token-metadata.mjs';
import {createMintApprovalJournal} from './mint-approval.mjs';
import {createMintWalletService} from './mint-wallet.mjs';
import {createLocalCreatorServices} from './services.mjs';
import {provisionFixture} from '../test/helpers/provision-fixture.mjs';
import {encodeBase58} from '../../shared/solana.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,address=()=>Keypair.generate().publicKey.toBase58();
test('immutable shared mint plan binds accepted artwork, publication receipts and reserved custody', {skip:!url},async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const creator=Keypair.generate(),owner=creator.publicKey.toBase58(),config={mode:'localnet-rehearsal',programVersion:3,rpcUrl:'http://127.0.0.1:19199',pilotCreator:owner,genesisHash:address(),programId:address(),policyHash:'a'.repeat(64),planHash:'b'.repeat(64)};
  let genesis=config.genesisHash,rent=1461600;
  const connection={rpcEndpoint:config.rpcUrl,getGenesisHash:async()=>genesis,getMinimumBalanceForRentExemption:async size=>{assert.equal(size,82);return rent;}};
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]),sha=contentHash(bytes),draft={name:'Local coin',symbol:'LocalCoin',description:'Creator-approved text.',pfp:{assetId:'owned-pfp',sha256:sha}};
  await registry.drafts.save({creator:owner,id:'one',revision:0,body:draft});const store=createCreationStore(registry);
  const q=await store.issue({owner,draftId:'one',revision:1,draftHash:canonicalHash(draft),descriptorHash:canonicalHash(config),requestKey:'one',body:{genesisHash:config.genesisHash,programId:config.programId,policyHash:config.policyHash,planHash:config.planHash,terms:provisionFixture().quote.terms,costs:{lines:[{item:'mint account rent',lamports:'1461600'}]},authorityFunding:{amountLamports:'300000000'},fundingEnabled:false,publicationConsent:true}});
  const request=await store.accept({owner,quoteId:q.id});
  const inventory=fakeInventory({stock:['7e2g1HXJQPCMLED6PQZhHwzYw9iGemwPuUc5FAFMkids','DCCMCL6DKH8X7MKr1xmHUcXrGwkybiUHipRDMHhakids']}),leases=createMintLeases({registry,inventory});
  const prepared=await createPreparationService({registry,connection,config,mintLeases:leases}).prepare(owner,{draftId:'one'});
  let pins=0;
  const receipt=input=>{const cid='Qm'+(input.stage==='image'?'a':'b').repeat(44);return {cid,uri:PINATA_GATEWAY+cid,inputHash:input.inputHash};};
  const publisher=createMetadataPublisher({registry,config,limits:{ownerPins:4,globalPins:4,ownerBytes:10000,globalBytes:10000},loadOwnedImage:async()=>({owner,assetId:'owned-pfp',sanitized:true,sha256:sha,bytes,contentType:'image/png'}),provider:{publish:async input=>{pins++;return receipt(input);},recover:async input=>receipt(input)}});
  const open=extra=>createMintPlanService({registry,connection,config,publisher,...extra});
  await t.test('foreign owner, wrong ledger and fabricated provider receipt cannot seal',async()=>{
   await assert.rejects(open().seal(address(),request.id));genesis=address();await assert.rejects(open().seal(owner,request.id),/ledger/);genesis=config.genesisHash;assert.equal(pins,0);
   const forged={status:'published',requestId:request.id,owner,metadata:{name:draft.name,symbol:draft.symbol,uri:PINATA_GATEWAY+'Qm'+'b'.repeat(44),documentHash:'d'.repeat(64)}};
   await assert.rejects(open({publisher:{publish:async()=>forged}}).seal(owner,request.id),{code:'IDEMPOTENCY_CONFLICT'});
   assert.equal(Number((await registry.query('SELECT COUNT(*) n FROM creation_mint_plans')).rows[0].n),0);
  });
  let intent;
  await t.test('parallel replicas seal one exact immutable plan, then load after restart',async()=>{
   const results=await Promise.all(Array.from({length:10},()=>open().seal(owner,request.id)));
   assert.ok(results.every(r=>r.status==='sealed'));assert.equal(new Set(results.map(r=>canonicalHash(r.intent))).size,1);intent=results[0].intent;
   assert.equal(intent.mint,prepared.mint);assert.equal(intent.campaign,prepared.campaign);assert.equal(intent.metadata.name,draft.name);assert.equal(intent.metadata.symbol,'LocalCoin');assert.equal(pins,2);
   assert.deepEqual(await open().load(request.id),intent);assert.equal(Number((await registry.query('SELECT COUNT(*) n FROM creation_mint_plans')).rows[0].n),1);
   rent=9999999;assert.deepEqual((await open().seal(owner,request.id)).intent,intent,'rent is sealed, not silently refreshed');
  });
  await t.test('a one-transaction seal binds the reserve to the accepted quote, not to the currently configured amount',async()=>{
   const draft2={...draft,name:'Second coin',symbol:'SecondCoin',start:'after-creation'};await registry.drafts.save({creator:owner,id:'two',revision:0,body:draft2});
   const q2=await store.issue({owner,draftId:'two',revision:1,draftHash:canonicalHash(draft2),descriptorHash:canonicalHash({...config,two:true}),requestKey:'two',body:{genesisHash:config.genesisHash,programId:config.programId,policyHash:config.policyHash,planHash:config.planHash,terms:provisionFixture().quote.terms,operatingReserveLamports:'100000000',authorityFunding:{amountLamports:'300000000'},publicationConsent:true,fundingEnabled:false}});
   const request2=await store.accept({owner,quoteId:q2.id});await createPreparationService({registry,connection,config,mintLeases:leases}).prepare(owner,{draftId:'two'});
   const one={...config,oneTransaction:true,operatingPayer:address(),operatingReserveLamports:'200000000',treasury:address(),priorityFeeLamports:'10000'};
   const sealed=await open({config:one}).seal(owner,request2.id);assert.equal(sealed.status,'sealed');assert.equal(sealed.intent.version,2);
   assert.equal(sealed.intent.launch.reserve.lamports,'100000000','the accepted amount, although 200000000 is configured now');assert.equal(sealed.intent.launch.reserve.payer,one.operatingPayer);
  });
  await t.test('local composition resumes the sealed plan without invoking the signer or enabling funding',async()=>{
   let signatures=0;const wrapped=Object.create(inventory);wrapped.assetMintSigner=()=>async()=>{signatures++;throw Error('Unexpected signature');};
   const composed=createLocalCreatorServices({registry,connection,config:{...config,treasury:address()},inventory:wrapped,publisher});
   const status=await composed.flow.status(owner,{requestId:request.id});assert.equal(status.stage,'mint');assert.equal(status.action,'prepare');assert.equal(status.mint,intent.mint);assert.equal(status.fundingEnabled,false);assert.equal(signatures,0);
   assert.throws(()=>createLocalCreatorServices({registry,connection,config:{...config,mode:'mainnet'},inventory:wrapped,publisher}));
  });
  await t.test('wallet replicas share one server offer, replace only unsigned offers and atomically reject superseded approval',async()=>{
   let valid=true,block={blockhash:address(),lastValidBlockHeight:150,observedSlot:50};connection.getLatestBlockhash=async()=>block;connection.getLatestBlockhashAndContext=async()=>({context:{slot:50},value:await connection.getLatestBlockhash()});connection.isBlockhashValid=async()=>({value:valid});
   const approvals=()=>createMintApprovalJournal({registry,mintLeases:leases,connection,config,loadIntent:id=>open().load(id)});
   const wallet=()=>createMintWalletService({registry,connection,config,plans:open(),approvals:approvals()});
   const sign=offer=>{const tx=VersionedTransaction.deserialize(Buffer.from(offer.transactionBase64,'base64'));tx.sign([creator]);return Buffer.from(tx.serialize()).toString('base64');};
   const offers=await Promise.all(Array.from({length:10},()=>wallet().prepare(owner,{requestId:request.id})));
   assert.equal(new Set(offers.map(x=>x.offerId)).size,1);const first=offers[0];assert.equal(first.review.mint,intent.mint);assert.equal(first.review.freezeAuthorityAfter,null);
   connection.getBlockHeight=async()=>140;block={blockhash:address(),lastValidBlockHeight:300,observedSlot:50};
   const fresh=await wallet().prepare(owner,{requestId:request.id});assert.notEqual(fresh.offerId,first.offerId,'an almost-expired unsigned offer is refreshed before prompting');delete connection.getBlockHeight;
   await assert.rejects(wallet().prepare(address(),{requestId:request.id}));
   connection.isBlockhashValid=async()=>({});await assert.rejects(wallet().prepare(owner,{requestId:request.id}),/validity/);connection.isBlockhashValid=async()=>({value:valid});
   valid=false;block={blockhash:address(),lastValidBlockHeight:200,observedSlot:50};const second=await wallet().prepare(owner,{requestId:request.id});assert.notEqual(first.offerId,second.offerId);
   await assert.rejects(wallet().submit(owner,{requestId:request.id,offerId:first.offerId,transactionBase64:sign(first)}),{code:'IDEMPOTENCY_CONFLICT'});
   let entered,release;const enteredPromise=new Promise(r=>entered=r),hold=new Promise(r=>release=r);let once=true;
   connection.isBlockhashValid=async()=>{if(once){once=false;entered();return hold;}return {value:false};};
   const stale=assert.rejects(wallet().submit(owner,{requestId:request.id,offerId:second.offerId,transactionBase64:sign(second)}),{code:'IDEMPOTENCY_CONFLICT'});
   await enteredPromise;block={blockhash:address(),lastValidBlockHeight:250,observedSlot:50};const third=await wallet().prepare(owner,{requestId:request.id});release({value:true});await stale;
   assert.equal(await approvals().find(request.id),null);assert.equal((await registry.mintLeases.get(prepared.leaseId)).state,'reserved');
   valid=true;connection.isBlockhashValid=async()=>({value:valid});
   const signed=sign(third),input={requestId:request.id,offerId:third.offerId,transactionBase64:signed,block:{blockhash:address(),lastValidBlockHeight:1,observedSlot:50}};
   const accepted=await Promise.all(Array.from({length:10},()=>wallet().submit(owner,input)));assert.ok(accepted.every(x=>x.action==='resume'&&x.state==='prepared'));
   assert.deepEqual((await approvals().find(request.id)).prepared.block,third.block,'browser-supplied block is ignored');
   assert.equal(Number((await registry.query('SELECT COUNT(*) n FROM operator_packets')).rows[0].n),1);
   assert.equal((await wallet().prepare(owner,{requestId:request.id})).action,'resume');
   valid=false;assert.equal((await wallet().submit(owner,input)).state,'prepared','duplicate approved submission survives block expiry');
   await assert.rejects(wallet().submit(owner,{...input,transactionBase64:third.transactionBase64}),/approval/);
  });
  await t.test('proof-authorized retry presents a fresh offer for the same mint and rejects stale approval',async()=>{
   const approvals=createMintApprovalJournal({registry,mintLeases:leases,connection,config,loadIntent:id=>open().load(id)}),row=await approvals.read(request.id);
   const tx=VersionedTransaction.deserialize(Buffer.from(row.prepared.creatorPacket,'base64')),signature=encodeBase58(tx.signatures[0]),digest=createHash('sha256').update(tx.message.serialize()).digest('hex');
   // Synthetic terminal/signature boundary. Recovery proof rules and real
   // signatures are qualified separately; this test exercises wallet offers.
   await registry.operatorPackets.sign({operationId:row.operationId,attempt:row.attempt,signedBase64:row.prepared.creatorPacket,signature});
   await leases.recordSignature({leaseId:prepared.leaseId,messageDigest:digest,signature});
   await registry.operatorPackets.progress({operationId:row.operationId,attempt:row.attempt,from:'signed',to:'expired'});
   await registry.query('INSERT INTO creation_mint_retries(request_id,generation,owner,intent_hash,operation_id,previous_message_hash,previous_signature,evidence_json,created_at) VALUES(?,1,?,?,?,?,?,?,1)',[request.id,owner,canonicalHash(intent),row.operationId,digest,signature,'{"testOnly":true}']);
   const wallet=()=>createMintWalletService({registry,connection,config,plans:open(),approvals});
   assert.equal((await wallet().status(owner,{requestId:request.id})).state,'review-required');
   connection.getLatestBlockhash=async()=>({blockhash:address(),lastValidBlockHeight:500,observedSlot:50});connection.getLatestBlockhashAndContext=async()=>({context:{slot:50},value:await connection.getLatestBlockhash()});connection.isBlockhashValid=async()=>({value:true});
   const offers=await Promise.all(Array.from({length:8},()=>wallet().prepare(owner,{requestId:request.id})));assert.equal(new Set(offers.map(o=>o.offerId)).size,1);
   const offer=offers[0];assert.equal(offer.action,'sign-mint');assert.equal(offer.review.mint,intent.mint);assert.equal(offer.review.creator,owner);
   const retry=VersionedTransaction.deserialize(Buffer.from(offer.transactionBase64,'base64'));retry.sign([creator]);
   await wallet().submit(owner,{requestId:request.id,offerId:offer.offerId,transactionBase64:Buffer.from(retry.serialize()).toString('base64')});
   assert.equal((await approvals.read(request.id)).attempt,2);assert.equal((await wallet().status(owner,{requestId:request.id})).action,'resume');
   const old=(await registry.query("SELECT offer_id FROM creation_mint_offers WHERE request_id=? AND block_json=?",[request.id,canonicalJson(row.prepared.block)])).rows[0];
   await assert.rejects(wallet().submit(owner,{requestId:request.id,offerId:old.offer_id,transactionBase64:row.prepared.creatorPacket}));
  });
  await t.test('signing and consumed lease retain the plan; source mutation or changed policy refuses reads',async()=>{
   const preparation=createPreparationService({registry,connection,config,mintLeases:leases});
   assert.equal((await preparation.prepare(owner,{draftId:'one'})).reason,'mint-signing');assert.deepEqual(await open().load(request.id),intent);
   const approvals=createMintApprovalJournal({registry,mintLeases:leases,connection,config,loadIntent:id=>open().load(id)}),approved=await approvals.find(request.id);
   const signature=encodeBase58(VersionedTransaction.deserialize(Buffer.from(approved.prepared.creatorPacket,'base64')).signatures[0]);
   // Synthetic completed worker boundary, not cryptographic or chain evidence.
   await registry.operatorPackets.sign({operationId:approved.operationId,attempt:approved.attempt,signedBase64:approved.prepared.creatorPacket,signature});
   await registry.operatorPackets.progress({operationId:approved.operationId,attempt:approved.attempt,from:'signed',to:'finalized',result:{testOnly:true}});
   await leases.recordSignature({leaseId:prepared.leaseId,messageDigest:(await registry.mintLeases.get(prepared.leaseId)).messageDigest,signature});
   await leases.markConsumed({leaseId:prepared.leaseId,signature});assert.equal((await preparation.status(owner,{draftId:'one'})).reason,'mint-created');assert.equal((await preparation.prepare(owner,{draftId:'one'})).reason,'mint-created');assert.deepEqual(await open().load(request.id),intent);
   const wallet=createMintWalletService({registry,connection,config,plans:open(),approvals}),offer=(await registry.query("SELECT offer_id FROM creation_mint_offers WHERE request_id=? AND state='approved' AND block_json=?",[request.id,canonicalJson(approved.prepared.block)])).rows[0];
   const retried=await wallet.submit(owner,{requestId:request.id,offerId:offer.offer_id,transactionBase64:approved.prepared.creatorPacket});assert.equal(retried.state,'finalized');assert.equal(retried.signature,signature);
   // A changed ACTIVE policy does not strand an accepted plan (it is read under its quoted policy); another ledger still refuses.
   assert.ok(await open({config:{...config,policyHash:'e'.repeat(64)}}).load(request.id));await assert.rejects(open({config:{...config,genesisHash:address()}}).load(request.id));
   const original=(await registry.query('SELECT body FROM creation_requests WHERE request_id=?',[request.id])).rows[0].body;
   const changed=JSON.parse(original);changed.draft.name='Other';await registry.query('UPDATE creation_requests SET body=? WHERE request_id=?',[JSON.stringify(changed),request.id]);await assert.rejects(open().load(request.id));await registry.query('UPDATE creation_requests SET body=? WHERE request_id=?',[original,request.id]);
   await registry.query("UPDATE creation_publications SET input_hash=? WHERE request_id=? AND stage='document'",['f'.repeat(64),request.id]);await assert.rejects(open().load(request.id));
  });
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
