import {RocketLaunch,ArrowRight} from '@phosphor-icons/react';
import {usePrelaunchChain} from './LocalPrelaunch';
import {LaunchStatus,OpensIn} from './LaunchStatus';
import './launch-countdown.css';
/** The Launch page: an honest availability state instead of a timer to a fixed date. Public launches (anyone pairing two
 * coins) are not open yet; the one live campaign, Shartcoin, is shown with its real status and a single next action. */
export function LaunchCountdown({go}){
 const chain=usePrelaunchChain(null),live=chain.data?.configured===true,preview=chain.data?.configured===false;
 return <section className="public-launch"><div className="launch-emblem"><RocketLaunch size={36}/></div><p className="eyebrow">YOUR PARENTS. YOUR COIN.</p>
  <h1>Public launches are not open yet.</h1>
  <p className="launch-lede">Soon anyone will pair two coins and launch their kid. Right now KIDS runs one launch, Shartcoin, and this is its live status.</p>
  {!live&&chain.data?.next?.opensAtUnix&&<div className="public-launch-opens"><p className="eyebrow">PUBLIC LAUNCH</p><OpensIn data={chain.data}/></div>}
  <div className="launch-page-status"><LaunchStatus data={live?chain.data:preview?{configured:false}:null} go={go} onRefresh={chain.refresh}/></div>
  {live&&chain.data.phase!=='launched'&&<button className="primary" onClick={()=>go?.('Shart')}>Go to Shartcoin <ArrowRight size={20}/></button>}
  <p className="small muted">{chain.error?'Live status unavailable right now. Refresh to try again.':'Status updates every few seconds from the ledger.'}</p>
 </section>;
}
