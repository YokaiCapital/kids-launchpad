// Backup and restore drill for a hosted shared registry (PostgreSQL). Read-only on the source: one consistent snapshot
// is exported with pg_dump (custom format, the transaction's exported snapshot), restored into a NEW database created
// on the PostgreSQL server the operator names, every table is fingerprinted on both sides and compared, the restored
// schema version is checked against this release, and the throwaway database is dropped. It never starts a worker,
// never signs, never sends RPC and never prints a URL. The archive stays in a private directory unless dropped.
import {mkdtempSync,chmodSync,readFileSync,writeFileSync,rmSync,statSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';import {tmpdir} from 'node:os';import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import pg from 'pg';
import {PostgresRegistry,REGISTRY_SCHEMA_VERSION} from '../registry/registry.mjs';
const run=promisify(execFile),sha256=b=>createHash('sha256').update(b).digest('hex');
const SCHEMA=/^[a-z_][a-z0-9_]{0,62}$/;
// execFile errors include the full command, including the private database URL.
// Emit a bounded diagnostic category, never the command, stderr or connection text.
export function drillFailureReason(error){
 const detail=String(error?.stderr??'');
 if(/server version mismatch/i.test(detail))return 'PostgreSQL client is older than the server; use matching or newer pg_dump and pg_restore tools';
 if(error?.code==='ENOENT')return 'PostgreSQL client tools are unavailable at the configured path';
 if(error?.report)return 'Restored database did not match the source snapshot or release schema';
 return 'Registry drill failed; check PostgreSQL client version, connectivity and database privileges';
}
function postgresUrl(value,name){let u;try{u=new URL(value);}catch{throw Error(name+' must be a PostgreSQL URL');}if(!['postgres:','postgresql:'].includes(u.protocol))throw Error(name+' must be a PostgreSQL URL');return u;}
async function fingerprint(client,schema){
 const tables=(await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',[schema])).rows.map(r=>r.tablename);
 const digest=createHash('sha256');let rows=0;const counts={};
 for(const table of tables){
  if(!SCHEMA.test(table))throw Error('Unexpected table name');
  const records=(await client.query(`SELECT row_to_json(t)::text AS content FROM "${schema}"."${table}" t ORDER BY row_to_json(t)::text`)).rows;
  digest.update(JSON.stringify([table,records.length]));for(const row of records){digest.update(row.content);digest.update('\n');}
  rows+=records.length;counts[table]=records.length;
 }
 return {tables:tables.length,rows,sha256:digest.digest('hex'),counts};
}
export async function drillRegistry({sourceUrl,restoreAdminUrl=sourceUrl,pgBin,schema='public',keepArchive=false,log=()=>{},now=Date.now}){
 postgresUrl(sourceUrl,'Source');const admin=postgresUrl(restoreAdminUrl,'Restore target');
 // With no separate server the throwaway database is created on the source server (never inside the source database).
 const restoreServer=restoreAdminUrl===sourceUrl?'same-server':'separate-server';
 if(!isAbsolute(pgBin??''))throw Error('Explicit PostgreSQL client tools directory required');
 if(!SCHEMA.test(schema))throw Error('Invalid schema name');
 const started=now();
 const output=mkdtempSync(join(tmpdir(),'kids-registry-drill-'));chmodSync(output,0o700);
 const archive=join(output,'registry.dump');
 const source=new pg.Client({connectionString:sourceUrl,options:'-c search_path='+schema,application_name:'kids-registry-drill'});
 const control=new pg.Client({connectionString:restoreAdminUrl,application_name:'kids-registry-drill'});
 const name='kids_drill_'+randomUUID().replaceAll('-',''),target=new URL(restoreAdminUrl);target.pathname='/'+name;
 let created=false,restoredPool=null,sourceVersion=null;
 const timings={};
 try{
  await source.connect();
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snapshot=(await source.query('SELECT pg_export_snapshot() AS snapshot, transaction_timestamp() AS at')).rows[0];
  const before=await fingerprint(source,schema);
  try{sourceVersion=Number((await source.query(`SELECT MAX(version) AS v FROM "${schema}".schema_migrations`)).rows[0].v);}catch{sourceVersion=null;}
  const dumpStart=now();
  await run(join(pgBin,'pg_dump'),['--dbname',sourceUrl,'--format=custom','--no-owner','--no-acl','--schema',schema,'--snapshot',snapshot.snapshot,'--file',archive],{timeout:600000,maxBuffer:1048576});
  timings.dumpMs=now()-dumpStart;chmodSync(archive,0o600);
  await source.query('COMMIT');await source.end();
  const archiveBytes=statSync(archive).size,archiveSha256=sha256(readFileSync(archive));
  log({event:'registry-drill-exported',tables:before.tables,rows:before.rows,archiveBytes});
  await control.connect();
  await control.query(`CREATE DATABASE ${name}`);created=true;
  const restoreStart=now();
  await run(join(pgBin,'pg_restore'),['--dbname',target.href,'--no-owner','--no-acl','--exit-on-error',archive],{timeout:600000,maxBuffer:1048576});
  timings.restoreMs=now()-restoreStart;
  restoredPool=new pg.Pool({connectionString:target.href,max:2,options:'-c search_path='+schema});
  const client=await restoredPool.connect();let after;try{after=await fingerprint(client,schema);}finally{client.release();}
  const fingerprintsMatch=after.tables===before.tables&&after.rows===before.rows&&after.sha256===before.sha256;
  const registry=new PostgresRegistry({pool:restoredPool});
  const restoredVersion=await registry.schemaVersion();
  const report={
   version:1,drilledAt:new Date(started).toISOString(),snapshotAt:new Date(snapshot.at).toISOString(),schema,
   source:{tables:before.tables,rows:before.rows,fingerprint:before.sha256,schemaVersion:sourceVersion},
   restored:{tables:after.tables,rows:after.rows,fingerprint:after.sha256,schemaVersion:restoredVersion,database:'dropped',server:restoreServer},
   fingerprintsMatch,schemaMatchesRelease:restoredVersion===REGISTRY_SCHEMA_VERSION,releaseSchemaVersion:REGISTRY_SCHEMA_VERSION,
   counts:{campaigns:before.counts.campaigns??0,jobs:before.counts.jobs??0,operationalBudgets:before.counts.operational_budgets??0,signerCapabilities:before.counts.signer_capabilities??0,operatorPackets:before.counts.operator_packets??0},
   archive:{bytes:archiveBytes,sha256:archiveSha256,path:keepArchive?archive:null},
   timings:{...timings,totalMs:now()-started},
   signedTransactionsSent:0,rpcCalls:0,
   verdict:fingerprintsMatch&&restoredVersion===REGISTRY_SCHEMA_VERSION?'PASS':'FAIL',
  };
  if(!fingerprintsMatch)throw Object.assign(Error('Restored tables differ from the source snapshot'),{report});
  if(restoredVersion!==REGISTRY_SCHEMA_VERSION)throw Object.assign(Error('Restored schema '+restoredVersion+' differs from this release ('+REGISTRY_SCHEMA_VERSION+')'),{report});
  writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
  return report;
 }finally{
  if(restoredPool)await restoredPool.end().catch(()=>{});
  await source.end().catch(()=>{});
  if(created)await control.query(`DROP DATABASE ${name}`).catch(error=>{log({event:'registry-drill-cleanup-failed',database:name,category:'drop'});throw error;});
  await control.end().catch(()=>{});
  if(!keepArchive)rmSync(output,{recursive:true,force:true});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2);const keepArchive=args.includes('--keep-archive');const schemaIndex=args.indexOf('--schema');
 const env=process.env;
 const sourceUrl=env.KIDS_DRILL_SOURCE_URL||env.KIDS_REGISTRY_URL||env.DATABASE_PUBLIC_URL||env.DATABASE_URL;
 drillRegistry({sourceUrl,restoreAdminUrl:env.KIDS_DRILL_RESTORE_URL||sourceUrl,pgBin:env.KIDS_DRILL_PG_BIN||'/usr/bin',schema:schemaIndex>=0?args[schemaIndex+1]:'public',keepArchive,log:line=>console.error(JSON.stringify(line))})
  .then(report=>{console.log(JSON.stringify(report,null,2));})
  .catch(error=>{console.error(JSON.stringify({event:'registry-drill-failed',reason:drillFailureReason(error)}));if(error.report)console.log(JSON.stringify(error.report,null,2));process.exitCode=1;});
}
