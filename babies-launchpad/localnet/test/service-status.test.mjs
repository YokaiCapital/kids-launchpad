import test from 'node:test';import assert from 'node:assert/strict';import {evaluateStatus,runKeeper,statusSnapshot,setSignerStatus,setReconciliation} from '../../shared/service-status.mjs';
test('the monitor flags stale keepers, closed writes, unresolved intents, unreachable signer and low disk; a healthy service passes',async()=>{
 await runKeeper('active',async()=>({status:'open'}));await runKeeper('fees',async()=>({status:'idle'}));setSignerStatus({configured:true,ok:true,checkedAt:Date.now()});setReconciliation({complete:true,unresolvedSigned:0,at:'x',services:[]},true);
 const snap=statusSnapshot({ready:true,runtimePath:process.cwd()});assert.deepEqual(evaluateStatus(snap),[]);
 assert.deepEqual(evaluateStatus({...snap,status:'unavailable'}),['service not ready']);
 assert.deepEqual(evaluateStatus({...snap,writesOpen:false}),['financial writes closed']);
 assert.deepEqual(evaluateStatus({...snap,reconciliation:{unresolvedSigned:2}}),['unresolved signed intents: 2']);
 assert.deepEqual(evaluateStatus({...snap,keepers:{...snap.keepers,active:{...snap.keepers.active,ageSeconds:1200}}}),['keeper active stale: 1200 s']);
 assert.deepEqual(evaluateStatus({...snap,signer:{configured:true,ok:false}}),['signer unreachable']);
 assert.deepEqual(evaluateStatus({...snap,disk:{freePercent:3}}),['disk free 3%']);
 assert.deepEqual(evaluateStatus({...snap,keepers:{}},{campaignConfigured:false}),[]);
 await assert.rejects(runKeeper('fees',async()=>{throw Error('boom api-key=SECRET');}));const again=statusSnapshot({ready:true});assert.equal(again.keepers.fees.status,'error');assert.ok(!again.keepers.fees.error.includes('SECRET'));
});
