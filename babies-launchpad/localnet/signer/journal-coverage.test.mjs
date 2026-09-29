import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,symlink,unlink} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';import pg from 'pg';import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';import {writeDurableJson} from '../../shared/durable-json.mjs';
import {assertJournalCoverage} from './journal-coverage.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
async function fixture(fn){
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1}),dir=await mkdtemp(join(tmpdir(),'kids-journal-coverage-'));let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:3,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const scope={genesisHash:key(1),programId:key(2),payer:key(3)},id={...scope,campaign:key(4)},stateFile=join(dir,'journal.json');
  await registry.campaigns.upsert({...id,mode:'standard',campaignVersion:3,registryStatus:'active'});
  const job=(await registry.jobs.enqueue({...id,jobClass:'settlement',operationKey:'settlement'})).job;await registry.jobs.leaseById({jobId:job.jobId,token:0,owner:'fixture',ttlMs:30000});
  const binding={...id,policy:'fixture',operationId:'op:'+'a'.repeat(64),messageHash:'b'.repeat(64),maximumLamports:'5000'};
  const approvedAt=Date.now();const journal={ledger:[{at:approvedAt,lamports:'5000'}],registry:[[binding.operationId,{hash:binding.messageHash,at:approvedAt}]],fences:[[id.campaign+'|settlement',1]]};
  const hold=()=>registry.query("INSERT INTO operating_spend_holds(genesis_hash,program_id,campaign,payer,operation_id,message_hash,maximum_lamports,policy,state) VALUES(?,?,?,?,?,?,?,?,?)",[scope.genesisHash,scope.programId,id.campaign,scope.payer,binding.operationId,binding.messageHash,'5000','fixture','held']);
  const shadow=async()=>{await registry.operatorPackets.prepare({operationId:'c'.repeat(64),descriptor:JSON.stringify({binding}),prepared:{fixture:true}});await registry.operatorPackets.sign({operationId:'c'.repeat(64),attempt:1,signedBase64:'fixture',signature:'1'.repeat(64)});};
  const check=()=>assertJournalCoverage({registry,stateFile,...scope});
  await fn({registry,scope,id,stateFile,journal,hold,shadow,check,dir,binding});
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();await rm(dir,{recursive:true,force:true});}
}
test('an unused v3 signer may start; persisted approvals require matching shared holds and fences',{skip:!url},()=>fixture(async f=>{
 assert.equal((await f.check()).verified,true);
 writeDurableJson(f.stateFile,f.journal);await assert.rejects(f.check(),/recovery verification/);
 await f.hold();assert.equal((await f.check()).approvals,1);
 await f.shadow();assert.equal((await f.check()).fences,1);
 await f.registry.query('UPDATE jobs SET fencing_token=2');assert.equal((await f.check()).verified,true);
 await f.registry.query('UPDATE jobs SET fencing_token=0');await assert.rejects(f.check(),/recovery verification/);
}));
test('older database or signer volume is refused, including a missing old signed history',{skip:!url},()=>fixture(async f=>{
 await f.hold();await f.shadow();writeDurableJson(f.stateFile,f.journal);await f.check();
 writeDurableJson(f.stateFile,{...f.journal,registry:[]});await assert.rejects(f.check(),/recovery verification/);
 writeDurableJson(f.stateFile,f.journal);await f.registry.query('DELETE FROM operating_spend_holds');await assert.rejects(f.check(),/recovery verification/);
 await unlink(f.stateFile);await assert.rejects(f.check(),/recovery verification/);
 await f.registry.query("UPDATE operator_packets SET updated_at='2020-01-01T00:00:00.000Z'");await assert.rejects(f.check(),/recovery verification/);
}));
test('journal coverage refuses unsafe files, duplicate or malformed state and another payer scope',{skip:!url},()=>fixture(async f=>{
 await f.hold();writeDurableJson(f.stateFile,f.journal);await f.check();
 await chmod(f.stateFile,0o644);await assert.rejects(f.check(),/recovery verification/);await chmod(f.stateFile,0o600);
 for(const journal of [{...f.journal,fences:[...f.journal.fences,...f.journal.fences]},{...f.journal,registry:[...f.journal.registry,...f.journal.registry]},{...f.journal,ledger:[{at:0,lamports:'NaN'}]}]){writeDurableJson(f.stateFile,journal);await assert.rejects(f.check(),/recovery verification/);}
 writeDurableJson(f.stateFile,f.journal);await assert.rejects(assertJournalCoverage({registry:f.registry,stateFile:f.stateFile,...f.scope,payer:key(9)}),/recovery verification/);
 const alternate=join(f.dir,'link.json');await symlink(f.stateFile,alternate);await assert.rejects(assertJournalCoverage({registry:f.registry,stateFile:alternate,...f.scope}),/recovery verification/);
}));
test('a conservative charge saved before approval survives restart without inventing a signature',{skip:!url},()=>fixture(async f=>{
 await f.hold();writeDurableJson(f.stateFile,{...f.journal,registry:[],fences:[]});assert.equal((await f.check()).verified,true);
 const before=(await f.registry.query('SELECT * FROM operating_spend_holds')).rows;await f.check();assert.deepEqual((await f.registry.query('SELECT * FROM operating_spend_holds')).rows,before);
}));

test('terminal shadow packets still require approval history and its hourly spend charge',{skip:!url},()=>fixture(async f=>{
 await f.hold();await f.shadow();writeDurableJson(f.stateFile,f.journal);await f.check();
 await f.registry.operatorPackets.progress({operationId:'c'.repeat(64),attempt:1,from:'signed',to:'finalized',result:{slot:9}});
 await f.check();
 for(const changes of [{registry:[]},{ledger:[]},{ledger:[{...f.journal.ledger[0],lamports:'4999'}]},{ledger:[{...f.journal.ledger[0],at:f.journal.ledger[0].at-1}]}]){
  writeDurableJson(f.stateFile,{...f.journal,...changes});await assert.rejects(f.check(),/recovery verification/);
 }
 writeDurableJson(f.stateFile,f.journal);assert.equal((await f.check()).verified,true);
}));
test('multiple approvals at the same instant cannot reuse one charge',{skip:!url},()=>fixture(async f=>{
 await f.hold();const operationId='op:'+'d'.repeat(64);await f.registry.query("INSERT INTO operating_spend_holds SELECT genesis_hash,program_id,campaign,payer,?,?,maximum_lamports,policy,state,actual_lamports,evidence_json FROM operating_spend_holds",[operationId,'e'.repeat(64)]);
 const journal={...f.journal,registry:[...f.journal.registry,[operationId,{...f.journal.registry[0][1],hash:'e'.repeat(64)}]]};
 writeDurableJson(f.stateFile,journal);await assert.rejects(f.check(),/recovery verification/);
 writeDurableJson(f.stateFile,{...journal,ledger:[...journal.ledger,...journal.ledger]});assert.equal((await f.check()).approvals,2);
}));
