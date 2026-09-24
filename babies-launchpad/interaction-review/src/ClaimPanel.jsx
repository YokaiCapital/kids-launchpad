import {useEffect,useState} from 'react';
import {ArrowRight} from '@phosphor-icons/react';
import {accountApi} from './Account';
import {ParentIcon} from './Parents';
import {formatUnits,formatSolAmount} from './flywheel-format.mjs';
import {formatUtc} from './launch-status.mjs';
import {remainingRaw,claimedAll,parentState,devSchedule,parentWindowFor,parentWindowNote} from './claim-view.mjs';
import {ParentClaimValue} from './ParentClaimValue';
import {parentStatsFor} from './valuation.mjs';
import {fetchMarket} from './market-data.mjs';
import {Help} from './Help';
const short=value=>value?`${value.slice(0,5)}…${value.slice(-5)}`:'';
const PARENTS=['Fartcoin','Buttcoin'];
function Row({label,icon,tag,amount,unit,note,state,children}){
 return <article className={'claim-row is-'+state}><div className="claim-row-head"><span className="claim-row-label">{icon}{label}</span>{tag&&<span className="claim-row-tag">{tag}</span>}</div>{amount!=null&&<strong className="claim-row-amount">{amount}{unit&&<small>{unit}</small>}</strong>}{note&&<p className="claim-row-note">{note}</p>}{children}</article>;
}
/**
 * The wallet's claims, in one list: prelaunch tokens and SOL refund, then each parent, then dev vesting.
 * `act(action)` claims on the coin page; when it is absent the panel is read-only (header modal) and `onOpen` leads
 * to the coin page. Amounts shown are what remains to claim, never the total entitlement.
 */
