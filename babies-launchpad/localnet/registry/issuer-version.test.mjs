import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import {readFileSync} from 'node:fs';import pg from 'pg';import {PublicKey} from '@solana/web3.js';
import {openRegistry,PostgresRegistry,splitStatements} from './registry.mjs';
const addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const migration=splitStatements(readFileSync(new URL('./migration-13-issuer-version.sql',import.meta.url),'utf8'));
for(const driver of ['sqlite','postgres'])test(driver+': issuer migration retains revoked grant history; leases enforce campaign version',{skip:driver==='postgres'&&!process.env.KIDS_TEST_POSTGRES_URL},async()=>{
 let registry,admin,pool;const schema='kids_test_'+randomUUID().replaceAll('-','');
 try{
  if(driver==='postgres'){
   admin=new pg.Pool({connectionString:process.env.KIDS_TEST_POSTGRES_URL,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
   pool=new pg.Pool({connectionString:process.env.KIDS_TEST_POSTGRES_URL,max:2,options:`-c search_path=${schema}`});registry=new PostgresRegistry({pool});
  }else registry=openRegistry();
  await registry.migrate();const id={genesisHash:addr(1),programId:addr(2),campaign:addr(3)},expiresAt=new Date(Date.now()+60000).toISOString();
  await registry.campaigns.upsert({...id,mode:'standard',campaignVersion:3,registryStatus:'planned'});
  const older=await registry.capabilities.grant({...id,programVersion:1,tags:[4],expiresAt});
  const revoked=await registry.capabilities.grant({...id,programVersion:2,tags:[4],expiresAt});await registry.capabilities.revoke(revoked.capabilityId);
  const before=await registry.capabilities.list({includeExpired:true});
  const exec=async sql=>driver==='postgres'?registry.query(sql):registry.db.exec(sql);
  // Rehearse the actual copy/swap against nonempty history, not only an empty DB.
  if(driver==='postgres')await registry.transaction(async()=>{for(const s of migration)await exec(s);});
  else registry.transaction(()=>{for(const s of migration)registry.db.exec(s);});
  assert.deepEqual(await registry.capabilities.list({includeExpired:true}),before);
  assert.equal((await registry.capabilities.latest(id)).capabilityId,revoked.capabilityId);
  assert.notEqual(older.capabilityId,revoked.capabilityId);
  const job=(await registry.jobs.enqueue({...id,jobClass:'settlement',operationKey:'settle'})).job;
  const leased=await registry.jobs.leaseById({jobId:job.jobId,token:0,owner:'qualified-worker',ttlMs:30000});
  const wrong=await registry.capabilities.grant({...id,programVersion:2,tags:[4],expiresAt});
  assert.equal((await registry.capabilities.authorizeLease({capability:wrong,operationKey:'settle',fencingToken:leased.fencingToken})).allowed,false,'a v2 grant cannot authorize the v3 row');
  const correct=await registry.capabilities.grant({...id,programVersion:3,tags:[4],expiresAt});
  assert.equal((await registry.capabilities.authorizeLease({capability:correct,operationKey:'settle',fencingToken:leased.fencingToken})).allowed,true);
  await registry.capabilities.revoke(correct.capabilityId);
  assert.equal((await registry.capabilities.authorizeLease({capability:correct,operationKey:'settle',fencingToken:leased.fencingToken})).allowed,false);
 }finally{if(driver==='sqlite')registry?.close();if(pool)await pool.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}}
});
