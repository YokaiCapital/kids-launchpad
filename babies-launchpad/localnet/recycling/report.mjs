// node localnet/recycling/report.mjs > /tmp/kids-recycling-comparison.md
// Deterministic scenarios, not a quote, oracle, backtest, exact AMM emulator or price forecast.
import {readFileSync} from 'node:fs';
import {DAY,initialize,simulateStep,policyHash} from './model.mjs';
const manifest=JSON.parse(readFileSync(new URL('../../deployment/presets/standard-recycling-research-v1.json',import.meta.url)));
const originalSupply=1_000_000_000_000_000n;
const base={tokenReserve:485_000_000_000_000n,solReserve:100_000_000_000n,lpSupply:1_000_000_000_000n};
console.log('# Standard launch recycling: illustrative comparison\n');
console.log('Research only. No selected policy or activation. All accepted SOL initially enters one pool. LP units are split into permanent and temporary custody.\n');
console.log('Inputs: 1 billion tokens at 6 decimals; 48.5% in the pool; 100 SOL; arbitrary scaled LP-unit supply. No outside trades, liquidity changes, fee collections, donations, keeper costs or token extensions. These numbers are not forecasts.\n');
console.log('The 90-day sunset is exclusive: first execution after 24 hours, at most 89 executions before day 90. At sunset all remaining temporary LP is locked. Missed days do not accrue.\n');
console.log('| Permanent / temporary LP | Daily % of remaining temporary LP | Swap fee | Original LP recycled | Original total token supply burned | Final economic SOL reserve | Final spot / initial spot |');
console.log('|---|---|---|---|---|---|---|');
for(const p of manifest.candidatePolicies){
 for(const fee of [0n,25000n]){
  let state=initialize(base.lpSupply,1n,p),pool={...base,tradeFeePpm:fee,protocolFeeSharePpm:120000n,fundFeeSharePpm:40000n},burned=0n;
  for(let d=1;d<=p.durationDays;d++){
   const r=simulateStep(state,p,1n+BigInt(d)*DAY,pool);state=r.state;pool=r.pool;burned+=r.result?.burnedTokens??0n;
  }
  const pct=(n,d)=>(Number(n)/Number(d)*100).toFixed(4)+'%';
  const price=Number(pool.solReserve)*Number(base.tokenReserve)/(Number(base.solReserve)*Number(pool.tokenReserve));
  console.log(`| ${p.permanentLpBps/100}% / ${p.recyclableLpBps/100}% | ${p.dailyRemainingBps/100}% | ${Number(fee)/10000}% | ${pct(state.recycledLp,base.lpSupply)} | ${pct(burned,originalSupply)} | ${(Number(pool.solReserve)/1e9).toFixed(6)} | ${price.toFixed(6)}x |`);
 }
}
console.log('\nThe fee model rounds the input fee up and separately accrues protocol/fund shares. Raw SOL is returned, but economic reserves lose those external fee entitlements. Exact production-version Raydium parity is still required.\n');
console.log('Seller counterexample, no fees: 100M tokens / 100 SOL -> withdraw/burn/buy/burn 1% -> 98.01M / 100 SOL. A holder then sells 990,000 tokens for 1 SOL -> 99M / 99 SOL, restoring the initial price. Returned SOL is not protected from ordinary market selling.\n');
console.log('## Candidate policy hashes\n');
for(const p of manifest.candidatePolicies)console.log(`- ${p.permanentLpBps/100}% locked, ${p.dailyRemainingBps/100}% daily, ${p.durationDays} days: \`${policyHash(p)}\``);
