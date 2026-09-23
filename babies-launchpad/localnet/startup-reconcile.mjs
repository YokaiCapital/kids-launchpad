// Startup reconciliation: every intent and operator journal is checked AGAINST THE CHAIN before the API reopens
// financial writes (docs/ENGINEERING-RULES.md; architecture audit 23 Sep 2026). Retention/archival is a separate
// concern and never a substitute: rows below the archival threshold are inspected like any other. A signed row whose
// outcome is still unknown keeps writes closed; the runtime retries this pass until the answer is final or expired.
import {existsSync,readFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';
import {reconcileOperatorJournal} from './chain-reconcile.mjs';import {writeDurableJson} from '../shared/durable-json.mjs';
const runtime=fileURLToPath(new URL('./.runtime/',import.meta.url));
const OPERATOR_JOURNALS=[['launch-operator','active-launch-operator.json'],['settlement-operator','active-settlement-operator.json'],['fee-operator','active-fee-operator.json']];
async function operatorPass(name,file){
 const path=runtime+file;if(!existsSync(path))return {service:name,hot:0,signed:0,checked:0,unresolvedSigned:0,complete:true};
 const journal=JSON.parse(readFileSync(path,'utf8'));const {activeContext}=await import('./active-launch.mjs');const {connection}=await activeContext();
 return reconcileOperatorJournal({service:name,journal,connection,persist:()=>writeDurableJson(path,journal)});
}
export function defaultPasses(){
 return [
  ['escrow',async()=>(await import('./escrow.mjs')).reconcile()],
  ['active-launch',async()=>(await import('./active-launch.mjs')).reconcile()],
  ['postlaunch-claims',async()=>(await import('./postlaunch-claim-intents.mjs')).reconcilePostlaunchClaims()],
  ['postlaunch-trades',async()=>(await import('./postlaunch-trade.mjs')).reconcile()],
  ...OPERATOR_JOURNALS.map(([name,file])=>[name,()=>operatorPass(name,file)])
 ];
}
export async function reconcileJournals({log=()=>{},passes=defaultPasses()}={}){
 const started=Date.now(),services=[];
 for(const [name,run] of passes){
  const t=Date.now();
  try{const summary=await run();const complete=summary?.complete!==false;services.push({...summary,service:summary?.service||name,status:complete?'reconciled':'partial',ms:Date.now()-t});log({event:'startup-reconcile',service:name,...summary,ms:Date.now()-t});}
  catch(error){services.push({service:name,status:'failed',category:error?.category||'error',message:String(error?.message||error).replace(/api[-_]?key=[^&\s"')]+/gi,'api-key=<redacted>').slice(0,160),ms:Date.now()-t});log({event:'startup-reconcile-failed',service:name,ms:Date.now()-t});}
 }
 const unresolvedSigned=services.reduce((n,s)=>n+(s.unresolvedSigned||0),0);
 const complete=services.every(s=>s.status==='reconciled')&&unresolvedSigned===0;
 return {complete,unresolvedSigned,services,ms:Date.now()-started,at:new Date().toISOString()};
}
