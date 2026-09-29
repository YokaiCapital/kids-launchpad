// Qualification measurements only. A recovery run must never masquerade as a
// fresh deadline burst; pre-close polling cannot dilute closing-window latency.
const quantile=(a,p)=>a.length?[...a].sort((x,y)=>x-y)[Math.ceil(a.length*p)-1]:null;
const stats=a=>({samples:a.length,p50Ms:quantile(a,.5),p95Ms:quantile(a,.95),p99Ms:quantile(a,.99)});
export function fleetClosingMetrics(events,{closeObservedAt,freshClose}){
 const close=Date.parse(closeObservedAt);
 if(!Number.isFinite(close)||typeof freshClose!=='boolean')throw Error('Explicit closing observation and run type required');
 const classes=new Map();
 for(const e of events){
  if(e.event!=='job-started')continue;
  const leased=Date.parse(e.leasedAt),due=Date.parse(e.dueAt);
  if(!Number.isFinite(leased)||!Number.isFinite(due)||leased<close)continue;
  if(typeof e.jobClass!=='string'||typeof e.jobId!=='string')throw Error('Qualified start event requires class and job identity');
  if(!classes.has(e.jobClass))classes.set(e.jobClass,{delays:[],first:new Map()});
  const c=classes.get(e.jobClass),delay=Math.max(0,leased-Math.max(due,close));c.delays.push(delay);
  if(!c.first.has(e.jobId))c.first.set(e.jobId,delay);
 }
 return {kind:freshClose?'observed-fresh-close':'recovery-after-close',closeObservedAt,byClass:Object.fromEntries([...classes].sort(([a],[b])=>a.localeCompare(b)).map(([key,c])=>[key,{allStarts:stats(c.delays),firstStartPerJob:stats([...c.first.values()])}]))};
}
