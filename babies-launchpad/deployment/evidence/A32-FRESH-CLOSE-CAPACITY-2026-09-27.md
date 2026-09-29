# A32: fresh 100-campaign close on the signer-balanced profile

Date: 27 September 2026, 19:15 to 19:31 UTC. Branch `feature/public-launches`. Isolated scale
ledger only. Fixture `kids-fleet-pHLtk8` (retained), background pools `kids-fleet-UqwFjp`,
signer journal lineage `kids-fleet-o4rg3E`. No hosted service, program or funded coin touched.

## Result

The first complete fresh-close run of the balanced profile: workers were up before the common
chain deadline, all 100 campaigns launched, every excess refund and fee activation finished,
100 background pools traded and drained their fee work, and every journal closed. Launch start
latency at the close missed the 5-second target (p95 7.1 s); settlement and lifecycle control
met it; refunds were marginal (p95 5.4 s). These are local numbers on a shared laptop, a lower
bound of service behaviour, not a hosted capacity claim.

## Setup

| Item | Value |
|---|---|
| Profile | `signer-balanced-360`: lifecycle 4, recovery 4, provisioning 2, accounting 1, harvest 1, economics 1 (13 processes, 4 slots each) |
| Budgets | worker RPC 240/s shared; signer evidence RPC 120/s; signing 600 per minute; 5 SOL rolling-hour ceiling; all unchanged |
| Cohort | 100 campaigns, 8 receipts each, 2 SOL committed per campaign, soft 0.5 SOL, hard 1 SOL |
| Background | 100 existing pools: one buy and one sell each plus harvest, distribution and burn |
| Chain clock | preflight 2.00 chain seconds per wall second; minimum 1.77 during the run; no stall; lag 5,044 s falling to 3,962 s |
| Close | workers scheduled 435 chain seconds before the deadline; close observed 19:20:05.5 UTC |
| Wall time | 948 s from funding to full reconciliation |

Before this run the same harness refused one attempt (`kids-fleet-5DbANT`) because its grants
had zero margin over the controller's new minimum; the cohort is retained and is reconciled
through the refund path once its window elapses. The background pools' expired fee grants were
renewed with their recorded scope and one paused fee job recovered, both as audited operator
steps (`fleet-fee-grant-renewal`: renewed 100, recovered 1, in the first attempt).

## Money and journals

| Check | Value |
|---|---|
| Accepted | 100 SOL (1 SOL per campaign) |
| Excess refunded | 100 SOL, exact per receipt |
| Locks and receipts | 100 locks verified, 800 receipts verified |
| Operating holds | 0 held at the end |
| Signed operator packets outstanding | 0 |
| Background trades | 100 buys and 100 sells finalized from their original packets |
| Background fee residue | SOL dust 9,778,022 lamports across 22 pools (each below the 500,000-lamport operation minimum); token dust in 1 pool worth at most 444,451 lamports |
| Background failed jobs | none |

## Latency from the observed close (first start of each job)

| Job | p50 | p95 | p99 | Target (plan section 11) |
|---|---|---|---|---|
| lifecycle-control | 1.9 s | 4.2 s | 4.3 s | due lifecycle start p95 < 5 s: met |
| settlement | 1.3 s | 3.3 s | 5.6 s | met |
| launch | 2.9 s | 7.1 s | 7.3 s | missed |
| refunds | 0.4 s | 5.4 s | 5.6 s | marginal |
| fee-setup | 0.1 s | 0.9 s | 1.8 s | met |
| fee-activate | 3 ms | 6 ms | 8 ms | met |
| fee-harvest (background) | 0.2 s | 4.9 s | 5.9 s | economical harvest start p95 < 60 s: met |
| distribution (background) | 0.4 s | 7.1 s | 9.7 s | within 5 minutes: met |
| token-burn (background) | 0.4 s | 8.4 s | 29.9 s | within 5 minutes: met |
| operating-reconcile | 4.2 s | 48.4 s | 50.7 s | no user-facing target; signer-free lane |

Execution p95: lifecycle 2.2 s, recovery 3.7 s, provisioning 1.0 s, harvest 1.0 s, economics 0.7 s.
The per-lane queue p95 for harvest and economics reads about six hours because the background
pools' fee jobs had been due since the morning while no worker ran; the closing-window table
above counts only starts after the observed close and is the number that matters.

## What this does and does not show

- It shows the platform's own behaviour under a simultaneous close of 100 small campaigns plus
  100 active pools: exact money, closed journals, no starvation between lanes, fee work drained
  to its economic thresholds.
- It does not show hosted capacity: the host ran four validators at roughly 80 percent of the
  nominal slot rate and all 13 workers, the signer, PostgreSQL and the test driver.
- Receipts per campaign were 8; campaigns with hundreds of receipts are a different workload
  (settlement is batched in chunks of 8 and bounded per job, but it was not measured here).
- Signer spend: the retained rolling-hour journal held 853 charges totalling 2.404 SOL at the end of the run (this run plus the refund path of A31), under the unchanged 5 SOL ceiling; no hourly-spend wait occurred.

## Admission proposal (register, not activated)

On this evidence, admit at most 50 campaigns closing inside any two-minute window for the
restricted pilot, and re-measure on the hosted composition before raising it. Launch start
latency grows with the number of simultaneous closes; at half the load the 5-second target is
the expectation, not a measurement. Never extend a sealed deadline to make room; slow new
creations before their setup payment instead.
