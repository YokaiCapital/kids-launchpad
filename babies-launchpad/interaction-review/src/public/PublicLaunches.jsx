import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import './public-launches.css';
import {makeClock} from './campaign-source.mjs';
import {ExplorePage} from './ExplorePage';
import {LaunchWizard} from './LaunchWizard';
import {CoinPage} from './CoinPage';
import {PortfolioPage} from './PortfolioPage';
import {MyLaunchesPage} from './MyLaunchesPage';
import {CreatorJourney} from './CreatorJourney';
import {CreatorQuote} from './CreatorQuote';
import {accountApi} from '../Account';
import {usePublicWallet} from './usePublicWallet';
import {coinHref,subFromHash} from './routes.mjs';
import {useCampaignDirectory} from './useCampaignDirectory';
import {useCampaignDetail} from './useCampaignDetail';
/**
 * Shell for the flag-gated public routes (#explore, #launch-new, #coin/<campaignId>, #portfolio, #my-launches).
 * Mounted by App only when VITE_KIDS_PUBLIC_LAUNCHES is '1'. Owns the campaign source and the chain-aligned clock.
 */
export function PublicLaunches({view,go,identity,onSignIn}){
 const clockRef=useRef(makeClock(null));
 const [sub,setSub]=useState(()=>subFromHash(location.hash));
 const [previewWallet,setPreviewWallet]=useState(false);
 const [notice,setNotice]=useState(null);
 useEffect(()=>{const onHash=()=>setSub(subFromHash(location.hash));window.addEventListener('hashchange',onHash);return()=>window.removeEventListener('hashchange',onHash);},[]);
 const [directoryFilters,setDirectoryFilters]=useState({query:null,mode:null,status:null});
 const directory=useCampaignDirectory({...(view==='Explore'?directoryFilters:{}),creator:view==='MyLaunches'?identity?.owner||null:null,onClock:time=>{clockRef.current=makeClock(time);}});
 const indexedPortfolio=view==='Portfolio'&&!!identity?.owner&&directory.manifest?.capabilities?.portfolioRead===true;
 const portfolio=useCampaignDirectory({portfolioOwner:identity?.owner||null,enabled:indexedPortfolio});
 const source=indexedPortfolio?{...portfolio,manifest:directory.manifest,indexedPortfolio:true}:directory;
 const load=source.retry;
 const detailKey=view==='Coin'?sub:null;
 const {detail,load:loadDetail}=useCampaignDetail(detailKey);
 const coin=detail?.key===detailKey?detail.vm:null;
 // Never scan every launch for every connected visitor. Coin reads one position;
 // portfolio/creator management read only the bounded directory page (20).
 const walletCampaigns=useMemo(()=>view==='Coin'?(coin?[coin]:[]):['Portfolio','MyLaunches'].includes(view)?source.campaigns:[],[view,coin,source.campaigns]);
 const refresh=useCallback(()=>{load({quiet:true});if(view==='Coin')loadDetail();},[load,view,loadDetail]);
 const api=usePublicWallet({owner:identity?.owner,campaigns:walletCampaigns,onConfirmed:refresh,readDrafts:['MyLaunches','LaunchNew'].includes(view)});
 const [editingDraft,setEditingDraft]=useState(null);
 const [creation,setCreation]=useState(null),[creationBusy,setCreationBusy]=useState(false),[creationError,setCreationError]=useState(null);
 const creatorOwner=useRef(identity?.owner),creationRunning=useRef(false);creatorOwner.current=identity?.owner;
 // Compile-time local rehearsal only. This does not enable public creation or
 // mount financial services; the authenticated server still enforces its pilot.
 const rehearsal=import.meta.env.DEV&&import.meta.env.VITE_KIDS_NETWORK==='localnet'&&import.meta.env.VITE_KIDS_CREATOR_REHEARSAL==='1'&&['localhost','127.0.0.1','[::1]'].includes(location.hostname)&&!source.fixture&&!!identity?.owner;
 useEffect(()=>{setCreation(null);setCreationError(null);setEditingDraft(null);},[identity?.owner]);
 async function creationCall(path,body){
  const owner=identity?.owner;if(!creationEnabled||!owner)throw Error('Launch creation is not available here');
  const assert=()=>{if(creatorOwner.current!==owner)throw Error('Creator wallet changed');};
  const session=await accountApi('state');assert();if(session.owner!==owner)throw Error('Signed-in wallet changed');
  const result=await accountApi('launches/creation/'+path,body,session.csrf,{retries:0});assert();return result;
 }
 async function creationAction(fn){
  if(creationRunning.current)return;creationRunning.current=true;setCreationBusy(true);setCreationError(null);
  const owner=identity?.owner;try{await fn();}catch(e){if(creatorOwner.current===owner)setCreationError(e.message);}finally{creationRunning.current=false;if(creatorOwner.current===owner)setCreationBusy(false);}
 }
 async function reviewCreation(saved){
  return creationAction(async()=>{
   setEditingDraft(saved);const accepted=await creationCall('status',{draftId:saved.id});
   if(accepted){setCreation({request:accepted});return;}
   const quote=await creationCall('quote',{draftId:saved.id,revision:saved.revision,requestId:crypto.randomUUID()});
   if(quote.owner!==identity.owner||quote.draftId!==saved.id||quote.draftRevision!==saved.revision)throw Error('Setup quote belongs to another draft');
   // One click (owner, 28 September 2026): when the exact setup quote is within two percent of the estimate the review
   // step showed, it is accepted at once and the wallet approvals start; a larger difference is shown for a fresh decision.
   const estimate=source.manifest?.costQuote?.items?.find(i=>i.key==='setup')?.lamports,exact=quote.body?.costs?.totalLamports;
   if(estimate&&exact&&/^\d+$/.test(estimate)&&/^\d+$/.test(exact)&&BigInt(exact)*100n<=BigInt(estimate)*102n){const request=await creationCall('accept',{quoteId:quote.id});setCreation({request});api.reload();return;}
   setCreation({quote,saved});
  });
 }
 async function acceptCreation(){
  return creationAction(async()=>{
   // Resolve a lost accept response through the same draft before accepting
   // this exact quote again. Never create a new request after an ambiguous send.
   const saved=creation.saved,existing=await creationCall('status',{draftId:saved.id});
   const request=existing||await creationCall('accept',{quoteId:creation.quote.id});
   setCreation({request});api.reload();
  });
 }
 async function resumeDraft(d){
  const saved=api.drafts.find(x=>x.id===d.id);setEditingDraft(saved);setCreation(null);go('LaunchNew');
  if(saved?.status==='creating'&&creationEnabled)await creationAction(async()=>{
   const request=await creationCall('status',{draftId:saved.id});if(!request)throw Error('Accepted launch is not available. Keep this draft and retry.');setCreation({request});
  });
 }
 const clock=useCallback(()=>clockRef.current(),[]);
 const retry=useCallback(()=>{load();if(view==='Coin')loadDetail();api.reload();},[load,loadDetail,view,api.reload]);
 const src={...source,retry};
 // Wallet identity for these pages: the signed-in account, or the fixture wallet when explicitly previewed. Never both.
 const wallet=useMemo(()=>{
  if(identity?.owner)return {address:identity.owner,balanceLamports:api.account?.balanceLamports??null,fixture:false,connect:onSignIn};
  if(previewWallet&&source.fixture&&source.wallet)return {address:source.wallet.address,balanceLamports:null,fixture:true,connect:onSignIn};
  return null;
 },[identity?.owner,previewWallet,source.fixture,source.wallet,onSignIn,api.account?.balanceLamports]);
 useEffect(()=>{if(identity?.owner)setPreviewWallet(false);},[identity?.owner]);
 // Hosted creation (the wallet-restricted pilot, then the public opening): the server says whether creation is on and
 // enforces the pilot wallet itself; the local rehearsal keeps its compile-time switch. Declared after `wallet`, which it reads.
 const creationEnabled=rehearsal||(!!source.manifest?.capabilities?.create&&!source.fixture&&!!identity?.owner&&!wallet?.fixture);
 // Unknown chain reads stay undefined. Fixture positions never substitute for a real wallet.
 const positions=useMemo(()=>{
  if(!wallet)return null;
  if(!wallet.fixture)return api.account?.positions;
  const map={};for(const p of source.wallet?.positions||[])map[p.campaign]=p;return map;
 },[wallet,source.wallet,api.account]);
 const positionFor=vm=>wallet?(wallet.fixture?(positions?.[vm.identity.campaign]??null):positions?.[vm.id]):null;
 if(view==='Explore')return <ExplorePage source={src} clock={clock} go={go} coinHref={coinHref} onFilters={setDirectoryFilters}/>;
 if(view==='LaunchNew'){
  if(creationEnabled&&creation?.request)return <CreatorJourney key={identity.owner+':'+creation.request.id} owner={identity.owner} request={creation.request} onOpenCoin={campaign=>{go('Coin',campaign);load({quiet:true});}} onBack={()=>go('MyLaunches')}/>;
  if(creationEnabled&&creation?.quote)return <CreatorQuote quote={creation.quote} draft={creation.saved.body} busy={creationBusy} error={creationError} onAccept={acceptCreation} onRefresh={()=>reviewCreation(creation.saved)} onBack={()=>setCreation(null)}/>;
  if(editingDraft?.status==='creating')return <section className="pl"><div className="pl-panel"><h2>Creation already started</h2><p>{creationError||'Your accepted terms are preserved. Resume the existing request to continue.'}</p><button type="button" disabled={!creationEnabled||creationBusy} onClick={()=>resumeDraft(editingDraft)}>Resume creation</button><button type="button" onClick={()=>go('MyLaunches')}>My launches</button></div></section>;
  if(source.status==='loading')return <section className="pl" aria-busy="true"><p className="pl-small pl-muted">Loading the launch terms…</p></section>;
  if(!source.manifest)return <section className="pl"><div className="pl-panel pl-state is-error" role="alert"><h2>Launch terms unavailable</h2><p>{source.error||'No preset manifest is published, so nothing can be created.'}</p><button type="button" onClick={retry}>Retry</button></div></section>;
  return <LaunchWizard key={(identity?.owner||'anonymous')+':'+(editingDraft?.id||'new')} savedDraft={editingDraft?.creator===wallet?.address?editingDraft:null} onSave={api.saveDraft} manifest={source.manifest} parents={source.manifest.parents||[]} creator={wallet?.address||null} clock={clock} notice={notice} rehearsal={rehearsal} creating={creationBusy} creationError={creationError} onCancel={()=>go('MyLaunches')}
   onPrepublish={source.manifest.capabilities?.prepareArtwork&&creationEnabled?saved=>creationCall('artwork',{draftId:saved.id,revision:saved.revision}):null} onUpload={source.manifest.capabilities?.artwork&&!wallet?.fixture?api.uploadArtwork:null} onUploadVideo={source.manifest.capabilities?.videoPublication&&!wallet?.fixture?api.uploadVideo:null} onCreate={creationEnabled?reviewCreation:null}/>;
 }
 if(view==='Coin'){
  const vm=coin||(source.fixture?source.campaigns.find(c=>c.id===sub||c.identity.campaign===sub||c.slug===sub):null)||null;
  if(source.status==='loading'||!source.fixture&&detail?.key!==detailKey)return <section className="pl pl-wide" aria-busy="true"><div className="pl-coin"><div className="pl-panel"><span className="pl-skel" style={{width:'40%',height:22}}/><span className="pl-skel" style={{width:'55%',height:40,margin:'16px 0'}}/><span className="pl-skel" style={{width:'100%',height:10}}/></div><div className="pl-panel"><span className="pl-skel" style={{width:'100%',aspectRatio:'3/1',borderRadius:12}}/><span className="pl-skel" style={{width:'50%',height:22,marginTop:12}}/></div></div></section>;
  if(source.status==='error'||detail?.key===detailKey&&detail.error)return <section className="pl"><div className="pl-panel pl-state is-error" role="alert"><h2>Status temporarily unavailable</h2><p>{detail?.error||source.error}</p><button type="button" onClick={retry}>Retry</button></div></section>;
  if(!vm)return <section className="pl"><div className="pl-panel pl-state"><h2>No launch with that address</h2><p className="pl-mono pl-small">{sub||'(none)'}</p><button type="button" onClick={()=>go('Explore')}>Back to Explore</button></div></section>;
  return <CoinPage key={vm.id} vm={vm} clock={clock} go={go} wallet={wallet} position={positionFor(vm)} source={src} onConnect={onSignIn} onCommit={source.manifest?.capabilities?.commit&&['2','3'].includes(vm.terms.version)&&vm.mode==='standard'&&!wallet?.fixture?amount=>api.transact(vm,'commit',amount):null} onClaim={source.manifest?.capabilities?.claim&&['2','3'].includes(vm.terms.version)&&vm.mode==='standard'&&!wallet?.fixture?action=>api.transact(vm,action):null} transaction={api.notice} busy={api.busy} onCheck={api.check} accountError={api.error} trade={{quote:api.tradeQuote,working:api.tradeWorking,blocked:api.busy&&!api.tradeQuote,prepare:source.manifest?.capabilities?.trade&&vm.terms.version==='3'&&vm.mode==='standard'&&!wallet?.fixture?input=>api.prepareTrade(vm,input):null,sign:api.signTrade,cancel:api.cancelTrade}}/>;
 }
 if(view==='Portfolio')return <PortfolioPage source={src} wallet={wallet} positions={positions} reading={api.reading} accountError={api.error} go={go} coinHref={coinHref} onConnect={onSignIn} onPreviewWallet={()=>setPreviewWallet(true)}/>;
 if(view==='MyLaunches')return <MyLaunchesPage onReadOperations={source.manifest?.capabilities?.creatorOperationsRead?api.readOperations:null} source={src} wallet={wallet} drafts={wallet?.fixture?source.wallet?.drafts||[]:api.drafts.map(d=>({...d,...d.body,updatedAtUnix:Math.floor(Date.parse(d.updatedAt)/1000)}))} onResume={resumeDraft} onNew={()=>{setEditingDraft(null);setCreation(null);setCreationError(null);go('LaunchNew');}} go={go} coinHref={coinHref} onConnect={onSignIn} positions={positions} onAction={source.manifest?.capabilities?.claim&&!wallet?.fixture?api.transact:null} busy={api.busy} transaction={api.notice} onCheck={api.check} accountError={api.error}/>;
 return null;
}
