# A31: environment clock diagnosis, expired-window refunds and grant lifetimes

Date: 27 September 2026. Branch: `feature/public-launches`. Isolated scale ledger only; no
hosted service, program or funded coin was touched.

## Result

- The signer-balanced-360 run of 27 September (fixture `kids-fleet-x3rhUI`) failed for an
  environment reason, not a throughput reason: its 30-minute wall budget expired before the
  600 chain-second funding deadline arrived on a validator whose clock lags wall time. It is
  recorded as an environment failure and stays retained. No throughput number comes from it.
- The same cohort was then qualified through the supported failure path: the launch window had
  closed on chain without a launch, and all 100 campaigns were refunded in full.
- Doing so exposed a real defect: the cohort's one-hour keeper grants had expired before its own
  launch window closed, so every lifecycle job was paused and no refund could be paid. Fixed.
- Fresh close capacity is still unmeasured. The next run uses the new clock guard.

## Environment diagnosis (read-only, 18:37 to 18:50 UTC)

| Observation | Value |
|---|---|
| Scale validator (19499) chain clock behind wall time | 7,000 s at 18:38 UTC, 6,333 s at 18:50 UTC (catching up while idle) |
| Creator validator (19199) chain clock behind wall time | 1,538 s |
| Slot rate, both validators, idle | 2.05 slots per second (nominal 2.5) |
| Validators on the host | four `solana-test-validator` processes at 113 to 119 percent CPU each |
| Host | 14 cores, load average 8.4 to 8.7 with no fleet running |

During the failed run the fleet added 13 worker processes, trading and the test driver, which
slowed slot production further. Chain time then advanced at a fraction of wall time, so a
wall-bounded wait could not reach a chain deadline. The exact rate during that run was not
sampled; the harness now samples it continuously.

Harness changes (`localnet/creation/fleet-clock.mjs`, `qualify-fleet.mjs`):

- A fresh run samples the chain clock for twelve seconds first and refuses to start when the
  chain advances slower than half of wall time.
- While the chain target is ahead, the wall budget follows the observed chain rate (bounded at
  three hours); a sustained stall is an `ENVIRONMENT_CHAIN_CLOCK` failure, never a throughput one.
- A wall timeout before the observed chain close is classified `environment`; only a timeout
  after the close is `slo`.
- Every failure retains `failure-<attempt>.json` with its classification, chain-clock summary
  and job summary next to the packets.
- `KIDS_FLEET_EXPECT=refund-window-expired` resumes a cohort whose launch window elapsed on
  chain and verifies the refund path; a launch-mode resume of such a cohort is refused with
  the reason instead of timing out again. Fee lanes stay down in that mode so unrelated pools
  are not touched.

## Grant-lifetime defect and fixes

The cohort was scheduled at 13:18 UTC with keeper grants (tags 3, 4, 6) expiring one hour
later. Its funding deadline was 13:17:57 chain time plus a 3,600-second launch window, so the
grant expired before the window closed. At 18:57 UTC all 100 `lifecycle-control` jobs sat in
`lifecycle-capability-paused`; the signer served no grant for the cohort; nothing could pay the
refunds that the program allows once a window elapses.

Fixes, all tested:

1. `localnet/jobs/lifecycle.mjs`: scheduling refuses an initial grant that expires before the
   sealed launch window closes plus a refund allowance (default 86,400 s, configurable
   60 s to 30 days), measured from chain time so a lagging clock cannot hide the gap.
2. Refund-only continuation: after the window closed without a launch, a current grant with
   tag 3 only and no recipients lets the controller deliver full refunds. It never resumes
   settlement, launch or fee setup, and nothing issues it automatically; the harness issues it
   as an explicit operator action and logs the count.
3. `localnet/jobs/runner.mjs`: a signer refusal for an expired, revoked or missing grant is
   `capability-paused` (a yield that spends no retry budget and resumes once a grant exists)
   instead of a permanent `auth` failure needing audited recovery. Other refusals stay terminal.

The fee-harvest job of one background pool failed at 18:53:43 UTC during the first resume
attempt with exactly that `auth` reason. It is retained as evidence of the old behaviour and
still needs an operator grant plus recovery.

## Refund-path qualification (x3rhUI, expired window)

| Measure | Value |
|---|---|
| Campaigns and receipts | 100 campaigns, 8 receipts each, 2 SOL committed per campaign |
| Chain state before | phase 0 for all 100, launch window elapsed by 11,598 s |
| Continuation grants issued | 100, tag 3 only, no recipients, two hours |
| Workers | 9 processes: lifecycle 4, recovery 4, accounting 1; fee lanes not started |
| Refunds delivered (progress samples every 15 s from worker start) | 1 at 30 s, 7 at 45 s, 92 at 60 s, 99 at 75 s |
| Last refund | after an unknown-signature reconciliation: the first packet expired with retained history, a second packet finalized |
| Chain state after | phase 2 for all 100; refunded 200,000,000,000 lamports = total committed |
| Receipts | 800 verified: refunded equals committed, none settled |
| Registry | 100 lifecycles `refunded`, 100 refund jobs done, 100 controls done as `refunded`, 101 accounting jobs settled |
| Operator packets | 200 finalized, 2 expired with retained context, 0 signed outstanding |
| Operating holds | 0 held (101 settled) |
| Retained report | `report-17f16b98-b690-4974-9ba8-bd125a5c4a70.json` in the fixture, `expectation: refund-window-expired` |

Signer spend for this path was not separately measured; refunds are network-fee packets only.

## Regression and publication

- Full cross-layer regression at the runner change: 732 passed, 0 failed, 0 skipped
  (`/tmp/kids-a31-regression.log`, the handoff command plus the new fleet-clock and lifecycle
  tests, run while the refund rehearsal was still using the host).
- The branch was published to GitHub with assistant names removed from two documents and one
  commit message (tree otherwise identical), draft pull request 11 opened, and CI passed on
  the published source after the lockfiles gained the optional websocket peers that the CI
  npm (11.19) requires.

## Ultimate-goal comparison

Reliable concurrent operation and recovery improve: an expired launch window now ends in exact
full refunds at 100-campaign scale, and grant lifetimes can no longer strand refunds. Fresh
close latency, hosted composition, fee-grant renewal for long-lived pools, the operating-funding
policy and public release gates remain open. No public activation or funded-program change.
