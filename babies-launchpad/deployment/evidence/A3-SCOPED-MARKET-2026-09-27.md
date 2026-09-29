# Scoped market and live-page qualification

Scope: new Standard pilot, localnet v3; legacy market routes and existing funded
coins are unchanged. Shared market reads are composed into the private creator
HTTP service; this does not activate a production service or grant signing rights.

## Behavior

- The live coin page reuses the existing Lightweight Charts renderer with a
  campaign-specific authenticated PostgreSQL reader, not the legacy active-coin
  singleton or browser RPC. Responses must match ledger, program, campaign,
  pool, mint, decimals and finalized commitment.
- Bucket-aligned bounded queries share server caching. Polls do not overlap
  within one view and stop when hidden/unmounted. Changed owners/coins discard
  pending responses. Last verified data remains explicitly stale on failure.
- Chart and trades share one compact panel. Eight trades occupy a page; paging
  is bounded. Exact amounts remain accessible, including tiny nonzero SOL.
  Mobile shortcuts reach market and claims without traversing all content.
- Opening price is a separately labelled reference, never an invented trade,
  candle, volume or market capitalization. Carried bars are allowed only after
  real trades with fresh complete history. Unknown intervals remain gaps.

## Retention failure discovered and corrected

A read-only rehearsal against an earlier local launch returned no trades because
the owned validator had pruned those blocks. Previously an empty signature page
could be mistaken for complete quiet history. Initial coverage now requires the
successful exact CPMM initialization instruction for the canonical pool, vaults
and mints. Backfills preserve that evidence. Later recovery also checks that the
previous observation remains within the provider's retained block range.

Missing history must use a qualified archival provider or explicit recovery;
neither restarting nor a fresh chain head justifies declaring it complete. The
read-only `localnet/market/qualify-market.mjs` deliberately fails on pruned history.

## Validation and remaining boundaries

Browser interactions pass at 320, 390, 768 and 1440 pixels: real chart renderer,
opening reference, intervals, trade paging, claims shortcut, stale warning,
foreign-scope rejection and disconnect clearing. No overflow or browser errors.
These use explicit HTTP fixtures and do not certify external wallets/providers.

Authenticated HTTP tests cover pilot ownership, CSRF, exact ledger response and
read availability while financial writes are paused. Unit/integration tests
cover scoped reads, bounded caching, retention, initial history, genuine gaps and
malformed data. Actual-chain results and final regression totals are recorded in
the integrated plan checkpoint after completion.

Still required: hosted/archive provider qualification, fleet-scale indexing
capacity, user-signed per-campaign trading, complete live activity/fee projection
and the remaining creator/operating/release gates. No mass-traffic or production
readiness claim follows from these checks alone.

## Completed local chain run

Campaign `Fu5AmLMFrLRPcu4NoG8ygDppuyvAgWi1wBpLYjmVqGk9`, mint
`5e9Qe96uJF8TPQpDBAAFCeP6mVKj89ZRFR9KTdA85ZEQ`, on the owned local
validator completed controller and signer restart, automatic settlement, launch,
refunds, fee setup and independent fee jobs. The market worker ran independently
while claims, burn and a buy confirmed. It verified pool initialization, indexed
the exact buy signature and produced one actual candle. Current custody remained
valid after those actions. This is local chain evidence, not mainnet evidence.

Subsequent deterministic tests cover pruning an old signature during continuous
quiet observations: retained finalized slot overlap permits continued polling
without passing a stale signature bound. Incremental backfills keep that boundary
and stop there. A real observation gap beyond retention still fails closed.

Final bounded regression: **551 passed, 0 failed, 0 skipped**. Production frontend
build and four-viewport browser interactions pass. No hosted activation or push.
