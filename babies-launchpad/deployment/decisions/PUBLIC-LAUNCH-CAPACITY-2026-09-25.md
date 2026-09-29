# Public launches: independent execution capacity and demand scaling

25 September 2026. Architecture review of the local feature/public-launches branch after 654c365. This is a source review and implementation requirement, not a live Railway inventory, benchmark, deployment or capacity certification.

## Decision

Do not launch public multi-coin creation behind one shared FIFO or one pool of worker slots. Launches, user actions, fee harvesting, economic operations and market indexing need independently reserved capacity. Separate queues without separate execution slots, signer admission and RPC budgets are insufficient.

100 registered coins, 100 active pools, 100 simultaneous funding closes and 100 concurrent user requests are four different workloads. Capacity must be qualified for all four, including different receipt counts per campaign. No promise of 100 simultaneous launches follows from a successful 100-request HTTP test.

## Findings in this branch

| Evidence | Consequence |
|---|---|
| localnet/registry/registry.mjs PostgresRegistry throws NOT_CONFIGURED; working adapter is synchronous SQLite | Shared distributed durable storage is not implemented. Do not replicate the current writable volume/API process. |
| deployment/mainnet/supervisor.mjs requires /data and starts the API under flock | The current process is intentionally a single writer. Stateless replicas require extraction of persistent state, not another Railway replica switch. |
| interaction-review/server/account-plugin.mjs starts keepers, market and activity in the API process | API restarts/resource pressure affect background work. Existing createEscrowKeepers runs independent named tasks: the legacy implementation is not literally one FIFO. |
| localnet/jobs/runner.mjs defaults to concurrency 2, with class priority and campaign round-robin | Useful foundation, but no reserved lane capacity; slow handlers can occupy all slots. tick waits for its started batch; a caller awaiting tick does not continuously refill idle slots. |
| Registry jobDue selects the oldest 200 candidates for the runner | Fairness only applies to this candidate window. A large old backlog can hide urgent jobs/campaigns beyond the window. |
| localnet/jobs/handlers.mjs settlement/refund handlers iterate a full campaign sequentially, waiting on each chain call | One large campaign can occupy a slot for a long time. Divide work into bounded resumable steps, not a whole campaign per job. |
| localnet/signer-service.mjs defaults to 60 signing requests/minute and file-backed replay/spend/fence state | Extra worker replicas cannot overcome signer admission limits. Blind signer replication would undermine the shared security policy. |
| localnet/protocol-v2/chain-adapter.mjs uses one keeper fee payer and broadcasts before persisting a packet within this adapter | Shared writable payer contention and a crash window need qualification. The public-wallet path already persists signed packets before broadcast; reuse that pattern for operators. |
| Job deadline handling can fail a job before its unknown transaction is reconciled | An operational deadline must not discard an unresolved signature or justify mint reuse. Keep reconciliation alive independently of the action deadline. |
| localnet/market/feed.mjs resolves the active campaign; the legacy fee adapter checks the single campaign it serves | This is not a fleet-wide indexing/fees implementation. Use explicit campaign identities throughout the new services. |
| kids-mint-worker/worker.mjs already isolates CPU-intensive vanity work with encrypted inventory | Keep it separate. Generated inventory must also be verified, leasable and usable for signing; a count alone is not launch readiness. |

These are blockers to a scaling claim, not evidence that the existing live coin has failed. Preserve existing programs and legacy service behavior during migration.

## Execution lanes

| Service / lane | Work | Isolation rule |
|---|---|---|
| Stateless API + interactive transaction path | Auth, drafts, quotes, user-signed commits/trades/claims/refunds, operation status | Dedicated request limits, connections and RPC capacity. User-authorized transactions do not wait behind operator fee jobs or use an operator signature when the program does not require it. |
| Provisioning | Media/metadata readiness, verified mint reservation, creation, registration | Independent of deadline-sensitive closes. Durable intent and quoted budgets; explicit intake capacity before payment/signing. |
| Lifecycle | Due campaigns, settlement chunks, pool creation and launch verification | Reserved workers and signer/RPC budget; prioritize deadline slack and fair campaign service. Settlement prerequisites must not be starved by launch readiness polling. |
| Recovery / reconciliation | Unknown signatures, crash recovery, receipt verification and operator-assisted refund work | Reserved capacity remains available during overload and after action deadlines. No duplicate replacement transaction while the original is unresolved. |
| Fee harvest / accounting | Check accrued amounts, threshold decisions, collect qualified fees, reconcile counters | Separate worker pool, cadence and signer budget from launches. Routine checks must not each create a transaction. |
| Economic operations | Confirmed collected token burns, authorized SOL distributions and parent buybacks/burns where applicable | Separate from harvest so slow swap routes cannot stop collecting other pools. Future recycling/MM get their own versioned lanes and policies. |
| Market / activity indexer | Pool trades, candles, chain program activity and read projections | Separate consumers with durable cursors; no per-viewer chain scan. Live ingestion capacity protected from historical backfill. |
| Vanity mint generation | Refill encrypted validated suffix inventory | CPU-isolated; no web/API capacity consumed. Unique inventory ownership and authenticated leasing/import. |

