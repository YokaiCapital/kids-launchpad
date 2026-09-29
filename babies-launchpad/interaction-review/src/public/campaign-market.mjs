// Public v3 market view: exact ledger identity, bounded windows, no fabricated
// trade history. The authenticated gateway reads the shared projection only.
import {validateFeeProjection} from '../../../shared/fee-projection.mjs';
import {intervalFor,normaliseCandle,normaliseTrade,seriesData} from '../market-data.mjs';
const STATES=new Set(['not-indexed','starting','stale','backfilling','indexing-error','live','no-trades']);
const unsigned=s=>typeof s==='string'&&/^[0-9]{1,40}$/.test(s);
const decimal=s=>typeof s==='string'&&/^[0-9]{1,40}(?:\.[0-9]{1,30})?$/.test(s);
const sig=s=>typeof s==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
export function marketExplorer(genesis,signature){
 if(!sig(signature))return null;
 const cluster=genesis==='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'?'':genesis==='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'?'?cluster=devnet':null;
 return cluster===null?null:'https://solscan.io/tx/'+signature+cluster;
}
export function marketWindow(interval,at=Math.floor(Date.now()/1000)){
 const def=intervalFor(interval),to=Math.floor(at/def.seconds)*def.seconds+def.seconds;
 return {interval:def.key,from:Math.max(0,to-def.window),to};
}
export function validateMarket(data,vm,kind){
 const reject=()=>{throw Error('Market data could not be verified for this coin');};
 if(!data||data.genesisHash!==vm.identity.genesisHash||data.programId!==vm.identity.programId||data.campaign!==vm.identity.campaign||data.commitment!=='finalized'||!STATES.has(data.status))reject();
 if(data.available===false){if(data.status!=='not-indexed')reject();return data;}
 if(data.available!==true||data.pool!==vm.chain.pool||data.mint!==vm.chain.mint||data.coinDecimals!==vm.terms.supply.decimals||data.quote!=='SOL'||!integer(data.at)||!data.freshness||typeof data.freshness.stale!=='boolean'||!data.coverage||typeof data.coverage.complete!=='boolean')reject();
 const ref=data.openingReference;
 if(!ref||!integer(ref.time)||ref.source!=='pool-opening'||ref.isTrade!==false||!decimal(ref.priceSolExact)||!Number.isFinite(ref.priceSol)||ref.priceSol<=0)reject();
 if(kind==='fees'){
  if(data.fees!==null){try{validateFeeProjection(data.fees);}catch{reject();}if(!integer(data.fees.updatedAt)||data.fees.updatedAt!==data.freshness.updatedAt)reject();if(data.fees.status==='verified'&&vm.terms.fee?.totalBps!=null&&Number(data.fees.poolTradeFeeRate)!==vm.terms.fee.totalBps*100)reject();}
 }else if(kind==='candles'){
  if(!Array.isArray(data.candles)||data.candles.length>1000||!integer(data.from)||!integer(data.to)||data.to<=data.from||intervalFor(data.interval).key!==data.interval)reject();
  const seconds=intervalFor(data.interval).seconds,seen=new Set();
  for(const raw of data.candles){const c=normaliseCandle(raw);if(!c||c.time< data.from||c.time>=data.to||c.time%seconds||seen.has(c.time)||c.open<=0||c.low<=0||!integer(raw.trades)||raw.trades<1)reject();seen.add(c.time);}
 }else if(kind==='trades'){
  if(!Array.isArray(data.trades)||data.trades.length>100||data.nextCursor!=null&&(typeof data.nextCursor!=='string'||data.nextCursor.length>160||!/^[0-9A-Za-z:.]+$/.test(data.nextCursor)))reject();
  for(const raw of data.trades){const t=normaliseTrade(raw);if(!t||raw.commitment!=='finalized'||!sig(t.signature)||!unsigned(t.solRaw)||!unsigned(t.coinRaw)||!decimal(t.priceSol)||t.provisional||!integer(t.blockTimeUnix)||!integer(t.slot)||!/^\d+(?:\.\d+)*$/.test(t.path))reject();}
 }else reject();
 return data;
}
export function marketState(data,{error=false,now=Date.now()}={}){
 if(error)return {status:'unavailable',label:'Updates unavailable',quiet:false};
 if(!data)return {status:'loading',label:'Loading market',quiet:false};
 if(!data.available)return {status:'starting',label:'Indexing pool',quiet:false};
 const stale=data.freshness.stale||!integer(data.freshness.updatedAt)||now-data.freshness.updatedAt>30000||data.freshness.updatedAt>now+5000;
 const status=stale?'stale':data.status;
 const labels={stale:'Data is stale',backfilling:'Syncing history','indexing-error':'History needs recovery',starting:'Indexing pool',live:'Finalized trades','no-trades':'No trades yet'};
 return {status,label:labels[status]||'Market unavailable',quiet:status==='no-trades'&&data.coverage.complete===true};
}
export function marketSeries(data,now=Date.now()){
 if(!data?.available||!Array.isArray(data.candles))return {points:[],carried:0};
 const bars=data.candles.map(normaliseCandle).filter(Boolean).sort((a,b)=>a.time-b.time),def=intervalFor(data.interval);
 // An unfinished backfill or stale feed cannot establish that an empty bucket
 // had no trade. In that case draw real bars only, never carried prices.
 if(!data.coverage.complete||['stale','indexing-error','starting','backfilling'].includes(marketState(data,{now}).status))return seriesData(bars,{intervalSeconds:def.seconds,fromUnix:bars[0]?.time??data.from,toUnix:Math.min(data.to-def.seconds,Math.floor(now/1000)),gaps:[{fromUnix:data.from,toUnix:data.to}]});
 const lastKnown=Math.floor(Math.min(now,data.freshness.updatedAt)/1000);
 return seriesData(bars,{intervalSeconds:def.seconds,fromUnix:bars[0]?.time??data.from,toUnix:Math.min(data.to-def.seconds,Math.floor(lastKnown/def.seconds)*def.seconds)});
}
export async function readCampaignMarket({api,owner,vm,kind,params={},signal=null,session=null}){
 if(!owner)throw Error('Connect your pilot wallet to view the market');
 session=session||await api('state',undefined,undefined,{signal});if(session.owner!==owner||!session.csrf)throw Error('Signed-in wallet changed');
 const data=await api('launches/market/read',{...params,campaign:vm.identity.campaign,kind},session.csrf,{retries:0,signal});
 const valid=validateMarket(data,vm,kind);
 if(kind==='candles'&&valid.available&&(valid.interval!==params.interval||valid.from!==params.from||valid.to!==params.to))throw Error('Market window changed');
 return valid;
}
