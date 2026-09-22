const activeURL=new URL('../../localnet/active-launch.mjs',import.meta.url).href;
const operatorURL=new URL('../../localnet/launch-active.mjs',import.meta.url).href;
let job=null;
export async function activeLaunchStatus(){return {campaign:await (await import(/* @vite-ignore */ activeURL)).readActive(),job};}
export async function startActiveLaunch(){
 if(job?.status==='running')return activeLaunchStatus();
 const state=await (await import(/* @vite-ignore */ activeURL)).readActive();
 if(!state.configured||state.phase!=='awaiting-launch'||state.chainTimeUnix<state.deadlineUnix||state.chainTimeUnix>=state.launchDeadlineUnix||BigInt(state.totalLamports)<BigInt(state.softCapLamports))throw Error('The active campaign is not ready to launch');
 if(job?.status==='running')return activeLaunchStatus();
 job={status:'running',startedAt:new Date().toISOString(),finishedAt:null,signature:null,error:null};const current=job;
 Promise.resolve().then(async()=>{const result=await (await import(/* @vite-ignore */ operatorURL)).launchActive();current.status='passed';current.signature=result.signature||null;}).catch(error=>{current.status='failed';current.error=error.message;}).finally(()=>{current.finishedAt=new Date().toISOString();});
 return {campaign:state,job:current};
}
