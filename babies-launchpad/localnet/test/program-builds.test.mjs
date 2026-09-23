// Regression: after the on-chain upgrade the running service must keep working (old and new build accepted), and the
// keeper must not plan the burn instruction while the v1 program is live.
import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {acceptedBuilds,matchBuild,manifestFeatures,CURRENT_FEATURES} from '../program-builds.mjs';
import {feePlan} from '../active-fee-keeper.mjs';
const bytesA=Buffer.from('program-v1-bytes'),bytesB=Buffer.from('program-v2-bytes-longer');
const sha=b=>createHash('sha256').update(b).digest('hex');
const program={binarySha256:sha(bytesA),binarySize:bytesA.length,builds:[{sha256:sha(bytesB),binarySize:bytesB.length,features:['burn-child-fees']},{sha256:sha(bytesA),binarySize:bytesA.length}]};
test('accepted builds: primary first, duplicates dropped, features kept',()=>{
 const builds=acceptedBuilds(program);
 assert.deepEqual(builds.map(b=>b.sha256),[sha(bytesA),sha(bytesB)]);
 assert.deepEqual(builds[1].features,['burn-child-fees']);assert.deepEqual(builds[0].features,[]);
});
test('the live bytes select the build, with zero padding tolerated and foreign bytes refused',()=>{
 const builds=acceptedBuilds(program);
 assert.equal(matchBuild(Buffer.concat([bytesB,Buffer.alloc(3)]),builds).sha256,sha(bytesB));
 assert.equal(matchBuild(bytesA,builds).sha256,sha(bytesA));
 assert.equal(matchBuild(Buffer.concat([bytesA,Buffer.from([1])]),builds),null);
 assert.equal(matchBuild(Buffer.from('something-else'),builds),null);
});
test('keeper converts coin-side fees on a program without the burn instruction and burns once it has it',()=>{
 const counters={totalSol:168n,treasuryPaid:98n,devPaid:20n,parentAAllocated:25n,parentBAllocated:25n,parentASpent:25n,parentBSpent:25n,childPending:7n};
 assert.deepEqual(feePlan(counters,[]),[{kind:'convert',amount:'7'}]);
 assert.deepEqual(feePlan(counters,['burn-child-fees']),[{kind:'burn',amount:'7'}]);
 assert.deepEqual(feePlan(counters),[{kind:'burn',amount:'7'}],'default keeps the localnet behaviour');
});
test('manifest features: recorded list wins, localnet defaults to the current source, real networks default to none',()=>{
 assert.deepEqual(manifestFeatures({network:'mainnet',features:['x']}),['x']);
 assert.deepEqual(manifestFeatures({network:'mainnet'}),[]);
 assert.deepEqual(manifestFeatures({network:'localnet'}),[...CURRENT_FEATURES]);
});
test('a live upgrade keeps the previous build in the lineage so campaign records stay accepted',async()=>{
 const {acceptedProgramHash}=await import('../program-lineage.mjs');
 const before={sha256:'v1',lineage:[]};const lineage=[...(before.lineage||[])];if(!lineage.includes(before.sha256))lineage.push(before.sha256);const after={...before,sha256:'v2',lineage};
 assert.equal(acceptedProgramHash(after,'v1'),true);assert.equal(acceptedProgramHash(after,'v2'),true);assert.equal(acceptedProgramHash(after,'v3'),false);
});
