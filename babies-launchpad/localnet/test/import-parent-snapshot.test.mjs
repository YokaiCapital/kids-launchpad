import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {buildCampaignSnapshot,readSnapshotEvidence} from '../import-parent-snapshot.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const campaign='FwSXhZFVUG4wD25cYsSV4mr7hfqHCoHSQzBxEg24bKnL',mintA='9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump',mintB='Cm6fNnMk7NfzStP9CZpsQA2v3jjzbcYGAxdJySmHpump';
const owners=['6EU5CHrLWCvQUZUsRQNPnsPRCs8VJexDeHypwnBgArzi','91eLwFTAxkcQLPSMxbzdSFkTyEwyRYcoZk64HMZj8vX','AAuwkFNvXRimHyvdQfh7Zik9baw8W2ufSbc5cyBqsdoE'];
function evidence(dir,mint,{supply='100000',counted=['600','300','100'],complete=true,eligibleTotal=null}={}){
 mkdirSync(join(dir,campaign),{recursive:true});const csv=['owner,countedBalance,originalBalance',...owners.map((o,i)=>o+','+counted[i]+','+counted[i]),''].join('\n');
 const total=counted.reduce((s,c)=>s+BigInt(c),0n);writeFileSync(join(dir,campaign,mint+'.allocation.csv'),csv);
 writeFileSync(join(dir,campaign,mint+'.json'),JSON.stringify({campaign,mint,complete,supply,slotAfter:123,tokenProgram:'spl-token',csvSha256:'x',allocation:{csvSha256:sha(csv),eligibleTotal:String(eligibleTotal??total),capBps:200}}));
}
test('evidence is imported into the same Merkle tree format as the fixture snapshot',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-snap-'));evidence(dir,mintA);evidence(dir,mintB,{counted:['500','300','200']});
 const s=buildCampaignSnapshot({directory:dir,campaign,network:'mainnet',genesisHash:'G',parents:[{mint:mintA,tokenProgram:'spl-token'},{mint:mintB,tokenProgram:'token-2022'}]});
 assert.equal(s.parents.length,2);assert.equal(s.slot,123);assert.equal(s.parents[0].balances.length,3);assert.ok(s.parents[0].root);assert.equal(s.parents[0].entries.length,3);assert.equal(s.parents[0].eligibleBalance,1000n);
 assert.equal(s.parents[1].tokenProgram,'spl-token');
});
test('tampered or foreign evidence is refused',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-snap-bad-'));evidence(dir,mintA);
 assert.throws(()=>readSnapshotEvidence(dir,'other',mintA),/missing/);
 writeFileSync(join(dir,campaign,mintA+'.allocation.csv'),'owner,countedBalance,originalBalance\n'+owners[0]+',999,999\n');assert.throws(()=>readSnapshotEvidence(dir,campaign,mintA),/does not match/);
 const dir2=mkdtempSync(join(tmpdir(),'kids-snap-inc-'));evidence(dir2,mintA,{complete:false});assert.throws(()=>readSnapshotEvidence(dir2,campaign,mintA),/incomplete/);
});
