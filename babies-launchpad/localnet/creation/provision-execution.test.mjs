import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {Keypair} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {provisionFixture,provisionAccounts} from '../test/helpers/provision-fixture.mjs';
import {buildProvisionPacket} from './provision-packet.mjs';
import {verifyProvisionResult,verifyNativeCustody} from './provision-result.mjs';
import {createProvisionExecutor} from './provision-execution.mjs';
const address=()=>Keypair.generate().publicKey.toBase58();
test('setup evidence rejects changed terms, custody, authority and insufficient rent/funding',()=>{
 const {intent}=provisionFixture(),response=provisionAccounts(intent),verify=r=>verifyProvisionResult(intent,r,{minSlot:100,campaignRentLamports:'8000000'});
 assert.equal(verify(response).campaign,intent.mint.campaign);
 for(const mutate of [r=>r.value[0].data[50]^=1,r=>r.value[0].data[840]=3,r=>r.value[0].data[842]=1,r=>r.value[0].lamports=1,r=>r.value[1].lamports=1,r=>r.value[1].data=Buffer.alloc(1),r=>r.value[1].owner=r.value[0].owner,r=>r.value[2].data.writeUInt32LE(0,109),r=>r.value[2].data.writeUInt32LE(1,72),r=>r.value[2].data.writeUInt32LE(1,129),r=>r.value[3].data.writeUInt32LE(1,0),r=>r.value[4].data.writeBigUInt64LE(1n,64)]){
  const r={context:{...response.context},value:response.value.map(a=>({...a,data:Buffer.from(a.data)}))};mutate(r);assert.throws(()=>verify(r));
 }
 const committed=provisionAccounts(intent);committed.value[0].data.writeBigUInt64LE(500000000n,848);committed.value[0].data.writeBigUInt64LE(1n,864);committed.value[0].lamports+=500000000;assert.equal(verify(committed).campaign,intent.mint.campaign);
 assert.throws(()=>verify({...response,context:{slot:99}}),{code:'PROVISION_RESULT_UNAVAILABLE'});
 const donated=provisionAccounts(intent).value[2];donated.data.writeBigUInt64LE(123n,64);assert.equal(verifyNativeCustody(intent.mint,donated).amount,'123');
});
const url=process.env.KIDS_TEST_POSTGRES_URL;
test('durable creator setup preserves signed bytes and reconciles both stages across replicas',{skip:!url},async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  function fixture(stage='create-campaign'){
   const {creator,intent,block}=provisionFixture(),response=provisionAccounts(intent);intent.mint.requestId=randomUUID();
   let genesis=intent.mint.genesisHash,status=null,height=100,failSend=false,failRead=false,waitRead=false,clock=2000000000n,nativeMissing=false,campaignExists=false;const sends=[];
   const tx=buildProvisionPacket(intent,stage,block);tx.sign([creator]);const creatorPacket=Buffer.from(tx.serialize()).toString('base64');
   const connection={rpcEndpoint:'http://127.0.0.1:19199',getGenesisHash:async()=>genesis,isBlockhashValid:async()=>({value:true}),getFirstAvailableBlock:async()=>1,getSignatureStatuses:async()=>{if(failRead)throw Error('provider private detail');if(waitRead)return new Promise(()=>{});return {context:{slot:110},value:[status]};},getEpochInfo:async()=>({blockHeight:height,absoluteSlot:110}),getMinimumBalanceForRentExemption:async()=>8000000,
    sendRawTransaction:async bytes=>{sends.push(Buffer.from(bytes).toString('base64'));if(failSend)throw Error('lost provider response');return (await open().record(intent.mint.requestId,{stage,block,creatorPacket})).signature;},
    getMultipleAccountsInfoAndContext:async(keys,options)=>{
     if(options.minContextSlot!==undefined)return keys.length===1?{context:response.context,value:[response.value[2]]}:response;
     const c=Buffer.alloc(40);c.writeBigInt64LE(clock,32);return {context:response.context,value:[...response.value.slice(3),{data:c},...(stage==='create-campaign'?[nativeMissing?null:response.value[2],campaignExists?response.value[0]:null]:[])]};
    }};
   const config={mode:'localnet-rehearsal',programVersion:3,rpcUrl:connection.rpcEndpoint,genesisHash:intent.mint.genesisHash,programId:intent.mint.programId,pilotCreator:intent.mint.creator,treasury:intent.treasury};
   const open=extra=>createProvisionExecutor({registry,connection,config,loadIntent:async()=>intent,...extra}),record=()=>open().record(intent.mint.requestId,{stage,block,creatorPacket}),resume=extra=>open(extra).resume(intent.mint.requestId,stage);
   return {intent,block,creatorPacket,response,stage,open,record,resume,sends,connection,set status(v){status=v;},set height(v){height=v;},set genesis(v){genesis=v;},set failSend(v){failSend=v;},set failRead(v){failRead=v;},set waitRead(v){waitRead=v;},set clock(v){clock=v;},set nativeMissing(v){nativeMissing=v;},set campaignExists(v){campaignExists=v;}};
  }
  await t.test('both stages survive lost response and concurrent finalization without replacement',async()=>{
   for(const stage of ['native-custody','create-campaign']){
    const f=fixture(stage),approvals=await Promise.all(Array.from({length:8},()=>f.record()));assert.equal(new Set(approvals.map(r=>r.signature)).size,1);
    f.failSend=true;assert.equal((await f.resume()).reason,'submission-unresolved');assert.deepEqual(f.sends,[f.creatorPacket]);
    f.status={confirmationStatus:'confirmed',slot:100,err:null};assert.equal((await f.resume()).reason,'awaiting-finality');assert.equal(f.sends.length,1);
    f.status={confirmationStatus:'finalized',slot:100,err:null};const results=await Promise.all(Array.from({length:8},()=>f.resume()));assert.ok(results.every(r=>r.status==='complete'));assert.equal(f.sends.length,1);
    f.failRead=true;assert.equal((await f.resume()).status,'complete');assert.equal((await f.record()).status,'finalized');
   }
  });
  await t.test('preflight rejects missing custody, changed ledger, existing campaign and stale opening',async()=>{
   const f=fixture();f.nativeMissing=true;await assert.rejects(f.record());f.nativeMissing=false;f.campaignExists=true;await assert.rejects(f.record(),/already exists/);f.campaignExists=false;f.clock=2000000031n;await assert.rejects(f.record(),/Opening time/);f.clock=2000000000n;f.genesis=address();await assert.rejects(f.record(),/ledger/);assert.equal(f.sends.length,0);
  });
  await t.test('no replacement after expiry/failure; provider timeouts and mismatches are explicit',async()=>{
   for(const terminal of ['expired','failed']){const f=fixture();await f.record();if(terminal==='expired')f.height=151;else f.status={confirmationStatus:'finalized',slot:100,err:{InstructionError:[0,'Custom']}};assert.equal((await f.resume()).reason,terminal);assert.equal(f.sends.length,0);assert.equal((await f.resume()).status,'attention');}
   const f=fixture();await f.record();f.waitRead=true;assert.equal((await f.resume({timeoutMs:15})).reason,'confirmation-unavailable');f.waitRead=false;f.status={confirmationStatus:'finalized',slot:100,err:null};f.response.value[1].lamports=0;assert.equal((await f.resume()).reason,'account-mismatch');assert.equal(f.sends.length,0);
  });
  await t.test('crashes after broadcast or final journal write resume the same operation',async()=>{
   const f=fixture();await f.record();await assert.rejects(f.resume({checkpoint:async()=>{throw Error('synthetic interruption');}}),/interruption/);assert.equal(f.sends.length,1);
   f.status={confirmationStatus:'finalized',slot:100,err:null};await assert.rejects(f.resume({checkpoint:async()=>{throw Error('synthetic interruption');}}),/interruption/);assert.equal((await f.resume()).status,'complete');assert.equal(f.sends.length,1);
  });
  await t.test('a different signed packet cannot supersede the approved transfer',async()=>{
   const f=fixture();await f.record();await assert.rejects(f.open().record(f.intent.mint.requestId,{stage:f.stage,block:{...f.block,blockhash:address()},creatorPacket:f.creatorPacket}));f.intent.authorityBudgetLamports='400000000';await assert.rejects(f.resume(),{code:'IDEMPOTENCY_CONFLICT'});assert.equal(f.sends.length,0);
  });
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