These are logical roles. One audited codebase/container image can run role-specific services; do not invent eight separate products. A shared Postgres jobs table is acceptable initially if leasing is lane-filtered and execution capacity is physically independent. Financial truth remains on-chain; Postgres stores durable intents, jobs, packets and indexed observations. Shared Redis may serve cache/rate limits, not the sole financial journal.

## Durable concurrency rules

1. Implement the real asynchronous Postgres adapter and migrations, transactional uniqueness, connection pools, backups/PITR and restore drills. Refactor synchronous callers correctly; swapping only placeholders is insufficient.
2. Transactionally lease due jobs by lane using short row-lock transactions (for example FOR UPDATE SKIP LOCKED). Commit the lease before doing network work. Never hold a database transaction open while waiting for a wallet, RPC or confirmation.
3. Use stable operation identity: network genesis + program version + campaign + action + sequence. Store signed bytes/signature before broadcast; record every attempt. At-least-once execution plus on-chain idempotence/reconciliation, not a claim of exactly-once network delivery.
4. Fence leases at durable writes and signer admission. A fence check alone cannot revoke an already issued signature; correctness also requires program/account state constraints and exact packet reconciliation. Lease loss stops new work; unresolved packets remain tracked.
5. Execute across independent campaigns concurrently. Coordinate only conflicting campaign/pool/account mutations. Do not globally lock all coins. Avoid launching/refunding/recycling against inconsistent state, but do not hold a campaign lock during backoff or an RPC outage.
6. Split settlement/refunds into bounded chunks with cursor/checkpoint and finite work budget; initially qualify small batches, then tune against transaction-size/compute/account-write constraints. Batching is not unlimited parallel writes to one campaign.
7. Fill a free worker slot immediately. Query urgent lanes fairly at the database boundary, not after selecting 200 oldest mixed jobs. Retries use bounded exponential backoff and jitter, not an unbounded hot loop.
8. Reconciliation of potentially broadcast transactions outlives normal job deadlines. Unrecoverable failures go to explicit operator review; funds/refund access are not silently abandoned.

## Shared bottlenecks: protect them too

- RPC: per-lane and global request budgets, paid capacity sized to measured load, batched reads/subscriptions, circuit breakers, bounded retries and same-genesis failover. Fee/backfill traffic cannot exhaust launch/interactive reserves. Additional workers must not amplify a provider 429 storm.
- Signer: preserve private-network access, strict program/campaign capabilities, destination allowlists, replay/fence state and spend ceilings. Measure signing latency separately from confirmation. Do not simply remove the 60/minute ceiling. Introduce lane admission and shared atomic limits. If measured demand needs partitioning, use explicitly authorized funded fee-payer shards and isolated signers, not duplicated uncoordinated keys/state.
- On-chain writes: inventory writable accounts across each hot instruction. One common writable fee payer or treasury/global counter can serialize otherwise unrelated campaigns. For new programs keep configuration read-only where possible and use campaign-specific vaults/state. Changes to authorities/payers must be supported by the program and signer policy; do not retrofit old programs silently.
- Database: budget the total of replica connection pools; monitor query/lock time and queue-table growth, archive terminal jobs without deleting necessary financial audit evidence. Database HA and recovery are separate from API replica count.
- Media: durable object storage and CDN; uploads/video processing do not occupy financial workers. Existing access gate rules must also apply to private assets.

## Fee collection, burns and user expectations

Pool fees accrue when qualifying swaps execute; our collector realizes the claimable amounts later. A slow keeper generally delays collection/distribution/burning, not the swap's fee accrual itself. Verify this against the exact venue/version. Do not label accrued or merely submitted amounts as already collected/burned.

Maintain independent per-pool records: observed accrued, confirmed collected (both assets), token amount awaiting burn, SOL earmarked for each destination, confirmed spent/distributed, confirmed burned and relevant signatures. Timestamp every observation; freshness is explicit. Separate accrued estimates from authoritative executed totals.

