// Market tab for the coin page: candlestick chart (TradingView Lightweight Charts 5.2.1) and the transactions list.
// Mounted only while the Market tab is open; the chart is created on mount and removed on unmount. Data comes from
// /api/market/* through market-data.mjs and is polled every 10 s while the document is visible. Zoom and pan survive
// each poll because bars are appended or updated in place; the series is only reset when the interval changes.
import {useEffect,useMemo,useRef,useState} from 'react';
import {createChart,CandlestickSeries,ColorType,CrosshairMode,LineStyle} from 'lightweight-charts';
import {ChartLine} from '@phosphor-icons/react';
import {explorerTx} from './network-label.mjs';
import {compactUnits,formatSolAmount} from './flywheel-format.mjs';
import {INTERVALS,POLL_MS,STATE_COPY,cacheKey,candleRange,diffForUpdate,fetchMarket,formatPrice,intervalFor,isoStamp,mergeCandles,mergeGaps,mergeTrades,normaliseCandle,pricePrecision,readCache,relativeTime,seriesData,startPolling,stateTone,utcStamp,writeCache} from './market-data.mjs';
const nowUnix=()=>Math.floor(Date.now()/1000);
const shortSig=v=>v?v.slice(0,6)+'…'+v.slice(-6):'';
const reducedMotion=()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
const cssVar=(el,name,fallback)=>{try{return getComputedStyle(el).getPropertyValue(name).trim()||fallback;}catch{return fallback;}};

/** The chart itself. `points` already contain whitespace for empty buckets; `seriesKey` changes force a fresh series. */
export function MarketChart({points,seriesKey,precision,intraday,label}){
 const host=useRef(null),chart=useRef(null),series=useRef(null),applied=useRef({key:null,points:[]});
 useEffect(()=>{
  const el=host.current;if(!el)return;
  const ink=cssVar(el,'--post-ink','#fff0fb'),muted=cssVar(el,'--post-muted','#b9a7c6'),line=cssVar(el,'--post-line','#41304f'),card=cssVar(el,'--post-card','#1b1328'),up=cssVar(el,'--market-up','#f86bcf'),down=cssVar(el,'--market-down','#8cecff'),grid=cssVar(el,'--market-grid','rgba(255,255,255,.045)');
  const still=reducedMotion();
  const c=createChart(el,{autoSize:true,layout:{background:{type:ColorType.Solid,color:card},textColor:muted,fontFamily:'Space, Arial, sans-serif',fontSize:11,attributionLogo:true},
   grid:{vertLines:{color:grid,style:LineStyle.Solid},horzLines:{color:grid,style:LineStyle.Solid}},
   crosshair:{mode:CrosshairMode.Normal,vertLine:{color:muted,width:1,style:LineStyle.Dashed,labelBackgroundColor:'#2a1b3a'},horzLine:{color:muted,width:1,style:LineStyle.Dashed,labelBackgroundColor:'#2a1b3a'}},
   rightPriceScale:{borderColor:line,scaleMargins:{top:.12,bottom:.12}},timeScale:{borderColor:line,timeVisible:true,secondsVisible:false,rightOffset:3,minBarSpacing:2,shiftVisibleRangeOnNewBar:true,lockVisibleTimeRangeOnResize:true},
   handleScroll:{mouseWheel:true,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:false},handleScale:{mouseWheel:true,pinch:true,axisPressedMouseMove:true,axisDoubleClickReset:true},kineticScroll:{touch:!still,mouse:false},localization:{locale:'en-GB'}});
  const s=c.addSeries(CandlestickSeries,{upColor:up,downColor:down,borderUpColor:up,borderDownColor:down,wickUpColor:up,wickDownColor:down,priceLineColor:ink,priceLineStyle:LineStyle.Dotted,lastValueVisible:true,priceLineVisible:true});
  chart.current=c;series.current=s;applied.current={key:null,points:[]};
  return()=>{c.remove();chart.current=null;series.current=null;applied.current={key:null,points:[]};};
 },[]);
 useEffect(()=>{const s=series.current;if(!s)return;s.applyOptions({priceFormat:{type:'price',precision,minMove:Number((10**-precision).toFixed(precision))}});},[precision]);
 useEffect(()=>{const c=chart.current;if(!c)return;c.applyOptions({timeScale:{timeVisible:intraday,secondsVisible:false}});},[intraday]);
 useEffect(()=>{
  const s=series.current,c=chart.current;if(!s||!c)return;
  const prev=applied.current;const diff=prev.key===seriesKey?diffForUpdate(prev.points,points):{reset:true,updates:[]};
  if(diff.reset){s.setData(points);const width=host.current?.clientWidth||600;const visible=Math.min(points.length,Math.max(40,Math.min(160,Math.floor(width/8))));if(points.length)c.timeScale().setVisibleLogicalRange({from:points.length-visible,to:points.length+2});}
  else for(const {point,historical} of diff.updates)s.update(point,historical);
  applied.current={key:seriesKey,points};
 },[points,seriesKey]);
 return <div ref={host} className="market-chart-canvas" role="img" aria-label={label} tabIndex={0}/>;
}

