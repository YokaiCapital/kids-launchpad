// Regression for the architecture audit (23 Sep 2026): reconciliation must inspect pending signatures on the chain
// regardless of the archival threshold, and the startup gate must stay closed while any signed row is unresolved.
import test from 'node:test';import assert from 'node:assert/strict';
import {reconcileSignedIntents,reconcileOperatorJournal} from '../chain-reconcile.mjs';
import {reconcileJournals} from '../startup-reconcile.mjs';
const conn=(map,height=150)=>({calls:[],async getSignatureStatuses(sigs){this.calls.push(sigs);return {value:sigs.map(s=>map[s]===undefined?null:map[s])};},async getBlockHeight(){return height;}});
const ok={err:null,confirmationStatus:'finalized'},bad={err:{InstructionError:[0,'Custom']},confirmationStatus:'finalized'};
test('every signed row below the archival threshold is checked on chain and classified',async()=>{
 const intents={a:{submittedSignature:'sigA',block:{lastValidBlockHeight:100}},b:{signature:'sigB',signed:'x',block:{lastValidBlockHeight:100}},c:{submittedSignature:'sigC',block:{lastValidBlockHeight:100}},d:{submittedSignature:'sigD',block:{lastValidBlockHeight:999}},e:{unsignedTransactionBase64:'u'},done:{submittedSignature:'sigZ',confirmedSignature:'sigZ'}};
 const c=conn({sigA:ok,sigB:bad});let persisted=0;
 const s=await reconcileSignedIntents({service:'t',intents,connection:c,persist:()=>persisted++});
 assert.equal(c.calls.length,1);assert.deepEqual(c.calls[0],['sigA','sigB','sigC','sigD']);
 assert.equal(intents.a.confirmedSignature,'sigA');assert.equal(intents.b.closedReason,'failed');assert.equal(intents.c.closedReason,'expired');assert.equal(intents.d.closedReason,undefined);
 assert.deepEqual({hot:s.hot,signed:s.signed,checked:s.checked,ok:s.resolvedSuccess,failed:s.resolvedFailed,expired:s.expired,unresolved:s.unresolvedSigned,complete:s.complete},{hot:6,signed:5,checked:4,ok:1,failed:1,expired:1,unresolved:1,complete:true});
 assert.equal(persisted,1);
});
test("the 'confirmed' success field and batches of 100 work; an RPC failure propagates instead of counting as reconciled",async()=>{
 const intents={};for(let i=0;i<250;i++)intents['k'+i]={signature:'s'+i,signed:'x'};const map={};for(let i=0;i<250;i++)map['s'+i]=ok;
 const c=conn(map);const s=await reconcileSignedIntents({service:'trades',intents,connection:c,successField:'confirmed'});
 assert.equal(c.calls.length,3);assert.equal(s.resolvedSuccess,250);assert.equal(intents.k7.confirmed,true);
 await assert.rejects(reconcileSignedIntents({service:'x',intents:{a:{signature:'q',signed:'x'}},connection:{async getSignatureStatuses(){throw Error('rpc down');}}}),/rpc down/);
});
test('operator journal attempts are classified and moved like the sender does',async()=>{
 const journal={attempts:{'fee:1':{signature:'p',block:{lastValidBlockHeight:100},createdAt:5},'fee:2':{signature:'q',block:{lastValidBlockHeight:100},createdAt:6},'fee:3':{signature:'r',block:{lastValidBlockHeight:999},createdAt:7}},current:{id:'fee:2'}};
 let persisted=0;const s=await reconcileOperatorJournal({service:'fees',journal,connection:conn({p:ok}),persist:()=>persisted++});
 assert.equal(journal.attempts['fee:1'].confirmed,true);assert.equal(journal.attempts['fee:2'],undefined);assert.equal(journal.attempts['fee:2:6'].closedReason,'expired');assert.equal(journal.current,null);assert.equal(journal.attempts['fee:3'].confirmed,undefined);
 assert.equal(s.unresolvedSigned,1);assert.equal(persisted,1);
});
test('startup gate: complete only when every pass ran and no signed row is unresolved',async()=>{
 const passes=[['a',async()=>({service:'a',hot:1,signed:1,unresolvedSigned:0,checked:1,complete:true})],['b',async()=>({service:'b',hot:2,signed:2,unresolvedSigned:1,checked:2,complete:true})]];
 const r=await reconcileJournals({passes});assert.equal(r.complete,false);assert.equal(r.unresolvedSigned,1);
 const r2=await reconcileJournals({passes:[passes[0]]});assert.equal(r2.complete,true);
 const r3=await reconcileJournals({passes:[['c',async()=>({service:'c',hot:0,signed:0,unresolvedSigned:0,checked:0,complete:false})]]});assert.equal(r3.complete,false);
 const r4=await reconcileJournals({passes:[['d',async()=>{throw Error('boom');}]]});assert.equal(r4.complete,false);assert.equal(r4.services[0].status,'failed');
});
test('hasPendingSigned: a journal with only resolved or unsigned rows needs no chain access; one pending signed row does',async()=>{
 const {hasPendingSigned}=await import('../chain-reconcile.mjs');
 assert.equal(hasPendingSigned({a:{submittedSignature:'s',confirmedSignature:'s'},b:{unsignedTransactionBase64:'u'},c:{signature:'x',closedReason:'failed'}}),false);
 assert.equal(hasPendingSigned({a:{submittedSignature:'s'}}),true);assert.equal(hasPendingSigned({t:{signature:'q',signed:'bytes'}},'confirmed'),true);assert.equal(hasPendingSigned({t:{signature:'q',signed:'bytes',confirmed:true}},'confirmed'),false);
});
