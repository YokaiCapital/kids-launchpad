# Independent public-launch workers

`service.mjs` is a separate **localnet rehearsal** entry point. It does not import the
web API, legacy keepers or market feed. It currently serves:

- `lifecycle`: v2 receipt settlement, launch readiness and launch.
- `recovery`: v2 refunds. Unknown outcomes remain reconciled by their original handler;
  this is not yet a general cross-lane packet recovery service.
- `harvest`: Standard v2 locked-position fee collection only.
- `economics`: Standard v2 SOL-side distribution and child-token burns. Parent
  buybacks are deliberately not served by this worker.

Explicit `programVersion: 3` additionally enables the qualified Standard adapters.
The v3 lifecycle may coordinate settlement/launch/refunds and a funded handoff when
`lifecycle.setupHandoff` and its exact operating policy are configured. Provisioning
serves v3 `fee-setup` and opt-in `fee-activate`; signer-free accounting independently
reconciles finalized operating costs. Existing v2 handlers do not inherit v3 policy.
See the dated joined-lifecycle evidence for its complete qualified boundary.

Fee state and canonical token accounts must be initialized during provisioning.
Workers cannot initialize the treasury-controlled fee state or change the fee operator.
After that prerequisite, `seedFeeJobs(registry, identity)` idempotently creates three
independent recurring job chains. Each runs at most one transaction per pass, normally
every five minutes. The successor waits for its predecessor to finish, including after
a crash between scheduling and completion. Unknown signatures block only that chain
until reconciled; they are not evidence of failed transactions.

New collections are simulated first. Collection, distribution and burns wait until their
value reaches 0.0005 SOL in this rehearsal; coin-side dust uses the current pool reserve
ratio solely as an operating-cost gate, not an oracle or execution quote. Previously
prepared/signed packets are resumed before dust checks. Fee weights come from sealed
campaign terms. A closed recipient ATA can interrupt payouts but cannot stop collection
or burns. Funding and bounded recipient-ATA repair remain provisioning qualifications.

PostgreSQL atomically filters jobs by lane, supported class, genesis, program ID and
campaign version before choosing one. Legacy/other-program jobs stay untouched. RPC
and signing calls require shared reserved admission. Shutdown stops intake and drains
in-flight handlers. A database loss leaves unresolved leases/packets for recovery.

## Rehearsal setup

Use an isolated PostgreSQL schema/database with migrations already applied, a new local
validator ledger, and a local registry-backed signer. `signer/registry-service.mjs`
exports the signer composition: pass its shared registry, bounded connection, exact
ledger/program identity, test keypair, authentication token and private state-file path.
The signer must be one process with exclusive ownership of its state volume. V3
additionally acquires a schema-28 database time lease before journal verification;
competing replicas and expired/failed renewals cannot sign. Graceful callers must
await `service.close()` before replacement. See the signer ownership evidence
under `deployment/evidence/A3-SIGNER-OWNERSHIP-2026-09-27.md` for restore limits. Its new
registry composition reads only the newest grant for the requested campaign in its
configured genesis/program scope, using schema 9's ordered index. Revoked/expired
newest grants do not resurrect older permissions. It rejects
requests without a campaign capability or a current job lease. Lookup-table signing is
not enabled in this composition yet. The existing production signer entry point is
unchanged.

Keep operator configuration outside Git. A worker config has this shape:

```json
{
  "mode": "localnet-rehearsal",
  "lane": "lifecycle",
  "genesisHash": "EXACT_LOCAL_GENESIS",
  "programId": "LOCAL_V2_PROGRAM",
  "concurrency": 2,
  "rpcUrl": "http://127.0.0.1:19199",
  "signer": {"url": "http://127.0.0.1:4176", "publicKey": "TEST_SIGNER_PUBLIC_KEY"},
  "rpcAdmission": {"resource": "rpc-local", "policy": "EXPLICIT_POLICY_OBJECT"},
  "signerAdmission": {"resource": "signer-local", "policy": "EXPLICIT_POLICY_OBJECT"}
}
```

Each policy is `{ratePerSecond, burst, lanes: {lifecycle: {ratePerSecond, burst},
recovery: {ratePerSecond, burst}}}`. All replicas sharing a resource use the identical
policy. Lane totals must fit its global envelope. Use separate resource identities for
RPC and signing; include every enabled consumer. No production capacity values are
implied by this example. Choose bursts and rates that allow multi-call handlers to make
progress, then measure them. Existing signer ceilings remain independently enforced.

