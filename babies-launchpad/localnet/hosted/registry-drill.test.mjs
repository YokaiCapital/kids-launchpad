import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import {existsSync} from 'node:fs';import pg from 'pg';import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry,REGISTRY_SCHEMA_VERSION} from '../registry/registry.mjs';
import {drillRegistry,drillFailureReason} from './registry-drill.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,pgBin=process.env.KIDS_TEST_PG_BIN,key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
test('registry drill failure diagnostics never expose connection credentials or command output',()=>{
 const connection='postgresql://operator:private-example-password@private-host/database';
 for(const extra of [{},{code:'ENOENT'},{stderr:'pg_dump: error: aborting because of server version mismatch '+connection},{report:{}}]){
  const reason=drillFailureReason(Object.assign(Error('Command failed: pg_dump --dbname '+connection),{cmd:connection,stderr:connection,...extra}));
  assert.ok(!reason.includes('private-example-password'));assert.ok(!reason.includes('postgresql:'));assert.ok(!reason.includes('private-host'));
 }
 assert.match(drillFailureReason({stderr:'aborting because of server version mismatch'}),/older than the server/);
});
test('registry drill: consistent export, restore into a throwaway database, equal fingerprints, release schema, cleanup',{skip:!(url&&pgBin)&&'KIDS_TEST_POSTGRES_URL and KIDS_TEST_PG_BIN unset'},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:4,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  for(const n of [3,4])await registry.campaigns.upsert({genesisHash:key(1),programId:key(2),campaignVersion:3,campaign:key(n),mode:'standard',registryStatus:'active'});
  const logs=[];
  const report=await drillRegistry({sourceUrl:url,restoreAdminUrl:url,pgBin,schema,log:l=>logs.push(l)});
  assert.equal(report.verdict,'PASS');assert.equal(report.fingerprintsMatch,true);assert.equal(report.schemaMatchesRelease,true);
  assert.equal(report.restored.schemaVersion,REGISTRY_SCHEMA_VERSION);assert.equal(report.source.schemaVersion,REGISTRY_SCHEMA_VERSION);
  assert.equal(report.restored.tables,report.source.tables);assert.ok(report.source.tables>=40);assert.equal(report.counts.campaigns,2);
  assert.equal(report.restored.database,'dropped');assert.equal(report.restored.server,'same-server');assert.equal(report.archive.path,null);assert.ok(report.archive.bytes>1000);assert.match(report.archive.sha256,/^[0-9a-f]{64}$/);
  assert.equal(report.signedTransactionsSent,0);assert.equal(report.rpcCalls,0);assert.ok(report.timings.dumpMs>=0&&report.timings.restoreMs>=0&&report.timings.totalMs>=report.timings.restoreMs);
  assert.ok(!JSON.stringify(report).includes('kids_registry_test?host'),'no connection details in the report');
  const left=(await control.query("SELECT datname FROM pg_database WHERE datname LIKE 'kids_drill_%'")).rows;assert.deepEqual(left,[],'the throwaway database is dropped');
  assert.equal(logs[0].event,'registry-drill-exported');assert.equal(logs[0].rows,report.source.rows);
  const kept=await drillRegistry({sourceUrl:url,restoreAdminUrl:url,pgBin,schema,keepArchive:true});
  assert.ok(kept.archive.path&&existsSync(kept.archive.path),'--keep-archive leaves the dump in its private folder');
  const {rmSync}=await import('node:fs');rmSync(kept.archive.path.replace(/\/registry\.dump$/,''),{recursive:true,force:true});
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
test('registry drill refuses vague inputs',async()=>{
 await assert.rejects(drillRegistry({sourceUrl:'mysql://x',restoreAdminUrl:'postgresql://y',pgBin:'/usr/bin'}),/Source must be a PostgreSQL URL/);
 await assert.rejects(drillRegistry({sourceUrl:'postgresql://x',restoreAdminUrl:'file:///y',pgBin:'/usr/bin'}),/Restore target/);
 await assert.rejects(drillRegistry({sourceUrl:'postgresql://x',restoreAdminUrl:'postgresql://y',pgBin:'bin'}),/client tools/);
 await assert.rejects(drillRegistry({sourceUrl:'postgresql://x',restoreAdminUrl:'postgresql://y',pgBin:'/usr/bin',schema:'bad;name'}),/schema/);
});
