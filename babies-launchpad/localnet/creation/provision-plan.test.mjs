import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresRegistry} from '../registry/registry.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {provisionFixture,provisionAccounts} from '../test/helpers/provision-fixture.mjs';
import {quoteCampaignCosts} from '../budgets.mjs';
import {quoteAuthorityFunding} from './setup-funding.mjs';
import {mintIntentHash} from './mint-packet.mjs';
import {createCreationStore} from './store.mjs';
import {createProvisionPlanService} from './provision-plan.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL;
test('shared setup plan binds accepted costs, finalized mint, schedule and immutable replica retries',{skip:!url},async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();const store=createCreationStore(registry);
  async function fixture(start='after-creation'){
   const {intent,quote}=provisionFixture(),owner=intent.mint.creator,draftId=randomUUID(),draft={name:'Local coin',symbol:'LocalCoin',start,startUtc:'2033-05-18T04:33',publicationConsent:true};
   await registry.drafts.save({creator:owner,id:draftId,revision:0,body:draft});
   const costs=JSON.parse(JSON.stringify(quoteCampaignCosts({live:{ammCreationFeeLamports:150000000n},counts:{transactions:8,signatures:11,ataCreates:9,lockedPositions:1,feeStates:1}}),(_,v)=>typeof v==='bigint'?String(v):v));
   const body={...quote,costs,authorityFunding:quoteAuthorityFunding(costs),genesisHash:intent.mint.genesisHash,programId:intent.mint.programId,fundingEnabled:false,publicationConsent:true};
   const q=await store.issue({owner,draftId,revision:1,requestKey:draftId,draftHash:canonicalHash(draft),descriptorHash:'a'.repeat(64),body}),r=await store.accept({owner,quoteId:q.id});intent.mint.requestId=r.id;
   const config={mode:'localnet-rehearsal',programVersion:3,rpcUrl:'http://127.0.0.1:19199',pilotCreator:owner,genesisHash:intent.mint.genesisHash,programId:intent.mint.programId,treasury:intent.treasury,policyHash:quote.policyHash,planHash:quote.planHash};
   const response=provisionAccounts(intent);let time=2000000000n,reads=0,genesis=config.genesisHash,approved=true;
   const connection={rpcEndpoint:config.rpcUrl,getGenesisHash:async()=>genesis,getMultipleAccountsInfoAndContext:async(keys,opts)=>{reads++;assert.equal(opts.commitment,'finalized');assert.equal(opts.minContextSlot,100);const clock=Buffer.alloc(40);clock.writeBigInt64LE(time,32);return {context:{slot:101},value:[...response.value.slice(3),{data:clock}]};}};
   const mintPlans={load:async()=>intent.mint},mintApprovals={find:async()=>({status:approved?'finalized':'confirmed',result:{mintEvidence:{intentHash:mintIntentHash(intent.mint),slot:100}}})};
   const open=extra=>createProvisionPlanService({registry,connection,config,mintPlans,mintApprovals,...extra});
   return {open,config,intent,request:r,owner,body,response,get reads(){return reads;},set time(v){time=v;},set genesis(v){genesis=v;},set approved(v){approved=v;}};
  }
  await t.test('parallel replicas seal one exact reserve, then load unchanged after restart',async()=>{
   const f=await fixture(),results=await Promise.all(Array.from({length:12},()=>f.open().seal(f.owner,f.request.id)));assert.equal(new Set(results.map(r=>canonicalHash(r.intent))).size,1);const saved=results[0].intent;
   assert.equal(saved.authorityBudgetLamports,f.body.authorityFunding.amountLamports);assert.equal(saved.opensAt,'2000000000');assert.equal(saved.treasury,f.config.treasury);
   const reads=f.reads;f.time=2000000999n;assert.deepEqual(await f.open().load(f.request.id),saved);assert.deepEqual((await f.open().seal(f.owner,f.request.id)).intent,saved);assert.equal(f.reads,reads,'a retry cannot silently change schedule or reserve');
   await assert.rejects(f.open({config:{...f.config,treasury:f.owner}}).load(f.request.id));
  });
  await t.test('nonfinal mint, wrong owner, changed network and active authority cannot seal',async()=>{
   const f=await fixture();f.approved=false;await assert.rejects(f.open().seal(f.owner,f.request.id),/Finalized/);f.approved=true;await assert.rejects(f.open().seal(f.intent.treasury,f.request.id));f.genesis=f.owner;await assert.rejects(f.open().seal(f.owner,f.request.id),/ledger/);f.genesis=f.config.genesisHash;f.response.value[3].data.writeUInt32LE(1,0);await assert.rejects(f.open().seal(f.owner,f.request.id),{code:'MINT_RESULT_MISMATCH'});
  });
  await t.test('scheduled start is exact and expired scheduled setup does not silently move',async()=>{
   const f=await fixture('scheduled');const time=BigInt(Date.parse('2033-05-18T04:33:00Z')/1000);f.time=time-181n;assert.equal((await f.open().seal(f.owner,f.request.id)).intent.opensAt,String(time));
   const late=await fixture('scheduled');late.time=time-180n;await assert.rejects(late.open().seal(late.owner,late.request.id),/too close/);
  });
  await t.test('missing or tampered reviewed reserve refuses the plan',async()=>{
   for(const mutate of [q=>delete q.authorityFunding,q=>q.authorityFunding.amountLamports='1',q=>q.terms.supplySplitBps.dev=600]){
    const f=await fixture(),body=structuredClone(f.request.body);mutate(body.quote);await registry.query('UPDATE creation_requests SET body=? WHERE request_id=?',[JSON.stringify(body),f.request.id]);await assert.rejects(f.open().seal(f.owner,f.request.id));
   }
  });
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
