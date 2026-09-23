import test from 'node:test';import assert from 'node:assert/strict';
import {exactUnits,formatUnits,compactUnits,formatSolAmount,activityLabel} from '../src/flywheel-format.mjs';
test('burn counters are raw 6-decimal units, not whole coins',()=>{
 assert.equal(exactUnits('763999619760',6),'763999.61976');
 assert.equal(formatUnits('763999619760',6),'763,999.61');
 assert.equal(formatUnits('123456789',6),'123.45');
 assert.equal(formatUnits('5000000',6),'5');
 assert.equal(formatUnits(null,6),'—');assert.equal(formatUnits('abc',6),'—');assert.equal(formatUnits('-5',6),'—');
});
test('tile figures are compact with the exact value beside them',()=>{
 assert.deepEqual(compactUnits('763999619760',6,'coins'),{text:'764K',exact:'763,999.61976 coins'});
 assert.deepEqual(compactUnits('18823456789012',6,'burned'),{text:'18.82M',exact:'18,823,456.789012 burned'});
 assert.deepEqual(compactUnits('493827156',9,'SOL'),{text:'0.4938',exact:'0.493827156 SOL'});
 assert.deepEqual(compactUnits('1234567890123',9,'SOL'),{text:'1.23K',exact:'1,234.567890123 SOL'});
 assert.deepEqual(compactUnits(undefined,6),{text:'—',exact:null});
});
test('history SOL amounts never round a real amount to zero and never invent one',()=>{
 assert.deepEqual(formatSolAmount('50000'),{text:'<0.0001 SOL',exact:'0.00005 SOL'});
 assert.deepEqual(formatSolAmount('1'),{text:'<0.0001 SOL',exact:'0.000000001 SOL'});
 assert.deepEqual(formatSolAmount('123456789'),{text:'0.1234 SOL',exact:'0.123456789 SOL'});
 assert.deepEqual(formatSolAmount('2500000000'),{text:'2.5 SOL',exact:'2.5 SOL'});
 assert.deepEqual(formatSolAmount('0'),{text:'0 SOL',exact:'0 SOL'});
 assert.deepEqual(formatSolAmount(null),{text:'—',exact:null});assert.deepEqual(formatSolAmount('x'),{text:'—',exact:null});
});
test('activity label says what the window shows',()=>{
 assert.equal(activityLabel(0,8),'None yet');assert.equal(activityLabel(3,8),'Recent activity · showing 3');assert.equal(activityLabel(22,8),'Recent activity · showing 8');
});
