// Offline SDK evidence only. No RPC, wallet, signing, or transaction execution.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import BN from 'bn.js';
import {Curve,LaunchConstantProductCurve as CP} from '@raydium-io/raydium-sdk-v2';
const bn=n=>new BN(String(n)), zero=bn(0), S=bn('1000000000000000'), C=S.muln(55).divn(100), L=S.divn(10), R=bn(85000000000);
const init=CP.getInitParam({supply:S,totalSell:C,totalLockedAmount:L,totalFundRaising:R,migrateFee:zero});
const cases=[];
for(const raised of ['0','80000000000','84999999999','85000000000']) {
 const realB=bn(raised), realA=BN.min(C,CP.getAmountOut({amountIn:realB,inputReserve:init.b,outputReserve:init.a}));
 const poolInfo={virtualA:init.a,virtualB:init.b,realA,realB,totalSellA:C,totalFundRaisingB:R};
 for(const feeRate of [0,2500,10000])for(const gross of ['1000000000','10000000000','100000000000']) {
  const requested=bn(gross);
  const quote=Curve.buyExactIn({poolInfo,amountB:requested,protocolFeeRate:bn(feeRate),platformFeeRate:zero,shareFeeRate:zero,creatorFeeRate:zero,curveType:0,transferFeeConfigA:undefined,slot:0});
  const fees=quote.splitFee.platformFee.add(quote.splitFee.creatorFee).add(quote.splitFee.shareFee).add(quote.splitFee.protocolFee);
  assert(quote.amountA.amount.lte(C.sub(realA)),'sale cap exceeded');
  assert(quote.amountB.lte(requested),'charged more than requested');
  assert(quote.amountB.gte(fees),'negative net input');
  if(realA.eq(C)){assert(quote.amountA.amount.isZero());assert(quote.amountB.isZero());}
  cases.push({raisedRaw:raised,illustrativeFeeRateMillionths:feeRate,requestedRaw:gross,outputRaw:quote.amountA.amount.toString(),chargedRaw:quote.amountB.toString(),unusedInputRaw:requested.sub(quote.amountB).toString(),feeRaw:fees.toString(),netRaisedAfterRaw:realB.add(quote.amountB.sub(fees)).toString(),fillsSale:quote.amountA.amount.eq(C.sub(realA))});
 }
}
const report={status:'36 offline SDK quote cases passed; not transaction-simulated',sdk:'0.2.71-alpha',assumptions:['zero migration fee','no token transfer fees','illustrative protocol fee rates, not deployed configurations','near-target states derived from low-level curve and capped at sale allocation'],cases};
writeFileSync(new URL('./final-fill-results.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(report.status);
console.log(JSON.stringify(cases.filter(c=>c.raisedRaw==='80000000000' && c.requestedRaw==='10000000000'),null,2));
