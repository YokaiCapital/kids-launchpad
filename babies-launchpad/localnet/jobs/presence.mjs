// Private process telemetry. Never grants signing rights or replaces job fences.
import {randomUUID} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {laneClasses} from './lanes.mjs';
import {canonicalJson} from '../registry/canonical.mjs';
const integer=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
export function createWorkerPresence({registry,scope,lane,classes,capacity,health,log=()=>{},intervalMs=5000,bootId=randomUUID()}){
 if(registry?.driver!=='postgres'||typeof health!=='function')throw Error('Presence requires shared registry and runner health');
 for(const value of [scope?.genesisHash,scope?.programId])if(new PublicKey(value).toBase58()!==value)throw Error('Invalid presence scope');
 if(![2,3].includes(scope.campaignVersion)||!integer(capacity,1,64)||!integer(intervalMs,1000,10000)||!/^[a-f0-9-]{36}$/.test(bootId))throw Error('Invalid presence configuration');
 const allowed=laneClasses(lane);if(!Array.isArray(classes)||!classes.length||new Set(classes).size!==classes.length||classes.some(x=>!allowed.includes(x)))throw Error('Invalid presence classes');
 const identity=[scope.genesisHash,scope.programId,scope.campaignVersion,lane,canonicalJson([...classes].sort()),capacity];
 let sequence=0,timer=null,pending=null,started=false,stopped=false,closing=null;
 async function write(state){
  const h=health();for(const k of ['active','dispatchAgeMs','oldestActiveMs','finished'])if(!integer(h[k],0,k==='active'?capacity:Number.MAX_SAFE_INTEGER))throw Error('Invalid runner health');
  const seq=++sequence;
  return registry.transaction(async()=>{
   await registry.query("SET LOCAL statement_timeout='3000ms'");
   if(seq===1&&state==='running')await registry.query(`DELETE FROM worker_presence WHERE boot_id IN (
    SELECT boot_id FROM worker_presence WHERE genesis_hash=? AND program_id=? AND campaign_version=? AND lane=?
     AND observed_ms<CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT)-604800000 ORDER BY observed_ms LIMIT 100
   )`,identity.slice(0,4));
   const result=await registry.query(`INSERT INTO worker_presence(boot_id,genesis_hash,program_id,campaign_version,lane,classes_json,capacity,sequence,state,active,dispatch_age_ms,oldest_active_ms,finished,observed_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT))
    ON CONFLICT(boot_id) DO UPDATE SET sequence=excluded.sequence,state=excluded.state,active=excluded.active,
     dispatch_age_ms=excluded.dispatch_age_ms,oldest_active_ms=excluded.oldest_active_ms,finished=excluded.finished,observed_ms=excluded.observed_ms
    WHERE worker_presence.state='running' AND worker_presence.sequence<excluded.sequence
     AND worker_presence.genesis_hash=excluded.genesis_hash AND worker_presence.program_id=excluded.program_id
     AND worker_presence.campaign_version=excluded.campaign_version AND worker_presence.lane=excluded.lane
     AND worker_presence.classes_json=excluded.classes_json AND worker_presence.capacity=excluded.capacity
    RETURNING boot_id`,[bootId,...identity,seq,state,h.active,h.dispatchAgeMs,h.oldestActiveMs,h.finished]);
   if(result.rows.length!==1)throw Error('Presence generation refused');
  },{lockKey:'worker-presence:'+bootId});
 }
 function beat(){if(pending)return pending;pending=write('running').finally(()=>{pending=null;});return pending;}
 return {
  async start(){if(started||stopped)throw Error('Presence already started or stopped');started=true;await beat();if(stopped)return;timer=setInterval(()=>{if(!pending)beat().catch(()=>log({event:'worker-presence-write-failed',lane}));},intervalMs);timer.unref?.();},
  stop(){if(closing)return closing;stopped=true;clearInterval(timer);closing=(async()=>{if(pending)await pending.catch(()=>{});if(started)await write('stopped');})();return closing;}
 };
}

// Configured role minima are release expectations, never inferred from whatever
// replicas happen to be running. No boot IDs or job/wallet labels are exported.
export function presencePolicy(required={}){
 if(!required||typeof required!=='object'||Array.isArray(required))throw Error('Invalid worker expectations');
 const out={};for(const [lane,value]of Object.entries(required)){
  const allowed=laneClasses(lane),{minimum,classes,maxJobMs=600000}=value??{};
  if(!integer(minimum,1,100)||!integer(maxJobMs,10000,3600000)||!Array.isArray(classes)||!classes.length||new Set(classes).size!==classes.length||classes.some(x=>!allowed.includes(x)))throw Error('Invalid worker expectations');
  out[lane]={minimum,classes:[...classes],maxJobMs};
 }return out;
}
export async function observePresence(registry,{scope,at,required}){
 const id=[scope.genesisHash,scope.programId,scope.campaignVersion],lanes={},alerts=[];
 for(const [lane,expect]of Object.entries(required)){
  // Aggregate by scope/lane and strict class membership. PostgreSQL performs the
  // count; the monitoring process never loads an unbounded process history.
  const row=(await registry.query(`SELECT COUNT(*) n,COALESCE(SUM(capacity),0) capacity,COALESCE(SUM(active),0) active,
   COALESCE(MAX(dispatch_age_ms),0) dispatch_age,COALESCE(MAX(oldest_active_ms),0) oldest_active
   FROM worker_presence WHERE genesis_hash=? AND program_id=? AND campaign_version=? AND lane=?
    AND state='running' AND observed_ms>=? AND observed_ms<=?
    AND classes_json::jsonb @> ?::jsonb`,[...id,lane,at-20000,at,JSON.stringify(expect.classes)])).rows[0];
  const n=Number(row.n),dispatchAgeMs=Number(row.dispatch_age),oldestActiveMs=Number(row.oldest_active);
  lanes[lane]={minimum:expect.minimum,alive:n,capacity:Number(row.capacity),active:Number(row.active),dispatchAgeMs,oldestActiveMs};
  if(n<expect.minimum)alerts.push({code:'worker-missing',lane});
  if(dispatchAgeMs>20000)alerts.push({code:'worker-dispatch-stalled',lane});
  if(oldestActiveMs>expect.maxJobMs)alerts.push({code:'worker-job-slow',lane});
 }
 return {status:Object.keys(required).length?(alerts.length?'degraded':'observed'):'not-configured',ttlMs:20000,lanes,alerts};
}
