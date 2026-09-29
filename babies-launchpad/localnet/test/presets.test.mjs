// Presets manifest gates: the canonical hash is stable under key order and whitespace, moves on any value, the shipped
// file is consistent and pinned, nothing is activated.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readPresets,presetsHash,validatePresets,activatedPresets,presetTerms,canonicalJson,canonicalHash,PRESETS_PATH} from '../registry/presets.mjs';
const reorder=v=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).reverse().map(k=>[k,reorder(v[k])])):v;
test('v1 manifest cannot silently drop a future liquidity policy or activate it',()=>{
 for(const target of ['manifest','agreed','liquidity','standard','preset']){
  const m=readPresets();const o={manifest:m,agreed:m.agreed,liquidity:m.agreed.liquidity,standard:m.modes.standard,preset:m.capPresets[0]}[target];
  o.liquidityPolicy={kind:'standard-bounded-recycling-v1'};
  assert.ok(validatePresets(m).some(x=>x.startsWith('liquidityPolicy')));
  assert.throws(()=>presetTerms(m,{mode:'standard',capPresetId:'default'}),/new manifest/);
  m.status='active';m.activation={};m.capPresets[0].status='active';m.capPresets[0].activation={};
  assert.deepEqual(activatedPresets(m),[]);
 }
 assert.throws(()=>presetTerms(readPresets(),{mode:'standard',capPresetId:'default',liquidityPolicy:null}),/new manifest/);
});
test('canonical JSON sorts keys, keeps array order, prints integers plainly and refuses undefined or NaN',()=>{
 assert.equal(canonicalJson({b:1,a:[3,{z:true,y:null}],c:'x'}),'{"a":[3,{"y":null,"z":true}],"b":1,"c":"x"}');
 assert.equal(canonicalJson({a:undefined,b:2}),'{"b":2}');assert.equal(canonicalJson(10n),'"10"');assert.equal(canonicalJson(1.5),'1.5');
 assert.throws(()=>canonicalJson({a:NaN}),/non-finite/);assert.throws(()=>canonicalJson([undefined]),/undefined/);assert.throws(()=>canonicalJson(new Date()),/plain objects/);
});
test('the hash is stable across key order and file whitespace and changes on any value',()=>{
 const m=readPresets();const h=presetsHash(m);
 assert.equal(presetsHash(reorder(m)),h);assert.equal(presetsHash(JSON.parse(JSON.stringify(m,null,8))),h);
 assert.equal(canonicalHash(JSON.parse(readFileSync(PRESETS_PATH,'utf8'))),h);
 const changed=JSON.parse(JSON.stringify(m));changed.capPresets[0].hardCapLamports='100000000001';assert.notEqual(presetsHash(changed),h);
 const activated=JSON.parse(JSON.stringify(m));activated.activation={date:'2026-10-01'};assert.notEqual(presetsHash(activated),h);
});
test('the shipped manifest is consistent, proposed only and pinned by hash',()=>{
 const m=readPresets();
 assert.deepEqual(validatePresets(m),[]);assert.equal(m.status,'proposed');assert.equal(m.activation,null);assert.deepEqual(activatedPresets(m),[]);
 assert.equal(presetsHash(m),'7dfbc3053f167597b32d4866fda4eba2ef5c1623959d2db2fdeed31c34c6b1c4','the pinned hash moves only with an intentional edit of the manifest');
 assert.deepEqual(m.modes.standard.supplySplitBps,{participants:4750,liquidity:4750,dev:500});assert.deepEqual(m.agreed.devSupply.bps,500);assert.equal(m.agreed.devSupply.immediateBps,150);assert.equal(m.agreed.devSupply.linearBps,350);assert.equal(m.policyVersion,'public-presets-v2');assert.equal(m.agreed.funding.minimumCommitmentLamports,'50000000');assert.deepEqual(m.modes.family.solFeeRouting,{denominator:168,treasury:98,dev:20,parentA:25,parentB:25});
 assert.deepEqual(m.capPresets.map(p=>[p.id,p.softCapLamports,p.hardCapLamports,!!p.pilotOnly]),[['default','50000000000','100000000000',false],['large','100000000000','250000000000',false],['pilot','1000000000','5000000000',true]]);
 assert.throws(()=>presetTerms(m,{mode:'standard',capPresetId:'pilot'}),/only in the wallet-restricted pilot/);assert.equal(presetTerms(m,{mode:'standard',capPresetId:'pilot',pilot:true}).terms.hardCapLamports,'5000000000');
 const pilotBroken=JSON.parse(JSON.stringify(m));pilotBroken.capPresets[2].advanced=false;assert.ok(validatePresets(pilotBroken).some(x=>x.startsWith('cap preset pilot: pilotOnly')));
 assert.deepEqual([m.agreed.operating.status,m.agreed.operating.reserveLamports,m.agreed.operating.floorLamports,m.agreed.operating.refillBps,m.agreed.operating.returnUnusedOnRefund],['proposed','100000000','20000000',1000,true]);
});
test('validation catches split, routing, cap, status and activation mistakes',()=>{
 const m=readPresets();const broken=JSON.parse(JSON.stringify(m));
 broken.modes.standard.supplySplitBps.dev=501;broken.modes.family.solFeeRouting.dev=21;broken.capPresets[0].softCapLamports='200000000000';broken.capPresets[1].status='active';broken.schedule.activation={x:1};broken.platformCreationCharge.lamports='free';broken.agreed.operating.floorLamports='200000000';broken.agreed.operating.refillBps=10001;
 const problems=validatePresets(broken);
 for(const p of ['mode standard: supply split','mode family: fee routing','cap preset default: soft cap','cap preset large: active without','schedule: activation record','platformCreationCharge: lamports','operating: the reserve','operating: refillBps'])assert.ok(problems.some(x=>x.startsWith(p)),p+' reported: '+problems.join('; '));
});
test('preset terms seal one mode with one cap preset and hash deterministically; nothing is active',()=>{
 const m=readPresets();
 const a=presetTerms(m,{mode:'standard',capPresetId:'default'}),b=presetTerms(reorder(m),{mode:'standard',capPresetId:'default'});
 assert.equal(a.termsHash,b.termsHash);assert.equal(a.status,'proposed');assert.equal(a.terms.parents,0);assert.equal(a.terms.softCapLamports,'50000000000');assert.equal(a.terms.feePolicy.tradeFeeBps,250);assert.deepEqual(a.terms.operating,{reserveLamports:'100000000',floorLamports:'20000000',refillBps:1000,returnUnusedOnRefund:true});
 assert.notEqual(presetTerms(m,{mode:'family',capPresetId:'default'}).termsHash,a.termsHash);
 assert.throws(()=>presetTerms(m,{mode:'other',capPresetId:'default'}),/Unknown mode/);assert.throws(()=>presetTerms(m,{mode:'standard',capPresetId:'huge'}),/Unknown cap preset/);
});
