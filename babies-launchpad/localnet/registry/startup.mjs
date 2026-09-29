// Dark startup wiring of the registry and the legacy import (P3 deliverable 1). Nothing here runs unless
// KIDS_REGISTRY_URL is set: a sqlite file path (absolute, or a `sqlite:` URL) or a postgres URL.
// Opening and migration are awaited before the registry is exposed. The import reads campaign files only,
// is idempotent, runs on an interval (KIDS_REGISTRY_IMPORT_INTERVAL_MS, default 60 s) and reports to /statusz through
// service-status setExtra as `registry`: configured, driver, lastImportAt, campaigns, lastError {category, at}.
import {openRegistry} from './registry.mjs';
import {importLegacyCampaigns,defaultSources} from './import-legacy.mjs';
export const DEFAULT_IMPORT_INTERVAL_MS=60000,MIN_IMPORT_INTERVAL_MS=5000,MAX_IMPORT_INTERVAL_MS=3600000;
export const IMPORT_ERROR_CATEGORIES=Object.freeze(['not-configured','open-failed','migration-failed','import-failed','unknown']);
/** The read side of a registry for route handlers: campaigns.list and campaigns.get only, no writer, no migrate, no
 * close (the owner of the connection closes it). What the public campaign routes are handed. */
export function readOnlyRegistry(registry){
 if(!registry?.campaigns)throw Error('readOnlyRegistry needs an open registry');
 return Object.freeze({driver:registry.driver??null,readOnly:true,campaigns:Object.freeze({list:query=>registry.campaigns.list(query),get:id=>registry.campaigns.get(id)}),close(){}});
}
/** Parses KIDS_REGISTRY_URL into a driver and a path; null when unset. */
export function registryTarget(env=process.env){
 const raw=(env.KIDS_REGISTRY_URL||'').trim();if(!raw)return null;
 if(/^postgres(ql)?:\/\//i.test(raw))return {driver:'postgres',path:raw};
 if(/^sqlite:/i.test(raw))return {driver:'sqlite',path:raw.replace(/^sqlite:(\/\/)?/i,'')};
 return {driver:'sqlite',path:raw};
}
export function importInterval(env=process.env){
 const raw=env.KIDS_REGISTRY_IMPORT_INTERVAL_MS;if(raw===undefined||raw==='')return DEFAULT_IMPORT_INTERVAL_MS;
 const n=Number(raw);if(!Number.isSafeInteger(n)||n<MIN_IMPORT_INTERVAL_MS||n>MAX_IMPORT_INTERVAL_MS)throw Error('KIDS_REGISTRY_IMPORT_INTERVAL_MS must be an integer from '+MIN_IMPORT_INTERVAL_MS+' to '+MAX_IMPORT_INTERVAL_MS);
 return n;
}
export function categorizeStartupError(error,step){
 if(error?.code==='NOT_CONFIGURED')return 'not-configured';
 if(step==='open')return 'open-failed';if(step==='migrate')return 'migration-failed';if(step==='import')return 'import-failed';
 return 'unknown';
}
const redact=m=>String(m||'').replace(/(postgres(ql)?:\/\/)[^@\s]+@/gi,'$1<redacted>@').replace(/api[-_]?key=[^&\s"')]+/gi,'api-key=<redacted>').slice(0,200);
/**
 * Starts the interval import. Returns {configured, registry, status(), runOnce(), stop()}; with no KIDS_REGISTRY_URL it
 * returns {configured:false} and does nothing. Injection points keep it testable: open, importFn, sources, setExtra, log,
 * schedule (setInterval-like), now.
 */
export function startRegistryImport({env=process.env,open=openRegistry,importFn=importLegacyCampaigns,sources=null,setExtra=()=>{},log=line=>console.log(JSON.stringify(line)),schedule=setInterval,unschedule=clearInterval,now=Date.now}={}){
 const target=registryTarget(env);
 if(!target)return {configured:false,registry:null,status:()=>({configured:false}),runOnce:async()=>({skipped:true}),stop(){}};
 const state={configured:true,driver:target.driver,lastImportAt:null,lastAttemptAt:null,campaigns:null,inserted:null,updated:null,conflicts:null,skipped:null,lastError:null,runs:0};
 const publish=()=>setExtra({registry:{configured:true,driver:state.driver,lastImportAt:state.lastImportAt,lastAttemptAt:state.lastAttemptAt,campaigns:state.campaigns,conflicts:state.conflicts,skipped:state.skipped,lastError:state.lastError,runs:state.runs}});
 const fail=(step,error)=>{const category=categorizeStartupError(error,step);state.lastError={category,step,at:new Date(now()).toISOString(),message:redact(error?.message||error)};log({event:'registry-import-error',step,category,message:state.lastError.message});publish();};
 let registry=null,timer=null,inFlight=null,stopped=false;
 const interval=(()=>{try{return importInterval(env);}catch(e){fail('configure',e);return DEFAULT_IMPORT_INTERVAL_MS;}})();
 async function ensureOpen(){
  if(registry)return registry;
  let r;try{r=await open({driver:target.driver,path:target.path});}catch(e){fail('open',e);return null;}
  try{
   await r.migrate();
   const schemaVersion=await r.schemaVersion();
   if(stopped){await r.close();return null;}
   registry=r;log({event:'registry-opened',driver:target.driver,schemaVersion});return r;
  }catch(e){fail('migrate',e);try{await r.close();}catch{}return null;}
 }
 async function performRun(){
  state.lastAttemptAt=new Date(now()).toISOString();state.runs+=1;
  try{
   const r=await ensureOpen();if(!r)return {ok:false,category:state.lastError?.category||'stopped'};
   let out;try{out=await importFn({registry:r,sources:sources||defaultSources(),log});}catch(e){fail('import',e);return {ok:false,category:'import-failed'};}
   state.lastImportAt=new Date(now()).toISOString();state.campaigns=out.total;state.inserted=out.rows.filter(x=>x.inserted).length;state.updated=out.rows.filter(x=>x.updated).length;state.conflicts=out.rows.filter(x=>x.conflicts.length).length;state.skipped=out.skipped.length;state.lastError=null;publish();
   return {ok:true,campaigns:out.total};
  }catch(e){fail('run',e);return {ok:false,category:'unknown'};}
 }
 function runOnce(){
  if(stopped)return Promise.resolve({skipped:true});
  if(inFlight)return Promise.resolve({busy:true});
  inFlight=performRun().finally(()=>{inFlight=null;});return inFlight;
 }
 async function stop(){
  stopped=true;if(timer)unschedule(timer);timer=null;
  // Drain the importer before closing; stop during migration must not expose a late connection.
  if(inFlight)await inFlight;
  const r=registry;registry=null;if(r)await r.close();
 }
 publish();
 runOnce().catch(e=>fail('run',e));
 timer=schedule(()=>{runOnce().catch(e=>fail('run',e));},interval);timer?.unref?.();
 return {configured:true,get registry(){return registry;},status:()=>({...state}),runOnce,stop};
}
