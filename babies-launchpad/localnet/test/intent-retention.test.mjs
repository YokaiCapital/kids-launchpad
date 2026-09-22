import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createIntentRetention,ARCHIVE_MARKER} from '../../shared/intent-retention.mjs';
test('failed hot checkpoint commit restores memory; restart with old journal ignores orphan archive',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-retention-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'hot.json'),intents={one:{signature:'sig',signed:'bytes'}};writeFileSync(file,JSON.stringify(intents));
 const describe=async()=>({connection:{getSignatureStatuses:async()=>({value:[{confirmationStatus:'finalized',slot:1,err:null}]})},signature:'sig'});
 const history=createIntentRetention({file,service:'test',intents,describe,persist:()=>{throw Error('fsync');},threshold:1});
 await assert.rejects(history.compact(),/fsync/);assert.equal(intents[ARCHIVE_MARKER],undefined);assert.equal(history.lookup('one').signed,'bytes');
 const restarted=createIntentRetention({file,service:'test',intents:JSON.parse(readFileSync(file)),describe,persist:()=>{},threshold:1});assert.equal(restarted.lookup('one').signed,'bytes');
});
test('one pass scans at most ten rows and memoizes qualification only within that pass',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-retention-budget-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'hot.json'),intents={};for(let i=0;i<11;i++)intents[String(i).padStart(2,'0')]={signature:'sig',campaign:'campaign'};
 let qualifications=0,statuses=0;const connection={getSignatureStatuses:async()=>{statuses++;return {value:[{confirmationStatus:'finalized',slot:1,err:null}]};}};
 const history=createIntentRetention({file,service:'test',intents,threshold:1,persist:()=>writeFileSync(file,JSON.stringify(intents)),describe:async(i,key,memo)=>({connection:await memo(i.campaign,async()=>{qualifications++;return connection;}),signature:i.signature})});
 assert.equal((await history.compact()).archived,10);assert.equal(statuses,10);assert.equal(qualifications,1);
 assert.equal((await history.compact()).archived,1);assert.equal(statuses,11);assert.equal(qualifications,2);
});
