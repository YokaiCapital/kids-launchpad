import test from 'node:test';import assert from 'node:assert/strict';
import {evaluateStatus} from '../../shared/service-status.mjs';
import {readinessTargets,TARGETS,checkTarget} from '../../deployment/health-check.mjs';
test('status evaluation: public-launch alerts and an unavailable observation are problems; a clean observation is not',()=>{
 const base={status:'ready',writesOpen:true,keepers:{}};
 assert.deepEqual(evaluateStatus({...base,publicLaunch:{status:'observed',alerts:[]}},{campaignConfigured:false}),[]);
 assert.deepEqual(evaluateStatus({...base,publicLaunch:{status:'degraded',alerts:[{code:'worker-missing',lane:'lifecycle'},{code:'low-operating-reserve',lane:'accounting'},{code:'worker-missing',lane:'lifecycle'}]}},{campaignConfigured:false}),['public-launch alerts: low-operating-reserve@accounting, worker-missing@lifecycle']);
 assert.deepEqual(evaluateStatus({...base,publicLaunch:{status:'unavailable',alerts:null}},{campaignConfigured:false}),['public-launch observation unavailable']);
 assert.deepEqual(evaluateStatus(base,{campaignConfigured:false}),[],'services without the observer are unchanged');
});
test('readiness targets: the pilot API joins the monitor only through an https origin',async()=>{
 assert.deepEqual(readinessTargets({}),TARGETS);
 const list=readinessTargets({KIDS_PILOT_API_BASE:'https://pilot.example.up.railway.app/'});
 assert.deepEqual(list.at(-1),{name:'pilot-api',base:'https://pilot.example.up.railway.app',required:true,signerRequired:false});
 assert.throws(()=>readinessTargets({KIDS_PILOT_API_BASE:'http://pilot.example'}),/https/);
 assert.throws(()=>readinessTargets({KIDS_PILOT_API_BASE:'https://pilot.example/path'}),/https/);
 const answers={'/healthz':{status:'alive'},'/readyz':{status:'ready'},'/statusz':{status:'ready',writesOpen:true,keepers:{},publicLaunch:{status:'degraded',alerts:[{code:'unscheduled-funded-campaign',lane:'lifecycle'}]}}};
 const fetchImpl=async(url)=>({status:200,json:async()=>answers[new URL(url).pathname]});
 await assert.rejects(checkTarget(list.at(-1),{fetchImpl}),/public-launch alerts: unscheduled-funded-campaign@lifecycle/);
 answers['/statusz'].publicLaunch={status:'observed',alerts:[]};
 assert.equal((await checkTarget(list.at(-1),{fetchImpl})).status,'ready');
});
import {publicStatusBody} from '../../shared/service-status.mjs';
test('public status body keeps what the monitor evaluates and drops paths, error text and keys',()=>{
 const full={status:'ready',at:'T',writesOpen:true,reconciliation:{complete:true,unresolvedSigned:0,expiredUnverified:1,at:'T',services:[{service:'escrow'}]},keepers:{fees:{lastAt:1,ms:2,status:'error',error:'ECONNREFUSED 10.0.0.1',ageSeconds:9}},signer:{configured:true,ok:false,checkedAt:1,publicKey:'K',ageSeconds:2},disk:{path:'/data/localnet',totalBytes:1,freeBytes:1,freePercent:3},market:{enabled:true,running:true,connected:true,decodeFailures:2,decodeFailuresGrowing:true,warnings:[]},registry:{configured:true,driver:'postgres',campaigns:2,lastError:{category:'query',message:'relation x',at:'T'}},campaign:{configured:true,phase:3,campaign:'C',escrow:'E'},publicLaunch:{status:'degraded',alerts:[{code:'failed-work',lane:'harvest'}]}};
 const body=publicStatusBody(full);
 assert.deepEqual(body.disk,{freePercent:3});assert.deepEqual(body.keepers.fees,{status:'error',ageSeconds:9,ms:2});assert.deepEqual(body.signer,{configured:true,ok:false,ageSeconds:2});
 assert.deepEqual(body.registry.lastError,{category:'query',at:'T'});assert.equal('services' in body.reconciliation,false);assert.deepEqual(body.campaign,{configured:true,phase:3,campaign:'C'});
 const problems=evaluateStatus(body,{campaignConfigured:true});
 for(const expected of ['keeper active has never run','keeper fees error','signer unreachable','disk free 3%','market decode failures growing: 2','public-launch alerts: failed-work@harvest'])assert.ok(problems.some(p=>p.startsWith(expected)),expected+' in '+JSON.stringify(problems));
 assert.ok(!JSON.stringify(problems).includes('10.0.0.1'),'the trimmed body carries no error text for the monitor to echo');
});
