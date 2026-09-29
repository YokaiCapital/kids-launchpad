// Mint lease gates: atomic reservation per binding, same key same lease, no double lease of one mint, digest persisted
// before signing, a signed-pending lease never released, release only when never signed and absent on chain, consumed
// never recycled, stock by state, explicit no-stock, suffix and network validation.
// The fake inventory follows the contract of SqliteVanityMintInventory (reserve by binding under one lock; release refused
// once a signature exists). Grinding a real `kids` key takes minutes, so the state-machine tests inject a relaxed
// validator (canonical, on-curve) and use genuine random keys; the strict suffix rule has its own tests and is the
// production default. The real inventory is exercised where it can be without stock (empty inventory, fallback refused).
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes} from 'node:crypto';
import {Keypair,PublicKey} from '@solana/web3.js';
import {openRegistry} from '../registry/registry.mjs';
import {createMintLeases,validateKidsMint,validateNetwork} from './leases.mjs';
import {MAINNET_GENESIS} from '../network.mjs';
import {fakeInventory} from '../test/helpers/mint-inventory-fixture.mjs';
import {mintLeaseCases} from '../test/helpers/mint-lease-cases.mjs';
const addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const LOCAL=addr(9),CREATOR=Keypair.generate().publicKey.toBase58(),CREATOR2=Keypair.generate().publicKey.toBase58();
const realKey=()=>Keypair.generate().publicKey.toBase58();
const relaxed=mint=>{const k=new PublicKey(mint);if(k.toBase58()!==mint||!PublicKey.isOnCurve(k.toBytes()))throw Error('Mint is not a canonical on-curve address');return mint;};

