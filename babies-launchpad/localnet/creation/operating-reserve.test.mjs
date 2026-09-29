// Real PostgreSQL journal and ledger with a mocked loopback ledger: the creator's reserve transfer is offered exactly,
// signed only by the creator, broadcast with the same bytes, and credited once on finalized balance evidence.
import test from 'node:test';
import {canonicalHash} from '../registry/canonical.mjs';
import {createCreationStore} from './store.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {Keypair,PublicKey,VersionedTransaction,TransactionMessage} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {createOperatingLedger} from './operating-ledger.mjs';
import {createOperatingProofReader} from './operating-proofs.mjs';
import {createOperatingReserveService,loadOperatingFundingPacket,operatingReserveOperationId,OPERATING_RESERVE_POLICY} from './operating-reserve.mjs';
import {encodeBase58} from '../../shared/solana.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
function world(registry,{campaign,creator,payer,genesisHash,programId,requestId='request-one',loadAccepted=null}){
 const owner=creator.publicKey.toBase58(),rpcUrl='http://127.0.0.1:19199';
 const w={blockhashValid:true,seq:0,statuses:new Map(),sent:[],finalized:null,epoch:{blockHeight:100,absoluteSlot:1000}};
 const connection={rpcEndpoint:rpcUrl,getGenesisHash:async()=>genesisHash,
  getLatestBlockhashAndContext:async()=>({context:{slot:50+w.seq},value:{blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:150+(w.seq++)}}),
  isBlockhashValid:async()=>({value:w.blockhashValid}),
  sendRawTransaction:async raw=>{const tx=VersionedTransaction.deserialize(raw);w.sent.push(Buffer.from(raw).toString('base64'));return encodeBase58(tx.signatures[0]);},
  getSignatureStatuses:async([sig])=>({context:{slot:w.epoch.absoluteSlot},value:[w.statuses.get(sig)??null]}),
  getEpochInfo:async()=>w.epoch,getFirstAvailableBlock:async()=>0,
  getTransaction:async sig=>w.finalized?.signature===sig?w.finalized.reply:null};
 const config={mode:'localnet-rehearsal',programVersion:3,rpcUrl,genesisHash,programId,pilotCreator:owner,treasury:payer,operatingPayer:payer,operatingReserveLamports:'100000000'};
 const never=async()=>{throw Error('creator services never reconcile keeper spends');};
 const proofs=createOperatingProofReader({connection,genesisHash,loadFundingPacket:loadOperatingFundingPacket(registry),loadSpendPacket:never});
 const ledger=createOperatingLedger({registry,verifyFunding:proofs.verifyFunding,verifyOutcome:never});
 const service=createOperatingReserveService({registry,connection,config,ledger,loadCampaign:async(o,id)=>id===requestId?registry.campaigns.get({genesisHash,programId,campaign}):null,...(loadAccepted?{loadAccepted}:{})});
 return {...w,owner,connection,config,ledger,service,binding:{genesisHash,programId,campaign,payer,policy:OPERATING_RESERVE_POLICY},set:patch=>Object.assign(w,patch),state:w};
}
test('operating reserve: exact creator transfer, durable offer, one signature, finalized credit into the operating ledger',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1}),pools=[];
 try{
  await control.query(`CREATE SCHEMA ${schema}`);const pool=new pg.Pool({connectionString:url,max:6,options:`-c search_path=${schema}`});pools.push(pool);const registry=new PostgresRegistry({pool});await registry.migrate();
  const creator=Keypair.generate(),payer=Keypair.generate().publicKey.toBase58(),genesisHash=addr(1),programId=addr(2),campaign=addr(3);
  await registry.campaigns.upsert({genesisHash,programId,campaign,creator:creator.publicKey.toBase58(),mint:addr(9),mode:'standard',campaignVersion:3,registryStatus:'planned'});
  // The persisted accepted request, through the real store: the default stored-quote reader binds the amount to it.
  const owner0=creator.publicKey.toBase58(),store=createCreationStore(registry);await registry.drafts.save({creator:owner0,id:'draft-one',revision:0,body:{name:'Reserve coin'}});
  const q=await store.issue({owner:owner0,draftId:'draft-one',revision:1,draftHash:canonicalHash({name:'Reserve coin'}),descriptorHash:'c'.repeat(64),requestKey:'request-one',body:{genesisHash,programId,operatingReserveLamports:'100000000',policyHash:'a'.repeat(64),planHash:'b'.repeat(64)}});
  const request=await store.accept({owner:owner0,quoteId:q.id});
  const w=world(registry,{campaign,creator,payer,genesisHash,programId,requestId:request.id}),{owner,service,ledger,binding,state}=w,input={requestId:request.id};
  assert.throws(()=>createOperatingReserveService({registry,connection:w.connection,config:{...w.config,operatingPayer:owner},ledger,loadCampaign:async()=>null}),/cannot be the creator/);
  await assert.rejects(service.prepare('foreign',input));await assert.rejects(service.prepare(owner,{requestId:'other'}));
  assert.deepEqual(await service.status(owner,input),{requestId:request.id,stage:'operating-reserve',payer,lamports:'100000000',campaign,policy:'creator-funded-v1',status:'awaiting-approval',action:'prepare',signature:null,attempt:0});
  const offer=await service.prepare(owner,input);assert.equal(offer.action,'sign-operating-reserve');assert.equal(offer.attempt,1);assert.equal(offer.review.payer,payer);assert.match(offer.review.memo,/^KIDS operating:[a-f0-9]{64}$/);
  const tx=VersionedTransaction.deserialize(Buffer.from(offer.transactionBase64,'base64')),message=TransactionMessage.decompile(tx.message);
  assert.equal(String(message.payerKey),owner);assert.equal(message.instructions.length,2);assert.equal(String(message.instructions[0].keys[1].pubkey),payer);assert.equal(message.instructions[1].data.toString(),offer.review.memo);
  const again=await service.prepare(owner,input);assert.equal(again.offerId,offer.offerId);assert.equal(again.transactionBase64,offer.transactionBase64);
  // A later change of the configured amount never rewrites this journal: a service restarted with 200000000 configured serves
  // the identical offer for the request accepted at 100000000, and the new amount only to a request accepted at it.
  const campaign2=addr(4);await registry.campaigns.upsert({genesisHash,programId,campaign:campaign2,creator:owner,mint:addr(10),mode:'standard',campaignVersion:3,registryStatus:'planned'});
  const later=createOperatingReserveService({registry,connection:w.connection,config:{...w.config,operatingReserveLamports:'200000000'},ledger,loadCampaign:async(o,id)=>registry.campaigns.get({genesisHash,programId,campaign:id==='request-two'?campaign2:campaign}),loadAccepted:async(o,id)=>({operatingReserveLamports:id==='request-two'?'200000000':'100000000'})});
  const same=await later.prepare(owner,input);assert.equal(same.offerId,offer.offerId);assert.equal(same.transactionBase64,offer.transactionBase64);assert.equal(same.lamports,'100000000');assert.equal((await later.status(owner,input)).lamports,'100000000');
  assert.equal((await later.status(owner,{requestId:'request-two'})).lamports,'200000000');
  const forged=VersionedTransaction.deserialize(Buffer.from(offer.transactionBase64,'base64'));forged.signatures[0]=new Uint8Array(64).fill(7);
  await assert.rejects(service.submit(owner,{...input,offerId:offer.offerId,transactionBase64:Buffer.from(forged.serialize()).toString('base64')}),/does not match/);
  tx.sign([creator]);const signed=Buffer.from(tx.serialize()).toString('base64'),signature=encodeBase58(tx.signatures[0]);
  const submitted=await service.submit(owner,{...input,offerId:offer.offerId,transactionBase64:signed});assert.equal(submitted.status,'signed');assert.equal(submitted.signature,signature);assert.deepEqual(state.sent,[signed]);
  assert.equal((await service.submit(owner,{...input,offerId:offer.offerId,transactionBase64:signed})).status,'signed');assert.deepEqual(state.sent,[signed,signed],'a resubmission re-broadcasts the same bytes only');
  await assert.rejects(service.submit(owner,{...input,offerId:offer.offerId,transactionBase64:Buffer.from(forged.serialize()).toString('base64')}));
  assert.equal((await service.prepare(owner,input)).status,'signed','no second offer while a signed packet is in flight');
  let r=await service.resume(owner,input);assert.equal(r.status,'pending');assert.equal(r.reason,'submitted');assert.equal(state.sent.length,3);assert.equal(state.sent[2],signed);
  state.statuses.set(signature,{confirmationStatus:'confirmed',err:null,slot:60});r=await service.resume(owner,input);assert.equal(r.reason,'awaiting-finality');assert.equal((await service.status(owner,input)).status,'confirmed');
  const keys=tx.message.staticAccountKeys.map(String),n=100000000,fee=5000,pre=keys.map(()=>0),post=keys.map(()=>0);pre[0]=1000000000;post[0]=1000000000-n-fee;pre[1]=500000;post[1]=500000+n;
  state.statuses.set(signature,{confirmationStatus:'finalized',err:null,slot:61});
  state.finalized={signature,reply:{slot:61,transaction:{message:tx.message,signatures:[signature]},meta:{err:null,fee,preBalances:pre,postBalances:post}}};
  r=await service.resume(owner,input);assert.equal(r.status,'credited');assert.equal(r.signature,signature);
  const balance=await ledger.balance(binding);assert.equal(balance.fundedLamports,'100000000');assert.equal(balance.availableLamports,'100000000');
  assert.equal((await service.resume(owner,input)).status,'credited');assert.equal((await service.status(owner,input)).status,'credited');assert.equal((await service.prepare(owner,input)).status,'credited');
  assert.equal((await ledger.balance(binding)).fundedLamports,'100000000','a second resume never credits twice');
  const packet=await loadOperatingFundingPacket(registry)(binding);assert.equal(packet.signature,signature);assert.equal(packet.transactionBase64,signed);assert.equal(packet.binding.creator,owner);
  assert.equal(operatingReserveOperationId(binding),offer.offerId.split(':')[0]);
  // Restart under changed settings (reserve 200000000, other policy and plan) with the DEFAULT stored-quote reader: the persisted,
  // finalized request keeps its accepted amount, signature and packet; status, resume and prepare are idempotent; nothing is
  // credited or broadcast again; no new offer.
  const restarted=createOperatingReserveService({registry,connection:w.connection,config:{...w.config,operatingReserveLamports:'200000000',policyHash:'e'.repeat(64),planHash:'f'.repeat(64)},ledger,loadCampaign:async(o,id)=>id===request.id?registry.campaigns.get({genesisHash,programId,campaign}):null});
  const after=await restarted.status(owner,input);assert.equal(after.status,'credited');assert.equal(after.lamports,'100000000');assert.equal(after.signature,signature);
  assert.equal((await restarted.resume(owner,input)).status,'credited');assert.equal((await restarted.prepare(owner,input)).status,'credited');assert.equal((await restarted.status(owner,input)).lamports,'100000000');
  assert.equal((await ledger.balance(binding)).fundedLamports,'100000000','the restarted service credits nothing twice');assert.equal(state.sent.length,3,'the restarted service broadcasts nothing');
  const packetAfter=await loadOperatingFundingPacket(registry)(binding);assert.equal(packetAfter.signature,signature);assert.equal(packetAfter.transactionBase64,signed);
  assert.equal(Number((await registry.query('SELECT COUNT(*) n FROM operator_packets')).rows[0].n),1,'one journal row, no new offer');
 }finally{for(const p of pools)await p.end();await control.query(`DROP SCHEMA ${schema} CASCADE`);await control.end();}
});
test('operating reserve: an unsigned offer whose blockhash expired is superseded; a signed packet that expires needs explicit recovery and a fresh attempt',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1}),pools=[];
 try{
  await control.query(`CREATE SCHEMA ${schema}`);const pool=new pg.Pool({connectionString:url,max:6,options:`-c search_path=${schema}`});pools.push(pool);const registry=new PostgresRegistry({pool});await registry.migrate();
  const creator=Keypair.generate(),payer=Keypair.generate().publicKey.toBase58(),genesisHash=addr(1),programId=addr(2),campaign=addr(4);
  await registry.campaigns.upsert({genesisHash,programId,campaign,creator:creator.publicKey.toBase58(),mint:addr(9),mode:'standard',campaignVersion:3,registryStatus:'planned'});
  const w=world(registry,{campaign,creator,payer,genesisHash,programId,loadAccepted:async()=>({operatingReserveLamports:'100000000'})}),{owner,service,state}=w,input={requestId:'request-one'};
  const first=await service.prepare(owner,input);assert.equal(first.attempt,1);
  state.blockhashValid=false;const second=await service.prepare(owner,input);assert.equal(second.attempt,2);assert.notEqual(second.offerId,first.offerId);
  const stale=VersionedTransaction.deserialize(Buffer.from(first.transactionBase64,'base64'));stale.sign([creator]);
  await assert.rejects(service.submit(owner,{...input,offerId:first.offerId,transactionBase64:Buffer.from(stale.serialize()).toString('base64')}),/changed/);
  const tx=VersionedTransaction.deserialize(Buffer.from(second.transactionBase64,'base64'));tx.sign([creator]);const signed=Buffer.from(tx.serialize()).toString('base64');
  assert.equal((await service.submit(owner,{...input,offerId:second.offerId,transactionBase64:signed})).status,'signed');
  state.epoch={blockHeight:1000,absoluteSlot:5000};
  const expired=await service.resume(owner,input);assert.equal(expired.status,'expired');assert.equal(expired.action,'recover');
  assert.equal((await service.resume(owner,input)).status,'expired','expiry is final for that attempt');
  state.blockhashValid=true;const fresh=await service.recover(owner,input);assert.equal(fresh.status,'awaiting-approval');assert.equal(fresh.attempt,3);assert.equal(fresh.action,'sign-operating-reserve');
  assert.equal((await service.status(owner,input)).attempt,3);
 }finally{for(const p of pools)await p.end();await control.query(`DROP SCHEMA ${schema} CASCADE`);await control.end();}
});
