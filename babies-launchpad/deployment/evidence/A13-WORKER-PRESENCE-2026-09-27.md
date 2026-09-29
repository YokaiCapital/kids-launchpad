# A13: scoped worker presence

27 September 2026. Schema 37 adds private process telemetry, independent of job
leases and signer authorization. Continuous lifecycle/fee/accounting and market
workers publish supported job classes and bounded capacity under a fresh boot
identity. They heartbeat every five seconds and mark stopped after draining.
Database time defines freshness; monotonic process time measures stalled dispatch
and slow active work. Stopped generations cannot revive during retained history.
Startup removes at most 100 telemetry records older than seven days in its scope.

The observer accepts explicit required role/class/minimum expectations. An empty
map remains unmeasured; a live fee process cannot satisfy a launch/refund role.
Wrong ledger, program, issuer version or supported classes cannot satisfy a
requirement. It reports missing workers, dispatch stalls and slow jobs separately
from queue/funding/authority alerts. Output remains aggregate and private.

Verification: **641 regression tests pass, zero failed or skipped**. Six new tests
cover scope/class ownership, dead/stale/stopped workers, retained terminal state,
monotonic job progress, real service composition/start/drain, and concurrent
startup/shutdown of 100 PostgreSQL-backed process identities. These tests do not
claim 100 on-chain launches or hosted capacity. Presence does not alter job
outcomes, transaction reconciliation, custody or signing permissions.

[Operations guidance](../../localnet/jobs/PRESENCE-OPERATIONS.md) defines the
configuration, alert meanings, telemetry retention and collector freshness
requirements. Hosting a collector/alerts, qualifying database clock/failover and
measuring representative mixed-chain throughput remain release gates. No public
or mainnet activation occurs.

Against the ultimate goal, observable independent operation improves to partial.
Hosted monitoring, explicit operating funding, mixed-chain fleet, coordinated
restore and external-wallet/provider qualification still remain.

Fresh joined actual-chain verification also passed with the updated worker
runtime: campaign `AKyorKdbh2N8MUMQo7kCHRxJ7MLMP3Z3CML3imFRMocU`, mint
`6V5J2MpniqpgYxyEQuBdkwbKgGfd214NdkGYCYjJPwPx`. Controller and signer restart,
settlement, launch, 1 SOL excess refund, fee setup/activation, three independent
fee jobs, setup return, participant/dev claims, burn and buy all reconciled.
Continuous market workers indexed the trade and all 11 finalized activity events.
Operating accounting reconciled 40,000,000 funded lamports to 14,320,840 spent,
zero held and 25,679,160 available. This is one owned local-chain lifecycle, not
fleet or hosted capacity evidence.
