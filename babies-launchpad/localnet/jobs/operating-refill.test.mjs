// Refill accounting: entitlements only from finalized fee-state growth, capped by the floor; credits only from a
// finalized treasury transfer that matches the prepared funding exactly. PostgreSQL for the shared tables.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {Keypair,PublicKey,TransactionMessage,TransactionInstruction,SystemProgram,VersionedTransaction} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {FEE_STATE_MAGIC,FEE_STATE_LEN,feeStateAddress} from '../protocol-v2/client.mjs';
import {refillEntitlement,refillMemo,operatingRefillHandler,prepareRefillFunding,creditRefillFunding,voidRefillFunding,verifyRefillTransaction} from './operating-refill.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
test('entitlement rule: share of the payout growth, capped by the room under the floor, never negative, never backwards',()=>{
 const base={refillBps:1000,floorLamports:20000000n};
 assert.equal(refillEntitlement({...base,treasuryPaidNow:50000000n,treasuryPaidAccounted:0n,availableLamports:10000000n,dueLamports:0n}).addLamports,5000000n);
 assert.equal(refillEntitlement({...base,treasuryPaidNow:150000000n,treasuryPaidAccounted:50000000n,availableLamports:10000000n,dueLamports:5000000n}).addLamports,5000000n,'room caps the share');
 assert.equal(refillEntitlement({...base,treasuryPaidNow:150000000n,treasuryPaidAccounted:150000000n,availableLamports:10000000n,dueLamports:10000000n}).addLamports,0n,'no growth, no entitlement');
 assert.equal(refillEntitlement({...base,treasuryPaidNow:900000000n,treasuryPaidAccounted:0n,availableLamports:25000000n,dueLamports:0n}).addLamports,0n,'above the floor nothing is due');
 assert.throws(()=>refillEntitlement({...base,treasuryPaidNow:1n,treasuryPaidAccounted:2n,availableLamports:0n,dueLamports:0n}),e=>e.code==='REFILL_EVIDENCE_MISMATCH');
 assert.throws(()=>refillEntitlement({...base,refillBps:10001,treasuryPaidNow:1n,treasuryPaidAccounted:0n,availableLamports:0n,dueLamports:0n}));
 const memo=refillMemo({genesisHash:addr(1),programId:addr(2),payer:addr(3),policy:'p',treasury:addr(4),nonce:'n',entitlements:[{campaign:addr(6),lamports:'2'},{campaign:addr(5),lamports:1n}]});
 assert.equal(memo,refillMemo({genesisHash:addr(1),programId:addr(2),payer:addr(3),policy:'p',treasury:addr(4),nonce:'n',entitlements:[{campaign:addr(5),lamports:'1'},{campaign:addr(6),lamports:'2'}]}),'memo is order independent');
 assert.notEqual(memo,refillMemo({genesisHash:addr(1),programId:addr(2),payer:addr(3),policy:'p',treasury:addr(4),nonce:'m',entitlements:[{campaign:addr(5),lamports:'1'},{campaign:addr(6),lamports:'2'}]}),'a fresh nonce makes a fresh funding');
});
test('refill accounting job and treasury funding: entitlements accrue per campaign, one prepared funding, credited once from the exact finalized transfer',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:5,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const genesisHash=addr(1),programId=addr(2),campaign=addr(4),other=addr(5),payer=addr(3),policy='creator-funded-v1',treasury=Keypair.generate();
  for(const c of [campaign,other])await registry.campaigns.upsert({genesisHash,programId,campaign:c,network:'localnet',mode:'standard',campaignVersion:3,registryStatus:'planned'});
  await registry.budgets.put({genesisHash,programId,campaign,payer,policy,reservedLamports:'100000000',spentLamports:'90000000',returnedLamports:'0'});
  const fees=new Map();const feeState=(c,treasuryPaid)=>{const d=Buffer.alloc(FEE_STATE_LEN);FEE_STATE_MAGIC.copy(d);new PublicKey(c).toBuffer().copy(d,8);d.writeBigUInt64LE(treasuryPaid,40+16);return {data:d};};
  const connection={getAccountInfo:async address=>fees.get(String(address))??null,getTransaction:async()=>null};
  const handler=operatingRefillHandler({registry,connection,genesisHash,programId,payer,policy,refillBps:1000,floorLamports:'20000000',intervalMs:60000});
  const queued=[],ctx=key=>({campaign:{genesisHash,programId,campaign},jobId:'job-'+key,token:1,now:()=>1000,enqueue:async job=>{queued.push(job);}});
  const binding=c=>({genesisHash,programId,campaign:c.campaign,payer,policy});
  const run=(key,c={genesisHash,programId,campaign},payload=null)=>handler.run({jobClass:'operating-refill',operationKey:'operating-refill:'+key,payload:payload??{binding:binding(c)}},{...ctx(key),campaign:c});
  assert.equal((await run(0)).category,'awaiting-fee-state');
  fees.set(String(feeStateAddress(programId,campaign)),feeState(campaign,50000000n));
  let r=await run(0);assert.equal(r.category,'refill-accounted');assert.equal(r.addedLamports,'5000000');assert.equal(r.dueLamports,'5000000');assert.equal(r.next,'operating-refill:1');assert.equal(queued.at(-1).operationKey,'operating-refill:1');assert.equal(queued.at(-1).notBefore,new Date(61000).toISOString());
  fees.set(String(feeStateAddress(programId,campaign)),feeState(campaign,150000000n));
  r=await run(1);assert.equal(r.addedLamports,'5000000');assert.equal(r.dueLamports,'10000000');
  r=await run(2);assert.equal(r.addedLamports,'0');assert.equal(r.dueLamports,'10000000');
  fees.set(String(feeStateAddress(programId,campaign)),feeState(campaign,100000000n));
  r=await run(3);assert.equal(r.outcome,'failed-permanent');assert.equal(r.category,'refill-evidence-mismatch');
  fees.set(String(feeStateAddress(programId,campaign)),feeState(campaign,150000000n));
  assert.equal((await run(3)).outcome,'done');
  assert.equal((await handler.run({jobClass:'operating-refill',operationKey:'nope'},ctx(9))).category,'refill-scope');
  // The job must carry the lane's binding: no payload, another payer, another policy or another campaign are refused, not accounted.
  for(const bad of [{},{binding:{...binding({campaign}),payer:addr(9)}},{binding:{...binding({campaign}),policy:'other-policy'}},{binding:{...binding({campaign}),campaign:other}}]){const r=await run(4,{genesisHash,programId,campaign},bad);assert.equal(r.outcome,'failed-permanent');assert.equal(r.category,'refill-scope');}
  assert.deepEqual(queued.at(-1).payload.binding,binding({campaign}),'the successor carries the same binding');assert.equal(queued.at(-1).payload.predecessorJobId,'job-3');
  // Funding: the treasury's owner pays all due entitlements of the payer in one transfer.
  const scope={registry,genesisHash,programId,payer,policy,treasury:treasury.publicKey.toBase58()};
  await assert.rejects(prepareRefillFunding({...scope,treasury:payer}),/distinct from the payer/);
  const funding=await prepareRefillFunding(scope);assert.equal(funding.state,'prepared');assert.deepEqual(funding.entitlements,[{campaign,lamports:'10000000'}]);assert.equal(funding.totalLamports,'10000000');assert.match(funding.memo,/^KIDS refill:[a-f0-9]{64}$/);
  assert.equal((await prepareRefillFunding(scope)).fundingId,funding.fundingId,'one open funding at a time');
  const row=(await registry.query('SELECT pending_funding_id,due_lamports FROM operating_refills WHERE campaign=?',[campaign])).rows[0];assert.equal(row.pending_funding_id,funding.fundingId);assert.equal(row.due_lamports,'10000000');
  const build=(lamports,memo)=>{const tx=new VersionedTransaction(new TransactionMessage({payerKey:treasury.publicKey,recentBlockhash:addr(7),instructions:[SystemProgram.transfer({fromPubkey:treasury.publicKey,toPubkey:new PublicKey(payer),lamports}),new TransactionInstruction({programId:new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),keys:[],data:Buffer.from(memo)})]}).compileToV0Message());tx.sign([treasury]);return tx;};
  const reply=(tx,lamports,err=null)=>{const keys=tx.message.staticAccountKeys.map(String),pre=keys.map(()=>0),post=keys.map(()=>0);pre[0]=1000000000;post[0]=1000000000-lamports-5000;const p=keys.indexOf(payer);pre[p]=1;post[p]=1+lamports;return {slot:77,transaction:{message:tx.message,signatures:['sig']},meta:{err,fee:5000,preBalances:pre,postBalances:post}};};
  const good=build(10000000,funding.memo),signature='4'.repeat(88);
  connection.getTransaction=async()=>reply(build(9999999,funding.memo),9999999);
  await assert.rejects(creditRefillFunding({registry,connection,fundingId:funding.fundingId,signature}),/does not match/);
  connection.getTransaction=async()=>reply(build(10000000,'KIDS refill:'+'0'.repeat(64)),10000000);
  await assert.rejects(creditRefillFunding({registry,connection,fundingId:funding.fundingId,signature}),/memo/);
  connection.getTransaction=async()=>reply(good,10000000,{InstructionError:[0,'Custom']});
  await assert.rejects(creditRefillFunding({registry,connection,fundingId:funding.fundingId,signature}),/failed on chain/);
  connection.getTransaction=async()=>reply(good,10000000);
  assert.deepEqual(await verifyRefillTransaction(connection,funding,signature),{signature,slot:77});
  const credited=await creditRefillFunding({registry,connection,fundingId:funding.fundingId,signature});assert.equal(credited.state,'credited');assert.equal(credited.duplicate,false);assert.equal(credited.slot,77);
  const budget=await registry.budgets.get({genesisHash,programId,campaign,payer});assert.equal(budget.reservedLamports,'110000000');
  const after=(await registry.query('SELECT pending_funding_id,due_lamports,funded_lamports FROM operating_refills WHERE campaign=?',[campaign])).rows[0];assert.equal(after.pending_funding_id,null);assert.equal(after.due_lamports,'0');assert.equal(after.funded_lamports,'10000000');
  assert.equal((await creditRefillFunding({registry,connection,fundingId:funding.fundingId,signature})).duplicate,true);assert.equal((await registry.budgets.get({genesisHash,programId,campaign,payer})).reservedLamports,'110000000','a second credit changes nothing');
  await assert.rejects(creditRefillFunding({registry,connection,fundingId:funding.fundingId,signature:'5'.repeat(88)}),/another signature/);
  assert.equal(await prepareRefillFunding(scope),null,'nothing due after the credit');
  // Later growth accrues again; a prepared funding that will not be paid is voided and its entitlements become due again.
  fees.set(String(feeStateAddress(programId,campaign)),feeState(campaign,250000000n));await registry.budgets.put({genesisHash,programId,campaign,payer,policy,reservedLamports:'110000000',spentLamports:'100000000',returnedLamports:'0'});
  r=await run(4);assert.equal(r.addedLamports,'10000000');
  const second=await prepareRefillFunding(scope);assert.equal(second.totalLamports,'10000000');assert.notEqual(second.fundingId,funding.fundingId);
  const voided=await voidRefillFunding({registry,fundingId:second.fundingId});assert.equal(voided.state,'void');
  assert.equal((await registry.query('SELECT pending_funding_id FROM operating_refills WHERE campaign=?',[campaign])).rows[0].pending_funding_id,null);
  assert.equal((await prepareRefillFunding(scope)).totalLamports,'10000000','voided entitlements are due again');
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
