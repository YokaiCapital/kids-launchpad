# Receipt scaling and independent v3 batch lanes

## Actual local-chain measurement

`KIDS_QUALIFY_RECEIPT_SCALE=1 node --test localnet/test/receipt-scale-e2e.test.mjs`
passed on the isolated v3 validator with 100 actual commitment wallets. Total was
3 SOL against a 2 SOL hard cap. Final account reads verified every wallet's
0.02 SOL accepted / 0.01 SOL refunded, and exact 2 SOL / 1 SOL campaign totals.
The campaign was not launched: this fixture qualifies receipt work only.

One intentionally invalid recipient was submitted with preflight disabled after
valid instructions in the same transaction. The whole transaction rolled back:
no counters, receipt data or recipient balance changed. Replaying completed receipt
work with a new transaction signature did not increase payments or counters.

| Work | Packet bytes | Simulated compute units | Quoted base fee |
|---|---:|---:|---:|
| One settlement | 276 | 6,407 | 5,000 lamports |
| One refund | 309 | 7,056 | 5,000 lamports |
| Eight settlements | 542 | 63,706 | 5,000 lamports |
| Eight refunds | 806 | 68,898 | 5,000 lamports |

Compute is an exact-message pre-send simulation and the fee is the network's
`getFeeForMessage` quote. They are not retrospectively indexed transaction metadata:
the first benchmark attempt completed balance assertions but its later history
lookup returned null. The revised test measures before sending and still confirms
and reconciles actual execution. No missing metric is replaced by zero or guessed.

The 100 commits took 6.290 seconds locally. Twenty receipts processed individually
used 40 transactions / 4.865 seconds. Eighty receipts in separate settlement/refund
batches used 20 transactions / 2.892 seconds. Concurrency was four for that comparison.
These timings are **not mainnet/hosted throughput or latency guarantees**.

Campaign: `EYHc7Awqjs7Nq4nqD6DyekDgdNq3uuqQrFRZwjLHaLkf`.
Replay: `2qmgVWqAFTmcgAGAbWvM12yoZTch7rSf9pXb4SYe7LAoGj8DE3kLeSJXZBDg4BtmJjSX3xeoohMUZLdALwUahkfn`.
Log: `/tmp/kids-receipt-scale-e2e.log`.

## Implementation boundary

Workers default to one receipt per transaction. Explicit `receiptBatchSize: 2..8`
is accepted only for **v3 localnet lifecycle/recovery** roles; v2 and fee lanes
reject it. No deployed runtime or program is changed. Batches keep settlement and
refund transactions separate and retain the existing durable operator outbox,
signature reconciliation, lease fencing and signer limits.

Every batch binds its campaign, ordered receipt set and derived owner destinations.
Refund operation identities also bind the previously refunded amounts. A batch is
bounded by both eight receipts and the remaining job slice budget. An ambiguous
transaction stops the pass and is reconciled before rebuilding. Batch failures
cannot be treated as an individual receipt's already-completed response.

Tests cover scoped adapters, duplicate/foreign receipts, unsupported versions/lanes,
eight-receipt signer policy, changed campaign refusal, crash/unknown recovery and
slice fairness. A failed batch remains retry/dead-letter work; there is no hidden
unbounded per-receipt fallback consuming another lane's capacity.

The full v3 lifecycle also passed with batching enabled, PostgreSQL, the remote
capability signer and real local programs (84.2 seconds). A runner was interrupted
after two single settlements; its replacement settled the remaining receipts in a
batch, and the revived stale runner was refused. Exact over-cap and failed-campaign
refunds, pool creation/permanent LP lock, claims, swaps, fee distribution, token burn
and finalized market indexing all passed. Nine keeper packets confirmed, zero failed
or unknown, with one stale signer refusal. This test uses five participant wallets;
the separate 100-wallet test above measures larger receipt work.

Lifecycle launch: `dvrkhwU71jmKBwtoNZ3nrjeGeSci892wmedJG2Cm8QgRmHkm6QfifPRub3EcfpuNL7c43M5NnbFQswjpPMRYg3y`.
Pool: `6Woyah5T5oAtiJiWjN1M2JEeDjyeWafaBdSF9aTS2sQh`.
Log: `/tmp/kids-v3-batch-lifecycle.log`. 322 focused regressions passed, followed
by all 12 signer-policy tests including the additional eight-receipt qualification.
The frontend/SSR build passed. All tests in these reported commands ran without skips.

## Cost implications, not a new funding policy

For full eight-receipt batches at this zero-priority local base fee, settlement plus
refund costs 1,250 lamports per receipt versus 10,000 individually: an 8x reduction
in this component. The observed receipt rent is 1,781,760 lamports per new wallet,
paid by the committing wallet. This is useful grief-cost evidence, not an adequate
reason to remove abuse controls or promise a minimum commitment policy.

For example, 10,000 receipts imply 0.0125 SOL of these batched base fees, compared
with 17.8176 SOL of receipt rent for the committing wallets. Excluded: incomplete
batch tails, priority fees, retries, RPC/indexing cost, setup/launch transactions,
ongoing keepers, provider capacity and reserve margin. The complete funding quote
and operational funding decision remain required before enabling creator funding.

## Ultimate-goal comparison

This reduces one source of close/refund latency without merging fee or user-recovery
queues or changing funded campaigns. It does not establish 100 simultaneous real
launches, public admission limits, complete provisioning or production readiness.
