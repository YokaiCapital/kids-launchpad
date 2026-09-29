import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DemoStore} from '../server/demo-store.mjs';
const draft={a:'ALPHA',b:'BETA',name:'Local Kid',ticker:'LOCAL',description:'A local demo proposal.',art:'/assets/sprout.png',rights:true};
test('submission, approval and revision persist after reopening; retries do not duplicate',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kid-demo-')),file=join(dir,'state.sqlite');let store=new DemoStore(file);
 try{
  const request={requestId:'submit-0001',revision:0,action:'submit',payload:{draft}};
  const first=store.apply(request);assert.deepEqual(store.apply(request),first);assert.equal(store.read().history.length,1);
  const approved=store.apply({requestId:'review-0001',revision:1,action:'review',payload:{id:first.proposal.id,version:1,status:'Approved for next round'}});
  const revision=store.apply({requestId:'submit-0002',revision:approved.revision,action:'submit',payload:{draft:{...draft,proposalId:first.proposal.id,name:'Revised Kid'}}});
  assert.equal(revision.history[0].status,'Approved for next round');assert.equal(revision.history[0].name,'Local Kid');assert.equal(revision.proposal.version,2);
  store.close();store=new DemoStore(file);assert.equal(store.read().history.length,2);assert.deepEqual(store.apply(request),first);
 }finally{store.close();rmSync(dir,{recursive:true});}
});
test('replacement is atomic, stale clients and invalid candidates retain accepted vote',()=>{
 const store=new DemoStore(':memory:',()=>Date.parse('2026-09-19T12:00:00Z'));try{
 const first=store.apply({requestId:'vote-0001',revision:0,action:'vote',payload:{candidateId:'K009-001'}});
 assert.throws(()=>store.apply({requestId:'vote-0002',revision:0,action:'vote',payload:{candidateId:'K009-002'}}),/another tab/);
 assert.throws(()=>store.apply({requestId:'vote-0003',revision:1,action:'vote',payload:{candidateId:'fake'}}),/unavailable/);
 assert.deepEqual(store.read().accepted,first.accepted);
 const next=store.apply({requestId:'vote-0004',revision:1,action:'vote',payload:{candidateId:'K009-002'}});assert.equal(next.accepted.candidate.id,'K009-002');
 assert.throws(()=>store.apply({requestId:'vote-0004',revision:1,action:'vote',payload:{candidateId:'K009-003'}}),/reused/);
 }finally{store.close();}
});
test('server rejects invalid drafts and frozen moderation without changing revision',()=>{
 const store=new DemoStore(':memory:',()=>Date.parse('2026-09-19T12:00:00Z'));try{assert.throws(()=>store.apply({requestId:'submit-bad',revision:0,action:'submit',payload:{draft:{...draft,rights:false}}}),/permission/);assert.equal(store.read().revision,0);
 assert.throws(()=>store.apply({requestId:'review-bad',revision:0,action:'review',payload:{id:'missing',version:1,status:'Approved for next round'}}),/no longer/);
 }finally{store.close();}
});
