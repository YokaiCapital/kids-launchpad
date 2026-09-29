import test from 'node:test';import assert from 'node:assert/strict';import {planWorkerScale} from './scaling.mjs';
const now=1790510400000;
function fixture(){const lanes=['lifecycle','recovery','harvest'];return {
 now,policy:{maxTotalReplicas:9,lanes:Object.fromEntries(lanes.map(l=>[l,{minimum:1,maximum:4,slotsPerReplica:2,measuredJobMs:200,maxStep:2,cooldownMs:30000,idleMs:300000,needsSigner:true}]))},
 deployment:Object.fromEntries(lanes.map(l=>[l,1])),history:{},
 snapshot:{version:1,observedAt:new Date(now).toISOString(),lanes:Object.fromEntries(lanes.map(l=>[l,{due:0,leased:0,failed:0,unknownTransactions:0,fundingWait:0,capacityWait:0,oldestDueMs:0,targetMs:5000}])),presence:{lanes:Object.fromEntries(lanes.map(l=>[l,{minimum:1,alive:1,active:0,capacity:2}]))},authority:{missing:0,revoked:0,expired:0},admission:{signerRpc:{status:'observed',lanes:{signer:{availableRequests:10,retryAfterMs:0}}},...Object.fromEntries(['rpc','signer'].map(k=>[k,{status:'observed',lanes:Object.fromEntries(lanes.map(l=>[l,{availableRequests:10,retryAfterMs:0}]))}]))}}};}
const decision=(x,l='lifecycle')=>planWorkerScale(x).decisions.find(d=>d.lane===l);
test('scaling respects lane minima, step limits and aggregate ceiling',()=>{const x=fixture();x.policy.maxTotalReplicas=5;for(const q of Object.values(x.snapshot.lanes))q.due=1000;const result=planWorkerScale(x);assert.equal(decision(x,'recovery').desired,3);assert.equal(decision(x).desired,1);assert.equal(result.apply,false);assert.ok(result.decisions.reduce((n,d)=>n+d.desired,0)<=5);});
test('stale telemetry and upstream saturation cannot trigger a scale storm',()=>{const x=fixture();x.snapshot.lanes.lifecycle.due=1000;x.snapshot.observedAt=new Date(now-25001).toISOString();assert.equal(planWorkerScale(x).reason,'stale-observation');x.snapshot.observedAt=new Date(now+1).toISOString();assert.equal(planWorkerScale(x).reason,'stale-observation');x.snapshot.observedAt=new Date(now).toISOString();x.snapshot.admission.rpc.lanes.lifecycle.retryAfterMs=500;assert.equal(decision(x).reason,'upstream-saturated');assert.equal(decision(x).desired,1);});
test('missing authority, funding and admission hold financial scaling',()=>{for(const field of ['authority','funding','admission']){const x=fixture();x.snapshot.lanes.lifecycle.due=1000;if(field==='authority')x.snapshot.authority.expired=1;else if(field==='funding')x.snapshot.lanes.lifecycle.fundingWait=1;else x.snapshot.admission.signer.status='unavailable';assert.equal(decision(x).desired,1);}});
test('only sustained idle can remove a replica, with unknown and active work protected',()=>{const x=fixture();x.deployment.lifecycle=3;x.snapshot.presence.lanes.lifecycle.alive=3;x.snapshot.presence.lanes.lifecycle.capacity=6;x.history.lifecycle={lastAppliedAt:now-400000,idleSince:now-350000};assert.equal(decision(x).desired,2);x.snapshot.lanes.lifecycle.unknownTransactions=1;assert.equal(decision(x).desired,3);x.snapshot.lanes.lifecycle.unknownTransactions=0;x.snapshot.presence.lanes.lifecycle.active=1;assert.equal(decision(x).desired,3);x.snapshot.presence.lanes.lifecycle.active=0;x.history.lifecycle.idleSince=now-1000;assert.equal(decision(x).desired,3);});
test('cooldown uses acknowledged changes; missing inventory or impossible ceilings refuse',()=>{const x=fixture();x.snapshot.lanes.lifecycle.due=1000;x.history.lifecycle={lastAppliedAt:now-1000,idleSince:null};assert.equal(decision(x).reason,'cooldown');delete x.deployment.lifecycle;assert.throws(()=>planWorkerScale(x),/inventory/);const y=fixture();y.policy.maxTotalReplicas=2;assert.throws(()=>planWorkerScale(y),/minima/);});