function useCandles(campaign,interval,enabled,retry){
 const [state,setState]=useState(()=>{const cached=campaign?readCache(cacheKey(campaign,'candles',interval)):null;return cached?{candles:cached.candles,gaps:cached.gaps,from:cached.from,to:cached.to,result:null,readAt:cached.readAt,loading:true}:{candles:[],gaps:[],from:null,to:null,result:null,readAt:null,loading:true};});
 useEffect(()=>{
  if(!campaign||!enabled){setState(s=>({...s,loading:false}));return;}
  const key=cacheKey(campaign,'candles',interval);const cached=readCache(key);
  let held=cached?{candles:cached.candles,gaps:cached.gaps,from:cached.from,to:cached.to,readAt:cached.readAt}:{candles:[],gaps:[],from:null,to:null,readAt:null};
  setState({...held,result:null,loading:true});
  let controller=null,alive=true;
  const stop=startPolling(async()=>{
   controller?.abort();controller=new AbortController();const signal=controller.signal;
   const {from,to}=candleRange(interval,held.candles,nowUnix());
   const result=await fetchMarket('candles',{campaign,interval,from,to},{signal});
   if(!alive||signal.aborted)return;
   if(result.ok){
    const candles=mergeCandles(held.candles,result.data.candles.map(normaliseCandle).filter(Boolean)),gaps=mergeGaps(held.gaps,result.data.gaps);
    held={candles,gaps,from:held.from==null?from:Math.min(held.from,from),to,readAt:nowUnix()};writeCache(key,held);
   }
   setState({...held,result,loading:false});
  },POLL_MS);
  return()=>{alive=false;stop();controller?.abort();};
 },[campaign,interval,enabled,retry]);
 return state;
}
function useTrades(campaign,enabled,retry){
 const [state,setState]=useState(()=>{const cached=campaign?readCache(cacheKey(campaign,'trades')):null;return {trades:cached?.trades||[],nextCursor:cached?.nextCursor??null,pages:1,result:null,loading:true,more:false,moreResult:null};});
 const held=useRef(state);held.current=state;
 useEffect(()=>{
  if(!campaign||!enabled){setState(s=>({...s,loading:false}));return;}
  const key=cacheKey(campaign,'trades');const cached=readCache(key);
  setState(s=>({...s,trades:cached?.trades||[],nextCursor:cached?.nextCursor??null,result:null,loading:true}));
  let controller=null,alive=true;
  const stop=startPolling(async()=>{
   controller?.abort();controller=new AbortController();const signal=controller.signal;
   const result=await fetchMarket('trades',{campaign,limit:30},{signal});
   if(!alive||signal.aborted)return;
   setState(s=>{if(!result.ok)return {...s,result,loading:false};
    const trades=mergeTrades(s.trades,result.data.trades);const nextCursor=s.pages>1?s.nextCursor:(result.data.nextCursor??null);// a deeper page's cursor wins over page one's
    writeCache(key,{trades,nextCursor});return {...s,trades,nextCursor,result,loading:false};});
  },POLL_MS);
  return()=>{alive=false;stop();controller?.abort();};
 },[campaign,enabled,retry]);
 async function loadMore(){
  const cursor=held.current.nextCursor;if(!cursor||held.current.more)return;setState(s=>({...s,more:true,moreResult:null}));
  const result=await fetchMarket('trades',{campaign,cursor,limit:30});
  setState(s=>{if(!result.ok)return {...s,more:false,moreResult:result};const trades=mergeTrades(s.trades,result.data.trades);const nextCursor=result.data.nextCursor??null;writeCache(cacheKey(campaign,'trades'),{trades,nextCursor});return {...s,trades,nextCursor,pages:s.pages+1,more:false,moreResult:result};});
 }
 return {...state,loadMore};
}

