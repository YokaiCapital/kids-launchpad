// External monitor (GitHub schedule every 15 minutes, architecture audit item 6): checks the MAINNET service, the test
// ledger and kids.fun, with thresholds on the status page (keeper heartbeat age, unresolved signed intents, writes
// open, signer reachable, disk free). Any failure fails the workflow, which emails the owner.
import {pathToFileURL} from 'node:url';
import {evaluateStatus} from '../shared/service-status.mjs';
export const TARGETS=[
 {name:'mainnet-api',base:'https://kids-api-production-fc8e.up.railway.app',required:true,signerRequired:false},
 {name:'test-ledger',base:'https://kids-private-localnet-production-9e71.up.railway.app',required:false,signerRequired:false},
];
export const SITE='https://kids.fun/';
export async function checkTarget(target,{fetchImpl=globalThis.fetch}={}){
 for(const [path,status] of [['/healthz','alive'],['/readyz','ready']]){
  const response=await fetchImpl(target.base+path,{signal:AbortSignal.timeout(15000),redirect:'error',headers:{accept:'application/json'}});
  if(response.status!==200)throw Error(target.name+' '+path+' returned HTTP '+response.status);
  const body=await response.json();if(body.status!==status)throw Error(target.name+' '+path+' reported unhealthy state');
 }
 const status=await fetchImpl(target.base+'/statusz',{signal:AbortSignal.timeout(15000),redirect:'error',headers:{accept:'application/json'}});
 if(status.status!==200)throw Error(target.name+' /statusz returned HTTP '+status.status);
 const snapshot=await status.json();const campaignConfigured=snapshot.campaign?.configured!==false&&Object.keys(snapshot.keepers||{}).length>0;
 const problems=evaluateStatus(snapshot,{campaignConfigured,signerRequired:target.signerRequired});
 if(problems.length)throw Error(target.name+': '+problems.join('; '));
 return {name:target.name,status:'ready',keepers:Object.keys(snapshot.keepers||{}),writesOpen:snapshot.writesOpen,unresolvedSigned:snapshot.reconciliation?.unresolvedSigned??null,diskFreePercent:snapshot.disk?.freePercent??null};
}
export async function checkSite({fetchImpl=globalThis.fetch}={}){
 const response=await fetchImpl(SITE,{signal:AbortSignal.timeout(15000),redirect:'manual'});
 if(response.status!==200)throw Error('kids.fun returned HTTP '+response.status);const html=await response.text();if(!/KIDS/.test(html))throw Error('kids.fun served an unexpected page');return {site:'kids.fun',status:'gated'};
}
export async function checkReadiness(options={}){
 const results=[];const failures=[];
 for(const target of TARGETS){try{results.push(await checkTarget(target,options));}catch(error){if(target.required)failures.push(error.message);else results.push({name:target.name,status:'warning',message:error.message});}}
 try{results.push(await checkSite(options));}catch(error){failures.push(error.message);}
 if(failures.length)throw Error(failures.join(' | '));
 return {status:'ready',results};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.env.KIDS_SIMULATE_FAILURE==='true'){console.error('KIDS readiness failed: simulated failure requested to test alert delivery (no service was checked)');process.exit(1);}
 let failure;for(let attempt=0;attempt<3;attempt++){try{console.log(JSON.stringify(await checkReadiness()));failure=null;break;}catch(error){failure=error;if(attempt<2)await new Promise(r=>setTimeout(r,5000));}}
 if(failure){console.error('KIDS readiness failed:',failure.message);process.exitCode=1;}
}
