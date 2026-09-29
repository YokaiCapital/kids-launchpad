import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {createOperatingLedger} from '../creation/operating-ledger.mjs';
import {createFeeActivation,feeActivationPolicy} from './fee-activation.mjs';
import {createJobRunner} from './runner.mjs';
const addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58(),url=process.env.KIDS_TEST_POSTGRES_URL;
const config={mode:'localnet-rehearsal',genesisHash:addr(1),programId:addr(2),payer:addr(3),treasury:addr(7),policy:'fixture-operations-v3',minimumReserveLamports:'100'};
test('activation needs an explicit positive reserve and cannot enable hosted operations',()=>{
 for(const patch of [{mode:'production'},{minimumReserveLamports:'0'},{minimumReserveLamports:100},{minimumReserveLamports:'01'},{minimumReserveLamports:'18446744073709551616'},{policy:''}])assert.throws(()=>feeActivationPolicy({...config,...patch}));
 assert.equal(feeActivationPolicy(config).minimumReserveLamports,'100');
 // The treasury is pinned apart from the payer; a hosted policy must name it; a legacy local fixture without one keeps the payer.
 assert.equal(feeActivationPolicy(config).treasury,addr(7));assert.equal(feeActivationPolicy(config).payer,addr(3));
 assert.throws(()=>feeActivationPolicy({...config,mode:'hosted',treasury:undefined}),/release treasury/);
 assert.equal(feeActivationPolicy({...config,mode:'hosted'}).treasury,addr(7));
 assert.equal(feeActivationPolicy({...config,treasury:undefined}).treasury,addr(3));assert.notEqual(feeActivationPolicy({...config,treasury:undefined}).descriptorHash,feeActivationPolicy(config).descriptorHash);
});
test('activation is atomic, funded, restartable and cannot revive revoked authority',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const id={genesisHash:config.genesisHash,programId:config.programId,campaign:addr(4)},termsHash='a'.repeat(64),recipients=[config.payer,addr(5)];
  await registry.campaigns.upsert({...id,network:'localnet',mode:'standard',campaignVersion:3,registryStatus:'planned',termsHash});
  const expiresAt=new Date(Date.now()+3600000).toISOString();
  const cap=await registry.capabilities.grant({...id,programVersion:3,kind:'fee-setup',tags:[20],recipients,expiresAt,limits:{maxHourlyLamports:1000000}});
  const setup=(await registry.jobs.enqueue({...id,jobClass:'fee-setup',operationKey:'fee-setup'})).job;
  const setupLease=await registry.jobs.leaseById({jobId:setup.jobId,token:0,owner:'setup',ttlMs:30000});
  let evidence={status:'ready',slot:10,payer:config.payer,operator:addr(6),recipients,termsHash};
  let reads=0;const adapter={async snapshot(){reads++;return evidence;}};
  const activation=createFeeActivation({registry,adapter,config});
  await activation.schedule(setup,{campaign:id});await activation.schedule(setup,{campaign:id});
  let job=(await registry.jobs.listForCampaign(id)).find(j=>j.jobClass==='fee-activate');
  const lease=await registry.jobs.leaseById({jobId:job.jobId,token:0,owner:'activation',ttlMs:120000});
  const ctx={campaign:id,jobId:job.jobId,token:lease.fencingToken,owner:'activation',fenced:async(_label,fn)=>fn()};
  assert.equal((await activation.handler.run(job,ctx)).category,'awaiting-verified-fee-setup');assert.equal(reads,0);
  await registry.jobs.complete({jobId:setup.jobId,token:setupLease.fencingToken,result:{verified:true}});
  assert.equal((await activation.handler.run(job,ctx)).category,'awaiting-operating-funding');assert.equal((await registry.capabilities.latest(id)).capabilityId,cap.capabilityId);
  const ledger=createOperatingLedger({registry,verifyFunding:async x=>({...x,source:addr(7),lamports:'150',slot:9,finalized:true}),verifyOutcome:async x=>({...x,actualLamports:'0',status:'expired',slot:12})});
  const base={...id,payer:config.payer,policy:config.policy};await ledger.credit({...base,signature:'3'.repeat(88)});
  const hold={...base,operationId:'pending',messageHash:'b'.repeat(64),maximumLamports:'100'};await ledger.hold(hold);
  assert.equal((await activation.handler.run(job,ctx)).category,'awaiting-operating-funding','pending spends reduce usable reserve');
  await ledger.reconcile(hold);
  const normal=evidence;evidence={...normal,status:'waiting',reason:'recipient-account-repair-required'};
  assert.equal((await activation.handler.run(job,ctx)).category,'recipient-account-repair-required');evidence=normal;
  evidence={...normal,termsHash:'c'.repeat(64)};assert.equal((await activation.handler.run(job,ctx)).outcome,'failed-permanent');evidence=normal;
  await assert.rejects(activation.handler.run(job,{...ctx,token:ctx.token+1}),{code:'STALE_LEASE'});
  // A queue write failure cannot leave the stronger grant committed alone.
  const enqueue=registry.jobs.enqueue;registry.jobs.enqueue=async input=>{const result=await enqueue(input);if(input.jobClass==='distribution')throw Error('fixture queue write failed');return result;};
  await assert.rejects(activation.handler.run(job,ctx),/queue write failed/);
  assert.equal((await registry.capabilities.latest(id)).capabilityId,cap.capabilityId);
  assert.equal((await registry.query('SELECT * FROM standard_fee_activations')).rowCount,0);
  assert.equal((await registry.jobs.listForCampaign(id)).length,2);
  registry.jobs.enqueue=enqueue;
  const result=await activation.handler.run(job,ctx);assert.equal(result.category,'fees-active');assert.equal(result.duplicate,false);
  const active=await registry.capabilities.latest(id);assert.deepEqual(active.tags,[3,21,23,26]);assert.deepEqual(active.recipients,[]);assert.equal(active.expiresAt,expiresAt);assert.deepEqual(active.limits,cap.limits);
  // Crash after the atomic transition and before runner completion: the new
  // process reads the immutable evidence and does not grant or enqueue again.
  const restarted=createFeeActivation({registry,adapter,config});assert.equal((await restarted.handler.run(job,ctx)).duplicate,true);
  assert.equal((await registry.capabilities.list({includeExpired:true})).length,2);
  assert.equal((await registry.jobs.listForCampaign(id)).length,6);
  await registry.capabilities.revoke(active.capabilityId);
  assert.equal((await restarted.handler.run(job,ctx)).category,'fee-capability-paused');await restarted.schedule(setup,{campaign:id});
  assert.equal((await registry.capabilities.list({includeExpired:true})).length,2,'revocation cannot resurrect setup rights');
  assert.equal((await ledger.balance(base)).availableLamports,'150','activation itself cannot debit or credit money');
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
test('two provisioning replicas activate 100 campaigns without touching lifecycle or fee executors',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const recipients=[config.payer,addr(5)],termsHash='a'.repeat(64),activation=createFeeActivation({registry,config,adapter:{async snapshot(){return {status:'ready',slot:10,payer:config.payer,operator:addr(6),recipients,termsHash};}}});
  for(let i=0;i<100;i++){
   const id={genesisHash:config.genesisHash,programId:config.programId,campaign:addr(i+20)};
   await registry.campaigns.upsert({...id,network:'localnet',mode:'standard',campaignVersion:3,registryStatus:'planned',termsHash});
   await registry.capabilities.grant({...id,programVersion:3,kind:'fee-setup',tags:[20],recipients,expiresAt:new Date(Date.now()+3600000).toISOString()});
   // DB fixture, not chain funding evidence. Chain-backed proof is qualified separately.
   await registry.budgets.put({...id,payer:config.payer,policy:config.policy,reservedLamports:'100',spentLamports:'0',returnedLamports:'0'});
   const setup=(await registry.jobs.enqueue({...id,jobClass:'fee-setup',operationKey:'fee-setup'})).job;
   await registry.jobs.leaseById({jobId:setup.jobId,token:0,owner:'setup',ttlMs:30000});await registry.jobs.complete({jobId:setup.jobId,token:1,result:{verified:true}});
   await activation.schedule(setup,{campaign:id});await registry.jobs.enqueue({...id,jobClass:'launch',operationKey:'unrelated-launch'});
  }
  const scope={genesisHash:config.genesisHash,programId:config.programId,campaignVersion:3};
  const make=owner=>createJobRunner({registry,handlers:{'fee-activate':activation.handler},owner,concurrency:4,lane:'provisioning',servedClasses:['fee-activate'],scope});
  const a=make('activation-a'),b=make('activation-b');for(let i=0;i<14;i++)await Promise.all([a.tick(),b.tick()]);
  assert.equal(Number((await registry.query('SELECT COUNT(*) n FROM standard_fee_activations')).rows[0].n),100);
  assert.equal(Number((await registry.query("SELECT COUNT(*) n FROM jobs WHERE job_class='fee-activate' AND state='done'")).rows[0].n),100);
  assert.equal(Number((await registry.query("SELECT COUNT(*) n FROM jobs WHERE job_class IN ('fee-harvest','distribution','token-burn') AND state='queued'")).rows[0].n),300);
  assert.equal(Number((await registry.query("SELECT COUNT(*) n FROM jobs WHERE job_class='launch' AND state='queued'")).rows[0].n),100);
  a.stop();b.stop();await Promise.all([a.drain(),b.drain()]);
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
