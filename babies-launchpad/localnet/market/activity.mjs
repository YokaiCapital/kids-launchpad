// Program activity feed for the coin page (owner requirement, 23 September 2026): every instruction of our programs
// for the selected campaign, not only buybacks. Sibling of the swap feed: same bounded RPC client, the same SQLite file
// (its own connection, its own tables `events` and `activity_cursor`), the same cursor, gap, backfill and
// finalization discipline (ingest.mjs), the same cached single-flight read API. Watched addresses: the campaign
// account (commitments, refunds, settlement, launch, claims and every fee instruction name it), the fee-state PDA, and
// the distribution record of a vault campaign (its claims never mention the campaign). Events are deduplicated by
// (genesis, campaign, signature, instruction path), so one transaction reached through two addresses is stored once.
// Kill switches: KIDS_MARKET_FEED=0 (all market data) or KIDS_MARKET_ACTIVITY=0 (this feed only). Nothing here logs an
// RPC URL or a key.
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {decodeActivity,KINDS,ROLES} from './activity-decode.mjs';
import {SUPPORTED_VERSIONS} from './decode.mjs';
import {createRpcClient} from './rpc.mjs';
import {DEFAULT_STORE_PATH,marketFeedEnabled} from './feed.mjs';
export const ACTIVITY_SCHEMA_VERSION=1;
export const MAX_UNSUPPORTED=200;
const ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/,SIGNATURE=/^[1-9A-HJ-NP-Za-km-z]{64,90}$/,U64=/^\d{1,20}$/,PATH=/^\d{1,4}(\.\d{1,4})?$/;
const PROGRAMS=new Set(['launch','distribution','token']),DIRECTIONS=new Set(['in','out','burn']);
const redact=text=>String(text).replace(/api[-_]?key=[^&\s"')]+/gi,'api-key=<redacted>');
// ---------------------------------------------------------------- store
/** Chain order inside a slot: top-level index, then inner index (top-level itself sorts first). */
export const ordinalOf=path=>{const [a,b]=path.split('.').map(Number);return a*100000+(b===undefined?0:b+1);};
export const encodeActivityCursor=c=>Buffer.from(JSON.stringify(c)).toString('base64url');
export function decodeActivityCursor(text){
 if(typeof text!=='string'||!text||text.length>400)return null;
 try{const c=JSON.parse(Buffer.from(text,'base64url').toString('utf8'));if(!Number.isSafeInteger(c.slot)||!Number.isSafeInteger(c.ordinal)||!SIGNATURE.test(c.signature))return null;return c;}catch{return null;}
}
export function validateEvent(e){
 if(!SIGNATURE.test(e.signature||''))throw Error('Invalid event signature');
 if(!PATH.test(e.instructionPath||''))throw Error('Invalid event instruction path');
 if(!Number.isSafeInteger(e.slot)||e.slot<0)throw Error('Invalid event slot');
 if(!(e.blockTimeUnix===null||(Number.isSafeInteger(e.blockTimeUnix)&&e.blockTimeUnix>0)))throw Error('Invalid event block time');
 if(!PROGRAMS.has(e.program))throw Error('Invalid event program');
 if(!KINDS.includes(e.kind))throw Error('Invalid event kind');
 if(!(e.actor===null||ADDRESS.test(e.actor||'')))throw Error('Invalid event actor');
 if(!Array.isArray(e.assets)||e.assets.length>64)throw Error('Invalid event assets');
 for(const a of e.assets){
  if(!(a.mint==='SOL'||ADDRESS.test(a.mint||'')))throw Error('Invalid asset mint');
  if(!U64.test(a.amountRaw||''))throw Error('Invalid asset amount');
  if(!Number.isInteger(a.decimals)||a.decimals<0||a.decimals>18)throw Error('Invalid asset decimals');
  if(!DIRECTIONS.has(a.direction))throw Error('Invalid asset direction');
  if(!(a.role==null||ROLES.includes(a.role)))throw Error('Invalid asset role');
  if(!(a.account==null||ADDRESS.test(a.account)))throw Error('Invalid asset account');
 }
 if(!(e.detail===null||e.detail===undefined||(typeof e.detail==='string'&&e.detail.length<=200)))throw Error('Invalid event detail');
 if(typeof e.failed!=='boolean'||typeof e.nested!=='boolean')throw Error('Invalid event flags');
 if(!Number.isInteger(e.decoderVersion)||e.decoderVersion<1)throw Error('Invalid event decoder version');
}
const rowToEvent=r=>({genesis:r.genesis,campaign:r.campaign,signature:r.signature,instructionPath:r.instruction_path,slot:Number(r.slot),blockTimeUnix:r.block_time===null?null:Number(r.block_time),program:r.program,kind:r.kind,actor:r.actor,assets:JSON.parse(r.assets),detail:r.detail,failed:r.failed===1,nested:r.nested===1,decoderVersion:Number(r.decoder_version),commitment:r.commitment,status:r.failed===1?'failed':r.commitment,observedAt:Number(r.observed_at)});
export function openActivityStore(path=':memory:'){
 if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const db=new DatabaseSync(path);
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS market_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS events(
  genesis TEXT NOT NULL, campaign TEXT NOT NULL, signature TEXT NOT NULL, instruction_path TEXT NOT NULL, ordinal INTEGER NOT NULL,
  slot INTEGER NOT NULL, block_time INTEGER, program TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT, assets TEXT NOT NULL, detail TEXT,
  failed INTEGER NOT NULL, nested INTEGER NOT NULL, decoder_version INTEGER NOT NULL, commitment TEXT NOT NULL, observed_at INTEGER NOT NULL,
  PRIMARY KEY(genesis,campaign,signature,instruction_path)) WITHOUT ROWID;
 CREATE INDEX IF NOT EXISTS events_order ON events(genesis,campaign,slot,signature,ordinal);
 CREATE INDEX IF NOT EXISTS events_kind ON events(genesis,campaign,kind);
 CREATE INDEX IF NOT EXISTS events_commitment ON events(genesis,campaign,commitment,slot);
 CREATE TABLE IF NOT EXISTS activity_cursor(
  genesis TEXT NOT NULL, address TEXT NOT NULL,
  newest_signature TEXT, newest_slot INTEGER, newest_block_time INTEGER,
  oldest_signature TEXT, oldest_slot INTEGER, oldest_block_time INTEGER,
  backfill_complete INTEGER NOT NULL DEFAULT 0, gaps TEXT NOT NULL DEFAULT '[]', unsupported TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL,
  PRIMARY KEY(genesis,address)) WITHOUT ROWID;
 INSERT OR IGNORE INTO market_meta(key,value) VALUES('activity-schema','${ACTIVITY_SCHEMA_VERSION}');`);
 const found=db.prepare("SELECT value FROM market_meta WHERE key='activity-schema'").get();
 if(Number(found?.value)!==ACTIVITY_SCHEMA_VERSION){db.close();throw Error('Activity store schema '+found?.value+' is not '+ACTIVITY_SCHEMA_VERSION+'; migrate before opening');}
 const q={
  insert:db.prepare(`INSERT INTO events(genesis,campaign,signature,instruction_path,ordinal,slot,block_time,program,kind,actor,assets,detail,failed,nested,decoder_version,commitment,observed_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(genesis,campaign,signature,instruction_path) DO UPDATE SET
    commitment=CASE WHEN excluded.commitment='finalized' THEN 'finalized' ELSE events.commitment END,
    block_time=COALESCE(events.block_time,excluded.block_time)`),
  existing:db.prepare('SELECT commitment FROM events WHERE genesis=? AND campaign=? AND signature=? AND instruction_path=?'),
  signatureState:db.prepare("SELECT MIN(commitment) AS commitment, COUNT(*) AS n FROM events WHERE genesis=? AND campaign=? AND signature=?"),
  bySignature:db.prepare('SELECT * FROM events WHERE genesis=? AND campaign=? AND signature=? ORDER BY ordinal ASC'),
  deleteSignature:db.prepare('DELETE FROM events WHERE genesis=? AND campaign=? AND signature=?'),
  finalize:db.prepare("UPDATE events SET commitment='finalized' WHERE genesis=? AND campaign=? AND signature=?"),
  setBlockTime:db.prepare('UPDATE events SET block_time=? WHERE genesis=? AND campaign=? AND signature=? AND block_time IS NULL'),
  provisional:db.prepare("SELECT signature, MIN(slot) AS slot, MIN(observed_at) AS observed_at FROM events WHERE genesis=? AND campaign=? AND commitment='confirmed' GROUP BY signature ORDER BY slot ASC LIMIT ?"),
  missingBlockTime:db.prepare('SELECT signature, MIN(slot) AS slot FROM events WHERE genesis=? AND campaign=? AND block_time IS NULL GROUP BY signature ORDER BY slot ASC LIMIT ?'),
  first:db.prepare('SELECT * FROM events WHERE genesis=? AND campaign=? AND kind IN (SELECT value FROM json_each(?)) ORDER BY slot DESC, signature DESC, ordinal DESC LIMIT ?'),
  after:db.prepare(`SELECT * FROM events WHERE genesis=? AND campaign=? AND kind IN (SELECT value FROM json_each(?)) AND (slot<? OR (slot=? AND (signature<? OR (signature=? AND ordinal<?))))
   ORDER BY slot DESC, signature DESC, ordinal DESC LIMIT ?`),
  counts:db.prepare("SELECT COUNT(*) AS total, SUM(failed) AS failed, SUM(CASE WHEN commitment='confirmed' THEN 1 ELSE 0 END) AS provisional, SUM(CASE WHEN block_time IS NULL THEN 1 ELSE 0 END) AS missingBlockTime, MIN(block_time) AS oldest, MAX(block_time) AS newest FROM events WHERE genesis=? AND campaign=?"),
  byKind:db.prepare('SELECT kind, COUNT(*) AS n FROM events WHERE genesis=? AND campaign=? AND failed=0 GROUP BY kind'),
  getCursor:db.prepare('SELECT * FROM activity_cursor WHERE genesis=? AND address=?'),
  setCursor:db.prepare(`INSERT INTO activity_cursor(genesis,address,newest_signature,newest_slot,newest_block_time,oldest_signature,oldest_slot,oldest_block_time,backfill_complete,gaps,unsupported,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(genesis,address) DO UPDATE SET newest_signature=excluded.newest_signature,newest_slot=excluded.newest_slot,newest_block_time=excluded.newest_block_time,oldest_signature=excluded.oldest_signature,oldest_slot=excluded.oldest_slot,oldest_block_time=excluded.oldest_block_time,backfill_complete=excluded.backfill_complete,gaps=excluded.gaps,unsupported=excluded.unsupported,updated_at=excluded.updated_at`),
 };
 let depth=0;
 function transaction(fn){
  if(depth>0)return fn();
  db.exec('BEGIN IMMEDIATE');depth++;
  try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}finally{depth--;}
 }
 const key=scope=>{if(!ADDRESS.test(scope?.campaign||'')||typeof scope?.genesis!=='string'||!scope.genesis)throw Error('Activity scope requires genesis and campaign');return scope;};
 const cursorKey=scope=>{if(!ADDRESS.test(scope?.address||'')||typeof scope?.genesis!=='string'||!scope.genesis)throw Error('Activity cursor requires genesis and address');return scope;};
 return {
  path,transaction,
  /** Idempotent: new rows are inserted, known rows may only gain a block time or a finalized commitment. */
  insertEvents(scope,events,{commitment='confirmed',observedAt=Date.now()}={}){
   key(scope);if(!['confirmed','finalized'].includes(commitment))throw Error('Invalid commitment');
   return transaction(()=>{
    let inserted=0,updated=0;
    for(const e of events){
     validateEvent(e);
     const before=q.existing.get(scope.genesis,scope.campaign,e.signature,e.instructionPath);
     q.insert.run(scope.genesis,scope.campaign,e.signature,e.instructionPath,ordinalOf(e.instructionPath),e.slot,e.blockTimeUnix,e.program,e.kind,e.actor,JSON.stringify(e.assets),e.detail??null,e.failed?1:0,e.nested?1:0,e.decoderVersion,commitment,observedAt);
     if(before)updated++;else inserted++;
    }
    return {inserted,updated};
   });
  },
  /** What the store knows about a signature: null, or its weakest commitment and row count. */
  signatureState(scope,signature){key(scope);const r=q.signatureState.get(scope.genesis,scope.campaign,signature);return r&&Number(r.n)>0?{commitment:r.commitment,events:Number(r.n)}:null;},
  removeEvents(scope,signatures){key(scope);return transaction(()=>{let n=0;for(const s of signatures)n+=Number(q.deleteSignature.run(scope.genesis,scope.campaign,s).changes);return n;});},
  finalizeEvents(scope,signatures){key(scope);return transaction(()=>{let n=0;for(const s of signatures)n+=Number(q.finalize.run(scope.genesis,scope.campaign,s).changes);return n;});},
  setBlockTime(scope,signature,blockTime){key(scope);if(!Number.isSafeInteger(blockTime)||blockTime<=0)throw Error('Invalid block time');return Number(q.setBlockTime.run(blockTime,scope.genesis,scope.campaign,signature).changes);},
  provisional(scope,limit=50){key(scope);return q.provisional.all(scope.genesis,scope.campaign,limit).map(r=>({signature:r.signature,slot:Number(r.slot),observedAt:Number(r.observed_at)}));},
  missingBlockTime(scope,limit=50){key(scope);return q.missingBlockTime.all(scope.genesis,scope.campaign,limit).map(r=>({signature:r.signature,slot:Number(r.slot)}));},
  eventsOf(scope,signature){key(scope);return q.bySignature.all(scope.genesis,scope.campaign,signature).map(rowToEvent);},
  /** Newest first, keyset pagination in chain order, optional kind filter. */
  events(scope,{cursor=null,limit=50,kinds=null}={}){
   key(scope);const bounded=Math.max(1,Math.min(200,limit));
   const filter=JSON.stringify(kinds&&kinds.length?kinds:[...KINDS]);
   const c=cursor?decodeActivityCursor(cursor):null;if(cursor&&!c)throw Error('Invalid activity cursor');
   const rows=(c?q.after.all(scope.genesis,scope.campaign,filter,c.slot,c.slot,c.signature,c.signature,c.ordinal,bounded+1):q.first.all(scope.genesis,scope.campaign,filter,bounded+1)).map(rowToEvent);
   const page=rows.slice(0,bounded),last=page[page.length-1];
   return {events:page,nextCursor:rows.length>bounded&&last?encodeActivityCursor({slot:last.slot,signature:last.signature,ordinal:ordinalOf(last.instructionPath)}):null};
  },
  /** Totals for the summary: every event, failed attempts, and successful events by kind. */
  counts(scope){
   key(scope);const c=q.counts.get(scope.genesis,scope.campaign);const byKind={};for(const r of q.byKind.all(scope.genesis,scope.campaign))byKind[r.kind]=Number(r.n);
   return {total:Number(c.total),failed:Number(c.failed||0),byKind,provisional:Number(c.provisional||0),missingBlockTime:Number(c.missingBlockTime||0),oldestBlockTime:c.oldest===null?null:Number(c.oldest),newestBlockTime:c.newest===null?null:Number(c.newest)};
  },
  stats(scope){const c=this.counts(scope);return {events:c.total,failed:c.failed,provisional:c.provisional,missingBlockTime:c.missingBlockTime};},
  getCursor(scope){
   cursorKey(scope);const r=q.getCursor.get(scope.genesis,scope.address);
   if(!r)return {newestSignature:null,newestSlot:null,newestBlockTime:null,oldestSignature:null,oldestSlot:null,oldestBlockTime:null,backfillComplete:false,gaps:[],unsupported:[],updatedAt:null};
   return {unsupported:JSON.parse(r.unsupported),newestSignature:r.newest_signature,newestSlot:r.newest_slot===null?null:Number(r.newest_slot),newestBlockTime:r.newest_block_time===null?null:Number(r.newest_block_time),oldestSignature:r.oldest_signature,oldestSlot:r.oldest_slot===null?null:Number(r.oldest_slot),oldestBlockTime:r.oldest_block_time===null?null:Number(r.oldest_block_time),backfillComplete:r.backfill_complete===1,gaps:JSON.parse(r.gaps),updatedAt:Number(r.updated_at)};
  },
  setCursor(scope,cursor,updatedAt=Date.now()){
   cursorKey(scope);if(!Array.isArray(cursor.gaps))throw Error('Cursor gaps must be a list');
   for(const g of cursor.gaps)if(!SIGNATURE.test(g.newerSignature||'')||!SIGNATURE.test(g.olderSignature||''))throw Error('Cursor gap needs newer and older signatures');
   const unsupported=(cursor.unsupported||[]).slice(-MAX_UNSUPPORTED);for(const u of unsupported)if(!SIGNATURE.test(u.signature||''))throw Error('Unsupported entry needs a signature');
   return transaction(()=>{q.setCursor.run(scope.genesis,scope.address,cursor.newestSignature??null,cursor.newestSlot??null,cursor.newestBlockTime??null,cursor.oldestSignature??null,cursor.oldestSlot??null,cursor.oldestBlockTime??null,cursor.backfillComplete?1:0,JSON.stringify(cursor.gaps),JSON.stringify(unsupported),updatedAt);});
  },
  close(){db.close();},
 };
}
// ---------------------------------------------------------------- ingest
export const ACTIVITY_DEFAULTS=Object.freeze({pageLimit:100,maxPagesPerTick:10,concurrency:4,pollIntervalMs:8000,finalizeBatch:50,provisionalMinAgeMs:120000});
/** The addresses whose signature history covers the campaign's activity, with a plain role for the coverage report. */
export function watchedAddresses(identity){
 const list=[{address:identity.campaign,role:'campaign'},{address:identity.feeState,role:'fees'}];
 if(identity.distribution)list.push({address:identity.distribution,role:'distribution'});
 const seen=new Set();return list.filter(w=>{if(seen.has(w.address))return false;seen.add(w.address);return true;});
}
export function createActivityIngest({identity,rpc,store,now=Date.now,log=()=>{},options={}}){
 for(const k of ['genesis','campaign','launchProgram','mint','feeState'])if(typeof identity?.[k]!=='string'||!identity[k])throw Error('Activity identity is incomplete: '+k);
 const opt={...ACTIVITY_DEFAULTS,...options};
 const scope={genesis:identity.genesis,campaign:identity.campaign},watched=watchedAddresses(identity);
 const stats={enabled:true,running:false,ticks:0,lastTickAt:null,lastPollAt:null,lastPollOk:null,lastError:null,lastErrorAt:null,pagesFetched:0,transactionsFetched:0,transactionsSkippedKnown:0,eventsInserted:0,decodeFailures:0,unsupported:0,unsupportedRecorded:0,removed:0,finalized:0,rpcErrors:0,lastBlockTime:null,newestSlot:null,backfillComplete:false,openGaps:0};
 let timer=null,ticking=null,stopped=false;
 const note=error=>{stats.lastError=redact(error?.message||error).slice(0,200);stats.lastErrorAt=now();if(error?.name==='RpcError')stats.rpcErrors++;log({event:'activity-ingest-error',category:error?.category||error?.name||'error',message:stats.lastError});};
 const signatures=(address,params)=>rpc.call('getSignaturesForAddress',[address,{limit:opt.pageLimit,commitment:'confirmed',...params}]);
 const maxVersion=Math.max(...SUPPORTED_VERSIONS.filter(Number.isInteger));
 async function fetchTransaction(signature){
  let tx;
  try{tx=await rpc.call('getTransaction',[signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:maxVersion,commitment:'confirmed'}]);}
  catch(error){if(error?.category==='unsupported-version')return {unsupportedVersion:true};throw error;}
  stats.transactionsFetched++;
  if(tx===null)throw Object.assign(Error('transaction '+signature.slice(0,8)+' not returned yet'),{category:'unresolved'});
  return tx;
 }
 /** Decode one newest-first page (failed transactions included) and store its events. Throws when any transaction is unresolved: nothing of the page is committed. */
 async function processPage(address,entries){
  const known=[],finalizeKnown=[],toFetch=[];
  for(const e of entries){
   if(!SIGNATURE.test(e.signature))continue;
   const state=store.signatureState(scope,e.signature);
   if(state){known.push(e);stats.transactionsSkippedKnown++;if(e.confirmationStatus==='finalized'&&state.commitment!=='finalized')finalizeKnown.push(e.signature);continue;}
   toFetch.push(e);
  }
  const fetched=new Map();let cursor=0;
  const worker=async()=>{while(cursor<toFetch.length){const e=toFetch[cursor++];fetched.set(e.signature,await fetchTransaction(e.signature));}};
  await Promise.all(Array.from({length:Math.min(opt.concurrency,toFetch.length)},worker));
  const confirmed=[],finalized=[],unsupported=[];
  for(const e of toFetch){
   const tx=fetched.get(e.signature);
   const result=tx?.unsupportedVersion?{unsupported:true,version:'>'+maxVersion,events:[],skipped:[]}:decodeActivity(tx,identity);
   if(result.unsupported){stats.unsupported++;unsupported.push({signature:e.signature,slot:e.slot,version:result.version??null});log({event:'activity-unsupported-transaction',signature:e.signature,slot:e.slot,version:String(result.version??'unknown')});continue;}
   for(const s of result.skipped){stats.decodeFailures++;log({event:'activity-decode-skipped',signature:e.signature,path:s.path,reason:s.reason});}
   for(const ev of result.events){
    const record={...ev,blockTimeUnix:ev.blockTimeUnix??(Number.isInteger(e.blockTime)?e.blockTime:null)};
    (e.confirmationStatus==='finalized'?finalized:confirmed).push(record);
    if(record.blockTimeUnix!==null&&(stats.lastBlockTime===null||record.blockTimeUnix>stats.lastBlockTime))stats.lastBlockTime=record.blockTimeUnix;
   }
  }
  let inserted=0;
  store.transaction(()=>{
   if(confirmed.length)inserted+=store.insertEvents(scope,confirmed,{commitment:'confirmed',observedAt:now()}).inserted;
   if(finalized.length)inserted+=store.insertEvents(scope,finalized,{commitment:'finalized',observedAt:now()}).inserted;
   if(finalizeKnown.length)stats.finalized+=store.finalizeEvents(scope,finalizeKnown);
   if(unsupported.length){const c=store.getCursor({genesis:scope.genesis,address});const have=new Set(c.unsupported.map(u=>u.signature));store.setCursor({genesis:scope.genesis,address},{...c,unsupported:[...c.unsupported,...unsupported.filter(u=>!have.has(u.signature))]},now());}
  });
  stats.eventsInserted+=inserted;stats.pagesFetched++;
  return inserted;
 }
 const gapOf=(newer,older,reason)=>({newerSignature:newer.signature,newerSlot:newer.slot,olderSignature:older.signature,olderSlot:older.slot,reason});
 /** Newest signatures of one address since its watermark. */
 async function pollLive(address){
  const cscope={genesis:scope.genesis,address},cursor=store.getCursor(cscope);
  if(!cursor.newestSignature){
   const page=await signatures(address,{});
   if(!page.length){if(!cursor.backfillComplete)store.setCursor(cscope,{...cursor,backfillComplete:true},now());return;}// no history yet (a fee state before creation): covered, nothing to page
   const complete=page.length<opt.pageLimit;
   await processPage(address,page);
   const newest=page[0],oldest=page[page.length-1];
   store.setCursor(cscope,{...store.getCursor(cscope),newestSignature:newest.signature,newestSlot:newest.slot,newestBlockTime:newest.blockTime??null,oldestSignature:oldest.signature,oldestSlot:oldest.slot,oldestBlockTime:oldest.blockTime??null,backfillComplete:complete},now());
   return;
  }
  let before=undefined,newest=null,lastProcessed=null,pages=0;
  const gaps=[...cursor.gaps];
  try{
   for(;;){
    const page=await signatures(address,{before,until:cursor.newestSignature});
    if(!page.length)break;
    await processPage(address,page);
    if(!newest)newest=page[0];lastProcessed=page[page.length-1];pages++;
    if(page.length<opt.pageLimit)break;
    before=lastProcessed.signature;
    if(pages>=opt.maxPagesPerTick){gaps.push(gapOf(lastProcessed,{signature:cursor.newestSignature,slot:cursor.newestSlot},'page budget'));break;}
   }
  }catch(error){
   if(newest&&lastProcessed)gaps.push(gapOf(lastProcessed,{signature:cursor.newestSignature,slot:cursor.newestSlot},'unresolved: '+(error.category||'error')));
   else throw error;
  }
  if(newest)store.setCursor(cscope,{...store.getCursor(cscope),newestSignature:newest.signature,newestSlot:newest.slot,newestBlockTime:newest.blockTime??cursor.newestBlockTime,gaps},now());
 }
 /** Oldest gap first; a gap closes when a page shorter than the limit reaches its older bound. */
 async function fillGaps(address){
  const cscope={genesis:scope.genesis,address},cursor=store.getCursor(cscope);if(!cursor.gaps.length)return;
  const gaps=cursor.gaps.map(g=>({...g}));const gap=gaps[0];let pages=0;
  for(;;){
   const page=await signatures(address,{before:gap.newerSignature,until:gap.olderSignature});
   if(page.length)await processPage(address,page);
   if(page.length<opt.pageLimit){gaps.shift();break;}
   gap.newerSignature=page[page.length-1].signature;gap.newerSlot=page[page.length-1].slot;pages++;
   store.setCursor(cscope,{...store.getCursor(cscope),gaps},now());
   if(pages>=opt.maxPagesPerTick)break;
  }
  store.setCursor(cscope,{...store.getCursor(cscope),gaps},now());
 }
 /** Older history until the address's first signature. */
 async function backfill(address){
  const cscope={genesis:scope.genesis,address};let cursor=store.getCursor(cscope);if(cursor.backfillComplete||!cursor.oldestSignature)return;
  for(let pages=0;pages<opt.maxPagesPerTick;pages++){
   const page=await signatures(address,{before:cursor.oldestSignature});
   const complete=page.length<opt.pageLimit;
   if(page.length)await processPage(address,page);
   const oldest=page.length?page[page.length-1]:null;
   cursor={...store.getCursor(cscope),oldestSignature:oldest?oldest.signature:cursor.oldestSignature,oldestSlot:oldest?oldest.slot:cursor.oldestSlot,oldestBlockTime:oldest?(oldest.blockTime??null):cursor.oldestBlockTime,backfillComplete:complete};
   store.setCursor(cscope,cursor,now());
   if(complete)break;
  }
 }
 /** Provisional rows: finalized -> mark; dropped from history after a grace period -> remove. A failed transaction that finalized stays, marked finalized. */
 async function finalizePass(){
  const pending=store.provisional(scope,opt.finalizeBatch);if(!pending.length)return;
  const statuses=await rpc.call('getSignatureStatuses',[pending.map(p=>p.signature),{searchTransactionHistory:true}]);
  const list=statuses?.value;if(!Array.isArray(list)||list.length!==pending.length)throw Object.assign(Error('getSignatureStatuses: malformed'),{category:'malformed'});
  const done=[],gone=[];
  pending.forEach((p,i)=>{const s=list[i];
   if(s===null){if(now()-p.observedAt>=opt.provisionalMinAgeMs)gone.push(p.signature);return;}
   if(s.confirmationStatus==='finalized')done.push(p.signature);
  });
  if(done.length)stats.finalized+=store.finalizeEvents(scope,done);
  if(gone.length){stats.removed+=store.removeEvents(scope,gone);log({event:'activity-provisional-removed',signatures:gone});}
 }
 async function resolveBlockTimes(){
  for(const m of store.missingBlockTime(scope,opt.finalizeBatch)){const t=await rpc.call('getBlockTime',[m.slot]);if(Number.isInteger(t)&&t>0)store.setBlockTime(scope,m.signature,t);}
 }
 function refreshCoverage(){
  let gaps=0,complete=true,newest=null,unsupported=0;
  for(const w of watched){const c=store.getCursor({genesis:scope.genesis,address:w.address});gaps+=c.gaps.length;if(!c.backfillComplete)complete=false;if(c.newestSlot!==null&&(newest===null||c.newestSlot>newest))newest=c.newestSlot;unsupported+=c.unsupported.length;}
  stats.openGaps=gaps;stats.backfillComplete=complete;stats.newestSlot=newest;stats.unsupportedRecorded=unsupported;
 }
 async function tick(){
  if(ticking)return ticking;
  ticking=(async()=>{
   stats.ticks++;stats.lastTickAt=now();let pollOk=true;
   for(const w of watched){
    for(const step of [pollLive,fillGaps,backfill]){if(stopped)break;try{await step(w.address);}catch(error){if(step===pollLive)pollOk=false;note(error);}}
   }
   for(const step of [finalizePass,resolveBlockTimes]){if(stopped)break;try{await step();}catch(error){note(error);}}
   stats.lastPollAt=now();stats.lastPollOk=pollOk;refreshCoverage();
  })().finally(()=>{ticking=null;});
  return ticking;
 }
 return {
  scope,identity,watched,tick,pollLive,fillGaps,backfill,finalizePass,resolveBlockTimes,
  start(){if(stats.running)return;stats.running=true;stopped=false;timer=setInterval(()=>{tick().catch(()=>{});},opt.pollIntervalMs);timer.unref?.();tick().catch(()=>{});},
  async stop(){stopped=true;stats.running=false;clearInterval(timer);if(ticking)await ticking.catch(()=>{});},
  coverage(){return watched.map(w=>{const c=store.getCursor({genesis:scope.genesis,address:w.address});return {address:w.address,role:w.role,completeToStart:c.backfillComplete,newestSlot:c.newestSlot,oldestSlot:c.oldestSlot,gaps:c.gaps.map(g=>({newerSlot:g.newerSlot,olderSlot:g.olderSlot,reason:g.reason})),unsupported:c.unsupported.length,updatedAt:c.updatedAt};});},
  stats(){
   const t=now();
   return {...stats,lagSeconds:stats.lastPollAt===null?null:Math.round((t-stats.lastPollAt)/1000),lastEventAgeSeconds:stats.lastBlockTime===null?null:Math.max(0,Math.round(t/1000-stats.lastBlockTime)),connected:stats.lastPollOk===true&&t-stats.lastPollAt<opt.pollIntervalMs*3,rpc:rpc.stats?.()||null,store:store.stats(scope)};
  },
 };
}
// ---------------------------------------------------------------- api
export const STALE_AFTER_SECONDS=120;
export function activityStatus(stats,coverage,counts){
 if(!stats)return 'disabled';
 if(stats.lastPollOk===false||(stats.lagSeconds!==null&&stats.lagSeconds>STALE_AFTER_SECONDS))return 'stale';
 if(stats.lastPollAt===null)return 'starting';
 if(coverage.some(c=>!c.completeToStart||c.gaps.length))return 'backfilling';
 if(!counts?.total)return 'no-activity';
 return 'live';
}
export function shapeEvent(e){
 return {signature:e.signature,path:e.instructionPath,slot:e.slot,time:e.blockTimeUnix,program:e.program,kind:e.kind,actor:e.actor,
  assets:e.assets.map(a=>({mint:a.mint,amountRaw:a.amountRaw,decimals:a.decimals,amount:Number(BigInt(a.amountRaw))/10**a.decimals,direction:a.direction,role:a.role??null,account:a.account??null})),
  status:e.status,nested:e.nested,detail:e.detail??null,decoderVersion:e.decoderVersion};
}
const int=(v,fallback)=>{if(v===undefined||v===null||v==='')return fallback;if(!/^\d{1,12}$/.test(v))throw Error('Invalid number: '+v);return Number(v);};
/** feed: {enabled, identity():identity|null, store():store|null, stats():stats|null, coverage():[]} */
export function createActivityApi({feed,now=Date.now,cacheMs=2000,maxCacheEntries=200}){
 const cache=new Map();
 function cached(key,compute){
  const t=now();const hit=cache.get(key);
  if(hit&&(hit.pending||hit.expires>t))return hit.promise;
  const entry={pending:true,expires:t+cacheMs,promise:null};
  entry.promise=Promise.resolve().then(compute).then(value=>{entry.pending=false;entry.expires=now()+cacheMs;return value;},error=>{cache.delete(key);throw error;});
  if(cache.size>=maxCacheEntries)cache.delete(cache.keys().next().value);
  cache.set(key,entry);return entry.promise;
 }
 function context(params){
  if(!feed.enabled)return {error:{status:503,body:{error:'Activity data is switched off',status:'disabled'}}};
  const identity=feed.identity(),store=feed.store();
  if(!identity||!store)return {error:{status:503,body:{error:'Activity is not available until the campaign has launched',status:'not-launched'}}};
  const campaign=params.get('campaign');
  if(typeof campaign!=='string'||!ADDRESS.test(campaign))return {error:{status:400,body:{error:'campaign is required'}}};
  if(campaign!==identity.campaign)return {error:{status:404,body:{error:'Campaign is not a registered launched pool'}}};
  return {identity,store,scope:{genesis:identity.genesis,campaign:identity.campaign}};
 }
 function activity(ctx,params){
  const limit=int(params.get('limit'),50);if(limit<1||limit>200)throw Error('limit must be between 1 and 200');
  const kindsParam=params.get('kinds');let kinds=null;
  if(kindsParam){kinds=kindsParam.split(',').map(s=>s.trim()).filter(Boolean);if(!kinds.length||kinds.length>KINDS.length)throw Error('kinds is empty');for(const k of kinds)if(!KINDS.includes(k))throw Error('unknown kind: '+k.slice(0,40));}
  const page=ctx.store.events(ctx.scope,{cursor:params.get('cursor')||null,limit,kinds});
  const counts=ctx.store.counts(ctx.scope),stats=feed.stats(),coverage=feed.coverage?.()||[];
  return {campaign:ctx.identity.campaign,mint:ctx.identity.mint,events:page.events.map(shapeEvent),nextCursor:page.nextCursor,
   counts:{total:counts.total,failed:counts.failed,byKind:counts.byKind},
   status:activityStatus(stats,coverage,counts),
   feed:stats?{connected:stats.connected,lagSeconds:stats.lagSeconds,lastPollAt:stats.lastPollAt,lastEventAgeSeconds:stats.lastEventAgeSeconds,backfillComplete:stats.backfillComplete,openGaps:stats.openGaps,decodeFailures:stats.decodeFailures,unsupportedTransactions:stats.unsupportedRecorded??0,provisional:counts.provisional}:null,
   coverage:{oldestBlockTime:counts.oldestBlockTime,newestBlockTime:counts.newestBlockTime,addresses:coverage},at:new Date(now()).toISOString()};
 }
 async function handle(req,res){
  const url=new URL(req.url,'http://localhost');
  if(url.pathname!=='/api/market/activity')return false;
  const send=(code,data)=>{if(res.writableEnded)return;res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'public, max-age=2','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
  if(req.method!=='GET'){send(405,{error:'Method not allowed'});return true;}
  const ctx=context(url.searchParams);if(ctx.error){send(ctx.error.status,ctx.error.body);return true;}
  const key=url.pathname+'?'+[...url.searchParams.entries()].filter(([k])=>['campaign','cursor','limit','kinds'].includes(k)).sort().map(([k,v])=>k+'='+v).join('&');
  try{send(200,await cached(key,()=>activity(ctx,url.searchParams)));}
  catch(error){send(400,{error:String(error.message||error).slice(0,200)});}
  return true;
 }
 return {handle,middleware:(req,res,next)=>{handle(req,res).then(handled=>{if(!handled)next();},next);},cacheSize:()=>cache.size};
}
// ---------------------------------------------------------------- feed bootstrap
export const activityFeedEnabled=(env=process.env)=>marketFeedEnabled(env)&&env.KIDS_MARKET_ACTIVITY!=='0';
/** Activity identity from a resolved campaign (postlaunch-campaign.mjs resolve()): the campaign, its programs, the fee-state PDA and, for a vault campaign, the distribution record. */
export async function activityIdentityFromCampaign(selected,{decimalsOf,PublicKey,distributionAddress}){
 const {ctx,state,campaign}=selected;
 const coinDecimals=await decimalsOf(ctx,state.mint);
 if(!Number.isInteger(coinDecimals)||coinDecimals<0||coinDecimals>18)throw Error('Coin decimals unavailable');
 const feeState=PublicKey.findProgramAddressSync([Buffer.from('fees'),campaign.toBuffer()],ctx.programId)[0].toBase58();
 const distributionProgram=state.distributionProgram?state.distributionProgram.toBase58():null;
 return {genesis:ctx.manifest.genesisHash,campaign:campaign.toBase58(),mint:state.mint.toBase58(),coinDecimals,launchProgram:ctx.programId.toBase58(),feeState,distributionProgram,distribution:distributionProgram?distributionAddress(distributionProgram,campaign).toBase58():null,scope:selected.scope};
}
async function defaultResolve(){
 const [{resolvePostlaunchCampaign},{distributionAddress},{PublicKey}]=await Promise.all([import('../postlaunch-campaign.mjs'),import('../distribution.mjs'),import('@solana/web3.js')]);
 let selected=await resolvePostlaunchCampaign('active');
 if(!selected&&(process.env.KIDS_NETWORK||'localnet')==='localnet')selected=await resolvePostlaunchCampaign('rehearsal');
 if(!selected)return null;
 return activityIdentityFromCampaign(selected,{PublicKey,distributionAddress,decimalsOf:async(ctx,mint)=>(await ctx.connection.getTokenSupply(mint)).value.decimals});
}
export function createActivityFeed({env=process.env,resolve=defaultResolve,storePath=DEFAULT_STORE_PATH,rpcUrl=null,log=line=>console.log(JSON.stringify(line)),retryMs=60000,options={},now=Date.now}={}){
 const enabled=activityFeedEnabled(env);
 let identity=null,store=null,ingest=null,timer=null,stopped=false,lastResolveError=null,starting=null;
 const feed={enabled,identity:()=>identity,store:()=>store,stats:()=>ingest?ingest.stats():null,coverage:()=>ingest?ingest.coverage():[],lastResolveError:()=>lastResolveError};
 /** Compact status: no URLs, no keys. */
 function status(){const s=feed.stats();return {enabled,running:!!ingest,campaign:identity?.campaign||null,connected:s?s.connected:null,lagSeconds:s?s.lagSeconds:null,openGaps:s?s.openGaps:0,decodeFailures:s?s.decodeFailures:0,unsupported:s?s.unsupportedRecorded:0,rpcErrors:s?s.rpcErrors:0,provisional:s?.store?.provisional??0,backfillComplete:s?s.backfillComplete:false,lastError:s?.lastError||lastResolveError||null};}
 async function attempt(){
  if(stopped||ingest||starting)return;
  starting=(async()=>{
   try{
    const found=await resolve();if(!found){lastResolveError='no launched campaign yet';return;}
    const url=rpcUrl||(await import('../network.mjs')).networkProfile(env).rpcUrl;
    store=openActivityStore(storePath);
    identity=found;
    ingest=createActivityIngest({identity,rpc:createRpcClient({url}),store,now,log,options});
    ingest.start();
    lastResolveError=null;
    log({event:'activity-feed-started',campaign:identity.campaign,watched:ingest.watched.map(w=>w.role),scope:identity.scope,store:storePath.replace(/^.*\/(\.runtime\/)/,'$1')});
   }catch(error){lastResolveError=redact(error?.message||error).slice(0,200);log({event:'activity-feed-waiting',reason:lastResolveError});}
   finally{starting=null;}
  })();
  return starting;
 }
 return {
  ...feed,
  api:createActivityApi({feed,now}),
  status,
  start(){if(!enabled){log({event:'activity-feed-disabled',reason:env.KIDS_MARKET_FEED==='0'?'KIDS_MARKET_FEED=0':'KIDS_MARKET_ACTIVITY=0'});return;}if(timer)return;attempt();timer=setInterval(attempt,retryMs);timer.unref?.();},
  async stop(){stopped=true;clearInterval(timer);timer=null;if(starting)await starting;if(ingest)await ingest.stop();ingest=null;store?.close();store=null;identity=null;},
  attempt,
 };
}