function EmptyChart({state,copy,onRetry,busy}){
 return <div className="post-chart-empty" aria-busy={busy||undefined}><div className="post-chart-grid" aria-hidden="true"/><div className="post-chart-message" role="status"><ChartLine size={30} weight="light" aria-hidden="true"/><h2>{copy.title}</h2><p>{copy.body}</p>{state==='unavailable'&&onRetry&&<button type="button" className="outlined" onClick={onRetry}>Try again now</button>}</div></div>;
}

function TradeRow({trade,data,decimals,now}){
 const sol=formatSolAmount(trade.solRaw),coin=compactUnits(trade.coinRaw,decimals,'$Shartcoin'),price=formatPrice(trade.priceSol),link=explorerTx(data,trade.signature);
 const when=trade.blockTimeUnix;
 return <li className={`market-trade is-${trade.side}${trade.provisional?' is-provisional':''}`}>
  <div className="market-trade-main">
   <time dateTime={isoStamp(when)||undefined} title={utcStamp(when)||undefined}>{when!=null?relativeTime(when,now):'Pending'}</time>
   <span className="market-side">{trade.side==='buy'?'Buy':'Sell'}</span>
   <span className="market-sol" title={sol.exact||undefined}>{sol.text}</span>
  </div>
  <div className="market-trade-sub">
   <span className="market-coin" title={coin.exact||undefined}>{coin.text} <small>$Shartcoin</small></span>
   <span className="market-price" title={price.exact?price.exact+' SOL per coin':undefined}>{price.text} <small>SOL each</small></span>
   <span className="market-tags">{trade.nested&&<em title="Filled through a router, not directly on the pool">via router</em>}{trade.provisional&&<em className="is-confirming" title="Seen but not yet finalised on the chain">confirming</em>}</span>
   <span className="market-sig">{link?<a href={link} target="_blank" rel="noopener noreferrer" title={trade.signature}>{shortSig(trade.signature)}</a>:<code title={trade.signature}>{shortSig(trade.signature)}</code>}</span>
  </div>
 </li>;
}

/**
 * The whole Market tab. `market` comes from the page: {summary,state,hint,readAt}. The page owns the summary poll
 * because the metrics row shows it whether or not this tab is open.
 */
