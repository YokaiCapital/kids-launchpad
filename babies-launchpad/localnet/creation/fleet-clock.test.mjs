import test from 'node:test';import assert from 'node:assert/strict';
import {createChainClockMonitor,wallBudgetMs,fleetExpectation,classifyFleetFailure,FLEET_EXPECTATIONS} from './fleet-clock.mjs';

test('chain clock monitor measures the chain rate over a bounded window and reports a stall only after a sustained slow period',()=>{
 const m=createChainClockMonitor({windowMs:60000,minRate:0.5,stallMs:120000});
 assert.equal(m.observe(0,1000).rate,null,'a single sample has no rate');
 assert.equal(m.observe(5000,1005).rate,null,'less than ten seconds of wall time has no rate');
 const healthy=m.observe(20000,1020);assert.equal(healthy.rate,1);assert.equal(healthy.lagSeconds,-1000);assert.equal(healthy.stalledMs,0);assert.equal(m.stalled(),false);
 // The chain falls to a quarter of wall speed: stalled only once that persists for the stall bound.
 let wall=20000,chain=1020;for(let i=0;i<6;i++){wall+=20000;chain+=5;m.observe(wall,chain);}
 assert.ok(m.rate()<0.5);assert.equal(m.stalled(),false,'a slow minute is not yet a stall');
 for(let i=0;i<4;i++){wall+=20000;chain+=5;m.observe(wall,chain);}
 assert.equal(m.stalled(),true);
 const s=m.summary();assert.equal(s.minAcceptableRate,0.5);assert.ok(s.minRate<0.5);assert.equal(s.maxRate,1);assert.equal(s.firstLagSeconds,-1000);assert.ok(s.stalledMs>=120000);
 // Recovery clears the stall.
 for(let i=0;i<4;i++){wall+=20000;chain+=20;m.observe(wall,chain);}assert.equal(m.stalled(),false);
 assert.throws(()=>createChainClockMonitor({windowMs:1000}));assert.throws(()=>createChainClockMonitor({stallMs:10}));assert.throws(()=>m.observe(NaN,1));
});

test('wall budget follows the observed chain rate, defaults to a slow rate without observations and never exceeds the ceiling',()=>{
 assert.equal(wallBudgetMs({remainingChainSeconds:600,rate:1,allowanceMs:60000,ceilingMs:3600000}),660000);
 assert.equal(wallBudgetMs({remainingChainSeconds:600,rate:0.5,allowanceMs:60000,ceilingMs:3600000}),1260000);
 assert.equal(wallBudgetMs({remainingChainSeconds:600,rate:null,allowanceMs:60000,ceilingMs:3600000}),3600000,'no rate assumes a tenth of wall speed and hits the ceiling');
 assert.equal(wallBudgetMs({remainingChainSeconds:600,rate:9,allowanceMs:60000,ceilingMs:3600000}),460000,'a fast clock is capped at 1.5 so a burst never shrinks the budget below reality');
 assert.equal(wallBudgetMs({remainingChainSeconds:0,rate:1,allowanceMs:60000,ceilingMs:3600000}),60000);
 assert.throws(()=>wallBudgetMs({remainingChainSeconds:1,rate:1,allowanceMs:70000,ceilingMs:60000}));
});

test('fleet expectation refuses to treat an expired launch window as a launch run and qualifies the refund path only once the window has elapsed',()=>{
 assert.deepEqual(FLEET_EXPECTATIONS,['launch','refund-window-expired']);
 const base={deadline:1000n,launchDeadline:4600n};
 assert.equal(fleetExpectation({...base,chainNow:900n}).kind,'launch');
 assert.equal(fleetExpectation({...base,chainNow:4600n,phases:[3,3]}).kind,'launch','launched campaigns keep the launch expectation after the window');
 assert.throws(()=>fleetExpectation({...base,chainNow:4600n,phases:[0,3]}),e=>e.code==='EXPIRED_WINDOW');
 assert.throws(()=>fleetExpectation({expect:'refund-window-expired',...base,chainNow:4599n,phases:[0]}),e=>e.code==='WINDOW_OPEN');
 assert.throws(()=>fleetExpectation({expect:'refund-window-expired',...base,chainNow:4600n,phases:[0,3]}),e=>e.code==='ALREADY_LIVE');
 const refund=fleetExpectation({expect:'refund-window-expired',...base,chainNow:4600n,phases:[0,0]});
 assert.equal(refund.kind,'refund-window-expired');assert.equal(refund.chainTarget,4600n);assert.equal(refund.requiresFeeWork,false);
 assert.throws(()=>fleetExpectation({expect:'anything',...base,chainNow:0n}));assert.throws(()=>fleetExpectation({deadline:10n,launchDeadline:10n,chainNow:0n}));
});

test('failure classification separates environment, precondition, service-level and plain errors',()=>{
 assert.deepEqual(classifyFleetFailure(null),{kind:'none',reason:null});
 assert.equal(classifyFleetFailure(Object.assign(Error('x'),{code:'ENVIRONMENT_CHAIN_CLOCK'})).kind,'environment');
 assert.equal(classifyFleetFailure(Object.assign(Error('x'),{code:'EXPIRED_WINDOW'})).kind,'precondition');
 assert.equal(classifyFleetFailure(Object.assign(Error('x'),{code:'SLO_TIMEOUT'}),{closeObservedAt:null}).kind,'environment','a wall timeout before the chain close is not a throughput failure');
 assert.equal(classifyFleetFailure(Object.assign(Error('x'),{code:'SLO_TIMEOUT'}),{closeObservedAt:'2026-09-27T00:00:00Z'}).kind,'slo');
 assert.equal(classifyFleetFailure(Error('boom')).kind,'error');
});
