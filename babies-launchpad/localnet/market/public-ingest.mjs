// Bounded finalized ingestion for new public-launch workers. Live and backfill
// use separate lanes/cursors. Confirmed wallet progress remains a separate UI state.
import {decodeSwaps,SUPPORTED_VERSIONS,CPMM_PROGRAM} from './decode.mjs';
import {decodeBase58} from '../../shared/solana.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {providerFreshness} from './freshness.mjs';
const sig=/^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
// A short/empty RPC page alone does not prove coverage to pool creation. A
// pruned provider can answer [] for a pool with real trades. Require its exact
// initialization in the initial traversal before reporting complete history.
export function hasPoolInitialization(tx,pool){
 if(tx?.meta?.err||!tx?.meta||!tx.transaction?.message)return false;
 const all=[...(tx.transaction.message.instructions||[]),...(tx.meta.innerInstructions||[]).flatMap(x=>x.instructions||[])];
 return all.some(ix=>{
  if(ix.programId!==CPMM_PROGRAM||ix.accounts?.[3]!==pool.pool||ix.accounts?.[2]!==pool.authority||ix.accounts?.[4]!==pool.mint0||ix.accounts?.[5]!==pool.mint1||ix.accounts?.[10]!==pool.vault0||ix.accounts?.[11]!==pool.vault1)return false;
  try{const bytes=decodeBase58(ix.data);return bytes.length===32&&Array.from(bytes.subarray(0,8)).join(',')==='175,175,109,31,13,152,155,237';}catch{return false;}
 });
}
export function createPublicMarketHandlers({store,rpc,resolveIdentity,pageLimit=20,liveIntervalMs=8000}){
 if(!Number.isInteger(pageLimit)||pageLimit<1||pageLimit>100||!Number.isInteger(liveIntervalMs)||liveIntervalMs<1000||liveIntervalMs>60000)throw Error('Invalid market worker bounds');
 async function page(identity,{before,until,minContextSlot}={},ctx){
  const call=(method,params)=>ctx.fenced('market-read',()=>rpc.call(method,params));
  const entries=await call('getSignaturesForAddress',[identity.pool,{limit:pageLimit,commitment:'finalized',...(before?{before}:{}),...(until?{until}:{}),...(minContextSlot?{minContextSlot}:{})}]);
  if(!Array.isArray(entries)||entries.length>pageLimit||entries.some(e=>!sig.test(e.signature)||!Number.isSafeInteger(e.slot)||e.slot<0||e.confirmationStatus!=='finalized'))throw Error('Malformed finalized signature page');
  if(new Set(entries.map(e=>e.signature)).size!==entries.length||entries.some((e,i)=>e.signature===before||e.signature===until||i>0&&e.slot>entries[i-1].slot))throw Error('Malformed signature page ordering');
  const swaps=[];const times=new Map();let openingVerified=false;
  // Sequential fetches bound upstream concurrency; fleet concurrency is explicit.
  for(const e of entries){
   if(e.err)continue;
   const tx=await call('getTransaction',[e.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:Math.max(...SUPPORTED_VERSIONS.filter(Number.isInteger))}]);
   if(!tx)throw Error('Finalized transaction unavailable');
   if(tx.transaction?.signatures?.[0]!==e.signature||tx.slot!==e.slot)throw Error('Transaction identity mismatch');
   if(hasPoolInitialization(tx,identity))openingVerified=true;
   const decoded=decodeSwaps(tx,identity);
   if(decoded.unsupported||decoded.skipped.length)throw Error('Market decoder refused finalized transaction '+e.signature);
   for(const swap of decoded.swaps){
    let time=swap.blockTime??e.blockTime;
    if(!Number.isSafeInteger(time)||time<=0){if(!times.has(e.slot))times.set(e.slot,await call('getBlockTime',[e.slot]));time=times.get(e.slot);}
    if(!Number.isSafeInteger(time)||time<=0)throw Error('Finalized block time unavailable');
    swaps.push({...swap,blockTime:time,txIndex:null});
   }
  }
  return {entries,swaps,openingVerified};
 }
 const process=kind=>({async run(job,ctx){
  const live=kind==='live';
  if(job.jobClass!==(live?'market-index':'market-backfill'))throw Error('Market job class mismatch');
  if(live&&!/^market-live:(0|[1-9][0-9]{0,14})$/.test(job.operationKey))throw Error('Invalid market live sequence');
  if(!live&&!/^market-backfill:(initial|[0-9a-f]{32})$/.test(job.operationKey))throw Error('Invalid backfill key');
  const identity=await ctx.fenced('market-identity',()=>resolveIdentity(ctx.campaign)),scope={genesis:ctx.campaign.genesisHash,pool:identity.pool};
  // Schedule independent current counters before any archive-dependent chart work.
  if(live&&identity.fees){await ctx.fenced('fee-index-schedule',()=>ctx.enqueue({jobClass:'fee-index',operationKey:'fee-snapshot:0'}));await ctx.fenced('activity-index-schedule',()=>ctx.enqueue({jobClass:'activity-index',operationKey:'activity-live:0'}));await ctx.fenced('position-index-schedule',()=>ctx.enqueue({jobClass:'position-index',operationKey:'positions:0'}));}
  const stream=live?'live':job.operationKey,previous=await store.cursor(scope,stream);
  // A crash after the atomic page+successor commit replays the checkpoint only.
  const sequence=live?BigInt(job.operationKey.split(':')[1]):null;
  if(live&&previous.body?.sequence!=null&&BigInt(previous.body.sequence)>=sequence||!live&&previous.body?.complete)return {outcome:'done',replayed:true};
  if(live&&sequence!==(previous.body?.sequence!=null?BigInt(previous.body.sequence)+1n:0n))throw Error('Invalid market sequence gap');
  let params={},providerHead=null;
  if(live){
   const slot=await ctx.fenced('market-read',()=>rpc.call('getSlot',[{commitment:'finalized'}]));
   if(!Number.isSafeInteger(slot)||slot<=0)throw Error('Malformed finalized provider head');
   if(slot<(previous.body?.providerHead?.slot??0))throw Object.assign(Error('Finalized provider head regressed'),{code:'RPC_UNAVAILABLE'});
   const time=await ctx.fenced('market-read',()=>rpc.call('getBlockTime',[slot]));
   providerHead={slot,time};
   if(providerFreshness(providerHead,ctx.now()).stale)throw Object.assign(Error('Finalized provider head is stale or unverified'),{code:'RPC_UNAVAILABLE'});
   params.minContextSlot=slot;
   if(previous.body?.head)params.until=previous.body.head;
  }
  else{
   const initial=job.payload||{};
   const before=previous.body?.before??initial.before,until=previous.body?.until??initial.until;
   if(!sig.test(before||'')||until!=null&&!sig.test(until))throw Error('Invalid backfill bounds');
   params={before,until};
  }
  const initial=live?previous.body?.sequence==null:job.payload?.boundarySlot==null&&params.until==null;
  const boundarySlot=live?previous.body?.providerHead?.slot:job.payload?.boundarySlot;
  // Incremental polls must overlap retained chain history. A returning worker
  // cannot treat a pruned gap as zero volume just because the newest page is short.
  if(identity.market&&!initial){
   const first=await ctx.fenced('market-read',()=>rpc.call('getFirstAvailableBlock',[]));
   if(!Number.isSafeInteger(boundarySlot)||boundarySlot<1||!Number.isSafeInteger(first)||first<0||first>boundarySlot)throw Object.assign(Error('Market history gap is outside provider retention'),{code:'RPC_UNAVAILABLE'});
   // A quiet pool's last transaction may be older than retained history even
   // while our continuous finalized observations overlap. Do not send a
   // pruned signature as an RPC bound; the verified slot boundary is enough.
   if(live&&Number.isSafeInteger(previous.body?.slot)&&previous.body.slot<first)delete params.until;
  }
  const {entries,swaps,openingVerified}=await page(identity,params,ctx);
  if(identity.market&&initial&&entries.length<pageLimit&&!openingVerified&&!previous.body?.openingVerified)throw Object.assign(Error('Pool opening history is unavailable from this provider'),{code:'RPC_UNAVAILABLE'});
  if(entries.length&&params.before===entries.at(-1).signature)throw Error('Backfill cursor did not advance');
  const followups=[];let body;
  if(live){
   const head=entries[0]?.signature??previous.body?.head??null;
   body={head,slot:entries[0]?.slot??previous.body?.slot??null,openingVerified:openingVerified||previous.body?.openingVerified===true,providerHead,lastJob:job.jobId,sequence:String(sequence),commitment:'finalized'};
   if(entries.length===pageLimit&&(initial||!Number.isSafeInteger(boundarySlot)||entries.at(-1).slot>boundarySlot)){
    const before=entries.at(-1).signature,until=params.until??null;
    const suffix=initial?'initial':canonicalHash({before,until,boundarySlot:boundarySlot??null}).slice(0,32);
    followups.push({operationKey:'market-backfill:'+suffix,jobClass:'market-backfill',payload:{before,until,...(!initial?{boundarySlot:boundarySlot??null}:{})}});
   }
   followups.push({operationKey:'market-live:'+(BigInt(job.operationKey.split(':')[1])+1n),jobClass:'market-index',notBefore:new Date(ctx.now()+liveIntervalMs).toISOString()});
  }else body={before:entries.at(-1)?.signature??params.before,until:params.until??null,openingVerified:openingVerified||previous.body?.openingVerified===true,complete:entries.length<pageLimit||!initial&&Number.isSafeInteger(boundarySlot)&&entries.at(-1)?.slot<=boundarySlot,commitment:'finalized'};
  try{await ctx.fenced('market-page',()=>store.commitPage({scope,stream,expectedRevision:previous.revision,body,swaps,job,followups,market:identity.market??null}));}
  catch(e){if(e.code==='MARKET_CURSOR_CONFLICT')return {outcome:'yield',category:'market-cursor',delayMs:1000};throw e;}
  return {outcome:live||body.complete?'done':'yield',category:'market-page',delayMs:1,transactions:entries.length,swaps:swaps.length,commitment:'finalized'};
 }});
 return {'market-index':process('live'),'market-backfill':process('backfill')};
}