Schedule active pools promptly, cold pools less often, with jitter so every coin does not wake at the same second. Coalesce duplicate checks. Collection and buybacks run only when economic thresholds justify network/priority fees and route quality; thresholds are policy/version-specific. Small balances remain visibly awaiting the threshold, not fake 0.00 burns. Maximum-age policy must be explicit, including cases where spending more on fees than the balance would be unreasonable.

Each buyback is a bounded, guarded slice. One unavailable parent route cannot stall another coin, ordinary fee harvesting, or user claims. Confirm the acquired amount before burning it; reconcile uncertain swap/burn outcomes before retrying. Preserve the selected dev/treasury earnings policy and distinguish it from any future LP principal recycling.

Suggested service targets for qualification, not advertised guarantees: interactive request internal queue p95 under 1 s; due lifecycle job start p95 under 5 s at the declared peak; due economical fee harvest start p95 under 60 s; economical burn/distribution work start within 5 minutes. These exclude wallet waiting and external chain confirmation, which must be measured and displayed separately. A target breach triggers scaling/alerts; it must not silently stretch a published funding deadline.

## Demand scaling and capacity proof

Use oldest due-job age, deadline slack, arrival/completion rate, active slots and RPC/signer headroom—not CPU alone—to scale each lane. Keep minimum warm capacity and pre-scale ahead of scheduled closes. Independent minimum capacity for recovery and fees prevents either class starving under sustained load. Apply cooldown and cost ceilings. When upstream capacity is exhausted, throttle new creation before taking setup payment, protect submitted operations/claims, and expose truthful degraded status.

Railway supports replica scaling, but its documented volumes cannot attach to replicated services. Move API/worker mutable state to shared services first. Configure or implement a controller for queue-driven replica changes; do not assume ordinary resource autoscaling watches job backlog. Start with modest independently deployed pools (e.g. two API instances, two lifecycle workers with low bounded concurrency, and separate warm recovery, fee and indexing consumers), then choose counts from measured throughput. These are rehearsal starting points, not proof of sufficient capacity.

Capacity model: required concurrent execution slots ≈ jobs/second × measured seconds of slot occupancy, plus tested headroom. Separate launch count from receipt/transaction count. For illustration only, 100 closes × 100 receipts × one settlement transaction each means 10,000 settlement transactions. At the current default signer admission of 60 requests/minute, signing alone is on the order of 167 minutes before other operations—even with many Node workers. Actual batching, reuse, signer policy and receipts determine the real workload. Capacity needs end-to-end measurement.

Qualification matrix:

- 100 simultaneous funding closes with realistic distributions (small, typical and a whale-sized receipt backlog), while another 100 pools accrue fees and users submit commits/claims/trades.
- 1,000+ browsing clients using shared cached/indexed reads; no per-client RPC multiplication. Distinguish this target from the independently tested transaction workload.
- Concurrent fee harvests, burns and routes that stall, fail, return 429 or exceed guards. User/launch latency must remain within targets; fee work must still receive its reserved service.
- Worker killed before/after signing, persistence and broadcast; signer/API restart, lost lease, duplicate delivery, database failover, RPC outage and indexer reconnect/backfill.
- Assert no double mint lease, duplicate financial effect, lost refund entitlement, stale runner spend or cross-campaign action. Check exact asset conservation and program state.
- Record p50/p95/p99 API and queue latency by lane; whole-campaign settlement/launch completion distribution; confirmation time; fee age; spend/priority-fee cost; RPC/signing throughput; database lock time; indexer lag. No public scale claim until evidence meets the chosen targets.

## Delivery order and review gates

1. Postgres/shared sessions/transaction journal; lane-aware durable queue; persist-before-broadcast for operators; unknown-outcome recovery fixes.
2. Extract API, lifecycle, fee/economic and indexer runtimes; campaign-specific adapters; bounded settlement work and fair slot refill.
3. Signer and RPC reserved budgets; writable-account contention review; inventory/provisioning capacity integration.
4. Per-lane metrics/alerts/autoscaling controls; synthetic/adversarial and isolated-chain mixed workload tests.
5. Restricted pilot under representative concurrency, then public capacity limits chosen from evidence. Keep existing mainnet/Family behavior intact; no mainnet action or security-limit relaxation is authorized by this document alone.

## Primary references checked

- Railway replica scaling: https://docs.railway.com/deployments/scaling
- Railway volume/replica limitation: https://docs.railway.com/volumes/reference
- Railway stateless API and shared session considerations: https://docs.railway.com/guides/multi-region-api-failover
- PostgreSQL queue-consumer row locking: https://www.postgresql.org/docs/current/sql-select.html
- Solana transaction pipeline (writable fee payer): https://solana.com/docs/core/transactions/transaction-pipeline
