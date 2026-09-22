# Offline final-fill qualification — 19 September 2026

Status: SDK quote behavior tested; transaction and migration qualification still open. No RPC, keys, wallet, signing, funding or deployment was used.

Reproduce: run `npm ci` in this directory, then `npm test` and `npm run test:baseline`. SDK pinned to `@raydium-io/raydium-sdk-v2@0.2.71-alpha` with a lockfile. The parent arithmetic script now resolves this isolated installation; prototype dependencies are unchanged.

36 cases cover initial state, 80 SOL raised, one lamport before 85 SOL, and the exhausted allocation; 1/10/100 SOL requested inputs; illustrative 0/0.25/1% protocol fees. Assertions check the 55% sale cap, charged input no greater than requested, nonnegative net input, and zero charge/output after exhaustion. Results are in `final-fill-results.json`. Original arithmetic also passes (`baseline-results.json`).

At 80 SOL raised, requesting a 10 SOL buy yields the remaining 21,038,251.363766 tokens. The SDK quotes 5 SOL charged with zero fees, 5.012531329 SOL with the illustrative 0.25% fee, or 5.050505051 SOL at 1%. Each reaches 85 SOL net. Unused input is a quote difference, **not proof of an on-chain refund**.

The high-level `Curve.buyExactIn` caps output at remaining inventory and recomputes required input via exact-output math. That closes the offline cap question left by the low-level 0.002499-token overquote. It does not establish actual program enforcement, transaction behavior, migration fees, LP custody, or reserve funding. A synthetic exhausted state returning zero also does not prove that a real post-graduation instruction will succeed.

Primary source: [Raydium Curve implementation](https://github.com/raydium-io/raydium-sdk-V2/blob/master/src/raydium/launchpad/curve/curve.ts). Checked against the installed pinned package source. Fee rates are sensitivity assumptions; no deployed configuration is qualified.

## Mainnet configuration read and allocation rehearsal

`npm run check:chain` reads the advertised SOL configuration, verifies its owner is the SDK's LaunchLab program, decodes its account at finalized commitment and checks API agreement plus preset bounds. Recorded slot: 448531652, account 6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX. It showed 0.25% protocol trading fee and zero migration fee. These are global-config observations, not kid.fun's total fee or post-migration trading fee. Platform/creator/share fees, fee beneficiaries and LP allocation require a selected platform configuration. Result: `chain-config-results.json`, including raw account bytes for reproducibility.

`npm run test:allocations` uses the existing repository allocation and Merkle code with two synthetic 2,000-owner snapshots, 0.05% eligibility and the inherited 2% per-owner allocation cap. It checks conservation of the full 100M-token parent allocation, all 4,000 recipient proofs, rejection of an altered amount and input-order invariance. Result: `allocation-results.json`. This is not a live snapshot or funded claim. It records the exact Merkle source hash and resolves its dependencies from this isolated package; production source is not changed. Node25's TypeScript stripping is used. A funded distributor, on-chain proof execution and actual claim delivery remain untested.

The offline SDK dependency tree has npm audit findings (7 moderate, 4 high as of this run). It is not imported into the browser or deployed. Production dependency qualification remains required; no forced dependency upgrades were applied to the existing project.

**Blocking inputs for transaction qualification:** kid.fun platform account and beneficiaries, LP burn/lock/ownership policy, reserve recipient/unlock arrangement, and actual launch/distributor accounts. No existing account has been silently adopted and no mainnet accounts were created. Until these exist, a successful real launch/graduation/claim rehearsal cannot be reported.
