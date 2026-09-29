import {CreatorOperations} from './CreatorOperations';
import {DirectoryPager} from './DirectoryPager';
import {solAmount,formatUtc} from './campaign-adapter.mjs';
import {Pfp} from './CoinMedia';
import {ExactAmount} from './ExactAmount';
import {ClaimsSummary} from './ClaimsSummary';
import {TransactionStatus} from './TransactionStatus';
const LIFECYCLE={scheduled:'Scheduled',open:'Funding',closed:'Closing',settling:'Launching',launching:'Launching',live:'Live',refund:'Failed',unavailable:'Unavailable'};
/**
 * MyLaunchesPage (spec §11): the creator's drafts, scheduled, funding, launching, live and failed campaigns.
 * Terms stay read-only. Wallet actions use verified positions and the shared
 * durable transaction flow; opening management never prepares a transaction.
 */
export function MyLaunchesPage({source,wallet,drafts=[],go,coinHref,onConnect,onResume,onNew,positions,onAction,busy=false,transaction,onCheck,accountError,onReadOperations}){
 if(!wallet)return <section className="pl" aria-labelledby="pl-mine-h"><div className="pl-head"><div><h1 id="pl-mine-h">My launches</h1><p>Drafts and campaigns created by your wallet.</p></div></div><div className="pl-panel pl-state"><h2>Connect a wallet</h2><p>Drafts and campaigns belong to the creator wallet that signed them.</p><button type="button" className="primary" onClick={onConnect}>Connect wallet</button></div></section>;
 const mine=(source.campaigns||[]).filter(vm=>vm.creator===wallet.address);
 return <section className="pl" aria-labelledby="pl-mine-h">
  <div className="pl-head"><div><h1 id="pl-mine-h">My launches</h1><p>Drafts and campaigns created by your wallet.</p></div><button type="button" className="primary" onClick={onNew||(()=>go('LaunchNew'))}>New launch</button></div>
  {drafts.length>0&&<><h2 className="pl-label">Drafts</h2><div className="pl-plist" style={{marginBottom:20}}>{drafts.map(d=><article className="pl-pitem" key={d.id}><Pfp src={d.pfp?.url&&!d.pfp.error?d.pfp.url:null} name={d.name} size={48}/><div className="pl-pitem-text"><span style={{fontSize:17,fontWeight:700}}>{d.name||'Untitled'} <span className="pl-muted">{d.symbol?'$'+d.symbol:''}</span> <span className="pl-pill is-muted" style={{marginLeft:6}}>{d.status==='creating'?'Setup in progress':'Draft'}</span></span><div className="pl-pitem-facts"><span>{d.mode==='family'?'Family':'Standard'}</span>{d.updatedAtUnix&&<span>Saved {formatUtc(d.updatedAtUnix)}</span>}</div></div><button type="button" className="pl-btn-sm pl-pitem-action" onClick={()=>onResume?.(d)}>Continue</button></article>)}</div></>}
  <h2 className="pl-label">Campaigns</h2>
  {transaction&&<TransactionStatus {...transaction} onPrimary={onCheck}/>}
  {accountError&&<p className="pl-error" role="alert">{accountError}</p>}
  {source.status==='loading'&&<p role="status">Loading your launches…</p>}
  {source.status==='error'&&<p role="alert">Launches could not be read. <button type="button" onClick={source.retry}>Retry</button></p>}
  {source.status==='ready'&&mine.length===0&&<div className="pl-panel pl-state"><h2>No campaigns yet</h2><p>Your first launch is one click and one wallet approval.</p><button type="button" onClick={onNew||(()=>go('LaunchNew'))}>Start a launch</button></div>}
  <div className="pl-plist">{mine.map(vm=><article className="pl-pitem" key={vm.id}><Pfp src={vm.media.pfp} name={vm.name} size={48}/><div className="pl-pitem-text"><a href={coinHref(vm.id)} onClick={e=>{e.preventDefault();go('Coin',vm.id);}}>{vm.name} <span className="pl-muted">{vm.symbol?'$'+vm.symbol:''}</span> <span className="pl-pill is-muted" style={{marginLeft:6}}>{LIFECYCLE[vm.phase]}</span></a><div className="pl-pitem-facts"><span>Committed <strong><ExactAmount amount={solAmount(vm.totals.committedLamports)}/></strong></span><span>Caps {solAmount(vm.terms.softLamports).compact} / {solAmount(vm.terms.hardLamports).compact} SOL</span>{vm.terms.deadlineUnix!=null&&<span>Closes {formatUtc(vm.terms.deadlineUnix)}</span>}</div></div><button type="button" className="pl-btn-sm pl-pitem-action" onClick={()=>go('Coin',vm.id)}>View</button>
   {onReadOperations&&vm.terms.version==='3'&&!wallet.fixture&&<CreatorOperations campaignId={vm.id} owner={wallet.address} onRead={onReadOperations}/>}
   {vm.terms.version==='3'&&!wallet.fixture&&<details className="pl-launch-manage"><summary>Manage funds</summary><ClaimsSummary vm={vm} position={positions?.[vm.id]} connected onClaim={onAction?action=>onAction(vm,action):null} busy={busy}/></details>}
  </article>)}</div>
  <DirectoryPager source={source}/>
 </section>;
}
