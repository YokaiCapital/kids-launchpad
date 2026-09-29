import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import pg from 'pg';import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {renewFeeGrant,MIN_RENEWAL_MS,MAX_RENEWAL_MS} from './renew-fee-grant.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const identity={genesisHash:addr(1),programId:addr(2),campaign:addr(3)},activeTags=[3,21,23,26];
test('fee grant renewal repeats exactly the recorded active scope, never widens it, and refuses stale, revoked or unactivated states',{skip:!url},async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:6,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  await registry.campaigns.upsert({...identity,mode:'standard',campaignVersion:3,registryStatus:'planned'});
  const input=until=>({registry,identity,actor:'qualification-operator',expiresAt:new Date(Date.now()+until).toISOString()});
  await t.test('no activation, no renewal',async()=>{
   const setup=await registry.capabilities.grant({...identity,kind:'fee-setup',programVersion:3,tags:[20],recipients:[addr(4),addr(5)],expiresAt:new Date(Date.now()+3600000).toISOString()});
   await assert.rejects(renewFeeGrant({...input(86400000),expectedCapabilityId:setup.capabilityId}),{code:'RENEWAL_CONFLICT'});
   assert.equal((await registry.capabilities.list({includeExpired:true})).length,1);
  });
  const active=await registry.capabilities.grant({...identity,kind:'keeper',programVersion:3,tags:activeTags,limits:{maxHourlyLamports:500000},expiresAt:new Date(Date.now()+3600000).toISOString()});
  await registry.query('INSERT INTO standard_fee_activations(genesis_hash,program_id,campaign,descriptor_hash,setup_capability_id,active_capability_id,setup_job_id,payer,policy,minimum_reserve_lamports,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[identity.genesisHash,identity.programId,identity.campaign,'d'.repeat(64),'setup','ACTIVE','job',addr(6),'policy','1000','{}',new Date().toISOString()]);
  await registry.query('UPDATE standard_fee_activations SET active_capability_id=? WHERE campaign=?',[active.capabilityId,identity.campaign]);
  await t.test('renewal repeats the active scope and becomes the latest grant; the stale id then conflicts',async()=>{
   const renewed=await renewFeeGrant({...input(86400000),expectedCapabilityId:active.capabilityId});
   assert.deepEqual(renewed.tags,activeTags);assert.deepEqual(renewed.limits,{maxHourlyLamports:500000});assert.equal(renewed.previousCapabilityId,active.capabilityId);
   const latest=await registry.capabilities.latest(identity);assert.equal(latest.capabilityId,renewed.capabilityId);assert.deepEqual(latest.recipients,[]);assert.equal(latest.kind,'keeper');
   await assert.rejects(renewFeeGrant({...input(86400000),expectedCapabilityId:active.capabilityId}),{code:'RENEWAL_CONFLICT'},'the old id is no longer current');
   const again=await Promise.allSettled([renewFeeGrant({...input(86400000),expectedCapabilityId:renewed.capabilityId}),renewFeeGrant({...input(86400000),expectedCapabilityId:renewed.capabilityId})]);
   assert.equal(again.filter(r=>r.status==='fulfilled').length,1,'a concurrent renewal against the same expected id succeeds once');
  });
  await t.test('bounds, actor and revocation are enforced; nothing is granted on refusal',async()=>{
   const before=(await registry.capabilities.list({includeExpired:true})).length,current=(await registry.capabilities.latest(identity)).capabilityId;
   for(const bad of [{expiresAt:new Date(Date.now()+MIN_RENEWAL_MS-1000).toISOString()},{expiresAt:new Date(Date.now()+MAX_RENEWAL_MS+1000).toISOString()},{expiresAt:'never'},{actor:''},{actor:'bad actor'}])await assert.rejects(renewFeeGrant({...input(86400000),...bad,expectedCapabilityId:current}),{code:'RENEWAL_CONFLICT'});
   await registry.capabilities.revoke(current);
   await assert.rejects(renewFeeGrant({...input(86400000),expectedCapabilityId:current}),{code:'RENEWAL_CONFLICT'},'a revoked grant stays revoked');
   assert.equal((await registry.capabilities.list({includeExpired:true})).length,before);
   await assert.rejects(renewFeeGrant({...input(86400000),identity:{...identity,campaign:addr(9)},expectedCapabilityId:current}),{code:'RENEWAL_CONFLICT'});
  });
 }finally{if(pool)await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
