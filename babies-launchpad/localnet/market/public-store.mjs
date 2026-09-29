// Shared, finalized market projection. Incremental candles are O(page size), not
// a rescan of the day's entire trade history. Existing SQLite feed is unchanged.
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {isAddress} from '../registry/registry.mjs';
import {validateSwap,INTERVALS,bucketStart} from './store.mjs';
import {validateFeeProjection} from './public-fees.mjs';
const name=/^[A-Za-z0-9_.:-]{1,128}$/;
function scope(s){if(!isAddress(s?.genesis)||!isAddress(s?.pool))throw Error('Invalid market scope');return [s.genesis,s.pool];}
const order=s=>String(s.slot).padStart(16,'0')+':'+String(s.txIndex??2147483647).padStart(10,'0')+':'+s.signature+':'+s.instructionPath.split('.').map(n=>n.padStart(4,'0')).join('.');
const cursorRow=r=>r?{revision:Number(r.revision),body:JSON.parse(r.body),updatedAt:Number(r.updated_at)}:{revision:0,body:null,updatedAt:null};
const stale=()=>Object.assign(Error('Market job lease expired'),{code:'STALE_LEASE'});
export function createPublicMarketStore(registry){
 if(registry?.driver!=='postgres')throw Error('Shared market store requires PostgreSQL');
 const query=(sql,p=[])=>registry.query(sql,p);
 async function cursor(s,stream){if(!name.test(stream))throw Error('Invalid market stream');return cursorRow((await query('SELECT * FROM public_market_cursors WHERE genesis=? AND pool=? AND stream=?',[...scope(s),stream])).rows[0]);}
 async function commitPage({scope:s,stream,expectedRevision,body,swaps,job,followups=[],market=null,fees=null}){
  const [genesis,pool]=scope(s);
  if(!name.test(stream)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||!Array.isArray(swaps)||swaps.length>1000||!job?.jobId||!Array.isArray(followups)||followups.length>2)throw Error('Invalid market page');
  if(Buffer.byteLength(canonicalJson(body))>8192)throw Error('Market cursor too large');
  const normalized=swaps.map(s=>{validateSwap(s);if(s.blockTime===null)throw Error('Market block time unresolved');return {...s,txIndex:null,commitment:'finalized'};});
  if(fees){validateFeeProjection(fees);if(!market||fees.slot!==market.verifiedSlot)throw Error('Fee snapshot must share the market observation');}
  if(market&&(market.genesis!==genesis||market.pool!==pool||market.programId!==job.programId||market.campaign!==job.campaign||!isAddress(market.mint)||!Number.isInteger(market.coinDecimals)||market.coinDecimals<0||market.coinDecimals>9||!Number.isSafeInteger(market.launchTime)||market.launchTime<1||!/^\d{1,40}$/.test(market.openingPriceScaled)||!Number.isSafeInteger(market.verifiedSlot)||market.verifiedSlot<1))throw Error('Invalid verified market identity');
  return registry.transaction(async()=>{
   const at=Number((await query('SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) AS ms')).rows[0].ms);
   const lease=(await query("SELECT campaign FROM jobs WHERE job_id=? AND genesis_hash=? AND program_id=? AND campaign=? AND fencing_token=? AND state='leased' AND lease_expires_at>? FOR UPDATE",[job.jobId,genesis,job.programId,job.campaign,job.fencingToken,new Date(at).toISOString()])).rows[0];
   if(!lease)throw stale();
   const before=await cursor(s,stream);
   if(before.revision!==expectedRevision)throw Object.assign(Error('Market cursor changed'),{code:'MARKET_CURSOR_CONFLICT'});
   if(market){
    const stable={...market};delete stable.verifiedSlot;
    const fingerprint=canonicalHash(stable);
    const known=(await query('SELECT identity_hash FROM public_market_identities WHERE genesis=? AND program_id=? AND campaign=?',[genesis,job.programId,job.campaign])).rows[0];
    if(known&&known.identity_hash!==fingerprint)throw Error('Verified market identity changed');
    if(!known)await query('INSERT INTO public_market_identities(genesis,program_id,campaign,pool,identity_hash,body,first_observed_at) VALUES(?,?,?,?,?,?,?)',[genesis,job.programId,job.campaign,pool,fingerprint,canonicalJson(market),at]);
   }
   let inserted=0;
   if(fees){
    const prior=(await query('SELECT slot,fingerprint FROM public_fee_snapshots WHERE genesis=? AND program_id=? AND campaign=?',[genesis,job.programId,job.campaign])).rows[0],fingerprint=canonicalHash(fees);
    if(prior&&Number(prior.slot)===fees.slot&&prior.fingerprint!==fingerprint)throw Error('Finalized fee snapshot changed within a slot');
    await query('INSERT INTO public_fee_snapshots AS f(genesis,program_id,campaign,slot,fingerprint,body,observed_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(genesis,program_id,campaign) DO UPDATE SET slot=EXCLUDED.slot,fingerprint=EXCLUDED.fingerprint,body=EXCLUDED.body,observed_at=EXCLUDED.observed_at WHERE EXCLUDED.slot>=f.slot',[genesis,job.programId,job.campaign,fees.slot,fingerprint,canonicalJson(fees),at]);
   }
   for(const swap of normalized){
    const hash=canonicalHash(swap),key=order(swap);
    const result=await query('INSERT INTO public_market_swaps(genesis,pool,signature,path,order_key,block_time,record,fingerprint) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING signature',[genesis,pool,swap.signature,swap.instructionPath,key,swap.blockTime,canonicalJson(swap),hash]);
    if(!result.rowCount){const existing=(await query('SELECT fingerprint FROM public_market_swaps WHERE genesis=? AND pool=? AND signature=? AND path=?',[genesis,pool,swap.signature,swap.instructionPath])).rows[0];if(existing.fingerprint!==hash)throw Error('Finalized trade data mismatch');continue;}
    inserted++;
    for(const interval of Object.keys(INTERVALS))await query(`INSERT INTO public_market_candles AS c
     (genesis,pool,interval,bucket,open,high,low,close,volume_sol,volume_coin,trades,buys,sells,open_key,close_key,first_slot,last_slot)
     VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?) ON CONFLICT(genesis,pool,interval,bucket) DO UPDATE SET
     open=CASE WHEN EXCLUDED.open_key COLLATE "C"<c.open_key COLLATE "C" THEN EXCLUDED.open ELSE c.open END,
     close=CASE WHEN EXCLUDED.close_key COLLATE "C">c.close_key COLLATE "C" THEN EXCLUDED.close ELSE c.close END,
     high=GREATEST(c.high::numeric,EXCLUDED.high::numeric)::text,low=LEAST(c.low::numeric,EXCLUDED.low::numeric)::text,
     volume_sol=(c.volume_sol::numeric+EXCLUDED.volume_sol::numeric)::text,volume_coin=(c.volume_coin::numeric+EXCLUDED.volume_coin::numeric)::text,
     trades=c.trades+1,buys=c.buys+EXCLUDED.buys,sells=c.sells+EXCLUDED.sells,
     open_key=LEAST(c.open_key COLLATE "C",EXCLUDED.open_key COLLATE "C"),close_key=GREATEST(c.close_key COLLATE "C",EXCLUDED.close_key COLLATE "C"),
     first_slot=LEAST(c.first_slot,EXCLUDED.first_slot),last_slot=GREATEST(c.last_slot,EXCLUDED.last_slot)`,
     [genesis,pool,interval,bucketStart(swap.blockTime,interval),swap.priceScaled,swap.priceScaled,swap.priceScaled,swap.priceScaled,swap.solLamports,swap.coinRaw,swap.side==='buy'?1:0,swap.side==='sell'?1:0,key,key,swap.slot,swap.slot]);
   }
   await query(`INSERT INTO public_market_cursors(genesis,pool,stream,revision,body,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(genesis,pool,stream) DO UPDATE SET revision=EXCLUDED.revision,body=EXCLUDED.body,updated_at=EXCLUDED.updated_at`,[genesis,pool,stream,expectedRevision+1,canonicalJson(body),at]);
   for(const input of followups)await registry.jobs.enqueue({...input,genesisHash:genesis,programId:job.programId,campaign:job.campaign});
   // A large decoded page can outlive its lease while this transaction holds the
   // job row. Recheck database time after the writes; expiry rolls the page back.
   const active=(await query("SELECT 1 FROM jobs WHERE job_id=? AND fencing_token=? AND state='leased' AND lease_expires_at>to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",[job.jobId,job.fencingToken])).rows[0];
   if(!active)throw stale();
   return {inserted,revision:expectedRevision+1};
  },{lockKey:'market:'+genesis+':'+pool});
 }
 async function trades(s,{before=null,limit=30}={}){
  if(!Number.isInteger(limit)||limit<1||limit>100||before!==null&&(typeof before!=='string'||before.length>160||!/^[0-9A-Za-z:.]+$/.test(before)))throw Error('Invalid market pagination');
  const rows=(await query(`SELECT record,order_key FROM public_market_swaps WHERE genesis=? AND pool=? AND (?::text IS NULL OR order_key COLLATE "C"<?) ORDER BY order_key COLLATE "C" DESC LIMIT ?`,[...scope(s),before,before,limit+1])).rows;
  return {commitment:'finalized',trades:rows.slice(0,limit).map(r=>JSON.parse(r.record)),nextCursor:rows.length>limit?rows[limit-1].order_key:null};
 }
 async function candles(s,{interval='1m',from,to,limit=1000}){
  if(!Object.hasOwn(INTERVALS,interval)||!Number.isSafeInteger(from)||from<0||!Number.isSafeInteger(to)||to<=from||!Number.isInteger(limit)||limit<1||limit>1000)throw Error('Invalid candle range');
  return (await query('SELECT * FROM public_market_candles WHERE genesis=? AND pool=? AND interval=? AND bucket>=? AND bucket<? ORDER BY bucket ASC LIMIT ?',[...scope(s),interval,from,to,limit])).rows.map(r=>({time:Number(r.bucket),open:r.open,high:r.high,low:r.low,close:r.close,volumeSol:r.volume_sol,volumeCoin:r.volume_coin,trades:Number(r.trades),buys:Number(r.buys),sells:Number(r.sells)}));
 }
 async function marketFor(id){
  if(!isAddress(id?.genesisHash)||!isAddress(id?.programId)||!isAddress(id?.campaign))throw Error('Invalid market campaign identity');
  const row=(await query('SELECT body FROM public_market_identities WHERE genesis=? AND program_id=? AND campaign=?',[id.genesisHash,id.programId,id.campaign])).rows[0];
  return row?JSON.parse(row.body):null;
 }
 async function coverage(id){
  const m=await marketFor(id);if(!m)return null;
  const live=await cursor({genesis:m.genesis,pool:m.pool},'live');
  const initial=live.body?.openingVerified?null:await cursor({genesis:m.genesis,pool:m.pool},'market-backfill:initial');
  const jobs=(await query("SELECT job_class,state,COUNT(*) AS n FROM jobs WHERE genesis_hash=? AND program_id=? AND campaign=? AND job_class IN ('market-index','market-backfill') AND state<>'done' GROUP BY job_class,state",[id.genesisHash,id.programId,id.campaign])).rows;
  return {lastPollAt:live.updatedAt,lastIndexedTransactionSlot:live.body?.slot??null,openingVerified:live.body?.openingVerified===true||initial?.body?.openingVerified===true,providerHead:live.body?.providerHead??null,pendingBackfills:jobs.filter(r=>r.job_class==='market-backfill').reduce((n,r)=>n+Number(r.n),0),failedJobs:jobs.filter(r=>r.state==='failed').reduce((n,r)=>n+Number(r.n),0)};
 }
 async function feeSnapshot(id){
  if(!isAddress(id?.genesisHash)||!isAddress(id?.programId)||!isAddress(id?.campaign))throw Error('Invalid fee campaign identity');
  const row=(await query('SELECT body,observed_at FROM public_fee_snapshots WHERE genesis=? AND program_id=? AND campaign=?',[id.genesisHash,id.programId,id.campaign])).rows[0];
  return row?{...JSON.parse(row.body),updatedAt:Number(row.observed_at)}:null;
 }
 return {cursor,commitPage,trades,candles,marketFor,coverage,feeSnapshot};
}
