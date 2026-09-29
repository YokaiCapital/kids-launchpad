import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresRegistry} from '../registry/registry.mjs';
import {provisionFixture,provisionAccounts} from '../test/helpers/provision-fixture.mjs';
import {verifyProvisionResult} from './provision-result.mjs';
import {createProvisionRegistrar} from './provision-registration.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL;
test('verified setup registers exactly once without activating workers or regressing live campaigns',{skip:!url},async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const {intent}=provisionFixture(),m=intent.mint,evidence={...verifyProvisionResult(intent,provisionAccounts(intent),{minSlot:100,campaignRentLamports:'8000000'}),stage:'create-campaign'},config={mode:'localnet-rehearsal',programVersion:3,pilotCreator:m.creator,genesisHash:m.genesisHash,programId:m.programId,treasury:intent.treasury};
  let result={status:'pending',reason:'awaiting-finality'};const open=()=>createProvisionRegistrar({registry,config,loadIntent:async()=>intent,executor:{resume:async()=>result}});
  assert.equal((await open().register(m.creator,m.requestId)).status,'pending');assert.equal(await registry.campaigns.count(),0);
  result={status:'complete',signature:'2'.repeat(88),evidence};await assert.rejects(open().register(intent.treasury,m.requestId));
  const rows=await Promise.all(Array.from({length:20},()=>open().register(m.creator,m.requestId)));assert.ok(rows.every(r=>r.status==='registered'&&!r.workerActivation));assert.equal(await registry.campaigns.count(),1);
  const id={genesisHash:m.genesisHash,programId:m.programId,campaign:m.campaign},row=await registry.campaigns.get(id);assert.equal(row.mint,m.mint);assert.equal(row.name,m.metadata.name);assert.equal(row.sourceSlot,101);assert.equal(row.sourceCommitment,'finalized');assert.equal(row.chainStatus,null,'indexer must read current phase; do not guess from a wall clock');
  for(const table of ['jobs','signer_capabilities','operational_budgets'])assert.equal(Number((await registry.query('SELECT COUNT(*) n FROM '+table)).rows[0].n),0);
  await registry.campaigns.upsert({...id,mode:'standard',campaignVersion:3,registryStatus:'active',chainStatus:'launched',sourceSlot:200,sourceCommitment:'finalized',name:'Moderated name'});
  await open().register(m.creator,m.requestId);const later=await registry.campaigns.get(id);assert.equal(later.chainStatus,'launched');assert.equal(later.name,'Moderated name');assert.equal(later.sourceSlot,200);
  const discovery=createProvisionRegistrar({registry,config:{...config,discoveryIndex:true},loadIntent:async()=>intent,executor:{resume:async()=>result}});await discovery.register(m.creator,m.requestId);await discovery.register(m.creator,m.requestId);assert.deepEqual((await registry.jobs.listForCampaign(id)).map(j=>j.jobClass).sort(),['activity-index','campaign-index','position-index']);assert.equal((await registry.capabilities.list()).length,0);
  const awaitingProfile=createProvisionRegistrar({registry,config:{...config,profilePublication:true},loadIntent:async()=>intent,executor:{resume:async()=>result},publisher:{publish:async()=>({status:'pending'})}});assert.equal((await awaitingProfile.register(m.creator,m.requestId)).reason,'awaiting-profile-publication');assert.throws(()=>createProvisionRegistrar({registry,config:{...config,profilePublication:true},loadIntent:async()=>intent,executor:{resume:async()=>result}}),/publisher/);
  const different=structuredClone(intent);different.authorityBudgetLamports='1';await assert.rejects(createProvisionRegistrar({registry,config,loadIntent:async()=>different,executor:{resume:async()=>result}}).register(m.creator,m.requestId));
  await registry.query('UPDATE campaigns SET mint=? WHERE campaign=?',[intent.treasury,m.campaign]);await assert.rejects(open().register(m.creator,m.requestId),{code:'IDEMPOTENCY_CONFLICT'});
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
