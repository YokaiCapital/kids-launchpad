# Atomic launch escrow v3

Local development program, separate from existing immutable v1/v2 campaigns. It is **upgradeable and not production-qualified**. Native Rust with pinned `solana-program = 2.3.0`.

## Launch transaction

Campaign terms bind the child mint, fixed one-billion-token supply at six decimals, dev, treasury, SOL caps and deadlines before commitments. Every registered receipt must settle before launch. Accepted amounts use proportional integer rounding; rounding surplus remains refundable.

Instruction 6 moves exactly the settled accepted SOL through the program's System-owned authority into WSOL, initializes the canonical 2% Raydium CPMM pool with 43.5% of supply, locks all issued LP in Burn & Earn, and revokes mint/freeze authorities in one transaction. The Fee Key NFT belongs to the campaign PDA. Setup rent and pool fees use separately sponsored funds. The campaign retains rent plus unpaid refunds. Phase 3 is written only after all postconditions pass.

Canonical programs, configuration, vaults, mint, ATA ownership, delegates and authority settings are checked. Donations to campaign, source WSOL and the predictable native pool vault cannot change participant acceptance or prevent launch. The funding System CPI includes both directly changed accounts so the runtime observes a balanced movement before wrapping SOL.

## Instructions and state

| Tag | Operation |
| --- | --- |
| 0 | Initialize fixed campaign terms; an optional fourth account records the distribution program |
| 1 | Commit SOL with per-wallet sequence |
| 2 | Finalize funding / recognize launch timeout |
| 3 | Pay receipt-bound refund, permissionless and idempotent |
| 4 | Settle a registered receipt once |
| 5 | Assert complete launch readiness |
| 6 | Create pool, lock LP and revoke authorities atomically; with a recorded distribution program, fund the four claim vaults and activate it in the same instruction |
| 7 | Claim participant allocation to receipt owner (custody claims; error 40 once a distribution is activated) |
| 8 | Claim vested dev allocation to fixed dev (custody claims; error 40 once a distribution is activated) |
| 9 | Bind immutable parent snapshot roots before commitments |
| 10 | Claim parent allocation with recipient-bound proof within 30 days of the launch (custody claims; error 40 once a distribution is activated; error 45 after the window) |
| 11 | Burn the unclaimed rest of both parent reserves once the 30-day window has closed; permissionless and idempotent (error 46 while the window is open) |
| 20 | Initialize fee accounting |
| 21 | Collect actual LP earnings using campaign Fee Key |
| 23 | Distribute cumulative treasury/dev shares; reserve the two parent budgets |
| 26 | Burn coin-side fees held in custody |
| 27 | Buy the coin with a slice of the parent budgets (0.5 SOL at most) through the campaign's own pool and burn it |
| 22, 24, 25 | Retired (sell coin fees; buy and burn a parent through the canonical pool or Jupiter): refused with InvalidInstructionData |

Campaign: 384 bytes, `KIDSESC3`. Receipt: 112 bytes, `KIDSREC3`. Builders and exact instruction account order: `localnet/atomic-launch.mjs`. Reproduction commands: `docs/LAUNCH-QUALIFICATION.md`.

The campaign records the distribution program at offset 312 (32 bytes, all zero when none) and the activation flag at offset 344 (1 byte, written by tag 6). The full layout is listed next to `OFF_DISTRIBUTION_PROGRAM` in `src/lib.rs`.

## Claim vaults

A campaign created with the distribution program (`programs/kids-distribution`) as the fourth account of tag 0 pays no claims from launch custody. Tag 6 then takes 40 accounts instead of 29: the 29 pool and lock accounts, then 29 the distribution program, 30 the parents PDA, 31 the distribution PDA, 32 to 35 the four vault authorities and 36 to 39 the four vault associated token accounts. The four vault accounts must exist before the launch (the keeper creates them; `localnet/verify-distribution-launch.mjs` shows the order): the pool creation and the LP lock already use most of the runtime's nested-instruction budget, so tag 6 refuses a missing vault with error 44 instead of creating it. After the pool is created and the LP locked, tag 6 writes phase 3 and the launch time, then calls the distribution program's `activate` (tag 0, prior counters all zero, 17 accounts: outer accounts 2, 1, 0, 30, 3, 4, 31, 32 to 35, 36 to 39, 11 and 13) signed by the launch authority PDA with the keeper paying rent. `activate` creates its record, burns anything a vault already held, and moves 43.5 % / 5 % / 5 % / 3 % of the supply out of the child custody account into the vaults: five nested instructions on a fresh launch, one more per donated vault. The Associated Token program stays at outer account 12 for the pool and lock CPIs. Tag 6 then reads back that custody holds only the dust (`supply % 10000`, zero for the fixed supply), every vault holds exactly its allocation, the mint still has the original supply and no authorities, and the record names this campaign, mint and program with the activation flag set (error 42 otherwise). Only then is the activation flag written. A failing activation fails the launch, so the campaign stays in its pre-launch state and a launched pool never exists with unfunded claims.

