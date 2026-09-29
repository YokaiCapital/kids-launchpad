import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import pg from 'pg';import {PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {startStatusObserver,summarizeObservation,pilotWorkerExpectations,PILOT_LANES,PILOT_LANE_CLASSES} from './status-observer.mjs';
import {createWorkerPresence} from './presence.mjs';
import {WORKER_LANES} from './lanes.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,key=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const manifest={network:'mainnet',genesisHash:key(1),programId:key(2)};
test('status observer: publishes an aggregate on the status page and delivers the first alert set once',{skip:!url&&'KIDS_TEST_POSTGRES_URL unset'},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool,observer;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:4,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  await registry.campaigns.upsert({genesisHash:manifest.genesisHash,programId:manifest.programId,campaignVersion:3,campaign:key(3),mode:'standard',registryStatus:'active'});
  const extras=[],posts=[],logs=[];
  observer=startStatusObserver({registry,manifest,env:{KIDS_ALERT_WEBHOOK:'https://discord.example/api/webhooks/1/x'},setExtra:p=>extras.push(p),log:l=>logs.push(l),intervalMs:3600000,fetchImpl:async(u,init)=>{posts.push({u,init});return {ok:true,status:200};},now:()=>1_800_000_000_000});
  await observer.ready;
  const published=extras.at(-1).publicLaunch;
  assert.equal(published.status,'degraded');assert.equal(published.delivery,'webhook');
  for(const lane of PILOT_LANES)assert.ok(published.alerts.some(a=>a.code==='worker-missing'&&a.lane===lane),'no worker runs, so every pilot lane is missing: '+lane);
  assert.equal(published.workers.lifecycle.alive,0);assert.equal(published.workers.lifecycle.minimum,1);
  assert.equal(published.operating.budgets,0);assert.equal(published.authority.missing,0);
  assert.doesNotMatch(JSON.stringify(published),/[1-9A-HJ-NP-Za-km-z]{32,44}/,'no addresses on the status page');
  assert.equal(posts.length,1);const body=JSON.parse(posts[0].init.body);assert.match(body.content,/KIDS public launches \(mainnet\): \d+ alerts at .*worker-missing \(/);
  assert.ok(!body.content.includes(key(1))&&!body.content.includes(key(2)),'the message names no scope identifiers');
  await observer.tick();assert.equal(posts.length,1,'unchanged alerts are not repeated within the interval');
  // A worker announcing exactly the served classes of its lane clears that lane's worker-missing alert.
  const presence=createWorkerPresence({registry,scope:{genesisHash:manifest.genesisHash,programId:manifest.programId,campaignVersion:3},lane:'provisioning',classes:['fee-setup','fee-activate'],capacity:2,health:()=>({active:0,dispatchAgeMs:0,oldestActiveMs:0,finished:0})});
  await presence.start();try{const after=await observer.tick();assert.ok(!after.alerts.some(a=>a.code==='worker-missing'&&a.lane==='provisioning'),'provisioning present');assert.ok(after.alerts.some(a=>a.code==='worker-missing'&&a.lane==='lifecycle'),'others still missing');assert.equal(after.workers.provisioning.alive,1);}finally{await presence.stop();}
  assert.ok(logs.some(l=>l.event==='public-launch-alerts'),'alerts are logged by code and lane');
  assert.ok(logs.some(l=>l.event==='alert-delivered'&&l.reason==='changed'));
 }finally{await observer?.stop();if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();}
});
test('status observer: an observation failure is published as unavailable and delivers nothing',async()=>{
 const extras=[],posts=[];let calls=0;
 const registry={driver:'postgres',schemaVersion:async()=>{calls+=1;throw Error('database down: postgres://user:secret@host/db');}};
 const observer=startStatusObserver({registry,manifest,env:{KIDS_ALERT_WEBHOOK:'https://hooks.example/x'},setExtra:p=>extras.push(p),intervalMs:3600000,fetchImpl:async()=>{posts.push(1);return {ok:true};},now:()=>1_800_000_000_000});
 try{await observer.ready;assert.equal(calls,1);
  assert.deepEqual(extras.at(-1),{publicLaunch:{status:'unavailable',observedAt:'2027-01-15T08:00:00.000Z',alerts:null,delivery:'webhook'}});
  assert.equal(posts.length,0);assert.ok(!JSON.stringify(extras).includes('secret'),'driver errors never reach the status page');
 }finally{await observer.stop();}
 assert.throws(()=>startStatusObserver({registry,manifest,env:{KIDS_OBSERVER_INTERVAL_MS:'10'},setExtra(){}}),/KIDS_OBSERVER_INTERVAL_MS/);
 assert.throws(()=>startStatusObserver({registry,manifest,env:{},setExtra:null}),/setter/);
});
test('pilot expectations name the classes each hosted lane announces, every one inside its lane; the aggregate drops everything but counts',()=>{
 const expectations=pilotWorkerExpectations();
 assert.deepEqual(Object.keys(expectations),[...PILOT_LANES]);
 for(const lane of PILOT_LANES){assert.deepEqual(expectations[lane],{minimum:1,classes:[...PILOT_LANE_CLASSES[lane]]});for(const c of PILOT_LANE_CLASSES[lane])assert.ok(WORKER_LANES[lane].includes(c),lane+' '+c);}
 assert.deepEqual(PILOT_LANE_CLASSES.provisioning,['fee-setup','fee-activate'],'the hosted provisioning lane serves fee setup and activation only');
 assert.deepEqual(PILOT_LANE_CLASSES.recovery,['refunds','operating-return']);
 const snapshot={version:1,status:'observed',observedAt:'T',liveness:'observed',alerts:[],lanes:{lifecycle:{queued:1,leased:0,failed:0,due:1,oldestDueMs:5,targetMs:5000,scheduled:{},scaleDemand:{}}},presence:{lanes:{lifecycle:{minimum:1,alive:1,capacity:2,active:0}}},operating:{budgets:2,missingBudgets:0,lowReserves:1,unscheduledFunded:0,heldLamports:'5'},authority:{missing:0,revoked:0,expired:0,expiring:1},admission:{secret:'x'}};
 const s=summarizeObservation(snapshot);
 assert.deepEqual(s,{status:'observed',observedAt:'T',liveness:'observed',alerts:[],lanes:{lifecycle:{queued:1,leased:0,failed:0,due:1,oldestDueMs:5}},workers:{lifecycle:{alive:1,minimum:1}},operating:{budgets:2,missingBudgets:0,lowReserves:1,unscheduledFunded:0},authority:{missing:0,revoked:0,expired:0,expiring:1}});
 assert.throws(()=>summarizeObservation({version:2}));
});
