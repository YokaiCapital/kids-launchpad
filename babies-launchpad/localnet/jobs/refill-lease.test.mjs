// The accounting lane leases only rows whose payload binding names its payer and policy (postgres.mjs leaseNext).
// Refill rows must therefore carry that binding from seeding (fee activation) and succession (the handler), and the
// one legacy row seeded without it is repaired only through the audited path. Real PostgreSQL, isolated schema.
import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import pg from 'pg';import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {refillJobBinding} from './operating-refill.mjs';
import {repairRefillBinding,REFILL_REPAIR_REASON} from './recover-failed.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
test('refill rows are leased only by the accounting worker of their payer and policy; a legacy unbound row needs the audited repair',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:4,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const genesisHash=addr(1),programId=addr(2),payer=addr(3),policy='creator-funded-v1',bound=addr(4),legacy=addr(5),unactivated=addr(6);
  for(const campaign of [bound,legacy,unactivated])await registry.campaigns.upsert({genesisHash,programId,campaign,network:'localnet',mode:'standard',campaignVersion:3,registryStatus:'planned'});
  const classes=['operating-reconcile','operating-refill'];
  const lease=(owner,scope)=>registry.jobs.leaseNext({owner,ttlMs:30000,jobClasses:classes,scope:{genesisHash,programId,campaignVersion:3,operatingPayer:payer,operatingPolicy:policy,...scope}});
  // Initial refill row as fee activation seeds it now.
  const id={genesisHash,programId,campaign:bound};
  const initial=(await registry.jobs.enqueue({...id,jobClass:'operating-refill',operationKey:'operating-refill:0',payload:{binding:refillJobBinding({...id,payer,policy})}})).job;
  assert.equal(await lease('other-payer',{operatingPayer:addr(9)}),null,'another payer leases nothing');
  assert.equal(await lease('other-policy',{operatingPolicy:'other-policy'}),null,'another policy leases nothing');
  const leased=await lease('acct-a',{});assert.equal(leased?.jobId,initial.jobId,'the bound initial refill is leased by its lane');
  await registry.jobs.complete({jobId:initial.jobId,token:leased.fencingToken,result:{outcome:'done'}});
  // Successor exactly as the handler enqueues it.
  const successor=(await registry.jobs.enqueue({...id,jobClass:'operating-refill',operationKey:'operating-refill:1',payload:{binding:refillJobBinding({...id,payer,policy}),predecessorJobId:initial.jobId}})).job;
  assert.equal((await lease('acct-a',{}))?.jobId,successor.jobId,'the bound successor is leased');
  // Legacy row: seeded before 28 Sep 2026 without any payload.
  const legacyId={genesisHash,programId,campaign:legacy};
  const stale=(await registry.jobs.enqueue({...legacyId,jobClass:'operating-refill',operationKey:'operating-refill:0'})).job;
  assert.equal(await lease('acct-a',{}),null,'an unbound row is never leased');
  const repairInput={registry,jobId:stale.jobId,recoveryId:'refill-binding:'+stale.jobId,actor:'owner-terminal'};
  await assert.rejects(repairRefillBinding(repairInput),{code:'RECOVERY_CONFLICT'},'no verified fee activation, no repair');
  const activation=(campaign,setupJobId)=>registry.query('INSERT INTO standard_fee_activations(genesis_hash,program_id,campaign,descriptor_hash,setup_capability_id,active_capability_id,setup_job_id,payer,policy,minimum_reserve_lamports,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[genesisHash,programId,campaign,'a'.repeat(64),randomUUID(),randomUUID(),setupJobId,payer,policy,'1000000','{}',new Date().toISOString()]);
  await activation(legacy,randomUUID());
  const repaired=await repairRefillBinding(repairInput);
  assert.deepEqual(repaired,{jobId:stale.jobId,recoveryId:repairInput.recoveryId,repaired:true,binding:refillJobBinding({...legacyId,payer,policy})});
  const row=await registry.jobs.get(stale.jobId);assert.equal(row.state,'queued');assert.equal(row.fencingToken,0);assert.deepEqual(row.payload.binding,refillJobBinding({...legacyId,payer,policy}));
  const audit=(await registry.query('SELECT * FROM job_recoveries WHERE job_id=?',[stale.jobId])).rows;assert.equal(audit.length,1);assert.equal(audit[0].reason,REFILL_REPAIR_REASON);assert.equal(Number(audit[0].prior_token),0);assert.equal(audit[0].prior_result_json,'{}');
  assert.deepEqual(await repairRefillBinding(repairInput),{jobId:stale.jobId,recoveryId:repairInput.recoveryId,repaired:false},'the same recovery id is a no-op');
  await assert.rejects(repairRefillBinding({...repairInput,actor:'someone-else'}),{code:'RECOVERY_CONFLICT'});
  await assert.rejects(repairRefillBinding({...repairInput,recoveryId:'second:'+stale.jobId}),{code:'RECOVERY_CONFLICT'},'already bound rows are refused');
  assert.equal((await lease('acct-a',{}))?.jobId,stale.jobId,'the repaired row is leased by its lane');
  // Refusals: a leased row, a bound row, a failed row, a non-refill row.
  const another=(await registry.jobs.enqueue({...legacyId,jobClass:'operating-refill',operationKey:'operating-refill:1'})).job;
  await registry.query('UPDATE jobs SET lease_owner=?,state=? WHERE job_id=?',['someone','leased',another.jobId]);
  await assert.rejects(repairRefillBinding({registry,jobId:another.jobId,recoveryId:'x:'+another.jobId,actor:'owner-terminal'}),{code:'RECOVERY_CONFLICT'},'a leased row is refused');
  const reconcile=(await registry.jobs.enqueue({...legacyId,jobClass:'operating-reconcile',operationKey:'operating-reconcile:z'})).job;
  await assert.rejects(repairRefillBinding({registry,jobId:reconcile.jobId,recoveryId:'y:'+reconcile.jobId,actor:'owner-terminal'}),{code:'RECOVERY_CONFLICT'},'only operating-refill rows');
  const unact=(await registry.jobs.enqueue({genesisHash,programId,campaign:unactivated,jobClass:'operating-refill',operationKey:'operating-refill:0'})).job;
  await assert.rejects(repairRefillBinding({registry,jobId:unact.jobId,recoveryId:'u:'+unact.jobId,actor:'owner-terminal'}),{code:'RECOVERY_CONFLICT'},'no activation row, no repair');
  assert.equal(await lease('acct-a',{}),null,'nothing else becomes leasable');
 }finally{if(pool)await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
