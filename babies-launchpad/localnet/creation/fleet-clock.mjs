// Chain-clock observation for fleet rehearsals. Financial deadlines are chain
// time; the wall clock only bounds the harness. A validator whose clock falls
// behind wall time makes a wall-bounded wait expire before funding closes on
// chain: that is an environment failure and must never be recorded as a
// throughput or latency result.
const MIN_WINDOW_MS=10000;
export function createChainClockMonitor({windowMs=60000,minRate=0.5,stallMs=120000}={}){
 if(!(windowMs>=MIN_WINDOW_MS)||!(minRate>0&&minRate<=1)||!(stallMs>=windowMs))throw Error('Invalid chain clock monitor bounds');
 const samples=[];let stalledSince=null,minObserved=null,maxObserved=null,firstLag=null,lastLag=null;
 const rate=()=>{if(samples.length<2)return null;const a=samples[0],b=samples[samples.length-1],wall=(b.wallMs-a.wallMs)/1000;return wall>=MIN_WINDOW_MS/1000?(b.chainSeconds-a.chainSeconds)/wall:null;};
 return {
  minRate,
  observe(wallMs,chainSeconds){
   if(!Number.isFinite(wallMs)||!Number.isFinite(chainSeconds))throw Error('Clock samples must be finite');
   samples.push({wallMs,chainSeconds});while(samples.length>2&&wallMs-samples[0].wallMs>windowMs)samples.shift();
   const r=rate(),lagSeconds=Math.round(wallMs/1000-chainSeconds);if(firstLag===null)firstLag=lagSeconds;lastLag=lagSeconds;
   if(r!==null){minObserved=minObserved===null?r:Math.min(minObserved,r);maxObserved=maxObserved===null?r:Math.max(maxObserved,r);if(r<minRate)stalledSince??=wallMs;else stalledSince=null;}
   return {rate:r,lagSeconds,stalledMs:stalledSince===null?0:wallMs-stalledSince};
  },
  rate,
  stalled(){return stalledSince!==null&&samples[samples.length-1].wallMs-stalledSince>=stallMs;},
  summary(){return {samples:samples.length,lastRate:rate(),minRate:minObserved,maxRate:maxObserved,firstLagSeconds:firstLag,lastLagSeconds:lastLag,stalledMs:stalledSince===null?0:samples[samples.length-1].wallMs-stalledSince,minAcceptableRate:minRate};}
 };
}
// Wall time to allow until a chain target should be reached at the observed
// rate, plus a fixed processing allowance, bounded by a hard ceiling.
export function wallBudgetMs({remainingChainSeconds,rate,allowanceMs,ceilingMs}){
 if(!Number.isFinite(allowanceMs)||allowanceMs<0||!Number.isFinite(ceilingMs)||ceilingMs<allowanceMs)throw Error('Invalid wall budget bounds');
 if(!Number.isFinite(remainingChainSeconds)||remainingChainSeconds<=0)return allowanceMs;
 const r=Number.isFinite(rate)&&rate>0?Math.min(rate,1.5):0.1;
 return Math.min(ceilingMs,Math.ceil(remainingChainSeconds/r*1000)+allowanceMs);
}
export const FLEET_EXPECTATIONS=Object.freeze(['launch','refund-window-expired']);
// What a resumed or fresh fixture is allowed to prove. An expired launch window
// is a supported failure path (full refunds), never a launch result; a run that
// expected launches refuses to continue against an expired cohort instead of
// timing out again.
export function fleetExpectation({expect='launch',chainNow,deadline,launchDeadline,phases=[]}){
 if(!FLEET_EXPECTATIONS.includes(expect))throw Error('Unknown fleet expectation: '+expect);
 chainNow=BigInt(chainNow);deadline=BigInt(deadline);launchDeadline=BigInt(launchDeadline);
 if(launchDeadline<=deadline)throw Error('Launch window must follow the funding deadline');
 const live=phases.filter(p=>p===3).length,windowElapsed=chainNow>=launchDeadline;
 if(expect==='launch'){
  if(windowElapsed&&live<phases.length)throw Object.assign(Error('Launch window elapsed on chain for '+(phases.length-live)+' campaign(s) ('+String(chainNow-launchDeadline)+' s ago); resume with the refund-window-expired expectation to qualify the failure path'),{code:'EXPIRED_WINDOW'});
  return {kind:'launch',chainTarget:deadline,requiresFeeWork:true};
 }
 if(!windowElapsed)throw Object.assign(Error('Launch window is still open on chain ('+String(launchDeadline-chainNow)+' s left); the refund path cannot be qualified yet'),{code:'WINDOW_OPEN'});
 if(live>0)throw Object.assign(Error(live+' campaign(s) already launched; the refund path applies only to unlaunched campaigns'),{code:'ALREADY_LIVE'});
 return {kind:'refund-window-expired',chainTarget:launchDeadline,requiresFeeWork:false};
}
// Separate environment failures from service-level failures in retained
// fixtures so a stalled validator is never read as a throughput result.
export function classifyFleetFailure(error,{closeObservedAt=null}={}){
 if(!error)return {kind:'none',reason:null};
 const code=error.code||null,message=String(error.message||error);
 if(code==='ENVIRONMENT_CHAIN_CLOCK')return {kind:'environment',reason:'chain clock',message};
 if(code==='EXPIRED_WINDOW'||code==='WINDOW_OPEN'||code==='ALREADY_LIVE')return {kind:'precondition',reason:code,message};
 if(code==='SLO_TIMEOUT')return {kind:closeObservedAt?'slo':'environment',reason:closeObservedAt?'wall budget exhausted after the chain close':'wall budget exhausted before the chain close',message};
 return {kind:'error',reason:code||'exception',message};
}
