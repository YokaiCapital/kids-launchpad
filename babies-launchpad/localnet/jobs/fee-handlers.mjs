// Three independent recurring chains. No harvest handler waits for a burn or payout.
// Initial keys are fixed; retries enqueue the same successor before completing.
export const FEE_CLASSES=Object.freeze(['fee-harvest','distribution','token-burn']);
export async function seedFeeJobs(registry,id){
 for(const kind of FEE_CLASSES)await registry.jobs.enqueue({...id,operationKey:kind+':0',jobClass:kind});
}
export function feeHandler({chain,registry,kind,intervalMs=300000}){
 if(!FEE_CLASSES.includes(kind)||typeof chain?.runFeeOperation!=='function'||!registry?.jobs?.get)throw Error('Invalid fee handler');
 if(!Number.isInteger(intervalMs)||intervalMs<300000||intervalMs>21600000)throw Error('Invalid fee interval');
 return {
  async reconcile(job){
   const f=job.result?.reconcile;if(!f?.signature)throw Error('Fee packet signature missing');
   return chain.signatureStatus(f.signature,f);
  },
  async run(job,ctx){
   const match=new RegExp('^'+kind+':(0|[1-9][0-9]{0,14})$').exec(job.operationKey);
   if(!match||job.jobClass!==kind)return {outcome:'failed-permanent',category:'fee-key',reason:'Invalid fee sequence'};
   if(match[1]!=='0'){
    const prev=job.payload?.predecessorJobId?await registry.jobs.get(job.payload.predecessorJobId):null;
    if(!prev||prev.operationKey!==kind+':'+(BigInt(match[1])-1n)||prev.jobClass!==kind||['genesisHash','programId','campaign'].some(k=>prev[k]!==ctx.campaign[k]))return {outcome:'failed-permanent',category:'fee-chain',reason:'Invalid fee predecessor'};
    if(prev.state!=='done')return {outcome:'yield',category:'fee-predecessor',delayMs:30000};
   }
   const sent=await ctx.fenced(kind,()=>chain.runFeeOperation(ctx.campaign,kind,{
    operationId:job.operationKey,operationKey:job.operationKey,fencingToken:ctx.token,signal:ctx.signal,holds:ctx.holds
   }));
   if(sent.status==='unknown')return {outcome:'unknown',category:'unresolved',reconcile:{...(sent.packetRef?{packetRef:sent.packetRef}:{}),signature:sent.signature,blockhash:sent.blockhash,lastValidBlockHeight:sent.lastValidBlockHeight}};
   if(sent.status==='failed')return {outcome:'retry',category:'fee-send',reason:sent.error||'Fee operation failed'};
   if(!['confirmed','deferred'].includes(sent.status))throw Error('Invalid fee operation result');
   const next=kind+':'+(BigInt(match[1])+1n);
   await ctx.enqueue({operationKey:next,jobClass:kind,payload:{predecessorJobId:ctx.jobId},notBefore:new Date(ctx.now()+intervalMs).toISOString()});
   return {outcome:'done',status:sent.status,signature:sent.signature??null,reason:sent.reason??null,...(sent.recovery?{recovery:sent.recovery}:{}),next};
  }
 };
}
