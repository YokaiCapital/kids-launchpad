// The v3 registry signer with lookup-table packets: a signature is possible only for a durable packet whose pinned
// resolution matches the request and proves on the ledger; replay of the same accepted packet after a lost response
// returns the same signature; mismatched, unpinned and foreign resolutions are refused before any reservation.
import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID,createPublicKey,verify} from 'node:crypto';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import pg from 'pg';
import {Keypair,PublicKey,TransactionMessage,VersionedTransaction,ComputeBudgetProgram,AddressLookupTableAccount,AddressLookupTableProgram} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {settleInstruction} from '../protocol-v2/client.mjs';
import {createOperatingSignerBudget} from './operating-budget.mjs';
import {createRegistrySignerService} from './registry-service.mjs';
import {pinCompiledLookups} from './lookup-resolution.mjs';
import {encodeLookupTableAccount,U64_MAX} from '../test/helpers/lookup-table-account.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,key=()=>Keypair.generate().publicKey;
const spki=pk=>createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(new PublicKey(pk).toBytes())]),format:'der',type:'spki'});
test('v3 signer signs lookup-table packets only through the pinned resolution of the durable packet',{skip:!url},async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1}),dir=await mkdtemp(join(tmpdir(),'kids-lookup-signer-'));let pool,service;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const payer=Keypair.generate(),base={genesisHash:String(key()),programId:String(key()),campaign:String(key()),payer:String(payer.publicKey),policy:'lookup-signing-test'};
  await registry.campaigns.upsert({...base,mode:'standard',campaignVersion:3,registryStatus:'planned'});
  await registry.capabilities.grant({...base,programVersion:3,tags:[4],expiresAt:new Date(Date.now()+60000).toISOString()});
  const job=(await registry.jobs.enqueue({...base,jobClass:'settlement',operationKey:'settle'})).job;await registry.jobs.leaseById({jobId:job.jobId,token:0,owner:'lookup-test',ttlMs:30000});
  // The ledger: one table owned by the payer holding the settle instruction's non-signer accounts.
  const ix=settleInstruction(base.programId,base.campaign,key()),tableKey=key();
  const entries=[...new Set(ix.keys.filter(k=>!k.isSigner).map(k=>String(k.pubkey)))].map(x=>new PublicKey(x));
  const ledger=new Map([[String(tableKey),{authority:payer.publicKey,addresses:entries,lastExtendedSlot:10,deactivationSlot:U64_MAX}]]);
  let rpcDown=false;const rpcCalls=[];
  const connection={getGenesisHash:async()=>base.genesisHash,getBlockHeight:async()=>50,getEpochInfo:async()=>({blockHeight:50,absoluteSlot:60}),
   getAccountInfoAndContext:async(k,commitment)=>{rpcCalls.push(commitment);if(rpcDown)throw Error('rpc down');const x=ledger.get(String(k));return {context:{slot:1000},value:x?{owner:AddressLookupTableProgram.programId,executable:false,lamports:1,data:encodeLookupTableAccount(x)}:null};}};
  const costCalls=[],reserves=[],logs=[];
  // The real budget validates the pinned packet (its packet check and cost reader input); the test ledger holds no funds, so a
  // validated packet reserves as 'insufficient' and an invalid one throws. The service sees 'held' to reach the signing boundary.
  const budget=createOperatingSignerBudget({registry,connection,...base,loadFundingPacket:async()=>{throw Error('unused');},loadCostIntent:async x=>{costCalls.push(x);return {costModel:'network-fee-only'};}});
  const token='synthetic-lookup-signing-token-0123456789';
  service=await createRegistrySignerService({admitRpc:async()=>{},registry,connection,...base,programVersion:3,keypair:payer,token,stateFile:join(dir,'state.json'),
   operatingBudget:{reserve:async x=>{const r=await budget.reserve(x);reserves.push(r.state);return {state:'held',binding:r.binding};},recordSignature:async()=>{}},log:e=>logs.push(e)});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  const post=body=>fetch('http://127.0.0.1:'+service.server.address().port+'/sign',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
  const table=new AddressLookupTableAccount({key:tableKey,state:{deactivationSlot:U64_MAX,lastExtendedSlot:10,lastExtendedSlotStartIndex:0,authority:payer.publicKey,addresses:entries}});
  async function prepare(n,{pin=true,tamper=l=>l,blockhash=String(key())}={}){
   const block={blockhash,lastValidBlockHeight:100,observedSlot:50},stable='settle:'+n,op=canonicalHash({genesisHash:base.genesisHash,programId:base.programId,campaign:base.campaign,operationId:stable});
   const message=new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:block.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:60000}),ix]}).compileToV0Message([table]);
   assert.equal(message.addressTableLookups.length,1);
   const lookups=tamper(pinCompiledLookups(message,{lookups:[{table:String(tableKey),addresses:entries.map(String)}]}));
   const descriptor=canonicalJson({...base,operationId:stable,operationKey:'settle',computeUnits:60000,intent:null});
   await registry.operatorPackets.prepare({operationId:op,descriptor,prepared:{base64:Buffer.from(new VersionedTransaction(message).serialize()).toString('base64'),...block,...(pin?{lookups,lookupSlot:1000}:{}),facts:{}}});
   const messageBase64=Buffer.from(message.serialize()).toString('base64'),operationId='op:'+canonicalHash({operation:op,attempt:1,message:messageBase64});
   return {message,input:{message:messageBase64,operationId,campaign:base.campaign,operationKey:'settle',fencingToken:1,packetRef:{operationId:op,attempt:1}}};
  }
  const signed=async(entry,label)=>{const r=await post(entry.input);assert.equal(r.status,200,label);const {signature}=await r.json();assert.ok(verify(null,Buffer.from(entry.message.serialize()),spki(payer.publicKey),Buffer.from(signature,'base64')),label+': signature verifies over the lookup message');return signature;};
  const refused=async(entry,status,pattern,label)=>{const before=reserves.length;const r=await post(entry.input);assert.equal(r.status,status,label);const body=await r.json();assert.equal(body.signature,undefined,label+': no signature');assert.match(body.error,pattern,label);assert.equal(reserves.length,before,label+': refused before any reservation');return body;};
  await t.test('a pinned packet is resolved, validated by the budget and signed; replay after a lost response returns the same signature',async()=>{
   const a=await prepare(1);const first=await signed(a,'first');
   assert.deepEqual(reserves,['insufficient'],'the real budget accepted the pinned packet (unfunded ledger, so no hold)');
   assert.equal(costCalls.length,1);assert.deepEqual(costCalls[0].lookups.map(l=>l.table),[String(tableKey)],'the cost reader receives the pinned resolution');
   assert.deepEqual(rpcCalls,['finalized'],'the table is proved at finalized commitment');
   const second=await signed(a,'replay');assert.equal(second,first,'the same accepted bytes give the same signature');
   assert.equal(logs.filter(e=>e.event==='signer-signed').length,2);assert.ok(logs.filter(e=>e.event==='signer-signed').every(e=>e.version===0));
  });
  await t.test('unpinned, mismatched, foreign and tampered resolutions are refused before signing',async()=>{
   await refused(await prepare(2,{pin:false}),403,/lookup resolution failed/,'no pin');
   await refused(await prepare(3,{tamper:l=>[{...l[0],addresses:[String(key()),...l[0].addresses.slice(1)]}]}),403,/lookup resolution failed/,'a pin that is not what the ledger holds');
   await refused(await prepare(4,{tamper:l=>[{...l[0],writableIndexes:[...l[0].readonlyIndexes],readonlyIndexes:[...l[0].writableIndexes]}]}),403,/lookup resolution failed/,'indexes other than the message selects');
   await refused(await prepare(5,{tamper:l=>[{...l[0],table:String(key())}]}),403,/lookup resolution failed/,'another table');
   const c=await prepare(6);await refused({...c,input:{...c.input,packetRef:undefined}},403,/lookup resolution failed/,'a lookup message without its packet reference');
   const other=await prepare(7,{blockhash:String(key())});await refused({...c,input:{...c.input,message:other.input.message}},403,/lookup resolution failed/,'a message that is not the packet it names');
   ledger.get(String(tableKey)).deactivationSlot=5n;await refused(await prepare(8),403,/lookup resolution failed/,'a deactivated table');ledger.get(String(tableKey)).deactivationSlot=U64_MAX;
   assert.ok(logs.filter(e=>e.event==='signer-refused'&&e.reason==='lookup resolution failed').length>=7);
  });
  await t.test('a ledger read failure during resolution is unresolved, not a refusal, and the same packet signs afterwards',async()=>{
   const e=await prepare(9);rpcDown=true;
   const body=await refused(e,503,/lookup resolution unresolved/,'rpc down');assert.equal(body.category,'signer-lookup-unresolved');
   assert.equal(logs.at(-1).reason,'lookup resolution unresolved');assert.equal(logs.at(-1).cause,'dependency-failure');
   rpcDown=false;await signed(e,'after the outage');
  });
 }finally{if(service?.server.listening)await service.close();if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();await rm(dir,{recursive:true,force:true});}
});
