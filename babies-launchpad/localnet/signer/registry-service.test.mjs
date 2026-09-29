import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import {mkdtemp,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import pg from 'pg';
import {Keypair,PublicKey,TransactionInstruction,TransactionMessage} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {createRegistrySignerService} from './registry-service.mjs';
import * as client from '../protocol-v2/client.mjs';
import * as policy from '../protocol-v2/policy.mjs';
import {feeSetupInstructions} from '../creation/operating-costs.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL;
const addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
for(const programVersion of [2,3])test('registry signer v'+programVersion+' scopes grants and requires the actual current lease without legacy fallback',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-','');const admin=new pg.Pool({connectionString:url,max:1});
 const dir=await mkdtemp(join(tmpdir(),'kids-signer-scope-'));let pool,service;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:2,options:`-c search_path=${schema}`});
  const registry=new PostgresRegistry({pool});await registry.migrate();
  const id={genesisHash:addr(1),programId:addr(2),campaign:addr(3)},other={...id,genesisHash:addr(4)};
  for(const identity of [id,other]){await registry.campaigns.upsert({...identity,mode:'standard',campaignVersion:programVersion,registryStatus:'planned'});await registry.capabilities.grant({...identity,programVersion,tags:[4],expiresAt:new Date(Date.now()+60000).toISOString()});}
  const requested=[];const latest=registry.capabilities.latest.bind(registry.capabilities);
  registry.capabilities.latest=async identity=>{requested.push(identity);return latest(identity);};
  registry.capabilities.list=async()=>{throw Error('Signer must not enumerate the entire capability table');};
  const job=(await registry.jobs.enqueue({...id,jobClass:'settlement',operationKey:'settle'})).job;
  const payer=Keypair.generate(),token='synthetic-scoped-registry-signer'.padEnd(40,'x');
  const args={admitRpc:async()=>{},registry,connection:{getGenesisHash:async()=>id.genesisHash},...id,programVersion,keypair:payer,token,stateFile:join(dir,'state.json')};
  if(programVersion===3){await assert.rejects(createRegistrySignerService(args),/operating funding/);await assert.rejects(createRegistrySignerService({...args,admitRpc:null,operatingBudget:{reserve:async()=>{},recordSignature:async()=>{}}}),/shared RPC admission/);}
  // This test isolates lease/grant behavior; operating-budget.test covers actual
  // shared reservations and signed-packet persistence instead of these stubs.
  service=await createRegistrySignerService({...args,operatingBudget:programVersion===3?{reserve:async()=>({state:'held'}),recordSignature:async()=>{}}:null});
  if(programVersion===3)await assert.rejects(createRegistrySignerService({...args,operatingBudget:{reserve:async()=>({state:'held'}),recordSignature:async()=>{}}}),/ownership unavailable/);
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  const message=new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:addr(5),instructions:[new TransactionInstruction({programId:new PublicKey(id.programId),keys:[{pubkey:new PublicKey(id.campaign),isSigner:false,isWritable:true},{pubkey:payer.publicKey,isSigner:true,isWritable:true}],data:Buffer.from([4])})]}).compileToV0Message();
  const body={message:Buffer.from(message.serialize()).toString('base64'),campaign:id.campaign,operationKey:'settle',operationId:'operation:1',fencingToken:1};
  const post=x=>fetch('http://127.0.0.1:'+service.server.address().port+'/sign',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(x)});
  assert.equal((await post(body)).status,409,'queued job cannot sign');
  await registry.jobs.leaseById({jobId:job.jobId,token:0,owner:'one',ttlMs:30000});
  assert.equal((await post(body)).status,200,'explicit scope selects the right ledger grant');
  assert.ok(requested.length>=2);assert.ok(requested.every(x=>JSON.stringify(x)===JSON.stringify(id)));
  assert.equal((await post({...body,campaign:undefined})).status,403,'omitting campaign cannot bypass capability policy');
  await registry.jobs.requeue({jobId:job.jobId,token:1,result:{}});
  assert.equal((await post(body)).status,409,'even identical signed-packet retry needs a live lease');
  await registry.jobs.leaseById({jobId:job.jobId,token:1,owner:'two',ttlMs:30000});
  const revoked=await registry.capabilities.grant({...id,programVersion,tags:[4],expiresAt:new Date(Date.now()+60000).toISOString()});
  await registry.capabilities.revoke(revoked.capabilityId);
  assert.equal((await post({...body,fencingToken:2})).status,403,'revoked latest grant never falls back to the older valid one');
  await registry.capabilities.grant({...id,programVersion,tags:[4],expiresAt:new Date(Date.now()-1000).toISOString()});
  assert.equal((await post({...body,fencingToken:2})).status,403,'expired latest grant never falls back either');
 }finally{if(service?.server.listening)await service.close();if(pool)await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();await rm(dir,{recursive:true,force:true});}
});

