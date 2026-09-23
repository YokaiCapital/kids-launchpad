// Pure helpers for the launch status card: what to say in each phase and how to count down.
export function formatCountdown(seconds){
 const s=Math.max(0,Math.floor(seconds));const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60),sec=s%60,two=n=>String(n).padStart(2,'0');
 if(d>0)return d+'d '+two(h)+'h '+two(m)+'m';
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
 const progress={raised:solText(total),soft:solText(soft),hard:solText(hard),pct:Math.min(100,Number(total*10000n/hard)/100),softPct:Math.min(100,Number(soft*10000n/hard)/100),reached};
 const closeIn=data.deadlineUnix-nowUnix,launchWindowIn=data.launchDeadlineUnix-nowUnix;
 if(data.phase==='open')return {phase:'open',tone:'live',pill:'Open',headline:reached?'Soft cap reached. Still open.':'Open for commitments',sub:reached?'Every SOL committed now joins the pool at launch, up to the hard cap of '+progress.hard+' SOL.':'Reach '+progress.soft+' SOL before the clock runs out and the coin launches by itself.',countdown:{label:'Closes in',seconds:closeIn,at:data.deadlineUnix},progress,addresses:null};
 if(data.phase==='awaiting-launch')return {phase:'awaiting-launch',tone:'pending',pill:'Launching',headline:'Funding closed. Launch in progress.',sub:'The keeper settles every commitment, then creates and locks the pool. This usually takes under a minute.',countdown:{label:'Launch window ends in',seconds:launchWindowIn,at:data.launchDeadlineUnix},progress,addresses:null};
 if(data.phase==='failed')return {phase:'failed',tone:'problem',pill:'Not launched',headline:'This launch did not happen',sub:(reached?'The launch window closed before the pool was created.':'Only '+progress.raised+' of the '+progress.soft+' SOL soft cap was committed.')+' Every commitment is refunded in full. If you took part, claim your refund below.',countdown:null,progress,addresses:null};
 if(data.phase==='launched')return {phase:'launched',tone:'ok',pill:'Live',headline:'Shartcoin is live',sub:'The pool is created and the liquidity is locked. Claim your coins and trade on the coin page.',countdown:null,progress,addresses:[{label:'Coin address',value:data.mint},{label:'Pool',value:data.pool},{label:'Escrow',value:data.escrowAddress}].filter(a=>a.value),explorerUrl:data.explorerUrl||null};
 return {phase:data.phase,tone:'muted',pill:data.phase,headline:'Launch status: '+data.phase,sub:'',countdown:null,progress,addresses:null};
}
