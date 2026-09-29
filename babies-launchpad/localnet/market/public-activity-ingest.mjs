import {decodePublicActivity} from './public-activity-decode.mjs';
import {canonicalHash} from '../registry/canonical.mjs';import {providerFreshness} from './freshness.mjs';
const signature=s=>typeof s==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s);
export function createPublicActivityHandlers({store,rpc,resolveIdentity,pageLimit=20,intervalMs=10000}){
 if(!Number.isInteger(pageLimit)||pageLimit<1||pageLimit>100||!Number.isInteger(intervalMs)||intervalMs<1000||intervalMs>60000)throw Error('Invalid activity worker bounds');
 const process=live=>({async run(job,ctx){
  if(job.jobClass!==(live?'activity-index':'activity-backfill')||!(live?/^activity-live:(0|[1-9][0-9]{0,14})$/:/^activity-backfill:(initial|[a-f0-9]{32})$/).test(job.operationKey))throw Error('Invalid activity job');
  const identity=await ctx.fenced('activity-identity',()=>resolveIdentity(ctx.campaign));
  const stream = live ? 'live' : job.operationKey;
  const previous = await store.cursor(ctx.campaign, stream);
  const sequence = live ? BigInt(job.operationKey.split(':')[1]) : null;
  if(live&&previous.body?.sequence!=null&&BigInt(previous.body.sequence)>=sequence||!live&&previous.body?.complete)return {outcome:'done',replayed:true};
  if(live&&sequence!==(previous.body?.sequence!=null?BigInt(previous.body.sequence)+1n:0n))throw Error('Invalid activity sequence');
  const call=(method,params)=>ctx.fenced('activity-read',()=>rpc.call(method,params));
  let providerHead=null,params={};
  if(live){const slot=await call('getSlot',[{commitment:'finalized'}]);providerHead={slot,time:await call('getBlockTime',[slot])};if(providerFreshness(providerHead,ctx.now()).stale||slot<(previous.body?.providerHead?.slot??0))throw Object.assign(Error('Activity provider head stale or regressed'),{code:'RPC_UNAVAILABLE'});params.minContextSlot=slot;if(previous.body?.head)params.until=previous.body.head;}
  else{params.before=previous.body?.before??job.payload?.before;params.until=previous.body?.until??job.payload?.until;if(!signature(params.before)||params.until!=null&&!signature(params.until))throw Error('Invalid activity backfill bounds');}
  const initial=live?previous.body?.sequence==null:job.payload?.boundarySlot==null&&params.until==null,boundary=live?previous.body?.providerHead?.slot:job.payload?.boundarySlot;
  if(!initial){const first=await call('getFirstAvailableBlock',[]);if(!Number.isSafeInteger(first)||first<0||!Number.isSafeInteger(boundary)||first>boundary)throw Object.assign(Error('Activity gap outside provider retention'),{code:'RPC_UNAVAILABLE'});if(live&&previous.body?.slot<first)delete params.until;}
  const entries=await call('getSignaturesForAddress',[identity.campaign,{limit:pageLimit,commitment:'finalized',...Object.fromEntries(Object.entries(params).filter(([,v])=>v!=null))}]);
  if(!Array.isArray(entries)||entries.length>pageLimit||new Set(entries.map(e=>e.signature)).size!==entries.length||entries.some((e,i)=>!signature(e.signature)||!Number.isSafeInteger(e.slot)||e.slot<1||e.confirmationStatus!=='finalized'||e.signature===params.before||e.signature===params.until||i>0&&e.slot>entries[i-1].slot))throw Error('Malformed activity signatures');
  let creationVerified=previous.body?.creationVerified===true;const events=[];
  for(const entry of entries){
   const tx=await call('getTransaction',[entry.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:0}]);
   if(!tx)throw Object.assign(Error('Finalized activity transaction unavailable'),{code:'RPC_UNAVAILABLE'});
   if(tx.transaction?.signatures?.[0]!==entry.signature||tx.slot!==entry.slot||!!tx.meta?.err!==!!entry.err)throw Error('Activity transaction identity mismatch');
   const decoded=decodePublicActivity(tx,identity);if(decoded.unsupported||decoded.skipped.length)throw Error('Activity decoder requires supported finalized data');
   let time=tx.blockTime??entry.blockTime;if(!Number.isSafeInteger(time)||time<1)time=await call('getBlockTime',[entry.slot]);if(!Number.isSafeInteger(time)||time<1)throw Object.assign(Error('Activity block time unavailable'),{code:'RPC_UNAVAILABLE'});
   for(const event of decoded.events){events.push({...event,blockTimeUnix:time});if(event.kind==='campaign-init'&&!event.failed)creationVerified=true;}
  }
  const historyUnavailable=initial&&entries.length<pageLimit&&!creationVerified,followups=[];let body;
  if(live){
   body={sequence:String(sequence),head:entries[0]?.signature??previous.body?.head??null,slot:entries[0]?.slot??previous.body?.slot??null,providerHead,creationVerified,historyUnavailable:historyUnavailable||previous.body?.historyUnavailable===true};
   if(entries.length===pageLimit&&(initial||entries.at(-1).slot>boundary)){
    const before=entries.at(-1).signature,until=params.until??null,suffix=initial?'initial':canonicalHash({before,until,boundary}).slice(0,32);
    followups.push({jobClass:'activity-backfill',operationKey:'activity-backfill:'+suffix,payload:{before,until,...(!initial?{boundarySlot:boundary}:{})}});
   }
   followups.push({jobClass:'activity-index',operationKey:'activity-live:'+(sequence+1n),notBefore:new Date(ctx.now()+intervalMs).toISOString()});
  }else body={before:entries.at(-1)?.signature??params.before,until:params.until??null,creationVerified,historyUnavailable,complete:entries.length<pageLimit||!initial&&entries.at(-1)?.slot<=boundary};
  try{await ctx.fenced('activity-publish',()=>store.commit({identity,stream,expectedRevision:previous.revision,body,events,job,followups}));}catch(e){if(e.code==='ACTIVITY_CURSOR_CONFLICT')return {outcome:'yield',delayMs:1000,category:'activity-cursor'};throw e;}
  return {outcome:live||body.complete?'done':'yield',delayMs:1,category:'activity-page',events:events.length,historyUnavailable};
 }});
 return {'activity-index':process(true),'activity-backfill':process(false)};
}