Tags 7, 8 and 10 refuse such a campaign with error 40; tag 9 is unchanged. Campaigns without a recorded program (all zero at offset 312), including the launched mainnet test coin, keep the custody claims exactly as before. The launch program signs nothing for the vaults after activation: the distribution program pays and burns only with its own vault authority PDAs, and `activate` cannot run twice because its record account already exists.

Error codes added: 40 claims refused after activation, 41 the distribution program account is missing, not executable, not under the upgradeable loader or is this program, 42 the read-back after activation does not match the allocation table, 43 wrong tag 6 account count for the campaign, 44 a vault token account does not exist before the launch.

## Claims and fee custody

The remaining supply funds participant claims (43.5%), parent A/B reserves (5% each), and dev allocation (3%). Dev vesting begins at actual successful launch: 1% immediately plus 2% linearly over three UTC calendar months. Parent claims require the 0.05% snapshot threshold and Merkle proofs bound to campaign, parent, owner, balance and allocation. Roots are immutable before commitments, but their historical-balance assertions still trust the publisher. Current circulating supply may fall through voluntary burns without invalidating original-supply entitlements.

Parent claims close 30 days (2,592,000 seconds) after the launch time the campaign records at offset 232. Tag 10 refuses a claim from that second on with error 45. Tag 11 may then be sent by anyone: it burns `reserve - claimed - burned` for each parent from launch custody in one Token burn signed by the launch authority, records the burned amounts in the parents account (parent A at 224, parent B at 232) and the time of the first run at 240, and burns nothing on a second run. Participant claims, dev claims and refunds have no window and are not touched.

The Fee Key remains with the campaign PDA. Separate `fee_authority` custody collects coin/WSOL earnings, burns the coin side (tag 26), and distributes realized WSOL proceeds cumulatively in weights 98:20:25:25/168 (tag 23). The two 25/168 shares are one coin buyback budget: tag 27 spends a slice of at most 0.5 SOL and at most the two pending budgets together through the campaign's own pool (the one recorded at campaign offset 240, its config on the allowlist, vaults, mints and observation account bound to that pool), requires the fill to be at least 1 % under the spot quote from the pool's live reserves (the keeper's `min_out` may be stricter, never looser), burns every received coin unit, and books the SOL against parent A's pending budget first, then parent B's, adding the burned units to `burned_child`. Swaps require a positive minimum output and no more than 120 seconds of quote validity. Only the creator keeper can initiate fee actions, and fixed recipients/mints cannot be redirected. This is not oracle-based pricing or complete manipulation protection.

Fee state: 128 bytes, `KIDSFEE1` (child 40, total 48, treasury 56, dev 64, parent A 72, parent B 80, spent A 88, spent B 96, burned A 104, burned B 112, burned child 120); parent state: 256 bytes, `KIDSPAR1` (layout next to `PARENTS_LEN` in `src/claims.rs`). Exact account/body layouts are in `localnet/atomic-claims.mjs` and `localnet/atomic-fees.mjs`; tags 11 and 27 are listed in `deployment/decisions/BUILD-6-2026-09-24.md` until the keeper builders exist.

## Verified and remaining

The combined localnet run passed 26 launch/claim checks and 9 fee checks against binary SHA-256 `e0b4051752422366e51ae6a5fe8eaeeeab773faa1448cec33a0990961c76e71d` (177,880 bytes). Tests include downstream launch rollback, claims and refund replay, custody substitution, donated-account handling, collection, conversion, routing and both parent burns. Runtime evidence remains under ignored `localnet/.runtime/`.

The active public UI still uses v1; this separate upgradeable development program is not a production deployment. No admin withdrawal or arbitrary CPI instruction exists. Upstream Burn & Earn is closed source; executable testing is not an audit or a production immutability guarantee. Independent review, application migration, verified token identities and production operational controls remain outstanding.
