// Destructive actions are restricted to a new disposable database created here.
// Restores a quiet owned fleet schema; never starts workers, a signer or sends RPC.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,copyFileSync,mkdtempSync,chmodSync,statSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';import {tmpdir} from 'node:os';import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import pg from 'pg';
import {PostgresRegistry} from '../registry/registry.mjs';import {assertJournalCoverage} from '../signer/journal-coverage.mjs';
const run=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex');
export async function qualifyRestore({postgresUrl,directory,pgBin}){
 if(!postgresUrl?.startsWith('postgresql:///kids_registry_test?')||!isAbsolute(directory??'')||!directory.split('/').at(-1).startsWith('kids-fleet-')||!isAbsolute(pgBin??''))throw Error('Owned local fleet, test database and explicit PostgreSQL binaries required');
 const scope=JSON.parse(readFileSync(join(directory,'scope.json'))),manifest=JSON.parse(readFileSync(new URL('../.runtime/kids-scale-v3-program.json',import.meta.url)));
 assert.equal(scope.rpcUrl,'http://127.0.0.1:19499');assert.equal(manifest.scaleQualification,true);assert.equal(scope.genesisHash,manifest.genesisHash);assert.equal(scope.programId,manifest.programId);assert.match(scope.schema,/^kids_test_[a-f0-9]{32}$/);
 if(scope.backgroundDirectory)throw Error('Restore uses a self-contained quiet fleet');
 const source=new pg.Client({connectionString:postgresUrl,options:'-c search_path='+scope.schema}),control=new pg.Client({connectionString:postgresUrl});let restored,restoredPool,created=false;
 const name='kids_restore_'+randomUUID().replaceAll('-',''),target=new URL(postgresUrl);target.pathname='/'+name;
 const output=mkdtempSync(join(tmpdir(),'kids-restore-'));chmodSync(output,0o700);const archive=join(output,'registry.dump'),journal=join(output,'signer-state.json'),stateFile=join(directory,'signer-state.json');
 const initialState=readFileSync(stateFile);assert.equal(statSync(stateFile).mode&0o077,0);
 const copy=()=>{copyFileSync(stateFile,journal);chmodSync(journal,0o600);assert.equal(hash(readFileSync(journal)),hash(initialState));};
 async function quiet(client){
  const r=(await client.query(`SELECT
   (SELECT count(*) FROM signer_ownership WHERE owner IS NOT NULL AND expires_ms>EXTRACT(EPOCH FROM clock_timestamp())*1000) signers,
   (SELECT count(*) FROM worker_presence WHERE state='running' AND observed_ms>EXTRACT(EPOCH FROM clock_timestamp())*1000-20000) workers,
   (SELECT count(*) FROM jobs WHERE state='leased') leases,
   (SELECT count(*) FROM operating_spend_holds WHERE state='held') holds`)).rows[0];
  assert.ok(Object.values(r).every(x=>Number(x)===0),'Source must be stopped and fully reconciled');
 }
 async function fingerprint(client){
  const tables=(await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',[scope.schema])).rows;let rows=0;const digest=createHash('sha256');
  for(const {tablename} of tables){assert.match(tablename,/^[a-z_][a-z0-9_]*$/);const records=(await client.query(`SELECT row_to_json(t)::text AS content FROM "${scope.schema}"."${tablename}" t ORDER BY row_to_json(t)::text`)).rows;digest.update(JSON.stringify([tablename,records.length]));for(const row of records){digest.update(row.content);digest.update('\n');}rows+=records.length;}
  return {tables:tables.length,rows,sha256:digest.digest('hex')};
 }
 try{
  await source.connect();await control.connect();await quiet(source);await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snapshot=(await source.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;const before=await fingerprint(source);copy();
  // Output directory is private before pg_dump creates any archive bytes.
  await run(join(pgBin,'pg_dump'),['--dbname',postgresUrl,'--format=custom','--no-owner','--no-acl','--schema',scope.schema,'--snapshot',snapshot,'--file',archive],{timeout:120000,maxBuffer:1048576});chmodSync(archive,0o600);
  assert.equal(hash(readFileSync(stateFile)),hash(initialState),'Signer state changed during backup');await source.query('COMMIT');await quiet(source);
  const checkpoint={version:1,scope:{genesisHash:scope.genesisHash,programId:scope.programId,payer:manifest.treasury},database:before,archiveSha256:hash(readFileSync(archive)),signerSha256:hash(readFileSync(journal)),createdAt:new Date().toISOString()};
  writeFileSync(join(output,'checkpoint.json'),JSON.stringify(checkpoint,null,2),{mode:0o600,flag:'wx'});
  await control.query(`CREATE DATABASE ${name}`);created=true;
  await run(join(pgBin,'pg_restore'),['--dbname',target.href,'--no-owner','--no-acl','--exit-on-error',archive],{timeout:120000,maxBuffer:1048576});
  restoredPool=new pg.Pool({connectionString:target.href,max:2,options:'-c search_path='+scope.schema});restored=new PostgresRegistry({pool:restoredPool});
  const restoredClient=await restoredPool.connect();let after;try{after=await fingerprint(restoredClient);}finally{restoredClient.release();}assert.deepEqual(after,before);
  const coverage=await assertJournalCoverage({registry:restored,stateFile:journal,...checkpoint.scope});
  // Demonstrate that a rolled-back volume cannot erase already signed exposure.
  const saved=JSON.parse(readFileSync(journal));assert.ok(saved.registry.length>0);
  writeFileSync(journal,JSON.stringify({...saved,ledger:[],registry:[]}));await assert.rejects(assertJournalCoverage({registry:restored,stateFile:journal,...checkpoint.scope}),/recovery verification/);
  writeFileSync(journal,initialState);assert.equal(hash(readFileSync(journal)),checkpoint.signerSha256);
  await assertJournalCoverage({registry:restored,stateFile:journal,...checkpoint.scope});
  const report={network:'isolated-localnet',restoredTables:after.tables,restoredRows:after.rows,allTableFingerprintsMatch:true,journalCoverage:coverage,rollbackRefused:true,signedTransactionsSent:0,remoteImmutableCheckpoint:false,hostedPitr:false,directory:output};
  writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});return report;
 }finally{
  if(restoredPool)await restoredPool.end();await source.end().catch(()=>{});
  if(created)await control.query(`DROP DATABASE ${name}`);await control.end().catch(()=>{});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)qualifyRestore({postgresUrl:process.env.KIDS_TEST_POSTGRES_URL,directory:process.env.KIDS_FLEET_RESUME,pgBin:process.env.KIDS_TEST_PG_BIN}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.stack);process.exitCode=1;});
