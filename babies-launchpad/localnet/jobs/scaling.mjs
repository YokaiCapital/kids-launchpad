// Private capacity decisions, never signing authority. The deployment controller
// must persist acknowledged provider changes, not assume this advice was applied.
import {WORKER_LANES} from './lanes.mjs';
const integer=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
const order=['recovery','lifecycle','accounting','harvest','economics','provisioning','indexing','backfill','maintenance'];
export function planWorkerScale({snapshot,policy,deployment,history={},now=Date.now()}){
 if(!integer(now,0,Number.MAX_SAFE_INTEGER)||!policy||!integer(policy.maxTotalReplicas,1,256)||!policy.lanes||!Object.keys(policy.lanes).length)throw Error('Explicit bounded scaling policy required');
 const config=Object.entries(policy.lanes);let minima=0,currentTotal=0;
 for(const [lane,p]of config){
  if(!Object.hasOwn(WORKER_LANES,lane)||!integer(p?.minimum,1,32)||!integer(p.maximum,p.minimum,64)||!integer(p.slotsPerReplica,1,64)||!integer(p.measuredJobMs,1,300000)||!integer(p.maxStep,1,8)||!integer(p.cooldownMs,30000,3600000)||!integer(p.idleMs,300000,86400000)||typeof p.needsSigner!=='boolean'||![0,60000,300000,600000].includes(p.prewarmMs??0))throw Error('Invalid measured lane scaling policy');
  if(!integer(deployment?.[lane],0,64))throw Error('Provider replica inventory required');
  const h=history[lane];if(h&&(!integer(h.lastAppliedAt,0,now)||h.idleSince!==null&&!integer(h.idleSince,0,now)))throw Error('Invalid acknowledged scaling history');
  minima+=p.minimum;currentTotal+=deployment[lane];
 }
 if(minima>policy.maxTotalReplicas)throw Error('Global ceiling cannot cover independent warm minima');
 const at=Date.parse(snapshot?.observedAt),fresh=snapshot?.version===1&&Number.isFinite(at)&&at<=now&&now-at<=25000;
 if(!fresh)return {version:1,observedAt:new Date(now).toISOString(),status:'blocked',reason:'stale-observation',decisions:[],apply:false};
 const decisions=[];let available=Math.max(0,policy.maxTotalReplicas-currentTotal),reservedMinimum=config.reduce((n,[lane,p])=>n+Math.max(0,p.minimum-deployment[lane]),0);
 for(const lane of order.filter(x=>Object.hasOwn(policy.lanes,x))){
  const p=policy.lanes[lane],q=snapshot.lanes?.[lane],presence=snapshot.presence?.lanes?.[lane],current=deployment[lane],h=history[lane];
  const hold=reason=>decisions.push({lane,current,desired:current,reason});
  if(!q||!presence||!['due','leased','failed','unknownTransactions','fundingWait','capacityWait','oldestDueMs','targetMs'].every(k=>integer(q[k],0,Number.MAX_SAFE_INTEGER))||q.targetMs<1||!integer(presence.active,0,4096)||!integer(presence.alive,0,256)){hold('incomplete-observation');continue;}
  if(!integer(presence.minimum,1,100)||p.minimum<presence.minimum||!integer(presence.capacity,0,16384)||presence.capacity!==presence.alive*p.slotsPerReplica){hold('deployment-policy-mismatch');continue;}
  if(current>p.maximum||currentTotal>policy.maxTotalReplicas){hold('configured-ceiling-breached');continue;}
  const needs=[['rpc',lane],...(p.needsSigner?[['signer',lane],['signerRpc','signer']]:[])];
  const missing=needs.some(([kind,channel])=>snapshot.admission?.[kind]?.status!=='observed'||!snapshot.admission[kind].lanes?.[channel]);
  const saturated=needs.some(([kind,channel])=>{const a=snapshot.admission?.[kind]?.lanes?.[channel];return a&&(a.retryAfterMs>0||a.availableRequests===0&&q.capacityWait>0);});
  const unsafe=!snapshot.authority||['missing','expired','revoked'].some(k=>!integer(snapshot.authority[k],0,Number.MAX_SAFE_INTEGER)||snapshot.authority[k]>0);
  const demand=q.scaleDemand;
  if(demand&&(!['due','blockedFunding','blockedAuthority'].every(k=>integer(demand[k],0,Number.MAX_SAFE_INTEGER))||demand.due>q.due||!['within60s','within300s','within600s'].every(k=>integer(demand.scheduled?.[k],0,Number.MAX_SAFE_INTEGER)&&demand.scheduled[k]<=q.scheduled?.[k]))){hold('incomplete-demand-observation');continue;}
  if(presence.alive<current){hold('worker-recovery-required');continue;}
  if(q.signerSpendWait!==undefined&&!integer(q.signerSpendWait,0,Number.MAX_SAFE_INTEGER)){hold('incomplete-observation');continue;}
  if(p.needsSigner&&q.signerSpendWait>0){hold('signer-spend-limit');continue;}
  // Legacy observations remain fail-closed. New observations isolate blocked
  // campaigns without allowing their backlog to inflate healthy lane demand.
  if(missing||saturated||!demand&&(q.fundingWait||p.needsSigner&&unsafe)){hold(missing?'admission-unavailable':saturated?'upstream-saturated':q.fundingWait?'operating-funding':'authority-unavailable');continue;}
  const horizon={60000:'within60s',300000:'within300s',600000:'within600s'}[p.prewarmMs],scheduled=horizon?(demand??q).scheduled?.[horizon]:0,due=demand?.due??q.due;
  if(!integer(scheduled,0,Number.MAX_SAFE_INTEGER)){hold('schedule-observation-unavailable');continue;}
  const minimumNeeded=Math.max(p.minimum,Math.ceil(q.leased/p.slotsPerReplica)+Math.ceil((due+scheduled)*p.measuredJobMs/q.targetMs/p.slotsPerReplica));
  let desired=Math.min(p.maximum,minimumNeeded),reason='within-capacity';
  if(current<p.minimum){desired=Math.min(p.minimum,current+p.maxStep);reason='restore-warm-minimum';}
  else if(h&&now-h.lastAppliedAt<p.cooldownMs){hold('cooldown');continue;}
  else if(desired>current){desired=Math.min(desired,current+p.maxStep);reason=scheduled?'scheduled-work':'due-work';}
  else if(desired<current){
   // Never remove capacity around active/uncertain money work or a missing process.
   const idle=scheduled===0&&q.due===0&&q.leased===0&&q.failed===0&&q.unknownTransactions===0&&presence.active===0&&presence.alive>=current;
   if(!idle||h?.idleSince==null||now-h.idleSince<p.idleMs){hold('drain-or-idle-window');continue;}
   desired=Math.max(p.minimum,current-1);reason='sustained-idle';
  }
  if(desired>current){const restoring=current<p.minimum,granted=Math.min(desired-current,Math.max(0,available-(restoring?0:reservedMinimum)));desired=current+granted;available-=granted;if(restoring)reservedMinimum-=granted;if(!granted)reason='global-ceiling';}
  // Do not spend a hoped-for downscale before the provider acknowledges it.
  decisions.push({lane,current,desired,reason});
 }
 return {version:1,observedAt:new Date(now).toISOString(),status:decisions.some(d=>d.current!==d.desired)?'change-proposed':'hold',decisions,apply:false};
}
