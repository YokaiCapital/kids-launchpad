import {lazy,Suspense,useEffect,useMemo,useRef,useState} from 'react';
import {accountApi} from '../Account';
import {INTERVALS,normaliseTrade,formatPrice,pricePrecision,relativeTime,utcStamp,startPolling} from '../market-data.mjs';
import {marketWindow,marketSeries,marketState,readCampaignMarket,marketExplorer} from './campaign-market.mjs';
import {ExactAmount,CopyButton} from './ExactAmount';
import {solAmount,tokenAmount,shortAddress} from './campaign-adapter.mjs';
import {CampaignFeeSummary} from './CampaignFeeSummary';
const Chart=lazy(()=>import('../MarketChart').then(m=>({default:m.MarketChart})));
const empty=()=>({data:null,error:false,loading:true});
const PAGE=8;
function Skeleton(){return <div className="pl-market-skeleton" aria-busy="true" aria-label="Loading market"><span className="pl-skel"/><span className="pl-skel"/><span className="pl-skel"/></div>;}
function Price({value}){const p=formatPrice(value);return <ExactAmount amount={{compact:p.text,exact:p.exact||'—',unit:'SOL'}}/>;}
/** Isolated shared-reader market surface. No legacy singleton routes, cache,
 * hard-coded ticker or browser RPC. Owner/coin changes discard pending reads. */
