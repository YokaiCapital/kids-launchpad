import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {Keypair,VersionedTransaction,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {quoteCampaignCosts} from '../budgets.mjs';
import {quoteAuthorityFunding} from './setup-funding.mjs';
import {mintIntentHash} from './mint-packet.mjs';
import {provisionIntentHash,buildProvisionPacket,provisionTerms} from './provision-packet.mjs';
import {createCreationStore} from './store.mjs';
import {createProvisionPlanService} from './provision-plan.mjs';
import {createProvisionExecutor} from './provision-execution.mjs';
import {createProvisionWalletService} from './provision-wallet.mjs';
import {createProvisionRecovery} from './provision-recovery.mjs';
import {provisionFixture,provisionAccounts} from '../test/helpers/provision-fixture.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,address=()=>Keypair.generate().publicKey.toBase58();
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
test('setup schedule recovery is explicit, finalized, immutable and race-safe',{skip:!url},async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:12,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  async function fixture(start='after-creation'){
   const f=provisionFixture(),owner=f.intent.mint.creator,draftId=randomUUID(),draft={name:'Local coin',symbol:'LocalCoin',start,startUtc:'2033-05-18T04:33',publicationConsent:true};
   await registry.drafts.save({creator:owner,id:draftId,revision:0,body:draft});
   const costs=JSON.parse(JSON.stringify(quoteCampaignCosts({live:{ammCreationFeeLamports:150000000n},counts:{transactions:8,signatures:11,ataCreates:9,lockedPositions:1,feeStates:1}}),(_,v)=>typeof v==='bigint'?String(v):v));
   const body={...f.quote,costs,authorityFunding:quoteAuthorityFunding(costs),genesisHash:f.intent.mint.genesisHash,programId:f.intent.mint.programId,fundingEnabled:false,publicationConsent:true},store=createCreationStore(registry);
   const quote=await store.issue({owner,draftId,revision:1,requestKey:draftId,draftHash:canonicalHash(draft),descriptorHash:'a'.repeat(64),body}),request=await store.accept({owner,quoteId:quote.id});f.intent.mint.requestId=request.id;
   const config={mode:'localnet-rehearsal',programVersion:3,rpcUrl:'http://127.0.0.1:19199',pilotCreator:owner,genesisHash:f.intent.mint.genesisHash,programId:f.intent.mint.programId,treasury:f.intent.treasury,policyHash:f.quote.policyHash,planHash:f.quote.planHash};
   const accounts=provisionAccounts(f.intent);let clock=2000000000n,height=100,slot=200,status=null,campaign=null,next=f.block,hook=null,genesis=config.genesisHash,sends=0;
   const connection={rpcEndpoint:config.rpcUrl,getGenesisHash:async()=>genesis,getLatestBlockhash:async()=>next,getLatestBlockhashAndContext:async()=>({context:{slot:50},value:next}),isBlockhashValid:async()=>({value:height<=next.lastValidBlockHeight}),getEpochInfo:async()=>({blockHeight:height,absoluteSlot:slot}),getFirstAvailableBlock:async()=>1,getSignatureStatuses:async()=>({context:{slot},value:[status]}),getMinimumBalanceForRentExemption:async()=>8000000,sendRawTransaction:async()=>{sends++;throw Error('no broadcasts in recovery');},
    getMultipleAccountsInfoAndContext:async(keys,opts)=>{
     const c=Buffer.alloc(40);c.writeBigInt64LE(clock,32);const response={context:{slot},value:keys.length===1?[keys[0].equals(SYSVAR_CLOCK_PUBKEY)?{data:c}:accounts.value[2]]:[...accounts.value.slice(3),{data:c},...(keys.length===6?[accounts.value[2],campaign]:[])]};
     if(hook)await hook(keys,opts);return response;
    }};
   const plans=createProvisionPlanService({registry,connection,config,mintPlans:{load:async()=>f.intent.mint},mintApprovals:{find:async()=>({status:'finalized',result:{mintEvidence:{intentHash:mintIntentHash(f.intent.mint),slot:100}}})}});
   const original=(await plans.seal(owner,request.id)).intent,executor=createProvisionExecutor({registry,connection,config,loadIntent:plans.load}),recovery=()=>createProvisionRecovery({registry,connection,config,plans,executor});
   const wallet=()=>createProvisionWalletService({registry,connection,config,plans,executor,recovery:recovery()}),input={requestId:request.id,stage:'create-campaign'},recover=()=>recovery().recover(owner,{requestId:request.id,expectedIntentHash:provisionIntentHash(original)});
   const sign=offer=>{const tx=VersionedTransaction.deserialize(Buffer.from(offer.transactionBase64,'base64'));tx.sign([f.creator]);return {...input,stage:offer.stage,offerId:offer.offerId,transactionBase64:Buffer.from(tx.serialize()).toString('base64')};};
   async function native(){const tx=buildProvisionPacket(original,'native-custody',f.block);tx.sign([f.creator]);await executor.record(request.id,{stage:'native-custody',block:f.block,creatorPacket:Buffer.from(tx.serialize()).toString('base64')});status={confirmationStatus:'finalized',slot:100,err:null};assert.equal((await executor.resume(request.id,'native-custody')).status,'complete');status=null;}
   return {owner,input,plans,original,executor,wallet,recover,recovery,sign,native,connection,accounts,config,get sends(){return sends;},set clock(v){clock=v;},set height(v){height=v;},set slot(v){slot=v;},set status(v){status=v;},set campaign(v){campaign=v;},set next(v){next=v;},set hook(v){hook=v;},set genesis(v){genesis=v;}};
  }
  await t.test('no offer: time can refresh after native finality without repeating its approval',async()=>{
   const f=await fixture();f.clock=2000000100n;assert.equal((await f.recover()).reason,'complete-native-custody-first');await f.native();
   const results=await Promise.all(Array.from({length:10},()=>f.recover()));assert.ok(results.every(r=>r.generation===2&&r.action==='prepare-setup'));assert.equal(new Set(results.map(r=>r.intentHash)).size,1);
   const latest=await f.plans.load(f.input.requestId);assert.equal(latest.opensAt,'2000000100');assert.deepEqual({...latest,version:1,opensAt:f.original.opensAt,generation:undefined},{...f.original,generation:undefined});
   assert.deepEqual(await f.plans.load(f.input.requestId,'native-custody'),f.original);assert.equal((await f.executor.resume(f.input.requestId,'native-custody')).status,'complete');
   assert.equal((await f.plans.seal(f.owner,f.input.requestId)).intent.generation,2);assert.equal((await f.recover()).generation,2,'retry returns same revision');
   const offer=await f.wallet().prepare(f.owner,f.input);assert.equal(offer.generation,2);assert.equal((await f.wallet().submit(f.owner,f.sign(offer))).status,'signed');assert.equal(f.sends,0);
  });
  await t.test('all unsigned offers must pass finalized expiry; caps and durations stay exact',async()=>{
   const f=await fixture();await f.native();const old=await f.wallet().prepare(f.owner,f.input);f.clock=2000000100n;
   assert.equal((await f.recover()).reason,'waiting-for-finalized-expiry');assert.equal((await f.plans.load(f.input.requestId)).version,1);
   f.height=151;const result=await f.recover();assert.equal(result.generation,2);await assert.rejects(f.wallet().submit(f.owner,f.sign(old)));
   const terms=provisionTerms(await f.plans.load(f.input.requestId)),before=provisionTerms(f.original);assert.equal(terms.soft,before.soft);assert.equal(terms.hard,before.hard);assert.equal(BigInt(terms.deadline)-BigInt(terms.opensAt),BigInt(before.deadline)-BigInt(before.opensAt));
   f.next={blockhash:address(),lastValidBlockHeight:350,observedSlot:50};const fresh=await f.wallet().prepare(f.owner,f.input);assert.notEqual(fresh.offerId,old.offerId);assert.equal((await f.wallet().submit(f.owner,f.sign(fresh))).status,'signed');assert.equal(f.sends,0);
  });
  await t.test('approved unknown and confirmed creation cannot be replaced; expired absent creation can',async()=>{
   const f=await fixture();await f.native();const offer=await f.wallet().prepare(f.owner,f.input);await f.wallet().submit(f.owner,f.sign(offer));f.clock=2000000100n;
   assert.equal((await f.recover()).reason,'previous-transaction-unresolved');f.status={confirmationStatus:'confirmed',slot:200,err:null};f.height=151;assert.equal((await f.recover()).reason,'previous-transaction-unresolved');
   f.status=null;assert.equal((await f.recover()).generation,2);assert.equal((await f.executor.status(f.input.requestId,'create-campaign')).status,'awaiting-approval');assert.equal(f.sends,0);
  });
  await t.test('existing campaign, wrong ledger, missing custody, wrong owner and fixed schedule deny recovery',async()=>{
   const f=await fixture();await f.native();f.clock=2000000100n;f.campaign=f.accounts.value[0];assert.equal((await f.recover()).reason,'campaign-already-exists');f.campaign=null;
   f.genesis=address();await assert.rejects(f.recover(),/ledger/);f.genesis=f.config.genesisHash;
   f.accounts.value[4].data.writeBigUInt64LE(1n,64);await assert.rejects(f.recover(),{code:'MINT_RESULT_MISMATCH'});
   await assert.rejects(f.recovery().recover(address(),{requestId:f.input.requestId,expectedIntentHash:provisionIntentHash(f.original)}));
   const scheduled=await fixture('scheduled');await scheduled.native();scheduled.clock=BigInt(scheduled.original.opensAt)+31n;assert.equal((await scheduled.recover()).reason,'scheduled-start-is-fixed');
  });
  await t.test('an expired approved scheduled packet retries without moving the agreed opening',async()=>{
   const f=await fixture('scheduled');await f.native();const offer=await f.wallet().prepare(f.owner,f.input);await f.wallet().submit(f.owner,f.sign(offer));f.height=151;
   assert.equal((await f.recover()).generation,2);const current=await f.plans.load(f.input.requestId);assert.equal(current.opensAt,f.original.opensAt);assert.deepEqual(provisionTerms(current),provisionTerms(f.original));
  });
  await t.test('an in-flight old approval cannot be recorded after recovery wins',async()=>{
   const f=await fixture();await f.native();const offer=await f.wallet().prepare(f.owner,f.input),entered=defer(),release=defer();let first=true;
   f.hook=async(keys)=>{if(first&&keys.length===6){first=false;entered.resolve();await release.promise;}};
   const pending=f.wallet().submit(f.owner,f.sign(offer)),reject=assert.rejects(pending,{code:'IDEMPOTENCY_CONFLICT'});await entered.promise;f.clock=2000000100n;f.height=151;
   assert.equal((await f.recover()).generation,2);release.resolve();await reject;assert.equal((await f.executor.status(f.input.requestId,'create-campaign')).status,'awaiting-approval');assert.equal(f.sends,0);
  });
  await t.test('expired native approval gets its own generation without changing creation timing or charging twice',async()=>{
   const f=await fixture(),input={...f.input,stage:'native-custody'},offer=await f.wallet().prepare(f.owner,input);
   await f.wallet().submit(f.owner,f.sign(offer));f.height=151;f.clock=2000000100n;
   const request={...input,expectedIntentHash:provisionIntentHash(f.original)},results=await Promise.all(Array.from({length:8},()=>f.wallet().recover(f.owner,request)));
   assert.ok(results.every(r=>r.generation===2&&r.stage==='native-custody'));assert.equal((await f.plans.load(f.input.requestId)).version,1);
   const native=await f.plans.load(f.input.requestId,'native-custody');assert.equal(native.generation,2);assert.deepEqual(provisionTerms(native),provisionTerms(f.original));
   assert.equal((await f.executor.status(f.input.requestId,'native-custody')).status,'awaiting-approval');
   await assert.rejects(f.wallet().submit(f.owner,f.sign(offer)));f.next={blockhash:address(),lastValidBlockHeight:350,observedSlot:50};
   const next=await f.wallet().prepare(f.owner,input);assert.equal((await f.wallet().submit(f.owner,f.sign(next))).status,'signed');
   f.status={confirmationStatus:'finalized',slot:200,err:null};assert.equal((await f.wallet().resume(f.owner,input)).status,'complete');f.status=null;
   assert.equal((await f.recover()).generation,2);assert.equal((await f.executor.status(f.input.requestId,'native-custody')).status,'finalized');assert.equal(f.sends,0);
   const rows=(await registry.query('SELECT status FROM operator_packets WHERE descriptor LIKE ?',['%'+f.input.requestId+'%'])).rows;
   assert.equal(rows.filter(r=>r.status==='expired').length,1);assert.equal(rows.filter(r=>r.status==='signed').length,0,'recovery closes old signed records atomically');
  });
  await t.test('native recovery cannot replace a live or successful signature',async()=>{
   const f=await fixture(),input={...f.input,stage:'native-custody'},offer=await f.wallet().prepare(f.owner,input);await f.wallet().submit(f.owner,f.sign(offer));
   const request={...input,expectedIntentHash:provisionIntentHash(f.original)};assert.equal((await f.wallet().recover(f.owner,request)).reason,'previous-transaction-unresolved');
   f.status={confirmationStatus:'finalized',slot:200,err:null};assert.equal((await f.wallet().recover(f.owner,request)).reason,'previous-transaction-unresolved');
   assert.equal((await f.plans.load(f.input.requestId,'native-custody')).version,1);assert.equal(f.sends,0);
  });
  await t.test('stale RPC contexts and timeouts fail closed without creating a revision',async()=>{
   const f=await fixture();await f.native();f.clock=2000000100n;f.connection.getEpochInfo=async()=>({blockHeight:151,absoluteSlot:250});await assert.rejects(f.recover(),/accounts unavailable/);
   f.connection.getGenesisHash=()=>new Promise(()=>{});const short=createProvisionRecovery({registry,connection:f.connection,config:f.config,plans:f.plans,executor:f.executor,timeoutMs:15});await assert.rejects(short.recover(f.owner,{requestId:f.input.requestId,expectedIntentHash:provisionIntentHash(f.original)}),/deadline/);
   assert.equal((await f.plans.load(f.input.requestId)).version,1);
  });
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
