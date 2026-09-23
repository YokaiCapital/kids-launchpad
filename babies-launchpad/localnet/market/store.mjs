// Durable market store: swaps, candles, replay cursor. SQLite (node:sqlite) on the runtime volume, WAL, every
// write inside a transaction, every insert idempotent. Amounts and prices are stored as decimal TEXT (u64 and the
// 1e18-scaled price) and aggregated with BigInt; candles are recomputed deterministically from the swaps of each
// affected bucket, so out-of-order arrival, duplicates, removed provisional rows and late block times all converge
// on the same candles. Single writer by design (plan section 4): this is the staged option, not a shared database.
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
export const SCHEMA_VERSION=1;
export const INTERVALS=Object.freeze({'1m':60,'5m':300,'15m':900,'1h':3600,'1d':86400});
export const INTERVAL_NAMES=Object.freeze(Object.keys(INTERVALS));
const ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/,SIGNATURE=/^[1-9A-HJ-NP-Za-km-z]{64,90}$/,U64=/^\d{1,20}$/,PATH=/^\d{1,4}(\.\d{1,4})?$/;
const NO_INDEX=2147483647;
/** Transactions the decoder refused for their version are remembered (newest 200) so health can show them and a later decoder can revisit them. */
export const MAX_UNSUPPORTED=200;
/** Chain order inside one bucket: slot, then transaction index (unknown last), then signature, then instruction path by components. */
export function compareSwapOrder(a,b){
 if(a.slot!==b.slot)return a.slot-b.slot;
 const ai=a.txIndex??NO_INDEX,bi=b.txIndex??NO_INDEX;if(ai!==bi)return ai-bi;
 if(a.signature!==b.signature)return a.signature<b.signature?-1:1;
 const ap=a.instructionPath.split('.').map(Number),bp=b.instructionPath.split('.').map(Number);
 for(let i=0;i<Math.max(ap.length,bp.length);i++){const x=ap[i]??-1,y=bp[i]??-1;if(x!==y)return x-y;}
 return 0;
}
export const bucketStart=(blockTime,interval)=>Math.floor(blockTime/INTERVALS[interval])*INTERVALS[interval];
export const encodeCursor=c=>Buffer.from(JSON.stringify(c)).toString('base64url');
export function decodeCursor(text){
 if(typeof text!=='string'||!text||text.length>400)return null;
 try{const c=JSON.parse(Buffer.from(text,'base64url').toString('utf8'));if(!Number.isSafeInteger(c.slot)||!Number.isSafeInteger(c.ti)||!SIGNATURE.test(c.signature)||!PATH.test(c.path))return null;return c;}catch{return null;}
}
function validateSwap(s){
 if(!SIGNATURE.test(s.signature||''))throw Error('Invalid swap signature');
 if(!PATH.test(s.instructionPath||''))throw Error('Invalid swap instruction path');
 if(!Number.isSafeInteger(s.slot)||s.slot<0)throw Error('Invalid swap slot');
 if(!(s.blockTime===null||(Number.isSafeInteger(s.blockTime)&&s.blockTime>0)))throw Error('Invalid swap block time');
 if(!(s.txIndex==null||(Number.isSafeInteger(s.txIndex)&&s.txIndex>=0)))throw Error('Invalid swap transaction index');
 if(!['buy','sell'].includes(s.side))throw Error('Invalid swap side');
 for(const k of ['inputAmount','outputAmount','solLamports','coinRaw','priceScaled'])if(!U64.test(s[k]||'')&&!/^\d{21,60}$/.test(s[k]||''))throw Error('Invalid swap amount: '+k);
 if(!Number.isInteger(s.coinDecimals)||s.coinDecimals<0||s.coinDecimals>18)throw Error('Invalid swap decimals');
 if(!ADDRESS.test(s.inputMint||'')||!ADDRESS.test(s.outputMint||''))throw Error('Invalid swap mint');
 if(!(s.trader===null||ADDRESS.test(s.trader||'')))throw Error('Invalid swap trader');
}
const rowToSwap=r=>({genesis:r.genesis,pool:r.pool,signature:r.signature,instructionPath:r.instruction_path,slot:Number(r.slot),txIndex:r.tx_index===null?null:Number(r.tx_index),blockTime:r.block_time===null?null:Number(r.block_time),side:r.side,trader:r.trader,inputMint:r.input_mint,inputAmount:r.input_amount,outputMint:r.output_mint,outputAmount:r.output_amount,solLamports:r.sol_lamports,coinRaw:r.coin_raw,coinDecimals:Number(r.coin_decimals),priceScaled:r.price_scaled,priceSol:Number(r.price_sol),nested:r.nested===1,outerProgram:r.outer_program,kind:r.kind,decoderVersion:Number(r.decoder_version),commitment:r.commitment,observedAt:Number(r.observed_at)});
const rowToCandle=r=>({interval:r.interval,time:Number(r.bucket_start),open:r.open,high:r.high,low:r.low,close:r.close,volumeSol:r.volume_sol,volumeCoin:r.volume_coin,trades:Number(r.trades),buys:Number(r.buys),sells:Number(r.sells),firstSlot:Number(r.first_slot),lastSlot:Number(r.last_slot)});
export function openMarketStore(path=':memory:'){
 if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const db=new DatabaseSync(path);
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS market_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS swaps(
  genesis TEXT NOT NULL, pool TEXT NOT NULL, signature TEXT NOT NULL, instruction_path TEXT NOT NULL,
  slot INTEGER NOT NULL, tx_index INTEGER, block_time INTEGER,
  side TEXT NOT NULL, trader TEXT, input_mint TEXT NOT NULL, input_amount TEXT NOT NULL, output_mint TEXT NOT NULL, output_amount TEXT NOT NULL,
  sol_lamports TEXT NOT NULL, coin_raw TEXT NOT NULL, coin_decimals INTEGER NOT NULL, price_scaled TEXT NOT NULL, price_sol REAL NOT NULL,
  nested INTEGER NOT NULL, outer_program TEXT, kind TEXT NOT NULL, decoder_version INTEGER NOT NULL,
  commitment TEXT NOT NULL, observed_at INTEGER NOT NULL,
  PRIMARY KEY(genesis,pool,signature,instruction_path)) WITHOUT ROWID;
 CREATE INDEX IF NOT EXISTS swaps_time ON swaps(genesis,pool,block_time);
 CREATE INDEX IF NOT EXISTS swaps_order ON swaps(genesis,pool,slot,tx_index,signature,instruction_path);
 CREATE INDEX IF NOT EXISTS swaps_commitment ON swaps(genesis,pool,commitment,slot);
 CREATE TABLE IF NOT EXISTS candles(
  genesis TEXT NOT NULL, pool TEXT NOT NULL, interval TEXT NOT NULL, bucket_start INTEGER NOT NULL,
  open TEXT NOT NULL, high TEXT NOT NULL, low TEXT NOT NULL, close TEXT NOT NULL,
  volume_sol TEXT NOT NULL, volume_coin TEXT NOT NULL, trades INTEGER NOT NULL, buys INTEGER NOT NULL, sells INTEGER NOT NULL,
  first_slot INTEGER NOT NULL, last_slot INTEGER NOT NULL,
  PRIMARY KEY(genesis,pool,interval,bucket_start)) WITHOUT ROWID;
 CREATE TABLE IF NOT EXISTS cursor(
  genesis TEXT NOT NULL, pool TEXT NOT NULL,
  newest_signature TEXT, newest_slot INTEGER, newest_block_time INTEGER,
  oldest_signature TEXT, oldest_slot INTEGER, oldest_block_time INTEGER,
  backfill_complete INTEGER NOT NULL DEFAULT 0, gaps TEXT NOT NULL DEFAULT '[]', unsupported TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL,
  PRIMARY KEY(genesis,pool)) WITHOUT ROWID;
 INSERT OR IGNORE INTO market_meta(key,value) VALUES('schema','${SCHEMA_VERSION}');`);
 const found=db.prepare("SELECT value FROM market_meta WHERE key='schema'").get();
 if(Number(found?.value)!==SCHEMA_VERSION){db.close();throw Error('Market store schema '+found?.value+' is not '+SCHEMA_VERSION+'; migrate before opening');}
 const q={
  insert:db.prepare(`INSERT INTO swaps(genesis,pool,signature,instruction_path,slot,tx_index,block_time,side,trader,input_mint,input_amount,output_mint,output_amount,sol_lamports,coin_raw,coin_decimals,price_scaled,price_sol,nested,outer_program,kind,decoder_version,commitment,observed_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(genesis,pool,signature,instruction_path) DO UPDATE SET
    commitment=CASE WHEN excluded.commitment='finalized' THEN 'finalized' ELSE swaps.commitment END,
    block_time=COALESCE(swaps.block_time,excluded.block_time), tx_index=COALESCE(swaps.tx_index,excluded.tx_index)`),
  existing:db.prepare('SELECT block_time,commitment,tx_index FROM swaps WHERE genesis=? AND pool=? AND signature=? AND instruction_path=?'),
  bySignature:db.prepare('SELECT * FROM swaps WHERE genesis=? AND pool=? AND signature=?'),
  bucketRows:db.prepare('SELECT * FROM swaps WHERE genesis=? AND pool=? AND block_time>=? AND block_time<?'),
  upsertCandle:db.prepare(`INSERT INTO candles(genesis,pool,interval,bucket_start,open,high,low,close,volume_sol,volume_coin,trades,buys,sells,first_slot,last_slot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(genesis,pool,interval,bucket_start) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume_sol=excluded.volume_sol,volume_coin=excluded.volume_coin,trades=excluded.trades,buys=excluded.buys,sells=excluded.sells,first_slot=excluded.first_slot,last_slot=excluded.last_slot`),
  deleteCandle:db.prepare('DELETE FROM candles WHERE genesis=? AND pool=? AND interval=? AND bucket_start=?'),
  deleteSwap:db.prepare('DELETE FROM swaps WHERE genesis=? AND pool=? AND signature=?'),
  finalize:db.prepare("UPDATE swaps SET commitment='finalized' WHERE genesis=? AND pool=? AND signature=?"),
  setBlockTime:db.prepare('UPDATE swaps SET block_time=? WHERE genesis=? AND pool=? AND signature=? AND block_time IS NULL'),
  provisional:db.prepare("SELECT signature, MIN(slot) AS slot, MIN(observed_at) AS observed_at FROM swaps WHERE genesis=? AND pool=? AND commitment='confirmed' GROUP BY signature ORDER BY slot ASC LIMIT ?"),
  missingBlockTime:db.prepare('SELECT signature, MIN(slot) AS slot FROM swaps WHERE genesis=? AND pool=? AND block_time IS NULL GROUP BY signature ORDER BY slot ASC LIMIT ?'),
  candles:db.prepare('SELECT * FROM candles WHERE genesis=? AND pool=? AND interval=? AND bucket_start>=? AND bucket_start<? ORDER BY bucket_start ASC LIMIT ?'),
  candlesSince:db.prepare('SELECT * FROM candles WHERE genesis=? AND pool=? AND interval=? AND bucket_start>=? AND bucket_start<=? ORDER BY bucket_start ASC'),
  lastSwap:db.prepare('SELECT * FROM swaps WHERE genesis=? AND pool=? AND block_time IS NOT NULL ORDER BY slot DESC, COALESCE(tx_index,2147483647) DESC, signature DESC, instruction_path DESC LIMIT 1'),
  tradesFirst:db.prepare('SELECT * FROM swaps WHERE genesis=? AND pool=? ORDER BY slot DESC, COALESCE(tx_index,2147483647) DESC, signature DESC, instruction_path DESC LIMIT ?'),
  tradesAfter:db.prepare(`SELECT * FROM swaps WHERE genesis=? AND pool=? AND (slot<? OR (slot=? AND (COALESCE(tx_index,2147483647)<? OR (COALESCE(tx_index,2147483647)=? AND (signature<? OR (signature=? AND instruction_path<?))))))
   ORDER BY slot DESC, COALESCE(tx_index,2147483647) DESC, signature DESC, instruction_path DESC LIMIT ?`),
  counts:db.prepare("SELECT COUNT(*) AS swaps, SUM(CASE WHEN commitment='confirmed' THEN 1 ELSE 0 END) AS provisional, SUM(CASE WHEN block_time IS NULL THEN 1 ELSE 0 END) AS missingBlockTime, MIN(block_time) AS oldest, MAX(block_time) AS newest FROM swaps WHERE genesis=? AND pool=?"),
  candleCount:db.prepare('SELECT COUNT(*) AS n FROM candles WHERE genesis=? AND pool=?'),
  getCursor:db.prepare('SELECT * FROM cursor WHERE genesis=? AND pool=?'),
  setCursor:db.prepare(`INSERT INTO cursor(genesis,pool,newest_signature,newest_slot,newest_block_time,oldest_signature,oldest_slot,oldest_block_time,backfill_complete,gaps,unsupported,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(genesis,pool) DO UPDATE SET newest_signature=excluded.newest_signature,newest_slot=excluded.newest_slot,newest_block_time=excluded.newest_block_time,oldest_signature=excluded.oldest_signature,oldest_slot=excluded.oldest_slot,oldest_block_time=excluded.oldest_block_time,backfill_complete=excluded.backfill_complete,gaps=excluded.gaps,unsupported=excluded.unsupported,updated_at=excluded.updated_at`),
 };
 let depth=0;
 function transaction(fn){
  if(depth>0)return fn();
  db.exec('BEGIN IMMEDIATE');depth++;
  try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}finally{depth--;}
 }
 const key=(scope)=>{if(!ADDRESS.test(scope?.pool||'')||typeof scope?.genesis!=='string'||!scope.genesis)throw Error('Market scope requires genesis and pool');return scope;};
 function rebuildBucket(scope,interval,start){
  const size=INTERVALS[interval];
  const rows=q.bucketRows.all(scope.genesis,scope.pool,start,start+size).map(rowToSwap).sort(compareSwapOrder);
  if(!rows.length){q.deleteCandle.run(scope.genesis,scope.pool,interval,start);return null;}
  let high=BigInt(rows[0].priceScaled),low=high,volumeSol=0n,volumeCoin=0n,buys=0,sells=0;
  for(const r of rows){const p=BigInt(r.priceScaled);if(p>high)high=p;if(p<low)low=p;volumeSol+=BigInt(r.solLamports);volumeCoin+=BigInt(r.coinRaw);if(r.side==='buy')buys++;else sells++;}
  const candle={interval,time:start,open:rows[0].priceScaled,high:high.toString(),low:low.toString(),close:rows[rows.length-1].priceScaled,volumeSol:volumeSol.toString(),volumeCoin:volumeCoin.toString(),trades:rows.length,buys,sells,firstSlot:rows[0].slot,lastSlot:rows[rows.length-1].slot};
  q.upsertCandle.run(scope.genesis,scope.pool,interval,start,candle.open,candle.high,candle.low,candle.close,candle.volumeSol,candle.volumeCoin,candle.trades,candle.buys,candle.sells,candle.firstSlot,candle.lastSlot);
  return candle;
 }
 function rebuildTimes(scope,blockTimes){
  const done=new Set();
  for(const t of blockTimes){if(t==null)continue;for(const interval of INTERVAL_NAMES){const start=bucketStart(t,interval),k=interval+':'+start;if(done.has(k))continue;done.add(k);rebuildBucket(scope,interval,start);}}
  return done.size;
 }
 return {
  path,
  transaction,
  /** Idempotent: new rows are inserted, known rows may only gain a block time, a transaction index or a finalized commitment. Candles of every touched bucket are rebuilt. */
  insertSwaps(scope,swaps,{commitment='confirmed',observedAt=Date.now(),txIndexOf=null}={}){
   key(scope);if(!['confirmed','finalized'].includes(commitment))throw Error('Invalid commitment');
   return transaction(()=>{
    let inserted=0,updated=0;const times=[];
    for(const s of swaps){
     validateSwap(s);
     const txIndex=s.txIndex??(txIndexOf?txIndexOf(s):null);
     const before=q.existing.get(scope.genesis,scope.pool,s.signature,s.instructionPath);
     q.insert.run(scope.genesis,scope.pool,s.signature,s.instructionPath,s.slot,txIndex,s.blockTime,s.side,s.trader,s.inputMint,s.inputAmount,s.outputMint,s.outputAmount,s.solLamports,s.coinRaw,s.coinDecimals,s.priceScaled,Number(BigInt(s.priceScaled))/1e18,s.nested?1:0,s.outerProgram||null,s.kind,s.decoderVersion,commitment,observedAt);
     if(!before){inserted++;times.push(s.blockTime);}
     else{updated++;if(before.block_time===null&&s.blockTime!==null)times.push(s.blockTime);else if(before.tx_index===null&&txIndex!==null)times.push(before.block_time);}
    }
    const buckets=rebuildTimes(scope,times);
    return {inserted,updated,buckets};
   });
  },
  /** Removes every record of the signatures (dropped or failed after a provisional observation) and rebuilds their candles. */
  removeSwaps(scope,signatures){
   key(scope);
   return transaction(()=>{const times=[];let removed=0;for(const sig of signatures){for(const r of q.bySignature.all(scope.genesis,scope.pool,sig))times.push(r.block_time);removed+=Number(q.deleteSwap.run(scope.genesis,scope.pool,sig).changes);}rebuildTimes(scope,times);return removed;});
  },
  finalizeSwaps(scope,signatures){key(scope);return transaction(()=>{let n=0;for(const sig of signatures)n+=Number(q.finalize.run(scope.genesis,scope.pool,sig).changes);return n;});},
  setBlockTime(scope,signature,blockTime){key(scope);if(!Number.isSafeInteger(blockTime)||blockTime<=0)throw Error('Invalid block time');return transaction(()=>{const n=Number(q.setBlockTime.run(blockTime,scope.genesis,scope.pool,signature).changes);if(n)rebuildTimes(scope,[blockTime]);return n;});},
  provisional(scope,limit=50){key(scope);return q.provisional.all(scope.genesis,scope.pool,limit).map(r=>({signature:r.signature,slot:Number(r.slot),observedAt:Number(r.observed_at)}));},
  missingBlockTime(scope,limit=50){key(scope);return q.missingBlockTime.all(scope.genesis,scope.pool,limit).map(r=>({signature:r.signature,slot:Number(r.slot)}));},
  swapsOf(scope,signature){key(scope);return q.bySignature.all(scope.genesis,scope.pool,signature).map(rowToSwap).sort(compareSwapOrder);},
  candles(scope,interval,from,to,limit=1000){
   key(scope);if(!INTERVALS[interval])throw Error('Unknown interval');
   return q.candles.all(scope.genesis,scope.pool,interval,from,to,Math.max(1,Math.min(1000,limit))).map(rowToCandle);
  },
  /** Newest first, keyset pagination in chain order. */
  trades(scope,{cursor=null,limit=50}={}){
   key(scope);const bounded=Math.max(1,Math.min(200,limit));
   const c=cursor?decodeCursor(cursor):null;if(cursor&&!c)throw Error('Invalid trades cursor');
   const rows=(c?q.tradesAfter.all(scope.genesis,scope.pool,c.slot,c.slot,c.ti,c.ti,c.signature,c.signature,c.path,bounded+1):q.tradesFirst.all(scope.genesis,scope.pool,bounded+1)).map(rowToSwap);
   const page=rows.slice(0,bounded),last=page[page.length-1];
   return {trades:page,nextCursor:rows.length>bounded&&last?encodeCursor({slot:last.slot,ti:last.txIndex??NO_INDEX,signature:last.signature,path:last.instructionPath}):null};
  },
  /** Last fill plus a trailing 24 h window aggregated from the 1m candles (exact sums). */
  summary(scope,nowUnix){
   key(scope);const last=q.lastSwap.get(scope.genesis,scope.pool);
   const since=bucketStart(nowUnix-86400,'1m'),window=q.candlesSince.all(scope.genesis,scope.pool,'1m',since,bucketStart(nowUnix,'1m')).map(rowToCandle);
   let volumeSol=0n,volumeCoin=0n,trades=0,buys=0,sells=0;for(const c of window){volumeSol+=BigInt(c.volumeSol);volumeCoin+=BigInt(c.volumeCoin);trades+=c.trades;buys+=c.buys;sells+=c.sells;}
   const counts=q.counts.get(scope.genesis,scope.pool);
   return {last:last?rowToSwap(last):null,open24h:window.length?window[0].open:null,volume24hSol:volumeSol.toString(),volume24hCoin:volumeCoin.toString(),trades24h:trades,buys24h:buys,sells24h:sells,tradesTotal:Number(counts.swaps),oldestBlockTime:counts.oldest===null?null:Number(counts.oldest),newestBlockTime:counts.newest===null?null:Number(counts.newest)};
  },
  stats(scope){key(scope);const c=q.counts.get(scope.genesis,scope.pool);return {swaps:Number(c.swaps),provisional:Number(c.provisional||0),missingBlockTime:Number(c.missingBlockTime||0),candles:Number(q.candleCount.get(scope.genesis,scope.pool).n)};},
  getCursor(scope){
   key(scope);const r=q.getCursor.get(scope.genesis,scope.pool);
   if(!r)return {newestSignature:null,newestSlot:null,newestBlockTime:null,oldestSignature:null,oldestSlot:null,oldestBlockTime:null,backfillComplete:false,gaps:[],unsupported:[],updatedAt:null};
   return {unsupported:JSON.parse(r.unsupported),newestSignature:r.newest_signature,newestSlot:r.newest_slot===null?null:Number(r.newest_slot),newestBlockTime:r.newest_block_time===null?null:Number(r.newest_block_time),oldestSignature:r.oldest_signature,oldestSlot:r.oldest_slot===null?null:Number(r.oldest_slot),oldestBlockTime:r.oldest_block_time===null?null:Number(r.oldest_block_time),backfillComplete:r.backfill_complete===1,gaps:JSON.parse(r.gaps),updatedAt:Number(r.updated_at)};
  },
  setCursor(scope,cursor,updatedAt=Date.now()){
   key(scope);if(!Array.isArray(cursor.gaps))throw Error('Cursor gaps must be a list');
   for(const g of cursor.gaps)if(!SIGNATURE.test(g.newerSignature||'')||!SIGNATURE.test(g.olderSignature||''))throw Error('Cursor gap needs newer and older signatures');
   const unsupported=(cursor.unsupported||[]).slice(-MAX_UNSUPPORTED);for(const u of unsupported)if(!SIGNATURE.test(u.signature||''))throw Error('Unsupported entry needs a signature');
   return transaction(()=>{q.setCursor.run(scope.genesis,scope.pool,cursor.newestSignature??null,cursor.newestSlot??null,cursor.newestBlockTime??null,cursor.oldestSignature??null,cursor.oldestSlot??null,cursor.oldestBlockTime??null,cursor.backfillComplete?1:0,JSON.stringify(cursor.gaps),JSON.stringify(unsupported),updatedAt);});
  },
  close(){db.close();},
 };
}
