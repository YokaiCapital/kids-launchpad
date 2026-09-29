# A33: refunds for a funded cohort that was never scheduled

Date: 27 September 2026. Branch: `feature/public-launches`. Isolated scale ledger only; no
hosted service, program or funded coin was touched.

## Result

- Cohort `kids-fleet-5DbANT` (100 campaigns, 8 receipts each, 0.25 SOL per receipt) was funded
  on 27 September and then abandoned: its keeper grants expired exactly at the launch deadline,
  and the scheduling rule introduced in A31 (a grant must outlive the launch window plus the
  refund allowance) refused to schedule it. No lifecycle row existed, so no keeper acted, and
  the launch window closed with the SOL still in the program's escrow.
- After the window had elapsed on chain, the cohort was taken through the refund path with the
  operator action that applies to a never-scheduled campaign: a fresh initial keeper grant
  (tags 3, 4, 6) sized by the lifetime rule, then scheduling. The lifecycle handler saw the
  expired window and paid every refund.
- Figures from the run (fixture retained, `completed: true`):

| Measure | Value |
|---|---|
| Campaigns refunded | 100 of 100 |
| SOL returned | 200 SOL (`refundedLamports` 200000000000), accepted 0, held 0 |
| Receipts verified on chain | all (`allReceiptsVerified: true`) |
| Outstanding signed packets | 0 |
| Wall time | 64 s with 9 worker processes (lifecycle 4, recovery 4, accounting 1) |
| Lifecycle jobs | 502 starts, queue p95 3.7 s, execution p95 0.6 s |
| Refund jobs | 300 starts, queue p95 5.0 s, execution p95 1.9 s |
| Accounting jobs | 234 starts, queue p95 11.0 s, execution p95 1.0 s |
| Chain clock | lagging wall time by about 1,600 s, never stalled |

## What went wrong first, and the fix

The first attempt (20:01 UTC) failed inside a second with `Live explicit lifecycle grant
required`. The harness had issued refund-only continuation grants (tag 3) to every campaign
and then tried to schedule with them. A continuation grant is for a campaign that is already
under lifecycle control and whose initial grant has died; scheduling itself always needs the
explicit initial grant. The harness now separates the two cases: campaigns with a lifecycle row
and a dead grant get the continuation, campaigns without a lifecycle row get a fresh initial
grant and are scheduled. The second attempt (20:09 UTC) completed.

## What this proves and what it does not

- Proven on the isolated ledger: a funded campaign that the keepers never picked up can be
  refunded in full after its window by one operator action per campaign, with receipts,
  escrow and journals reconciling to zero held.
- Not proven: that an operator would notice such a campaign in time. A funded campaign with
  no lifecycle row is a silent state today. Open item: an alert when a funded campaign has no
  lifecycle row for longer than a few minutes, delivered through the observability channel.
- The scheduling refusal that abandoned this cohort was the harness's own zero-margin grant,
  not a product path; the creator flow sizes grants by the lifetime rule.
