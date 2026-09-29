import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DAY,POLICY_KIND,validatePolicy,policyHash,splitLaunchLp,initialize,nextAction,recyclePool,simulateStep} from './model.mjs';
const policy={kind:POLICY_KIND,mode:'standard',permanentLpBps:9000,recyclableLpBps:1000,dailyRemainingBps:100,durationDays:90};
const zeroFees={tradeFeePpm:0n,protocolFeeSharePpm:0n,fundFeeSharePpm:0n};
const pool={tokenReserve:100_000_000n,solReserve:100_000_000_000n,lpSupply:1_000_000n,...zeroFees};
test('independent 1% whole-pool example: 1.99M burn, all SOL returned',()=>{
 const r=recyclePool({...pool,lpAmount:10_000n});
 assert.equal(r.withdrawnTokens,1_000_000n);assert.equal(r.withdrawnSol,1_000_000_000n);
 assert.equal(r.boughtTokens,990_000n);assert.equal(r.burnedTokens,1_990_000n);
 assert.equal(r.tokenReserve,98_010_000n);assert.equal(r.solReserve,pool.solReserve);assert.equal(r.lpSupply,990_000n);
 // A subsequent sale of 990k tokens restores price and extracts 1 SOL, even though the cycle returned its SOL.
 const sold=990_000n,solOut=sold*r.solReserve/(r.tokenReserve+sold);
 assert.equal(solOut,1_000_000_000n);
 assert.equal((r.tokenReserve+sold)*pool.solReserve,(r.solReserve-solOut)*pool.tokenReserve);
});
test('1% of temporary allocation is not 1% of whole pool',()=>{
 const s=initialize(1_000_000n,1n,policy),a=nextAction(s,policy,1n+DAY);
 assert.equal(s.permanentLp,900_000n);assert.equal(a.lp,1_000n);
 const r=simulateStep(s,policy,1n+DAY,pool);
 assert.equal(r.result.burnedTokens,199_900n);assert.equal(r.state.remainingLp,99_000n);
 assert.equal(r.state.permanentLp,s.permanentLp);
});
test('rounding favours permanent LP, large integers remain exact',()=>{
 assert.deepEqual(splitLaunchLp(10_001n,policy),{permanent:9001n,recyclable:1000n});
 const max=(1n<<64n)-1n,p=splitLaunchLp(max,policy);assert.equal(p.permanent+p.recyclable,max);
 assert.throws(()=>initialize(Number.MAX_SAFE_INTEGER+1,1n,policy),/unsafe/);
 assert.throws(()=>initialize('18446744073709551616',1n,policy),/u64/);
 assert.throws(()=>initialize('1e6',1n,policy),/integer/);
 assert.throws(()=>initialize(true,1n,policy),/integer/);
 assert.throws(()=>splitLaunchLp(1n,policy),/zero/);
});
test('trade fees: returning all raw SOL is not restoring all usable reserves',()=>{
 const r=recyclePool({...pool,lpAmount:10_000n,tradeFeePpm:25000n,protocolFeeSharePpm:120000n,fundFeeSharePpm:40000n});
 assert.equal(r.swapFee,25_000_000n);assert.equal(r.protocolFee,3_000_000n);assert.equal(r.fundFee,1_000_000n);assert.equal(r.lpFee,21_000_000n);
 assert.equal(r.returnedSol,r.withdrawnSol);assert.equal(r.solReserve,99_996_000_000n);
 assert.equal(r.boughtTokens,99_000_000n*975_000_000n/99_975_000_000n);
 assert.ok(r.burnedTokens<1_990_000n);
});
test('rolling 24h guard and no catch-up after downtime',()=>{
 const s=initialize(1_000_000n,100n,policy);
 assert.equal(nextAction(s,policy,100n+DAY-1n).kind,'wait');
 const r=simulateStep(s,policy,100n+DAY*10n,pool);
 assert.equal(r.action.lp,1000n,'only one daily redemption, not ten');
 assert.equal(nextAction(r.state,policy,100n+DAY*10n).kind,'wait');
 assert.equal(nextAction(r.state,policy,100n+DAY*11n-1n).kind,'wait');
 assert.equal(nextAction(r.state,policy,100n+DAY*11n).lp,990n);
});
test('sunset takes precedence and locks everything unused without a final buy',()=>{
 const s=initialize(1_000_000n,100n,policy);
 assert.deepEqual(nextAction(s,policy,s.sunsetAt),{kind:'lock-remainder',lp:100_000n});
 const r=simulateStep(s,policy,s.sunsetAt,pool);
 assert.equal(r.state.relockedLp,100_000n);assert.equal(r.state.remainingLp,0n);assert.equal(r.state.closed,true);
 assert.equal(r.pool,pool);assert.equal(nextAction(r.state,policy,s.sunsetAt+DAY).kind,'closed');
});
test('dust remainder is locked, never rounded up to a withdrawal',()=>{
 const s=initialize(100n,100n,policy);
 assert.deepEqual(nextAction(s,policy,100n+DAY),{kind:'lock-remainder',lp:10n});
});
test('policy edits, unknown terms, Family and unsafe bounds are refused',()=>{
 const s=initialize(1_000_000n,100n,policy);
 assert.throws(()=>nextAction(s,{...policy,durationDays:91},101n),/Policy changed/);
 for(const bad of [{...policy,mode:'family'},{...policy,dailyRemainingBps:10000},{...policy,recyclableLpBps:2000,permanentLpBps:8000},{...policy,permanentLpBps:9500},{...policy,recipient:'wallet'}])assert.throws(()=>validatePolicy(bad));
 const reversed=Object.fromEntries(Object.entries(policy).reverse());assert.equal(policyHash(policy),policyHash(reversed));
});
test('custody and schedule tampering is refused',()=>{
 const s=initialize(1_000_000n,100n,policy);
 assert.throws(()=>nextAction({...s,remainingLp:s.remainingLp+1n},policy,100n+DAY),/conservation/);
 assert.throws(()=>nextAction({...s,permanentLp:800_000n,initialLp:900_000n},policy,100n+DAY),/split/);
 assert.throws(()=>nextAction({...s,sunsetAt:s.sunsetAt+1n},policy,100n+DAY),/schedule/);
 assert.throws(()=>simulateStep(s,policy,100n+DAY,{...pool,lpSupply:999_999n}),/protected/);
});
test('invalid reserves, rates and dust cannot produce a nominal successful burn',()=>{
 for(const change of [{lpAmount:0n},{lpAmount:pool.lpSupply},{tokenReserve:0n},{solReserve:1n},{tradeFeePpm:1_000_000n},{protocolFeeSharePpm:1_000_001n},{tokenReserve:1n}])assert.throws(()=>recyclePool({...pool,lpAmount:10_000n,...change}));
});
test('each candidate conserves custody and sunsets; no fees and no traders are explicitly assumed',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../../deployment/presets/standard-recycling-research-v1.json',import.meta.url)));
 assert.equal(manifest.activation,null);assert.equal(manifest.selectedPolicy,null);assert.equal(manifest.status,'research-only');
 for(const p of manifest.candidatePolicies){
  let s=initialize(pool.lpSupply,100n,p),q={...pool},burn=0n;
  for(let day=1;day<=p.durationDays+1;day++){
   const r=simulateStep(s,p,100n+BigInt(day)*DAY,q);s=r.state;q=r.pool;burn+=r.result?.burnedTokens??0n;
   assert.equal(s.permanentLp+s.remainingLp+s.relockedLp+s.recycledLp,s.initialLp);
   assert.equal(q.tokenReserve+burn,pool.tokenReserve);assert.equal(q.solReserve,pool.solReserve);
   assert.ok(s.recycledLp<=s.initialRecyclableLp);assert.ok(q.lpSupply>=s.permanentLp+s.relockedLp);
  }
  assert.equal(s.closed,true);assert.ok(s.relockedLp>0n);assert.ok(s.recycledLp>0n);
 }
});