test('fee setup signer checks sealed recipients before admitting a specialized v3 grant',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url,max:1}),dir=await mkdtemp(join(tmpdir(),'kids-fee-setup-scope-'));let pool,service;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:2,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  // Separate identities as on mainnet: the signer pays, the sealed platform treasury is a different key it never holds.
  const payer=Keypair.generate(),treasury=Keypair.generate().publicKey,dev=Keypair.generate().publicKey,program=Keypair.generate().publicKey,genesis=Keypair.generate().publicKey;
  const vector=JSON.parse(await readFile(new URL('../protocol-v2/test-vectors.json',import.meta.url))).termsHash.find(v=>v.name==='standard');
  const t={...vector.terms,creator:client.keyHex(dev),dev:client.keyHex(dev),treasury:client.keyHex(treasury),genesis:client.keyHex(genesis)},campaign=client.campaignAddress(program,dev,t.nonce),data=Buffer.alloc(policy.CAMPAIGN_LEN);
  client.CAMPAIGN_MAGIC.copy(data);policy.encodeTerms(t).copy(data,8);policy.termsHash(data.subarray(8,808)).copy(data,808);const terms=client.decodeCampaign(data).terms;
  const id={genesisHash:String(genesis),programId:String(program),campaign:String(campaign)};
  await registry.campaigns.upsert({...id,mode:'standard',campaignVersion:3,registryStatus:'planned'});
  const grant={...id,programVersion:3,kind:'fee-setup',tags:[20],recipients:[String(treasury),String(dev)],expiresAt:new Date(Date.now()+60000).toISOString()};
  for(const patch of [{programVersion:2},{tags:[20,23]},{recipients:[]}])await assert.rejects(registry.capabilities.grant({...grant,...patch}),/Fee setup/);
  const token='synthetic-fee-setup-grant-test-token',connection={getGenesisHash:async()=>id.genesisHash,getAccountInfo:async()=>({owner:program,data}),getMinimumBalanceForRentExemption:async size=>(size+128)*6960};let reserved=0,rpcBlocked=false;
  service=await createRegistrySignerService({admitRpc:async()=>{if(rpcBlocked)throw Object.assign(Error('busy'),{code:'CAPACITY_WAIT',retryAfterMs:125});},registry,connection,...id,programVersion:3,keypair:payer,token,stateFile:join(dir,'state.json'),treasury:String(treasury),operatingBudget:{reserve:async()=>{reserved++;return {state:'held'};},recordSignature:async()=>{}}});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  const job=(await registry.jobs.enqueue({...id,jobClass:'fee-harvest',operationKey:'fee-init'})).job;await registry.jobs.leaseById({jobId:job.jobId,token:0,owner:'fixture',ttlMs:30000});
  const message=new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:addr(5),instructions:feeSetupInstructions({programId:program,campaign,payer:payer.publicKey,operator:dev,terms})}).compileToV0Message();
  const body={message:Buffer.from(message.serialize()).toString('base64'),campaign:id.campaign,operationKey:'fee-init',operationId:'fee-setup:1',fencingToken:1};
  const post=()=>fetch('http://127.0.0.1:'+service.server.address().port+'/sign',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
  await registry.capabilities.grant({...grant,recipients:[String(treasury),addr(9)]});assert.equal((await post()).status,403);assert.equal(reserved,0,'Wrong grant cannot reserve or reach signing');
  await registry.capabilities.grant(grant);rpcBlocked=true;const busy=await post();assert.equal(busy.status,429);assert.equal((await busy.json()).category,'signer-capacity');assert.equal(reserved,0,'RPC admission refusal must not reserve funding or sign');rpcBlocked=false;assert.equal((await post()).status,200);assert.equal(reserved,1);
  data[20]^=1;assert.notEqual((await post()).status,200,'Corrupt sealed terms cannot reuse a prior signature');assert.equal(reserved,1);
 }finally{if(service?.server.listening)await service.close();if(pool)await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();await rm(dir,{recursive:true,force:true});}
});
