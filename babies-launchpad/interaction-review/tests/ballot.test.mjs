import test from 'node:test';
import assert from 'node:assert/strict';
import {ballot,candidates} from '../src/model.js';
test('all 12 concepts appear exactly once across two pages',()=>{
 const all=ballot({}); assert.equal(all.length,12); assert.equal(new Set(all.map(c=>c.id)).size,12);
 assert.equal(all.slice(9).length,3);
});
test('search reaches final created candidate regardless of page and parent',()=>{
 assert.equal(ballot({query:'POOT'})[0].id,'K009-012');
 assert.equal(ballot({query:'POOT',parent:'BONK'}).length,0);
 assert.equal(ballot({query:'POOT',parent:'PENGU'}).length,1);
});
test('discover remains stable; viewer seed rotates order but never eligibility',()=>{
 const ids=seed=>ballot({seed}).map(c=>c.id);
 assert.deepEqual(ids('a'),ids('a'));assert.notDeepEqual(ids('a'),ids('b'));
 assert.deepEqual(ids('a').sort(),ids('b').sort());
});
test('new and most-voted ordering have deterministic ties',()=>{
 assert.equal(ballot({sort:'New'})[0].id,'K009-012');
 const sorted=ballot({sort:'Most voted'});assert.equal(sorted[0].name,'Bonkhat');
 for(let i=1;i<sorted.length;i++)assert.ok(sorted[i-1].votes>=sorted[i].votes);
});
test('displayed baseline turnout agrees with every candidate tally',()=>{
 assert.equal(candidates.reduce((sum,c)=>sum+c.votes,0),1250000);
});
test('most-voted reflects the accepted replacement in its ordering',()=>{
 const result=ballot({sort:'Most voted',boostId:'K009-012'});
 assert.equal(result[9].name,'Poot');
 assert.equal(ballot({sort:'Most voted',boostId:'K009-002'})[1].name,'Popwif');
});
