# A35: return of unused operating reserve to the creator after refunds

Date: 27 September 2026, 21:35 to 21:40 UTC. Branch: `feature/public-launches`. Isolated scale ledger
(127.0.0.1:19499, rebuilt version-3 program) only; no hosted service, real wallet or funded coin was
touched. Owner decision implemented: option 1, third part (unused reserve returned on refunds).

## Result

The abandoned cohort `kids-fleet-5DbANT` (100 campaigns, refunded in full in A33, each with a funded
operating budget of 0.08 SOL) was taken through the reserve return by the fleet harness in refund mode:
one `operating-return` capability per campaign naming the sealed creator (the operator step), then the
recovery lane's `operating-return` jobs and the accounting lane's settlement.

| Measure | Value |
|---|---|
| Campaigns returned | 100 of 100 |
| Returned to the creator | 7,999,000,000 lamports (7.999 SOL), one transfer per campaign |
| Creator balance change on chain | exactly 7,999,000,000 lamports |
| Operating budgets after settlement | available 0 on every campaign (funded 0.08 SOL, spent 10,000 lamports, returned 79,990,000 lamports each) |
| Holds and outstanding signed packets at the end | 0 and 0 |
| Wall time | 265 s with 9 worker processes (lifecycle 4, recovery 4, accounting 1) |
| Return jobs | 300 starts, queue p95 224 ms, execution p95 282 ms |
| Accounting jobs | 308 starts, queue p95 7.1 s, execution p95 0.9 s |
| Chain clock | in step with wall time (rate 1.00, lag 2 s), never stalled |

## The path that ran

- The signer signed each return only under the `operating-return` grant: exactly one system transfer
  from the operator to the one recipient plus one memo, nothing else; the keeper grants of the same
  campaigns could not have moved SOL to anyone.
- The signer's cost reader qualified each packet against the chain: a terminally refunded Standard
  campaign, all refunds paid, destination equal to the sealed creator, exact template; the operating
  budget held amount plus fee before signing.
- The accounting lane proved every finalized outcome from balances and recorded fee spent plus amount
  returned; the harness compared the sum of recorded returns with the creator's on-chain balance change.

## What went wrong on the way, and the fixes (all in this branch)

1. First attempt: the return job read the creator from the registry row, which the synthetic fleet never
   fills; every job failed permanently. The job now reads the creator sealed on chain, the same bytes the
   signer checks.
2. Second attempt: the recovery lane had no operating policy, so the ledger view refused the budget row
   (policy mismatch). The lane carries the policy now.
3. Third attempt: the return packet's compute limit was 20,000 units, too small for the memo instruction;
   125 signed packets failed on chain and expired without moving any lamport, and the signer's rolling-hour
   ledger conservatively counted their never-landed amounts (10 SOL of the 10 SOL ceiling set for the run).
   The limit is 60,000 units and part of the operation identity; the fourth run used a 20 SOL ceiling for
   this isolated ledger only.
   The retained fixture keeps all four attempts. Nothing was reset except requeueing the failed
   rehearsal jobs after each fix; the signer journal and every packet stay.

## Not proven here

- The refill from the coin's own fee share (accounting is built; the treasury-signed transfer is the
  owner's step) and the hosted composition are separate items.
- Production returns run under the default ceiling (1 SOL per rolling hour): a burst of failed launches
  returns at that pace, never faster.
