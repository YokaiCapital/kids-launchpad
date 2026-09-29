import test from 'node:test';import assert from 'node:assert/strict';
import {fleetParameters,fleetCapacity,qualifyFleet,retainedFleetSignerDirectory} from './qualify-fleet.mjs';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('fleet rehearsal bounds actual fixture work and refuses external databases before RPC access',async()=>{
 assert.deepEqual(fleetParameters(),{campaigns:2,receipts:8});assert.deepEqual(fleetParameters({campaigns:100,receipts:100}),{campaigns:100,receipts:100});
 for(const input of [{campaigns:0},{campaigns:101},{receipts:1},{receipts:101},{receipts:3},{campaigns:1.5}])assert.throws(()=>fleetParameters(input));
 await assert.rejects(qualifyFleet({postgresUrl:'postgresql://example.com/production'}),/owned local/);
});

test('large fleet prewarms independent lifecycle and recovery replicas within a fixed shared RPC budget',()=>{
 const c=fleetCapacity(100);assert.equal(c.replicas.lifecycle,2);assert.equal(c.replicas.recovery,2);assert.equal(c.replicas.harvest,1);assert.equal(c.replicas.economics,1);
 assert.equal(Object.values(c.policy.lanes).reduce((n,lane)=>n+lane.ratePerSecond,0),240);assert.equal(Object.values(c.replicas).reduce((a,b)=>a+b,0),8);assert.equal(c.concurrency,4);assert.equal(c.rpcResource,'fleet-rpc-240-v2');assert.equal(c.signerPolicy.lanes.lifecycle.ratePerSecond,30);
 assert.equal(fleetCapacity(2).replicas.lifecycle,1);assert.throws(()=>fleetCapacity(101));
});

test('signer-balanced experiment versions its read quota without raising signing or spend permissions',()=>{
 const baseline=fleetCapacity(100),c=fleetCapacity(100,'signer-balanced-360');
 assert.equal(Object.values(c.replicas).reduce((a,b)=>a+b,0),13);assert.equal(c.replicas.lifecycle,4);assert.equal(c.replicas.recovery,4);assert.equal(c.replicas.provisioning,2);
 assert.deepEqual(c.policy,baseline.policy);assert.deepEqual(c.signerPolicy,baseline.signerPolicy);
 assert.equal(c.signerRpcPerSecond,120);assert.notEqual(c.signerRpcResource,baseline.signerRpcResource);
 assert.equal(Object.values(c.policy.lanes).reduce((n,p)=>n+p.ratePerSecond,0)+c.signerRpcPerSecond,360);
 assert.throws(()=>fleetCapacity(2,'signer-balanced-360'));assert.throws(()=>fleetCapacity(100,'unbounded'));
});

test('nested background cohorts retain the existing signer journal instead of resetting spend history',()=>{
 const a=mkdtempSync(join(tmpdir(),'kids-fleet-')),b=mkdtempSync(join(tmpdir(),'kids-fleet-'));
 const scope={genesisHash:'genesis',programId:'program',rpcUrl:'http://127.0.0.1:19499',schema:'owned'};
 try{
  writeFileSync(join(a,'scope.json'),JSON.stringify({...scope,backgroundDirectory:b}));writeFileSync(join(b,'scope.json'),JSON.stringify(scope));
  assert.throws(()=>retainedFleetSignerDirectory(a,scope),/missing/);
  writeFileSync(join(b,'signer-state.json'),'{}');assert.equal(retainedFleetSignerDirectory(a,scope),b);
  assert.throws(()=>retainedFleetSignerDirectory(a,{...scope,schema:'other'}),/scope differs/);
  rmSync(join(b,'signer-state.json'));writeFileSync(join(b,'scope.json'),JSON.stringify({...scope,backgroundDirectory:a}));
  assert.throws(()=>retainedFleetSignerDirectory(a,scope),/lineage/);
 }finally{rmSync(a,{recursive:true,force:true});rmSync(b,{recursive:true,force:true});}
});