export function CampaignMarket({vm,owner,enabled=false,onConnect,api=accountApi}){
 return <MarketContents key={vm.id+':'+(owner||'')+':'+enabled} vm={vm} owner={owner} enabled={enabled} onConnect={onConnect} api={api}/>;
}
function MarketContents({vm,owner,enabled,onConnect,api}){
 const [interval,setIntervalValue]=useState('5m'),[view,setView]=useState('chart'),[retry,setRetry]=useState(0),[candles,setCandles]=useState(empty),[trades,setTrades]=useState(empty),[now,setNow]=useState(Date.now),[page,setPage]=useState(0),[cursors,setCursors]=useState([null]),[latest,setLatest]=useState(null),[fees,setFees]=useState(empty);
 const showFees=vm.mode==='standard'&&vm.terms.version==='3';
 const epoch=useRef(0),identity=vm.id+':'+(owner||'');
 useEffect(()=>{setPage(0);setCursors([null]);},[identity]);
 useEffect(()=>{
  const generation=++epoch.current;let stopped=false,running=false;const controller=new AbortController();
  setCandles(s=>s.data?.interval===interval?{...s,loading:true}:empty());setTrades(empty());setFees(empty());
  if(!enabled||!owner)return;
  const tick=async()=>{
   if(running||stopped)return;running=true;
   const params=marketWindow(interval),cursor=cursors[page]??null;let session;
   try{session=await api('state',undefined,undefined,{retries:0,signal:controller.signal});}catch{running=false;if(!stopped&&epoch.current===generation){setCandles(s=>({...s,error:true,loading:false}));setTrades(s=>({...s,error:true,loading:false}));setFees(s=>({...s,error:true,loading:false}));}return;}
   if(stopped||controller.signal.aborted){running=false;return;}
   // One poll owns these parallel reads. Slow reads never pile up per viewer.
   const results=await Promise.allSettled([
    readCampaignMarket({api,owner,vm,kind:'candles',params,signal:controller.signal,session}),
    readCampaignMarket({api,owner,vm,kind:'trades',params:{limit:PAGE,cursor},signal:controller.signal,session}),
    ...(showFees?[readCampaignMarket({api,owner,vm,kind:'fees',signal:controller.signal,session})]:[])
   ]);
   running=false;if(stopped||epoch.current!==generation)return;
   if(page===0&&results[1].status==='fulfilled')setLatest(results[1].value.trades?.[0]?normaliseTrade(results[1].value.trades[0]):null);
   for(const [index,set] of [setCandles,setTrades,...(showFees?[setFees]:[])].entries())set(previous=>results[index].status==='fulfilled'?{data:results[index].value,error:false,loading:false}:{...previous,error:true,loading:false});
  };
  const stop=startPolling(tick,10000),clock=setInterval(()=>setNow(Date.now()),1000);
  return()=>{stopped=true;controller.abort();stop();clearInterval(clock);};
 },[identity,enabled,interval,retry,page,cursors,api,showFees]);
 const chart=useMemo(()=>candles.data?.interval===interval?marketSeries(candles.data,now):{points:[],carried:0},[candles.data,interval,Math.floor(now/10000)]);
 const cs=marketState(candles.data,{error:candles.error,now}),ts=marketState(trades.data,{error:trades.error,now});
 const rows=(trades.data?.trades||[]).map(normaliseTrade),last=latest,ref=candles.data?.openingReference;
 if(!enabled)return <section className="pl-panel"><h3 className="pl-label">Market</h3><p className="pl-small pl-muted">Market indexing is not enabled for this launch yet.</p></section>;
 if(!owner)return <section className="pl-panel"><h3 className="pl-label">Market</h3><p className="pl-small pl-muted">Connect your pilot wallet to view this pool’s market.</p><button type="button" onClick={onConnect}>Connect wallet</button></section>;
 const retryNeeded=candles.error||trades.error||['stale','indexing-error'].includes(cs.status);
 const updated=candles.data?.freshness?.updatedAt;
 function next(){const cursor=trades.data?.nextCursor;if(!cursor||trades.loading)return;setCursors(list=>[...list.slice(0,page+1),cursor]);setPage(p=>p+1);}
 return <section className="pl-panel pl-market" aria-label={vm.name+' market'}>
  <div className="pl-panel-head"><div><h3 className="pl-label">{vm.symbol?'$'+vm.symbol:vm.name} / SOL</h3><strong className="pl-market-price">{last?<Price value={last.priceSol}/>:cs.quiet&&ref?<Price value={ref.priceSolExact}/>:'—'}</strong><span className="pl-small pl-muted">{cs.quiet?'Opening reference':last?'Last indexed trade':''}</span></div><div className="pl-market-health"><span className={'pl-pill '+(['live','no-trades'].includes(cs.status)?'is-muted':'is-pending')}>{cs.label}</span>{updated!=null&&<small>{relativeTime(Math.floor(updated/1000),Math.floor(now/1000))}</small>}{retryNeeded&&<button type="button" className="pl-btn-sm" onClick={()=>setRetry(r=>r+1)}>Retry</button>}</div></div>
  <div className="pl-market-view" role="group" aria-label="Market view"><button type="button" aria-pressed={view==='chart'} onClick={()=>setView('chart')}>Chart</button><button type="button" aria-pressed={view==='trades'} onClick={()=>setView('trades')}>Trades</button></div>
  <div hidden={view!=='chart'}>
  <div className="pl-market-intervals" role="group" aria-label="Candle interval">{INTERVALS.map(i=><button type="button" key={i.key} aria-pressed={interval===i.key} aria-label={i.label} onClick={()=>setIntervalValue(i.key)}>{i.key}</button>)}</div>
  <div className="pl-market-chart">
   {candles.loading&&!candles.data?<Skeleton/>:chart.points.length?<Suspense fallback={<Skeleton/>}><Chart points={chart.points} seriesKey={vm.id+':'+interval} precision={pricePrecision(candles.data.candles)} intraday={interval!=='1d'} label={vm.name+' finalized candles in SOL. '+(chart.carried?'Thin carried bars have no new trades.':'')}/></Suspense>:cs.quiet&&ref?<div className="pl-market-opening"><div aria-hidden="true" className="pl-market-reference-line"/><div><span className="pl-label">Opening reference</span><strong><Price value={ref.priceSolExact}/></strong><p>No trades yet. Candles appear after the first finalized trade.</p></div></div>:<div className="pl-market-empty"><strong>{cs.label}</strong><p>{candles.error?'The last request did not complete. Your funds and the pool are not changed.':'Verified trade history will appear here when indexing catches up.'}</p></div>}
  </div>
  <p className="pl-help-text">{chart.carried?'Thin bars carry the last trade price through quiet intervals. ':''}{!candles.data?.coverage?.complete&&chart.points.length?'History is incomplete. Gaps are not filled. ':''}Finalized data. {cs.status==='stale'||candles.error?'Do not use stale data as a current quote.':'Prices are in SOL.'}</p>
  </div>
  <div hidden={view!=='trades'}>
  <div className="pl-panel-head pl-market-trades-head"><h3 className="pl-label">Recent trades</h3><span className="pl-small pl-muted">{page>0?'Page '+(page+1):ts.label}</span></div>
  {trades.loading&&!trades.data?<span className="pl-skel" style={{height:44}}/>:rows.length?<ol className="pl-market-trades">{rows.map(t=><li key={t.key}>
   <div><span className={'pl-market-side is-'+t.side}>{t.side==='buy'?'Buy':'Sell'}</span><time dateTime={new Date(t.blockTimeUnix*1000).toISOString()} title={utcStamp(t.blockTimeUnix)}>{relativeTime(t.blockTimeUnix,Math.floor(now/1000))}</time>{t.wallet&&<small><ExactAmount amount={{compact:shortAddress(t.wallet,4,3),exact:t.wallet,unit:''}} label="Trader"/></small>}</div>
   <div><ExactAmount amount={solAmount(t.solRaw)}/><small><ExactAmount amount={tokenAmount(t.coinRaw,vm.terms.supply.decimals,vm.symbol?'$'+vm.symbol:'coins')}/></small></div>
   <div className="pl-market-signature">{marketExplorer(vm.identity.genesisHash,t.signature)?<a href={marketExplorer(vm.identity.genesisHash,t.signature)} target="_blank" rel="noopener noreferrer" aria-label="View finalized trade on explorer">↗</a>:<span className="pl-mono">{shortAddress(t.signature)}</span>}<CopyButton value={t.signature} label="trade signature"/></div>
  </li>)}</ol>:<p className="pl-small pl-muted">{ts.quiet?'No finalized trades yet.':trades.error?'Trades are temporarily unavailable.':'Trade history is being indexed.'}</p>}
  {(page>0||trades.data?.nextCursor)&&<div className="pl-market-pages"><button type="button" className="pl-btn-sm" disabled={page===0||trades.loading} onClick={()=>setPage(p=>p-1)}>Newer</button><span className="pl-small pl-muted">{PAGE} trades per page</span><button type="button" className="pl-btn-sm" disabled={!trades.data?.nextCursor||trades.loading||page>=49} onClick={next}>Older</button></div>}
  </div>
  {showFees&&<CampaignFeeSummary vm={vm} state={fees} now={now} onRetry={()=>setRetry(r=>r+1)}/>}
 </section>;
}
