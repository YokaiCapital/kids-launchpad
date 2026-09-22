# Atomic launch escrow v3

Local development program, separate from existing immutable v1/v2 campaigns. It is **upgradeable and not production-qualified**. Native Rust with pinned `solana-program = 2.3.0`.

## Launch transaction

Campaign terms bind the child mint, fixed one-billion-token supply at six decimals, dev, treasury, SOL caps and deadlines before commitments. Every registered receipt must settle before launch. Accepted amounts use proportional integer rounding; rounding surplus remains refundable.

Instruction 6 moves exactly the settled accepted SOL through the program's System-owned authority into WSOL, initializes the canonical 2% Raydium CPMM pool with 43.5% of supply, locks all issued LP in Burn & Earn, and revokes mint/freeze authorities in one transaction. The Fee Key NFT belongs to the campaign PDA. Setup rent and pool fees use separately sponsored funds. The campaign retains rent plus unpaid refunds. Phase 3 is written only after all postconditions pass.

Canonical programs, configuration, vaults, mint, ATA ownership, delegates and authority settings are checked. Donations to campaign, source WSOL and the predictable native pool vault cannot change participant acceptance or prevent launch. The funding System CPI includes both directly changed accounts so the runtime observes a balanced movement before wrapping SOL.

## Instructions and state

| Tag | Operation |
| --- | --- |
| 0 | Initialize fixed campaign terms |
| 1 | Commit SOL with per-wallet sequence |
| 2 | Finalize funding / recognize launch timeout |
| 3 | Pay receipt-bound refund, permissionless and idempotent |
| 4 | Settle a registered receipt once |
| 5 | Assert complete launch readiness |
| 6 | Create pool, lock LP and revoke authorities atomically |
| 7 | Claim participant allocation to receipt owner |
| 8 | Claim vested dev allocation to fixed dev |
| 9 | Bind immutable parent snapshot roots before commitments |
| 10 | Claim parent allocation with recipient-bound proof |
| 20 | Initialize fee accounting |
| 21 | Collect actual LP earnings using campaign Fee Key |
| 22 | Convert child fees to WSOL through campaign pool |
| 23 | Distribute cumulative treasury/dev shares; reserve parent budgets |
| 24 | Buy and burn one parent's pending budget atomically |

Campaign: 384 bytes, `KIDSESC3`. Receipt: 112 bytes, `KIDSREC3`. Builders and exact instruction account order: `localnet/atomic-launch.mjs`. Reproduction commands: `docs/LAUNCH-QUALIFICATION.md`.

## Claims and fee custody

The remaining supply funds participant claims (43.5%), parent A/B reserves (5% each), and dev allocation (3%). Dev vesting begins at actual successful launch: 1% immediately plus 2% linearly over three UTC calendar months. Parent claims require the 0.05% snapshot threshold and Merkle proofs bound to campaign, parent, owner, balance and allocation. Roots are immutable before commitments, but their historical-balance assertions still trust the publisher. Current circulating supply may fall through voluntary burns without invalidating original-supply entitlements.

The Fee Key remains with the campaign PDA. Separate `fee_authority` custody collects child/WSOL earnings, converts child fees to WSOL, and distributes actual realized proceeds cumulatively in weights 98:20:25:25/168. Parent spending and SPL burns are atomic; rounding dust remains reserved. Only the creator keeper can initiate fee actions, and fixed recipients/mints cannot be redirected. Parent pools are pinned to canonical CPMM index 2. Swaps require a positive minimum output, no more than 120 seconds of quote validity, and at least 98% of the execution-time spot quote. This is not oracle-based pricing or complete manipulation protection.

Fee state: 128 bytes, `KIDSFEE1`; parent state: 256 bytes, `KIDSPAR1`. Exact account/body layouts are in `localnet/atomic-claims.mjs` and `localnet/atomic-fees.mjs`.

## Verified and remaining

The combined localnet run passed 26 launch/claim checks and 9 fee checks against binary SHA-256 `e0b4051752422366e51ae6a5fe8eaeeeab773faa1448cec33a0990961c76e71d` (177,880 bytes). Tests include downstream launch rollback, claims and refund replay, custody substitution, donated-account handling, collection, conversion, routing and both parent burns. Runtime evidence remains under ignored `localnet/.runtime/`.

The active public UI still uses v1; this separate upgradeable development program is not a production deployment. No admin withdrawal or arbitrary CPI instruction exists. Upstream Burn & Earn is closed source; executable testing is not an audit or a production immutability guarantee. Independent review, application migration, verified token identities and production operational controls remain outstanding.
