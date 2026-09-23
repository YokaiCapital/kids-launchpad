import test from 'node:test';import assert from 'node:assert/strict';import {denylistState} from '../../shared/denylist.mjs';
test('the journal is append-only: the last row per wallet wins, only active rows are enforced, today\'s additions are counted',()=>{
 const j={entries:[{wallet:'A',reason:'bundler',addedAt:'2026-09-22T10:00:00Z',addedBy:'owner'},{wallet:'B',reason:'vamp',addedAt:'2026-09-23T01:00:00Z'},{wallet:'A',status:'removed',addedAt:'2026-09-23T02:00:00Z',reason:'bundler'}]};
 const s=denylistState(j,new Date('2026-09-23T12:00:00Z'));
 assert.deepEqual([...s.active],['B']);assert.equal(s.counts.total,2);assert.equal(s.counts.active,1);assert.equal(s.counts.addedToday,2);
 assert.equal(s.wallets.find(w=>w.wallet==='A').status,'removed');assert.equal(s.wallets.find(w=>w.wallet==='A').history.length,2);
 assert.equal(s.enforcement.program,false);assert.deepEqual(denylistState(null).counts,{active:0,total:0,addedToday:0});
});
