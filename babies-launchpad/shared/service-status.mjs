// Process-wide operational status for the real-network service: keeper heartbeats, signer reachability, disk space,
// reconciliation and admission facts. Served on /_health/status (loopback) and /statusz (gateway, public, no secrets).
import {statfsSync} from 'node:fs';
const keepers={};let signer={configured:false,ok:null,checkedAt:null,publicKey:null},reconciliation=null,writesOpen=null,extra={};
export async function runKeeper(name,fn){const started=Date.now();try{const result=await fn();keepers[name]={lastAt:started,ms:Date.now()-started,status:result?.status||'ok',error:null};return result;}catch(error){keepers[name]={lastAt:started,ms:Date.now()-started,status:'error',error:String(error?.message||error).replace(/api[-_]?key=[^&\s"')]+/gi,'api-key=<redacted>').slice(0,160)};throw error;}}
export function setSignerStatus(next){signer={...signer,...next};}
export function setReconciliation(report,open){reconciliation=report?{complete:!!report.complete,unresolvedSigned:report.unresolvedSigned??null,at:report.at??null,services:(report.services||[]).map(s=>({service:s.service,status:s.status,unresolvedSigned:s.unresolvedSigned??0}))}:null;writesOpen=open;}
export function setExtra(patch){extra={...extra,...patch};}
export function diskStatus(path){try{const s=statfsSync(path);const total=Number(s.blocks)*Number(s.bsize),free=Number(s.bavail)*Number(s.bsize);return {path,totalBytes:total,freeBytes:free,freePercent:total?Math.round(free*1000/total)/10:null};}catch{return {path,error:'unavailable'};}}
export function statusSnapshot({ready,runtimePath}){
 const now=Date.now();
 return {status:ready?'ready':'unavailable',at:new Date(now).toISOString(),writesOpen,reconciliation,keepers:Object.fromEntries(Object.entries(keepers).map(([k,v])=>[k,{...v,ageSeconds:Math.round((now-v.lastAt)/1000)}])),signer:{...signer,ageSeconds:signer.checkedAt?Math.round((now-signer.checkedAt)/1000):null},disk:runtimePath?diskStatus(runtimePath):null,...extra};
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
 return problems;
}
