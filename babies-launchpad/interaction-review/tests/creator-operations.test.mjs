import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import pg from '../../localnet/node_modules/pg/lib/index.js';
import {PostgresRegistry,campaignId} from '../../localnet/registry/registry.mjs';
import {createCreatorOperationsReader} from '../server/creator-operations.mjs';
import {createPublicLaunchAccount} from '../server/public-launch-account.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,owner='JBjY3ETQWkJa79G1URqFsgzqxKqxWeNfNycccQLkGVgn',other='11111111111111111111111111111111';
const id={genesisHash:owner,programId:other,campaign:'So11111111111111111111111111111111111111112'};
async function fixture(fn){const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;try{await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:4,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();await registry.campaigns.upsert({...id,creator:owner,campaignVersion:3,mode:'standard',registryStatus:'planned'});const reader=createCreatorOperationsReader({registry,...id});await fn({registry,reader,input:{campaignId:campaignId(id)}});}finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}}
test('creator diagnostics require scoped PostgreSQL',()=>{assert.throws(()=>createCreatorOperationsReader({registry:{driver:'sqlite'},...id}));});
test('only creator can read exact launch accounting; no grants, packets, wallets or raw errors escape',{skip:!url},()=>fixture(async({registry,reader,input})=>{
 assert.equal((await reader.read(owner,input)).status,'not-scheduled');await assert.rejects(reader.read(other,input));await assert.rejects(reader.read(owner,{campaignId:campaignId({...id,programId:owner})}));
 await registry.budgets.put({...id,payer:other,policy:'private-policy',reservedLamports:'90071992547409930',spentLamports:'31',returnedLamports:'9'});
 await registry.query("INSERT INTO operating_spend_holds(genesis_hash,program_id,campaign,payer,operation_id,message_hash,maximum_lamports,policy,state) VALUES(?,?,?,?,?,?,?,?,?)",[id.genesisHash,id.programId,id.campaign,other,'private-operation','a'.repeat(64),'90','private-policy','held']);
 await registry.jobs.enqueue({...id,jobClass:'refunds',operationKey:'private-refund',payload:{secret:'private-payload'}});await registry.query("UPDATE jobs SET result_json=?",[JSON.stringify({outcome:'unknown',reason:'private-diagnostic',reconcile:{packet:'private-packet'}})]);
 const before=(await registry.query('SELECT * FROM jobs')).rows,result=await reader.read(owner,input);assert.equal(result.status,'reconciling');assert.equal(result.jobs.uncertain,1);assert.equal(result.operating.availableLamports,'90071992547409800');assert.equal(result.operating.heldLamports,'90');assert.equal(result.readOnly,true);assert.ok(Number.isFinite(Date.parse(result.observedAt)));assert.doesNotMatch(JSON.stringify(result),/private-|capability|signature|payload|message_hash/);assert.deepEqual((await registry.query('SELECT * FROM jobs')).rows,before);
 await registry.query("UPDATE jobs SET result_json=?",[JSON.stringify({outcome:'yield',category:'awaiting-operating-funding'})]);assert.equal((await reader.read(owner,input)).status,'funding-needed');
 await registry.query("UPDATE jobs SET state='failed'");assert.equal((await reader.read(owner,input)).status,'needs-attention');
 await registry.query("UPDATE operating_spend_holds SET maximum_lamports='999999999999999999999'");await assert.rejects(reader.read(owner,input),/reconciliation/);
}));
test('authenticated route ignores body owner and remains unavailable without explicit composition',{skip:!url},()=>fixture(async({registry,reader,input})=>{
 const access={allows:()=>true},api=createPublicLaunchAccount({registry,access,creatorOperationsReader:reader}),request={method:'POST',path:'/api/account/launches/operations/read',input:{...input,owner}};
 assert.equal((await api.handle(request)).status,401);assert.equal((await api.handle({...request,owner:other})).status,400);const result=await api.handle({...request,owner});assert.equal(result.status,200);assert.equal(result.body.owner,owner);
 assert.equal((await createPublicLaunchAccount({registry,access}).handle({...request,owner})).status,503);
}));
test('the creator sees the actual available reserve apart from pending refills, and a low reserve is flagged before any task waits',{skip:!url},()=>fixture(async({registry,reader,input})=>{
 const payer=other,policy='creator-funded-v1';
 await registry.budgets.put({...id,payer,policy,reservedLamports:'30000000',spentLamports:'15000000',returnedLamports:'0'});
 let r=await reader.read(owner,input);assert.equal(r.status,'funding-low');assert.equal(r.operating.lowReserve,true);assert.equal(r.operating.availableLamports,'15000000');assert.equal(r.operating.floorLamports,'20000000');
 assert.deepEqual(r.refills,{pendingLamports:'0',awaitingTransferLamports:'0',fundedLamports:'0'});
 const at=new Date().toISOString(),fundingId='f'.repeat(64);
 await registry.query("INSERT INTO operating_refills(genesis_hash,program_id,campaign,payer,policy,treasury_paid_accounted,due_lamports,funded_lamports,pending_funding_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",[id.genesisHash,id.programId,id.campaign,payer,policy,'50000000','5000000','1000000',fundingId,at,at]);
 await registry.query("INSERT INTO operating_refill_fundings(funding_id,genesis_hash,program_id,payer,policy,treasury,entitlements_json,total_lamports,memo,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'prepared',?,?)",[fundingId,id.genesisHash,id.programId,payer,policy,owner,JSON.stringify([{campaign:id.campaign,lamports:'5000000'}]),'5000000','KIDS refill:'+fundingId,at,at]);
 r=await reader.read(owner,input);assert.deepEqual(r.refills,{pendingLamports:'5000000',awaitingTransferLamports:'5000000',fundedLamports:'1000000'});assert.equal(r.operating.availableLamports,'15000000','pending refills never count as available');
 await registry.budgets.put({...id,payer,policy,reservedLamports:'60000000',spentLamports:'15000000',returnedLamports:'0'});
 r=await reader.read(owner,input);assert.equal(r.status,'not-scheduled');assert.equal(r.operating.lowReserve,false);
 const strict=createCreatorOperationsReader({registry,genesisHash:id.genesisHash,programId:id.programId,floorLamports:'50000000'});assert.equal((await strict.read(owner,input)).status,'funding-low');
}));
