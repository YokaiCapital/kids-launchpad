// Pure helpers for the launch status card: what to say in each phase and how to count down.
/** One canonical UTC rendering of a Unix time: '24 Sep 2026, 16:00 UTC'. Never the viewer's local zone. */
export function formatUtc(unix){
 const d=new Date(unix*1000);if(Number.isNaN(d.getTime()))return '';const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
 return d.getUTCDate()+' '+months[d.getUTCMonth()]+' '+d.getUTCFullYear()+', '+String(d.getUTCHours()).padStart(2,'0')+':'+String(d.getUTCMinutes()).padStart(2,'0')+' UTC';
}
/** Remaining time as days, hours, minutes and seconds; never negative (0 or below renders as 00:00). */
export function formatCountdown(seconds){
 const s=Math.max(0,Math.floor(seconds));const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60),sec=s%60,two=n=>String(n).padStart(2,'0');
 if(d>0)return d+'d '+two(h)+'h '+two(m)+'m '+two(sec)+'s';
 if(h>0)return two(h)+':'+two(m)+':'+two(sec);
 return two(m)+':'+two(sec);
}
export const solText=lamports=>{const n=Number(BigInt(lamports||0))/1e9;return n.toLocaleString('en-GB',{maximumFractionDigits:n<1?4:2});};
/** @param data readActive() output (or {configured:false}), @param nowUnix chain-aligned time in seconds */
export function describeLaunch(data,nowUnix){const live=data?.network==='mainnet';
 if(!data)return {phase:'loading',tone:'muted',pill:'Connecting',headline:'Loading launch status',sub:'Reading the ledger…',countdown:null,progress:null,addresses:null};
 if(data.configured!==true){
  const next=data.next||null,soft=BigInt(next?.terms?.soft||'100000000000'),hard=BigInt(next?.terms?.hard||'500000000000');
  const progress={raised:'0',soft:solText(soft),hard:solText(hard),pct:0,softPct:Math.min(100,Number(soft*10000n/hard)/100),reached:false};
  if(next?.opensAtUnix){const opensIn=next.opensAtUnix-nowUnix;return {phase:'scheduled',tone:'pending',pill:opensIn>0?'Opens soon':'Opening',headline:(next.coin||'The next launch')+(opensIn>0?' opens '+new Date(next.opensAtUnix*1000).toLocaleString():' is opening now'),sub:'Commitments start when the clock reaches zero. Soft cap '+progress.soft+' SOL, hard cap '+progress.hard+' SOL, '+Math.round((next.terms?.deadlineSeconds||86400)/3600)+' hours to commit.',countdown:{label:'Opens in',seconds:opensIn,at:next.opensAtUnix},progress,addresses:null};}
  return {phase:'unscheduled',tone:'muted',pill:'Not open yet',headline:next?(next.coin||'The next launch')+': opening date to be announced':'No launch is open right now',sub:next?'Planned terms: soft cap '+progress.soft+' SOL, hard cap '+progress.hard+' SOL, '+Math.round((next.terms?.deadlineSeconds||86400)/3600)+' hours to commit. The date will appear here first.':'When the next launch opens, the countdown and the commit box appear here.',countdown:null,progress:next?progress:null,addresses:null};
 }
 const total=BigInt(data.totalLamports||0),soft=BigInt(data.softCapLamports||1),hard=BigInt(data.hardCapLamports||soft),reached=total>=soft;
 const subscribed=Number(total*10000n/hard)/100,full=total>=hard;
 const progress={raised:solText(total),soft:solText(soft),hard:solText(hard),pct:Math.min(100,subscribed),subscribed,full,softPct:Math.min(100,Number(soft*10000n/hard)/100),reached};
 const closeIn=data.deadlineUnix-nowUnix,launchWindowIn=data.launchDeadlineUnix-nowUnix;
 if(data.phase==='open')return {phase:'open',tone:'live',pill:'Open',headline:full?'Hard cap reached. You can still commit.':reached?'Soft cap reached. Still open.':'Open for commitments',sub:full?'Allocation is proportional: every wallet gets the same share of the coin per accepted SOL. Only '+progress.hard+' SOL goes into the pool; the rest is refunded to everyone pro rata after the close. Committing now still earns a share, at the same rate as everyone else.':reached?'Up to the hard cap of '+progress.hard+' SOL, committed SOL joins the pool at launch. Anything above the hard cap is refunded pro rata after the close.':'Reach '+progress.soft+' SOL before the clock runs out and the coin launches by itself.',countdown:{label:'Closes in',seconds:closeIn,at:data.deadlineUnix},progress,addresses:null};
 if(data.phase==='awaiting-launch')return {phase:'awaiting-launch',tone:'pending',pill:'Launching',headline:'Funding closed. Launching now.',sub:'Every commitment is being settled, then the pool is created and locked. This usually takes under a minute. If the launch could not happen within 24 hours, every commitment would be refunded in full.',countdown:null,progress,addresses:null};
 if(data.phase==='failed')return {phase:'failed',tone:'problem',pill:'Not launched',headline:'This launch did not happen',sub:(reached?'The launch window closed before the pool was created.':'Only '+progress.raised+' of the '+progress.soft+' SOL soft cap was committed.')+' Every commitment is refunded in full. If you took part, claim your refund below.',countdown:null,progress,addresses:null};
 if(data.phase==='launched'){
  // Completed-launch stats: only what the API served. Pool liquidity, lock state and the launch signature are not served, so they are not shown.
  const count=v=>/^\d+$/.test(String(v??''))?String(v):null,receipts=count(data.receiptCount),settled=count(data.settledReceiptCount);
  const stats=[{label:'Raised',value:progress.raised,unit:'SOL'},receipts&&{label:'Commitments',value:Number(receipts).toLocaleString('en-GB')},receipts&&settled&&{label:'Settled',value:Number(settled).toLocaleString('en-GB'),unit:'of '+Number(receipts).toLocaleString('en-GB')}].filter(Boolean);
  return {phase:'launched',tone:'ok',pill:'Live',headline:'Shartcoin is live',sub:'The pool is created. Claims and trading are on the coin page.',countdown:null,progress,stats,addresses:[{label:'Coin address',value:data.mint},{label:'Pool',value:data.pool},{label:'Escrow',value:data.escrowAddress}].filter(a=>a.value),explorerUrl:data.explorerUrl||null};
 }
 return {phase:data.phase,tone:'muted',pill:data.phase,headline:'Launch status: '+data.phase,sub:'',countdown:null,progress,addresses:null};
}
