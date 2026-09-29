# A38 — Hosted signer key incident and fix (28 September 2026)

Summary (three lines): the hosted v3 signer had signed with a zeroed secret since 27 Sep 23:04 BST (commit 863744d8);
the persistence verification refused every signature, so no funds moved and nothing was broadcast; fixed in 34dd960,
deployed 20:54 UTC, settlement of EHivt8… recovered through the audited path (outcome below).

## Incident
- Campaign `EHivt8VYrtHZpM5CsBeQ4fSxALiVdy3TDRYMgaUSqqPr` closed 20:22:54 UTC with 1.1 SOL committed (soft 1, hard 5).
- Settlement job `6fca6194-d94a-4c98-8fa4-552400260570`: attempts 1–5 and 7 `503 signature persistence unresolved` (538–811 ms
  each), attempts 6 and 8 packet expiry; failed at 20:26:05 UTC, category retries-exhausted, token 8.
- Packets `8d686cf2…` attempts 1 and 2 and shadows `9cb5a866…`, `cb916706…`: expired, signature null, `unsigned:true`.
- Operating holds `op:65ba43b8…`, `op:1e6c7790…`: 5000 lamports each, settled at 0 (reconcile 20:24:21, 20:26:16 UTC).
- Chain at close: phase 0, settledCount 0, no pool. No transaction by the signer exists.

## Root cause
`readSignerKey` (localnet/signer/main.mjs) called `Keypair.fromSecretKey(secret)` then `secret.fill(0)`. web3.js 1.98.4 copies
the public half but keeps the caller's buffer as the secret, so the wipe zeroed the keypair's secret while the public key stayed
`7MES…`. `createSignerService` derived its ed25519 private key from that zeroed secret; every signature verified only for the
zero-seed key. `recordSignature` verifies against the pinned payer before persisting and threw; `signer-service.mjs` mapped any
exception to 503 without a diagnostic, and `runner.classifyError` treated "unresolved" as a transient timeout.

## Fix (commit 34dd960, reviewed and passed before deployment)
- `readSignerKey`: keypair built from its own copy; file bytes and intermediate wiped (also on a throw). Same fix in `claim-cli.mjs`.
- `operating-budget.mjs`: deterministic pre-write checks throw `OPERATING_SIGNATURE_REFUSED`; registry failures and timeouts inside
  bounded calls are tagged `dependency` (wrapped when the value cannot carry the tag) and stay unresolved.
- `signer-service.mjs`: typed refusal → 409 `signer-persistence-refused`; else 503 `signer-persistence-unresolved`. One log event
  `signer-persistence-failed` with allowlisted `stage` and `cause` classes.
- `operator-signer.mjs`, `jobs/runner.mjs`: 409 → `SIGNER_PERSISTENCE_REFUSED` → category `signer-refused`, permanent.
- Tests: key-loader regression (fails on the old loader), signer service on a file-loaded key, foreign signature and expired packet
  refusals, bounded read failures (Error, string, frozen Error, real timeout), HTTP 409/503 with sanitized logs, classification rows.
  Evidence: `signer-fix-suites-34dd960.log` (197 pass) and the mutation run (6 failures with the old loader).

## Deploy
- Push f0d036a → 34dd960 at 20:54:45 UTC; nine services SUCCESS 20:54:46 UTC.
- Signer 20:55:39 UTC: schema-ready v40; composed mainnet, payer `7MES…`, treasury `91eLw…`; listening 4177.
- API statusz ready, release checks all true.

## Recovery and outcome
- Recovery run by the owner at 21:44:11 UTC: `recoverFailedJob` reason reconciliation-budget-correction, prior token 8, prior result hash 2136dfa2…, requeued true (audit row settlement-signer-key-fix:6fca6194…).
- Settlement: packet 8d686cf2… attempt 3, signature 3gLNBN3zzjBb6SYkqHtRAvMdr8BqHeHs5REXWtVfbmYZeRqir8CL5FdfRK4zkCNejrCt69mfHPh8hJLMV7jM9oda, slot 451443388, finalized, 6,246 CU; hold op:4bd940b1… settled at 5,000 lamports.
- Launch: fee-setup capability 0365b27b…, packet 799ffd7d…, signature 2rskAvzXrqYHe5oSpv9qLMFrCudUUQXsmMCoRrXmXQXmaKx2qQvBUwTjGMjAuk6FT1wtLh34FE4CEDkS8N3cQ6oT, slot 451443499, finalized, 261,909 CU (first mainnet tag-6 figure).
- Chain at slot 451443612: phase 3 live, settledCount 1/1, settledAccepted 1,100,000,000, pool 4nrd3XSJeigAt47ReEBoJLTMS4fssntRevAtL8d3s5Uw, fee NFT 3wwCmWUZwRFUKmudHi7UhR35u1QJdUSpVvEihL8yAmso, launchTime 1790631881 (21:44:41 UTC).
- Live verification (withLiveVerification, read-only, finalized slot 451443613, 21:45:20 UTC): ok, no failures; custody 525,000,000,000,000; coin vault 297,667,263,602,831; SOL vault 1,833,485,295; lock vault 722,841,614,640 LP (the whole LP token mint supply); the pool state's lp_supply field 722,841,614,740 = lock vault + Raydium's 100 virtual locked units (that field, not the token mint supply).
- Indexing recovery run by the owner at 21:46:26 UTC (reason activity-decoder-fix-reviewed, prior token 1): job f39972cd… done, 8 events, no duplicates by (genesis, program, campaign, signature, path); the failed-work alert cleared.
- Reserve reconciliation: every hold settled; launch actual 6,004,400 of 10,103,960 held; fee-setup 5,933,360 of 9,625,160; settlement 5,000; the two pre-fix holds 0.
- First fee collection ran 20 s after launch (fees-collect 54nThi…): at slot 451443914 the lock vault and the LP token mint supply were both 709,795,309,581 (all LP still locked; the lock program withdrew the fee share of the position, as designed).
- Reconciliation complete 21:47 UTC: six holds settled, none held; reserve 100,000,000 lamports, spent 11,947,760, available 88,052,240.

## Not closed by this evidence
- The accounting lane's `operating-refill` job of this campaign (`b8d5042d-587f-4615-b667-ce98d6e14186`) was enqueued without the payer/policy binding the lane's lease filter selects on and has never been leased; `/statusz` reports `queue-delay` on the accounting lane until the binding fix is deployed and the row is repaired through the audited command (`pilot-recover-job.sh --action bind-refill`). Financial recovery of the round is verified; this worker gate is not.

## Operator tools kept
- `deployment/hosted/pilot-recover-job.sh` (wraps `localnet/jobs/recover-failed-cli.mjs`): the audited recovery as an owner command; the two one-off scripts used on 28 September are superseded by it.
- Regression tests: `localnet/signer/main.test.mjs` (loaded key signs and verifies), `localnet/signer/operating-budget.test.mjs` (file-loaded key through the service; typed refusal versus unresolved), `localnet/jobs/runner.test.mjs` and `localnet/test/operator-signer.test.mjs` (classification).