function setup(stock,validateMint=relaxed){const registry=openRegistry();registry.migrate();const inventory=fakeInventory({stock});const logs=[];return {registry,inventory,logs,leases:createMintLeases({registry,inventory,log:l=>logs.push(l),validateMint})};}
const bind=(extra={})=>({network:'localnet',genesisHash:LOCAL,draftId:'draft-1',creator:CREATOR,idempotencyKey:'key-1',...extra});
const rpc=({exists=false,status='confirmed',fail=false}={})=>({async mintExists(){if(fail)throw Error('fetch failed');return exists;},async signatureStatus(){return {status};}});
test('validation: exact lowercase kids suffix on a canonical on-curve address; network and genesis must agree',async()=>{
 const k=realKey();assert.throws(()=>validateKidsMint(k),/end in lowercase kids/);
 assert.throws(()=>validateKidsMint(k.slice(0,-4)+'KIDS'),/canonical|kids/);
 assert.throws(()=>validateKidsMint('not-an-address'),/canonical/);
 assert.throws(()=>validateKidsMint(PublicKey.default.toBase58()),/kids|on-curve|canonical/);
 assert.deepEqual(validateNetwork({network:'localnet',genesisHash:LOCAL}),{network:'localnet',genesisHash:LOCAL});
 assert.equal(validateNetwork({network:'mainnet',genesisHash:MAINNET_GENESIS}).network,'mainnet');
 assert.throws(()=>validateNetwork({network:'mainnet',genesisHash:LOCAL}),/not the mainnet genesis/);
 assert.throws(()=>validateNetwork({network:'testnet',genesisHash:LOCAL}),/network must be/);
});
test('the strict default refuses an inventory mint without the suffix as invalid-mint; nothing is leased and no suffix is changed',async()=>{
 const {leases,registry}=setup([realKey()],validateKidsMint);
 const r=(await leases.reserve(bind()));assert.equal(r.outcome,'invalid-mint');assert.match(r.reason,/kids/);assert.equal(registry.mintLeases.counts().reserved,0);
 await assert.rejects(leases.reserve(bind({network:'mainnet'})),/not the mainnet genesis/);
 registry.close();
});
test('reserve is idempotent per binding, two creators never get one mint, the public view carries no key material, exhausted stock is no-stock',async()=>{
 const m1=realKey(),m2=realKey();const {leases,registry,inventory,logs}=setup([m1,m2]);
 const a=(await leases.reserve(bind()));assert.equal(a.outcome,'reserved');assert.deepEqual(Object.keys(a.lease).sort(),['campaign','leaseId','mint','network','state']);assert.equal(a.lease.mint,m1);assert.equal(a.lease.state,'reserved');
 const again=(await leases.reserve(bind()));assert.equal(again.outcome,'existing');assert.equal(again.lease.leaseId,a.lease.leaseId);
 assert.equal((await leases.reserve(bind({draftId:'draft-2'}))).outcome,'refused','the same key cannot move to another draft');
 const b=(await leases.reserve(bind({creator:CREATOR2,idempotencyKey:'key-2'})));assert.equal(b.outcome,'reserved');assert.equal(b.lease.mint,m2);assert.notEqual(b.lease.mint,a.lease.mint);
 const none=(await leases.reserve(bind({creator:CREATOR2,idempotencyKey:'key-3'})));assert.equal(none.outcome,'no-stock');assert.ok(logs.some(l=>l.event==='mint-lease-no-stock'));
 assert.deepEqual((await leases.stock()),{inventory:{available:0,reserved:2,signed:0,quarantined:0},leases:{reserved:2,releasing:0,'signed-pending':0,consumed:0,quarantined:0,released:0},usable:0});
 // UNIQUE(mint): a second registry row for the same mint is impossible even if the inventory misbehaved
 assert.throws(()=>registry.mintLeases.insert({mint:m1,creator:CREATOR2,network:'localnet',draftId:'x',idempotencyKey:'y'}),/UNIQUE|constraint/i);
 assert.equal(inventory.reservations.size,2);
 registry.close();
});
test('the approved message digest is persisted before any signature; another digest is refused; the signature must match the digest',async()=>{
 const {leases,registry}=setup([realKey()]);
 const {lease}=(await leases.reserve(bind()));const digest='a'.repeat(64),sig='5'.repeat(64);
 assert.equal((await leases.recordSignature({leaseId:lease.leaseId,messageDigest:digest,signature:sig})).outcome,'refused','no signature before the intent is recorded');
 const rec=(await leases.recordSigningIntent({leaseId:lease.leaseId,messageDigest:digest}));assert.equal(rec.outcome,'recorded');assert.equal(rec.lease.state,'signed-pending');
 assert.equal(registry.mintLeases.get(lease.leaseId).messageDigest,digest);
 assert.equal((await leases.recordSigningIntent({leaseId:lease.leaseId,messageDigest:digest})).outcome,'recorded','idempotent');
 assert.equal((await leases.recordSigningIntent({leaseId:lease.leaseId,messageDigest:'b'.repeat(64)})).outcome,'refused');
 assert.equal((await leases.recordSignature({leaseId:lease.leaseId,messageDigest:'b'.repeat(64),signature:sig})).outcome,'refused');
 assert.equal((await leases.recordSignature({leaseId:lease.leaseId,messageDigest:digest,signature:sig})).outcome,'recorded');
 assert.equal((await leases.recordSignature({leaseId:lease.leaseId,messageDigest:digest,signature:'6'.repeat(64)})).outcome,'refused','one signature per lease');
 assert.equal((await leases.recordSigningIntent({leaseId:'nope',messageDigest:digest})).outcome,'refused');
 registry.close();
});
test('reconcile: a signed-pending lease is never released (timeout or not); it becomes consumed when the mint exists or the signature confirmed',async()=>{
 const {leases,registry,inventory}=setup([realKey()]);
 const {lease}=(await leases.reserve(bind()));(await leases.recordSigningIntent({leaseId:lease.leaseId,messageDigest:'a'.repeat(64)}));
 assert.deepEqual(await leases.reconcile({leaseId:lease.leaseId,rpc:rpc({exists:false})}),{outcome:'kept',state:'signed-pending',reason:'a signed message may still land; never returned to stock'});
 const timeouts=await leases.expireReserved({olderThanMs:0,rpc:rpc({exists:false})});assert.deepEqual(timeouts,[],'a signed-pending lease is not a reserved lease: a timeout does not touch it');
 (await leases.recordSignature({leaseId:lease.leaseId,messageDigest:'a'.repeat(64),signature:'5'.repeat(64)}));
 assert.equal((await leases.reconcile({leaseId:lease.leaseId,rpc:rpc({exists:false,status:'unresolved'})})).outcome,'kept');
 assert.equal((await leases.reconcile({leaseId:lease.leaseId,rpc:rpc({exists:false,status:'confirmed'})})).outcome,'consumed');
 assert.equal((await leases.get(lease.leaseId)).state,'consumed');
 assert.equal((await leases.reconcile({leaseId:lease.leaseId,rpc:rpc({exists:false})})).outcome,'unchanged','consumed is final');
 assert.equal((await leases.quarantine({leaseId:lease.leaseId,reason:'x'})).outcome,'refused');
 assert.equal(inventory.counts().available,0,'a consumed mint never returns to stock');
 // the other path: mint exists on chain
 const w=setup([realKey()]);const l2=(await w.leases.reserve(bind())).lease;(await w.leases.recordSigningIntent({leaseId:l2.leaseId,messageDigest:'c'.repeat(64)}));
 assert.equal((await w.leases.reconcile({leaseId:l2.leaseId,rpc:rpc({exists:true})})).outcome,'consumed');
 registry.close();w.registry.close();
});
test('reconcile: a reserved lease is released only when the inventory proves no signature AND the chain says absent; an unreadable chain releases nothing',async()=>{
 const m=realKey();const {leases,registry,inventory}=setup([m]);
 const {lease}=(await leases.reserve(bind()));
 assert.equal((await leases.reconcile({leaseId:lease.leaseId,rpc:rpc({fail:true})})).outcome,'unresolved');assert.equal((await leases.get(lease.leaseId)).state,'reserved');assert.equal(inventory.counts().reserved,1);
 // the inventory signed something for this mint that the registry does not know about (crash between signer and registry)
 inventory.sign(m);
 const kept=await leases.reconcile({leaseId:lease.leaseId,rpc:rpc({exists:false})});assert.equal(kept.outcome,'kept');assert.equal(kept.state,'signed-pending');
 // a fresh reserved lease, never signed, absent on chain: released, and the mint is back in stock
 const w=setup([realKey()]);const l2=(await w.leases.reserve(bind())).lease;
 const released=await w.leases.expireReserved({olderThanMs:0,rpc:rpc({exists:false})});assert.equal(released.length,1);assert.equal(released[0].outcome,'released');
 assert.equal((await w.leases.get(l2.leaseId)).state,'released');assert.equal(w.inventory.counts().available,1);
 assert.equal((await w.leases.reserve(bind())).outcome,'existing','the old binding still sees its released lease');
 const back=(await w.leases.reserve(bind({creator:CREATOR2,idempotencyKey:'key-9'})));assert.equal(back.outcome,'reserved');assert.equal(back.lease.mint,l2.mint,'the released mint is back in stock');assert.notEqual(back.lease.leaseId,l2.leaseId,'a reissued mint has a fresh lease identity');assert.equal(await w.leases.get(l2.leaseId),null,'the old lease cannot act on the new reservation');assert.match(w.registry.mintLeases.get(back.lease.leaseId).reason,/rebound/);
 assert.equal((await w.leases.reserve(bind())).outcome,'no-stock','the old binding no longer owns the row and the stock is empty: an explicit no-stock, never the rebound mint');
 // reserved but the mint account exists on chain: quarantined, never released
 const q=setup([realKey()]);const l3=(await q.leases.reserve(bind())).lease;assert.equal((await q.leases.reconcile({leaseId:l3.leaseId,rpc:rpc({exists:true})})).outcome,'quarantined');assert.equal(q.inventory.counts().reserved,1);
 registry.close();w.registry.close();q.registry.close();
});
test('the real encrypted inventory: empty stock is an explicit no-stock, and an ordinary-mint fallback is refused by the suffix rule',async t=>{
 let mod,store;
 try{[mod,store]=await Promise.all([import('../../kids-mint-worker/vendor/packages/launcher-sdk/src/mint-inventory.js'),import('../../kids-mint-worker/vendor/packages/launcher-sdk/src/sqlite-execution-store.js')]);}
 catch(e){t.skip('kids-mint-worker dependencies are not installed: '+String(e.message).slice(0,80));return;}
 const dir=mkdtempSync(join(tmpdir(),'kids-lease-inv-'));const key=randomBytes(32);const records=new store.SqliteLaunchExecutionStore(join(dir,'executions.sqlite'));
 const strict=new mod.SqliteVanityMintInventory({databasePath:join(dir,'inventory.sqlite'),executionStore:records,keyId:'test',encryptionKey:key,fallbackToOrdinaryMint:false});
 const registry=openRegistry();registry.migrate();
 try{
  const leases=createMintLeases({registry,inventory:strict});
  assert.equal((await leases.reserve(bind())).outcome,'no-stock');
  assert.deepEqual((await leases.stock()).inventory,{available:0,reserved:0,signed:0,quarantined:0});
  strict.close();
  const fallback=new mod.SqliteVanityMintInventory({databasePath:join(dir,'inventory2.sqlite'),executionStore:records,keyId:'test',encryptionKey:key,fallbackToOrdinaryMint:true});
  try{const r=(await createMintLeases({registry,inventory:fallback}).reserve(bind()));assert.equal(r.outcome,'invalid-mint','an ordinary generated mint is refused, never used as a kids mint');assert.equal(fallback.counts().reserved,1,'the inventory keeps its own record; nothing is silently recycled');}finally{fallback.close();}
 }finally{records.close();key.fill(0);registry.close();rmSync(dir,{recursive:true,force:true});}
});

