// Process-wide operational status for the real-network service: keeper heartbeats, signer reachability, disk space,
// reconciliation and admission facts. Served on /_health/status (loopback) and /statusz (gateway, public, no secrets).
import {statfsSync} from 'node:fs';
const keepers={};let signer={configured:false,ok:null,checkedAt:null,publicKey:null},reconciliation=null,writesOpen=null,extra={};
export async function runKeeper(name,fn){const started=Date.now();try{const result=await fn();keepers[name]={lastAt:started,ms:Date.now()-started,status:result?.status||'ok',error:null};return result;}catch(error){keepers[name]={lastAt:started,ms:Date.now()-started,status:'error',error:String(error?.message||error).replace(/api[-_]?key=[^&\s"')]+/gi,'api-key=<redacted>').slice(0,160)};throw error;}}
export function setSignerStatus(next){signer={...signer,...next};}
export function setReconciliation(report,open){reconciliation=report?{complete:!!report.complete,unresolvedSigned:report.unresolvedSigned??null,expiredUnverified:report.expiredUnverified??0,at:report.at??null,services:(report.services||[]).map(s=>({service:s.service,status:s.status,unresolvedSigned:s.unresolvedSigned??0}))}:null;writesOpen=open;}
export function setExtra(patch){extra={...extra,...patch};}
/** Market feed (localnet/market): connected, lag, gaps, decode failures. A growing decode-failure count within the last ten minutes is a problem; lag above 120 s is a warning. */
let market=null,marketDecodeIncreaseAt=null;
export const MARKET_LAG_WARNING_SECONDS=120,MARKET_DECODE_WINDOW_MS=600000;
export function setMarketStatus(next,now=Date.now()){if(next===null){market=null;marketDecodeIncreaseAt=null;return;}if(market&&Number(next.decodeFailures)>Number(market.decodeFailures))marketDecodeIncreaseAt=now;market={...next,checkedAt:now};}
let activity=null;export function setActivityStatus(next,now=Date.now()){activity=next?{...next,checkedAt:now}:null;}
export function activityWarnings(a){const w=[];if(!a||a.enabled===false||!a.running)return w;if(a.connected===false)w.push('activity feed disconnected');if(a.lagSeconds!=null&&a.lagSeconds>MARKET_LAG_WARNING_SECONDS)w.push('activity feed lag: '+a.lagSeconds+' s');if(a.openGaps>0)w.push('activity feed gaps: '+a.openGaps);return w;}
export function marketWarnings(m){const w=[];if(!m||m.enabled===false||!m.running)return w;if(m.connected===false)w.push('market feed disconnected');if(m.lagSeconds!=null&&m.lagSeconds>MARKET_LAG_WARNING_SECONDS)w.push('market feed lag: '+m.lagSeconds+' s');if(m.openGaps>0)w.push('market history has '+m.openGaps+' open gap'+(m.openGaps===1?'':'s'));if(m.unsupported>0)w.push('market skipped '+m.unsupported+' transaction'+(m.unsupported===1?'':'s')+' of an unsupported version');return w;}
export function diskStatus(path){try{const s=statfsSync(path);const total=Number(s.blocks)*Number(s.bsize),free=Number(s.bavail)*Number(s.bsize);return {path,totalBytes:total,freeBytes:free,freePercent:total?Math.round(free*1000/total)/10:null};}catch{return {path,error:'unavailable'};}}
/** The body served on the public /statusz: counts, flags and ages only; no paths, no error text, no keys (application review, 28 September 2026, L1). */
export function publicStatusBody(s){
 if(!s||typeof s!=='object')throw Error('Status body required');
 const pick=(o,keys)=>o&&typeof o==='object'?Object.fromEntries(keys.filter(k=>k in o).map(k=>[k,o[k]])):null;
 return {
  status:s.status,at:s.at??null,writesOpen:s.writesOpen??null,
  reconciliation:pick(s.reconciliation,['complete','unresolvedSigned','expiredUnverified','at']),
  keepers:Object.fromEntries(Object.entries(s.keepers||{}).map(([k,v])=>[k,{status:v?.status??null,ageSeconds:v?.ageSeconds??null,ms:v?.ms??null}])),
  signer:pick(s.signer,['configured','ok','ageSeconds']),
  disk:pick(s.disk,['freePercent']),
  market:pick(s.market,['enabled','running','connected','lagSeconds','openGaps','unsupported','decodeFailures','decodeFailuresGrowing','ageSeconds','warnings']),
  activity:pick(s.activity,['enabled','running','connected','lagSeconds','openGaps','warnings']),
  // Hosted creator flow: how many `kids` addresses are ready for the next launches (counts only).
  mintReserve:pick(s.mintReserve,['available','reserved','signed','quarantined','target']),
  registry:s.registry&&typeof s.registry==='object'?{...pick(s.registry,['configured','driver','lastImportAt','lastAttemptAt','campaigns','conflicts','skipped','runs']),lastError:pick(s.registry.lastError,['category','at'])}:null,
  release:pick(s.release,['configured','network','genesisHash','programId','binarySha256','registrySchemaVersion','checks']),
  campaign:pick(s.campaign,['configured','phase','campaign','mint','pool']),
  publicLaunch:s.publicLaunch??null,
 };
}
export function statusSnapshot({ready,runtimePath}){
 const now=Date.now();
 return {status:ready?'ready':'unavailable',at:new Date(now).toISOString(),writesOpen,reconciliation,keepers:Object.fromEntries(Object.entries(keepers).map(([k,v])=>[k,{...v,ageSeconds:Math.round((now-v.lastAt)/1000)}])),signer:{...signer,ageSeconds:signer.checkedAt?Math.round((now-signer.checkedAt)/1000):null},disk:runtimePath?diskStatus(runtimePath):null,activity:activity?{...activity,warnings:activityWarnings(activity)}:null,market:market?{...market,ageSeconds:Math.round((now-market.checkedAt)/1000),decodeFailuresGrowing:marketDecodeIncreaseAt!==null&&now-marketDecodeIncreaseAt<MARKET_DECODE_WINDOW_MS,warnings:marketWarnings(market)}:null,...extra};
}
/** Threshold checks used by the external monitor. Returns a list of problems (empty = healthy). */
export function evaluateStatus(snapshot,{campaignConfigured=true,keeperMaxAgeSeconds=600,minFreePercent=10,signerRequired=false}={}){
 const problems=[];
 if(snapshot.status!=='ready')problems.push('service not ready');
 if(snapshot.writesOpen===false)problems.push('financial writes closed');
 if(snapshot.reconciliation&&snapshot.reconciliation.unresolvedSigned>0)problems.push('unresolved signed intents: '+snapshot.reconciliation.unresolvedSigned);
 if(campaignConfigured)for(const name of ['active','fees']){const k=snapshot.keepers?.[name];if(!k)problems.push('keeper '+name+' has never run');else{if(k.ageSeconds>keeperMaxAgeSeconds)problems.push('keeper '+name+' stale: '+k.ageSeconds+' s');if(k.status==='error')problems.push('keeper '+name+' error: '+k.error);}}
 if(snapshot.signer?.configured&&snapshot.signer.ok===false)problems.push('signer unreachable');if(signerRequired&&!snapshot.signer?.configured)problems.push('signer not configured');
 if(snapshot.disk?.freePercent!=null&&snapshot.disk.freePercent<minFreePercent)problems.push('disk free '+snapshot.disk.freePercent+'%');
 if(snapshot.market?.decodeFailuresGrowing)problems.push('market decode failures growing: '+snapshot.market.decodeFailures);
 // Pilot API: the public-launch observer's aggregate (status-observer.mjs). Unavailable is a problem, never a pass.
 if(snapshot.publicLaunch){const p=snapshot.publicLaunch;if(p.status==='unavailable')problems.push('public-launch observation unavailable');else if(Array.isArray(p.alerts)&&p.alerts.length)problems.push('public-launch alerts: '+[...new Set(p.alerts.map(a=>a.code+'@'+a.lane))].sort().join(', '));}
 return problems;
}