export function MarketTab({campaign,decimals=6,data,market,enabled}){
 const [interval,setInterval_]=useState('5m'),[retry,setRetry]=useState(0),[now,setNow]=useState(nowUnix);
 const candles=useCandles(campaign,interval,enabled,retry),trades=useTrades(campaign,enabled,retry);
 useEffect(()=>{const stop=startPolling(()=>setNow(nowUnix()),POLL_MS);return stop;},[]);
 const def=intervalFor(interval);
 const chart=useMemo(()=>seriesData(candles.candles,{intervalSeconds:def.seconds,fromUnix:candles.from,toUnix:candles.to}),[candles.candles,candles.from,candles.to,def.seconds]);
 const precision=useMemo(()=>pricePrecision(candles.candles),[candles.candles]);
 const summaryState=market?.state||'loading';
 // What the chart area shows: the page-level feed state decides between "off" and "unavailable"; the candle read decides the rest.
 const candleState=!enabled||summaryState==='off'?'off':candles.loading&&!candles.candles.length?'loading':candles.result&&!candles.result.ok?(candles.result.reason==='off'?'off':'unavailable'):!candles.candles.length?(summaryState==='backfilling'?'backfilling':'no-trades'):'ready';
 const hasBars=candles.candles.length>0;
 const last=hasBars?candles.candles[candles.candles.length-1]:null;
 const label=hasBars?`Candlestick chart, ${def.label} candles, $Shartcoin in SOL. Last close ${formatPrice(last.close).text} SOL at ${utcStamp(last.time)}.`:'Candlestick chart, no candles yet.';
 const chip=market?.hint||{text:STATE_COPY[summaryState]?.chip||'', tone:stateTone(summaryState)};
 const gapCount=candles.gaps.filter(g=>candles.from==null||g.toUnix>=candles.from).length;
 const tradeState=!enabled||summaryState==='off'?'off':trades.loading&&!trades.trades.length?'loading':trades.result&&!trades.result.ok&&!trades.trades.length?(trades.result.reason==='off'?'off':'unavailable'):!trades.trades.length?'empty':'ready';
 return <div className="market-tab">
  <div className="market-toolbar">
   <span className="market-pair"><i aria-hidden="true"/>$Shartcoin / SOL <span>Raydium CPMM</span></span>
   <span className={`market-fresh is-${chip.tone}`} role="status"><i aria-hidden="true"/>{chip.text}</span>
   <div className="market-intervals" role="group" aria-label="Candle interval">{INTERVALS.map(i=><button key={i.key} type="button" aria-pressed={interval===i.key} aria-label={i.label+' candles'} onClick={()=>setInterval_(i.key)}>{i.key}</button>)}</div>
  </div>
  <div className="market-chart">
   {hasBars&&<MarketChart points={chart.points} seriesKey={campaign+'|'+interval} precision={precision} intraday={def.seconds<86400} label={label}/>}
   {hasBars&&candleState==='unavailable'&&<div className="market-banner" role="status">Feed unavailable since {candles.readAt?utcStamp(candles.readAt):'the last read'}. Showing the last data received.<button type="button" className="text-button" onClick={()=>setRetry(n=>n+1)}>Try again now</button></div>}
   {hasBars&&candleState==='ready'&&summaryState==='stale'&&<div className="market-banner is-stale" role="status">The feed is behind the chain. Candles may be missing recent trades.</div>}
   {!hasBars&&candleState!=='ready'&&<EmptyChart state={candleState} copy={STATE_COPY[candleState]||STATE_COPY.loading} busy={candleState==='loading'} onRetry={()=>setRetry(n=>n+1)}/>}
  </div>
  <div className="market-foot">
   <span>Times in UTC</span>
   {hasBars&&!chart.filled&&<span className="market-gaps">Too many empty buckets to space out; bars are shown side by side.</span>}
   {gapCount>0&&<span className="market-gaps" title={candles.gaps.map(g=>utcStamp(g.fromUnix)+' to '+utcStamp(g.toUnix)).join('; ')}>{gapCount===1?'1 gap in the feed, shown as empty space':gapCount+' gaps in the feed, shown as empty space'}</span>}
   <a className="market-credit" href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">Charts by TradingView</a>
  </div>
  <section className="market-trades" aria-label="Transactions">
   <div className="market-trades-head"><h2>Transactions</h2><span>{tradeState==='ready'?'Newest first · showing '+trades.trades.length:tradeState==='loading'?'Loading…':''}</span></div>
   {tradeState==='ready'&&<ul>{trades.trades.map(t=><TradeRow key={t.signature} trade={t} data={data} decimals={decimals} now={now}/>)}</ul>}
   {tradeState==='loading'&&<p className="market-trades-empty" aria-busy="true">Reading the last trades…</p>}
   {tradeState==='off'&&<p className="market-trades-empty">Transactions appear here when the market feed is connected.</p>}
   {tradeState==='unavailable'&&<p className="market-trades-empty" role="status">The trade feed is unavailable right now. It retries every 10 seconds.<button type="button" className="text-button" onClick={()=>setRetry(n=>n+1)}>Try again now</button></p>}
   {tradeState==='empty'&&<p className="market-trades-empty">No trades yet. The first one appears here as soon as it lands.</p>}
   {tradeState==='ready'&&<div className="market-trades-foot">
    {trades.nextCursor?<button type="button" className="outlined market-more" disabled={trades.more} aria-busy={trades.more||undefined} onClick={trades.loadMore}>{trades.more?'Loading…':'Load more'}</button>:<span>No older trades in the feed.</span>}
    {trades.result&&!trades.result.ok&&<span role="status">Feed unavailable · list may be missing new trades.</span>}
    {trades.moreResult&&!trades.moreResult.ok&&<span role="status">Older trades could not be read. Try again.</span>}
   </div>}
  </section>
 </div>;
}
