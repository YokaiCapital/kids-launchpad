import test from 'node:test';
import assert from 'node:assert/strict';
import {KIND,DAY,encodePolicy,decodePolicy,policyHash,splitLp,initialize,nextAction,simulateStep} from './direct-policy.mjs';
import {validatePolicy as historicalValidate} from './model.mjs';
const p={kind:KIND,mode:'direct',permanentLpBps:5000,temporaryLpBps:5000,dailyRemainingBps:300,firstDelaySeconds:'86400',end:{kind:'after-cycles',cycles:90},temporaryFeeTreatment:'recycle-with-principal'};
const pool={tokenReserve:100_000_000n,solReserve:100_000_000_000n,lpSupply:1_000_000n,tradeFeePpm:0n,protocolFeeSharePpm:0n,fundFeeSharePpm:0n};
test('Direct codec: explicit policy with Rust-compatible bytes, no new active default',()=>{
 const b=encodePolicy(p);
 assert.equal(b.toString('hex'),'4b494453444c5031010001015a0000008051010000000000881388132c010000');
 assert.deepEqual(decodePolicy(b),p);assert.equal(policyHash(p),policyHash(Object.fromEntries(Object.entries(p).reverse())));
 for(const at of [0,8,10,11,24,26,28,30,31]){const bad=Buffer.from(b);bad[at]^=128;assert.throws(()=>decodePolicy(bad));}
 assert.throws(()=>decodePolicy(b.subarray(0,31)));
 const until={...p,end:{kind:'until-dust'}};const u=encodePolicy(until);u.writeUInt32LE(90,12);assert.throws(()=>decodePolicy(u));
});
test('Direct cannot masquerade as parent or existing Standard policy',()=>{
 for(const bad of [{...p,mode:'family'},{...p,mode:'standard'},{...p,dailyRemainingBps:500},{...p,temporaryLpBps:10000},{...p,parentMint:'anything'},{...p,temporaryFeeTreatment:'distribute'},{...p,firstDelaySeconds:86399},{...p,end:{kind:'after-cycles',cycles:0}},{...p,end:{kind:'until-dust',cycles:90}}])assert.throws(()=>encodePolicy(bad));
 assert.throws(()=>historicalValidate(p));
 const missing={...p};delete missing.end;assert.throws(()=>encodePolicy(missing));
});
test('approved first cycle redeems 1.5% of initial LP; next is smaller',()=>{
 const s=initialize(1_000_000n,1n,p),r=simulateStep(s,p,1n+DAY,pool);
 assert.equal(s.permanentLp,500_000n);assert.equal(r.action.lp,15_000n);
 assert.equal(r.result.withdrawnTokens,1_500_000n);assert.equal(r.result.boughtTokens,1_477_500n);
 assert.equal(r.pool.tokenReserve,97_022_500n);assert.equal(r.pool.solReserve,pool.solReserve);
 assert.equal(nextAction(r.state,p,1n+2n*DAY).lp,14_550n);
});
test('integer and schedule bounds cannot silently round or overflow',()=>{
 assert.deepEqual(splitLp(10_001n),{permanent:5001n,temporary:5000n});
 assert.throws(()=>splitLp(Number.MAX_SAFE_INTEGER+1));assert.throws(()=>splitLp(1n));
 assert.throws(()=>initialize(1000n,(1n<<64n)-1n,p));
 const s=initialize(1_000_000n,1n,p);
 assert.equal(nextAction(s,p,DAY).kind,'wait');
 const r=simulateStep(s,p,1n+10n*DAY,pool);assert.equal(r.action.lp,15_000n);
 assert.equal(nextAction(r.state,p,10n*DAY+DAY).kind,'wait');
 assert.equal(nextAction(r.state,p,1n+11n*DAY).lp,14_550n);
});
test('ninety successful cycles, then remaining LP locks without another buy',()=>{
 let s=initialize(1_000_000_000_000n,1n,p),q={...pool,tokenReserve:485_000_000_000_000n,lpSupply:1_000_000_000_000n};
 for(let day=1;day<=90;day++){
  const r=simulateStep(s,p,1n+BigInt(day)*DAY,q);s=r.state;q=r.pool;
  assert.equal(s.cycles,day);assert.equal(s.permanentLp+s.remainingLp+s.redeemedLp,s.initialLp);
 }
 const remainder=s.remainingLp,locked=simulateStep(s,p,1n+90n*DAY,q);
 assert.equal(locked.action.kind,'lock-remainder');assert.equal(locked.state.relockedLp,remainder);
 assert.equal(locked.pool,q);assert.equal(locked.state.cycles,90);
 assert.equal(nextAction(locked.state,p,1n+91n*DAY).kind,'closed');
});
test('dust locks and donations do not expand the sealed initial budget',()=>{
 const s=initialize(66n,1n,p);assert.deepEqual(nextAction(s,p,1n+DAY),{kind:'lock-remainder',lp:33n});
 const large=initialize(1_000_000n,1n,p);
 const r=simulateStep(large,p,1n+DAY,{...pool,lpSupply:2_000_000n});
 assert.equal(r.action.lp,15_000n);assert.equal(r.state.permanentLp,500_000n);
 assert.throws(()=>simulateStep(large,p,1n+DAY,{...pool,lpSupply:999999n}));
});
test('policy and custody tampering is refused; until-dust has no implicit sunset',()=>{
 const until={...p,end:{kind:'until-dust'}},s=initialize(1_000_000n,1n,until);
 assert.equal(nextAction(s,until,DAY*400n).kind,'recycle');
 assert.throws(()=>nextAction(s,p,1n+DAY));
 for(const patch of [{remainingLp:s.remainingLp+1n},{permanentLp:1n},{closed:true},{cycles:1},{lastExecution:1n}])assert.throws(()=>nextAction({...s,...patch},until,1n+DAY));
});
test('fees reduce usable SOL even when all raw withdrawn SOL is spent',()=>{
 const s=initialize(1_000_000n,1n,p),r=simulateStep(s,p,1n+DAY,{...pool,tradeFeePpm:25000n,protocolFeeSharePpm:120000n,fundFeeSharePpm:40000n});
 assert.equal(r.result.swapFee,37_500_000n);assert.equal(r.result.protocolFee,4_500_000n);assert.equal(r.result.fundFee,1_500_000n);
 assert.equal(r.result.returnedSol,r.result.withdrawnSol);assert.equal(r.pool.solReserve,99_994_000_000n);
});
test('owner-selected fee preservation cannot fall back to the historical model',async()=>{
 const {validateForActivation,SELECTED_TEMPORARY_FEE_TREATMENT}=await import('./direct-policy.mjs');
 assert.equal(SELECTED_TEMPORARY_FEE_TREATMENT,'preserve-treasury-dev');
 assert.throws(()=>validateForActivation(p),/Owner selected preservation/);
 const selected={...p,temporaryFeeTreatment:SELECTED_TEMPORARY_FEE_TREATMENT};
 assert.throws(()=>validateForActivation(selected),/not implemented/);
 assert.throws(()=>encodePolicy(selected),/not implemented/);
 assert.throws(()=>initialize(1000000n,1n,selected),/not implemented/);
});
