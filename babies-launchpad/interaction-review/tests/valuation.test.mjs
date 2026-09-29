import {test} from 'node:test';
import assert from 'node:assert/strict';
import {claimValueCents,displayValue,parentStatsList,parentStatsFor,launchSupplyRaw,estimateSol,countText} from '../src/valuation.mjs';
test('one tenth percent at one million FDV is one thousand dollars',()=>{
 assert.equal(claimValueCents('1000000000000','1000000000000000','1000000'),100000n);
});
test('large quantities preserve precision and never overstate fractional cents',()=>{
 assert.equal(claimValueCents('9007199254740993','90071992547409930','100.01'),1000n);
 assert.equal(displayValue(claimValueCents('1','1000000000','1'),true),'<$0.01');
});
test('invalid or missing values cannot produce plausible estimates',()=>{
 for(const input of ['','-1','Infinity','1e6','1,000','1.001','0'])assert.equal(claimValueCents('1','10',input),null);
 assert.equal(claimValueCents('11','10','100'),null);
 assert.equal(claimValueCents('1','0','100'),null);
 assert.equal(claimValueCents(null,'10','100'),null);
 assert.equal(displayValue(claimValueCents('0','10','100')),'$0.00');
});
test('parent stats: served block or bare array, unknown is empty, lookup by index',()=>{
 const served={parentStats:{verifiedAt:'2026-09-23T00:00:00Z',parents:[{index:0,mint:'A'},{index:1,mint:'B'}]}};
 assert.deepEqual(parentStatsList(served).map(p=>p.mint),['A','B']);
 assert.deepEqual(parentStatsList({parentStats:[{index:1,mint:'B'}]}).map(p=>p.mint),['B']);
 assert.deepEqual(parentStatsList({parentStats:null}),[]);assert.deepEqual(parentStatsList(null),[]);assert.deepEqual(parentStatsList({parentStats:{parents:[null,'x']}}),[]);
 assert.equal(parentStatsFor(served,1).mint,'B');assert.equal(parentStatsFor(served,2),null);
});
test('FDV denominator is the launch supply (allocation × 20), current supply only as a labelled fallback',()=>{
 assert.deepEqual(launchSupplyRaw({allocationRaw:'50000000000000'},{supplyRaw:'999000000000000'}),{raw:'1000000000000000',source:'launch'});
 assert.deepEqual(launchSupplyRaw(null,{launchSupplyRaw:'7',supplyRaw:'5'}),{raw:'7',source:'launch'});
 assert.deepEqual(launchSupplyRaw({allocationRaw:'0'},{supplyRaw:'999000000000000'}),{raw:'999000000000000',source:'current'});
 assert.deepEqual(launchSupplyRaw(null,null),{raw:null,source:null});
});
test('SOL estimate at the last trade price: unknown price or amount is null, never 0',()=>{
 assert.equal(estimateSol('2000000000000',6,0.00000021),0.42);
 assert.equal(estimateSol('2000000000000',6,'0.0000005'),1);
 assert.equal(estimateSol('2000000000000',6,null),null);assert.equal(estimateSol('2000000000000',6,0),null);assert.equal(estimateSol('2000000000000',6,'—'),null);
 assert.equal(estimateSol(null,6,1),null);assert.equal(estimateSol('x',6,1),null);
});
test('counts read "unknown" when not served',()=>{
 assert.equal(countText(1834),'1,834');assert.equal(countText('12'),'12');assert.equal(countText(0),'0');
 assert.equal(countText(null),'unknown');assert.equal(countText(undefined),'unknown');assert.equal(countText('x'),'unknown');assert.equal(countText(-1),'unknown');
});
