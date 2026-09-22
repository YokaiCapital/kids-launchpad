# Parent-holder snapshot policy (mainnet)

Decided 20 September 2026 after auditing the Pairz reader (`apps/api/src/community-snapshot.ts`, `community-scan.ts`, `packages/asset-pools/src/community-allocation.ts`) against the KIDS agreement and the KIDS program (`programs/atomic-launch/src/claims.rs`). Implementation: `localnet/mainnet-parent-snapshot.mjs`; tests: `localnet/test/mainnet-parent-snapshot.test.mjs`. Nothing here changes the localnet fixtures, which keep their placeholder mints and the local full-bank read in `localnet/parent-snapshot.mjs`.

## What Pairz assumes, and what KIDS keeps or changes

| Topic | Pairz | KIDS decision |
| --- | --- | --- |
| Floor and cap | 0.25% of supply per owner, plus a 2% per-owner cap on the pool | **0.05% per owner**, exact integers: `balance * 2000 >= supply`, the program's `ceil(supply * 5 / 10000)`. **Owner decision, 20 September 2026: a 2% per-owner cap on each parent's pool; a wallet above it is counted as exactly 2%.** Implemented as a cap on the **counted** balance (`finalizeParentAllocation`, fixed point), so the on-chain pro-rata needs no program change; the published `.allocation.csv` shows counted and original balances. In a tiny community where every wallet sits at the cap, the eligible total is raised so each capped wallet still receives exactly 2%, and the unallocated remainder stays in the campaign's custody (published as `unallocatedBps`). A cap limits concentration, it is not Sybil resistance. |
| Aggregation | By token-account owner before the floor | Same. Fragmented holdings add up; two accounts that together reach the floor are eligible. |
| Weighting | Pro-rata by balance, floored, remainder kept | Same, enforced on chain: `allocation = floor(reserve * balance / eligibleBalance)`, `reserve = 5% of child supply` per parent. Flooring dust stays in the campaign authority's token account and is never handed to anyone. |
| Per parent | Separate snapshots and pools | Same. Each parent has its own root, threshold, eligible total and 5% pool; a wallet eligible in both claims twice, once per parent. |
| Off-curve owners | Excluded (PDAs: pools, vaults, escrows) | Excluded. A PDA cannot sign a claim; including it would only strand allocation. |
| Frozen accounts | Excluded | Excluded. |
| Zero balances | Excluded | Excluded (the index is asked to omit them; the chain read drops them). |
| Named exclusions | Configurable list (creator, operator, deployment overrides) | The incinerator plus `deployment/PARENT-SNAPSHOT-EXCLUSIONS.json`. Only entries with `confirmed: true` are applied; each carries a published reason. The reader records custodial signals for every eligible owner (SOL held, non-empty token accounts; flagged at 1,000 SOL and 100 accounts) as evidence for that list. Signals never exclude anyone by themselves: an exchange is a business decision the owner confirms, and the decision is published with the snapshot. |
| Supply | Read once | Read before and after the index pass; a change refuses the read. Both parents have mint and freeze authority revoked, so supply can only fall through burns. |
| Token-2022 | Decoded with the same layout | Decoded with `unpackAccount`/`unpackMint` for the owning program (verified from the mint account's owner on chain, never from the name). Mint extensions allowed: metadata pointer, token metadata, mint close authority. Anything else (transfer fee, transfer hook, permanent delegate, confidential transfer, non-transferable, default frozen, pausable) refuses the whole snapshot. Holder accounts with a withheld transfer fee or an unexpected extension are excluded and counted. Buttcoin today carries only the two metadata extensions. |

## Consistency: what is and is not guaranteed

- The Helius DAS index **nominates** accounts; it is a search index, not the ledger, and it has no historical slot. Every nominated account of every owner above the floor is read back with `getMultipleAccounts` at finalized commitment with `minContextSlot >= slotAfter`, and the chain reading is what is stored. `minContextSlot` is a lower bound only, so the evidence records the actual context slots of the read-back (min and max).
- The published claim is therefore: "each eligible balance is the finalized balance at a slot within the recorded read-back window; the candidate set came from the index between `slotBefore` and `slotAfter`". An owner the index never listed is absent from the snapshot; that is the disclosed trust boundary, the same one Pairz discloses.
- Two full nomination passes run concurrently; an owner that reaches the floor in either pass is a candidate (the union), so balance changes on a live token between passes cannot drop anyone. The chain read-back at or after the last pass decides. A pass wider than 9,000 slots (about an hour) is refused. The index sum is recorded (`indexTotalRaw`, `indexOverSupplyRaw`) but never decides anything: on 20 September 2026 the live Fartcoin index summed to about 0.02% above the supply because it still lists closed or stale accounts, which is exactly why every kept account is read back from the chain and the supply check applies to those readings.
- Any RPC error, at any page or batch, throws. Evidence files are create-once (`O_EXCL`, mode 0600) and are written only after a consistent result. A partial read never becomes evidence.
- A public RPC is acceptable for preliminary inspection only. Production snapshots run through the server-side Helius URL (`KIDS_HELIUS_RPC_URL`), whose host is the only thing ever logged.

## Authorization and immutability (program facts)

- Only the campaign creator can write the two roots, and only while the campaign is in phase 0 with zero commitments (`claims::configure`). The roots, slot, supplies and eligible totals live in a create-once PDA, so they cannot be replaced after commitments or claims begin.
- A parent claim recomputes the threshold and the pro-rata amount on chain from the stored supply and eligible total, checks the Merkle leaf that binds campaign, parent index, owner, balance and allocation, and creates a per-owner claim PDA, so a second claim is a no-op and unrelated accounts are rejected. The claimed total can never exceed the 5% reserve.
- The operator who runs the snapshot and calls `configure` is a trusted publisher. The published CSV and its hashes let anyone recompute the roots; independent review of this trust boundary is still a release gate.

## Open owner decisions

1. Confirm or reject each proposed entry in `PARENT-SNAPSHOT-EXCLUSIONS.json` (ten Fartcoin wallets flagged on 20 September 2026 by custodial signals, about 37% of that pool).
2. Announcing the snapshot window in advance (recommended: announce the target hour, take the two passes inside it, publish the evidence before `configure`).
3. Decided: 2% per-owner cap (20 September 2026).

## Measured on 20 September 2026 (trial, throwaway campaign label, evidence kept out of the repository)

Both parents, two passes each, all four reads concurrent through the server-side Helius URL: 56 seconds in total. Fartcoin: 181,550 non-empty accounts over 366 index pages, index 0.02% above supply (stale rows, as expected), 185 candidate owners, 15 off-curve (pools) excluded, 170 eligible owners read back at one context slot, holding 77.7% of the supply. Buttcoin (Token-2022): 21,116 accounts over 46 pages, 313 candidates, 28 off-curve excluded, one account excluded for an unsupported extension, 284 eligible owners holding 66.5% of the supply. Zero candidates appeared in only one pass.

Helius's `getProgramAccountsV2` was tried and rejected: its pages stride the whole token program before the mint filter, so a large mint returns a handful of accounts per page. The classic single `getProgramAccounts` read is refused by Helius above a size threshold.

Concentration is a policy question for the owner, not a reader question: with no per-owner cap, the largest eligible owners (exchange and custodial wallets are ordinary on-curve owners) take most of each 5% pool pro-rata.

## Lookup reliability and completeness (rules: docs/RELIABILITY-RULES.md)

Every read in the reader goes through one classified, bounded retry path: transient network faults, timeouts, HTTP 429 (with `Retry-After` honoured) and 5xx retry with exponential backoff and jitter, at most four attempts, a real per-request abort and an operation deadline; invalid requests, authentication failures and malformed responses are never retried. Each owner's custodial lookup ends as `resolved` or `unresolved`; an unresolved owner carries the failure category and attempt count, is never flagged and never treated as clean, and makes the snapshot `complete: false`, which the evidence writer refuses to publish. Facts (lamports, token accounts, the balance read's context slot) are stored apart from the heuristic (rule, flag, low confidence). Logs carry sanitized categories, attempts and latency; RPC URLs and keys are stripped. Run of 20 September 2026, 17:55 UTC, with the confirmed list: 444 of 444 lookups resolved, zero retries needed, Fartcoin 160 eligible owners in 39 s, Buttcoin 284 in 15 s.

Capped run, 20 September 2026, 20:40 UTC, with the confirmed exclusion list (37 wallets): Fartcoin 133 eligible wallets, 18 held at the 2% cap; Buttcoin 283 eligible, 9 held at the cap; no unallocated remainder in either; all custodial lookups resolved. Fartcoin took 142 s in this run (slower index responses), Buttcoin 20 s.
