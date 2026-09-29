// Observation loop for the pilot API: every interval it reads the shared registry's worker telemetry (observability.mjs,
// bounded query, no RPC, no signer), publishes an aggregate under `publicLaunch` on the status page (/_health/status,
// forwarded by the gateway as /statusz) and hands the snapshot to the alert delivery when KIDS_ALERT_WEBHOOK is set.
// Read-only. A failed observation is published as unavailable, never as healthy, and its error text is never exported.
import {createWorkerObserver} from './observability.mjs';
import {WORKER_LANES} from './lanes.mjs';
import {createAlertDelivery} from './alert-delivery.mjs';
/** The job classes each hosted pilot service announces (localnet/jobs/service.mjs servedClasses with fee activation and the
 * lifecycle handoff on; the indexer serves every indexing class). Presence needs the announced set to cover the expected one,
 * so these must be the served classes, not the whole lane table. */
export const PILOT_LANE_CLASSES=Object.freeze({
 provisioning:Object.freeze(['fee-setup','fee-activate']),
 lifecycle:Object.freeze(['launch','settlement','lifecycle-control']),
 recovery:Object.freeze(['refunds','operating-return']),
 accounting:Object.freeze(['operating-reconcile','operating-refill']),
 harvest:Object.freeze(['fee-harvest']),
 economics:Object.freeze(['distribution','token-burn']),
 indexing:Object.freeze([...WORKER_LANES.indexing]),
});
export const PILOT_LANES=Object.freeze(Object.keys(PILOT_LANE_CLASSES));
/** Release expectation for the pilot: one live worker per served lane, announcing exactly the served classes. */
export function pilotWorkerExpectations(lanes=PILOT_LANES){return Object.fromEntries(lanes.map(lane=>[lane,{minimum:1,classes:[...PILOT_LANE_CLASSES[lane]]}]));}
/** Aggregate counts only: alert codes and lanes, queue counts per lane, worker presence per lane, operating and authority counts. */
export function summarizeObservation(snapshot){
 if(snapshot?.version!==1)throw Error('Invalid worker observation');
 const number=v=>{const n=Number(v);return Number.isFinite(n)?n:null;};
 return {
  status:snapshot.status,observedAt:snapshot.observedAt,liveness:snapshot.liveness,
  alerts:snapshot.alerts.map(a=>({code:String(a.code),lane:String(a.lane)})),
  lanes:Object.fromEntries(Object.entries(snapshot.lanes).map(([lane,l])=>[lane,{queued:number(l.queued),leased:number(l.leased),failed:number(l.failed),due:number(l.due),oldestDueMs:number(l.oldestDueMs)}])),
  workers:snapshot.presence?.lanes?Object.fromEntries(Object.entries(snapshot.presence.lanes).map(([lane,p])=>[lane,{alive:number(p.alive),minimum:number(p.minimum)}])):null,
  operating:{budgets:number(snapshot.operating?.budgets),missingBudgets:number(snapshot.operating?.missingBudgets),lowReserves:number(snapshot.operating?.lowReserves),unscheduledFunded:number(snapshot.operating?.unscheduledFunded)},
  authority:Object.fromEntries(['missing','revoked','expired','expiring'].map(k=>[k,number(snapshot.authority?.[k])])),
 };
}
export function startStatusObserver({registry,manifest,env=process.env,setExtra,log=()=>{},intervalMs,fetchImpl,now=Date.now,requiredWorkers=pilotWorkerExpectations()}){
 if(typeof setExtra!=='function')throw Error('Status observer needs the status page setter');
 const interval=intervalMs??(env.KIDS_OBSERVER_INTERVAL_MS?Number(env.KIDS_OBSERVER_INTERVAL_MS):60000);
 if(!Number.isInteger(interval)||interval<5000||interval>3600000)throw Error('KIDS_OBSERVER_INTERVAL_MS must be 5000 to 3600000');
 const observer=createWorkerObserver({registry,scope:{genesisHash:manifest.genesisHash,programId:manifest.programId,campaignVersion:3},requiredWorkers});
 const delivery=env.KIDS_ALERT_WEBHOOK?createAlertDelivery({webhookUrl:env.KIDS_ALERT_WEBHOOK,fetchImpl,now,label:'KIDS public launches ('+manifest.network+')',log}):null;
 let timer=null,stopped=false,running=null,last=null;
 async function tick(){
  if(stopped)return last;
  try{
   const snapshot=await observer.read();last={...summarizeObservation(snapshot),delivery:delivery?'webhook':'status-page'};setExtra({publicLaunch:last});
   if(snapshot.alerts.length)log({event:'public-launch-alerts',alerts:last.alerts});
   if(delivery)await delivery.deliver(snapshot);
  }catch{
   last={status:'unavailable',observedAt:new Date(now()).toISOString(),alerts:null,delivery:delivery?'webhook':'status-page'};setExtra({publicLaunch:last});log({event:'public-launch-observation-unavailable'});
  }
  return last;
 }
 const schedule=()=>{if(stopped)return;timer=setTimeout(()=>{running=tick().finally(()=>{running=null;schedule();});},interval);timer.unref?.();};
 const ready=(running=tick().finally(()=>{running=null;schedule();}));
 return {ready,tick,last:()=>last,async stop(){stopped=true;if(timer)clearTimeout(timer);timer=null;await running;}};
}
