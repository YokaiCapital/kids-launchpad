import test from 'node:test';import assert from 'node:assert/strict';
import {createWalletReadSession} from '../src/public/wallet-read-session.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('same wallet/page reads coalesce; omitted positions are unknown, not zero',async()=>{
 const wait=deferred(),calls=[];const s=createWalletReadSession(async(path,body)=>{calls.push(path);if(path==='state'){await wait.promise;return {owner:'owner',csrf:'csrf'};}return {owner:'owner',available:true,positions:{one:{eligibility:'verified',commitLamports:'7'}}};});
 const input={owner:'owner',campaignIds:['one','two']},a=s.read(input),b=s.read(input);assert.equal(a,b);wait.resolve();
 const {account}=await a;assert.deepEqual(account.positions.two,{eligibility:'unknown'});assert.equal(account.positions.one.commitLamports,'7');assert.deepEqual(calls,['state','launches/positions']);
});
test('changing pages cancels the preceding read; a late response cannot enter the next page',async()=>{
 const wait=deferred(),signals=[];let n=0;const s=createWalletReadSession(async(path,body,csrf,options)=>{if(path==='state'){signals.push(options.signal);if(++n===1)await wait.promise;return {owner:'owner'};}return {owner:'owner',available:true,positions:{}};});
 const old=s.read({owner:'owner',campaignIds:['one']});const rejection=assert.rejects(old,{name:'AbortError'});
 const next=s.read({owner:'owner',campaignIds:['two']});assert.equal(signals[0].aborted,true);wait.resolve();await rejection;assert.deepEqual(Object.keys((await next).account.positions),['two']);
});
test('no reads are silently truncated; another owner or campaign in a response fails closed',async()=>{
 const good={owner:'owner',available:true,positions:{one:{eligibility:'verified'}}};
 for(const bad of [{...good,owner:'other'},{...good,available:false},{...good,positions:{foreign:{}}}]){
  const s=createWalletReadSession(async p=>p==='state'?{owner:'owner'}:bad);await assert.rejects(s.read({owner:'owner',campaignIds:['one']}),/identity|unavailable/);
 }
 const s=createWalletReadSession(()=>{throw Error('must not read');});assert.throws(()=>s.read({owner:'owner',campaignIds:Array.from({length:25},(_,i)=>String(i))}),/bounded/);assert.throws(()=>s.read({owner:'owner',campaignIds:['one','one']}),/bounded/);
});
test('drafts are fetched only on demand and are isolated to the authenticated owner',async()=>{
 let other=false;const calls=[];const s=createWalletReadSession(async path=>{calls.push(path);return path==='state'?{owner:'owner'}:path==='launches/drafts'?{drafts:[{creator:other?'other':'owner',id:'draft'}]}:{owner:'owner',available:true,positions:{}};});
 assert.equal((await s.read({owner:'owner',campaignIds:[]})).drafts,null);assert.ok(!calls.includes('launches/drafts'));
 assert.equal((await s.read({owner:'owner',campaignIds:[],readDrafts:true})).drafts.length,1);other=true;
 await assert.rejects(s.read({owner:'owner',campaignIds:[],readDrafts:true}),/Draft wallet/);
});
