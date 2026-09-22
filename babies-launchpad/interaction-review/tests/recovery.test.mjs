import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDraft,draftError,restoreVote,restoreProposal,recordVote,candidates} from '../src/model.js';
test('malformed saved drafts recover safe fields without trusting types or remote artwork',()=>{
 for(const value of [null,[],false,7,{name:{},rights:'true',art:'https://invalid.test/x',a:'UNKNOWN'}]) {
  const d=normalizeDraft(value); assert.equal(typeof d.name,'string');assert.equal(d.rights,false);assert.equal(d.art,'');assert.equal(d.a,'ALPHA');
 }
 const d=normalizeDraft({name:'Sprout',ticker:'sprout',art:'/assets/sprout.png'});assert.equal(d.name,'Sprout');assert.equal(d.ticker,'SPROUT');assert.equal(d.art,'/assets/sprout.png');
});
test('review cannot bypass parent, ticker, description or rights validation',()=>{
 const d={a:'ALPHA',b:'BETA',name:'Sprout',ticker:'SPROUT',description:'A kid',art:'/assets/sprout.png',rights:true};
 assert.equal(draftError(d),'');
 for(const change of [{b:'ALPHA'},{ticker:'?'},{description:' '},{rights:false}])assert.ok(draftError({...d,...change}));
});
test('stored votes resolve canonical frozen data and reject unknown versions',()=>{
 assert.equal(restoreVote({}),null);assert.equal(restoreVote({candidate:{id:'K009-001'},receipt:'DEMO-009-1'}),null);
 const v=restoreVote({candidate:{...candidates[0],votes:999999999},receipt:'DEMO-009-1'});assert.equal(v.candidate.votes,candidates[0].votes);
 assert.equal(restoreProposal({id:'other',status:'Awaiting review'}),null);
});
test('failed replacement preserves original vote and receipt; retry is idempotent',()=>{
 const original=recordVote(null,candidates[0],{now:1}).vote;
 for(const options of [{scenario:'Offline'},{scenario:'Closed'},{wallet:false},{power:0}]) {
  const result=recordVote(original,candidates[1],options);assert.equal(result.vote,original);assert.ok(result.error);
 }
 const replacement=recordVote(original,candidates[1],{now:2}).vote;assert.equal(replacement.candidate.id,candidates[1].id);
 assert.equal(recordVote(replacement,candidates[1],{now:3}).vote,replacement);
 assert.equal(recordVote(replacement,{...candidates[1],hash:'changed'}).vote,replacement);
});
