import {FEE_DISTRIBUTION,resolveFeeDistribution} from './fee-distribution.mjs';
// Approved launch policy. Mainnet reference is metadata, never a localnet account.
export const POOL_POLICY = Object.freeze({
 provider: 'raydium-cpmm', quoteSymbol: 'SOL', tradeFeeBps: 200, // localnet clone tier; new mainnet pools use 250 (owner decision 23 Sep 2026)
 approvedTiers: [{ index: 2, tradeFeeBps: 200, address: '2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5' }, { index: 7, tradeFeeBps: 250, address: 'ESLj2Rzmvn3RhDo4Z18hY1wYmGyC9xM4ZtRXhvoFkDAi' }],
 protocolShareBps: 1200, fundShareBps: 400,
 creatorFeeEnabled: false, tokenTransferFeeBps: 0,
 liquidityPolicy: 'permanent-lock-retain-fees',
 mainnetConfigIndex: 2,
 mainnetConfigAddress: '2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5',
 localnetConfigAddress: null,
 revenueSplit: FEE_DISTRIBUTION,
});
export function withLaunchPolicy(config) {
 if (!config) return config;
 return {...config, launch: {...config.launch,
  softPoolUsd: config.launch.softPoolUsd ?? 40000,
  prelaunchShareBps: config.launch.prelaunchShareBps ?? 4350,
  liquidityShareBps: config.launch.liquidityShareBps ?? 4350,
  devShareBps: config.launch.devShareBps ?? 300,
  devUnlockBps: config.launch.devUnlockBps ?? 100,
  devVestedBps: config.launch.devVestedBps ?? 200,
  devVestingMonths: config.launch.devVestingMonths ?? 3,
  devCliffSeconds: config.launch.devCliffSeconds ?? 0,
  revokeMintAuthority: config.launch.revokeMintAuthority ?? true, revokeFreezeAuthority: config.launch.revokeFreezeAuthority ?? true,
  pool: {...POOL_POLICY, ...config.launch.pool, revenueSplit: resolveFeeDistribution(config.launch.pool?.revenueSplit)},
 }};
}
export function validateLaunchPolicy(launch) {
 if (launch.prelaunchShareBps !== 4350 || launch.liquidityShareBps !== 4350 || launch.parentShareBps !== 1000 || launch.devShareBps !== 300)
  throw Error('Supply allocation must remain 43.5% prelaunch / 43.5% liquidity / 10% parents / 3% dev');
 if (launch.devUnlockBps !== 100 || launch.devVestedBps !== 200 || launch.devVestingMonths !== 3 || launch.devCliffSeconds !== 0)
  throw Error('Dev allocation: 1% of total supply at launch, 2% linear over 3 months, no cliff');
 for (const [key, value] of Object.entries(POOL_POLICY)) {
  if (JSON.stringify(launch.pool[key]) !== JSON.stringify(value))
   throw Error('Keep the approved Raydium 2% pool policy; deployment and revenue split require separate configuration');
 }
 if (!launch.revokeMintAuthority || !launch.revokeFreezeAuthority) throw Error('Mint and freeze authorities must be revoked at launch');
}
