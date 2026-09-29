/** Recipient-owned WSOL accounts can be closed by their wallet. The repair is
 * a separately approved, exact ATA creation paid by that recipient. */
export function FeePayoutRepair({payout,onRestore,busy=false}){
 if(!payout||payout.status==='ready'||payout.status==='awaiting-setup')return null;
 const missing=payout.status==='repair-required';
 return <div className="pl-claim-group pl-payout-repair">
  <h3>Fee payouts</h3>
  <p className="pl-claim-reason">{missing?'Your payout account was closed. Restore it to resume fee payments. Your unpaid share stays in program custody.':'Payout account status is unavailable. Refresh before restoring an account.'}</p>
  {missing&&<>
   <p className="pl-claim-reason">Your wallet pays the account rent and network fee.</p>
   <details className="pl-small"><summary>Account details</summary><span className="pl-mono">{payout.address}</span></details>
   <button type="button" className="pl-btn-sm" disabled={busy||!onRestore} onClick={onRestore}>{busy?'Transaction in progress':'Restore payout account'}</button>
  </>}
 </div>;
}
