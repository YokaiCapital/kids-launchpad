import test from 'node:test';import assert from 'node:assert/strict';import {checkReadiness,TARGETS} from '../../deployment/health-check.mjs';
const healthy={status:'ready',writesOpen:true,reconciliation:{complete:true,unresolvedSigned:0},keepers:{active:{ageSeconds:20,status:'open'},fees:{ageSeconds:40,status:'idle'}},signer:{configured:true,ok:true},disk:{freePercent:60}};
const fetchFor=(statusBody,siteStatus=200)=>async(url,options)=>{
 if(url==='https://kids.fun/')return {status:siteStatus,text:async()=>'<title>KIDS · Private access</title>'};
 assert.equal(options.redirect,'error');assert.ok(options.signal);assert.equal(options.headers.authorization,undefined);
 if(url.endsWith('/healthz'))return {status:200,json:async()=>({status:'alive'})};if(url.endsWith('/readyz'))return {status:200,json:async()=>({status:'ready'})};
 if(url.endsWith('/statusz'))return {status:200,json:async()=>statusBody};throw Error('unexpected '+url);
};
test('monitor checks liveness, readiness, the status thresholds of every target and the kids.fun gate without credentials',async()=>{
 const result=await checkReadiness({fetchImpl:fetchFor(healthy)});assert.equal(result.status,'ready');assert.equal(result.results.length,TARGETS.length+1);assert.ok(TARGETS[0].required&&TARGETS[0].name==='mainnet-api');
});
test('monitor fails on a stale keeper, closed writes or a broken site; the optional test ledger only warns',async()=>{
 await assert.rejects(checkReadiness({fetchImpl:fetchFor({...healthy,keepers:{...healthy.keepers,fees:{ageSeconds:9999,status:'idle'}}})}),/keeper fees stale/);
 await assert.rejects(checkReadiness({fetchImpl:fetchFor({...healthy,writesOpen:false})}),/financial writes closed/);
 await assert.rejects(checkReadiness({fetchImpl:fetchFor(healthy,500)}),/kids.fun returned HTTP 500/);
 const onlyTestBroken=async(url,options)=>url.includes('kids-private-localnet')?{status:503,json:async()=>({})}:fetchFor(healthy)(url,options);
 const r=await checkReadiness({fetchImpl:onlyTestBroken});assert.equal(r.status,'ready');assert.ok(r.results.some(x=>x.name==='test-ledger'&&x.status==='warning'));
});
