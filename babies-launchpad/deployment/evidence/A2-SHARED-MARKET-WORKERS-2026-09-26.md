# Shared market workers, 26 September 2026

New public-launch indexing and history backfill now have independent worker processes,
job lanes and reserved RPC capacity. They reuse the existing Raydium swap decoder.
They do not import the API plugin, wallet signer or legacy keeper timers. Existing
live indexing remains unchanged; this path is limited to loopback localnet rehearsal.

Schema 10 stores finalized swaps, incremental candles and revisioned cursors in
PostgreSQL. Each page atomically commits unique trades, candle deltas, cursor movement
and successor jobs. Duplicate live/history pages cannot double-count volume. An expired
job cannot publish. Conflicting finalized data stops processing instead of rewriting
history. Reads use bounded keyset pagination and a matching C-collation index.
Each upstream read now rechecks the job fence. A final database-time lease check after
page writes rolls back the trades, cursor and follow-ups if the lease expired during
the transaction. The expanded shared-market group passes 16 tests, including this case.

One pass fetches at most 20 signatures, with sequential bounded transaction reads.
Full live pages enqueue separate history work. A history job yields after one page;
it cannot monopolize live indexing or lifecycle/fee lanes. Missing transactions and
unavailable block times retain the cursor for recovery. Decoder incompatibility is
visible as a job failure requiring repair; automated incident handling remains ahead.

## Verification

- 254 focused tests passed, no failures or skips, including actual PostgreSQL,
  new worker/store tests and existing market regression tests.
- Actual PostgreSQL + local-validator end-to-end test passed, no skip. It exercised
  settlement, excess and failed-campaign refunds, permanent LP locking, participant/dev
  claims, swaps, fee harvesting, payouts, token burns and then the new market worker.
- The projection contains exactly the two executed swaps, with total volume
  300774095 lamports. Pool creation, lock operations and fee activity are not trades.
- Replica tests cover duplicate/out-of-order ingestion, exact candle totals, cursor
  races, failed follow-up rollback, expired/foreign leases and bounded pagination.
- Publication pattern check: 728 files, zero findings. This does not prove absence
  of every secret. `git diff --check` passed. CI includes the new test group.

Local logs: `/tmp/kids-a2-market-focused.log`, `/tmp/kids-v2-market-e2e.log`.
Ledger/program/build identities remain those in the role/validator evidence. The local
AMM fixture uses its existing 2% tier, not the production 2.5% configuration.

## Running the isolated roles

`node localnet/market/public-service.mjs` requires `KIDS_REGISTRY_URL` and a private
`KIDS_MARKET_WORKER_CONFIG` file. Its fields are `mode: localnet-rehearsal`, `lane:
indexing` or `backfill`, loopback `rpcUrl`, exact `genesisHash`/`programId`, bounded
`concurrency`, and `rpcAdmission` with an explicit resource and reserved lane policy.
Apply schema 10 before starting roles. Initial `market-live:0` is seeded by a trusted
lifecycle coordinator only after verification of a live campaign; automatic lifecycle
seeding is not yet wired. No signer key or capability is needed by these roles.

## Limits and next gates

This projection is explicitly finalized-only, so it has finality latency. Pending
wallet activity is separate. Within a slot, signatures provide a deterministic order;
transaction ordinal is unknown. No full-block ordinal fidelity is claimed.

Still needed: shared read API/cache and freshness/completeness status, confirmed overlay
if required by the accepted UI, opening-price/no-trade chart behavior, lifecycle seeding,
history/decode incident recovery, retention, provider archival qualification and measured
100-coin workloads. Per-pool serialization protects candles; unrelated pools do not
share that lock. This is not a hosted capacity result or permission to replace live indexing.

Ultimate-goal comparison: advances concurrent reliable trading data and independent
operations, preserves existing campaigns, but does not complete creation, UI or release.
