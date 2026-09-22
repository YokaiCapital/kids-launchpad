import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePrelaunchState,chainAllocation,parseCommitment} from '../src/prelaunch-chain.js';
const state={configured:true,network:'localnet',genesisHash:'test-ledger',phase:'open',deadlineUnix:1900000000,poolSoftUsd:40000,poolHardUsd:200000,totalLamports:'761000000000',softCapLamports:'100000000000',hardCapLamports:'500000000000',user:{committedLamports:'11000000000',acceptedLamports:'0',refundableLamports:'0',refundedLamports:'0'}};
test('chain figures never add the sample baseline, and proportional rounding stays in refund',()=>{
 assert.equal(validatePrelaunchState(state),state);const estimate=chainAllocation(state,1000000000n);
 assert.equal(estimate.total,762000000000n);assert.equal(estimate.retained+estimate.refund,12000000000n);assert.equal(estimate.retained,7874015748n);
 assert.equal(chainAllocation({...state,phase:'failed'}).refund,11000000000n);
});
test('unavailable or foreign-network state fails closed; preview requires explicit false',()=>{
 assert.throws(()=>validatePrelaunchState(null));assert.throws(()=>validatePrelaunchState({...state,network:'mainnet'}));assert.throws(()=>validatePrelaunchState({...state,totalLamports:761}));assert.throws(()=>validatePrelaunchState({...state,softCapLamports:'0'}));assert.deepEqual(validatePrelaunchState({configured:false}),{configured:false});
});
test('commitments preserve raw precision and reject invalid amounts',()=>{
 assert.equal(parseCommitment('0.000000001'),1n);assert.equal(parseCommitment('12.012345678'),12012345678n);for(const input of ['0','-1','1e3','1.0000000001','abc'])assert.throws(()=>parseCommitment(input));
});
