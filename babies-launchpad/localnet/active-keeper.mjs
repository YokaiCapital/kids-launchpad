// One bounded lifecycle decision per tick. The injected operations retain their own
// durable journals, RPC timeouts and on-chain checks. Never release this lease on a
// synthetic timeout while an underlying financial operation could still be running.
import {networkProfile,scopeFor} from './network.mjs';
const PROFILE=networkProfile();
const phases=new Set(['open','awaiting-launch','failed','launched']);
const identityKeys=['genesisHash','programId','escrowAddress','mint'];
function identity(state){
 if(state.network!==PROFILE.network||state.scope!==scopeFor(PROFILE)||state.version!==3||identityKeys.some(key=>typeof state[key]!=='string'||!state[key]))throw Error('Active keeper requires explicit v3 '+PROFILE.network+' identity');
 return JSON.stringify(identityKeys.map(key=>state[key]));
}
function clock(state){
 const values=[state.chainTimeUnix,state.deadlineUnix,state.launchDeadlineUnix];
 if(values.some(n=>!Number.isSafeInteger(n)||n<0)||state.launchDeadlineUnix<=state.deadlineUnix||!phases.has(state.phase))throw Error('Invalid active lifecycle clock or phase');
}
function amount(state,key){
 const value=state[key];if(typeof value!=='string'||!/^\d{1,20}$/.test(value)||BigInt(value)>18446744073709551615n)throw Error('Invalid active lifecycle amount: '+key);return BigInt(value);
}
export function createActiveLifecycleKeeper({read,settle,launch}){
 if([read,settle,launch].some(fn=>typeof fn!=='function'))throw Error('Active lifecycle operations are required');
 let running=false;
 return async function tick(){
  if(running)return {status:'busy'};running=true;
  try{
   const initial=await read();if(initial?.configured===false)return {status:'unconfigured'};
   if(initial?.configured!==true)throw Error('Active keeper state unavailable');
   const expected=identity(initial);clock(initial);
   if(initial.phase==='open')return {status:'open'};
   if(initial.chainTimeUnix<initial.deadlineUnix)throw Error('Closed campaign precedes funding deadline');
   // This also completes any remaining participant refunds after a successful launch.
   await settle();
   const state=await read();if(state?.configured!==true||identity(state)!==expected)throw Error('Active campaign identity changed during settlement');clock(state);
   if(state.chainTimeUnix<state.deadlineUnix||state.phase==='open')throw Error('Campaign reopened during settlement');
   if(state.phase==='launched')return {status:'launched'};
   if(state.phase==='failed'||state.chainTimeUnix>=state.launchDeadlineUnix)return {status:'refunding'};
   const soft=amount(state,'softCapLamports'),total=amount(state,'totalLamports'),accepted=amount(state,'settledAcceptedLamports'),count=amount(state,'receiptCount'),settled=amount(state,'settledReceiptCount');
   if(soft===0n||settled>count||accepted>total)throw Error('Invalid active settlement accounting');
   if(total<soft)return {status:'below-soft-cap'};
   if(count===0n||settled!==count||accepted<soft)return {status:'awaiting-settlement'};
   await launch();return {status:'launch-completed'};
  }finally{running=false;}
 };
}
