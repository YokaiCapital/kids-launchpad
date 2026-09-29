import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {createMintLeases} from '../../mints/leases.mjs';
import {fakeInventory} from './mint-inventory-fixture.mjs';
const address=()=>Keypair.generate().publicKey.toBase58();
export async function mintLeaseCases(t,registries){
 const inventory=fakeInventory({stock:Array.from({length:8},address)});
 const services=registries.map(registry=>createMintLeases({registry,inventory,validateMint:m=>m}));
 const binding=()=>({network:'localnet',genesisHash:address(),creator:address(),draftId:'draft',idempotencyKey:'reservation'});
 const absent={async mintExists(){return false;}};
 await t.test('concurrent retries share one reservation and one immutable signature',async()=>{
  const bind=binding();const results=await Promise.all(Array.from({length:8},(_,i)=>services[i%services.length].reserve(bind)));
  const {lease}=results[0];assert.equal(new Set(results.map(r=>r.lease.leaseId)).size,1);
  assert.equal((await services[0].recordSigningIntent({leaseId:lease.leaseId,messageDigest:'a'.repeat(64)})).outcome,'recorded');
  const records=await Promise.all(Array.from({length:2},(_,i)=>services[i%services.length].recordSignature({leaseId:lease.leaseId,messageDigest:'a'.repeat(64),signature:String(i+5).repeat(64)})));
  assert.equal(records.filter(r=>r.outcome==='recorded').length,1);
  assert.equal((await services[0].reserve({...bind,programId:address()})).outcome,'refused');
 });
 await t.test('signing intent wins while a release chain read is pending',async()=>{
  const {lease}=await services[0].reserve(binding());let read,go;
  const entered=new Promise(r=>{read=r;}),pause=new Promise(r=>{go=r;});
  const releasing=services[0].reconcile({leaseId:lease.leaseId,rpc:{async mintExists(){read();await pause;return false;}}});
  await entered;assert.equal((await services[1%services.length].recordSigningIntent({leaseId:lease.leaseId,messageDigest:'b'.repeat(64)})).outcome,'recorded');
  go();assert.equal((await releasing).outcome,'unresolved');
  assert.equal((await services[0].get(lease.leaseId)).state,'signed-pending');
  assert.equal(inventory.mints.get(lease.mint).status,'reserved');
 });
 await t.test('release claim blocks a concurrent signature intent',async()=>{
  const {lease}=await services[0].reserve(binding());let entered,go;
  const arrived=new Promise(r=>{entered=r;}),pause=new Promise(r=>{go=r;}),original=inventory.releaseUnsignedReservation;
  inventory.releaseUnsignedReservation=async(...args)=>{entered();await pause;return original(...args);};
  try{
   const releasing=services[0].reconcile({leaseId:lease.leaseId,rpc:absent});await arrived;
   assert.equal((await services[1%services.length].recordSigningIntent({leaseId:lease.leaseId,messageDigest:'c'.repeat(64)})).outcome,'refused');
   go();assert.equal((await releasing).outcome,'released');
  }finally{go();inventory.releaseUnsignedReservation=original;}
 });
 await t.test('crash after inventory release resumes from its receipt; old lease cannot sign a reissued mint',async()=>{
  const inventory=fakeInventory({stock:[address()]});
  const services=registries.map(registry=>createMintLeases({registry,inventory,validateMint:m=>m}));
  const {lease}=await services[0].reserve(binding());const original=inventory.releaseUnsignedReservation;let once=true;
  inventory.releaseUnsignedReservation=(...args)=>{const receipt=original(...args);if(once){once=false;throw Error('synthetic cross-store crash');}return receipt;};
  try{
   await assert.rejects(services[0].reconcile({leaseId:lease.leaseId,rpc:absent}),/synthetic cross-store crash/);
   assert.equal((await services[0].get(lease.leaseId)).state,'releasing');
   assert.equal((await services[1%services.length].reconcile({leaseId:lease.leaseId,rpc:absent})).outcome,'released');
   const next=await services[0].reserve(binding());
   assert.equal(next.lease.mint,lease.mint);assert.notEqual(next.lease.leaseId,lease.leaseId);
   assert.equal((await services[1%services.length].recordSigningIntent({leaseId:lease.leaseId,messageDigest:'d'.repeat(64)})).outcome,'refused');
   assert.equal((await services[0].get(next.lease.leaseId)).state,'reserved');
  }finally{inventory.releaseUnsignedReservation=original;}
 });
}
