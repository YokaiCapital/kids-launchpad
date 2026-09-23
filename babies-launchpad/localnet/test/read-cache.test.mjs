// Regression for the architecture audit (item 5): polls must not download and hash the executable each time, and the
// public campaign read must be shared across concurrent polls.
import test from 'node:test';import assert from 'node:assert/strict';
import {createPublicCampaignRead} from '../active-launch.mjs';
test('the public campaign read is single-flight and shared for its TTL; a failure is not cached',async()=>{
 let t=0,loads=0,fail=false;const read=createPublicCampaignRead(async()=>{loads++;await new Promise(r=>setTimeout(r,5));if(fail)throw Error('rpc');return {slot:loads};},{ttlMs:2000,now:()=>t});
 const results=await Promise.all(Array.from({length:50},()=>read()));assert.equal(loads,1);assert.ok(results.every(r=>r.slot===1));
 t=1999;await read();assert.equal(loads,1);t=2001;await read();assert.equal(loads,2);
 fail=true;t=5000;await assert.rejects(read());fail=false;await read();assert.equal(loads,4,'a failed load is retried on the next call, never cached');
});
test('the qualified program context is shared and revalidated on a schedule (desktop ledger, skipped when it is not running)',async(t)=>{
 let up=false;try{const r=await fetch('http://127.0.0.1:19099',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getHealth'}),signal:AbortSignal.timeout(1500)});up=r.ok;}catch{}
 if(!up)return t.skip('local validator not running');
 const {atomicContext,contextStats,invalidateAtomicContext}=await import('../atomic-launch.mjs');
 invalidateAtomicContext();const before=contextStats.qualifications;
 await Promise.all([atomicContext(),atomicContext(),atomicContext()]);await atomicContext();
 assert.equal(contextStats.qualifications-before,1,'four calls, one qualification');
 await atomicContext({fresh:true});assert.equal(contextStats.qualifications-before,2,'fresh forces a new qualification');
});
