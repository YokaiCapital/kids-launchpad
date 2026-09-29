import test from 'node:test';
import assert from 'node:assert/strict';
import {admissionDecision,validateAdmissionPolicy} from './admission.mjs';
import {openRegistry} from './registry.mjs';
import {createAdmissionGuard} from '../jobs/admission.mjs';
import {createJobRunner} from '../jobs/runner.mjs';
const policy={ratePerSecond:2,burst:4,lanes:{lifecycle:{ratePerSecond:1,burst:2},harvest:{ratePerSecond:1,burst:2}}};
test('admission preserves hard lane reservations, fractional refill and backwards-clock safety',()=>{
 assert.throws(()=>validateAdmissionPolicy({...policy,burst:3}),/exceed/);
 assert.throws(()=>validateAdmissionPolicy({...policy,ratePerSecond:1}),/exceed/);
 const limit={ratePerSecond:2,burst:1};
 let d=admissionDecision({limit,now:1000});assert.equal(d.result.allowed,true);
 d=admissionDecision({limit,now:1250,bucket:{tokens_micro:d.tokensMicro,updated_ms:d.updatedMs}});assert.equal(d.result.allowed,false);assert.equal(d.result.retryAfterMs,250);
 d=admissionDecision({limit,now:1500,bucket:{tokens_micro:d.tokensMicro,updated_ms:d.updatedMs}});assert.equal(d.result.allowed,true);
 d=admissionDecision({limit,now:1000,bucket:{tokens_micro:d.tokensMicro,updated_ms:d.updatedMs}});assert.equal(d.result.allowed,false);assert.equal(d.result.retryAfterMs,1000);
 const slow={ratePerSecond:0.1,burst:1};
 assert.equal(admissionDecision({limit:slow,now:1000,bucket:{tokens_micro:'0',updated_ms:1000}}).result.retryAfterMs,10000);
 assert.doesNotThrow(()=>validateAdmissionPolicy({ratePerSecond:0.3,burst:3,lanes:{one:{ratePerSecond:0.1,burst:1},two:{ratePerSecond:0.2,burst:2}}}));
});
test('capacity waits yield instead of spending a financial job failure retry',async()=>{
 let now=1790000000000;const r=openRegistry({now:()=>now});r.migrate();
 try{
  const p={ratePerSecond:1,burst:1,lanes:{lifecycle:{ratePerSecond:1,burst:1}}};
  const admit=createAdmissionGuard({registry:r,resource:'signer-primary',lane:'lifecycle',policy:p});await admit();
  let externalCalls=0;
  const id={genesisHash:'1'.repeat(32),programId:'2'.repeat(32),campaign:'3'.repeat(32)};
  r.campaigns.upsert({...id,mode:'standard',registryStatus:'planned',campaignVersion:2});
  const j=r.jobs.enqueue({...id,operationKey:'work',jobClass:'launch'}).job;
  const runner=createJobRunner({registry:r,owner:'capacity-test',now:()=>now,maxAttempts:1,handlers:{launch:{async run(){await admit();externalCalls++;return {outcome:'done'};}}}});
  await runner.tick();const yielded=r.jobs.get(j.jobId);
  assert.equal(yielded.state,'queued');assert.equal(yielded.result.outcome,'yield');assert.equal(yielded.result.attempts,0);assert.equal(externalCalls,0);
  assert.equal(Date.parse(yielded.notBefore),now+1000);
  now+=1001;await runner.tick();assert.equal(r.jobs.get(j.jobId).state,'done');assert.equal(externalCalls,1);
 }finally{r.close();}
});
