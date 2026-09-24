// Program build 6 for the API: the parent claim window and burn record, the fee block's coin-buyback bucket and the
// keeper's running totals, each keyed on the live feature list (null without it, never zero when unknown).
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {PARENT_CLAIM_WINDOW_SECONDS,parentClaimExpiryUnix,parentClaimWindow,parentsBurnRecord,parentWindowClosedMessage} from '../parent-claim-window.mjs';
import {feeBlock,readChildBuybackTotals} from '../postlaunch-state.mjs';
const LAUNCH=1790213669,EXPIRY=LAUNCH+PARENT_CLAIM_WINDOW_SECONDS;// Shartcoin: 2026-09-24 01:34:29 UTC; the window is zero, so it closes at the launch time
const B5=['burn-child-fees','jupiter-route'],B6=['burn-child-fees','parent-claim-expiry','child-buyback'];
test('expiry is launch time + the window (zero) only when the live build has parent-claim-expiry',()=>{
 assert.equal(PARENT_CLAIM_WINDOW_SECONDS,0);
 assert.equal(parentClaimExpiryUnix(LAUNCH,B6),EXPIRY);assert.equal(parentClaimExpiryUnix(LAUNCH,B5),null);assert.equal(parentClaimExpiryUnix(LAUNCH,[]),null);assert.equal(parentClaimExpiryUnix(LAUNCH,null),null);
 assert.equal(parentClaimExpiryUnix(0,B6),null,'an unlaunched campaign has no window');assert.equal(parentClaimExpiryUnix(null,B6),null);
});
test('window flags at the boundary: open at expiry - 1, closed at expiry; null flags without the feature',()=>{
 assert.deepEqual(parentClaimWindow(LAUNCH,B6,EXPIRY-1),{expiresAtUnix:EXPIRY,windowOpen:true,expired:false});
 assert.deepEqual(parentClaimWindow(LAUNCH,B6,EXPIRY),{expiresAtUnix:EXPIRY,windowOpen:false,expired:true});
 assert.deepEqual(parentClaimWindow(LAUNCH,B5,EXPIRY+10),{expiresAtUnix:null,windowOpen:null,expired:null});
 assert.throws(()=>parentClaimWindow(LAUNCH,B6,NaN),/Clock/);
 assert.equal(parentWindowClosedMessage(EXPIRY),'The parent claim window closed on 2026-09-24 01:34 UTC. Unclaimed parent rewards are burned.');
});
test('the burn record reads KIDSPAR1 offsets 224, 232 and 240; zero time means not run yet',()=>{
 const d=Buffer.alloc(256);d.write('KIDSPAR1');assert.deepEqual(parentsBurnRecord(d),{burnedRaw:[0n,0n],burnedAtUnix:null});
 d.writeBigUInt64LE(30_000_000_000_000n,224);d.writeBigUInt64LE(7n,232);d.writeBigUInt64LE(BigInt(EXPIRY+5),240);
 assert.deepEqual(parentsBurnRecord(d),{burnedRaw:[30_000_000_000_000n,7n],burnedAtUnix:EXPIRY+5});
 assert.throws(()=>parentsBurnRecord(Buffer.alloc(255)),/Invalid parents account/);
});
test('fee block: old fields always, the coin-buyback bucket only with child-buyback, unknown totals stay null',()=>{
 const counters={childPending:'0',totalSol:'16800',treasuryPaid:'9800',devPaid:'2000',parentAAllocated:'2500',parentBAllocated:'2500',parentASpent:'1000',parentBSpent:'0',parentABurned:'5',parentBBurned:'6',childBurned:'99'};
 assert.deepEqual(feeBlock(counters,B5,{spentLamports:'1',boughtAndBurnedRaw:'2',slices:1}),counters,'build 5: byte for byte');
 assert.deepEqual(feeBlock(counters,B6,{spentLamports:'700',boughtAndBurnedRaw:'12345',slices:3}),{...counters,childBuybackPending:'4000',childBuybackSpent:'700',childBoughtAndBurned:'12345'});
 assert.deepEqual(feeBlock(counters,B6,null),{...counters,childBuybackPending:'4000',childBuybackSpent:null,childBoughtAndBurned:null});
 assert.equal(feeBlock(null,B6,null),null);
});
test('the keeper totals come from the journal of the same campaign; a journal without them reads zero, no journal reads null',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-b6-'));const p=join(dir,'j.json');
 writeFileSync(p,JSON.stringify({identity:{campaign:'C'},history:[],childBuyback:{spentLamports:'500000000',boughtAndBurnedRaw:'18407628128724',slices:1,lastSignature:'s'}}));
 assert.deepEqual(readChildBuybackTotals('C',p),{spentLamports:'500000000',boughtAndBurnedRaw:'18407628128724',slices:1});
 assert.equal(readChildBuybackTotals('other',p),null);assert.equal(readChildBuybackTotals('C',join(dir,'missing.json')),null);
 writeFileSync(p,JSON.stringify({identity:{campaign:'C'},history:[]}));assert.deepEqual(readChildBuybackTotals('C',p),{spentLamports:'0',boughtAndBurnedRaw:'0',slices:0});
});
