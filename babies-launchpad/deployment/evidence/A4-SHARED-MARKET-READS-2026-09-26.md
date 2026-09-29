# Shared market read path, 26 September 2026

Schema 12 records the verified finalized campaign/pool/mint identity with the first
market page. A later page cannot silently change that identity, launch time, decimals
or opening price. The identity, swaps, candles and cursor publish in the same transaction.

The new reader resolves campaign identity from PostgreSQL and never falls back to RPC.
It returns bounded, paginated trades or at most 1000 aligned candle buckets, reusing
the existing exact-number shaping functions. Responses carry the explicit finalized
commitment, last successful poll time, history completeness and indexing error state.
Missing projection, backfill, stale polling and an idle pool are distinct states.

A no-trade pool includes a separately labelled opening-price reference calculated
from its sealed liquidity allocation and accepted SOL. It is not a trade or a candle,
and adds no fabricated volume. Chart rendering must show it as an opening reference
when this API is integrated into the UI.

Per-process bounded caching shares one query among simultaneous identical requests.
Active entries cannot be evicted to bypass single-flight protection. Excess distinct
in-flight reads return capacity backpressure; errors are not cached. This is not a
distributed CDN/cache layer or a hosted load-test result.

An optional account route `/api/account/launches/market/read` is behind existing
wallet authentication, pilot access, origin and CSRF checks. Runtime composition
does not activate it or replace the live site's legacy market endpoint yet.

## Evidence

- **270 focused tests passed, zero failures/skips**, including actual PostgreSQL,
  legacy market regressions and all new projection/reader cases.
- Four reader tests also pass after bucket-alignment refinement.
- A unit concurrency test sends 100 simultaneous identical requests and observes
  one lookup; a different query is refused when the configured active cache is full.
- The actual v2 local-validator/PostgreSQL end-to-end run passed again, zero skips:
  real setup-cost evidence, two campaign outcomes, settlement/refunds/claims,
  locked launch, swaps, fee payout/burn, indexing and the shared public reader.
  It returns exactly two finalized trades with complete history and no fake trades.
- Publication pattern check: 741 files, zero findings; this is not a guarantee
  against every secret. Diff whitespace checks passed.

Logs: `/tmp/kids-public-final-focused.log`, `/tmp/kids-v2-market-reader-e2e.log`.

Remaining: UI integration, automatic verified lifecycle seeding, source/RPC-head
health (a recent successful poll is not proof the upstream node is current), retained
history incident repair, operational retention and actual representative fleet/browser
load tests. Finalized latency and within-slot deterministic signature ordering remain
the limits recorded in A2 evidence. Hosted production is not activated.

Ultimate-goal comparison: gives many coin pages a reusable database-backed read path
and truthful availability states; complete creation and release qualification remain.
