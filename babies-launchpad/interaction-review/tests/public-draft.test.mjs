import test from 'node:test';import assert from 'node:assert/strict';
import {LIMITS,STEPS,utf8Bytes,initialDraft,validateXUrl,validateHttpsUrl,validateCoin,validateProfile,validateTerms,parseUtcInput,canContinue,schedule,reviewModel,reduceDraft} from '../src/public/launch-draft.mjs';

const manifest={version:'presets-v1-proposed',status:'proposed',presets:[{id:'community',label:'Community launch',softLamports:'50000000000',hardLamports:'100000000000',default:true},{id:'larger',label:'Larger launch',softLamports:'100000000000',hardLamports:'250000000000'}],fundingSeconds:7200,launchWindowSeconds:7200,
 supply:{totalBaseUnits:'1000000000000000',decimals:6,standard:{participantsBps:4850,liquidityBps:4850,parentsBps:0,devBps:300},family:{participantsBps:4350,liquidityBps:4350,parentsBps:1000,devBps:300}},
 vesting:{immediateBps:100,vestedBps:200,months:3},fee:{totalBps:250,creatorFeeEnabled:false,tokenSide:'burn',solRouting:{standard:{treasury:148,dev:20,of:168}}},treasury:'Treasury111',
 costQuote:{validForSeconds:600,items:[{key:'budget',label:'Operational budget',lamports:'300000000',kind:'refundable'},{key:'creation',label:'Creation costs',lamports:'120000000',kind:'consumed'},{key:'platform',label:'Platform charge',lamports:'0',kind:'charge'}]}};
const parent=(mint,over={})=>({mint,name:'P'+mint,symbol:'P',verified:true,...over});

