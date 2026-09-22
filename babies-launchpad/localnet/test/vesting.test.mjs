import test from 'node:test';
import assert from 'node:assert/strict';
import {devPlan,threeMonthsAfter,scheduleBytes,unlockedRaw} from '../vesting-plan.mjs';
const ts=s=>Date.parse(s)/1000;
test('calendar month end and leap year boundaries',()=>{
 assert.equal(threeMonthsAfter(ts('2026-01-31T12:00:00Z')),ts('2026-04-30T12:00:00Z'));
 assert.equal(threeMonthsAfter(ts('2023-11-30T12:00:00Z')),ts('2024-02-29T12:00:00Z'));
});
test('one percent unlock and two percent linear are fractions of total supply',()=>{
 const p=devPlan(1000000000000000n,ts('2026-09-20T00:00:00Z'));
 assert.equal(p.immediateRaw,'10000000000000');assert.equal(p.linearRaw,'20000000000000');
 assert.equal(unlockedRaw('launch',p.immediateRaw,p.start,p.end,p.start-1),0n);
 assert.equal(unlockedRaw('launch',p.immediateRaw,p.start,p.end,p.start),10000000000000n);
 assert.equal(unlockedRaw('linear',p.linearRaw,p.start,p.end,p.start),0n);
 assert.equal(unlockedRaw('linear',p.linearRaw,p.start,p.end,(p.start+p.end)/2),10000000000000n);
 assert.equal(unlockedRaw('linear',p.linearRaw,p.start,p.end,p.end+1),20000000000000n);
 assert.equal(scheduleBytes('launch',p.start,p.end)[0],2);
 assert.equal(scheduleBytes('linear',p.start,p.end).length,17);
});
