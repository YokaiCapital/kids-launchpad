// Activity store and worker gates: idempotent events with exact ordering and kind filters; replay of the campaign's
// history over more than 200 signatures through the campaign and fee-state addresses without fetching a transaction
// twice; failed transactions recorded; the cursor never advances over an unresolved range; page budgets leave
// explicit gaps that close later; provisional rollback; restart at a persistence boundary.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openActivityStore,createActivityIngest,watchedAddresses,ordinalOf,decodeActivityCursor,encodeActivityCursor,validateEvent} from '../market/activity.mjs';
import {decodeActivity,KINDS} from '../market/activity-decode.mjs';
import {RpcError} from '../market/rpc.mjs';
const fixture=name=>JSON.parse(readFileSync(new URL('./fixtures/market/activity/'+name+'.json',import.meta.url),'utf8'));
const ID=fixture('identity');
const scope={genesis:ID.genesis,campaign:ID.campaign};
const sig=n=>('s'+n).replace(/0/g,'o').padEnd(64,'q').slice(0,64)+'ZZZZ';
const NAMES=['campaign-init-configure','commit','finalize','settle','launch','fees-init','fees-collect','fees-sell','fees-distribute','buy-burn','claim-participant','burn-child'];
/** A fake chain: the real fixtures in their real order, then n more fee collections (each names the campaign AND the fee state) and one failed claim. */
function chain(n,{start=1000,time=1790129340}={}){
 const entries=[];let i=0;
 const add=(tx,{err=null,failed=false}={})=>{const s=sig(start+i);tx.slot=start+i;tx.blockTime=time+i*7;tx.transaction.signatures=[s];if(failed){tx.meta.err={InstructionError:[1,{Custom:30}]};tx.meta.innerInstructions=[];}
  const mentions=tx.transaction.message.accountKeys.map(k=>k.pubkey);entries.push({signature:s,slot:tx.slot,blockTime:tx.blockTime,err:tx.meta.err?{InstructionError:[1,{Custom:30}]}:null,confirmationStatus:'finalized',tx,mentions});i++;};
 for(const name of NAMES)add(structuredClone(fixture(name)));
 for(let k=0;k<n;k++)add(structuredClone(fixture('fees-collect')));
 add(structuredClone(fixture('claim-participant')),{failed:true});
 for(const e of entries.slice(-3))e.confirmationStatus='confirmed';
 return entries;
}
function fakeRpc(entries,{failing=new Map(),statuses=null}={}){
 const calls=[],fetched=new Map();
 return {calls,entries,failing,fetched,
  async call(method,params){
   calls.push(method);
   if(method==='getSignaturesForAddress'){
    const address=params[0],{before,until,limit}=params[1];let list=[...entries].reverse().filter(e=>e.mentions.includes(address));
    if(before){const i=list.findIndex(e=>e.signature===before);list=i<0?[]:list.slice(i+1);}
    if(until){const i=list.findIndex(e=>e.signature===until);if(i>=0)list=list.slice(0,i);}
    return list.slice(0,limit).map(({signature,slot,blockTime,err,confirmationStatus})=>({signature,slot,blockTime,err,confirmationStatus,memo:null}));
   }
   if(method==='getTransaction'){
    const s=params[0];fetched.set(s,(fetched.get(s)||0)+1);const f=failing.get(s);
    if(f){if(f==='null')return null;if(f==='transient')throw new RpcError('getTransaction: HTTP 429',{category:'exhausted',method,status:429});if(f==='version')throw new RpcError('getTransaction: rpc -32015 Transaction version (2) is not supported',{category:'unsupported-version',method,code:-32015});}
    assert.equal(params[1].maxSupportedTransactionVersion,1);
    return entries.find(e=>e.signature===s)?.tx??null;
   }
   if(method==='getSignatureStatuses')return {value:params[0].map(s=>statuses?statuses(s):{confirmationStatus:'finalized',err:null})};
   if(method==='getBlockTime'){const e=entries.find(e=>e.slot===params[0]);return e?(e.realBlockTime??e.blockTime):null;}
   throw Error('unexpected '+method);
  },
  stats:()=>({calls:calls.length})};
}
const ingestFor=(rpc,store,options={})=>createActivityIngest({identity:ID,rpc,store,now:()=>1790200000000,options:{pageLimit:100,maxPagesPerTick:3,concurrency:3,finalizeBatch:100,provisionalMinAgeMs:0,...options}});
const expectedEvents=entries=>entries.reduce((n,e)=>n+decodeActivity(e.tx,ID).events.length,0);

