# A41: automatic funding-first lifecycle through the lane workers on the isolated ledger (29 Sep 2026)

**Result: 14 of 14 checks passed** (`localnet/protocol-v3/funding-first-lifecycle-localnet.mjs`, evidence
`kids-launchpad-recovery-2026-09-28/funding-first-lifecycle-rehearsal-4.json`; runs 1 and 2 of the same script stopped on a reused test mint key and on a grant
with an unknown limit key; run 3 launched automatically but its accounting job was refused by the signer's keeper tag set; all three
fixed: script, registry grant validation, signer policy). Program
`2T1K7xegEghMfR5RxtpJurG5bQhesHK6y8cvhpSos7CV` (sha256 `6236f4e8ee6cd003…`), RPC 127.0.0.1:19199, PostgreSQL registry in a fresh schema, the real encrypted
mint inventory (one test-only vanity mint), a scripted metadata provider, funding window 240 s, host at load 11-14.

## What ran, in order (the script only ticked the workers and watched after the creator's approval)
1. The pilot creator's services: reservation, publication + sealed version-3 plan (custody reserved the fee NFT `8BLpp8dFtPUwSr2vAoC5c2k6Aj1DjdrPFaqrqsU2ye7c`
   beside the mint `QHcG9YJPLeLz7aadpvLWWV1e1YUU7z3Bv7Nmtonkids`), ONE wallet approval, custody co-signature, exact broadcast, finalized opening evidence,
   registration (accounting version 2 + fee NFT), the operating reserve (60,000,000 lamports) credited from the same packet.
   Opening `3KL7EEXNJnpVhSAiCEbhsyJy2ZiZxNWxuRZ9EUVF39c5nU7iZiNYKuvD4dn4Yk7cj77rq23EJPx9MLdCjJKnPtU4`; approval to complete 20.322 s.
2. The hosted composition over the same registry: the signer service (capability tags 42,44,45,46,47, the budget the reserve credited), then a
   lifecycle-lane worker (funding-first controller, custody co-signer in process), a recovery-lane worker and an accounting-lane worker.
   The lifecycle was scheduled at 2026-09-29T03:29:29.956Z.
3. With NOTHING committed yet the lifecycle controller enqueued the table job and the lifecycle worker built the table through the
   signer (two packets, the accounting lane reconciling each hold): `launch-table` done at 2026-09-29T03:31:02.555Z, before the
   deadline 2026-09-29T03:33:08.000Z. Only then did the participant commit 0.02 SOL (2026-09-29T03:31:02.659Z).
4. After the sealed deadline the controller enqueued the launch; the lifecycle worker launched (tag 42 through the table, the keeper via
   the signer service, the reserved mint and fee NFT via the custody adapter co-signing the journaled packet: 1 co-sign call).
   Campaign live at 2026-09-29T03:33:28.463Z; launch `Pq1rJCHfZJvfp8Fe2qzjQjU4A44wzWZLBHDqAr9hdXCymBTzF25U5y7VUkN2489xYLcJm5VyDJuArkFgndDL2ko`.
5. Live: the recovery lane ran the excess refunds (done), the lifecycle lane accounted
   every receipt exactly once (done) and returned the collateral to the creator
   (done); the controller verified zero liability and handed off to fee setup:
   stage `fee-setup` at 2026-09-29T03:35:59.569Z (the fee-setup job is queued for the provisioning lane, not run here).
6. Accounting lane: every hold settled from finalized evidence; budget funded 60000000, spent 36865800, held 0, available 23134200.

## Jobs at the end of the watch
| operation key | class | lane | state | last category |
|---|---|---|---|---|
| `lifecycle-control` | lifecycle-control | lifecycle | done | fee-setup |
| `launch-table` | launch | lifecycle | done |  |
| `operating-reconcile:2ce586370a1b8ee2e4ea8bb0a6dfca8f36c182fafb35a43e605ab320445d9983` | operating-reconcile | accounting | done | operating-settled |
| `operating-reconcile:ed82a15de2ae3bde225102b308d689fddff8263faab5f7865bde09aaa7e4b223` | operating-reconcile | accounting | done | operating-settled |
| `launch` | launch | lifecycle | done |  |
| `operating-reconcile:26a65f708231a189b7ed9e39c29bb6bc7a522379f8508ef3b996b496985e7f74` | operating-reconcile | accounting | done | operating-settled |
| `refunds:excess` | refunds | recovery | done |  |
| `account` | settlement | lifecycle | done |  |
| `operating-reconcile:4f70850d2edda9e4957777acf8d4cd7cd1fa6b94f2c87e15bd8e130a568484b0` | operating-reconcile | accounting | done | operating-settled |
| `collateral-return` | settlement | lifecycle | done |  |
| `operating-reconcile:c2a025195ae2e4de8b392bf1a274c6b7b10ec9fcd1eed4ef6eeda844bfc56e7d` | operating-reconcile | accounting | done | operating-settled |
| `fee-setup` | fee-setup | provisioning (not run) | queued |  |

## Timings from the sealed deadline (wall clock; chain clock for the launch block)
- campaign live 20.463 s; launch job done 65.459 s; fee-setup handoff 171.569 s; launch block 18 s after the deadline on the chain's own clock.
- Creator: approval to opening finalized + registered + credited 20.322 s; table ready 92.6 s after scheduling.

## What this proves and what it does not
- Proves: after one creator approval no hand-driven step is needed: the table is prepared during funding (even with nothing committed),
  the launch lands automatically after the deadline with the custody co-signing, the round is accounted, the collateral returns and
  the lifecycle hands off, all through the job runner, the signer service and the accounting lane as composed for hosting.
- Does not prove: hosted timing, the custody endpoint (the custody ran in process; hosted workers need the private endpoint), metadata
  pinning (scripted provider), the fee-setup stage itself, holder claims (tag 43), a failed-round (refund) lifecycle on a real ledger,
  restart/restore of the custody rows, or any hosted qualification. No speed requirement is claimed met.
