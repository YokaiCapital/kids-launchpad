// Version-2 (funding-first) readiness: the program's `ready_v2` rule in JavaScript, next to the per-receipt rule.
import test from 'node:test';import assert from 'node:assert/strict';
import {launchReadyV2,launchReady,PHASE_FUNDING,PHASE_CLOSED,PHASE_LIVE,PHASE_REFUND_ONLY} from './policy.mjs';
test('funding-first readiness: inside the launch window, not live, funded to the soft cap, no per-receipt condition',()=>{
 const r={phase:PHASE_FUNDING,deadline:'1000',launchDeadline:'1600',soft:'6553500',total:'20000000',receiptCount:'1',settledCount:'0',settledAccepted:'0'};
 assert.equal(launchReadyV2(r,'1000'),true,'at the deadline');assert.equal(launchReadyV2(r,'1599'),true,'just inside the window');
 assert.equal(launchReadyV2(r,'999'),false,'funding still open');assert.equal(launchReadyV2(r,'1600'),false,'window closed');
 assert.equal(launchReadyV2({...r,phase:PHASE_CLOSED},'1000'),true,'closed round launches');assert.equal(launchReadyV2({...r,phase:PHASE_LIVE},'1000'),false);assert.equal(launchReadyV2({...r,phase:PHASE_REFUND_ONLY},'1000'),false);
 assert.equal(launchReadyV2({...r,total:'6553499'},'1000'),false,'under the soft cap');assert.equal(launchReadyV2({...r,total:'6553500'},'1000'),true,'exactly the soft cap');
 assert.equal(launchReady(r,'1000'),false,'the per-receipt rule still needs every receipt settled');
});
