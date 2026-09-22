import test from 'node:test';
import assert from 'node:assert/strict';
import {escrowIntentRetry} from '../escrow-intent-retry.mjs';
test('only conclusively finalized failure permits same-ID renewal',()=>{
 assert.equal(escrowIntentRetry({signature:'sig',status:{confirmationStatus:'finalized',err:{InstructionError:[0,'Custom']}}}),'renew-failed');
 assert.equal(escrowIntentRetry({proof:{kind:'finalized-failure'},signature:'sig',status:null,finalizedExpired:true}),'renew-failed');
 for(const confirmationStatus of ['processed','confirmed'])assert.equal(escrowIntentRetry({signature:'sig',status:{confirmationStatus,err:{failed:true}},finalizedExpired:true}),'retain');
});
test('expired unsigned wallet message never rebuilds regardless of absent signature',()=>{
 assert.throws(()=>escrowIntentRetry({signature:null,status:null,finalizedExpired:true}),/fresh request ID/);
 assert.throws(()=>escrowIntentRetry({proof:{kind:'finalized-expiry'}}),/may already have executed/);
 assert.equal(escrowIntentRetry({signature:null,status:null,finalizedExpired:false}),'retain');
});
test('signed missing or pruned outcome remains unresolved after expiry',()=>{
 assert.throws(()=>escrowIntentRetry({signature:'possibly-landed',status:null,finalizedExpired:true}),/reconcile its signature/);
 assert.equal(escrowIntentRetry({signature:'pending',status:null,finalizedExpired:false}),'retain');
 assert.equal(escrowIntentRetry({signature:'ok',status:{confirmationStatus:'finalized',err:null},finalizedExpired:true}),'retain');
});
