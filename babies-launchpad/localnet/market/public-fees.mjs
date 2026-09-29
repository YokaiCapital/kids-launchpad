// Finalized Standard v3 fee counters. Never infer collected fees by summing a
// partial activity page, or confuse uncollected LP earnings with custody totals.
import * as client from '../protocol-v2/client.mjs';
import {feeEntitlements} from '../protocol-v2/policy.mjs';
import {validateFeeProjection} from '../../shared/fee-projection.mjs';
export {FEE_FIELDS,validateFeeProjection} from '../../shared/fee-projection.mjs';
export function projectStandardFees({account,programId,campaign,terms,slot}){
 if(terms.mode!==0||!Number.isSafeInteger(slot)||slot<1)throw Error('Verified Standard fee scope required');
 const base={status:'awaiting-setup',slot,feeState:String(client.feeStateAddress(programId,campaign)),poolTradeFeeRate:String(terms.ammTradeFeeRate),source:'program-fee-state'};
 if(account===null)return base;
 if(!account||account.owner!==String(programId)||account.executable||account.data?.[1]!=='base64')throw Error('Fee state identity mismatch');
 const f=client.decodeFeeState(Buffer.from(account.data[0],'base64'),campaign),entitled=feeEntitlements(f.solCollected,terms.feeWeights);
 if([...f.parentAllocated,...f.parentSpent,...f.parentBurned].some(n=>n!==0n)||f.treasuryPaid>entitled.treasury||f.devPaid>entitled.dev||f.coinPending+f.coinBurned>terms.supply)throw Error('Fee counters do not conserve sealed entitlements');
 const pending=f.solCollected-f.treasuryPaid-f.devPaid;if(pending<0n)throw Error('Fee liability is negative');
 const projection={...base,status:'verified',solCollectedLamports:String(f.solCollected),solPendingLamports:String(pending),solDustLamports:String(entitled.dust),treasuryPaidLamports:String(f.treasuryPaid),devPaidLamports:String(f.devPaid),treasuryAccruedLamports:String(entitled.treasury),devAccruedLamports:String(entitled.dev),coinCollectedBaseUnits:String(f.coinPending+f.coinBurned),coinPendingBaseUnits:String(f.coinPending),coinBurnedBaseUnits:String(f.coinBurned)};
 validateFeeProjection(projection);return projection;
}
