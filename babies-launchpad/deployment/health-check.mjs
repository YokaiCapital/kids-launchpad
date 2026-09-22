import {pathToFileURL} from 'node:url';
const base='https://kids-private-localnet-production-9e71.up.railway.app';
export async function checkReadiness({fetchImpl=globalThis.fetch}={}){
 for(const [path,status] of [['/healthz','alive'],['/readyz','ready']]){
  const response=await fetchImpl(base+path,{signal:AbortSignal.timeout(15000),redirect:'error',headers:{accept:'application/json'}});
  if(response.status!==200)throw Error(path+' returned HTTP '+response.status);
  const body=await response.json();if(body.status!==status)throw Error(path+' reported unhealthy state');
 }
 return {network:'private-localnet',status:'ready'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.env.KIDS_SIMULATE_FAILURE==='true'){console.error('Private KIDS readiness failed: simulated failure requested to test alert delivery (no service was checked)');process.exit(1);}
 let failure;for(let attempt=0;attempt<3;attempt++){try{console.log(JSON.stringify(await checkReadiness()));failure=null;break;}catch(error){failure=error;if(attempt<2)await new Promise(r=>setTimeout(r,5000));}}
 if(failure){console.error('Private KIDS readiness failed:',failure.message);process.exitCode=1;}
}
