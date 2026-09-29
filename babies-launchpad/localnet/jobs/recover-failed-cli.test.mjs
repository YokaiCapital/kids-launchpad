// The owner recovery command: the parser fails closed before any database is opened; the dry run prints the reviewed row
// and the exact write invocation; the write path requires the reviewed token, result hash and scope and refuses when the
// row moved on (a changed token, or a changed result at the same token) without an audit row or a requeue; bind-refill
// repairs one legacy refill row. Real PostgreSQL in an isolated schema.
import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import pg from 'pg';import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';import {canonicalHash} from '../registry/canonical.mjs';
import {main,parseArgs} from './recover-failed-cli.mjs';import {recoverFailedJob} from './recover-failed.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const identity={genesisHash:addr(1),programId:addr(2),campaign:addr(3)};
const hex64='b'.repeat(64);
test('the parser fails closed and no registry is opened on a bad command line',async()=>{
 const good=['--job','j','--reason','r','--recovery-id','id','--dry-run'];
 assert.deepEqual(parseArgs(good),{job:'j',reason:'r','recovery-id':'id','dry-run':true,action:'requeue',dryRun:true,actor:'owner-terminal'});
 for(const [argv,message] of [
  [['--job','j','--reason','r','--recovery-id','id','--dry_run'],/Unknown option --dry_run/],
  [['--job','j','--reason','r','--recovery-id','id','--verbose'],/Unknown option/],
  [['--job','j','--job','k','--reason','r','--recovery-id','id','--dry-run'],/Duplicate option --job/],
  [['--job','--reason','r','--recovery-id','id','--dry-run'],/Missing value for --job/],
  [['--job','j','--reason','r','--recovery-id'],/Missing value for --recovery-id/],
  [['j','--reason','r'],/Unexpected argument j/],
  [['--job','j','--recovery-id','id','--dry-run'],/--reason is required/],
  [['--job','j','--reason','r','--recovery-id','id'],/--expected-token is required for the write path/],
  [['--job','j','--reason','r','--recovery-id','id','--expected-token','x','--genesis','g','--program','p','--campaign','c'],/whole number/],
  [['--job','j','--reason','r','--recovery-id','id','--expected-token','1','--expected-hash','zz','--genesis','g','--program','p','--campaign','c'],/--expected-hash must be/],
  [['--job','j','--reason','r','--recovery-id','id','--dry-run','--expected-token','1'],/belongs to the write path/],
  [['--action','delete','--job','j','--recovery-id','id','--dry-run'],/--action must be/],
  [['--action','bind-refill','--job','j','--recovery-id','id','--expected-token','0','--expected-hash',hex64,'--genesis','g','--program','p','--campaign','c'],/not used by bind-refill/],
 ]){
  let opened=0;await assert.rejects(main(argv,{KIDS_REGISTRY_URL:'postgres://unused'},()=>{},{registryFactory:()=>{opened++;throw Error('must not open');}}),message);assert.equal(opened,0,'no registry for '+argv.join(' '));
 }
});
test('dry run, reviewed write, stale review and bind-refill through the command',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url,max:1});let pool;
 const scoped=url+(url.includes('?')?'&':'?')+'options='+encodeURIComponent('-c search_path='+schema);
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:4,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  await registry.campaigns.upsert({...identity,mode:'standard',campaignVersion:3,registryStatus:'planned'});
  const fail=async(job,result)=>{const lease=await registry.jobs.leaseById({jobId:job.jobId,token:job.fencingToken??0,owner:'fixture'});return registry.jobs.fail({jobId:job.jobId,token:lease.fencingToken,error:result.reason,result});};
  const decoder={outcome:'failed-permanent',category:'unknown',attempts:1,error:'Activity decoder requires supported finalized data',reason:'Activity decoder requires supported finalized data'};
  const j=(await registry.jobs.enqueue({...identity,operationKey:'activity-live:0',jobClass:'activity-index'})).job;const failed=await fail(j,decoder);
  const run=async argv=>{const lines=[];const code=await main(argv,{KIDS_REGISTRY_URL:scoped},l=>lines.push(JSON.parse(l)));return {code,lines};};
  const base=['--job',j.jobId,'--reason','activity-decoder-fix-reviewed','--recovery-id','test-recovery:'+j.jobId];
  // Dry run: the reviewed row and the write invocation, no change.
  const dry=await run([...base,'--dry-run']);
  assert.equal(dry.code,0);assert.equal(dry.lines[0].before.state,'failed');assert.equal(dry.lines[0].before.token,String(failed.fencingToken));assert.equal(dry.lines[0].before.resultHash,canonicalHash(failed.result));
  assert.match(dry.lines[1].invocation,/^zsh deployment\/hosted\/pilot-recover-job\.sh '--action' 'requeue' .* '--expected-token' '\d+' '--genesis' '.* '--actor' 'owner-terminal'$/);assert.equal((await registry.jobs.get(j.jobId)).state,'failed');
  const reviewed=[...base,'--expected-token',String(failed.fencingToken),'--expected-hash',canonicalHash(failed.result),'--genesis',identity.genesisHash,'--program',identity.programId,'--campaign',identity.campaign,'--actor','owner-terminal'];
  const audits=()=>registry.query('SELECT COUNT(*)::int n FROM job_recoveries WHERE job_id=?',[j.jobId]).then(r=>r.rows[0].n);
  // Stale review 1: after the dry run the row was recovered once by another operator and failed again (higher token, still eligible).
  await recoverFailedJob({registry,identity,jobId:j.jobId,expectedToken:failed.fencingToken,expectedResultHash:canonicalHash(failed.result),recoveryId:'setup:'+j.jobId,actor:'fixture',reason:'activity-decoder-fix-reviewed'});
  const again=await fail(await registry.jobs.get(j.jobId),decoder);assert.ok(again.fencingToken>failed.fencingToken);
  const auditsBefore=await audits();
  const stale=await run(reviewed);assert.equal(stale.code,2);assert.equal(stale.lines[1].refused,true);assert.equal(stale.lines[1].code,'RECOVERY_CONFLICT');assert.match(stale.lines[1].message,/fencing token/);
  assert.equal((await registry.jobs.get(j.jobId)).state,'failed');assert.equal(await audits(),auditsBefore,'no audit row for a stale review');
  // Fresh review of the moved row; a wrong scope is refused before any write.
  const fresh=[...base,'--expected-token',String(again.fencingToken),'--expected-hash',canonicalHash(again.result),'--genesis',identity.genesisHash,'--program',identity.programId,'--campaign',identity.campaign];
  const wrongScope=await run([...fresh.slice(0,-2),'--campaign',addr(9)]);assert.equal(wrongScope.code,2);assert.match(wrongScope.lines[1].message,/campaign differs/);assert.equal(await audits(),auditsBefore);
  const ok=await run(fresh);assert.equal(ok.code,0,JSON.stringify(ok.lines));assert.equal(ok.lines[1].recovery.requeued,true);assert.equal(ok.lines[2].after.state,'queued');assert.equal(await audits(),auditsBefore+1);
  // Stale review 2: a different eligible result at the same token.
  const k=(await registry.jobs.enqueue({...identity,operationKey:'activity-live:1',jobClass:'activity-index'})).job;const kFailed=await fail(k,decoder);
  const kBase=['--job',k.jobId,'--reason','activity-decoder-fix-reviewed','--recovery-id','test-recovery:'+k.jobId,'--expected-token',String(kFailed.fencingToken),'--genesis',identity.genesisHash,'--program',identity.programId,'--campaign',identity.campaign];
  const otherHash=canonicalHash({...decoder,attempts:2});
  const staleResult=await run([...kBase,'--expected-hash',otherHash]);assert.equal(staleResult.code,2);assert.match(staleResult.lines[1].message,/result hash differs/);
  assert.equal((await registry.jobs.get(k.jobId)).state,'failed');assert.equal((await registry.query('SELECT COUNT(*)::int n FROM job_recoveries WHERE job_id=?',[k.jobId])).rows[0].n,0);
  const kOk=await run([...kBase,'--expected-hash',canonicalHash(kFailed.result)]);assert.equal(kOk.code,0,JSON.stringify(kOk.lines));assert.equal(kOk.lines[2].after.state,'queued');
  const missing=await run(['--job',randomUUID(),'--reason','activity-decoder-fix-reviewed','--recovery-id','x','--dry-run']);assert.equal(missing.code,2);assert.equal(missing.lines[0].code,'NOT_FOUND');
  // bind-refill through the command: a legacy unbound refill row with a verified activation.
  const legacy={...identity,campaign:addr(5)};await registry.campaigns.upsert({...legacy,mode:'standard',campaignVersion:3,registryStatus:'planned'});
  const legacyRow=(await registry.jobs.enqueue({...legacy,jobClass:'operating-refill',operationKey:'operating-refill:0'})).job;
  await registry.query('INSERT INTO standard_fee_activations(genesis_hash,program_id,campaign,descriptor_hash,setup_capability_id,active_capability_id,setup_job_id,payer,policy,minimum_reserve_lamports,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[legacy.genesisHash,legacy.programId,legacy.campaign,'a'.repeat(64),randomUUID(),randomUUID(),randomUUID(),addr(7),'creator-funded-v1','1000000','{}',new Date().toISOString()]);
  const bindDry=await run(['--action','bind-refill','--job',legacyRow.jobId,'--recovery-id','bind:'+legacyRow.jobId,'--dry-run']);assert.equal(bindDry.code,0);assert.equal(bindDry.lines[0].before.hasBinding,false);assert.match(bindDry.lines[1].invocation,/^zsh deployment\/hosted\/pilot-recover-job\.sh '--action' 'bind-refill' /);
  const bind=await run(['--action','bind-refill','--job',legacyRow.jobId,'--recovery-id','bind:'+legacyRow.jobId,'--expected-token','0','--genesis',legacy.genesisHash,'--program',legacy.programId,'--campaign',legacy.campaign]);
  assert.equal(bind.code,0,JSON.stringify(bind.lines));assert.equal(bind.lines[1].repair.repaired,true);assert.equal(bind.lines[2].after.binding.payer,addr(7));assert.equal(bind.lines[2].after.token,'0');
 }finally{if(pool)await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
