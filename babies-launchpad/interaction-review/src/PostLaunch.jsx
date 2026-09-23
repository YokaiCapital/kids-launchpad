import {netLabel,explorerAccount} from './network-label.mjs';
import {walletForOwner} from './wallet-connection.mjs';
import {friendlyError} from './friendly-errors.mjs';
import {Suspense,lazy,useEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowRight,ChartLine,CheckCircle,Copy,Fire,Globe,LockKey,Play,XLogo} from '@phosphor-icons/react';
import {POLL_MS,deriveMarketState,fetchMarket,formatChange,formatPrice,formatSol,formatSolVolume,freshnessHint,poolLiquidity,relativeTime,startPolling} from './market-data.mjs';
import './market.css';
// The chart library loads only with the Market tab; the tab is unmounted (and the chart removed) when another tab opens.
const MarketTab=lazy(()=>import('./MarketChart').then(m=>({default:m.MarketTab})));
import {accountApi} from './Account';
import {ParentIcon} from './Parents';
import {CoinUpdates} from './CoinUpdates';
import {resolveShartVideo} from './coin-media';
import {resolveCoinDescription} from './coin-display';
import './post-launch.css';
import {LocalTradePanel} from './LocalTradePanel';
import {ClaimPanel} from './ClaimPanel';
import {compactUnits} from './flywheel-format.mjs';
import {ActivityFeed} from './ActivityFeed';
import {formatUtc} from './launch-status.mjs';
import {claimableItems,claimedAll,custodyFacts,networkFact,parentState,remainingRaw} from './claim-view.mjs';
import {Help} from './Help';
import {parentStatsList} from './valuation.mjs';
const formatWhole=(value,decimals=6)=>value==null?'—':Math.round(Number(value)/10**decimals).toLocaleString('en-GB');
const format=(value,decimals=6)=>value==null?'—':(Number(value)/10**decimals).toLocaleString('en-GB',{maximumFractionDigits:decimals===9?4:2});
function moveTab(event){const tabs=[...event.currentTarget.querySelectorAll('[role="tab"]')],index=tabs.indexOf(event.target);if(index<0)return;let next;if(event.key==='ArrowRight')next=(index+1)%tabs.length;else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;else return;event.preventDefault();tabs[next].focus();tabs[next].click();}
const short=value=>value?`${value.slice(0,5)}…${value.slice(-5)}`:'Not connected';
const PARENT_NAMES=['Fartcoin','Buttcoin'];
const Burn=()=><Fire size={14} weight="fill" aria-hidden="true"/>;
const Figure=({raw,decimals,unit})=>{const v=compactUnits(raw,decimals,unit);return <strong title={v.exact||undefined}>{v.text} <small>{unit}</small></strong>;};
/** The fee sentence reads the pool fee the API served; the LP share the program harvests is not a fixed number here, and the rest of the pool fee is Raydium's protocol and fund share. */
function feeSentence(bps){const fee=Number(bps)>0?(bps/100).toLocaleString('en-GB')+' %':null;return (fee?'Every trade pays the pool fee of '+fee+'.':'Every trade pays the pool fee.')+' The program harvests the LP share of that fee. The rest of the pool fee is Raydium’s protocol and fund share. The SOL side is split: KIDS treasury, the dev, and buybacks of both parents that are burned. The coin side is burned outright, never sold.';}
function Flywheel({data,verified}){
 const f=verified?data.fees:null;
 // Token counters are raw base units: the child mint's decimals from the record (6), parents at 6. SOL is lamports.
 const childDecimals=Number.isInteger(data?.decimals)?data.decimals:6,parentDecimals=6;
 const childBurned=compactUnits(f?.childBurned,childDecimals,'coins');
 const parentStats=parentStatsList(data);
 const names={coin:verified?data.mint:null,parentMints:PARENT_NAMES.map((_,i)=>parentStats.find(p=>p?.index===i)?.mint||null),parents:PARENT_NAMES};
 return <section className="post-flywheel"><div className="post-flywheel-head"><div><h2>Every trade feeds the family.</h2><p>{feeSentence(verified?data.tradeFeeBps:null)}</p></div><span className="post-preview-badge">{f?format(f.totalSol,9)+' SOL collected':'No fees yet'}<Help label="SOL collected">All the SOL the pool fee has brought in since launch. It is split between the KIDS treasury, the dev and buybacks of both parents.</Help></span></div>
  <div className="post-flywheel-grid">
   <div className="post-flywheel-tile is-burn"><span>$Shartcoin burned from fees<Help label="$Shartcoin burned from fees">The coin side of the pool fee. These coins are destroyed for good, never sold back into the pool.</Help></span><strong title={childBurned.exact||undefined}>{childBurned.text} <small>coins</small></strong><em><Burn/> never sold</em></div>
   <div className="post-flywheel-tile"><span>KIDS treasury<Help label="KIDS treasury">The part of the SOL fee that has been paid to the KIDS treasury so far.</Help></span><Figure raw={f?.treasuryPaid} decimals={9} unit="SOL"/></div>
   <div className="post-flywheel-tile"><span>Dev<Help label="Dev">The part of the SOL fee that has been paid to the Shartcoin dev wallet so far.</Help></span><Figure raw={f?.devPaid} decimals={9} unit="SOL"/></div>
   {PARENT_NAMES.map((name,i)=>{const spent=f?(i?f.parentBSpent:f.parentASpent):null,burned=compactUnits(f?(i?f.parentBBurned:f.parentABurned):null,parentDecimals,name+' burned');let queued=null;try{if(f){const q=BigInt(i?f.parentBAllocated:f.parentAAllocated)-BigInt(spent);if(q>0n)queued=q;}}catch{}
    return <div key={name} className="post-flywheel-tile is-burn"><span><ParentIcon name={name}/> {name} buyback<Help label={name+' buyback'}>SOL from the fee that bought {name} on the open market. Every coin bought this way is burned.</Help></span><Figure raw={spent} decimals={9} unit="SOL"/><em title={burned.exact||undefined}><Burn/> {burned.text} burned</em>{queued!=null&&<small>{format(queued,9)} SOL queued, not yet bought</small>}</div>;})}
  </div>
  <ActivityFeed campaign={verified?data.campaign:null} data={verified?data:null} names={names} enabled={verified}/>
 </section>;
}
function Metric({label,value,unit,note,tone,fresh,title,help}){return <div className="post-metric"><span>{label}{help&&<Help label={label}>{help}</Help>}</span><strong className={tone?'is-'+tone:undefined} title={title||undefined}>{value}{unit&&<small>{unit}</small>}</strong>{(note||fresh)&&<small>{note&&<span>{note}</span>}{fresh&&<em className={`post-metric-fresh is-${fresh.tone}`}>{fresh.text}</em>}</small>}</div>;}
/** Market summary for the metrics row: read every 10 s while the page is visible, last valid answer kept through failures. */
function useMarketSummary(campaign,enabled){
 const [state,setState]=useState({summary:null,result:null,readAt:null,now:Math.floor(Date.now()/1000)});
 useEffect(()=>{
  if(!campaign||!enabled){setState({summary:null,result:null,readAt:null,now:Math.floor(Date.now()/1000)});return;}
  let controller=null,alive=true;
  const stop=startPolling(async()=>{
   controller?.abort();controller=new AbortController();const signal=controller.signal;
   const result=await fetchMarket('summary',{campaign},{signal});if(!alive||signal.aborted)return;
   const now=Math.floor(Date.now()/1000);
   setState(s=>result.ok?{summary:result.data,result,readAt:now,now}:{...s,result,now});
  },POLL_MS);
  return()=>{alive=false;stop();controller?.abort();};
 },[campaign,enabled]);
 const marketState=enabled?deriveMarketState({summary:state.summary,result:state.result,nowUnix:state.now}):'off';
 return {...state,state:marketState,hint:freshnessHint({state:marketState,summary:state.summary,lastReadUnix:state.readAt,nowUnix:state.now})};
}
/** One line under the heading: what this wallet can claim right now, or why that is unknown. Selecting Claims is the reader's click, never automatic. */
function ClaimStrip({owner,claims,verified,loading,error,onSignIn,onOpen,decimals}){
 if(!owner)return <div className="post-claim-strip is-quiet"><span>Sign in to see what you can claim.</span><button className="text-button" onClick={onSignIn}>Sign in <ArrowRight size={15}/></button></div>;
 if(loading)return <div className="post-claim-strip is-quiet" aria-busy="true"><span>Checking claims for {short(owner)}…</span></div>;
 if(error||!verified||!claims)return <div className="post-claim-strip is-quiet"><span>{error||'Your claims could not be read.'}</span><button className="text-button" onClick={onOpen}>Open claims <ArrowRight size={15}/></button></div>;
 const items=claimableItems(claims,decimals);
 if(!items.length)return <div className="post-claim-strip is-quiet"><span>Nothing left to claim for {short(owner)}.</span><button className="text-button" onClick={onOpen}>See claims <ArrowRight size={15}/></button></div>;
 return <div className="post-claim-strip"><span className="post-claim-strip-label"><i aria-hidden="true"/>You can claim</span><ul>{items.map(i=><li key={i.key}>{i.text}</li>)}</ul><button className="primary post-claim-strip-open" onClick={onOpen}>Open claims <ArrowRight size={18}/></button></div>;
}
export function PostLaunch({identity,onSignIn,profile,posts=[],go,preview=false}){
 const [tab,setTab]=useState('Market'),[railTab,setRailTab]=useState(()=>location.hash.split('/')[1]==='claims'?'Claims':'Trade'),[snapshot,setSnapshot]=useState(null),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),[copied,setCopied]=useState(''),[videoError,setVideoError]=useState(false);
 const [claimBusy,setClaimBusy]=useState(''),[claimResult,setClaimResult]=useState('');
 const owner=identity?.owner,ownerRef=useRef(owner),claimLock=useRef(false),claimPending=useRef(null),railRef=useRef(null);ownerRef.current=owner;
 useEffect(()=>{setClaimResult('');claimPending.current=null;},[owner]);
 async function claim(action){if(claimLock.current||!canClaim(action.startsWith('parent')?'parent':action,action==='parentB'?1:0))return;claimLock.current=true;setClaimBusy(action);setClaimResult('');try{const session=await accountApi('state');if(session.owner!==owner||ownerRef.current!==owner)throw Error('Wallet changed. Refresh your allocations.');let result;
 if(claims?.localClaimEnabled){result=await accountApi('postlaunch/claim',{action,campaign:claims.campaign},session.csrf);}
 else{
  const key=JSON.stringify([owner,claims.campaign,action]);if(claimPending.current?.key!==key)claimPending.current={key,requestId:crypto.randomUUID()};const pending=claimPending.current;
  const intent=await accountApi('postlaunch/claim/prepare',{action,campaign:claims.campaign,requestId:pending.requestId},session.csrf);
  if(ownerRef.current!==owner||intent.owner!==owner||intent.campaign!==claims.campaign||intent.programId!==data.programId||intent.mint!==data.mint||intent.genesisHash!==claims.genesisHash)throw Error('Claim identity changed. Refresh before signing.');
  if(!pending.body){
   const provider=await walletForOwner(owner);if(ownerRef.current!==owner)throw Error('Wallet changed. Refresh your allocations.');
   const {decodeApprovedClaim}=await import('./claim-signing.mjs'),{assertApprovedMessage}=await import('./escrow-signing.mjs');
   const tx=decodeApprovedClaim(Uint8Array.from(atob(intent.unsignedTransactionBase64),c=>c.charCodeAt(0)),{owner,programId:intent.programId,campaign:intent.campaign,mint:intent.mint,action}),approved=tx.message.serialize().slice();
   const signed=await provider.signTransaction(tx);if(ownerRef.current!==owner||provider.publicKey?.toString()!==owner)throw Error('Wallet changed before submission.');
   const bytes=assertApprovedMessage(signed,approved);let text='';for(const byte of bytes)text+=String.fromCharCode(byte);pending.body={intentId:intent.intentId,signedTransactionBase64:btoa(text)};
  }
  if(ownerRef.current!==owner)throw Error('Wallet changed before submission.');result=await accountApi('postlaunch/claim/submit',pending.body,session.csrf);
 }
 claimPending.current=null;if(ownerRef.current!==owner)return;if(!result.signature)throw Error('No transaction receipt returned. Refresh to check your claim.');setClaimResult({ok:true,title:'Claim confirmed',detail:'Your coins are in your wallet '+net.on+'.',technical:result.signature});setRefresh(n=>n+1);}catch(e){if(ownerRef.current===owner){if(!claimPending.current?.body&&e.message.includes('Unsigned claim expired'))claimPending.current=null;setClaimResult({ok:false,...friendlyError(e,{payWith:'SOL'})});}}finally{claimLock.current=false;setClaimBusy('');}}
 useEffect(()=>{let active=true;setError('');accountApi(preview?'postlaunch-preview':'postlaunch').then(data=>{if(active)setSnapshot({owner,data});}).catch(()=>{if(active){setSnapshot(null);setError('Launch data is not connected.');}});return()=>{active=false;};},[owner,refresh,preview]);
 const data=snapshot&&snapshot.owner===owner?snapshot.data:null,loading=!data&&!error;
 const verified=data?.configured===true&&['localnet','devnet','mainnet'].includes(data.network)&&data.scope===(preview?data.network+'-rehearsal':'active-'+data.network)&&typeof data.mint==='string'&&typeof data.pool==='string';
 const claims=verified&&data.claims?.owner===owner?data.claims:null;const net=netLabel(data?.network),decimals=Number.isInteger(data?.decimals)?data.decimals:6;
 const left=(total,claimed)=>{const r=remainingRaw(total,claimed);return r!=null&&BigInt(r)>0n;};
 const reasonFor=(kind,index=0)=>{if(!owner)return 'Sign in first';if(!claims)return 'Loading';if(!(claims.localClaimEnabled||claims.externalClaimEnabled))return 'Test wallets only';if(kind==='participant')return claimedAll(claims.participant?.allocatedRaw,claims.participant?.claimedRaw)?'Claimed':BigInt(claims.participant?.allocatedRaw||0)===0n?'No allocation':'';if(kind==='refund')return BigInt(claims.refund?.refundedLamports||0)>0n?'Refunded':'Nothing to refund';if(kind==='dev')return claims.dev?.isDev?'Nothing vested yet':'Dev wallet only';const p=parentState(claims.parents?.[index],claims.vault,decimals);return p.state==='open'?'':p.button;};
 const canClaim=(kind,index=0)=>{if(!owner||!(claims?.localClaimEnabled||claims?.externalClaimEnabled))return false;if(kind==='participant')return left(claims.participant?.allocatedRaw,claims.participant?.claimedRaw);if(kind==='refund')return left(claims.refund?.claimableLamports,0);if(kind==='dev')return claims.dev?.isDev&&left(claims.dev?.claimableRaw,0);const p=parentState(claims.parents?.[index],claims.vault,decimals);return p.state==='open'&&BigInt(p.remainingRaw||0)>0n;};
 const video=resolveShartVideo(profile?.video);
 async function copy(value,label){try{await navigator.clipboard.writeText(value);setCopied(`${label} copied`);}catch{setCopied('Copy unavailable. Select the address in Token details.');}}
 function openClaims(){setRailTab('Claims');requestAnimationFrame(()=>{const rail=railRef.current;if(!rail)return;rail.scrollIntoView({behavior:'smooth',block:'start'});rail.querySelector('#post-rail-tab-Claims')?.focus({preventScroll:true});});}
 const socials=[{key:'xUrl',label:'Shartcoin on X',Icon:XLogo},{key:'websiteUrl',label:'Shartcoin website',Icon:Globe}].filter(({key})=>typeof profile?.[key]==='string'&&/^https:\/\//.test(profile[key]));
 const facts=custodyFacts(verified?data:null);
 const market=useMarketSummary(verified?data.campaign:null,verified);
 const summary=market.summary,marketOk=market.state!=='off'&&market.state!=='loading';
 const price=formatPrice(marketOk?summary?.priceSol:null),change=formatChange(marketOk?summary?.priceChange24hPct:null),volume=formatSolVolume(marketOk?summary?.volume24hSol:null);
 const liquidity=verified?poolLiquidity({quoteReserveLamports:data.quoteReserveLamports,baseReserveRaw:data.baseReserveRaw,decimals,priceSol:marketOk?summary?.priceSol:null}):null;
 const poolReadUnix=verified&&data.observedAt?Math.floor(Date.parse(data.observedAt)/1000):null;
 const poolFresh=verified?{text:poolReadUnix?'Pool read '+relativeTime(poolReadUnix,market.now):'Pool read at slot '+Number(data.observedSlot||0).toLocaleString('en-GB'),tone:'live'}:null;
 const feedFresh=verified?market.hint:null;
 const statusText=verified?(preview?net.name+' test pool · Separate from Shartcoin':'Active Shartcoin · '+net.name):loading?'Loading launch data…':error?'Launch data unavailable':preview?'Trading and claims are not connected':'No launched campaign is connected';
 return <section className="post-launch">
  <div className="post-page-bar"><button className="text-button" onClick={()=>go('Shart')}><ArrowLeft size={17}/> Funding history</button><div><span className="post-preview-badge">{preview?'Post-launch preview':'Shartcoin launch'}</span><span>{statusText}</span>{!preview&&!verified&&!loading&&<button className="text-button" onClick={()=>go('PostLaunchPreview')}>View post-launch preview</button>}</div><button className="text-button" onClick={()=>setRefresh(n=>n+1)}>Refresh</button></div>
  <div className="post-terminal">
   <div className="post-main">
    <div className="post-market-heading"><div><span className="post-kicker">The next chapter</span><h1>Shartcoin <span>$Shartcoin</span></h1></div><span className={`post-status ${verified?'is-verified':''}`}><span/>{verified?'Pool found '+net.on:loading?'Reading the pool…':'Pool not connected'}</span></div>
    {!preview&&<ClaimStrip owner={owner} claims={claims} verified={verified} loading={loading} error={error} onSignIn={onSignIn} onOpen={openClaims} decimals={decimals}/>}
    <div className="post-metrics is-six">
     <Metric label="Price" value={price.text} unit={price.exact?' SOL':null} title={price.exact?price.exact+' SOL per $Shartcoin':undefined} note="SOL per $Shartcoin" fresh={feedFresh}/>
     <Metric label="24h change" value={change.text} tone={change.tone==='up'||change.tone==='down'?change.tone:null} note="Against the price 24 hours ago" fresh={feedFresh}/>
     <Metric label="24h volume" value={volume.text} unit={volume.exact?' SOL':null} title={volume.exact?volume.exact+' SOL traded in 24 hours':undefined} note={marketOk&&summary?.trades24h!=null?Number(summary.trades24h).toLocaleString('en-GB')+' trades':'Traded in the last 24 hours'} fresh={feedFresh}/>
     <Metric label="Pool liquidity" value={liquidity?formatSol(liquidity.total??liquidity.solSide):'—'} unit={liquidity&&(liquidity.total??liquidity.solSide)!=null?' SOL':null} title={liquidity?.total!=null?formatSol(liquidity.solSide)+' SOL + '+formatSol(liquidity.coinSideSol)+' SOL in $Shartcoin at the last price':undefined} note={liquidity?.total!=null?`${formatSol(liquidity.solSide,2)} SOL + $Shartcoin worth ${formatSol(liquidity.coinSideSol,2)} SOL at the last price`:liquidity?.solSide!=null?'SOL side only; the coin side needs a price from the feed':'Both sides of the pool'} fresh={poolFresh} help="The SOL in the pool plus its $Shartcoin valued at the last trade price. A deeper pool moves less on each trade."/>
     <Metric label="Token reserve" value={verified?formatWhole(data.baseReserveRaw,decimals):'—'} note="$Shartcoin in the pool" fresh={poolFresh} help="How many $Shartcoin sit in the pool right now. Buys take coins out of it, sells put coins back."/>
     <Metric label="Pool fee" value={verified&&data.tradeFeeBps?(data.tradeFeeBps/100).toLocaleString('en-GB')+'%':'—'} note={verified&&data.tradeFeeBps?'Read from the pool':'Not served'} fresh={verified&&data.tradeFeeBps?poolFresh:null} help="The share of every trade that goes to the pool, read from the pool itself. Part of it feeds the family; the rest is Raydium's share."/>
    </div>
    <section className="post-market-panel" aria-label="Coin market and media"><div className="post-panel-tabs" role="tablist" onKeyDown={moveTab} aria-label="Coin content">{['Market','Dev updates',...(video?['Video']:[])].map(name=><button id={`post-tab-${name.replaceAll(' ','-')}`} key={name} role="tab" tabIndex={tab===name?0:-1} aria-selected={tab===name} aria-controls="post-content-panel" onClick={()=>setTab(name)}>{name==='Market'?<ChartLine size={17}/>:name==='Video'?<Play size={17}/>:null}{name}</button>)}</div>
     <div id="post-content-panel" role="tabpanel" aria-labelledby={`post-tab-${tab.replaceAll(' ','-')}`} className={`post-panel-content ${tab==='Video'?'is-video':''}${tab==='Market'&&verified?' is-market':''}`}>
      {tab==='Market'&&!verified&&<div className="post-chart-empty"><div className="post-chart-grid" aria-hidden="true"/><div className="post-chart-message"><ChartLine size={35} weight="light"/><h2>A home for every move.</h2><p>The price chart appears here when the pool is connected.</p><span>{loading?'Reading the pool…':'Connect a launched pool to see trading activity.'}</span></div><div className="post-market-legend"><span><i/> $Shartcoin / SOL</span><span>Raydium CPMM</span></div></div>}
      {tab==='Market'&&verified&&<Suspense fallback={<div className="post-chart-empty" aria-busy="true"><div className="post-chart-grid" aria-hidden="true"/><div className="post-chart-message"><ChartLine size={30} weight="light" aria-hidden="true"/><h2>Loading the chart…</h2><p>Fetching the chart library.</p></div></div>}><MarketTab campaign={data.campaign} decimals={decimals} data={data} market={market} enabled={verified}/></Suspense>}
      {tab==='Dev updates'&&<CoinUpdates profile={profile} posts={posts} ready={false} admin={false}/>}
      {tab==='Video'&&(videoError?<div className="post-media-error"><p>Video unavailable.</p><button className="outlined" onClick={()=>setVideoError(false)}>Retry video</button></div>:<video key={video} controls playsInline preload="metadata" src={video} aria-label="Shartcoin introduction" onError={()=>setVideoError(true)}/>)}
     </div>
    </section>
    <div className="post-pool-strip"><span><LockKey size={17}/>{verified?facts[2][1]:'LP lock not verified'}</span><span><CheckCircle size={17}/>{verified&&data.mintAuthorityRevoked&&data.freezeAuthorityRevoked?'Mint & freeze authority revoked':verified?'Mint or freeze authority still active':'Authorities not read'}</span><details><summary>Token details</summary><dl>
     <dt>Network</dt><dd>{networkFact(data?.network,preview)}{verified&&data.observedSlot!=null&&<small>Read at slot {Number(data.observedSlot).toLocaleString('en-GB')}{data.observedAt?', '+formatUtc(Math.floor(Date.parse(data.observedAt)/1000)):''}</small>}</dd>
     <dt>Mint</dt><dd>{verified?data.mint:'Not connected'}{verified&&explorerAccount(data,data.mint)&&<a href={explorerAccount(data,data.mint)} target="_blank" rel="noopener noreferrer">Explorer</a>}</dd>
     <dt>Pool</dt><dd>{verified?data.pool:'Not connected'}{verified&&explorerAccount(data,data.pool)&&<a href={explorerAccount(data,data.pool)} target="_blank" rel="noopener noreferrer">Explorer</a>}</dd>
     <dt>Launch program</dt><dd>{verified?data.programId:'Not connected'}{verified&&explorerAccount(data,data.programId)&&<a href={explorerAccount(data,data.programId)} target="_blank" rel="noopener noreferrer">Explorer</a>}</dd>
     {verified&&data.distribution?.program&&<><dt>Claims program</dt><dd>{data.distribution.program}</dd></>}
     <dt>Launch transaction</dt><dd>{verified?(data.launchSignature||'Not recorded'):'Not connected'}{verified&&data.receiptHistoryAvailable===false&&<small>Receipt history unavailable; pool state read on chain.</small>}</dd>
     {facts.map(([label,value])=><div key={label} className="post-fact"><dt>{label}</dt><dd>{value}</dd></div>)}
     <dt>Unclaimed coins</dt><dd>{verified&&data.launchAuthority?'Held at '+data.launchAuthority+', a program-derived address with no private key. The launch program’s rules decide what moves them; see the program rows above.':'—'}</dd>
     <dt>Supply split</dt><dd>43.5 % prelaunch · 43.5 % liquidity · 5 % each parent · 3 % dev{verified&&data.supplyRaw?<small>Supply now {formatWhole(data.supplyRaw,decimals)} $Shartcoin</small>:null}</dd>
     {verified&&(data.distribution?.devStartUnix||data.launchedAt)&&<><dt>Dev vesting</dt><dd>1 % at launch, 2 % linear from {formatUtc(data.distribution?.devStartUnix||data.launchedAt)}{data.distribution?.devEndUnix?' to '+formatUtc(data.distribution.devEndUnix):''}.</dd></>}
     <dt>Fee routing</dt><dd>{data?.fees?`${format(data.fees.treasuryPaid,9)} SOL to KIDS · ${format(data.fees.devPaid,9)} SOL to dev`:'Not initialized for this pool'}</dd>{data?.fees&&<><dt>Parent buybacks</dt><dd>{format(data.fees.parentASpent,9)} SOL / {format(data.fees.parentBSpent,9)} SOL spent</dd></>}
    </dl></details></div>
   </div>
   <aside className="post-rail" ref={railRef}>
    <div className="post-banner"><img src={profile?.banner||"/assets/shart-cover.jpg"} alt="Shartcoin banner"/>{socials.length>0&&<div className="post-socials">{socials.map(({key,label,Icon})=><a key={key} href={profile[key]} target="_blank" rel="noopener noreferrer" aria-label={label} title={label}><Icon size={20} aria-hidden="true"/></a>)}</div>}</div>
    <div className="post-identity"><img src={profile?.logo||"/assets/shart-pfp.png"} alt="Shartcoin logo"/><div><div className="post-inline-parents"><ParentIcon name="Fartcoin"/><span>Fartcoin</span><b>×</b><ParentIcon name="Buttcoin"/><span>Buttcoin</span></div><strong>Shartcoin</strong><small>$Shartcoin</small></div></div>
    <p className="post-description">{resolveCoinDescription(profile?.description)}</p>
    <button className="post-contract" disabled={!verified} onClick={()=>copy(data.mint,'Mint address')}><span>CA</span><code>{verified?short(data.mint):'Available after connection'}</code><Copy size={16}/></button>
    <div className="post-rail-tabs" role="tablist" aria-label="Trade or claim" onKeyDown={moveTab}>{['Trade','Claims'].map(name=><button key={name} id={`post-rail-tab-${name}`} role="tab" tabIndex={railTab===name?0:-1} aria-selected={railTab===name} aria-controls="post-rail-panel" onClick={()=>setRailTab(name)}>{name}{name==='Claims'&&claims&&claimableItems(claims,decimals).length>0&&<i className="post-rail-dot" role="img" aria-label="something to claim"/>}</button>)}</div>
    <div id="post-rail-panel" role="tabpanel" aria-labelledby={`post-rail-tab-${railTab}`} className="post-rail-panel">
     {railTab==='Trade'&&<LocalTradePanel owner={owner} campaign={data?.campaign} tradeFeeBps={data?.tradeFeeBps||null} wallet={data?.wallet||null} network={data?.network||'localnet'} enabled={verified&&!!owner} localExecution={claims?.localClaimEnabled===true} mint={data?.mint} pool={data?.pool} programId={data?.programId} genesisHash={data?.genesisHash} onSignIn={onSignIn} onTraded={()=>setRefresh(n=>n+1)}/>}
     {railTab==='Claims'&&<div aria-busy={!!claimBusy}><ClaimPanel owner={owner} claims={claims} data={data} verified={verified} loading={loading} error={error} onSignIn={onSignIn} act={claim} busy={claimBusy} canClaim={canClaim} reasonFor={reasonFor} onRefresh={()=>setRefresh(n=>n+1)} result={claimResult} priceSol={marketOk?summary?.priceSol:null}/></div>}
    </div>
   </aside>
   <Flywheel data={data} verified={verified}/>
  </div>
  <span className="post-announcement" role="status" aria-live="polite">{copied||error}</span>
 </section>;
}
