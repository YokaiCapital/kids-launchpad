import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createIntentArchive,finalizedIntentProof,compactIntentHistory} from '../../shared/intent-archive.mjs';
const identity={service:'claims',genesis:'ledger-1',program:'program-1'};
const proof={kind:'finalized-success',signature:'sig',slot:3,observedAt:5};
const rpc=(status,height=50)=>({getSignatureStatuses:async()=>({value:[status]}),getBlockHeight:async commitment=>{assert.equal(commitment,'finalized');return height;}});
function fixture(t){const directory=mkdtempSync(join(tmpdir(),'kids-intent-archive-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));return {directory,archive:createIntentArchive({directory,identity})};}
test('exact replay lookup survives restart and immutable generations retain full signed audit',t=>{
 const {directory,archive}=fixture(t),value={owner:'alice',descriptor:'claim',signed:'full signed bytes',confirmedSignature:'sig'};
 archive.append('request/../../key',value,proof);assert.deepEqual(createIntentArchive({directory,identity}).lookup('request/../../key').value,value);assert.equal(archive.lookup('different'),null);
 archive.append('request/../../key',{...value,confirmedSignature:'next'}, {...proof,signature:'next'});assert.equal(readdirSync(join(directory,'objects')).length,2);assert.equal(archive.lookup('request/../../key').value.confirmedSignature,'next');
});
test('ledger mismatch, changed reference or corrupted immutable content fail closed',t=>{
 const {directory,archive}=fixture(t);archive.append('id',{signed:'wire'},proof);
 const foreign=createIntentArchive({directory,identity:{...identity,genesis:'other'}});assert.throws(()=>foreign.lookup('id'),/identity/);assert.throws(()=>foreign.append('id',{},proof),/identity/);
 const path=join(directory,'objects',readdirSync(join(directory,'objects'))[0]);writeFileSync(path,'{}');assert.throws(()=>archive.lookup('id'),/checksum/);
});
test('terminal classification preserves confirmed, pending, unknown signed, unexpired and malformed rows',async()=>{
 for(const status of [{confirmationStatus:'confirmed',slot:3,err:null},{confirmationStatus:'processed',slot:3,err:{failure:true}},null])assert.equal(await finalizedIntentProof(rpc(status),{signature:'sig',lastValidBlockHeight:1}),null);
 assert.equal(await finalizedIntentProof(rpc(null,50),{lastValidBlockHeight:50}),null);assert.equal(await finalizedIntentProof(rpc(null),{}),null);
 assert.deepEqual(await finalizedIntentProof(rpc(null),{lastValidBlockHeight:49},()=>5),{kind:'finalized-expiry',lastValidBlockHeight:49,finalizedBlockHeight:50,observedAt:5});
 assert.equal((await finalizedIntentProof(rpc({confirmationStatus:'finalized',slot:3,err:null}),{signature:'sig'},()=>5)).kind,'finalized-success');
 assert.equal((await finalizedIntentProof(rpc({confirmationStatus:'finalized',slot:3,err:{failure:true}}),{signature:'sig'},()=>5)).kind,'finalized-failure');
});
test('compaction archives before hot deletion, restart replay remains exact',async t=>{
 const {archive}=fixture(t),intents={a:{owner:'alice',signed:'wire'}},connection=rpc({confirmationStatus:'finalized',slot:3,err:null});let persisted;
 assert.deepEqual(await compactIntentHistory({intents,archive,describe:async()=>({connection,signature:'sig'}),persist:()=>{assert.equal(archive.lookup('a').value.signed,'wire');persisted=structuredClone(intents);}}),{inspected:1,archived:1,cursor:'a'});assert.deepEqual(persisted,{});assert.equal(archive.lookup('a').value.owner,'alice');
});
test('failed hot persistence restores memory with durable archive duplicate safe to retry',async t=>{
 const {archive}=fixture(t),intents={a:{signed:'wire'}},description={connection:rpc({confirmationStatus:'finalized',slot:3,err:null}),signature:'sig'};
 await assert.rejects(compactIntentHistory({intents,archive,describe:async()=>description,persist:()=>{throw Error('fsync failed');}}),/fsync/);assert.equal(intents.a.signed,'wire');assert.equal(archive.lookup('a').value.signed,'wire');
 assert.equal((await compactIntentHistory({intents,archive,describe:async()=>description,persist:()=>{}})).archived,1);
});
test('async races, busy entries and limit cannot remove active work',async t=>{
 const {archive}=fixture(t),intents={busy:{signed:'busy'},a:{signed:'old'},b:{signed:'b'}};
 const result=await compactIntentHistory({intents,archive,isBusy:key=>key==='busy',limit:1,describe:async(value,key)=>{intents[key]={signed:'new'};return {connection:rpc({confirmationStatus:'finalized',slot:3,err:null}),signature:'sig'};},persist:()=>assert.fail('racing row must stay hot')});assert.deepEqual(result,{inspected:1,archived:0,cursor:'a'});assert.equal(intents.a.signed,'new');assert.equal(intents.busy.signed,'busy');
});
test('invalid proof cannot write an archive and unresolved rows remain hot',async t=>{
 const {archive}=fixture(t);assert.throws(()=>archive.append('x',{}, {kind:'confirmed',observedAt:1}),/proof/);assert.throws(()=>archive.append('x',{}, {kind:'finalized-expiry',observedAt:1,lastValidBlockHeight:50,finalizedBlockHeight:50}),/expiry/);
 const intents={a:{signed:'wire'}};assert.equal((await compactIntentHistory({intents,archive,describe:async()=>({connection:rpc(null),signature:'sig',lastValidBlockHeight:1}),persist:()=>assert.fail()})).archived,0);assert.ok(intents.a);assert.equal(archive.lookup('a'),null);
});

test('bounded scan cursor advances past unresolved prefix to finalized entries',async t=>{
 const {archive}=fixture(t),intents={a:{signed:'unresolved'},b:{signed:'finalized'}};const describe=async(value,key)=>({connection:rpc(key==='a'?null:{confirmationStatus:'finalized',slot:3,err:null}),signature:'sig'});
 const first=await compactIntentHistory({intents,archive,describe,persist:()=>{},limit:1});assert.equal(first.archived,0);
 const second=await compactIntentHistory({intents,archive,describe,persist:()=>{},limit:1,cursor:first.cursor});assert.equal(second.archived,1);assert.ok(intents.a);assert.equal(archive.lookup('b').value.signed,'finalized');
});

test('checkpoint marker restores committed index, rejects partial archive, and ignores orphan generations',t=>{
 const {archive,directory}=fixture(t),a=archive.append('id',{signed:'old'},proof),head=archive.checkpoint(null,'id',a.object),marker={version:1,head,count:1};
 archive.append('id',{signed:'orphan-new'},proof);assert.equal(archive.readObject('id',archive.restoreIndex(marker).get('id')).value.signed,'old');
 assert.throws(()=>archive.restoreIndex({...marker,count:2}),/Incomplete/);
 const object=join(directory,'objects',a.object+'.json');writeFileSync(object,'broken');assert.throws(()=>archive.restoreIndex(marker),/checksum/);
});