export function ClaimPanel({owner,claims,data,verified,loading,error,onSignIn,act,busy='',canClaim,reasonFor,onOpen,onRefresh,result,priceSol=null}){
 const decimals=Number.isInteger(data?.decimals)?data.decimals:6,readOnly=!act;
 if(!owner)return <div className="claim-panel claim-panel-empty"><p>Sign in to see what you can claim.</p><p className="claim-panel-sub">Prelaunch tokens, SOL refunds and parent rewards are read for the signed-in wallet only.</p><button className="primary" onClick={onSignIn}>Sign in</button></div>;
 if(loading||(!data&&!error))return <div className="claim-panel claim-panel-empty" aria-busy="true"><p>Checking claims for {short(owner)}…</p></div>;
 if(error||!verified)return <div className="claim-panel claim-panel-empty"><p>{error||'No launched campaign is connected.'}</p>{onRefresh&&<button className="outlined" onClick={onRefresh}>Refresh</button>}</div>;
 if(!claims)return <div className="claim-panel claim-panel-empty"><p>Your claims could not be read for {short(owner)}.</p>{onRefresh&&<button className="outlined" onClick={onRefresh}>Refresh</button>}</div>;
 const gated=!(claims.localClaimEnabled||claims.externalClaimEnabled);
 const button=(kind,index,label)=>{if(readOnly)return null;const enabled=canClaim(kind,index)&&!busy;return <button className="outlined claim-row-button" disabled={!enabled} onClick={()=>act(kind==='parent'?(index?'parentB':'parentA'):kind)}>{busy?'Confirming…':enabled?label:reasonFor(kind,index)||label}</button>;};
 const participantLeft=remainingRaw(claims.participant?.allocatedRaw,claims.participant?.claimedRaw),refundLeft=claims.refund?.claimableLamports??null;
 const participantState=claimedAll(claims.participant?.allocatedRaw,claims.participant?.claimedRaw)?'claimed':participantLeft&&BigInt(participantLeft)>0n?'open':'off';
 const refundState=refundLeft&&BigInt(refundLeft)>0n?'open':BigInt(claims.refund?.refundedLamports||0)>0n?'claimed':'off';
 const dev=devSchedule(claims,data);
 const windowNote=parentWindowNote(parentWindowFor(claims),decimals);
 return <div className="claim-panel">
  <div className="claim-panel-wallet"><span>Wallet</span><code title={owner}>{short(owner)}</code>{claims.campaign&&<code className="claim-panel-campaign" title={'Campaign '+claims.campaign}>Campaign {short(claims.campaign)}</code>}</div>
  {result&&<div className={'trade-feedback '+(result.ok?'is-ok':'is-problem')} role="status"><strong>{result.title}</strong>{result.detail&&<p>{result.detail}</p>}{result.technical&&<details><summary>{result.ok?'Transaction signature':'Technical details'}</summary><code>{result.technical}</code></details>}</div>}
  {gated&&<p className="post-claim-feedback">Claims are available to local test wallets only in this rehearsal.</p>}
  <h3 className="claim-group-title">Your allocation</h3>
  <Row label="Prelaunch tokens" state={participantState} amount={formatUnits(participantLeft,decimals,2)} unit="$Shartcoin left" note={participantState==='claimed'?'All claimed: these coins are in your wallet.':participantState==='off'?'No prelaunch allocation for this wallet.':`Allocated ${formatUnits(claims.participant.allocatedRaw,decimals,2)} · claimed ${formatUnits(claims.participant.claimedRaw,decimals,2)}. No deadline.`}>{button('participant',0,'Claim')}</Row>
  <Row label="SOL refund" state={refundState} amount={formatSolAmount(refundLeft).text} note={refundState==='claimed'?`${formatSolAmount(claims.refund.refundedLamports).text} refunded. Nothing left.`:refundState==='off'?'No refund due for this wallet.':`Excess over your accepted commitment. ${formatSolAmount(claims.refund.refundedLamports).text} refunded so far. No deadline.`}>{button('refund',0,'Claim refund')}</Row>
  <h3 className="claim-group-title">Parent rewards <small>5 % of supply each · either parent counts<Help label="Parent rewards">Wallets that held a parent at its snapshot get a share of that parent's Shartcoin pool. Holding either parent is enough; holding both gives a share of each.</Help></small></h3>
  {windowNote&&<p className={'claim-group-note'+(windowNote.closed?' is-closed':'')}><b>{windowNote.title}</b>{!windowNote.closed&&<time dateTime={new Date(windowNote.expiresAtUnix*1000).toISOString()}> · {new Date(windowNote.expiresAtUnix*1000).toLocaleString()} your time</time>}{windowNote.closed?' · ':'. '}{windowNote.detail}</p>}
  {PARENTS.map((name,index)=>{const row=claims.parents?.[index],p=parentState(row,claims.vault,decimals),stats=parentStatsFor(data,index);
   return <Row key={`${name}:${owner}:${claims.campaign||''}`} icon={<ParentIcon name={name}/>} label={name+' holders'} tag={p.state==='open'?'Eligible':p.state==='claimed'?'Claimed':p.state==='expired'?'Closed':p.state==='ineligible'?'Not eligible':'Unknown'} state={p.state==='ineligible'||p.state==='unknown'?'off':p.state} amount={p.state==='open'||p.state==='expired'?p.remainingText:null} unit={p.state==='open'||p.state==='expired'?'$Shartcoin left':null} note={p.note+(p.state==='open'&&row?.claimedRaw&&BigInt(row.claimedRaw)>0n?` Allocated ${formatUnits(row.allocationRaw,decimals,2)} · claimed ${formatUnits(row.claimedRaw,decimals,2)}.`:'')}>{p.state==='open'?button('parent',index,'Claim'):null}<ParentClaimValue name={name} stats={stats} row={row} state={p} decimals={decimals} priceSol={priceSol} data={data}/></Row>;})}
  <h3 className="claim-group-title">Dev vesting <small>3 % of supply · 1 % at launch, 2 % linear over three months</small></h3>
  <Row label="Dev allocation" state={dev.isDev&&dev.claimableRaw&&BigInt(dev.claimableRaw)>0n?'open':'off'} tag={dev.isDev?'Your wallet':null} amount={dev.remainingRaw!=null?formatUnits(dev.remainingRaw,decimals,2):null} unit={dev.remainingRaw!=null?'$Shartcoin left to vest':null}
   note={[dev.startUnix?'Starts '+formatUtc(dev.startUnix):null,dev.endUnix?'ends '+formatUtc(dev.endUnix):null].filter(Boolean).join(' · ')+(dev.totalRaw!=null?`. Total ${formatUnits(dev.totalRaw,decimals,2)}`:'')+(dev.claimedRaw!=null?` · claimed ${formatUnits(dev.claimedRaw,decimals,2)}`:dev.isDev?'':' · claimed and remaining are read from the dev wallet')+(dev.isDev&&dev.claimableRaw!=null?` · ${formatUnits(dev.claimableRaw,decimals,2)} claimable now`:'')+'.'+(dev.beneficiary?` Beneficiary ${short(dev.beneficiary)}${dev.isDev?' (you)':''}.`:'')}>
   {dev.isDev?button('dev',0,'Claim vested tokens'):null}
  </Row>
  {readOnly&&onOpen&&<button className="primary claim-panel-open" onClick={onOpen}>Claim on the coin page <ArrowRight size={18}/></button>}
 </div>;
}
/** Header "My allocations": the same served claims as the coin page, read for the signed-in wallet, read-only. */
export function AllocationsModal({identity,onSignIn,onOpen}){
 const owner=identity?.owner;
 const [snapshot,setSnapshot]=useState(null),[error,setError]=useState(''),[tick,setTick]=useState(0);
 useEffect(()=>{if(!owner){setSnapshot(null);return;}let active=true;setError('');setSnapshot(null);accountApi('postlaunch').then(data=>{if(active)setSnapshot({owner,data});}).catch(()=>{if(active)setError('Launch data is not connected.');});return()=>{active=false;};},[owner,tick]);
 const data=snapshot?.owner===owner?snapshot.data:null;
 const verified=data?.configured===true&&['localnet','devnet','mainnet'].includes(data.network)&&data.scope==='active-'+data.network&&typeof data.mint==='string'&&typeof data.pool==='string';
 const claims=verified&&data.claims?.owner===owner?data.claims:null;
 const [price,setPrice]=useState(null);
 useEffect(()=>{const campaign=verified?data.campaign:null;setPrice(null);if(!campaign)return;const controller=new AbortController();fetchMarket('summary',{campaign},{signal:controller.signal}).then(r=>{if(r.ok&&!controller.signal.aborted)setPrice(typeof r.data?.priceSol==='number'?r.data.priceSol:null);});return()=>controller.abort();},[verified,data?.campaign]);
 if(owner&&data&&!verified&&!error)return <div className="claim-panel claim-panel-empty"><p>Shartcoin has not launched yet, so there is nothing to claim.</p><p className="claim-panel-sub">Parent holders qualify by holding at least 0.05 % of a parent at its snapshot; claims open on the coin page after launch.</p></div>;
 return <ClaimPanel owner={owner} claims={claims} data={data} verified={verified} loading={!!owner&&!data&&!error} error={error} onSignIn={onSignIn} onOpen={onOpen} onRefresh={()=>setTick(n=>n+1)} priceSol={price}/>;
}
