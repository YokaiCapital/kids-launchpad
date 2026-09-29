# Shared-state foundation and worker scheduling checkpoint

Date: 26 September 2026. Branch: `feature/public-launches`. Owner: platform engineering.
Scope: isolated local implementation and tests. No mainnet program, live coin, Railway service,
production database, wallet funds or public-access setting changed. This is not production sign-off.

## Delivered in this checkpoint

- Pinned `pg` 8.23.0 and an asynchronous PostgreSQL registry with bounded connection pools,
  short transactions, migrations coordinated across replicas, exact decimal amount storage,
  uniqueness and resumable wallet packets. SQLite remains available for existing deployments.
- Campaign updates serialize by full campaign identity rather than a global lock. Sequence
  ordinals do not collide between new campaigns. Unkeyed multi-row invariants use serializable
  transactions with bounded retry; external calls do not belong inside retried transactions.
- Awaited public wallet, draft, campaign and startup paths. Signed user packets persist before
  broadcast; an old unsigned-expiry read cannot overwrite a concurrently signed packet.
- PostgreSQL wallet challenges/sessions, nonce replay prevention, origin-scoped hashed session
  tokens, logout across replicas, and shared-secret stateless CSRF. These are opt-in.
- Explicit lane-filtered atomic `SKIP LOCKED` leasing. Production runners require a lane;
  continuously available slots refill independently of the slowest in-flight job.
- Settlement/refund slices default to at most 16 sends / five seconds between sends, with
  checkpoints and a non-failure yield. The adapter still re-enumerates chain receipts between
  slices; indexed pagination and per-call network deadlines remain part of later qualification.
- Expired leases cannot renew, complete, fail or requeue, even before another worker takes over.
  Unknown signed outcomes keep reconciliation state beyond scheduling deadlines and RPC errors.
- CI job definition for PostgreSQL concurrency, auth, worker tests and dump/restore. The workflow
  has not run remotely yet; local results are the evidence in this checkpoint.

## Verified locally

Real PostgreSQL 16, two independent pools and synthetic data in a unique, disposable schema:

- Simultaneous migration; 100 concurrent new campaign records with distinct ordinals; sealed
  term preservation; one winner for competing draft revisions; idempotent financial requests.
- Competing signatures retain one exact packet; competing mint reservations cannot share a mint;
  compare-and-set transitions; stale lease rejection; rollback returns pool connections.
- A launch is leased despite 250 queued harvest jobs. Six lifecycle jobs use two slots: five
  fast jobs finish while one remains deliberately blocked. No cross-lane consumption.
- Wallet proof created on HTTP replica A is verified on B, the session works on A, a draft saved
  on B reads on A, and logout on A revokes B. CSRF follows the same authenticated public origin.
- A PostgreSQL dump/restoration recovers exact signed bytes, campaign count, job count and auth
  rows. A new connection recovers the same packet. This proves this synthetic restore, not
  hosted point-in-time recovery, provider HA, production restore permissions or recovery SLA.
- A 45-receipt accounting test yields in groups of four without exhausting retries and reconciles
  all accepted/refunded lamports. See the separate 196-receipt crash/restart emulation report.

Reproducible database gate (test URL is provided privately at runtime):

```sh
node --test localnet/registry/postgres.test.mjs
```

Requires `KIDS_TEST_POSTGRES_URL` pointing to a disposable test database. Set `KIDS_TEST_PG_BIN`
to the PostgreSQL 16 executable directory to include the actual dump/restore test. Missing test
settings produce explicit skips; skipped tests do not qualify a release. CI supplies both.

## Configuration and cutover rules

- `KIDS_REGISTRY_URL`: server-only PostgreSQL connection string; never a frontend variable.
- `KIDS_ACCOUNT_STORAGE=postgres`: explicitly chooses shared account/session storage.
- `KIDS_CSRF_SECRET`: identical random 32–64 bytes, hex encoded, on API replicas only. Do not
  commit it, print it, use an example value in production or send it to a browser.
- Keep current public-launch owner-wallet access restrictions and localnet-only financial route
  gates in place. Do not enable replicas just because these three settings exist.
- Existing SQLite account/session files are untouched. A controlled cutover must preserve
  required account history and financial journals, reconcile pending transactions and document
  any re-authentication. No automatic destructive migration or silent SQLite fallback.
- The database role currently needs migration privileges during startup. Separate migration
  credentials and runtime grants, TLS/private-network policy, total connection allocation,
  backup retention/PITR and restore drills are required before hosted activation.

## Ultimate-goal comparison

| Dimension | Status | Evidence / remaining gap |
|---|---|---|
| Complete creator journey | Not demonstrated | Wizard/media/provisioning integration and interrupted-creation recovery still required. |
| Understandable participant journey | Partial | Existing wallet regression coverage retained; approved multi-launch UI is still pending. |
| Verifiable money and permissions | Partial | Shared signed user packets, nonce/lease/ownership guards tested. Operator persist-before-broadcast journal and signer admission integration remain mandatory. |
| Reliable concurrent operation | Partial | Database races and slot/lane isolation tested. Physical services, RPC/signing reserves and full mixed workload are not qualified. |
| Sustainable fee operations | Partial | Reserved harvest/economics lane definitions exist. Campaign-aware collectors, routing budgets, accrual reconciliation and cost thresholds still need integration. |
| Preservation and recovery | Partial | Legacy import/wallet regressions, synthetic restore and crash drill pass. Hosted cutover, operator packet recovery and incident drills remain. |
| Public operating readiness | Not demonstrated | No deployment or release claim; production monitoring, load/security review and dependency qualification remain. |

Next work: durable operator signed-packet journal and reconciliation before any new broadcast;
remaining async consumers (mint orchestration, budgets, signer capabilities); isolated role
runtimes with RPC/signer budgets; complete creation and UI; then full qualification and pilot.

Dependency audit reported nine advisories in the existing Solana dependency tree (six moderate,
three high); none named the newly added PostgreSQL dependency tree. npm suggested incompatible
historical Solana downgrades, so no automatic `audit fix` was applied. Reachability analysis and
safe remediation remain a release gate. A source publication scan found no pattern matches;
pattern scanning is not proof that every possible secret or vulnerability is absent.
