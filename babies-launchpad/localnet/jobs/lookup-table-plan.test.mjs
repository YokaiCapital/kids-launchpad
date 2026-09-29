import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {Keypair,PublicKey,AddressLookupTableProgram,SYSVAR_SLOT_HASHES_PUBKEY} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {canonicalJson} from '../registry/canonical.mjs';
import {allocateLookupTablePlan,markLookupTablePlan,readLookupTablePlan,recentSlots,tablePacketOperation} from './lookup-table-plan.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,key=()=>Keypair.generate().publicKey.toBase58();
/** The SlotHashes sysvar as the runtime lays it out: u64 count, then (u64 slot, 32-byte hash) newest first. */
function slotHashes(slots){const d=Buffer.alloc(8+40*slots.length);d.writeBigUInt64LE(BigInt(slots.length),0);slots.forEach((s,i)=>{d.writeBigUInt64LE(BigInt(s),8+40*i);});return d;}
test('SlotHashes parsing: newest first, malformed refused',async()=>{
 const c=data=>({getAccountInfo:async k=>String(k)===String(SYSVAR_SLOT_HASHES_PUBKEY)?{data}:null});
 assert.deepEqual(await recentSlots(c(slotHashes([1000,998,997]))),[1000,998,997]);
 await assert.rejects(recentSlots(c(Buffer.alloc(4))),/malformed/);await assert.rejects(recentSlots(c(slotHashes([1]).subarray(0,20))),/malformed/);await assert.rejects(recentSlots({getAccountInfo:async()=>null}),/unavailable/);
});
test('lookup table plans: creation slots come from SlotHashes, one per campaign, reused while the slot is in SlotHashes, replaced only when it left SlotHashes with no live attempt and no account, marked atomically',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:6,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const payer=key(),base={genesisHash:key(),programId:key()},a={...base,campaign:key()},b={...base,campaign:key()},c={...base,campaign:key()},d={...base,campaign:key()};
  let finalized=1000,known=[1000,998,997,996,995];const ledger=new Set();
  const connection={getSlot:async()=>finalized,getAccountInfo:async k=>String(k)===String(SYSVAR_SLOT_HASHES_PUBKEY)?{data:slotHashes(known)}:ledger.has(String(k))?{owner:AddressLookupTableProgram.programId,data:Buffer.alloc(56)}:null};
  const alloc=identity=>allocateLookupTablePlan({registry,connection,identity,payer});
  const pa=await alloc(a);assert.equal(pa.recentSlot,1000);assert.equal(pa.status,'planned');
  assert.equal(pa.table,AddressLookupTableProgram.createLookupTable({authority:new PublicKey(payer),payer:new PublicKey(payer),recentSlot:1000})[1].toBase58());
  const pb=await alloc(b);assert.equal(pb.recentSlot,998,'999 is not in SlotHashes (skipped), so the next known slot is taken');
  assert.deepEqual(await alloc(a),pa,'a retry reuses the plan');
  const [pc,pd]=await Promise.all([alloc(c),alloc(d)]);assert.deepEqual([pc.recentSlot,pd.recentSlot].sort(),[996,997],'concurrent allocations never collide');
  await assert.rejects(allocateLookupTablePlan({registry,connection,identity:a,payer:key()}),/another payer/);
  known=[1000];await assert.rejects(alloc({...base,campaign:key()}),{code:'LOOKUP_TABLE_SLOT_BUSY'},'no unused known slot');known=[1000,998,997,996,995];
  // Atomic monotonic marks bound to the plan's table and slot.
  assert.equal((await markLookupTablePlan({registry,identity:a,plan:pa,status:'created'})).status,'created');
  assert.equal((await markLookupTablePlan({registry,identity:a,plan:pa,status:'complete'})).status,'complete');
  assert.equal((await markLookupTablePlan({registry,identity:a,plan:pa,status:'created'})).status,'complete','a delayed lower result never regresses');
  assert.equal((await markLookupTablePlan({registry,identity:b,plan:{...pb,recentSlot:pb.recentSlot+1},status:'created'})).status,'planned','a mark for another slot touches nothing');
  assert.equal((await markLookupTablePlan({registry,identity:b,plan:{...pb,table:key()},status:'created'})).status,'planned','a mark for another table touches nothing');
  await assert.rejects(markLookupTablePlan({registry,identity:b,plan:null,status:'created'}),/plan/);
  // Stale plans: SlotHashes no longer lists the old creation slots (membership, never numeric age: skipped slots stretch the window).
  finalized=1900;known=[finalized,finalized-1,finalized-2];
  assert.equal((await alloc(a)).recentSlot,1000,'a completed plan is permanent however old');
  known=[finalized,finalized-1,finalized-2,pb.recentSlot];assert.deepEqual(await alloc(b),pb,'a never-created plan whose slot is still in SlotHashes is kept, whatever its numeric age');known=[finalized,finalized-1,finalized-2];
  const rb=await alloc(b);assert.equal(rb.recentSlot,finalized,'a stale plan whose table was never created and has no journaled attempt is replaced');
  assert.equal((await readLookupTablePlan({registry,identity:b})).table,rb.table);
  ledger.add(pc.table);const rc=await alloc(c);assert.equal(rc.recentSlot,pc.recentSlot,'a stale plan whose table exists on the ledger is kept');assert.equal(rc.status,'created');
  // A stale plan with an unresolved journaled creation attempt (signed, fate unknown) is kept until the worker reconciles it.
  const op=tablePacketOperation(d,pd.table,1);
  await registry.operatorPackets.prepare({operationId:op,descriptor:canonicalJson({...d,operationId:'launch-table:'+pd.table+':1'}),prepared:{base64:'AA==',blockhash:key(),lastValidBlockHeight:10}});
  await registry.operatorPackets.sign({operationId:op,attempt:1,signedBase64:'AA==',signature:'1'.repeat(64)});
  assert.deepEqual(await alloc(d),pd,'signed attempt: kept');
  await registry.operatorPackets.progress({operationId:op,attempt:1,from:'signed',to:'expired',result:{}});
  const rd=await alloc(d);assert.equal(rd.recentSlot,finalized-1,'expired attempt and no account: replaced');
  assert.equal(await readLookupTablePlan({registry,identity:{...base,campaign:key()}}),null);
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