test('store: events are validated, idempotent, ordered newest first by slot, signature and instruction ordinal, filtered by kind and paged by cursor',()=>{
 const store=openActivityStore();
 const events=NAMES.flatMap(n=>decodeActivity(fixture(n),ID).events);
 assert.equal(store.insertEvents(scope,events,{commitment:'confirmed',observedAt:1}).inserted,15);
 assert.deepEqual(store.insertEvents(scope,events,{commitment:'confirmed',observedAt:2}),{inserted:0,updated:15},'a replay changes nothing');
 assert.equal(store.counts(scope).total,15);assert.equal(store.counts(scope).byKind['authority-revoked'],2);assert.equal(store.counts(scope).provisional,15);
 const first=store.events(scope,{limit:4});assert.deepEqual(first.events.map(e=>e.kind),['fees-collect','burn-child','claim-participant','buy-burn']);assert.equal(first.events[0].status,'confirmed');
 const second=store.events(scope,{cursor:first.nextCursor,limit:4});assert.deepEqual(second.events.map(e=>e.kind),['fees-distribute','fees-sell','fees-init','authority-revoked']);
 assert.deepEqual(second.events[3].instructionPath,'1.40','inside one transaction the higher inner index is newer');
 const launchOnly=store.events(scope,{kinds:['launch','commit']});assert.deepEqual(launchOnly.events.map(e=>e.kind),['launch','commit']);assert.equal(launchOnly.nextCursor,null);
 assert.throws(()=>store.events(scope,{cursor:'nope'}),/Invalid activity cursor/);
 assert.equal(decodeActivityCursor(encodeActivityCursor({slot:1,signature:sig(1),ordinal:5})).ordinal,5);assert.equal(decodeActivityCursor('x'),null);
 assert.equal(ordinalOf('1'),100000);assert.equal(ordinalOf('1.0'),100001);assert.ok(ordinalOf('1.10')>ordinalOf('1.9'));
 assert.equal(store.finalizeEvents(scope,[events[0].signature]),2,'both events of the init transaction');assert.equal(store.signatureState(scope,events[0].signature).commitment,'finalized');
 assert.equal(store.signatureState(scope,sig(999)),null);
 assert.equal(store.removeEvents(scope,[events[events.length-1].signature]),1);assert.equal(store.counts(scope).total,14);
 for(const bad of [{...events[1],kind:'swap'},{...events[1],assets:[{mint:'SOL',amountRaw:'x',decimals:9,direction:'in'}]},{...events[1],assets:[{mint:'SOL',amountRaw:'1',decimals:9,direction:'sideways'}]},{...events[1],instructionPath:'a'},{...events[1],program:'other'}])assert.throws(()=>validateEvent(bad));
 for(const k of KINDS)assert.doesNotThrow(()=>validateEvent({...events[1],kind:k}));
 store.close();
});
test('worker: cold start replays more than 200 signatures across the campaign and fee-state addresses; each transaction is fetched once; failed attempts are stored with status failed',async()=>{
 const entries=chain(300),rpc=fakeRpc(entries),store=openActivityStore(),ingest=ingestFor(rpc,store);
 assert.deepEqual(watchedAddresses(ID).map(w=>w.role),['campaign','fees']);
 for(let i=0;i<6;i++)await ingest.tick();
 const s=ingest.stats();assert.equal(s.backfillComplete,true);assert.equal(s.openGaps,0);assert.equal(s.decodeFailures,0);
 assert.equal(store.counts(scope).total,expectedEvents(entries));
 assert.equal(rpc.fetched.size,entries.length);assert.ok([...rpc.fetched.values()].every(n=>n===1),'no transaction was fetched twice although every fee collection is in both histories');
 assert.ok(s.transactionsSkippedKnown>=300,'the fee-state poll skipped the fee collections the campaign poll had already stored');
 const failed=store.events(scope,{kinds:['claim-participant']}).events.find(e=>e.failed);assert.equal(failed.status,'failed');assert.deepEqual(failed.assets,[]);
 assert.equal(store.counts(scope).failed,1);assert.equal(store.counts(scope).byKind['claim-participant'],1,'successful claims only');
 assert.equal(store.counts(scope).provisional,0,'the three newest were confirmed only and the finalization pass marked them');
 const before=rpc.calls.length;await ingest.tick();assert.equal(rpc.calls.slice(before).filter(m=>m==='getTransaction').length,0,'nothing new, nothing fetched');
 assert.deepEqual(ingest.coverage().map(c=>[c.role,c.completeToStart,c.gaps.length]),[['campaign',true,0],['fees',true,0]]);
 store.close();
});
test('worker: an unresolved transaction keeps the page uncommitted; the watermark never passes it; a transient failure heals on a later tick',async()=>{
 const entries=chain(20),rpc=fakeRpc(entries),store=openActivityStore(),ingest=ingestFor(rpc,store);
 rpc.failing.set(entries[10].signature,'transient');
 await ingest.tick();
 const campaignCursor=store.getCursor({genesis:ID.genesis,address:ID.campaign});assert.equal(campaignCursor.newestSignature,null,'the campaign cold-start page failed as a whole: no watermark');
 assert.equal(store.eventsOf(scope,entries[10].signature).length,0);assert.equal(store.eventsOf(scope,entries[1].signature).length,0,'the commit (campaign history only) is not stored either');
 const feeOnly=entries.filter(e=>e.mentions.includes(ID.feeState));assert.equal(store.counts(scope).total,expectedEvents(feeOnly),'the fee-state address had no unresolved transaction, so its page committed');
 assert.equal(ingest.stats().lastPollOk,false);assert.match(ingest.stats().lastError,/429/);
 rpc.failing.delete(entries[10].signature);
 await ingest.tick();
 assert.equal(store.counts(scope).total,expectedEvents(entries));assert.equal(ingest.stats().lastPollOk,true);
 store.close();
});
test('worker: live poll with a page budget leaves an explicit gap that later ticks close; a null transaction becomes a gap instead of a skipped range',async()=>{
 const entries=chain(50),store=openActivityStore();
 let rpc=fakeRpc(entries.slice(0,10)),ingest=ingestFor(rpc,store,{pageLimit:5,maxPagesPerTick:2});
 for(let i=0;i<3;i++)await ingest.tick();assert.equal(store.counts(scope).total,expectedEvents(entries.slice(0,10)));
 rpc=fakeRpc(entries);ingest=ingestFor(rpc,store,{pageLimit:5,maxPagesPerTick:2});
 rpc.failing.set(entries[40].signature,'null');
 await ingest.tick();
 const cursor=store.getCursor({genesis:ID.genesis,address:ID.campaign});assert.equal(cursor.newestSignature,entries[entries.length-1].signature,'the watermark moved to the newest signature');
 assert.ok(cursor.gaps.length>=1);assert.ok(cursor.gaps.some(g=>/page budget|unresolved/.test(g.reason)));
 rpc.failing.delete(entries[40].signature);
 for(let i=0;i<12;i++)await ingest.tick();
 assert.deepEqual(store.getCursor({genesis:ID.genesis,address:ID.campaign}).gaps,[]);assert.deepEqual(store.getCursor({genesis:ID.genesis,address:ID.feeState}).gaps,[]);
 assert.equal(store.counts(scope).total,expectedEvents(entries));
 store.close();
});
test('worker: provisional events of a signature that vanished are removed; finalized ones are marked; an unsupported version is remembered on the cursor',async()=>{
 const entries=chain(5),store=openActivityStore();
 const gone=entries[entries.length-1].signature;// the failed claim, confirmed only
 const rpc=fakeRpc(entries,{statuses:s=>s===gone?null:{confirmationStatus:'finalized',err:null}}),ingest=ingestFor(rpc,store);
 rpc.failing.set(entries[3].signature,'version');
 await ingest.tick();
 assert.equal(store.eventsOf(scope,gone).length,0,'removed after the grace period');assert.equal(ingest.stats().removed,1);
 assert.equal(store.counts(scope).provisional,0);assert.ok(ingest.stats().finalized>=2);
 const c=store.getCursor({genesis:ID.genesis,address:ID.campaign});assert.deepEqual(c.unsupported.map(u=>u.signature),[entries[3].signature]);assert.equal(ingest.stats().unsupportedRecorded,1);
 store.close();
});
test('worker: a restart from the persisted cursor continues without refetching; block times missing from a page are resolved later',async()=>{
 const entries=chain(30),store=openActivityStore();
 for(const e of entries.slice(0,5)){e.realBlockTime=e.blockTime;e.blockTime=null;e.tx.blockTime=null;}// the chain knows the time, the page and the transaction do not
 const rpc=fakeRpc(entries),first=ingestFor(rpc,store);
 await first.tick();await first.tick();
 assert.equal(store.counts(scope).missingBlockTime,0,'getBlockTime filled the five missing times');
 const total=store.counts(scope).total,fetchedBefore=rpc.fetched.size;
 const second=ingestFor(rpc,store);await second.tick();
 assert.equal(rpc.fetched.size,fetchedBefore,'the restarted worker fetched nothing');assert.equal(store.counts(scope).total,total);
 store.close();
});