test('four steps, default preset, no leftover sample content',()=>{
 assert.deepEqual(STEPS.map(s=>s.title),['Coin','Profile','Terms','Review']);
 const d=initialDraft(manifest,{creator:'Creator1'});assert.equal(d.presetId,'community');assert.equal(d.name,'');assert.equal(d.mode,'standard');assert.equal(d.devBeneficiary,'Creator1');assert.equal(d.start,'after-creation');
});
test('name 32 bytes and symbol 10 bytes are UTF-8 byte limits, case preserved, no spaces in the ticker',()=>{
 assert.equal(utf8Bytes('Pebble'),6);assert.equal(utf8Bytes('ünï'),5);assert.equal(LIMITS.nameBytes,32);assert.equal(LIMITS.symbolBytes,10);
 assert.deepEqual(validateCoin({mode:'standard',name:'Pebble',symbol:'PEBL'}),{});
 assert.match(validateCoin({mode:'standard',name:'x'.repeat(33),symbol:'PEBL'}).name,/33 of 32 bytes/);
 assert.deepEqual(validateCoin({mode:'standard',name:'x'.repeat(32),symbol:'y'.repeat(10)}),{});
 assert.match(validateCoin({mode:'standard',name:'é'.repeat(17),symbol:'PEBL'}).name,/34 of 32 bytes/);
 assert.match(validateCoin({mode:'standard',name:'Pebble',symbol:'PE BL'}).symbol,/spaces/);
 assert.match(validateCoin({mode:'standard',name:'',symbol:''}).name,/name/);
});
test('family needs two distinct verified parents; unsupported combinations carry their reason',()=>{
 assert.match(validateCoin({mode:'family',name:'A',symbol:'A',parents:[null,null]}).parents,/two parent/);
 assert.match(validateCoin({mode:'family',name:'A',symbol:'A',parents:[parent('M1'),parent('M1')]}).parents,/different/);
 assert.match(validateCoin({mode:'family',name:'A',symbol:'A',parents:[parent('M1'),parent('M2',{verified:false})]}).parents,/verified/);
 assert.equal(validateCoin({mode:'family',name:'A',symbol:'A',parents:[parent('M1'),parent('M2',{unsupportedReason:'Token-2022 transfer hooks are not supported'})]}).parents,'Token-2022 transfer hooks are not supported');
 assert.deepEqual(validateCoin({mode:'family',name:'A',symbol:'A',parents:[parent('M1'),parent('M2')]}),{});
});
test('links: https only, X restricted to a profile path, no executable schemes',()=>{
 assert.equal(validateXUrl(''),null);assert.equal(validateXUrl('https://x.com/pebble'),null);assert.equal(validateXUrl('https://www.twitter.com/pebble/'),null);
 assert.match(validateXUrl('http://x.com/pebble'),/https/);assert.match(validateXUrl('javascript:alert(1)'),/https/);assert.match(validateXUrl('https://example.com/pebble'),/x\.com/);assert.match(validateXUrl('https://x.com/pebble/status/1'),/profile/);
 assert.equal(validateHttpsUrl('https://pebble.example'),null);assert.match(validateHttpsUrl('ftp://pebble.example'),/https/);assert.match(validateHttpsUrl('https://user:pw@pebble.example'),/website address/);assert.match(validateHttpsUrl('not a url'),/https/);
 const errors=validateProfile({description:'d'.repeat(281),xUrl:'https://x.com/ok',websiteUrl:'http://no',videoCaption:'c'.repeat(121),pfp:{error:'Image is 12 MB; the limit is 10 MB'}});
 assert.match(errors.description,/280/);assert.equal(errors.xUrl,undefined);assert.match(errors.websiteUrl,/https/);assert.match(errors.videoCaption,/120/);assert.match(errors.pfp,/10 MB/);
});
test('terms: preset must exist; a scheduled start is UTC and in the future; schedule derives close and launch deadline',()=>{
 const now=1790000000;
 assert.deepEqual(validateTerms({presetId:'community',start:'after-creation'},manifest,now),{});
 assert.match(validateTerms({presetId:'nope',start:'after-creation'},manifest,now).preset,/size/);
 assert.match(validateTerms({presetId:'community',start:'scheduled',startUtc:''},manifest,now).startUtc,/UTC/);
 assert.match(validateTerms({presetId:'community',start:'scheduled',startUtc:'2020-01-01T00:00'},manifest,now).startUtc,/future/);
 assert.equal(parseUtcInput('2026-09-24T16:00'),Date.UTC(2026,8,24,16,0)/1000);assert.equal(parseUtcInput('nope'),null);
 const s=schedule({start:'scheduled',startUtc:'2026-09-24T16:00'},manifest,now);assert.equal(s.startLabel,'24 Sep 2026, 16:00 UTC');assert.equal(s.closeUtc,'24 Sep 2026, 18:00 UTC');assert.equal(s.launchDeadlineUnix,s.deadlineUnix+7200);assert.equal(s.estimated,false);
 const n=schedule({start:'after-creation'},manifest,now);assert.equal(n.startLabel,'When creation confirms');assert.equal(n.estimated,true);assert.equal(n.deadlineUnix,now+7200);
});
test('step gating and reducer',()=>{
 const now=1790000000;let d=initialDraft(manifest,{creator:'C'});
 assert.equal(canContinue(d,manifest,now),false);
 d=reduceDraft(d,{type:'set',field:'name',value:'Pebble'});d=reduceDraft(d,{type:'set',field:'symbol',value:'PEBL'});assert.equal(canContinue(d,manifest,now),true);
 d=reduceDraft(d,{type:'next'});assert.equal(d.step,1);d=reduceDraft(d,{type:'back'});assert.equal(d.step,0);d=reduceDraft(d,{type:'back'});assert.equal(d.step,0);
 d=reduceDraft(d,{type:'mode',value:'family'});d=reduceDraft(d,{type:'parent',index:0,value:parent('M1')});assert.equal(canContinue(d,manifest,now),false);
 d=reduceDraft(d,{type:'mode',value:'standard'});assert.deepEqual(d.parents,[null,null]);
 d=reduceDraft(d,{type:'step',value:9});assert.equal(d.step,3);
});
test('review model: sealed terms, split by mode, itemised quote in three kinds, sealing sentence',()=>{
 const now=1790000000;const d={...initialDraft(manifest,{creator:'C'}),name:'Pebble',symbol:'PEBL',mode:'family',parents:[parent('M1'),parent('M2')]};
 const r=reviewModel(d,manifest,now);
 assert.equal(r.caps.soft.compact,'50');assert.equal(r.caps.hard.compact,'100');assert.deepEqual(r.supply.segments.map(s=>s.percent),['43.5%','43.5%','10%','3%']);
 assert.equal(r.fee.label,'Trading fee: 2.5% total · network fees extra');assert.equal(r.addresses.devBeneficiary,'C');assert.equal(r.addresses.treasury,'Treasury111');
 assert.equal(r.quote.refundable.compact,'0.3');assert.equal(r.quote.consumed.compact,'0.12');assert.equal(r.quote.charge.compact,'0');assert.equal(r.quote.total.compact,'0.42');assert.equal(r.quote.validForSeconds,600);
 assert.equal(r.sealingSentence,'Creating this launch fixes its financial terms, including its scheduled dates.');
 assert.equal(r.identity.parents.length,2);
 assert.equal(reviewModel({...d,presetId:null},manifest,now).caps,null);
});
