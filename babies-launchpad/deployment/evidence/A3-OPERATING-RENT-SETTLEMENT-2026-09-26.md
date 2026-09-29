# A3: actual fee-state rent settlement

Added an exact v3 fee-state initialization cost model. Its durable packet must
reconstruct the single reviewed instruction, operator, payer, campaign and
program. Finalized balance evidence must reconcile network fee plus rent into
the derived fee-state PDA; unrelated movements, payer income, excessive rent and
failed transactions with rent movement are refused. Prefunded accounts charge
only their actual top-up. Failed execution charges its network fee only.

Durable packet reads now have the same bounded timeout as RPC proof reads.
The new signer also rejects unqualified Token-2022 ATA rent templates and uses
live classic-account rent when it exceeds the legacy static estimate. Existing
Family/legacy signing paths are unchanged.

## Actual-chain qualification

`qualify-operating-rent.mjs` checks the owned local validator, v3 deployed binary
hash, existing test campaign's live state and its sealed test treasury. It creates
the previously absent fee state, without starting fee workers or changing launch
terms. An isolated PostgreSQL schema records the test transfer and cost hold.

- Local campaign: `3XUDtU2f7jVmvEEx8MqUK7HSLAhDBSPHjzmiomCgu8ez`
- Funding: `54DvJRbNCKM6HyEBcBHEzUFYQEwHNd8ekcyFvL6iBJRZtAcGxzEEcbXDeWSKkbqgDrVQW1KWeXhkxqvBLDRgWFtH`
- Fee initialization: `5gjiv9DcYXotDqrgw4vfozhEjkccSkjSTGzMCoUL6Y9uK8N8P1ZVVnKNnKFtcwjLXQPHPMcszePr8xBsMwhqcbdV`
- Funded: 3,000,000 lamports; actual rent: 2,004,480; actual fee: 5,000.
- Spent once: 2,009,480; held after finality: zero; available: 990,520.
- Fee-state owner, size, rent balance and operator independently read back.

An initial local harness submission used a confirmed blockhash with finalized
preflight and was refused before broadcast. Matching preflight to the blockhash
commitment fixed the harness; subsequent execution and finality checks passed.
No public RPC, mainnet wallet, hosted funding flow or deployment was used.

## Validation and remaining scope

443 regression tests pass with PostgreSQL and restore checks enabled, no skips.
This verifies fee-only and fee-state-rent accounting. Full LP-lock rent settlement,
signer-to-budget coupling, funding/custody policy, full authenticated creator flow,
external wallets and workload/release gates remain outstanding. Against the
ultimate goal this is **partial operating-lifecycle qualification**, not public
production readiness. Exact-cost decoders must precede release for other cost types.
