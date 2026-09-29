# A2 Standard fee worker checkpoint, 26 September 2026

This is local implementation and rehearsal evidence, not a hosted deployment or
production capacity qualification. Existing programs, production keepers and live
campaigns are unchanged. No Rust program or approved economic terms changed.

## Implementation

`localnet/jobs/service.mjs` now composes two additional independent roles, with
their own reserved RPC/signer admission lanes and bounded process concurrency:

- Harvest leases only `fee-harvest` jobs for the exact genesis/program/version.
- Economics leases only `distribution` and `token-burn`. No parent swap routes.

The adapter uses existing v2 instructions 21, 23 and 26. All recipients and weights
come from sealed Standard campaign terms. Before acting it checks campaign identity,
fee custody, canonical pool/lock/NFT identities and account ownership. Account reads
and simulations require context at least as recent as their source snapshot.

Three deterministic recurring job chains are seeded once. A completed or economically
deferred pass queues its own successor five minutes later. A successor must see its
matching predecessor completed before it can act. This closes the crash window between
enqueue and completion without combining the three types into one blocking queue.

Every send uses the existing durable operator packet journal. Restart/retry resumes
prepared or signed bytes before considering balances or dust thresholds. Ambiguous
transactions retain their signature and validity facts for reconciliation; no successor
is scheduled until the outcome is resolved. A completed operation replays its receipt
without another broadcast. Economic job records are not represented as transactions
when no transaction was sent.

New collection attempts simulate the canonical fee instruction and inspect resulting
fee counters. The local operating threshold is 500,000 lamports of value. Distribution
uses cumulative on-chain entitlements minus already-paid counters; burns consume only
accounted child fees. Coin-side valuation uses net pool reserves solely to avoid dust
operations; it is not an oracle or a user quote. Pending plus previously burned coins
forms the cumulative collection measure, so a parallel burn cannot produce a false
negative collection delta. Only the explicit Raydium ZeroTradingTokens simulation
error is suppressed as no economic work; other errors remain visible failures.

Recipient-owned ATAs are not prerequisites for collection/burns. A dev closing their
payout ATA can affect distribution but cannot stop those other chains. Workers do not
request treasury signing or initialize fee state. Initialization, funding and bounded
repair of recipient ATAs remain part of provisioning qualification.

## Verification

Final focused suite: **160 passed, 0 failed, 0 skipped**, including actual PostgreSQL
checks (`/tmp/kids-a2-fees-final.log`). Final validator flow: **1 passed, 0 failed,
0 skipped**, about 73 seconds (`/tmp/kids-v2-fee-e2e-final.log`). Source pattern scan:
719 export files, zero findings; this does not prove all secrets absent. CI now includes
the new fee adapter tests, but has not been executed on hosted GitHub in this checkpoint.
The subsequent SQLite adapter regression also passes the actual-validator fee flow
(`/tmp/kids-v2-fee-sqlite.log`, one pass, no skips). SQLite uses serial local execution;
independent role-leasing evidence belongs to the PostgreSQL runs. The isolated validator
was stopped after verification; its ledger remains available for further rehearsals.

Focused tests cover reserved role/class selection, current job dependencies, unknown
signatures, durable successor publication retries, dust, stale RPC context, foreign
accounts, wrong mode, missing setup, negative liabilities and concurrent burns.

A real PostgreSQL test holds an economic job indefinitely while separate harvest,
launch and refund runners complete their jobs. This proves executor/queue isolation
under that injected stall, not 100-coin throughput or provider capacity.

The actual local-validator integration test now creates two Standard campaigns, runs
settlement/refunds/launch/claims through PostgreSQL and the capability signer, executes
real CPMM buy and sell transactions, then runs the three fee jobs separately. It checks
the treasury and dev balance deltas against sealed entitlements, token supply reduction
against the burn counter, and that the keeper receives no unlocked LP or fee NFT.
Repeated completed fee jobs send no transaction. The treasury balance comparison is a
delta because the isolated ledger persists between test runs.

First successful fee rehearsal: 2,426,720 lamports collected; 2,137,824 paid to treasury;
288,895 paid to dev; 535,726,381,833 raw child units burned. One lamport of cumulative
rounding dust remains accounted in custody. Local clone uses its existing 2% config;
this does not change the approved 2.5% production tier. These are synthetic funds.

Final local run pool: `D51tW2xhRTDvojn3jM9RFyn1V8ysmuj3N32r3obg3UUB`.
Collection: `2h5e9XkHyn6tVjqtin8cWQUWaLTjDAYu9xqwDR7FES1ZfWpoE6HKDHZGQMKJr9JhmxwHP25iULhoiVa2sXA6PaCA`.
Distribution: `5FoczrYK9Uj3GAwPpqa1xcdMjyW1y5XEatgi9G72yoZVAPrQLE8daRSCtThzLY2Pn2JBGRNG1nu8xZHpdWZKaGsD`.
Burn: `48YFCSxRnSNHnQuQSUBmvgzYnheCN9ePyyAaq7Uzgdrjc3qbVJKnhctCPT8GfnaTqeUfDQ68docSvrWymMtjqczz`.
These identifiers belong only to the isolated local validator, not mainnet explorers.

## Remaining qualification

- Family routes, index/live feed/backfill processes and API timer extraction.
- Complete funded provisioning, canonical recipient ATA repair, usable vanity mint
  checks and registry activation. Fee job seeding is not automatic public activation.
- Stage-aware alerting for stalled/failed recurring chains; health/readiness and fleet
  scaling. Fee cadence/thresholds need measurement against real provider and network
  costs, including priority fees if enabled later.
- Signer state ownership and deployment topology. No independently replicated signers
  or increased signing ceilings. The subsequent [bounded lookup checkpoint](A2-BOUNDED-SIGNER-LOOKUP-2026-09-26.md)
  removes the whole-table capability scan.
- Hosted mixed-load/fault tests, real-wallet qualification and independent contract
  review. These tests do not certify permanent-lock economics or public launch safety.

Ultimate-goal comparison: Standard fee work now progresses independently of launch,
refund and other economic work, with explicit transaction outcomes. Public creation,
the approved UX and demonstrated production-scale operation are still outstanding.
