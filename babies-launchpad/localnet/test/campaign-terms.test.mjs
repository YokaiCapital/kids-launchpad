import test from 'node:test';import assert from 'node:assert/strict';
import {activeCampaignTerms} from '../provision-active-launch.mjs';
import {validCampaignTerms} from '../active-launch.mjs';
test('default terms are the production terms',()=>{assert.deepEqual(activeCampaignTerms({}),{soft:'100000000000',hard:'500000000000',supply:'1000000000000000',deadlineSeconds:86400});});
test('test terms come from the environment with integer lamport maths',()=>{
 assert.deepEqual(activeCampaignTerms({KIDS_ACTIVE_SOFT_CAP_SOL:'1',KIDS_ACTIVE_HARD_CAP_SOL:'5',KIDS_ACTIVE_DEADLINE_SECONDS:'300'}),{soft:'1000000000',hard:'5000000000',supply:'1000000000000000',deadlineSeconds:300});
 assert.equal(activeCampaignTerms({KIDS_ACTIVE_SOFT_CAP_SOL:'0.5'}).soft,'500000000');assert.equal(activeCampaignTerms({KIDS_ACTIVE_SOFT_CAP_SOL:'0.000000001'}).soft,'1');
});
test('invalid terms refuse instead of falling back',()=>{
 for(const env of [{KIDS_ACTIVE_SOFT_CAP_SOL:'0'},{KIDS_ACTIVE_SOFT_CAP_SOL:'6',KIDS_ACTIVE_HARD_CAP_SOL:'5'},{KIDS_ACTIVE_HARD_CAP_SOL:'1001'},{KIDS_ACTIVE_SOFT_CAP_SOL:'1e2'},{KIDS_ACTIVE_SOFT_CAP_SOL:'-1'},{KIDS_ACTIVE_DEADLINE_SECONDS:'59'},{KIDS_ACTIVE_DEADLINE_SECONDS:'604801'},{KIDS_ACTIVE_DEADLINE_SECONDS:'300.5'}])assert.throws(()=>activeCampaignTerms(env),Error,JSON.stringify(env));
});
test('manifest term bounds: positive soft, soft ≤ hard ≤ 1,000 SOL, fixed supply and 24 h launch window',()=>{
 const base={soft:'1000000000',hard:'5000000000',supply:'1000000000000000',deadline:100,launchDeadline:86500};
 assert.equal(validCampaignTerms(base),true);
 for(const change of [{soft:'0'},{soft:'6000000000'},{hard:'1000000000001'},{supply:'1'},{launchDeadline:86499},{soft:'x'}])assert.equal(validCampaignTerms({...base,...change}),false,JSON.stringify(change));
});
