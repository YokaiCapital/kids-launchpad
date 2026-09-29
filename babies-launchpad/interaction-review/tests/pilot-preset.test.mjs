import test from 'node:test';import assert from 'node:assert/strict';
import {readPresets} from '../../localnet/registry/presets.mjs';
import {publicPresetManifest} from '../server/public-campaign-contract.mjs';
test('the pilot-only preset is served only to a wallet-restricted composition and only that preset is preselected for the pilot',()=>{
 const m=readPresets();
 const open=publicPresetManifest(m),pilot=publicPresetManifest(m,{pilot:true});
 assert.deepEqual(open.presets.map(p=>p.id),['default','large']);
 assert.equal(open.presets.some(p=>p.default),false);
 assert.deepEqual(pilot.presets.map(p=>[p.id,p.pilotOnly===true,p.default]),[['default',false,false],['large',false,false],['pilot',true,true]]);
 assert.deepEqual(pilot.presets[2],{id:'pilot',label:'Private pilot (1 to 5 SOL)',softLamports:'1000000000',hardLamports:'5000000000',default:true,pilotOnly:true});
});
