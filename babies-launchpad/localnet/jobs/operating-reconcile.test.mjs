import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOperatingReconciler} from './operating-reconcile.mjs';
import pg from 'pg';
import {PublicKey} from '@solana/web3.js';
import {encodeBase58} from '../../shared/solana.mjs';
import {PostgresRegistry} from '../registry/registry.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {createOperatingLedger} from '../creation/operating-ledger.mjs';
import {createJobRunner} from './runner.mjs';
import {operatingReconcileHandler} from './operating-reconcile.mjs';
const addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58(),url=process.env.KIDS_TEST_POSTGRES_URL;
const base={genesisHash:addr(1),programId:addr(2),payer:addr(3),policy:'test-funded-v3'};
const binding={...base,campaign:addr(4),operationId:'op:1',messageHash:'a'.repeat(64),maximumLamports:'100'};
const job=x=>({jobClass:'operating-reconcile',operationKey:'operating-reconcile:'+canonicalHash(x),payload:{binding:x}});
const ctx=x=>({campaign:x,fenced:async(_label,fn)=>fn()});
test('operating worker retains uncertain holds, backs off without exhaustion and sanitizes errors',async()=>{
 let state='held',calls=0;const handler=operatingReconcileHandler({...base,reconciler:{async reconcile(){calls++;if(state==='error')throw Error('secret-bearing provider URL');return {state,actualLamports:'20'};}}});
 let j=job(binding),result;
 for(let i=0;i<12;i++){result=await handler.run(j,ctx(binding));assert.equal(result.outcome,'yield');assert.ok(result.delayMs>=5000&&result.delayMs<=300000);j={...j,result};}
 state='error';result=await handler.run(j,ctx(binding));assert.equal(result.category,'operating-evidence-unavailable');assert.ok(!JSON.stringify(result).includes('secret'));
 state='settled';assert.equal((await handler.run(j,ctx(binding))).actualLamports,'20');
 const before=calls;assert.equal((await handler.run(job({...binding,payer:addr(5)}),ctx(binding))).category,'operating-scope');assert.equal(calls,before);
});
test('automatic hold jobs are atomic, independently leased and fair across 100 campaigns',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);let clock=Date.now();pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool,now:()=>clock});await registry.migrate();
  const schedule=x=>registry.jobs.enqueue({...x,...job(x)});
  let observed=0;const ledger=createOperatingLedger({registry,verifyFunding:async x=>({...x,finalized:true,slot:1,source:addr(6),lamports:'100'}),verifyOutcome:async x=>{observed++;return x.operationId==='pending'?{status:'unknown'}:{...x,status:'finalized',slot:2,actualLamports:'20',signature:'3'.repeat(88)};},onHeld:schedule});
  const inputs=[];
  for(let i=0;i<100;i++){
   const x={...base,campaign:addr(i+20),operationId:i%10===0?'pending':'ready',messageHash:canonicalHash({i}),maximumLamports:'50'};inputs.push(x);
   await registry.campaigns.upsert({...x,mode:'standard',campaignVersion:3,registryStatus:'planned'});
   const signature=Buffer.alloc(64,1);signature.writeUInt32LE(i,60);await ledger.credit({...x,signature:encodeBase58(signature)});
   await ledger.hold(x);await ledger.hold(x);
  }
  assert.equal(Number((await registry.query("SELECT COUNT(*) n FROM jobs WHERE job_class='operating-reconcile'")).rows[0].n),100);
  const first=inputs[0],other={...first,operationId:'other-payer',messageHash:canonicalHash('other'),payer:addr(7)};
  await registry.jobs.enqueue({...other,...job(other)});await registry.jobs.enqueue({...first,jobClass:'launch',operationKey:'launch'});await registry.jobs.enqueue({...first,jobClass:'fee-harvest',operationKey:'fee-harvest:0'});
  const handler=operatingReconcileHandler({...base,reconciler:{reconcile:ledger.reconcile}}),scope={genesisHash:base.genesisHash,programId:base.programId,campaignVersion:3,operatingPayer:base.payer,operatingPolicy:base.policy};
  const make=owner=>createJobRunner({registry,handlers:{'operating-reconcile':handler},owner,concurrency:4,lane:'accounting',scope,now:()=>clock});
  const a=make('accounting-a'),b=make('accounting-b');
  for(let i=0;i<15;i++)await Promise.all([a.tick(),b.tick()]);assert.equal(observed,100);
  assert.equal(Number((await registry.query("SELECT COUNT(*) n FROM jobs WHERE job_class='operating-reconcile' AND state='done'")).rows[0].n),90);
  assert.equal(Number((await registry.query("SELECT COUNT(*) n FROM operating_spend_holds WHERE state='held'")).rows[0].n),10);
  assert.equal(Number((await registry.query("SELECT COUNT(*) n FROM jobs WHERE job_class IN ('launch','fee-harvest') AND state='queued'")).rows[0].n),2);
  const foreign=(await registry.jobs.listForCampaign(first)).find(j=>j.operationKey===job(other).operationKey);assert.equal(foreign.state,'queued');
  clock+=6000;await registry.query("UPDATE jobs SET not_before=NULL WHERE job_class='operating-reconcile' AND state='queued'");const restarted=make('accounting-restarted');for(let i=0;i<3;i++)await restarted.tick();assert.equal(observed,110);
  assert.equal((await ledger.balance(first)).heldLamports,'50');
  // The hold and its wake-up are one DB transaction. A scheduler failure cannot
  // reserve funds while leaving them permanently undiscoverable by the worker.
  const faulty=createOperatingLedger({registry,verifyFunding:async()=>{},verifyOutcome:async()=>{},onHeld:async x=>{await schedule(x);throw Error('scheduler failure');}});
  const extra={...first,operationId:'roll-back',messageHash:canonicalHash('rollback'),maximumLamports:'1'};
  await assert.rejects(faulty.hold(extra),/scheduler failure/);assert.equal((await ledger.balance(first)).heldLamports,'50');
  assert.equal((await registry.jobs.listForCampaign(first)).some(j=>j.operationKey===job(extra).operationKey),false);
  a.stop();b.stop();restarted.stop();await Promise.all([a.drain(),b.drain(),restarted.drain()]);
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
