import {solAmount,tokenAmount,settleReceipt,participantTokens,participantReserve} from './campaign-adapter.mjs';
import {ExactAmount} from './ExactAmount';
import {DataFreshness} from './DataFreshness';
/**
 * PersonalPosition (spec §7): committed, accepted (estimated or final), excess refundable, tokens claimable and wallet
 * tokens, each a different quantity and never summed. Unknown values are an em dash with a reason, not zero.
 * `position` comes from GET /api/wallets/:wallet/positions; `onAction(kind)` is optional and never signs here.
 */
export function PersonalPosition({vm,position,connected=false,onAction}){
 if(!connected)return <section className="pl-panel" aria-label="Your position"><h3 className="pl-label">Your position</h3><p className="pl-small pl-muted">Connect a wallet to see your commitment, allocation and refunds for this coin.</p></section>;
 if(position===undefined||position?.eligibility==='unknown')return <section className="pl-panel" aria-label="Your position"><h3 className="pl-label">Your position</h3><p className="pl-small pl-muted">Your position could not be read. Nothing is assumed until it is.</p>{onAction&&<button type="button" className="pl-btn-sm" style={{marginTop:8}} onClick={()=>onAction('retry')}>Retry</button>}</section>;
 if(position===null)return <section className="pl-panel" aria-label="Your position"><h3 className="pl-label">Your position</h3><p className="pl-small pl-muted">No commitment from this wallet.</p></section>;
 const t=vm.terms,d=t.supply.decimals,sym=vm.symbol;
 const open=vm.phase==='open',settled=vm.totals.acceptedLamports!=null&&position.acceptedLamports!=null;
 const commit=position.commitLamports||'0';
 let accepted=position.acceptedLamports,excess=null,tokens=position.tokensBaseUnits,acceptedTag=null;
 if(settled){excess=String(BigInt(commit)-BigInt(accepted));acceptedTag='final';}
 else if(open){const s=settleReceipt({commitLamports:commit,totalCommittedLamports:vm.totals.committedLamports,hardLamports:t.hardLamports});accepted=s.acceptedLamports;excess=s.excessLamports;const A=BigInt(vm.totals.committedLamports)<BigInt(t.hardLamports)?vm.totals.committedLamports:t.hardLamports;tokens=participantTokens({acceptedLamports:accepted,totalAcceptedLamports:A,participantReserveBaseUnits:participantReserve(t.supply)});acceptedTag='estimated';}
 const refundable=excess!=null?BigInt(excess)-BigInt(position.refundedLamports||0):null;
 const claimable=tokens!=null?BigInt(tokens)-BigInt(position.claimedTokensBaseUnits||0):null;
 const dash=reason=><span className="pl-dash" title={reason}>— <small className="pl-muted">{reason}</small></span>;
 const rows=[
  ['Committed',<ExactAmount amount={solAmount(commit)}/>],
  ['Accepted',accepted!=null?<><ExactAmount amount={solAmount(accepted)}/><small className="pl-muted">{acceptedTag}</small></>:dash(vm.phase==='refund'?'no launch':'pending settlement')],
  ['Excess refundable',refundable!=null?<><ExactAmount amount={solAmount(refundable<0n?0n:refundable)}/>{acceptedTag==='estimated'&&<small className="pl-muted">estimated</small>}{onAction&&refundable>0n&&(vm.phase==='live'||vm.phase==='refund')&&<button type="button" className="pl-btn-sm" onClick={()=>onAction('refund')}>Claim refund</button>}</>:vm.phase==='refund'?<><ExactAmount amount={solAmount(BigInt(commit)-BigInt(position.refundedLamports||0))}/><small className="pl-muted">full refund</small>{onAction&&<button type="button" className="pl-btn-sm" onClick={()=>onAction('refund')}>Claim refund</button>}</>:dash('pending settlement')],
  ['Tokens claimable',vm.phase==='refund'?dash('no launch'):claimable!=null?<><ExactAmount amount={tokenAmount(claimable<0n?0n:claimable,d,sym)}/>{acceptedTag==='estimated'&&<small className="pl-muted">estimated</small>}{onAction&&claimable>0n&&vm.phase==='live'&&<button type="button" className="pl-btn-sm" onClick={()=>onAction('claim')}>Claim</button>}</>:dash('pending settlement')],
  ['Wallet tokens',position.walletTokensBaseUnits!=null?<><ExactAmount amount={tokenAmount(position.walletTokensBaseUnits,d,sym)}/>{position.walletTokensAsOfUnix!=null&&<DataFreshness fetchedAtUnix={position.walletTokensAsOfUnix} staleAfterSeconds={120}/>}</>:dash(vm.phase==='live'?'balance not read':'no token yet')],
 ];
 return <section className="pl-panel" aria-label="Your position">
  <div className="pl-panel-head"><h3 className="pl-label" style={{margin:0}}>Your position</h3>{acceptedTag==='estimated'&&<span className="pl-small pl-muted">Provisional until settlement</span>}</div>
  <div className="pl-position pl-rows">{rows.map(([k,v])=><div className="pl-row" key={k}><span>{k}</span><span>{v}</span></div>)}</div>
 </section>;
}
