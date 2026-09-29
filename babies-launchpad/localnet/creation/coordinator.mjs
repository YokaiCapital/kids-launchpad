import {randomUUID} from 'node:crypto';
const walletStages=new Set(['launch','mint','native-custody','create-campaign','operating-reserve']);
const terminal=s=>s.stage==='complete'||s.action==='none';
const wallet=s=>s.action==='prepare'&&walletStages.has(s.stage);
/** Durable work contains identifiers and observations only. Approval bytes stay in the existing packet journal. */
export function createCreationCoordinator({registry,flow,owner,activate=null,supplement=null,canRun=()=>true,log=()=>{},intervalMs=500,leaseMs=60000}){
 if(registry?.driver!=='postgres'||!owner||leaseMs<1000)throw Error('Shared creation coordinator required');
 const q=(s,p=[])=>registry.query(s,p),worker=randomUUID();let closed=false,running=null,timer=null;
 const now=async()=>Number((await q('SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) AS ms')).rows[0].ms);
 async function wake(id){
  await q("UPDATE creation_work SET state='queued',next_run=0,error_code=NULL,failures=0 WHERE request_id=? AND state IN ('wallet','paused','done') AND EXISTS(SELECT 1 FROM creation_requests r WHERE r.request_id=creation_work.request_id AND r.owner=?)",[id,owner]);
 }
 async function read(id){return (await q('SELECT w.* FROM creation_work w JOIN creation_requests r ON r.request_id=w.request_id WHERE w.request_id=? AND r.owner=?',[id,owner])).rows[0];}
 async function status(o,input){
  const s=await flow.status(o,input),work=o===owner?await read(input.requestId):null;
  const observation=work?.result_json?JSON.parse(work.result_json):null;
  return {...s,serverManaged:true,workerActivation:!!work?.activated_at,activationReady:!!work?.activated_at,serverWork:work?.state??'queued',serverError:work?.error_code??null,
   ...(observation?.signature&&observation.signature===s.signature&&observation.reason==='awaiting-finality'?{confirmation:{signature:observation.signature,commitment:'confirmed'}}:{})};
 }
 async function tick(){
  if(closed||running||!canRun())return running;
  running=(async()=>{
   const at=await now();
   const row=await registry.transaction(async()=>{
    const r=(await q("SELECT w.* FROM creation_work w JOIN creation_requests r ON r.request_id=w.request_id WHERE r.owner=? AND r.state='accepted' AND ((w.state='queued' AND w.next_run<=?) OR (w.state='leased' AND w.lease_until<=?)) ORDER BY w.next_run,w.updated_at LIMIT 1 FOR UPDATE OF w SKIP LOCKED",[owner,at,at])).rows[0];
    if(!r)return null;
    const result=await q("UPDATE creation_work SET state='leased',lease_owner=?,lease_until=?,fencing_token=fencing_token+1,attempts=attempts+1,updated_at=? WHERE request_id=? RETURNING *",[worker,at+leaseMs,at,r.request_id]);return result.rows[0];
   });
   if(!row)return;
   const started=performance.now(),input={requestId:row.request_id};let phase='queued',result=null,error=null;
   const heartbeat=setInterval(()=>{q("UPDATE creation_work SET lease_until=CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT)+? WHERE request_id=? AND fencing_token=? AND lease_owner=? AND state='leased' AND lease_until>CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT)",[leaseMs,row.request_id,row.fencing_token,worker]).catch(()=>{});},Math.max(250,Math.floor(leaseMs/3)));heartbeat.unref?.();
   try{
    // Several short internal stages can finish in one turn. Each operation remains independently journaled.
    for(let i=0;i<8&&!closed&&canRun();i++){
     const held=(await q("SELECT 1 FROM creation_work WHERE request_id=? AND fencing_token=? AND lease_owner=? AND state='leased' AND lease_until>CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT)",[row.request_id,row.fencing_token,worker])).rows.length;
     if(!held)return;
     const s=await flow.status(owner,input);
     if(terminal(s)){
      if(activate)await activate(s);
      if(activate)await q("UPDATE creation_work SET activated_at=COALESCE(activated_at,?) WHERE request_id=? AND fencing_token=? AND lease_owner=?",[await now(),row.request_id,row.fencing_token,worker]);
      const media=supplement?await supplement(s):null;
      phase=media?.status==='pending'?'queued':'done';result=s;break;
     }
     if(wallet(s)){phase='wallet';result=s;break;}
     if(['support','recover'].includes(s.action)){phase='paused';result=s;break;}
     if(!['prepare','resume'].includes(s.action)){phase='paused';error='CREATION_STATE';break;}
     result=await flow[s.action](owner,input);
     if(result.result?.status==='pending')break;
    }
   }catch(e){error=String(e.code||'CREATION_RETRY');phase=Number(row.failures)+1>=10?'paused':'queued';}
   finally{clearInterval(heartbeat);}
   const end=await now(),observation=result?.result?{stage:result.stage,state:result.state,reason:result.result.reason??null,signature:result.signature??result.result.signature??null}:null;
   await q("UPDATE creation_work SET state=?,lease_owner=NULL,lease_until=NULL,next_run=?,result_json=COALESCE(?,result_json),error_code=?,failures=?,updated_at=? WHERE request_id=? AND fencing_token=? AND lease_owner=? AND state='leased'",[phase,end+(error?Math.min(30000,1000*(Number(row.failures)+1)):500),observation?JSON.stringify(observation):null,error,error?Number(row.failures)+1:0,end,row.request_id,row.fencing_token,worker]);
   log({event:'creation-work',requestId:row.request_id,state:phase,stage:result?.stage??null,elapsedMs:Math.round(performance.now()-started),errorCode:error});
  })().finally(()=>{running=null;});return running;
 }
 return {
  async start(){
   // Adopt existing accepted requests without altering their sealed plans or approvals.
   await q("INSERT INTO creation_work(request_id,updated_at) SELECT request_id,updated_at FROM creation_requests WHERE owner=? AND state='accepted' ON CONFLICT(request_id) DO NOTHING",[owner]);
   timer=setInterval(()=>tick().catch(()=>log({event:'creation-work-unavailable'})),intervalMs);timer.unref?.();void tick().catch(()=>{});
  },
  async close(){closed=true;clearInterval(timer);await running;},tick,wake,
  flow:{
   status,
   async prepare(o,input){const s=await flow.status(o,input);if(wallet(s))return {...await flow.prepare(o,input),serverManaged:true,serverWork:'wallet'};await wake(input.requestId);void tick().catch(()=>{});return status(o,input);},
   async resume(o,input){await flow.status(o,input);await wake(input.requestId);void tick().catch(()=>{});return status(o,input);},
   async submit(o,input){const s=await flow.submit(o,input);await wake(input.requestId);void tick().catch(()=>{});return {...s,serverManaged:true,serverWork:'queued'};},
   async recover(o,input){const s=await flow.recover(o,input);await wake(input.requestId);return {...s,serverManaged:true,serverWork:'queued'};},
  },
 };
}
