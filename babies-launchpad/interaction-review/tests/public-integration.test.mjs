import test from 'node:test';import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {openRegistry} from '../../localnet/registry/registry.mjs';
import {campaignViewModel,publicPresetManifest} from '../server/public-campaign-contract.mjs';
import {createPublicLaunchAccount,cleanDraft} from '../server/public-launch-account.mjs';
import {normalizeCampaign,fundingState} from '../src/public/campaign-adapter.mjs';
import {initialDraft,parseUtcInput} from '../src/public/launch-draft.mjs';
import {readPresets} from '../../localnet/registry/presets.mjs';
import {FINANCIAL_WRITE_PATHS} from '../server/runtime.mjs';
import {publicServices} from '../server/public-services.mjs';
const addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const row={genesisHash:addr(1),programId:addr(2),campaign:addr(3),campaignVersion:2,mode:'standard',name:'Test',softCapLamports:'50000000000',hardCapLamports:'100000000000'};
test('registry API bridge feeds UI without converting an RPC outage into a zero balance',()=>{
 const unavailable=normalizeCampaign(campaignViewModel(row));assert.equal(unavailable.phase,'unavailable');assert.equal(unavailable.totals.committedLamports,null);assert.notEqual(fundingState(unavailable,150).action,'commit');
 const record=campaignViewModel(row,{live:{available:true,phase:'open',terms:{opensAtUnix:100,deadlineUnix:200,supplyRaw:'1000000000000000',decimals:6,tradeFeeBps:250,splitBps:{participants:4850,liquidity:4850,dev:300,parentA:0,parentB:0}},totals:{totalLamports:'150000000000'},source:{slot:9,commitment:'confirmed'}}});
 const vm=normalizeCampaign(record);assert.equal(vm.terms.fee.totalBps,250);assert.equal(vm.totals.committedLamports,'150000000000');assert.equal(fundingState(vm,150).action,'commit');assert.equal(vm.id,[row.genesisHash,row.programId,row.campaign].join(':'));
 const m=publicPresetManifest(readPresets());assert.equal(m.costQuote,null);assert.equal(m.capabilities.create,false);assert.equal(m.capabilities.family,false);assert.equal(m.presets[0].softLamports,'50000000000');
});
test('wallet-owned drafts persist, isolate owners and enforce optimistic revisions and safe media',async()=>{
 const registry=openRegistry();registry.migrate();const api=createPublicLaunchAccount({registry,access:{allows:()=>true}});const owner=addr(4),other=addr(5),draft=initialDraft(publicPresetManifest(readPresets()),{creator:other});draft.name='Pebble';
 const write={method:'POST',path:'/api/account/launches/drafts/save',owner,input:{id:'draft-1',revision:0,draft}};
 assert.equal((await api.handle({...write,owner:null})).status,401);
 const saved=await api.handle(write);assert.equal(saved.status,200);assert.equal(saved.body.draft.body.creator,owner);assert.equal(saved.body.draft.body.devBeneficiary,owner);
 assert.equal((await api.handle(write)).status,409);assert.equal((await api.handle({method:'GET',path:'/api/account/launches/drafts',owner:other})).body.drafts.length,0);
 assert.equal((await api.handle({...write,input:{...write.input,revision:1}})).body.draft.revision,2);
 assert.throws(()=>cleanDraft({...draft,pfp:{url:'blob:temporary'}},owner),/Upload/);
 assert.throws(()=>cleanDraft({...draft,pfp:{url:'https://untrusted.example/p.png'}},owner),/Upload/);
 assert.throws(()=>cleanDraft({...draft,mode:'family'},owner),/not enabled/);
 assert.equal(parseUtcInput('2026-02-30T00:00'),null);assert.equal(parseUtcInput('2026-09-24T24:30'),null);assert.ok(parseUtcInput('2028-02-29T00:00'));
 registry.close();
});
test('new action paths obey financial startup gate while read/recovery remains available; production stays off',async()=>{
 assert.ok(FINANCIAL_WRITE_PATHS.test('/api/account/launches/prepare'));assert.ok(FINANCIAL_WRITE_PATHS.test('/api/account/launches/submit'));assert.equal(FINANCIAL_WRITE_PATHS.test('/api/account/launches/status'),false);
 assert.equal((await publicServices()).account,null);
 const registry=openRegistry();registry.migrate();const service=await publicServices({registryImport:{configured:true,registry},env:{KIDS_NETWORK:'mainnet',KIDS_PUBLIC_PILOT_WALLET:addr(4),KIDS_PUBLIC_WALLET_ACTIONS:'1',KIDS_PUBLIC_PROGRAM_ID:addr(2)}});
 assert.equal(service.manifest().capabilities.commit,false);assert.equal((await service.account.handle({method:'POST',path:'/api/account/launches/prepare',owner:addr(4),input:{}})).status,503);registry.close();
});
