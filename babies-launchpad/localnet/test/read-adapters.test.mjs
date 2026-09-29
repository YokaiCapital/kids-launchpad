// Read adapter gates: two campaigns read at once with no shared state, the active row prefers the manifest reader only
// when it names that campaign, failures are explicit categories, and a chain read projects back to the registry.
import test from 'node:test';import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {openRegistry} from '../registry/registry.mjs';
import {readCampaignView,readCampaignViews,chainStatusOf,campaignTerms,projectView,categorize,LEGACY_POLICY} from '../registry/read-adapters.mjs';
const addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const GENESIS=addr(200),PROGRAM=addr(201);
const row=(n,extra={})=>({genesisHash:GENESIS,programId:PROGRAM,campaign:addr(n),mode:'family',campaignVersion:3,registryStatus:'archived',legacyAdapterVersion:'v3-family-single',sourcePaths:[],parentMints:[addr(8),addr(9)],creator:addr(7),dev:addr(6),treasury:addr(5),...extra});
const account=(n,over={})=>({soft:1000n,hard:5000n,deadline:100,launchDeadline:200,total:BigInt(n)*1000n,refunded:0n,phase:0,receiptCount:BigInt(n),settledReceiptCount:0n,settledAccepted:0n,mint:new PublicKey(Buffer.alloc(32,n)),supply:10n**15n,dev:addr(6),treasury:addr(5),creator:addr(7),launchedAt:0,pool:new PublicKey(Buffer.alloc(32,0)),devClaimed:0n,distributionProgram:null,distributionActivated:false,...over});
test('chain status follows the deployed rule',()=>{
 const c=account(2);
 assert.equal(chainStatusOf(c,50),'open');assert.equal(chainStatusOf(c,150),'awaiting-launch');assert.equal(chainStatusOf({...c,total:500n},150),'failed');assert.equal(chainStatusOf(c,250),'failed');assert.equal(chainStatusOf({...c,phase:3},250),'launched');
});
test('two campaigns read at once, each from its own reader call, in input order',async()=>{
 const calls=[];
 const reader=async r=>{calls.push(r.campaign);await new Promise(res=>setTimeout(res,r.campaign===addr(1)?20:1));const n=r.campaign===addr(1)?1:2;return {campaign:account(n,{phase:n===2?3:0,launchedAt:n===2?150:0,pool:new PublicKey(Buffer.alloc(32,40))}),slot:100+n,commitment:'confirmed',chainTimeUnix:160};};
 const views=await readCampaignViews([row(1),row(2)],{readers:{readCampaignChain:reader}});
 assert.deepEqual(calls.sort(),[addr(1),addr(2)].sort());
 assert.equal(views[0].id,GENESIS+':'+PROGRAM+':'+addr(1));assert.equal(views[0].phase,'awaiting-launch');assert.equal(views[0].totals.totalLamports,'1000');assert.equal(views[0].source.slot,101);assert.equal(views[0].pool,null);
 assert.equal(views[1].phase,'launched');assert.equal(views[1].totals.receiptCount,'2');assert.equal(views[1].pool,new PublicKey(Buffer.alloc(32,40)).toBase58());assert.equal(views[1].launchedAtUnix,150);assert.equal(views[1].terms.supplyRaw,'1000000000000000');
});
test('the active row uses the manifest reader only when it names this campaign; otherwise the chain reader',async()=>{
 const active=row(3,{registryStatus:'active'});
 const readActive=async()=>({configured:true,escrowAddress:addr(3),genesisHash:GENESIS,programId:PROGRAM,phase:'open',chainTimeUnix:50,softCapLamports:'1000',hardCapLamports:'5000',deadlineUnix:100,launchDeadlineUnix:200,mint:addr(3),totalLamports:'700',refundedLamports:'0',settledAcceptedLamports:'0',receiptCount:'1',settledReceiptCount:'0',pool:null});
 const fromManifest=await readCampaignView(active,{readers:{readActive,readCampaignChain:async()=>{throw Error('chain must not be called');}}});
 assert.equal(fromManifest.source.kind,'active-manifest');assert.equal(fromManifest.totals.totalLamports,'700');assert.equal(fromManifest.phase,'open');
 const other=await readCampaignView(active,{readers:{readActive:async()=>({configured:true,escrowAddress:addr(4),genesisHash:GENESIS,programId:PROGRAM}),readCampaignChain:async()=>({campaign:account(3),slot:9,chainTimeUnix:10})}});
 assert.equal(other.source.kind,'chain','the manifest names another campaign: chain read instead');
 const broken=await readCampaignView(active,{readers:{readActive:async()=>{throw Error('manifest gone');},readCampaignChain:async()=>({campaign:account(3),slot:9,chainTimeUnix:10})}});
 assert.equal(broken.available,true);assert.equal(broken.source.kind,'chain');
});
test('an unreadable campaign is explicit: available false with a category, never a number',async()=>{
 const timeout=await readCampaignView(row(5),{readers:{readCampaignChain:async()=>{const e=Error('The operation was aborted due to timeout');e.name='TimeoutError';e.code='ABORT_ERR';throw e;}}});
 assert.equal(timeout.available,false);assert.equal(timeout.error.category,'timeout');assert.equal(timeout.totals,undefined);
 const wrong=await readCampaignView(row(5),{readers:{readCampaignChain:async()=>{const e=Error('other ledger');e.code='WRONG_NETWORK';throw e;}}});assert.equal(wrong.error.category,'wrong-network');
 const malformed=await readCampaignView(row(5),{readers:{readCampaignChain:async()=>{throw Error('Invalid atomic campaign');}}});assert.equal(malformed.error.category,'malformed');
 const none=await readCampaignView(row(5,{legacyAdapterVersion:'v9'}),{readers:{readCampaignChain:async()=>{throw Error('never');}}});assert.equal(none.error.category,'no-adapter');
 for(const [e,c] of [[{code:'ECONNREFUSED'},'network'],[Error('429 Too Many Requests'),'rate-limited'],[Error('502 upstream'),'upstream'],[Error('???'),'unknown']])assert.equal(categorize(e),c);
});
test('terms come from the registry row with the fixed legacy policy; a chain view projects status and slot back',async()=>{
 const r=openRegistry();r.migrate();const base=row(6,{softCapLamports:'1000',hardCapLamports:'5000',supplyRaw:'1000000000000000'});r.campaigns.upsert(base);
 const t=campaignTerms(r.campaigns.get(addr(6)));assert.equal(t.policy,LEGACY_POLICY['v3-family-single']);assert.equal(t.policy.supplySplitBps.parentA,500);assert.equal(t.softCapLamports,'1000');assert.equal(t.termsHash,null);assert.deepEqual(t.parentMints,[addr(8),addr(9)]);
 const view=await readCampaignView(base,{readers:{readCampaignChain:async()=>({campaign:account(6,{phase:3,launchedAt:150,pool:new PublicKey(Buffer.alloc(32,41))}),slot:777,chainTimeUnix:400})}});
 const p=projectView(r,base,view);assert.equal(p.campaign.chainStatus,'launched');assert.equal(p.campaign.sourceSlot,777);assert.equal(p.campaign.pool,new PublicKey(Buffer.alloc(32,41)).toBase58());assert.equal(p.campaign.launchedAt,'1970-01-01T00:02:30.000Z');
 assert.equal(projectView(r,base,{available:false}),null,'an unavailable view writes nothing');
 r.close();
});
