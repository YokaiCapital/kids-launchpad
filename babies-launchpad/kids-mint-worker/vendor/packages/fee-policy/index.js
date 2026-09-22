// Kids sets this policy. Creators choose a reward mint, never the fee allocation.
// The reward router enforces matching values in validate_bps.
export const KIDS_FEE_SPLITS = Object.freeze({
  holders: 8000,
  protocol: 2000,
});

// Off-chain payout policy. This does not change existing router/launch identities.
export const KIDS_PAYOUT_INTERVAL_MS = 5 * 60_000;
// Explicitly activated for NEW payout cycles only; never retrofit a receipt.
export const KIDS_HOLDER_ELIGIBILITY = Object.freeze({
  version: 1,
  minimumSupplyBps: 1,
  aggregation: "wallet-owner-all-token-accounts",
  snapshotCommitment: "finalized",
});
// Direct lane, 11 September 2026: a wallet qualifies when its combined balance
// is worth at least $20. The coin's price is this round's own tax sale
// (quote received per coin sold), and "$20 of the quote asset" is derived from
// the pair's admitted graduation target, so no price feed is consulted.
export const KIDS_HOLDER_VALUE_ELIGIBILITY = Object.freeze({
  version: 2,
  minimumHoldingUsd: "20",
  priceBasis: "round-conversion-realized-rate",
  anchorBasis: "pair-graduation-target-usd",
  aggregation: "wallet-owner-all-token-accounts",
  snapshotCommitment: "finalized",
});
export const KIDS_PAYOUT_POLICY = Object.freeze({
  version: 2,
  intervalMs: KIDS_PAYOUT_INTERVAL_MS,
  maxRecipientsPerBatch: 6,
  allocationBasis: "net-after-operating-costs",
  deferredRewards: "pooled-next-round",
});

const splitKeys = Object.keys(KIDS_FEE_SPLITS);
const denominator = 10_000n;

export function isKidsFeeSplit(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === splitKeys.length &&
    splitKeys.every((key) => Object.hasOwn(value, key) && value[key] === KIDS_FEE_SPLITS[key]);
}

/** Split actual fee base units, not trading volume. Rounding residue goes to holders. */
export function splitCreatorFees(gross) {
  if (typeof gross !== "bigint" || gross < 0n || gross > 18_446_744_073_709_551_615n) {
    throw new RangeError("Creator fees must be a nonnegative u64 bigint in base units.");
  }
  const protocol = gross * BigInt(KIDS_FEE_SPLITS.protocol) / denominator;
  return Object.freeze({
    holders: gross - protocol,
    protocol,
  });
}

function checkedAmount(value, label) {
  if (typeof value !== "bigint" || value < 0n || value > 18_446_744_073_709_551_615n) {
    throw new RangeError(`${label} must be a nonnegative u64 bigint.`);
  }
  return value;
}

/** Costs require independently finalized receipts at the caller. Future costs
 * are a separately disclosed reserve, NEVER represented as already spent.
 * Unused reserve returns to the next cycle before that cycle's 80/20 split. */
export function allocateNetCreatorFees({ gross, verifiedOperatingCosts, operatingReserve = 0n }) {
  checkedAmount(gross, "Gross creator fees");
  checkedAmount(verifiedOperatingCosts, "Verified operating costs");
  checkedAmount(operatingReserve, "Operating reserve");
  if (verifiedOperatingCosts + operatingReserve > gross) throw new RangeError("Operating costs and reserve exceed collected creator fees.");
  const netDistributable = gross - verifiedOperatingCosts - operatingReserve;
  return Object.freeze({ gross, verifiedOperatingCosts, operatingReserve, netDistributable, ...splitCreatorFees(netDistributable) });
}

/** No overrun or negative refund can silently consume holder/burn allocations. */
export function reconcileOperatingReserve(reserved, verifiedActualCost) {
  checkedAmount(reserved, "Operating reserve");
  checkedAmount(verifiedActualCost, "Verified actual operating cost");
  if (verifiedActualCost > reserved) throw new RangeError("Actual operating cost exceeds its immutable reserve.");
  return Object.freeze({ verifiedActualCost, carryToNextCycle: reserved - verifiedActualCost });
}
