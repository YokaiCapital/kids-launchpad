// Dedicated operator command, never an API route or a worker responsibility.
// Private config holds exact scope and non-secret quota resource names. A
// monitoring collector may run this on an internal schedule; failures exit 1 and
// never reuse an earlier healthy snapshot. Database credentials stay in env.
import {readFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
import {PostgresRegistry} from '../registry/registry.mjs';
import {createWorkerObserver,workerPrometheus} from './observability.mjs';
import {planWorkerScale} from './scaling.mjs';
export async function main(env=process.env,args=process.argv.slice(2)){
 if(args.length>1||args.length===1&&!['--prometheus','--scaling'].includes(args[0]))throw Error('Use JSON, --prometheus or --scaling output');
 if(!env.KIDS_OBSERVER_CONFIG||!env.KIDS_REGISTRY_URL?.startsWith('postgres'))throw Error('Private observer config and database required');
 const config=JSON.parse(readFileSync(env.KIDS_OBSERVER_CONFIG,'utf8'));
 const registry=new PostgresRegistry({connectionString:env.KIDS_REGISTRY_URL,max:1});
 try{const snapshot=await createWorkerObserver({registry,...config}).read();const output=args[0]==='--scaling'?planWorkerScale({snapshot,policy:config.scaling?.policy,deployment:config.scaling?.deployment,history:config.scaling?.history}):snapshot;process.stdout.write(args[0]==='--prometheus'?workerPrometheus(snapshot):JSON.stringify(output)+'\n');}
 finally{await registry.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{
 console.error(JSON.stringify({event:'worker-observation-unavailable'}));process.exitCode=1;
});
