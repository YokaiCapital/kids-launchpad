// Transport validation shared by the read service and browser. All amounts are exact base units.
export const FEE_FIELDS=Object.freeze(['solCollectedLamports','solPendingLamports','solDustLamports','treasuryPaidLamports','devPaidLamports','treasuryAccruedLamports','devAccruedLamports','coinCollectedBaseUnits','coinPendingBaseUnits','coinBurnedBaseUnits']);
export function validateFeeProjection(f){
 if(!f||!['verified','awaiting-setup','unavailable'].includes(f.status)||!Number.isSafeInteger(f.slot)||f.slot<1)throw Error('Invalid fee projection');
 if(f.status!=='verified')return;
 if(f.source!=='program-fee-state'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(f.feeState)||!/^\d{1,7}$/.test(f.poolTradeFeeRate)||Number(f.poolTradeFeeRate)<=0||Number(f.poolTradeFeeRate)>=1000000||FEE_FIELDS.some(k=>typeof f[k]!=='string'||!/^\d{1,20}$/.test(f[k])))throw Error('Invalid fee amounts');
 if(BigInt(f.solCollectedLamports)!==BigInt(f.solPendingLamports)+BigInt(f.treasuryPaidLamports)+BigInt(f.devPaidLamports)||BigInt(f.coinCollectedBaseUnits)!==BigInt(f.coinPendingBaseUnits)+BigInt(f.coinBurnedBaseUnits)||BigInt(f.treasuryPaidLamports)>BigInt(f.treasuryAccruedLamports)||BigInt(f.devPaidLamports)>BigInt(f.devAccruedLamports)||BigInt(f.solCollectedLamports)!==BigInt(f.treasuryAccruedLamports)+BigInt(f.devAccruedLamports)+BigInt(f.solDustLamports))throw Error('Fee projection does not conserve amounts');
}
