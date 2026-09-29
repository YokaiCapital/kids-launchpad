// The reserve return waits for every precondition instead of failing (refunded stage, chain refunds complete, no open
// holds, an operating-return grant naming the sealed creator), then sends exactly one bounded transfer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PublicKey,TransactionMessage} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {createOperatingLedger} from '../creation/operating-ledger.mjs';
import {operatingReturnMemo} from '../creation/operating-costs.mjs';
import {operatingReturnHandler} from './operating-return.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,address=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
test('operating return: waits for refunded stage, chain refunds, settled holds and the grant, then returns available minus the fee once',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:5,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const id={genesisHash:address(1),programId:address(2),campaign:address(4)},payer=address(3),creator=address(9),policy='creator-funded-v1';
  await registry.campaigns.upsert({...id,network:'localnet',mode:'standard',campaignVersion:3,registryStatus:'planned',creator,termsHash:'a'.repeat(64)});
  await registry.budgets.put({...id,payer,policy,reservedLamports:'100000000',spentLamports:'40000',returnedLamports:'0'});
  const c={phase:2,deadline:200n,launchDeadline:300n,total:2000000000n,soft:500000000n,hard:1000000000n,refunded:1999999000n,terms:{creator:new PublicKey(creator)}};const sent=[];let clock=400n;
  const chain={keeper:new PublicKey(payer),readCampaign:async()=>({...c}),chainTime:async()=>clock,signatureStatus:async()=>({status:'confirmed'}),
   send:async(build,options)=>{const built=await build();sent.push({built,options});return {status:'confirmed',signature:'sig-'+sent.length};}};
  const handler=operatingReturnHandler({chain,registry,policy}),job={jobClass:'operating-return',operationKey:'operating-return'},ctx={campaign:id,token:1,owner:'test',signal:null,holds:async()=>true,fenced:async(_n,fn)=>fn()};
  const run=()=>handler.run(job,ctx);
  assert.equal((await run()).category,'awaiting-refunded-stage');
  await registry.query("INSERT INTO standard_lifecycles(genesis_hash,program_id,campaign,descriptor_hash,initial_capability_id,terms_hash,stage,updated_at) VALUES(?,?,?,?,?,?,'refunded',?)",[id.genesisHash,id.programId,id.campaign,'d'.repeat(64),'cap','a'.repeat(64),new Date().toISOString()]);
  assert.equal((await run()).category,'awaiting-full-refunds');c.refunded=c.total;
  // Deadline-aware: with the clock before the funding deadline nothing is terminal, not even a round with nothing committed.
  clock=150n;assert.equal((await run()).category,'awaiting-full-refunds');Object.assign(c,{phase:0,total:0n,refunded:0n});assert.equal((await run()).category,'awaiting-full-refunds');Object.assign(c,{phase:2,total:2000000000n,refunded:2000000000n});clock=400n;
  const holder=createOperatingLedger({registry,verifyFunding:async()=>{throw Error('never');},verifyOutcome:async()=>({status:'unknown'})});
  const hold={...id,payer,policy,operationId:'op-1',messageHash:'b'.repeat(64),maximumLamports:'10000'};assert.equal((await holder.hold(hold)).state,'held');
  assert.equal((await run()).category,'awaiting-operating-holds');
  await registry.query("UPDATE operating_spend_holds SET state='settled',actual_lamports='0' WHERE operation_id=?",['op-1']);
  assert.equal((await run()).category,'awaiting-return-capability');
  await registry.capabilities.grant({...id,programVersion:3,kind:'keeper',tags:[3],expiresAt:new Date(Date.now()+3600000).toISOString()});
  assert.equal((await run()).category,'awaiting-return-capability','a keeper grant is not a return grant');
  await registry.capabilities.grant({...id,programVersion:3,kind:'operating-return',tags:[],recipients:[address(8)],expiresAt:new Date(Date.now()+3600000).toISOString()});
  assert.equal((await run()).category,'awaiting-return-capability','the grant must name the sealed creator');
  await registry.capabilities.grant({...id,programVersion:3,kind:'operating-return',tags:[],recipients:[creator],expiresAt:new Date(Date.now()+3600000).toISOString()});
  const done=await run();assert.equal(done.outcome,'done');assert.equal(done.category,'operating-returned');assert.equal(done.returnedLamports,'99955000');assert.equal(done.creator,creator);assert.equal(done.signature,'sig-1');
  assert.equal(sent.length,1);const {built,options}=sent[0];assert.equal(options.campaign,id.campaign);assert.equal(options.operationKey,'operating-return');assert.equal(options.fencingToken,1);assert.equal(options.computeUnits,60000);assert.equal(options.operationId,'operating-return:'+id.campaign+':99955000:cu60000');assert.deepEqual(options.intent,{action:'operating-return',creator,lamports:'99955000'});
  assert.equal(built.instructions.length,2);assert.equal(String(built.instructions[0].keys[0].pubkey),payer);assert.equal(String(built.instructions[0].keys[1].pubkey),creator);assert.equal(Buffer.from(built.instructions[0].data).readBigUInt64LE(4),99955000n);
  assert.equal(built.instructions[1].data.toString(),operatingReturnMemo({...id,payer,creator,lamports:'99955000'}));
  const message=new TransactionMessage({payerKey:new PublicKey(payer),recentBlockhash:address(5),instructions:built.instructions}).compileToV0Message();assert.ok(message.serialize().length<400);
  // Once the accounting lane records the return, nothing is left and a rerun does not send again.
  await registry.budgets.put({...id,payer,policy,reservedLamports:'100000000',spentLamports:'45000',returnedLamports:'99955000'});
  const again=await run();assert.equal(again.category,'nothing-to-return');assert.equal(sent.length,1);
  chain.send=async()=>({status:'unknown',signature:'sig-x',blockhash:'h',lastValidBlockHeight:10});
  await registry.budgets.put({...id,payer,policy,reservedLamports:'100000000',spentLamports:'40000',returnedLamports:'0'});
  const unknown=await run();assert.equal(unknown.outcome,'unknown');assert.equal(unknown.reconcile.kind,'operating-return');assert.equal(unknown.reconcile.signature,'sig-x');
  assert.equal((await handler.reconcile({result:{reconcile:unknown.reconcile}})).status,'confirmed');
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
