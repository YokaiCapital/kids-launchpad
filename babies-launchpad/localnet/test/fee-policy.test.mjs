import test from 'node:test';
import assert from 'node:assert/strict';
import {withLaunchPolicy,validateLaunchPolicy} from '../launch-policy.mjs';
import {FEE_DISTRIBUTION,lpRevenueEntitlements,lpRevenueDelta} from '../fee-distribution.mjs';
test('old unspecified/equal fee policy migrates to parent buyback policy',()=>{
 for(const revenueSplit of [null,{devBps:5000,platformBps:5000}]){
  const config=withLaunchPolicy({launch:{parentShareBps:1000,pool:{revenueSplit}}});
  assert.deepEqual(config.launch.pool.revenueSplit,FEE_DISTRIBUTION);
  assert.doesNotThrow(()=>validateLaunchPolicy(config.launch));
  config.launch.pool.revenueSplit={...FEE_DISTRIBUTION,devWeight:70,parentAWeight:0,parentBWeight:0};
  assert.throws(()=>validateLaunchPolicy(config.launch));
 }
});
test('actual LP earnings split into98/20/25/25 with no double protocol deduction',()=>{
 assert.deepEqual(lpRevenueEntitlements(16800000n),{treasury:9800000n,dev:2000000n,parentA:2500000n,parentB:2500000n,reservedDust:0n});
});
test('cumulative accounting preserves equal parent budgets and all raw units',()=>{
 let paid={treasury:0n,dev:0n,parentA:0n,parentB:0n};
 for(let n=1n;n<=1000n;n++){
  const delta=lpRevenueDelta(n-1n,n);for(const k of Object.keys(paid)){assert.ok(delta[k]>=0n);paid[k]+=delta[k];}
  assert.equal(paid.parentA,paid.parentB);
  assert.equal(Object.values(paid).reduce((a,b)=>a+b,0n)+delta.reservedDust,n);
  assert.ok(delta.reservedDust>=0n&&delta.reservedDust<=3n);
 }
 const result=lpRevenueEntitlements(1000n);for(const k of Object.keys(paid))assert.equal(paid[k],result[k]);
 assert.throws(()=>lpRevenueDelta(2n,1n));assert.throws(()=>lpRevenueEntitlements(-1n));assert.throws(()=>lpRevenueEntitlements(1));
});
