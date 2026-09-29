// Schema at boot for hosted services. The shared registry has no public address, so migrations run inside the platform:
// a service started with KIDS_REGISTRY_MIGRATE=1 brings the schema to this release (registry.migrate() holds a
// PostgreSQL advisory lock, so several boots serialize and the result is the same); every other hosted service waits,
// bounded, until the schema equals the release version, retrying connection failures while the database comes up.
import {REGISTRY_SCHEMA_VERSION} from '../registry/registry.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function ensureSchema({registry,env=process.env,log=()=>{},waitMs=600000,pollMs=5000,now=Date.now,sleepImpl=sleep}){
 if(registry?.driver!=='postgres')throw Error('Schema boot needs the shared PostgreSQL registry');
 const migrate=env.KIDS_REGISTRY_MIGRATE==='1',deadline=now()+waitMs;let lastLog=0,attempt=0;
 for(;;){
  attempt+=1;
  try{
   if(migrate){await registry.migrate();}
   const version=await registry.schemaVersion();
   if(version===REGISTRY_SCHEMA_VERSION){log({event:'schema-ready',version,migrated:migrate,attempts:attempt});return version;}
   if(version>REGISTRY_SCHEMA_VERSION)throw Object.assign(Error('Registry schema '+version+' is newer than this release ('+REGISTRY_SCHEMA_VERSION+')'),{permanent:true});
   if(now()-lastLog>=60000){lastLog=now();log({event:'waiting-for-schema',version,release:REGISTRY_SCHEMA_VERSION});}
  }catch(error){
   if(error?.permanent)throw error;
   // Connection refusals and resets while the database starts are retried; anything else is logged by category only.
   if(now()-lastLog>=60000){lastLog=now();log({event:'waiting-for-registry',category:error?.code||'error'});}
  }
  if(now()>=deadline)throw Error('Registry schema did not reach '+REGISTRY_SCHEMA_VERSION+' within '+Math.round(waitMs/1000)+' s');
  await sleepImpl(pollMs);
 }
}