Set `KIDS_WORKER_CONFIG` to the private config file, `KIDS_REGISTRY_URL` to the isolated
Postgres URL, and `KIDS_SIGNER_TOKEN` through the environment. From the application root:

```sh
node localnet/jobs/service.mjs
```

Run the recovery lane in another process with its own config and the same policies.
Only loopback RPC/signer endpoints and the localnet rehearsal mode are accepted. Startup
checks the RPC genesis and executable program before it leases any job. It refuses a
schema version different from this build; workers do not run schema migrations.

## Still required before hosted activation

This is not a production supervisor or an autoscaling configuration. Health/readiness
probes, aggregate connection budgeting, signer state
ownership/replication qualification, Family fee routes, indexing runtimes, complete creation,
provider failover and representative mixed-load/failure tests remain release gates.
Neither a running worker nor a positive inventory count proves a public launch is ready.

## Private monitoring

`observe.mjs` reads aggregate PostgreSQL queue, authority, operating-reserve and
RPC/signer admission state in one bounded consistent snapshot. Run it separately
from financial workers. Set `KIDS_REGISTRY_URL` privately and `KIDS_OBSERVER_CONFIG`
to a private JSON file containing `scope: {genesisHash, programId, campaignVersion: 3}`,
`resources: {rpc: "EXACT_RPC_RESOURCE", signer: "EXACT_SIGNER_RESOURCE"}` and
`minimumReserveLamports` as a positive decimal string. The resource values must be
the actual lowercase names used by the services, not the uppercase placeholders.

```sh
node localnet/jobs/observe.mjs
node localnet/jobs/observe.mjs --prometheus
```

No public HTTP endpoint, address labels, packet contents or secrets are exported.
The command neither consumes quota nor grants rights, mutates jobs or funds anything.
Monitoring must alert on a missing/old observation as well as a degraded one;
errors exit nonzero and never emit a fabricated healthy result. Poll at a modest
interval (for example 15 seconds) from a private collector. Do not place database
credentials in process arguments or shell history. Keep raw results internal.

Queue-delay targets follow the capacity plan: lifecycle/recovery 5 seconds,
harvest/accounting/provisioning 60 seconds, economics 5 minutes. Scheduled waits
do not count as overdue. Unknown transactions, expired leases, funding waits,
failed work, missing/expiring latest grants and projected quota headroom are
reported separately. Holdings reserved for unknown packets reduce usable funding.
Historical completed budgets are excluded from low-reserve alerts.

These are scale/incident inputs, not an automatic replica controller or proof of
process liveness. `liveness: not-measured` is deliberate. A collector still needs
service heartbeats and chain/provider probes; never label `observed` as launch-ready.
If deadlines/fees lag, identify whether the lane lacks worker slots or upstream
headroom before adding replicas. Replicas do not increase signer spending rights.

## V3 signer restart and restore

Keep the private signer journal and PostgreSQL history together in the backup
plan. On startup the registry signer compares exact-scope approvals and fences
before accepting requests. V3 journal writes are durably flushed before signing,
including retries. A missing or mismatched history refuses service; do not erase
the file, start an empty replacement or loosen file permissions to work around it.

Stop workers and the signer before a restore. Recover the retained journal and
database, reconcile unknown signatures and balances with finalized chain state,
then qualify the restored service privately before allowing new work. Comparing
the two stores cannot detect a coordinated rollback of both; backup provenance
and chain reconciliation are necessary. Only one signer process may own its disk
journal. Shared-volume multi-writer signing has not been qualified.

## Market history coverage

Run indexing and backfill with separate reserved RPC lanes. The shared reader
does not query RPC for viewers. A complete initial history requires verification
of the canonical pool's initialization, even if the provider returns an empty or
short signature page. Subsequent polls reject retention gaps across their prior
observation. Use archival history for catch-up; a pruned validator is suitable
only if indexing starts during launch and remains caught up. Never clear cursors
or label a missing history as a pool with no trades to make the dashboard green.

The isolated creator HTTP composition exposes these reads only to its signed-in
pilot wallet. It reports `marketRead` capability; other compositions leave the
panel disabled unless separately qualified. Market reads continue through a
financial write pause, while transaction routes remain blocked.
