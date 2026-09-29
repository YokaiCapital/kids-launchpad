import test from 'node:test';import assert from 'node:assert/strict';
import {acceptedScope} from './accepted-scope.mjs';
const scope={genesisHash:'genesis',programId:'program',treasury:'treasury',operatingPayer:'keeper',policyHash:'a'.repeat(64),planHash:'b'.repeat(64)};
const quote={genesisHash:'genesis',programId:'program',treasury:'treasury',operatingPayer:'keeper',policyHash:'c'.repeat(64),planHash:'d'.repeat(64)};
test('an accepted request keeps the policy and plan it was quoted with; identity must be this service',()=>{
 const s=acceptedScope(scope,quote);assert.equal(s.policyHash,'c'.repeat(64));assert.equal(s.planHash,'d'.repeat(64));assert.equal(s.acceptedPolicy.current,false);assert.equal(s.treasury,'treasury');
 assert.equal(acceptedScope(scope,{...quote,policyHash:scope.policyHash,planHash:scope.planHash}).acceptedPolicy.current,true);
 for(const bad of [{genesisHash:'other'},{programId:'other'},{treasury:'other'},{operatingPayer:'other'},{policyHash:'short'},{planHash:null}])assert.equal(acceptedScope(scope,{...quote,...bad}),null,JSON.stringify(bad));
 assert.equal(acceptedScope(scope,null),null);
 // A quote without a pinned treasury or payer (older quotes) is still bound by ledger and program.
 assert.ok(acceptedScope(scope,{...quote,treasury:undefined,operatingPayer:undefined}));
});
