import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from './registry/registry.mjs';
import {releaseFixture} from './hosted/release-manifest.test.mjs';
import {keeperGrantExpiry,createCampaignOperator,parseArgs,resolveArgs,REFUND_ALLOWANCE_SECONDS,GRANT_MARGIN_MS} from './operator-lifecycle.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
test('the initial keeper grant outlives the launch window plus the refund allowance and margin',()=>{
 const now=1000000000000;
 assert.equal(keeperGrantExpiry({launchDeadline:'1000',chainNow:'400',now}),new Date(now+600000+REFUND_ALLOWANCE_SECONDS*1000+GRANT_MARGIN_MS).toISOString());
 assert.equal(keeperGrantExpiry({launchDeadline:'1000',chainNow:'2000',now}),new Date(now+REFUND_ALLOWANCE_SECONDS*1000+GRANT_MARGIN_MS).toISOString(),'a closed window needs only the allowance and margin');
 assert.throws(()=>keeperGrantExpiry({launchDeadline:'1000',chainNow:'400',now,hours:1}),/must cover/);
 assert.equal(keeperGrantExpiry({launchDeadline:'1000',chainNow:'400',now,hours:48}),new Date(now+48*3600000).toISOString());
 assert.deepEqual(parseArgs(['schedule','--campaign','x']),{command:'schedule',campaign:'x'});
 assert.deepEqual(resolveArgs(['status','--campaign','x'],{KIDS_REGISTRY_URL:'postgres://r',KIDS_RPC_URL:'https://rpc',KIDS_RELEASE_MANIFEST:'deployment/hosted/release-mainnet.json'}),{command:'status',campaign:'x',registry:'postgres://r',rpc:'https://rpc',manifest:'deployment/hosted/release-mainnet.json'},'hosted containers supply the endpoints');
 assert.equal(resolveArgs(['status','--campaign','x','--rpc','https://mine'],{KIDS_RPC_URL:'https://rpc'}).rpc,'https://mine','a flag wins over the environment');
});
test('operator actions: keeper grant, scheduling, refund continuation and return grant, each explicit and bound to the chain state',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:5,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  // The release treasury is not the signer: the sealed campaign treasury must equal the former.
  const manifest={...releaseFixture({schema:39}).manifest,treasury:addr(8)},id={genesisHash:manifest.genesisHash,programId:manifest.programId,campaign:addr(4)},creator=addr(9),termsHash='a'.repeat(64);
  const c={phase:0,termsHash,terms:{mode:0,treasury:new PublicKey(manifest.treasury),dev:addr(5),creator:new PublicKey(creator),opensAt:50n},deadline:200n,launchDeadline:300n,total:1500n,soft:500n,hard:1000n,receiptCount:2n,settledCount:0n,settledAccepted:0n,refunded:0n};let clock=100n;
  const chain={readCampaign:async()=>({...c}),chainTime:async()=>clock,verifyLaunch:async()=>({ok:true,checks:{}})};
  await registry.campaigns.upsert({...id,network:'mainnet',mode:'standard',campaignVersion:3,registryStatus:'planned',termsHash,creator});
  await registry.budgets.put({...id,payer:manifest.signerPublicKey,policy:'creator-funded-v1',reservedLamports:'100000000',spentLamports:'0',returnedLamports:'0'});
  const now=Date.now(),operator=createCampaignOperator({registry,manifest,chain,now:()=>now});
  await assert.rejects(operator.schedule(id.campaign),/Grant the initial keeper capability first/);
  const grant=await operator.grantKeeper(id.campaign);assert.equal(grant.kind,'keeper');assert.deepEqual(grant.tags,[3,4,6]);assert.equal(grant.expiresAt,new Date(now+200000+REFUND_ALLOWANCE_SECONDS*1000+GRANT_MARGIN_MS).toISOString());
  const scheduled=await operator.schedule(id.campaign);assert.equal(scheduled.scheduled,true);
  let status=await operator.status(id.campaign);assert.equal(status.lifecycle.stage,'scheduled');assert.equal(status.capability.capabilityId,grant.capabilityId);assert.equal(status.budget.availableLamports,'100000000');assert.equal(status.chain.creator,creator);assert.equal(status.chain.failed,false);
  await assert.rejects(operator.grantRefund(id.campaign),/failed campaign/);await assert.rejects(operator.grantReturn(id.campaign),/fully refunded/);
  // Deadline-aware: while funding is open (clock 100 < deadline 200) a round below its soft cap, or with nothing committed, is not
  // failed: no refund continuation, no reserve return, status says open.
  for(const open of [{total:100n,refunded:0n},{total:0n,refunded:0n}]){Object.assign(c,open);status=await operator.status(id.campaign);assert.equal(status.chain.failed,false);assert.equal(status.chain.fundingOpen,true);await assert.rejects(operator.grantRefund(id.campaign),/failed campaign/);await assert.rejects(operator.grantReturn(id.campaign),/fully refunded/);}
  // After the funding deadline the same totals are a failed round (refund continuation allowed; return only once fully refunded).
  clock=250n;Object.assign(c,{total:100n,refunded:0n});status=await operator.status(id.campaign);assert.equal(status.chain.failed,true);assert.equal(status.chain.fundingOpen,false);await assert.rejects(operator.grantReturn(id.campaign),/fully refunded/);
  clock=100n;Object.assign(c,{total:1500n,refunded:0n});
  // fundingOpen follows the shared rule (phase, opening time, deadline): before the opening it is not open, at the exact close it is closed.
  clock=40n;assert.equal((await operator.status(id.campaign)).chain.fundingOpen,false);clock=200n;assert.equal((await operator.status(id.campaign)).chain.fundingOpen,false);clock=100n;assert.equal((await operator.status(id.campaign)).chain.fundingOpen,true);
  c.phase=2;clock=400n;const refund=await operator.grantRefund(id.campaign);assert.deepEqual(refund.tags,[3]);assert.equal(refund.kind,'keeper');
  await assert.rejects(operator.grantReturn(id.campaign),/fully refunded/);c.refunded=1500n;
  const ret=await operator.grantReturn(id.campaign);assert.equal(ret.kind,'operating-return');assert.deepEqual(ret.recipients,[creator]);assert.deepEqual(ret.tags,[]);
  status=await operator.status(id.campaign);assert.equal(status.chain.failed,true);assert.equal(status.capability.kind,'operating-return');
  const foreign={...c,terms:{...c.terms,treasury:new PublicKey(addr(7))}};await assert.rejects(createCampaignOperator({registry,manifest,chain:{...chain,readCampaign:async()=>foreign}}).grantKeeper(id.campaign),/not the release treasury/);
 }finally{if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
