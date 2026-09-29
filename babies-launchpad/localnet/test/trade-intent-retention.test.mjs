import test from 'node:test';
import assert from 'node:assert/strict';
import {pruneUnissuedTradeQuotes,reserveTradeIntentSlot} from '../trade-intent-retention.mjs';
test('only expired unissued quotes can be removed, preserving prepared and all signed replay records',()=>{
 const intents={expired:{expiresAt:1},fresh:{expiresAt:100},prepared:{expiresAt:1,unsignedTransactionBase64:'wallet message'},signed:{expiresAt:1,signed:'bytes'},ambiguous:{expiresAt:1,signature:'id'},confirmed:{expiresAt:1,confirmed:true},unknown:{}};
 assert.equal(pruneUnissuedTradeQuotes(intents,2),1);assert.deepEqual(Object.keys(intents),['fresh','prepared','signed','ambiguous','confirmed','unknown']);
});
test('pending reservations enforce per-wallet cap before asynchronous quote work completes',()=>{
 const intents={prior:{owner:'alice'},done:{owner:'alice',confirmed:true}},reservations=new Map();const release=[];
 for(let i=0;i<19;i++)release.push(reserveTradeIntentSlot(intents,reservations,'alice'));
 assert.throws(()=>reserveTradeIntentSlot(intents,reservations,'alice'),/Too many pending/);
 const bob=reserveTradeIntentSlot(intents,reservations,'bob');bob();
 release[0]();release[0]();assert.equal(reservations.get('alice'),18);
 const retry=reserveTradeIntentSlot(intents,reservations,'alice');retry();release.slice(1).forEach(fn=>fn());assert.equal(reservations.size,0);
});
test('global cap includes in-flight distinct-owner quote work',()=>{
 const reservations=new Map(),intents={done:{confirmed:true}},release=reserveTradeIntentSlot(intents,reservations,'alice',{total:2});
 assert.throws(()=>reserveTradeIntentSlot(intents,reservations,'bob',{total:2}),/history is full/);release();assert.doesNotThrow(()=>reserveTradeIntentSlot(intents,reservations,'bob',{total:2}));
});

test('quote preparation in flight cannot be pruned before its transaction is persisted',()=>{
 const intents={preparing:{expiresAt:1},local:{expiresAt:1,executionMode:'local'}};
 assert.equal(pruneUnissuedTradeQuotes(intents,2,id=>id==='preparing'),0);assert.equal(Object.keys(intents).length,2);
});
