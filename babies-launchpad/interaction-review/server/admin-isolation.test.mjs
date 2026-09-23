import test from 'node:test';import assert from 'node:assert/strict';
import {adminPluginAllowed} from './runtime.mjs';
test('admin plugin is local-only: any hosted runtime or a real network omits it',()=>{
 assert.equal(adminPluginAllowed({}),true);
 assert.equal(adminPluginAllowed({KIDS_NETWORK:'localnet'}),true);
 assert.equal(adminPluginAllowed({RAILWAY_ENVIRONMENT:'production'}),false);
 assert.equal(adminPluginAllowed({RAILWAY_SERVICE_ID:'x',KIDS_NETWORK:'localnet'}),false,'the cloud test ledger is localnet but hosted');
 assert.equal(adminPluginAllowed({KIDS_NETWORK:'mainnet'}),false);
 assert.equal(adminPluginAllowed({KIDS_ADMIN_PLUGIN:'0'}),false);
 assert.equal(adminPluginAllowed({KIDS_CLOUD:'1'}),false);
});
