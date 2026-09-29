# A19: terminal operator and operating-budget journals

Status: verified locally, not a hosted release approval.

## Problem and correction

The asynchronous v3 sender preserved the exact signed packet and workers correctly reconciled the on-chain action, but a handler that found its action already completed could leave its journal row marked signed. Budget shadow packets had the same terminal bookkeeping gap. This could mislead operators and complicate recovery despite completed transfers.

Unknown outcomes now carry the exact operation/attempt reference. Reconciliation checks that reference, signature, pinned program and genesis against the persisted row, uses the persisted validity window, and records chain-proven terminal outcomes. Finalized-mode workers continue to wait through merely confirmed evidence. Budget shadows become terminal only after the existing complete transaction/cost proof verifies; spend settlement remains exact-once.

## Verification

- Full regression: 674 tests passed, zero failures or skips, concurrency two with PostgreSQL and media tools enabled.
- Fresh isolated-chain smoke: two campaigns, eight receipts each, canonical 2.5% Raydium tier, six financial worker processes sharing one database and signer. Workers started before the common close.
- Both launches and permanent locks verified; all 16 receipts reconciled; exactly 2 SOL accepted and 2 SOL refunded; zero outstanding operating holds and zero signed operator/budget packet rows.
- Queue p95: lifecycle 278 ms, recovery 191 ms, provisioning 226 ms, accounting 248 ms, harvest 46 ms, economics 79 ms. Elapsed 284,764 ms includes waiting for the scheduled close and finality.
- Tests reject wrong attempt, signature and program references and verify confirmed-before-finalized handling for SQLite and PostgreSQL.

Private logs and generated fixtures remain outside version control. The older A18 fleet's historical signed rows are not silently rewritten by this change; new verified outcomes close their own journal entries. The smoke does not establish mixed-load or hosted capacity.

## Ultimate-goal comparison

Financial recovery observability improves without changing contracts or existing economics. Mixed simultaneous-close/trading/fee capacity, hosted isolation/providers, restore and release gates remain open. Public activation remains disabled.
