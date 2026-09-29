import test from 'node:test';import assert from 'node:assert/strict';import {validateActivity,readCampaignActivity} from '../src/public/campaign-activity.mjs';
const campaign='3'.repeat(32),mint='4'.repeat(32),vm={identity:{campaign,genesisHash:'genesis',programId:'program'},chain:{mint},terms:{supply:{decimals:6}}};
const event={campaign,signature:'2'.repeat(88),instructionPath:'0',slot:1,blockTimeUnix:100,decoderVersion:3,program:'launch',kind:'burn-child',actor:null,assets:[{mint,amountRaw:'1',decimals:6,direction:'burn',role:null,account:null}],failed:false,nested:false,commitment:'finalized'};
const data=()=>({...vm.identity,mint,coinDecimals:6,available:true,commitment:'finalized',filter:'movements',events:[event],nextCursor:null,status:'live',freshness:{updatedAt:100000,stale:false},coverage:{complete:true}});
test('activity rejects foreign identity, guessed movements, non-finalized and malformed events',()=>{
 assert.equal(validateActivity(data(),vm,'movements').events[0].assets[0].amountRaw,'1');
 for(const patch of [{campaign:'other'},{mint:'other'},{commitment:'confirmed'},{filter:'all'},{events:[{...event,failed:true}]},{events:[{...event,assets:[]}]},{events:[{...event,slot:null}]}])assert.throws(()=>validateActivity({...data(),...patch},vm,'movements'));
 assert.equal(validateActivity({...data(),filter:'all',events:[{...event,assets:[],kind:'settle'}]},vm,'all').events.length,1);
});
test('activity reads authenticate the current wallet and never use browser RPC',async()=>{
 const calls=[],api=async(p,b,csrf)=>{calls.push({p,b,csrf});return p==='state'?{owner:'owner',csrf:'csrf'}:data();};
 await readCampaignActivity({api,vm,owner:'owner'});assert.equal(calls[1].p,'launches/activity/read');assert.equal(calls[1].b.limit,8);assert.equal(calls[1].csrf,'csrf');
 await assert.rejects(readCampaignActivity({api,vm,owner:'other'}),/Wallet changed/);assert.equal(calls.length,3);
});
