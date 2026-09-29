# Active signing lease checkpoint

26 September 2026 · feature/public-launches · local source only.

The version-2 signing path now refuses requests without an authoritative registry lease
check. That check binds the exact genesis, program, campaign, current grant, operation key
and fencing token. Queued, expired, superseded and revoked authority is refused, including
an expired token the signer has never previously seen. Database failures fail closed.
PostgreSQL authorization uses database time. The signer conservatively subtracts lookup
latency and refuses leases with less than one second left. No asynchronous work follows
that final check before signing.

Capability loading no longer restores an older grant when the latest grant expires or is
revoked. A campaign address present under multiple ledger/program identities is refused
rather than selecting whichever row happened to be last. Sources for a signer must be
explicitly scoped before multi-ledger operation is enabled.

The signer also rechecks its per-minute limit after awaited lookups. Eight concurrent
requests that all pass ingress cannot each sign under a one-per-minute configuration.
Grant expiry is evaluated after asynchronous lookups, not from the request arrival time.
The existing legacy signing path remains available; production startup is not switched to
the new version-2 registry-backed path by this patch.

## Verification

138 focused tests passed, zero failures/skips, including PostgreSQL replicas, simulated
connection/restart failures, wallet packet recovery and existing signer regressions. New
cases cover expired first-use leases, live-lease TTL, cross-ledger mismatch, superseded and
revoked grants, backend unavailability, near-expiry refusal and concurrent rate admission.
Source publication scan: 707 files, zero pattern findings (not a guarantee of no secrets).

## Remaining boundaries

The registry observation is not an on-chain cancellation mechanism. A signature already
issued remains broadcastable until its transaction validity expires. Durable exact-packet
recovery and on-chain idempotence remain necessary. A lease could change after the observed
check; no absolute cross-system atomicity is claimed. Worker/signer clock and lease-time
qualification, registry deployment/roles and backup recovery still require rehearsal.

Signer spend/replay state remains on its single-writer volume. Do not replicate the signer
with independent copies of that state or treat worker replicas as authorization to increase
its rate/spend ceilings. Horizontal signing needs shared accounting or explicitly authorized
independent shards and its own qualification. Existing production services were not changed.

Ultimate goal: financial execution safety **improved, partial**. The next step is isolated
role composition and whole-flow/load evidence; this is not production or public activation.
