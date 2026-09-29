// Fixed localnet test command only. Never accepts RPC URLs, keys, shell text or arguments from HTTP.
import {spawn} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../../localnet/full-launch-verify.mjs',import.meta.url));
const feesPath=new URL('../../localnet/.runtime/atomic-fees-verification.json',import.meta.url);
const reportPath=new URL('../../localnet/.runtime/atomic-launch-verification.json',import.meta.url);
let job=null;
function lastReport(){if(!existsSync(reportPath))return null;const r=JSON.parse(readFileSync(reportPath,'utf8'));const fees=existsSync(feesPath)?JSON.parse(readFileSync(feesPath,'utf8')):null;const matchingFees=fees?.campaign===r.campaign&&fees.programSha256===r.programSha256?fees:null;return {claims:r.claims,fees:matchingFees?{state:matchingFees.state,burns:matchingFees.burns,checks:matchingFees.checks,limitations:matchingFees.limitations}:null,network:r.network,programId:r.programId,programSha256:r.programSha256,campaign:r.campaign,pool:r.pool,mint:r.mint,feeNft:r.feeNft,signature:r.signature,committedLamports:r.committedLamports,acceptedLamports:r.acceptedLamports,refundedLamports:r.refundedLamports,checks:r.checks,limitations:r.limitations};}
export function rehearsalStatus(){return {job:job?{status:job.status,startedAt:job.startedAt,finishedAt:job.finishedAt,error:job.error,stage:job.stage}:null,report:lastReport()};}
export async function startRehearsal(){
 if(job?.status==='running')return rehearsalStatus();
 // Verify ledger and deployed binary before enabling any fixture signing.
 const {atomicContext}=await import('../../localnet/atomic-launch.mjs');await atomicContext();
 if(job?.status==='running')return rehearsalStatus();
 const current={status:'running',startedAt:new Date().toISOString(),finishedAt:null,error:null,stage:'launch-and-claims'};job=current;
 const child=spawn(process.execPath,[script],{cwd:fileURLToPath(new URL('../../',import.meta.url)),stdio:['ignore','pipe','pipe']});let output='';
 const capture=data=>{const chunk=data.toString();output=(output+chunk).slice(-12000);const match=chunk.match(/KIDS_STAGE:(launch-and-claims|fees-and-parent-burns|complete)/);if(match)current.stage=match[1];};child.stdout.on('data',capture);child.stderr.on('data',capture);
 const timer=setTimeout(()=>{current.error='Local launch test exceeded its time limit';child.kill('SIGTERM');},300000);
 child.once('error',()=>{clearTimeout(timer);current.status='failed';current.error='Unable to start the local launch test';current.finishedAt=new Date().toISOString();});
 child.once('close',code=>{clearTimeout(timer);current.status=code===0?'passed':'failed';current.finishedAt=new Date().toISOString();if(code!==0&&!current.error)current.error='Local launch test failed. No production funds were used. Check the local server log.';if(code!==0)console.error('[KIDS local launch test]',output);});
 return rehearsalStatus();
}
