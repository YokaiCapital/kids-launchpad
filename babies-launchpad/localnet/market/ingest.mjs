// Market ingest worker: one canonical pool, one upstream. Polls getSignaturesForAddress (the robust default), pages
// history back to the pool's creation, records every uncovered range as an explicit gap, decodes each successful
// transaction with decode.mjs, and reconciles provisional (confirmed) rows against finalized state. An optional
// websocket subscription (KIDS_MARKET_WS=1) only wakes the poll early; it is never a second decode path.
//
// Cursor rules (plan section 3.6): a page is committed only when every transaction in it was fetched and decoded.
// RPC nulls and errors leave the page uncommitted, so the cursor never advances over an unresolved range. When the
// page budget of one tick runs out before the live poll reaches the previous watermark, the remaining range is
// stored as a gap and worked down on later ticks.
import {decodeSwaps,SUPPORTED_VERSIONS} from './decode.mjs';
const SIGNATURE=/^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
export const DEFAULTS=Object.freeze({pageLimit:100,maxPagesPerTick:10,concurrency:4,pollIntervalMs:8000,finalizeBatch:50,provisionalMinAgeMs:120000,wsIdleMs:300000,wsReconnectMaxMs:60000});
export function deriveWsUrl(env=process.env){
 if(env.KIDS_HELIUS_WS_URL)return env.KIDS_HELIUS_WS_URL;
 const http=env.KIDS_HELIUS_RPC_URL;if(typeof http!=='string')return null;
 return http.replace(/^https:\/\//,'wss://').replace(/^http:\/\//,'ws://');
}
/** Per-slot transaction ordinal from a newest-first signature page: only for slots that lie fully inside the page. */
export function txIndexes(entries,{complete=false}={}){
 const out=new Map();if(!entries.length)return out;
 const bySlot=new Map();for(const e of entries){if(!bySlot.has(e.slot))bySlot.set(e.slot,[]);bySlot.get(e.slot).push(e.signature);}
 const newest=entries[0].slot,oldest=entries[entries.length-1].slot;
 for(const [slot,sigs] of bySlot){
  if(slot===newest&&!complete)continue;// the newer part of this slot may be beyond the page
  if(slot===oldest&&!complete)continue;// the older part may be on the next page
  sigs.forEach((s,i)=>out.set(s,sigs.length-1-i));
 }
 return out;
}
export function createMarketIngest({identity,rpc,store,now=Date.now,log=()=>{},options={},webSocketFactory=null,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 for(const k of ['genesis','pool','authority','vault0','vault1','mint0','mint1'])if(typeof identity?.[k]!=='string'||!identity[k])throw Error('Market identity is incomplete: '+k);
 const opt={...DEFAULTS,...options};
 const scope={genesis:identity.genesis,pool:identity.pool};
 const stats={enabled:true,running:false,ticks:0,unsupportedRecorded:0,lastTickAt:null,lastPollAt:null,lastPollOk:null,lastError:null,lastErrorAt:null,pagesFetched:0,transactionsFetched:0,swapsInserted:0,decodeFailures:0,unsupported:0,removed:0,finalized:0,rpcErrors:0,lastBlockTime:null,newestSlot:null,backfillComplete:false,openGaps:0,ws:{enabled:false,connected:false,reconnects:0,lastMessageAt:null}};
 let timer=null,ticking=null,stopped=false,socket=null,wsTimer=null,wake=null;
 const note=error=>{stats.lastError=String(error?.message||error).replace(/api[-_]?key=[^&\s"')]+/gi,'api-key=<redacted>').slice(0,200);stats.lastErrorAt=now();if(error?.name==='RpcError')stats.rpcErrors++;log({event:'market-ingest-error',category:error?.category||error?.name||'error',message:stats.lastError});};
 const signatures=(params)=>rpc.call('getSignaturesForAddress',[identity.pool,{limit:opt.pageLimit,commitment:'confirmed',...params}]);
 async function fetchTransaction(signature){
  let tx;
  try{tx=await rpc.call('getTransaction',[signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:Math.max(...SUPPORTED_VERSIONS.filter(Number.isInteger)),commitment:'confirmed'}]);}
  catch(error){if(error?.category==='unsupported-version')return {unsupportedVersion:true};throw error;}
  stats.transactionsFetched++;
  if(tx===null)throw Object.assign(Error('transaction '+signature.slice(0,8)+' not returned yet'),{category:'unresolved'});
  return tx;
 }
 /** Decode one newest-first page and store its swaps. Throws when any transaction is unresolved: nothing of the page is committed. */
 async function processPage(entries,{complete=false}={}){
  const toFetch=entries.filter(e=>!e.err&&SIGNATURE.test(e.signature));
  const fetched=new Map();let cursor=0;
  const worker=async()=>{while(cursor<toFetch.length){const e=toFetch[cursor++];fetched.set(e.signature,await fetchTransaction(e.signature));}};
  await Promise.all(Array.from({length:Math.min(opt.concurrency,toFetch.length)},worker));
  const indexes=txIndexes(entries,{complete});
  const confirmed=[],finalized=[],unsupported=[];
  for(const e of toFetch){
   const tx=fetched.get(e.signature);
   const result=tx?.unsupportedVersion?{unsupported:true,version:'>'+Math.max(...SUPPORTED_VERSIONS.filter(Number.isInteger)),swaps:[],skipped:[]}:decodeSwaps(tx,identity);
   if(result.unsupported){stats.unsupported++;unsupported.push({signature:e.signature,slot:e.slot,version:result.version??null});log({event:'market-unsupported-transaction',signature:e.signature,slot:e.slot,version:String(result.version??'unknown')});continue;}
   if(result.failed)continue;
   for(const s of result.skipped){stats.decodeFailures++;if(/unsupported/.test(s.reason))stats.unsupported++;log({event:'market-decode-skipped',signature:e.signature,path:s.path,reason:s.reason});}
   for(const swap of result.swaps){
    const record={...swap,txIndex:indexes.has(e.signature)?indexes.get(e.signature):null,blockTime:swap.blockTime??(Number.isInteger(e.blockTime)?e.blockTime:null)};
    (e.confirmationStatus==='finalized'?finalized:confirmed).push(record);
    if(record.blockTime!==null&&(stats.lastBlockTime===null||record.blockTime>stats.lastBlockTime))stats.lastBlockTime=record.blockTime;
   }
  }
  let inserted=0;
  store.transaction(()=>{if(confirmed.length)inserted+=store.insertSwaps(scope,confirmed,{commitment:'confirmed',observedAt:now()}).inserted;if(finalized.length)inserted+=store.insertSwaps(scope,finalized,{commitment:'finalized',observedAt:now()}).inserted;
   if(unsupported.length){const c=store.getCursor(scope);const known=new Set(c.unsupported.map(u=>u.signature));store.setCursor(scope,{...c,unsupported:[...c.unsupported,...unsupported.filter(u=>!known.has(u.signature))]},now());}});
  stats.swapsInserted+=inserted;stats.pagesFetched++;
  return inserted;
 }
 const gapOf=(newer,older,reason)=>({newerSignature:newer.signature,newerSlot:newer.slot,olderSignature:older.signature,olderSlot:older.slot,reason});
 /** Newest signatures since the watermark. */
 async function pollLive(){
  const cursor=store.getCursor(scope);
  if(!cursor.newestSignature){
   const page=await signatures({});
   if(!page.length){stats.lastPollAt=now();stats.lastPollOk=true;return;}
   const complete=page.length<opt.pageLimit;
   await processPage(page,{complete});
   const newest=page[0],oldest=page[page.length-1];
   store.setCursor(scope,{...store.getCursor(scope),newestSignature:newest.signature,newestSlot:newest.slot,newestBlockTime:newest.blockTime??null,oldestSignature:oldest.signature,oldestSlot:oldest.slot,oldestBlockTime:oldest.blockTime??null,backfillComplete:complete},now());
   stats.lastPollAt=now();stats.lastPollOk=true;return;
  }
  let before=undefined,newest=null,lastProcessed=null,pages=0;
  const gaps=[...cursor.gaps];
  try{
   for(;;){
    const page=await signatures({before,until:cursor.newestSignature});
    if(!page.length)break;
    await processPage(page);
    if(!newest)newest=page[0];lastProcessed=page[page.length-1];pages++;
    if(page.length<opt.pageLimit)break;// reached the watermark
    before=lastProcessed.signature;
    if(pages>=opt.maxPagesPerTick){gaps.push(gapOf(lastProcessed,{signature:cursor.newestSignature,slot:cursor.newestSlot},'page budget'));break;}
   }
  }catch(error){
   // Pages already processed are covered; the rest of the range becomes an explicit gap so the cursor can move.
   if(newest&&lastProcessed)gaps.push(gapOf(lastProcessed,{signature:cursor.newestSignature,slot:cursor.newestSlot},'unresolved: '+(error.category||'error')));
   else throw error;
  }
  if(newest)store.setCursor(scope,{...store.getCursor(scope),newestSignature:newest.signature,newestSlot:newest.slot,newestBlockTime:newest.blockTime??cursor.newestBlockTime,gaps},now());
  stats.lastPollAt=now();stats.lastPollOk=true;
 }
 /** Work down the oldest gap first; a gap closes when a page shorter than the limit reaches its older bound. */
 async function fillGaps(){
  const cursor=store.getCursor(scope);if(!cursor.gaps.length)return;
  const gaps=cursor.gaps.map(g=>({...g}));const gap=gaps[0];let pages=0;
  for(;;){
   const page=await signatures({before:gap.newerSignature,until:gap.olderSignature});
   if(page.length)await processPage(page);
   if(page.length<opt.pageLimit){gaps.shift();break;}
   gap.newerSignature=page[page.length-1].signature;gap.newerSlot=page[page.length-1].slot;pages++;
   store.setCursor(scope,{...store.getCursor(scope),gaps},now());
   if(pages>=opt.maxPagesPerTick)break;
  }
  store.setCursor(scope,{...store.getCursor(scope),gaps},now());
 }
 /** Page older history until the pool's first signature. */
 async function backfill(){
  let cursor=store.getCursor(scope);if(cursor.backfillComplete||!cursor.oldestSignature)return;
  for(let pages=0;pages<opt.maxPagesPerTick;pages++){
   const page=await signatures({before:cursor.oldestSignature});
   const complete=page.length<opt.pageLimit;
   if(page.length)await processPage(page,{complete});
   const oldest=page.length?page[page.length-1]:null;
   cursor={...store.getCursor(scope),oldestSignature:oldest?oldest.signature:cursor.oldestSignature,oldestSlot:oldest?oldest.slot:cursor.oldestSlot,oldestBlockTime:oldest?(oldest.blockTime??null):cursor.oldestBlockTime,backfillComplete:complete};
   store.setCursor(scope,cursor,now());
   if(complete)break;
  }
 }
 /** Provisional rows: finalized -> mark; failed or absent from history after a grace period -> remove and rebuild. */
 async function finalizePass(){
  const pending=store.provisional(scope,opt.finalizeBatch);if(!pending.length)return;
  const statuses=await rpc.call('getSignatureStatuses',[pending.map(p=>p.signature),{searchTransactionHistory:true}]);
  const list=statuses?.value;if(!Array.isArray(list)||list.length!==pending.length)throw Object.assign(Error('getSignatureStatuses: malformed'),{category:'malformed'});
  const done=[],gone=[];
  pending.forEach((p,i)=>{const s=list[i];
   if(s===null){if(now()-p.observedAt>=opt.provisionalMinAgeMs)gone.push(p.signature);return;}
   if(s.err)gone.push(p.signature);else if(s.confirmationStatus==='finalized')done.push(p.signature);
  });
  if(done.length)stats.finalized+=store.finalizeSwaps(scope,done);
  if(gone.length){stats.removed+=store.removeSwaps(scope,gone);log({event:'market-provisional-removed',signatures:gone});}
 }
 async function resolveBlockTimes(){
  const missing=store.missingBlockTime(scope,opt.finalizeBatch);
  for(const m of missing){const t=await rpc.call('getBlockTime',[m.slot]);if(Number.isInteger(t)&&t>0)store.setBlockTime(scope,m.signature,t);}
 }
 async function tick(){
  if(ticking)return ticking;
  ticking=(async()=>{
   stats.ticks++;stats.lastTickAt=now();
   for(const step of [pollLive,fillGaps,backfill,finalizePass,resolveBlockTimes]){
    if(stopped)break;
    try{await step();}catch(error){if(step===pollLive)stats.lastPollOk=false;note(error);}
   }
   const cursor=store.getCursor(scope);stats.openGaps=cursor.gaps.length;stats.backfillComplete=cursor.backfillComplete;stats.newestSlot=cursor.newestSlot;stats.unsupportedRecorded=cursor.unsupported.length;
  })().finally(()=>{ticking=null;});
  return ticking;
 }
 // ---- optional websocket wake-up ----
 function connectSocket(url,attempt=0){
  if(stopped||!webSocketFactory)return;
  let ws;try{ws=webSocketFactory(url);}catch(error){note(error);scheduleReconnect(url,attempt);return;}
  socket=ws;stats.ws.enabled=true;
  const idle=()=>{clearTimeout(wsTimer);wsTimer=setTimeout(()=>{try{ws.close();}catch{}},opt.wsIdleMs);wsTimer.unref?.();};
  ws.onopen=()=>{stats.ws.connected=true;stats.ws.lastMessageAt=now();idle();try{ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'logsSubscribe',params:[{mentions:[identity.pool]},{commitment:'confirmed'}]}));}catch(error){note(error);}};
  ws.onmessage=event=>{stats.ws.lastMessageAt=now();idle();let body;try{body=JSON.parse(String(event.data));}catch{return;}if(body?.method==='logsNotification'){clearTimeout(wake);wake=setTimeout(()=>{tick().catch(()=>{});},500);wake.unref?.();}};
  ws.onerror=()=>{};
  ws.onclose=()=>{stats.ws.connected=false;clearTimeout(wsTimer);if(socket===ws)socket=null;scheduleReconnect(url,attempt);};
 }
 function scheduleReconnect(url,attempt){
  if(stopped)return;stats.ws.reconnects++;
  const delay=Math.min(opt.wsReconnectMaxMs,1000*2**Math.min(attempt,6))+Math.floor(Math.random()*1000);
  const t=setTimeout(()=>connectSocket(url,attempt+1),delay);t.unref?.();
 }
 return {
  scope,identity,tick,pollLive,fillGaps,backfill,finalizePass,resolveBlockTimes,
  start({wsUrl=null}={}){
   if(stats.running)return;stats.running=true;stopped=false;
   timer=setInterval(()=>{tick().catch(()=>{});},opt.pollIntervalMs);timer.unref?.();
   tick().catch(()=>{});
   if(wsUrl&&webSocketFactory)connectSocket(wsUrl);
  },
  async stop(){stopped=true;stats.running=false;clearInterval(timer);clearTimeout(wsTimer);clearTimeout(wake);try{socket?.close();}catch{}if(ticking)await ticking.catch(()=>{});},
  stats(){
   const t=now();
   return {...stats,ws:{...stats.ws},lagSeconds:stats.lastPollAt===null?null:Math.round((t-stats.lastPollAt)/1000),lastTradeAgeSeconds:stats.lastBlockTime===null?null:Math.max(0,Math.round(t/1000-stats.lastBlockTime)),connected:stats.lastPollOk===true&&t-stats.lastPollAt<opt.pollIntervalMs*3,rpc:rpc.stats?.()||null,store:store.stats(scope)};
  },
 };
}
