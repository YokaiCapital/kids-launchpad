// Design analysis only: no RPC, signing, transactions or changes to launch code.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(new URL('./qualification/package.json',import.meta.url));
const BN=require('bn.js');
const {LaunchConstantProductCurve:Curve}=require('@raydium-io/raydium-sdk-v2');
const S = new BN('1000000000000000'); // 1B tokens, six decimals
const C = S.muln(55).divn(100), M = S.muln(35).divn(100), L = S.divn(10);
const R = new BN('85000000000');
const args = {supply:S,totalSell:C,totalLockedAmount:L,totalFundRaising:R,migrateFee:new BN(0)};
const init = Curve.getInitParam(args);
const num = n => Number(n.toString());
const near = (a,b,t=1e-7) => assert(Math.abs(a-b)<t, `${a} != ${b}`);
const states = [0, 10, 25, 50, 75, 100].map(pct => {
 const realB = R.muln(pct).divn(100);
 const rawQuote = Curve.getAmountOut({amountIn:realB,inputReserve:init.b,outputReserve:init.a});
 // Low-level curve math can overquote the final fill due to integer init rounding.
 // Model the intended sale cap explicitly; chain enforcement remains a rollout gate.
 const overflowRaw = rawQuote.gt(C) ? rawQuote.sub(C) : new BN(0);
 const realA = BN.min(rawQuote,C);
 const poolInfo = {virtualA:init.a,virtualB:init.b,realA,realB};
 assert(realA.gte(new BN(0)) && realA.lte(C));
 if(pct) {
  const returned = Curve.sellExactIn({poolInfo,amount:realA});
  assert(returned.lte(realB));
  assert(realB.sub(returned).lten(2)); // raw SOL rounding, no fees
 }
 return {progressPercent:pct,netRaisedSOL:num(realB)/1e9,tokensSold:num(realA)/1e6,uncappedQuoteOverflowRaw:overflowRaw.toString(),spotSOLPerToken:Curve.getPoolPrice({poolInfo,decimalA:6,decimalB:9}).toNumber()};
});
near(states.at(-1).tokensSold,550000000,0.00001);
const end = Curve.getPoolEndPrice({...args,decimalA:6,decimalB:9}).toNumber();
near(states.at(-1).spotSOLPerToken,end,1e-15);
near(end,85/350000000,1e-15);
// Quote-side average execution premium relative to the pretrade spot, zero fees.
const buys = [85,170,340].flatMap(quote => [1,5,10].map(input => {
 const tokens = 350000000*input/(quote+input);
 const premium = (input/tokens/(quote/350000000)-1)*100;
 near(premium,input/quote*100);
 return {openingQuoteSOL:quote,buySOL:input,averagePricePremiumPercent:premium,tokenShortfallVersusSpotPercent:input/(quote+input)*100};
}));
const reserveSells = [0.25,0.5,1].map(fraction => {
 const tokens = 100000000*fraction, tokenPool=350000000, quote=85;
 const solOut=quote*tokens/(tokenPool+tokens);
 const remainingSOL=quote-solOut;
 const priceDrop=(1-(tokenPool/(tokenPool+tokens))**2)*100;
 assert(remainingSOL>0 && solOut<quote);
 return {fractionOfParentReserveSold:fraction,tokensSold:tokens,SOLReceived:solOut,remainingPoolSOL:remainingSOL,spotPriceDropPercent:priceDrop};
});
const feeSensitivity=[0,0.0025,0.01].map(fee=>{
 const gross=10,net=gross*(1-fee),out=350000000*net/(85+net);
 return {illustrativeInputFeePercent:fee*100,buySOL:gross,averageCostPremiumPercent:(gross/out/(85/350000000)-1)*100};
});
const floor=(supply)=> (supply*5n+9999n)/10000n;
assert.equal(floor(1000000000n),500000n);
assert.equal(floor(10001n),6n);
assert.equal(10000/5,2000);
assert.equal(C.add(M).add(L).toString(),S.toString());
console.log(JSON.stringify({status:'Design arithmetic passed; not chain-simulated',assumptions:['Zero migration fee and transfer tax','Full-range constant-product opening pool','Parent sells without intervening buying','Fees excluded except labeled sensitivity','No rent or priority fee included'],fixedPreset:{curvePercent:55,poolPercent:35,parentsPercent:10,raiseSOL:85,parentMinimumPercent:0.05},curveStates:states,openingPoolBuyScenarios:buys,parentReserveSellScenarios:reserveSells,illustrativeFeeSensitivity:feeSensitivity},null,2));
