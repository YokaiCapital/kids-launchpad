// Startup wiring gates: unset variable does nothing; a sqlite path opens, migrates and imports on an interval; errors are
// categorised and never thrown; asynchronous PostgreSQL errors are reported without exposing credentials; /statusz fields follow the existing shape.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {REGISTRY_SCHEMA_VERSION} from './registry.mjs';
import {startRegistryImport,registryTarget,importInterval,categorizeStartupError} from './startup.mjs';
import {statusSnapshot,setExtra} from '../../shared/service-status.mjs';
const F=fileURLToPath(new URL('../test/fixtures/registry-legacy/',import.meta.url));
const sources=()=>({root:F,runtimeDir:join(F,'runtime'),planPath:join(F,'campaign-plan.json'),archiveDir:join(F,'archive'),identitiesPath:join(F,'identities.json')});
const fakeSchedule=()=>{const timers=[];return {schedule:(fn,ms)=>{const t={fn,ms,cleared:false,unref(){}};timers.push(t);return t;},unschedule:t=>{t.cleared=true;},timers};};
test('KIDS_REGISTRY_URL unset: nothing opens, nothing is scheduled, nothing is published',()=>{
 const s=fakeSchedule();let extras=0;
 const h=startRegistryImport({env:{},open:()=>{throw Error('must not open');},setExtra:()=>extras++,schedule:s.schedule,log:()=>{}});
 assert.equal(h.configured,false);assert.equal(s.timers.length,0);assert.equal(extras,0);assert.deepEqual(h.status(),{configured:false});
 assert.equal(registryTarget({}),null);assert.equal(registryTarget({KIDS_REGISTRY_URL:'  '}),null);
 assert.deepEqual(registryTarget({KIDS_REGISTRY_URL:'/data/registry.sqlite'}),{driver:'sqlite',path:'/data/registry.sqlite'});
 assert.deepEqual(registryTarget({KIDS_REGISTRY_URL:'sqlite:///data/r.sqlite'}),{driver:'sqlite',path:'/data/r.sqlite'});
 assert.deepEqual(registryTarget({KIDS_REGISTRY_URL:'postgres://u:p@h/db'}),{driver:'postgres',path:'postgres://u:p@h/db'});
 assert.equal(importInterval({}),60000);assert.equal(importInterval({KIDS_REGISTRY_IMPORT_INTERVAL_MS:'5000'}),5000);assert.throws(()=>importInterval({KIDS_REGISTRY_IMPORT_INTERVAL_MS:'10'}),/KIDS_REGISTRY_IMPORT_INTERVAL_MS/);
});
test('a sqlite path opens the registry, imports the legacy fixture at once and again on the interval; statusz carries the fields',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-startup-'));const s=fakeSchedule();const logs=[];let t=1790000000000;
 const h=startRegistryImport({env:{KIDS_REGISTRY_URL:join(dir,'registry.sqlite'),KIDS_REGISTRY_IMPORT_INTERVAL_MS:'5000'},sources:sources(),setExtra,schedule:s.schedule,unschedule:s.unschedule,log:l=>logs.push(l),now:()=>t});
 try{
  assert.equal(h.configured,true);await new Promise(r=>setTimeout(r,20));
  const st=h.status();assert.equal(st.campaigns,4);assert.equal(st.lastError,null);assert.equal(st.runs,1);assert.equal(st.lastImportAt,new Date(t).toISOString());
  assert.equal(s.timers.length,1);assert.equal(s.timers[0].ms,5000);
  t+=5000;await s.timers[0].fn();await new Promise(r=>setTimeout(r,20));
  assert.equal(h.status().runs,2);assert.equal(h.status().campaigns,4,'idempotent rerun');assert.equal(h.status().lastImportAt,new Date(t).toISOString());
  const snap=statusSnapshot({ready:true,runtimePath:null});
  assert.deepEqual(Object.keys(snap.registry).sort(),['campaigns','configured','conflicts','driver','lastAttemptAt','lastError','lastImportAt','runs','skipped']);
  assert.equal(snap.registry.configured,true);assert.equal(snap.registry.driver,'sqlite');assert.equal(snap.registry.campaigns,4);assert.equal(snap.registry.skipped,1);
  assert.ok(logs.some(l=>l.event==='registry-opened'&&l.schemaVersion===REGISTRY_SCHEMA_VERSION));assert.ok(logs.some(l=>l.event==='legacy-campaigns-imported'));
 }finally{h.stop();setExtra({registry:undefined});}
 assert.ok(s.timers[0].cleared);
});
test('errors are categorised and never thrown: an unopenable path, a postgres URL, and an import that throws',async()=>{
 const s=fakeSchedule();const logs=[];
 const pg=startRegistryImport({env:{KIDS_REGISTRY_URL:'postgres://user:secret@db.internal/kids'},sources:sources(),open:()=>({async migrate(){throw Error('database unavailable');},async close(){}}),setExtra:()=>{},schedule:s.schedule,log:l=>logs.push(l)});
 await new Promise(r=>setTimeout(r,20));
 assert.equal(pg.status().lastError.category,'migration-failed');assert.doesNotMatch(JSON.stringify(logs),/secret/,'credentials never reach the log');pg.stop();
 const bad=startRegistryImport({env:{KIDS_REGISTRY_URL:'/dev/null/registry.sqlite'},sources:sources(),setExtra:()=>{},schedule:s.schedule,log:()=>{}});
 await new Promise(r=>setTimeout(r,20));assert.equal(bad.status().lastError.category,'open-failed');bad.stop();
 const boom=startRegistryImport({env:{KIDS_REGISTRY_URL:':memory:'},sources:sources(),importFn:()=>{throw Error('disk full');},setExtra:()=>{},schedule:s.schedule,log:()=>{}});
 await new Promise(r=>setTimeout(r,20));assert.equal(boom.status().lastError.category,'import-failed');assert.equal(boom.status().lastError.message,'disk full');assert.equal(boom.status().lastImportAt,null);
 const ok=await boom.runOnce();assert.equal(ok.ok,false,'the next run reports again instead of pretending');boom.stop();
 assert.equal(categorizeStartupError(Object.assign(Error('x'),{code:'NOT_CONFIGURED'}),'open'),'not-configured');assert.equal(categorizeStartupError(Error('x'),'migrate'),'migration-failed');
});

 test('registry is not exposed before migration completes; shutdown drains and closes it',async()=>{
  let release;const migrating=new Promise(r=>{release=r;});let closed=0,imported=0;
  const h=startRegistryImport({env:{KIDS_REGISTRY_URL:'postgres://fixture/test'},open:()=>({async migrate(){await migrating;},async schemaVersion(){return 3;},async close(){closed++;}}),importFn:()=>{imported++;},schedule:()=>null,log:()=>{}});
  assert.equal(h.registry,null);assert.deepEqual(await h.runOnce(),{busy:true});
  const stopping=h.stop();release();await stopping;
  assert.equal(h.registry,null);assert.equal(closed,1);assert.equal(imported,0);
  assert.deepEqual(await h.runOnce(),{skipped:true});
 });