test('mint orchestration races and cross-store recovery',async t=>{
 const registry=openRegistry();registry.migrate();try{await mintLeaseCases(t,[registry]);}finally{registry.close();}
});

test('real encrypted inventory release receipts survive reopening and cannot release a new owner',async()=>{
 const {SqliteVanityMintInventory}=await import('../../kids-mint-worker/vendor/packages/launcher-sdk/src/mint-inventory.js');
 const {SqliteLaunchExecutionStore}=await import('../../kids-mint-worker/vendor/packages/launcher-sdk/src/sqlite-execution-store.js');
 const dir=mkdtempSync(join(tmpdir(),'kids-release-proof-')),key=randomBytes(32),records=new SqliteLaunchExecutionStore(join(dir,'executions.sqlite'));
 // Ordinary fallback is enabled ONLY in this crypto/storage fixture, avoiding vanity grinding.
 const options={databasePath:join(dir,'inventory.sqlite'),executionStore:records,keyId:'test-release',encryptionKey:key,fallbackToOrdinaryMint:true};
 let inventory=new SqliteVanityMintInventory(options);
 try{
  const original={creator:CREATOR,draftId:'one',idempotencyKey:'one'},next={creator:CREATOR2,draftId:'two',idempotencyKey:'two'};
  const reservation=inventory.reserve(original),expected={reservationId:reservation.reservationId};
  const released=inventory.releaseUnsignedReservation(original,expected);assert.equal(released.released,true);
  inventory.close();inventory=new SqliteVanityMintInventory(options);
  const replay=inventory.releaseUnsignedReservation(original,expected);assert.equal(replay.replay,true);assert.equal(replay.mintAddress,reservation.mintAddress);
  const reissued=inventory.reserve(next);assert.equal(reissued.mintAddress,reservation.mintAddress);
  assert.throws(()=>inventory.releaseUnsignedReservation(next,expected),/binding mismatch/);
  assert.equal(inventory.releaseUnsignedReservation(original,expected).released,true);
  assert.equal(inventory.findReservation(next).reservationId,reissued.reservationId);
  assert.equal(inventory.counts().reserved,1,'the old release proof never releases the new owner');
 }finally{inventory.close();records.close();key.fill(0);rmSync(dir,{recursive:true,force:true});}
});
