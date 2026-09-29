// The 168 bps LP portion of the 200 bps swap fee; protocol/fund keep 32 bps.
// Apply these weights to ACTUAL collected LP earnings, separately per asset.
export const FEE_DISTRIBUTION = Object.freeze({
 basis:'collected-lp-fees', denominator:168,
 treasuryWeight:98, devWeight:20, parentAWeight:25, parentBWeight:25,
 parentAction:'buy-and-burn',
});
// Cumulative entitlements prevent repeated small collections from biasing payouts.
// Unassigned raw units remain in custody; never charge dust to a parent budget.
export function lpRevenueEntitlements(totalCollected){
 if(typeof totalCollected!=='bigint'||totalCollected<0n)throw Error('Collected fees must be nonnegative raw-unit bigint');
 const result={treasury:totalCollected*98n/168n,dev:totalCollected*20n/168n,parentA:totalCollected*25n/168n,parentB:totalCollected*25n/168n};
 return {...result,reservedDust:totalCollected-Object.values(result).reduce((a,b)=>a+b,0n)};
}
export function lpRevenueDelta(previousCollected,totalCollected){
 if(typeof previousCollected!=='bigint'||previousCollected<0n||previousCollected>totalCollected)throw Error('Cumulative collected fees cannot decrease');
 const before=lpRevenueEntitlements(previousCollected),after=lpRevenueEntitlements(totalCollected);
 return {treasury:after.treasury-before.treasury,dev:after.dev-before.dev,parentA:after.parentA-before.parentA,parentB:after.parentB-before.parentB,reservedDust:after.reservedDust};
}
export function resolveFeeDistribution(value){
 const legacy=value&&Object.keys(value).length===2&&value.devBps===5000&&value.platformBps===5000;
 return value==null||legacy?FEE_DISTRIBUTION:value;
}
