// An unsigned message may have been signed and sent directly by its wallet.
// Expiry proves it cannot execute later, never that it did not already execute.
export function escrowIntentRetry({proof,signature,status,finalizedExpired=false}){
 if(proof?.kind==='finalized-expiry')throw Error('Request expired. Refresh balances and use a fresh request ID; the previous message may already have executed.');
 if(proof?.kind==='finalized-failure'||status?.err&&status.confirmationStatus==='finalized')return 'renew-failed';
 if(finalizedExpired&&!status){
  if(signature)throw Error('Previous transaction outcome is unresolved. Retain this request ID and reconcile its signature before another commitment.');
  throw Error('Request expired. Refresh balances and use a fresh request ID; the previous message may already have executed.');
 }
 return 'retain';
}
