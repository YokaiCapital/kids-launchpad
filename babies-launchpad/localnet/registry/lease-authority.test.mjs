import test from 'node:test';import assert from 'node:assert/strict';
import {openRegistry} from './registry.mjs';
import {PublicKey} from '@solana/web3.js';
const addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const id={genesisHash:addr(1),programId:addr(2),campaign:addr(3)};
test('lease authority checks exact current job and grant, expiry and revocation without a historical signer mark',async()=>{
 let now=1790000000000;const r=openRegistry({now:()=>now});r.migrate();
 try{
  r.campaigns.upsert({...id,mode:'standard',campaignVersion:2,registryStatus:'planned'});
  const capability=r.capabilities.grant({...id,programVersion:2,tags:[4],expiresAt:new Date(now+60000).toISOString()});
  const job=r.jobs.enqueue({...id,operationKey:'settle',jobClass:'settlement'}).job;
  const input={capability,operationKey:'settle',fencingToken:1};
  assert.equal(r.capabilities.authorizeLease(input).allowed,false,'queued is not leased');
  r.jobs.leaseById({jobId:job.jobId,token:job.fencingToken,owner:'one',ttlMs:5000});
  assert.equal(r.capabilities.authorizeLease(input).validForMs,5000);
  assert.equal(r.capabilities.authorizeLease({...input,fencingToken:2}).allowed,false);
  assert.equal(r.capabilities.authorizeLease({...input,operationKey:'refund'}).allowed,false);
  assert.equal(r.capabilities.authorizeLease({...input,capability:{...capability,genesisHash:addr(4)}}).allowed,false);
  now+=5001;assert.equal(r.capabilities.authorizeLease(input).allowed,false,'expired before a newer token was seen');
  const fresh=r.jobs.leaseById({jobId:job.jobId,token:1,owner:'two',ttlMs:5000});
  input.fencingToken=fresh.fencingToken;assert.equal(r.capabilities.authorizeLease(input).allowed,true);
  const replacement=r.capabilities.grant({...id,programVersion:2,tags:[4],expiresAt:new Date(now+60000).toISOString()});
  assert.equal(r.capabilities.authorizeLease(input).allowed,false,'superseded grant cannot authorize');
  input.capability=replacement;assert.equal(r.capabilities.authorizeLease(input).allowed,true);
  r.capabilities.revoke(replacement.capabilityId);assert.equal(r.capabilities.authorizeLease(input).allowed,false,'revoked latest grant cannot fall back');
 }finally{r.close();}
});
test('latest capability lookup is scoped and retains newest revocation/expiry records',()=>{
 const now=1790000000000,r=openRegistry({now:()=>now});r.migrate();
 try{
  const other={...id,genesisHash:addr(4)};
  for(const identity of [id,other])r.campaigns.upsert({...identity,mode:'standard',campaignVersion:2,registryStatus:'planned'});
  assert.equal(r.capabilities.latest(id),null);
  const grant=identity=>r.capabilities.grant({...identity,programVersion:2,tags:[4],expiresAt:new Date(now+60000).toISOString()});
  const first=grant(id),foreign=grant(other),latest=grant(id);
  assert.notEqual(first.capabilityId,latest.capabilityId);r.capabilities.revoke(latest.capabilityId);
  assert.equal(r.capabilities.latest(id).capabilityId,latest.capabilityId);assert.ok(r.capabilities.latest(id).revokedAt);
  assert.equal(r.capabilities.latest(other).capabilityId,foreign.capabilityId);
  const expired=r.capabilities.grant({...id,programVersion:2,tags:[4],expiresAt:new Date(now-1).toISOString()});
  assert.equal(r.capabilities.latest(id).capabilityId,expired.capabilityId);
 }finally{r.close();}
});
