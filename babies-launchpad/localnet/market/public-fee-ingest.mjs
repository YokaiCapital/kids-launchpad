// Current fee counters do not require historical trades and never share the
// financial harvest/distribution queues. Publishing + successor remain fenced.
export function createFeeIndexHandler({store,rpc,resolveIdentity,intervalMs=10000}){
 if(!Number.isInteger(intervalMs)||intervalMs<1000||intervalMs>60000)throw Error('Invalid fee indexing interval');
 return {async run(job,ctx){
  if(job.jobClass!=='fee-index'||!/^fee-snapshot:(0|[1-9][0-9]{0,14})$/.test(job.operationKey))throw Error('Invalid fee snapshot job');
  const identity=await ctx.fenced('fee-identity',()=>resolveIdentity(ctx.campaign));
  if(!identity.fees||!identity.market)throw Error('Standard fee identity unavailable');
  const scope={genesis:ctx.campaign.genesisHash,pool:identity.pool},stream='fee-snapshot',previous=await store.cursor(scope,stream),sequence=BigInt(job.operationKey.split(':')[1]);
  if(previous.body?.sequence!=null&&BigInt(previous.body.sequence)>=sequence)return {outcome:'done',replayed:true};
  if(sequence!==(previous.body?.sequence!=null?BigInt(previous.body.sequence)+1n:0n))throw Error('Invalid fee snapshot sequence gap');
  const chainTime=await ctx.fenced('fee-block-time',()=>rpc.call('getBlockTime',[identity.fees.slot]));
  if(!Number.isSafeInteger(chainTime)||chainTime<=0)throw Object.assign(Error('Fee observation time unavailable'),{code:'RPC_UNAVAILABLE'});
  const fees={...identity.fees,chainTime},body={sequence:String(sequence),commitment:'finalized'};
  try{await ctx.fenced('fee-snapshot',()=>store.commitPage({scope,stream,expectedRevision:previous.revision,body,swaps:[],job,market:identity.market,fees,followups:[{jobClass:'fee-index',operationKey:'fee-snapshot:'+(sequence+1n),notBefore:new Date(ctx.now()+intervalMs).toISOString()}]}));}
  catch(e){if(e.code==='MARKET_CURSOR_CONFLICT')return {outcome:'yield',category:'fee-cursor',delayMs:1000};throw e;}
  return {outcome:'done',category:'fee-snapshot',commitment:'finalized',slot:fees.slot};
 }};
}
