import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {createCreationStore} from './store.mjs';
import {provisionFixture,provisionAccounts} from '../test/helpers/provision-fixture.mjs';
import {createProvisionExecutor} from './provision-execution.mjs';
import {createProvisionWalletService} from './provision-wallet.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,address=()=>Keypair.generate().publicKey.toBase58();
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
test('owned setup offers use durable approval and one refresh lock across replicas',{skip:!url},async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:12,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  async function fixture(){
   const {creator,intent,block}=provisionFixture(),owner=intent.mint.creator,draftId=randomUUID(),draft={name:'Local coin'};
   await registry.drafts.save({creator:owner,id:draftId,revision:0,body:draft});const store=createCreationStore(registry),q=await store.issue({owner,draftId,revision:1,requestKey:draftId,draftHash:canonicalHash(draft),descriptorHash:'a'.repeat(64),body:{}}),request=await store.accept({owner,quoteId:q.id});intent.mint.requestId=request.id;
   const response=provisionAccounts(intent),base={requestId:request.id,stage:'native-custody'},expired=new Set();let next=block,status=null,clock=2000000000n,height=100,readHook=null,genesis=intent.mint.genesisHash,sends=0;
   const connection={rpcEndpoint:'http://127.0.0.1:19199',getGenesisHash:async()=>genesis,getLatestBlockhash:async()=>next,getLatestBlockhashAndContext:async()=>({context:{slot:50},value:next}),isBlockhashValid:async hash=>({value:!expired.has(hash)}),getFirstAvailableBlock:async()=>1,getSignatureStatuses:async()=>({context:{slot:110},value:[status]}),getEpochInfo:async()=>({blockHeight:height,absoluteSlot:110}),getMinimumBalanceForRentExemption:async()=>8000000,
    sendRawTransaction:async()=>{sends++;throw Error('synthetic lost response');},
    getMultipleAccountsInfoAndContext:async(keys,opts)=>{
     if(readHook)await readHook();
     if(opts.minContextSlot!==undefined)return keys.length===1?{context:response.context,value:[response.value[2]]}:response;
     const c=Buffer.alloc(40);c.writeBigInt64LE(clock,32);
     if(keys.length===1)return {context:response.context,value:[{data:c}]};
     return {context:response.context,value:[...response.value.slice(3),{data:c},...(keys.length===6?[response.value[2],null]:[])]};
    }};
   const config={mode:'localnet-rehearsal',programVersion:3,rpcUrl:connection.rpcEndpoint,genesisHash:genesis,programId:intent.mint.programId,pilotCreator:owner,treasury:intent.treasury},plans={load:async()=>intent};
   const executor=()=>createProvisionExecutor({registry,connection,config,loadIntent:plans.load});
   const open=extra=>createProvisionWalletService({registry,connection,config,plans,executor:executor(),...extra});
   const signed=offer=>{const tx=VersionedTransaction.deserialize(Buffer.from(offer.transactionBase64,'base64'));tx.sign([creator]);return {...base,stage:offer.stage,offerId:offer.offerId,transactionBase64:Buffer.from(tx.serialize()).toString('base64')};};
   const finalizeNative=async()=>{const offer=await open().prepare(owner,base);await open().submit(owner,signed(offer));status={confirmationStatus:'finalized',slot:100,err:null};assert.equal((await open().resume(owner,base)).status,'complete');status=null;};
   return {owner,intent,base,connection,open,executor,signed,finalizeNative,expired,get sends(){return sends;},set next(v){next=v;},set status(v){status=v;},set clock(v){clock=v;},set height(v){height=v;},set readHook(v){readHook=v;},set genesis(v){genesis=v;}};
  }
  await t.test('parallel preparation converges; approval retries ignore caller expiry and never broadcast',async()=>{
   const f=await fixture(),offers=await Promise.all(Array.from({length:10},()=>f.open().prepare(f.owner,f.base)));assert.equal(new Set(offers.map(o=>o.offerId)).size,1);assert.equal(offers[0].block,undefined);
   const input={...f.signed(offers[0]),block:{blockhash:address(),lastValidBlockHeight:999999,observedSlot:50}};
   const results=await Promise.all(Array.from({length:10},()=>f.open().submit(f.owner,input)));assert.equal(new Set(results.map(r=>r.signature)).size,1);assert.equal(results[0].status,'signed');assert.equal(f.sends,0);
   f.expired.add(VersionedTransaction.deserialize(Buffer.from(offers[0].transactionBase64,'base64')).message.recentBlockhash);
   assert.equal((await f.open().submit(f.owner,input)).signature,results[0].signature);assert.equal((await f.open().prepare(f.owner,f.base)).action,'resume');
   const rows=(await registry.query('SELECT state FROM creation_provision_offers WHERE request_id=?',[f.base.requestId])).rows;assert.deepEqual(rows.map(r=>r.state),['approved']);
  });
  await t.test('owner, stage, signature and transaction mutations fail closed',async()=>{
   const f=await fixture(),offer=await f.open().prepare(f.owner,f.base),input=f.signed(offer);
   for(const method of ['prepare','submit','status','resume'])await assert.rejects(f.open()[method](address(),input));
   await assert.rejects(f.open().submit(f.owner,{...input,stage:'create-campaign'}));
   await assert.rejects(f.open().submit(f.owner,{...input,transactionBase64:offer.transactionBase64}));
   const tx=VersionedTransaction.deserialize(Buffer.from(input.transactionBase64,'base64'));tx.message.recentBlockhash=address();await assert.rejects(f.open().submit(f.owner,{...input,transactionBase64:Buffer.from(tx.serialize()).toString('base64')}));assert.equal(f.sends,0);
  });
  await t.test('unsigned expiry refresh supersedes stale wallet; in-flight old approval loses the lock race',async()=>{
   const f=await fixture(),offer=await f.open().prepare(f.owner,f.base),entered=deferred(),release=deferred();
   f.readHook=async()=>{entered.resolve();await release.promise;};
   const pending=f.open().submit(f.owner,f.signed(offer));const rejected=assert.rejects(pending,{code:'IDEMPOTENCY_CONFLICT'});await entered.promise;
   f.expired.add(VersionedTransaction.deserialize(Buffer.from(offer.transactionBase64,'base64')).message.recentBlockhash);f.next={blockhash:address(),lastValidBlockHeight:300,observedSlot:50};
   const newer=await f.open().prepare(f.owner,f.base);assert.notEqual(newer.offerId,offer.offerId);release.resolve();await rejected;f.readHook=null;
   assert.equal((await f.open().status(f.owner,f.base)).status,'awaiting-approval');await assert.rejects(f.open().submit(f.owner,f.signed(offer)));assert.equal((await f.open().submit(f.owner,f.signed(newer))).status,'signed');assert.equal(f.sends,0);
  });
  await t.test('confirmed native custody alone is insufficient; campaign review discloses exact destination and reserve',async()=>{
   const f=await fixture(),create={...f.base,stage:'create-campaign'};
   assert.equal((await f.open().prepare(f.owner,create)).reason,'complete-native-custody-first');
   const native=await f.open().prepare(f.owner,f.base);await f.open().submit(f.owner,f.signed(native));
   f.status={confirmationStatus:'confirmed',slot:100,err:null};assert.equal((await f.open().resume(f.owner,f.base)).reason,'awaiting-finality');
   assert.equal((await f.open().prepare(f.owner,create)).reason,'complete-native-custody-first');
   f.status={confirmationStatus:'finalized',slot:100,err:null};assert.equal((await f.open().resume(f.owner,f.base)).status,'complete');f.status=null;
   const offer=await f.open().prepare(f.owner,create);assert.equal(offer.action,'sign-setup');assert.equal(offer.review.setupReserveLamports,f.intent.authorityBudgetLamports);assert.equal(offer.review.setupDestination,f.intent.mint.authority);assert.equal(offer.review.costCoverage,'pool-initialization-only');
   assert.equal((await f.open().submit(f.owner,f.signed(offer))).status,'signed');assert.equal(f.sends,0);
  });
  await t.test('stale launch schedule asks for review without altering terms; RPC failures do not create offers',async()=>{
   const f=await fixture();await f.finalizeNative();f.clock=2000000031n;
   const result=await f.open().prepare(f.owner,{...f.base,stage:'create-campaign'});assert.equal(result.action,'review-schedule');assert.equal(result.transactionBase64,undefined);assert.equal(f.intent.opensAt,'2000000000');
   const g=await fixture();g.connection.getGenesisHash=()=>new Promise(()=>{});await assert.rejects(g.open({timeoutMs:15}).prepare(g.owner,g.base),/timeout/);
   assert.equal((await registry.query('SELECT COUNT(*) AS n FROM creation_provision_offers WHERE request_id=?',[g.base.requestId])).rows[0].n,'0');
  });
  await t.test('unknown broadcast and expired approved transaction never generate a replacement',async()=>{
   const f=await fixture(),offer=await f.open().prepare(f.owner,f.base);await f.open().submit(f.owner,f.signed(offer));
   assert.equal((await f.open().resume(f.owner,f.base)).reason,'submission-unresolved');assert.equal(f.sends,1);assert.equal((await f.open().prepare(f.owner,f.base)).action,'resume');
   f.height=151;assert.equal((await f.open().resume(f.owner,f.base)).reason,'expired');const result=await f.open().prepare(f.owner,f.base);assert.equal(result.status,'expired');assert.equal(result.transactionBase64,undefined);assert.equal(f.sends,1);
  });
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
