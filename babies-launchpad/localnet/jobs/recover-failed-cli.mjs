// Owner command behind deployment/hosted/pilot-recover-job.sh: the audited recovery of ONE permanently failed job, or the
// audited binding repair of ONE queued, never-leased operating-refill row.
//
//   node localnet/jobs/recover-failed-cli.mjs --job <job id> --reason <reason> --recovery-id <id> --dry-run
//   node localnet/jobs/recover-failed-cli.mjs --job <job id> --reason <reason> --recovery-id <id> \
//        --expected-token <n> --expected-hash <sha256> --genesis <hash> --program <address> --campaign <address> [--actor <name>]
//   node localnet/jobs/recover-failed-cli.mjs --action bind-refill --job <job id> --recovery-id <id> [--dry-run | --expected-token 0 --genesis … --program … --campaign …]
//
// The dry run prints the row as reviewed and the exact write command (the owner wrapper with every reviewed value filled in). The write path never derives its preconditions
// from the current row: it requires the reviewed token, result hash (requeue) and campaign scope, re-reads the row, refuses
// if anything differs, and only then calls the audited function (which repeats the checks inside its transaction).
// Output: JSON lines (before, invocation | recovery/repair, after); a "refused" line comes with exit code 2.
import {PostgresRegistry} from '../registry/registry.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {recoverFailedJob,repairRefillBinding} from './recover-failed.mjs';
const OPTIONS=Object.freeze({job:'value',reason:'value','recovery-id':'value',actor:'value',action:'value','expected-token':'value','expected-hash':'value',genesis:'value',program:'value',campaign:'value','dry-run':'flag'});
/** Fails closed: unknown flags, duplicates and missing values are errors before anything else happens. */
export function parseArgs(argv){
 const out={};
 for(let i=0;i<argv.length;i++){
  const raw=argv[i];if(typeof raw!=='string'||!raw.startsWith('--')||raw.length<3)throw Error('Unexpected argument '+String(raw));
  const name=raw.slice(2);const kind=OPTIONS[name];if(!kind)throw Error('Unknown option --'+name);
  if(Object.prototype.hasOwnProperty.call(out,name))throw Error('Duplicate option --'+name);
  if(kind==='flag'){out[name]=true;continue;}
  const value=argv[++i];if(typeof value!=='string'||value.startsWith('--')||!value)throw Error('Missing value for --'+name);
  out[name]=value;
 }
 const action=out.action??'requeue';if(!['requeue','bind-refill'].includes(action))throw Error('--action must be requeue or bind-refill');
 for(const k of ['job','recovery-id'])if(!out[k])throw Error('--'+k+' is required');
 if(action==='requeue'&&!out.reason)throw Error('--reason is required');
 if(out['dry-run']){for(const k of ['expected-token','expected-hash','genesis','program','campaign'])if(out[k]!==undefined)throw Error('--'+k+' belongs to the write path, not to --dry-run');}
 else{
  for(const k of ['expected-token','genesis','program','campaign'])if(!out[k])throw Error('--'+k+' is required for the write path (take it from the dry run)');
  if(!/^(0|[1-9][0-9]{0,15})$/.test(out['expected-token']))throw Error('--expected-token must be a whole number');
  if(action==='requeue'&&!/^[a-f0-9]{64}$/.test(out['expected-hash']??''))throw Error('--expected-hash must be the 64-hex result hash from the dry run');
  if(action==='bind-refill'&&out['expected-hash']!==undefined)throw Error('--expected-hash is not used by bind-refill');
 }
 return {...out,action,dryRun:out['dry-run']===true,actor:out.actor??'owner-terminal'};
}
const q=v=>"'"+String(v).replace(/'/g,"'\\''")+"'";
export async function main(argv=process.argv.slice(2),env=process.env,out=console.log,{registryFactory=url=>new PostgresRegistry({connectionString:url,max:2})}={}){
 const a=parseArgs(argv);
 if(!env.KIDS_REGISTRY_URL)throw Error('KIDS_REGISTRY_URL is required');
 const registry=registryFactory(env.KIDS_REGISTRY_URL);
 try{
  const row=(await registry.query('SELECT job_id,genesis_hash,program_id,campaign,job_class,state,fencing_token,lease_owner,payload_json,result_json FROM jobs WHERE job_id=?',[a.job])).rows[0];
  if(!row)throw Object.assign(Error('Job not found'),{code:'NOT_FOUND'});
  const result=JSON.parse(row.result_json||'null'),payload=JSON.parse(row.payload_json||'null');
  const before={jobClass:row.job_class,state:row.state,token:String(row.fencing_token),genesis:row.genesis_hash,program:row.program_id,campaign:row.campaign,...(a.action==='requeue'?{category:result?.category??null,reason:result?.reason??null,resultHash:result?canonicalHash(result):null}:{leaseOwner:row.lease_owner,hasBinding:!!payload?.binding})};
  out(JSON.stringify({before}));
  if(a.dryRun){
   const write=['--action',a.action,'--job',a.job,...(a.action==='requeue'?['--reason',a.reason,'--expected-hash',before.resultHash??'(no result)']:[]),'--recovery-id',a['recovery-id'],'--expected-token',before.token,'--genesis',row.genesis_hash,'--program',row.program_id,'--campaign',row.campaign,'--actor',a.actor];
   out(JSON.stringify({dryRun:true,invocation:'zsh deployment/hosted/pilot-recover-job.sh '+write.map(q).join(' ')}));return 0;
  }
  // Compare the reviewed revision with the row as it is now; never refresh the reviewed values from the row.
  const differs=[];
  if(String(row.fencing_token)!==a['expected-token'])differs.push('fencing token '+row.fencing_token+' (reviewed '+a['expected-token']+')');
  for(const [k,v] of [['genesis',row.genesis_hash],['program',row.program_id],['campaign',row.campaign]])if(a[k]!==v)differs.push(k+' differs');
  if(a.action==='requeue'&&(before.resultHash??'')!==a['expected-hash'])differs.push('result hash differs from the reviewed one');
  if(differs.length)throw Object.assign(Error('Reviewed revision no longer matches the row: '+differs.join('; ')),{code:'RECOVERY_CONFLICT'});
  const scope={genesisHash:a.genesis,programId:a.program,campaign:a.campaign};
  if(a.action==='bind-refill'){
   const repair=await repairRefillBinding({registry,jobId:a.job,recoveryId:a['recovery-id'],actor:a.actor});
   out(JSON.stringify({repair}));
   const after=(await registry.query('SELECT state,fencing_token,payload_json FROM jobs WHERE job_id=?',[a.job])).rows[0];
   out(JSON.stringify({after:{state:after.state,token:String(after.fencing_token),binding:JSON.parse(after.payload_json||'null')?.binding??null}}));
   return 0;
  }
  const recovery=await recoverFailedJob({registry,identity:scope,jobId:a.job,expectedToken:Number(a['expected-token']),expectedResultHash:a['expected-hash'],recoveryId:a['recovery-id'],actor:a.actor,reason:a.reason});
  out(JSON.stringify({recovery}));
  const after=(await registry.query('SELECT state,fencing_token,not_before,retry_count FROM jobs WHERE job_id=?',[a.job])).rows[0];
  out(JSON.stringify({after:{state:after.state,token:String(after.fencing_token),notBefore:after.not_before,retryCount:after.retry_count}}));
  return 0;
 }catch(error){
  out(JSON.stringify({refused:true,code:error.code??null,message:error.message}));return 2;
 }finally{await registry.close?.().catch(()=>{});}
}
if(import.meta.url===new URL(process.argv[1],'file:').href){main().then(code=>{process.exitCode=code;},error=>{console.error(error.message);process.exitCode=1;});}
