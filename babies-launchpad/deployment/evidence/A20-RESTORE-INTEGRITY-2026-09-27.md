# A20: restore integrity and retained signing exposure

Status: local restoration verified; hosted PITR and external checkpoint anchoring remain unqualified.

## Correction

Restart admission must cover recently signed budget shadows after they become finalized, failed or expired. Limiting the check to rows still marked signed would miss a rolled-back approval journal once A19 had correctly recorded their outcomes. Coverage now examines signed packet bytes regardless of lifecycle status.

Every approval in the live hourly window must also have its corresponding conservative maximum charge in the disk ledger at the same signing timestamp. Charges from multiple approvals at one timestamp are summed. Extra conservative charges are allowed after a persistence interruption; missing or reduced charges are rejected. The existing exact scope, message, hold and fence checks remain. Legacy signer behavior is unchanged.

## Actual restore drill

`localnet/creation/qualify-restore.mjs` is opt-in and limited to a stopped, fully reconciled, owned local fleet. It exports a consistent PostgreSQL snapshot, copies the private signer journal, hashes all tables and both files, restores into a newly created disposable database, then compares all table fingerprints and verifies signer coverage. It never starts financial workers or signs/broadcasts transactions.

The fresh two-campaign fixture restored **61 tables / 137 rows**, preserving every table fingerprint and all eight signer approvals/fences. A deliberately rolled-back signer copy was rejected. Restoring the correct copy passed again. The temporary restore database was removed; private backup and checksum files remain outside source control.

Full bounded regression: **676 passed, zero failures or skips**, with PostgreSQL and media tools enabled. New tests cover terminal shadows, missing/reduced/shifted hourly charges, and multiple approvals at one timestamp. An actual completed on-chain fixture also passed the stricter admission check.

The first drill exposed a test-tool connection cleanup error after validation; the pool cleanup was fixed, the disposable database removed, and a fresh complete run passed. This was a harness issue, not lost source data.

## Limits and next gate

This is a stopped local snapshot/restore test, not continuous WAL/PITR, cross-region recovery, network-partition failover, or an externally immutable checkpoint. A coordinated rollback of both stores still needs external provenance and chain reconciliation. Hosted restoration must retain the exact signed packets, preserve paid entitlements, qualify clock bounds, and refuse signing until all recovery checks pass. No live database or funded program changed.

Against the ultimate goal, preservation and recovery improve to partial. Mixed-chain latency, hosted operating funding/providers, independent review and release activation remain open.