test('busy lanes cannot consume another lane warm minimum',()=>{const x=fixture();x.policy.maxTotalReplicas=3;x.deployment.harvest=0;x.snapshot.presence.lanes.harvest.alive=0;x.snapshot.presence.lanes.harvest.capacity=0;x.snapshot.lanes.recovery.due=1000;assert.equal(decision(x,'recovery').desired,1);assert.equal(decision(x,'harvest').desired,1);});
test('unhealthy workers and missing authority need recovery, not speculative replica growth',()=>{const x=fixture();x.snapshot.lanes.lifecycle.due=1000;x.snapshot.presence.lanes.lifecycle.alive=0;x.snapshot.presence.lanes.lifecycle.capacity=0;assert.equal(decision(x).reason,'worker-recovery-required');x.snapshot.presence.lanes.lifecycle.alive=1;x.snapshot.presence.lanes.lifecycle.capacity=2;delete x.snapshot.authority;assert.equal(decision(x).reason,'authority-unavailable');});

test('scaling cannot contradict monitored role minima or measured process slots',()=>{const x=fixture();x.snapshot.presence.lanes.lifecycle.minimum=2;assert.equal(decision(x).reason,'deployment-policy-mismatch');x.snapshot.presence.lanes.lifecycle.minimum=1;x.snapshot.presence.lanes.lifecycle.capacity=4;assert.equal(decision(x).reason,'deployment-policy-mismatch');});

test('signer evidence congestion or missing observation prevents financial scale-up',()=>{
 const x=fixture();x.snapshot.lanes.lifecycle.due=1000;x.snapshot.admission.signerRpc.lanes.signer.retryAfterMs=500;
 assert.equal(decision(x).reason,'upstream-saturated');assert.equal(decision(x).desired,1);
 delete x.snapshot.admission.signerRpc;assert.equal(decision(x).reason,'admission-unavailable');
 x.policy.lanes.lifecycle.needsSigner=false;assert.equal(decision(x).desired,3,'Signer-free lanes retain independent scaling');
});

test('scheduled close demand warms capacity before jobs become due and prevents idle scale-down',()=>{
 const x=fixture();x.policy.lanes.lifecycle.prewarmMs=300000;x.snapshot.lanes.lifecycle.scheduled={within60s:0,within300s:150,within600s:150};
 assert.equal(decision(x).reason,'scheduled-work');assert.equal(decision(x).desired,3);
 x.snapshot.lanes.lifecycle.scheduled.within300s=1;x.deployment.lifecycle=3;x.snapshot.presence.lanes.lifecycle.alive=3;x.snapshot.presence.lanes.lifecycle.capacity=6;x.history.lifecycle={lastAppliedAt:now-400000,idleSince:now-350000};
 assert.equal(decision(x).desired,3,'Do not remove warm capacity around an approaching deadline');
 delete x.snapshot.lanes.lifecycle.scheduled;assert.equal(decision(x).reason,'schedule-observation-unavailable');
 x.policy.lanes.lifecycle.prewarmMs=1;assert.throws(()=>planWorkerScale(x),/policy/);
});

test('blocked old campaigns do not suppress measured healthy launch demand',()=>{
 const x=fixture(),q=x.snapshot.lanes.lifecycle;q.due=1000;q.fundingWait=900;x.snapshot.authority.expired=100;
 q.scheduled={within60s:0,within300s:0,within600s:0};
 q.scaleDemand={due:100,blockedFunding:900,blockedAuthority:100,scheduled:{...q.scheduled}};
 assert.equal(decision(x).desired,2,'Only the 100 healthy jobs drive additional capacity');
 q.scaleDemand.due=0;assert.equal(decision(x).desired,1,'Blocked work cannot trigger replica growth');
 q.scaleDemand.due=1001;assert.equal(decision(x).reason,'incomplete-demand-observation');
 q.scaleDemand.due=0;q.scaleDemand.scheduled.within300s=1;assert.equal(decision(x).reason,'incomplete-demand-observation');
});

test('healthy scheduled launches prewarm despite another campaign expired grant',()=>{
 const x=fixture(),q=x.snapshot.lanes.lifecycle;x.snapshot.authority.expired=1;x.policy.lanes.lifecycle.prewarmMs=300000;
 q.scheduled={within60s:0,within300s:1000,within600s:1000};
 q.scaleDemand={due:0,blockedFunding:0,blockedAuthority:1,scheduled:{within60s:0,within300s:100,within600s:100}};
 assert.equal(decision(x).desired,2);assert.equal(decision(x).reason,'scheduled-work');
 x.snapshot.admission.signerRpc.lanes.signer.retryAfterMs=1;assert.equal(decision(x).reason,'upstream-saturated','Shared upstream ceilings are still enforced');
});

test('more replicas cannot bypass an observed signer spend cooldown',()=>{
 const x=fixture();x.snapshot.lanes.lifecycle.due=1000;x.snapshot.lanes.lifecycle.signerSpendWait=1;
 assert.equal(decision(x).reason,'signer-spend-limit');assert.equal(decision(x).desired,1);
 x.snapshot.lanes.lifecycle.signerSpendWait=0;assert.equal(decision(x).desired,3);
 x.snapshot.lanes.lifecycle.signerSpendWait=-1;assert.equal(decision(x).reason,'incomplete-observation');
});
