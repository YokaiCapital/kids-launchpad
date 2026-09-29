// Finalized data has expected consensus latency. This bound detects a stalled
// provider, not trade inactivity: a pool can have no trades while the chain advances.
export const MAX_PROVIDER_HEAD_AGE_MS = 120000;
export const MAX_PROVIDER_CLOCK_LEAD_MS = 30000;
export function providerFreshness(head,now) {
  const valid=Number.isSafeInteger(head?.slot)&&head.slot>0&&Number.isSafeInteger(head?.time)&&head.time>0;
  const delta=valid?now-head.time*1000:null;
  return {verified:valid,slot:valid?head.slot:null,ageMs:valid?Math.max(0,delta):null,
    stale:!valid||delta>MAX_PROVIDER_HEAD_AGE_MS||delta< -MAX_PROVIDER_CLOCK_LEAD_MS};
}
