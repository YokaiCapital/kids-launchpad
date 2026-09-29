import test from 'node:test';import assert from 'node:assert/strict';import {fleetClosingMetrics} from './fleet-metrics.mjs';
const close=1790000000000,iso=x=>new Date(close+x).toISOString(),start=(id,at,due,kind='launch')=>({event:'job-started',jobId:id,jobClass:kind,leasedAt:iso(at),dueAt:iso(due)});
test('pre-close polls and repeated fast jobs cannot hide the first closing backlog',()=>{
 const events=Array.from({length:1000},(_,i)=>start('poll',-1000-i,-1100-i));
 events.push(start('slow',30000,0),start('fast',10,-60000),...Array.from({length:100},(_,i)=>start('fast',30010+i,30000+i)),start('refund',500,100,'refunds'));
 const r=fleetClosingMetrics(events,{closeObservedAt:iso(0),freshClose:true});assert.equal(r.kind,'observed-fresh-close');assert.equal(r.byClass.launch.firstStartPerJob.samples,2);assert.equal(r.byClass.launch.firstStartPerJob.p95Ms,30000);assert.equal(r.byClass.refunds.firstStartPerJob.p95Ms,400);assert.equal(r.byClass.launch.allStarts.samples,102);
});
test('recovery results are explicit and never classified as a fresh close',()=>{
 assert.equal(fleetClosingMetrics([start('a',10,0)],{closeObservedAt:iso(0),freshClose:false}).kind,'recovery-after-close');
 assert.throws(()=>fleetClosingMetrics([],{closeObservedAt:'invalid',freshClose:true}));assert.throws(()=>fleetClosingMetrics([],{closeObservedAt:iso(0)}));
});
