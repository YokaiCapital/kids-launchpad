// Hash route parsing: a coin link round-trips, and a malformed escape gives null (the not-found state) instead of throwing.
import test from 'node:test';import assert from 'node:assert/strict';
import {coinHref,subFromHash} from '../src/public/routes.mjs';
test('coin links round-trip and a malformed escape is null, never a thrown URIError',()=>{
 const id='FixtureCampaignA1111111111111111111111111111';
 assert.equal(coinHref(id),'#coin/'+id);assert.equal(subFromHash(coinHref(id)),id);
 assert.equal(subFromHash(coinHref('a b/c')),'a b/c');
 assert.equal(subFromHash('#explore'),null);assert.equal(subFromHash(''),null);assert.equal(subFromHash(null),null);assert.equal(subFromHash('#coin/'),null);
 for(const bad of ['#coin/%E0','#coin/%','#coin/%ZZ','#coin/abc%'])assert.doesNotThrow(()=>subFromHash(bad),bad),assert.equal(subFromHash(bad),null,bad);
});
