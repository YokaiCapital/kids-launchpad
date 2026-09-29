# Worker presence and deployment expectations

Continuous `jobs/service.mjs` and `market/public-service.mjs` workers announce a
fresh boot identity before leasing work, write a heartbeat every five seconds
and mark themselves stopped after draining. One-pass `tick()` rehearsals do not
claim to be a continuously available service. Heartbeat writes are serialized
per boot; stopped records cannot be revived. Startup prunes at most 100 records
older than seven days from its own program/version/lane. No financial records
are pruned. Freshness uses database time; dispatch and active-job durations use
the process monotonic clock. No machine clock changes can reset those durations.

Configure the existing private observer with `requiredWorkers`, in addition to
its exact `scope`, RPC/signer resources and reserve threshold. For example:

```json
{
  "requiredWorkers": {
    "lifecycle": {"minimum": 2, "classes": ["launch", "settlement", "lifecycle-control"]},
    "recovery": {"minimum": 2, "classes": ["refunds"]},
    "provisioning": {"minimum": 1, "classes": ["fee-setup", "fee-activate"]},
    "accounting": {"minimum": 1, "classes": ["operating-reconcile"]},
    "harvest": {"minimum": 2, "classes": ["fee-harvest"]},
    "economics": {"minimum": 1, "classes": ["distribution", "token-burn"]},
    "indexing": {"minimum": 2, "classes": ["campaign-index", "market-index", "fee-index", "activity-index", "position-index"]},
    "backfill": {"minimum": 1, "classes": ["market-backfill", "activity-backfill"], "maxJobMs": 900000}
  }
}
```

These are example role expectations, **not a qualified capacity recommendation**.
A worker counts only if its exact network/program/version matches, its supported
classes cover the requirement and its heartbeat is at most 20 seconds old.
An empty expectation map remains `liveness: not-measured`; discovering existing
workers must never silently define a healthy fleet. Aggregate JSON/Prometheus
outputs omit boot IDs, hosts, campaigns, wallet addresses, packets and credentials.

Alert separately on:

- `worker-missing`: fewer fresh capable processes than the configured minimum;
- `worker-dispatch-stalled`: a live process has not entered dispatch for 20 seconds;
- `worker-job-slow`: an active job exceeds the role's configured duration limit
  (default ten minutes); this does not assert that its transaction failed;
- existing queue delay, unknown transactions, expired leases, funding waits,
  missing/expiring capabilities and RPC/signer admission pressure;
- missing, stale or failed **observer collection itself**. A saved healthy result
  must not hide loss of the monitoring process.

Presence is telemetry, never a job lease, signer capability, transaction outcome
or assertion of financial readiness. A heartbeat failure logs a fixed event and
leaves existing job/signing fences intact. Monitor the database clock/failover
bound; alert on clock jumps. Keep the observer private with read-only database
permissions. Worker roles need writes only to their existing job/accounting
resources and this telemetry table. A monitored fleet is not automatically safe
to scale: per-lane upstream budgets, signer single-writer ownership and measured
mixed-chain throughput still determine capacity. No hosted collector/autoscaler
or public launch activation is installed by this module.

## Bounded scaling advice

`observe.mjs --scaling` reads the same fresh database observation and an explicit
private `scaling` section: `policy`, current provider `deployment` replica counts,
and acknowledged `history`. It emits `apply: false`; it does not call Railway or
change a replica count. Do not wire its output directly to provider writes without
fresh provider inventory, a single controller leader, acknowledged state storage,
least-privilege credentials and graceful worker drain qualification.

`policy.maxTotalReplicas` caps the entire configured group. Each lane requires
`minimum`, `maximum`, `slotsPerReplica`, `measuredJobMs`, `maxStep`, `cooldownMs`,
`idleMs` and `needsSigner`. Supply measured execution time from private
`job-finished.durationMs` events; this is slot occupancy, not queue delay or total
chain finality. No example values here imply a qualified production capacity.

`deployment` maps every configured lane to its currently acknowledged provider
replica count. Each optional `history[lane]` holds `lastAppliedAt` and `idleSince`
(milliseconds since epoch, with `null` when not continuously idle). Persist a
change time only after the provider acknowledges it. Reset idle tracking whenever
work, unknown transactions, missing workers or telemetry errors appear.

Advice protects all lane minima before extra growth, prioritizes recovery and
lifecycle demand, checks observed role/slot configuration, and respects finite
steps and cooldown. Stale/future observations, unknown upstream admission,
RPC/signer pressure, unavailable authority or funding do not trigger speculative
growth. Missing workers require recovery. Scale-down is limited to one replica
after sustained idle and never goes below the configured warm minimum. Proposed
downsizing is not treated as capacity available elsewhere before acknowledgement.

The hosted provider controller, scheduled-close pre-scaling, automatic intake
throttling, qualified production quotas and remote alert delivery remain release
work. Advice alone does not meet those gates.

## Independent resources and advance demand

`resources.rpc` and `resources.signer` accept either one existing partitioned
resource name or an explicit lane-to-resource map. A map must name the actual
resource configured in each service, not invent one from its lane name. Missing
policies or mismatched partitions are unavailable, never zero demand. Add
`resources.signerRpc` with the dedicated signer's evidence-RPC resource. Financial
scale advice requires that channel as well as worker RPC and signing admission.
This prevents adding workers when the shared signer cannot read its evidence.
All names remain private configuration; metric labels expose only fixed roles.

Queued `not_before` times are observed in cumulative 60/300/600-second horizons.
A lane's `prewarmMs` may be 60000, 300000 or 600000 (0/omitted disables advance
advice). Select a horizon from measured provider boot/ready time plus margin;
qualification must prove readiness before the actual close. The advice includes
scheduled work in its bounded capacity estimate and does not scale down around
that work. These counts describe scheduled jobs, including deliberate rechecks,
not unique coins or predicted future receipts. Refund jobs that do not exist yet
still need a qualified warm minimum; a schedule estimate cannot replace it.

The observer only reads and does not consume admission tokens or change leases.
Advance advice still emits `apply:false`; hosted leadership, provider acknowledgement,
actual minimum capacity and intake controls remain necessary before activation.
