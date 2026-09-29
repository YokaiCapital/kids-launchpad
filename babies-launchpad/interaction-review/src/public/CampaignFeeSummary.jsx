import {Help} from '../Help';
import {ExactAmount,CopyButton} from './ExactAmount';
import {solAmount,tokenAmount,shortAddress} from './campaign-adapter.mjs';
import {relativeTime} from '../market-data.mjs';
/** Cumulative finalized counters, independently readable when trade history has gaps. */
export function CampaignFeeSummary({vm,state,now=Date.now(),onRetry}){
 const data=state.data,f=data?.fees,verified=f?.status==='verified';
 const stale=!!state.error||!!data?.freshness?.stale||!Number.isSafeInteger(f?.updatedAt)||now-f.updatedAt>30000||f.updatedAt>now+5000;
 const coin=raw=>tokenAmount(raw,vm.terms.supply.decimals,vm.symbol?'$'+vm.symbol:'coins');
 return <section className="pl-fees" aria-label="Collected fees and burns">
  <div className="pl-panel-head"><h3 className="pl-label">Fees & burns <Help label="Collected fees">Finalized fees received from this launch’s locked LP position. These are cumulative amounts, not trading volume or fees still waiting to be collected from the pool.</Help></h3><span className="pl-small pl-muted">{verified?(stale?'Data is stale':relativeTime(Math.floor(f.updatedAt/1000),Math.floor(now/1000))):''}</span></div>
  {!verified?<p className="pl-small pl-muted" role="status">{state.loading&&!data?'Loading fee counters…':state.error||f?.status==='unavailable'?'Fee counters are unavailable.':f?.status==='awaiting-setup'?'Fee collection is being set up.':'Fee counters are being indexed.'} {state.error&&<button type="button" className="pl-btn-sm" onClick={onRetry}>Retry fees</button>}</p>:<>
   <div className="pl-fee-grid">
    <div><span>SOL collected</span><strong><ExactAmount amount={solAmount(f.solCollectedLamports)}/></strong></div>
    <div><span>Coin fees collected <Help label="Coin fees collected">Includes tokens already burned and tokens held by the fee program awaiting a burn. Collection alone does not mean a burn has happened.</Help></span><strong><ExactAmount amount={coin(f.coinCollectedBaseUnits)} unit={false}/></strong><small>{vm.symbol?'$'+vm.symbol:'coins'}</small></div>
    <div><span>Burned</span><strong><ExactAmount amount={coin(f.coinBurnedBaseUnits)} unit={false}/></strong><small><ExactAmount amount={coin(f.coinPendingBaseUnits)} unit={false}/> awaiting burn</small></div>
   </div>
   <p className="pl-help-text">{Number(f.poolTradeFeeRate)/10000}% pool trading fee. Collected coin-side fees are burned, never sold. SOL-side fees follow this launch’s sealed routing.</p>
   <details className="pl-fee-details"><summary>Where the SOL goes</summary><div className="pl-rows">
    <div className="pl-row"><span>KIDS treasury paid</span><ExactAmount amount={solAmount(f.treasuryPaidLamports)}/></div>
    <div className="pl-row"><span>Dev paid</span><ExactAmount amount={solAmount(f.devPaidLamports)}/></div>
    <div className="pl-row"><span>Still in fee custody <Help label="Still in fee custody">Collected SOL not yet distributed, including rounding dust. It is separate from commitments and refundable SOL.</Help></span><ExactAmount amount={solAmount(f.solPendingLamports)}/></div>
    <div className="pl-row"><span>Treasury / dev accrued</span><span><ExactAmount amount={solAmount(f.treasuryAccruedLamports)}/> / <ExactAmount amount={solAmount(f.devAccruedLamports)}/></span></div>
    <div className="pl-row"><span>Finalized fee account · slot {f.slot.toLocaleString('en-GB')}</span><span className="pl-mono">{shortAddress(f.feeState)}<CopyButton value={f.feeState} label="fee account"/></span></div>
    <div className="pl-row"><span>Rounding dust in custody</span><ExactAmount amount={solAmount(f.solDustLamports)}/></div>
   </div></details>
  </>}
 </section>;
}
