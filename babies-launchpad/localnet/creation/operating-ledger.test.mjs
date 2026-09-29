// Real PostgreSQL concurrency with injected proof boundaries. This does NOT
// qualify RPC evidence readers or authorize creator payments to a hosted signer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {createBudgetLedger} from '../budgets.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {createOperatingLedger} from './operating-ledger.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
test('operating exposure is durable, idempotent and isolated across campaigns and payers',{skip:!url},async t=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1}),pools=[];
 try{
  await control.query(`CREATE SCHEMA ${schema}`);const make=()=>{const pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});pools.push(pool);return new PostgresRegistry({pool});};const a=make(),b=make();await a.migrate();
  const base={genesisHash:addr(1),programId:addr(2),campaign:addr(3),payer:addr(4),policy:'creator-funded-v1'},other={...base,campaign:addr(5)};
  for(const x of [base,other])await a.campaigns.upsert({...x,mode:'standard',campaignVersion:3,registryStatus:'planned'});
  let funded='1000',valid=true,outcome='unknown',actual='30';
  const verifyFunding=async x=>({...x,finalized:valid,slot:10,source:addr(6),lamports:funded}),verifyOutcome=async x=>outcome==='unknown'?{status:outcome}:{...x,status:outcome,slot:11,actualLamports:actual,signature:'3'.repeat(88)};
  const open=registry=>createOperatingLedger({registry,verifyFunding,verifyOutcome}),ledgers=[open(a),open(b)],credit={...base,signature:'2'.repeat(88)};
  const h=i=>({...base,operationId:'op-'+i,messageHash:canonicalHash({i}),maximumLamports:'100'});
  await t.test('only finalized proof credits one ledger once, including parallel replays',async()=>{
   valid=false;await assert.rejects(ledgers[0].credit(credit));valid=true;
   const results=await Promise.all(Array.from({length:20},(_,i)=>ledgers[i%2].credit(credit)));assert.equal(results.filter(x=>!x.duplicate).length,1);assert.equal((await ledgers[0].balance(base)).fundedLamports,'1000');
   await assert.rejects(ledgers[0].credit({...credit,...other}));funded='1001';await assert.rejects(ledgers[1].credit(credit));funded='1000';
   assert.equal((await ledgers[1].balance(other)).fundedLamports,'0');
  });
  await t.test('restart verifies the stored final proof and accounting entry without RPC or another credit',async()=>{
   const noRpc=createOperatingLedger({registry:a,verifyFunding:async()=>{throw Error('History pruned');},verifyOutcome});
   const input={...credit,source:addr(6),lamports:'1000'};
   assert.equal((await noRpc.credited(input)).status,'credited');assert.equal((await noRpc.balance(base)).fundedLamports,'1000');
   for(const change of [{lamports:'1001'},{source:addr(8)},{payer:addr(7)},{policy:'different'},{campaign:other.campaign}])await assert.rejects(noRpc.credited({...input,...change}));
   assert.equal(await noRpc.credited({...input,signature:'7'.repeat(88)}),null);
   const op='fund:'+canonicalHash({signature:credit.signature});const before=(await a.query('SELECT result_json FROM budget_operations WHERE operation_key=?',[op])).rows[0].result_json;
   await a.query('UPDATE budget_operations SET result_json=? WHERE operation_key=?',['{}',op]);await assert.rejects(noRpc.credited(input));await a.query('UPDATE budget_operations SET result_json=? WHERE operation_key=?',[before,op]);
  });
  await t.test('twenty parallel holds cannot consume ten funded slots twice',async()=>{
   const results=await Promise.all(Array.from({length:20},(_,i)=>ledgers[i%2].hold(h(i))));assert.equal(results.filter(x=>x.state==='held').length,10);assert.equal(results.filter(x=>x.state==='insufficient').length,10);
   assert.equal((await ledgers[0].balance(base)).availableLamports,'0');assert.equal((await ledgers[1].balance(base)).heldLamports,'1000');
   const first=results.findIndex(x=>x.state==='held');await assert.rejects(ledgers[0].hold({...h(first),messageHash:'b'.repeat(64)}));await assert.rejects(ledgers[0].hold({...h(first),maximumLamports:'99'}));
   await assert.rejects(ledgers[1].hold({...h(first),operationId:'another-name-for-same-packet'}));
   assert.equal((await ledgers[0].hold({...h(50),...other})).state,'insufficient');assert.equal((await ledgers[0].hold({...h(50),payer:addr(7)})).state,'insufficient');
   const duplicate=await Promise.all(Array.from({length:12},(_,i)=>ledgers[i%2].hold(h(first))));assert.ok(duplicate.every(x=>x.state==='held'));assert.equal((await ledgers[0].balance(base)).heldLamports,'1000');
  });
  await t.test('generic spend and return cannot consume money held by pending signatures',async()=>{
   const view=await createBudgetLedger({registry:a}).get({identity:base,payer:base.payer});assert.equal(view.availableLamports,'0');assert.equal(view.heldLamports,'1000');
   for(const action of ['spend','return'])assert.equal((await a.budgets.apply({...base,action,lamports:'1',operationKey:'attempt-'+action})).outcome,'insufficient');
  });
  await t.test('unknown outcomes retain holds across restart; finality charges only actual cost once',async()=>{
   const pending=(await a.query("SELECT operation_id,message_hash FROM operating_spend_holds WHERE state='held' ORDER BY operation_id")).rows[0],x={...h(0),operationId:pending.operation_id,messageHash:pending.message_hash};
   assert.equal((await open(make()).reconcile(x)).reason,'awaiting-finality');assert.equal((await ledgers[0].balance(base)).heldLamports,'1000');
   outcome='finalized';actual='101';await assert.rejects(ledgers[0].reconcile(x));assert.equal((await ledgers[0].balance(base)).heldLamports,'1000');
   actual='30';const results=await Promise.all(Array.from({length:12},(_,i)=>ledgers[i%2].reconcile(x)));assert.ok(results.every(r=>r.state==='settled'&&r.actualLamports==='30'));
   assert.deepEqual(await ledgers[0].balance(base),{fundedLamports:'1000',spentLamports:'30',returnedLamports:'0',heldLamports:'900',availableLamports:'70'});
  });
  await t.test('expiry releases only its exact hold with zero cost; forged proof stays held',async()=>{
   const pending=(await a.query("SELECT operation_id,message_hash FROM operating_spend_holds WHERE state='held' ORDER BY operation_id")).rows[0],x={...h(0),operationId:pending.operation_id,messageHash:pending.message_hash};
   outcome='expired';actual='1';await assert.rejects(ledgers[0].reconcile(x));actual='0';
   const forged=createOperatingLedger({registry:a,verifyFunding,verifyOutcome:async i=>({...await verifyOutcome(i),messageHash:'b'.repeat(64)})});await assert.rejects(forged.reconcile(x));
   await ledgers[0].reconcile(x);assert.equal((await ledgers[1].balance(base)).heldLamports,'800');assert.equal((await ledgers[0].balance(base)).availableLamports,'170');
  });
  await t.test('message uniqueness is enforced by PostgreSQL, including settled financial identities',async()=>{
   const settled=(await a.query("SELECT message_hash FROM operating_spend_holds WHERE state='settled' LIMIT 1")).rows[0];
   await assert.rejects(a.query("INSERT INTO operating_spend_holds(genesis_hash,program_id,campaign,payer,operation_id,message_hash,maximum_lamports,policy,state) VALUES(?,?,?,?,?,?,?,?,'held')",[base.genesisHash,base.programId,base.campaign,base.payer,'duplicate-signed-identity',settled.message_hash,'1',base.policy]),e=>e.code==='23505');
   assert.equal((await ledgers[0].balance(base)).availableLamports,'170');
  });
 }finally{await Promise.all(pools.map(p=>p.end()));await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
test('a finalized reserve return settles its hold as fee spent plus amount returned; a return above the outflow or on an expired packet is refused',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:4,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const base={genesisHash:addr(1),programId:addr(2),campaign:addr(3),payer:addr(4),policy:'creator-funded-v1'};
  await registry.campaigns.upsert({...base,mode:'standard',campaignVersion:3,registryStatus:'planned'});
  let outcome={status:'finalized',slot:11,actualLamports:'100000',returnedLamports:'95000',signature:'3'.repeat(88)};
  const ledger=createOperatingLedger({registry,verifyFunding:async x=>({...x,finalized:true,slot:10,source:addr(6),lamports:'100000'}),verifyOutcome:async x=>({...x,...outcome})});
  await ledger.credit({...base,signature:'2'.repeat(88)});
  const hold={...base,operationId:'return-1',messageHash:canonicalHash({r:1}),maximumLamports:'100000'};assert.equal((await ledger.hold(hold)).state,'held');
  outcome={...outcome,returnedLamports:'100001'};await assert.rejects(ledger.reconcile(hold),/differs/);
  outcome={...outcome,status:'expired',actualLamports:'0',returnedLamports:'1'};await assert.rejects(ledger.reconcile(hold),/differs/);
  outcome={status:'finalized',slot:11,actualLamports:'100000',returnedLamports:'95000',signature:'3'.repeat(88)};
  const settled=await ledger.reconcile(hold);assert.equal(settled.state,'settled');assert.equal(settled.actualLamports,'100000');
  const b=await ledger.balance(base);assert.equal(b.spentLamports,'5000');assert.equal(b.returnedLamports,'95000');assert.equal(b.availableLamports,'0');assert.equal(b.heldLamports,'0');
  assert.equal((await ledger.reconcile(hold)).state,'settled');assert.equal((await ledger.balance(base)).returnedLamports,'95000','settlement is idempotent');
  const ops=(await registry.query('SELECT operation_key,result_json FROM budget_operations WHERE campaign=? ORDER BY operation_key',[base.campaign])).rows.map(r=>[r.operation_key.split(':')[0],JSON.parse(r.result_json).outcome]);
  assert.deepEqual(ops.sort(),[['cost','spent'],['fund','reserved'],['return','returned']]);
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
