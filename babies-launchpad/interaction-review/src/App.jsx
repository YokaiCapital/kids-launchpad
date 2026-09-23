import {useEffect,useRef,useState} from 'react';
import {Wallet,Users} from '@phosphor-icons/react';
import {Account,accountApi} from './Account';
import {lazy,Suspense} from 'react';
// Admin exists only in the local development server (owner rule, 22 September 2026): production builds strip the
// view, the navigation entry and the route, so nothing uploaded to Vercel or Railway contains admin functions.
const LOCAL_ADMIN=import.meta.env.DEV===true;
const Admin=LOCAL_ADMIN?lazy(()=>import('./Admin').then(m=>({default:m.Admin}))):null;
import {Home} from './Home';
import {PostLaunch} from './PostLaunch';
import {SITE_NETWORK} from './network-label.mjs';
import {Prelaunch} from './Prelaunch.jsx';
import {emptyPrelaunch} from './prelaunch.js';
import {loadDemo,saveDemo} from './demo-api';
import {LaunchCountdown} from './LaunchCountdown';
import {AllocationsModal} from './ClaimPanel';
import {coinDestination} from './claim-view.mjs';
const Docs=lazy(()=>import('./Docs').then(m=>({default:m.Docs})));
const route=()=>({...(LOCAL_ADMIN?{admin:'Admin'}:{}),'shart-live':'PostLaunch','shart-preview':'PostLaunchPreview',shart:'Shart',docs:'Docs',launch:'Launch',vote:'Launch',submit:'Launch',archive:'Launch'}[location.hash.slice(1).split('/')[0]]||'Today');
function Modal({title,children,onClose}){
 const ref=useRef(null),previous=useRef(document.activeElement);
 useEffect(()=>{const dialog=ref.current;dialog.showModal();return()=>{dialog.close();previous.current?.focus();};},[]);
 return <dialog ref={ref} onCancel={e=>{e.preventDefault();onClose();}} aria-labelledby="dialog-title"><div className="dialog-head"><h2 id="dialog-title">{title}</h2><button onClick={onClose}>Close</button></div>{children}</dialog>;
}
export function App(){
 const [view,setView]=useState(route),[modal,setModal]=useState(null),[identity,setIdentity]=useState(null);
 const [service,setService]=useState('Loading local records…'),[serviceReady,setServiceReady]=useState(false);
 const [prelaunch,setPrelaunch]=useState(emptyPrelaunch),[coinProfile,setCoinProfile]=useState(null),[coinPosts,setCoinPosts]=useState([]);
 const revision=useRef(0),pending=useRef(null);
 // One served lifecycle for the whole site: the header link and the home row open the live coin page once the campaign has launched.
 const [launch,setLaunch]=useState(null);
 useEffect(()=>{let active=true;accountApi('prelaunch').then(d=>{if(active)setLaunch(d);}).catch(()=>{if(active)setLaunch({configured:false,unavailable:true});});return()=>{active=false;};},[identity?.owner]);
 function applyServer(state){setPrelaunch(state.prelaunch||emptyPrelaunch);setCoinProfile(state.coinProfile||null);setCoinPosts(state.coinPosts||[]);revision.current=state.revision;setServiceReady(true);setService('Saved locally');}
 async function refreshRecords(){try{const [preview,account]=await Promise.all([loadDemo(),accountApi('state')]);applyServer(preview);setIdentity(account);}catch(e){setServiceReady(false);setService(e.message);}}
 useEffect(()=>{refreshRecords();},[]);
 useEffect(()=>{function openHash(){setView(route());setModal(null);}window.addEventListener('hashchange',openHash);return()=>window.removeEventListener('hashchange',openHash);},[]);
 function go(next,sub){const destination=['Vote','Submit','Archive'].includes(next)?'Launch':next;setView(destination);setModal(null);history.replaceState(null,'',`#${destination==='PostLaunch'?'shart-live':destination==='PostLaunchPreview'?'shart-preview':destination.toLowerCase()}${sub?'/'+sub:''}`);window.scrollTo(0,0);}
 const goCoin=sub=>go(coinDestination(launch?.phase),sub);
 async function persist(action,payload={}){
  if(!serviceReady)throw Error('Local records are not connected. Refresh records to retry.');
  const content=JSON.stringify({action,payload});if(!pending.current||pending.current.content!==content)pending.current={content,input:{action,payload,revision:revision.current,requestId:crypto.randomUUID()}};
  try{const result=await saveDemo(pending.current.input);applyServer(result);pending.current=null;return result;}catch(e){if(e.message.includes('another tab')){pending.current=null;await refreshRecords();}throw e;}
 }
 return <><header><button className="brand" aria-label="KIDS home" onClick={()=>go('Today')}><img className="brand-integrated" src="/assets/kids-logo-integrated-v1.png" alt="kids.fun"/></button><nav aria-label="Main navigation">{['Today','Shart','Launch'].map(v=><button key={v} className={`${(view===v||(['PostLaunch','PostLaunchPreview'].includes(view)&&v==='Shart'))?'active ':''}${v==='Launch'?'launch-nav':''}`} onClick={()=>v==='Shart'?goCoin():go(v)}>{v==='Today'?'Explore':v==='Shart'?'Shartcoin':v}</button>)}<button onClick={()=>setModal('rules')}>Guide</button><button className={view==='Docs'?'active':''} aria-current={view==='Docs'?'page':undefined} onClick={()=>go('Docs','start')}>Docs</button>{LOCAL_ADMIN&&<button onClick={()=>go('Admin')}>Admin</button>}</nav><div className="account"><button onClick={()=>setModal('allocations')}><Users size={22}/> My allocations</button><button className="outlined" onClick={()=>setModal('wallet')}><Wallet size={22}/><span>{identity?.owner?identity.owner.slice(0,4)+'…'+identity.owner.slice(-4):'Sign in'}</span></button></div></header>
 <main>{view==='Docs'&&<Suspense fallback={<p className="small muted">Loading the guide…</p>}><Docs/></Suspense>}{['PostLaunch','PostLaunchPreview'].includes(view)&&<PostLaunch key={view} preview={view==='PostLaunchPreview'} identity={identity} onSignIn={()=>setModal('wallet')} profile={coinProfile} posts={coinPosts} go={go}/>}{LOCAL_ADMIN&&view==='Admin'&&<Suspense fallback={null}><Admin/></Suspense>}{view==='Launch'&&<LaunchCountdown go={go}/>}{view==='Shart'&&<Prelaunch identity={identity} onSignIn={()=>setModal('wallet')} state={prelaunch} service={service} onRefresh={refreshRecords} profile={coinProfile} posts={coinPosts} onAction={persist} ready={serviceReady} go={go}/>}{view==='Today'&&<Home open={type=>type==='shart'?goCoin():setModal(type)} go={go} launch={launch}/>}</main>
 <footer><span>KIDS &nbsp; // &nbsp; SOLANA &nbsp; // &nbsp; TWO COMMUNITIES. ONE KID.</span><button className="text-button" onClick={()=>setModal('rules')}>Launch rules</button><button className="text-button" onClick={()=>go('Docs','start')}>Docs</button><span>{SITE_NETWORK==='mainnet'?'Solana mainnet · Live':SITE_NETWORK==='devnet'?'Devnet · Rehearsal':'Localnet · Not live'}</span></footer>
 {modal&&<Modal title={{wallet:'Wallet account',allocations:'My allocations',rules:'Launch rules',kid:'Meet KIDS.'}[modal]||'KIDS'} onClose={()=>setModal(null)}>
 {modal==='wallet'&&<Account onChange={setIdentity}/>}
 {modal==='allocations'&&<AllocationsModal identity={identity} onSignIn={()=>setModal('wallet')} onOpen={()=>go('PostLaunch','claims')}/>}
 {modal==='kid'&&<><img className="kid-profile" src="/assets/kids-mutt-v4.png" alt="KIDS, the pink mutt mascot"/><p>KIDS is the platform mascot. Shartcoin is the first coin: Fartcoin × Buttcoin.</p><button className="primary" onClick={()=>go('Launch')}>Launch your kid</button></>}
 {modal==='rules'&&<><p>Two parent communities. One new coin.</p><dl><dt>Supply allocation</dt><dd>43.5% prelaunch · 43.5% liquidity · 10% parents · 3% dev.</dd><dt>Dev vesting</dt><dd>1% at launch; 2% linear over three months, no cliff.</dd><dt>Parent eligibility</dt><dd>Hold at least 0.05% of a parent’s supply at its snapshot. Each community receives 5%.</dd><dt>Opening pool</dt><dd>$40K soft cap · $200K hard cap. Half SOL, half the new coin. Excess commitments are refunded proportionally.</dd><dt>Trading</dt><dd>2% trading fee · Permanently locked liquidity with fee collection retained.</dd></dl><button className="primary" onClick={()=>go('Launch')}>Public launches</button></>}
 </Modal>}</>;
}
