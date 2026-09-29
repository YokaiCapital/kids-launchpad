# A17: bounded operator confirmation and strict recovery finality

## Finding and change

A restarted durable sender previously treated a `confirmed` signature or cached journal row as success even when the caller required `finalized`. The chain adapter's reconciliation API also passed that weaker verdict to jobs. Both now honor the caller's requested level. A cached confirmed result cannot permit a fresh packet while finality is unresolved.

New v3 rehearsal workers wait at most one second after broadcast before returning the original signature as unknown and releasing their execution slot. The SDK subscription is aborted, the timer/listener is cleaned up, and the persisted signed bytes remain authoritative. Later jobs reconcile that same signature before any replacement. An elapsed wait is neither failure nor permission to rebuild. Existing worker versions retain their unbounded confirmation-wait default; program binaries and funded campaigns are unchanged.

## Validation

- Full joined regression: **660 passed, zero failures or skipped tests**.
- Shared SQLite/PostgreSQL crash tests cover confirmed-but-not-finalized recovery, cached weaker results, bounded subscription cancellation, exact signature retention, no additional build/sign/broadcast, and eventual finalization.
- Chain-adapter test confirms finalized jobs return unresolved for merely confirmed signatures while confirmed consumers retain their existing semantics.
- Invalid wait bounds fail before signing. Existing packet persistence, expiry, fencing and concurrency tests continue to pass.
- Private test log: `/tmp/kids-bounded-release-regression.log`.

## Limits and next gate

The 100-campaign isolated-chain fleet is using this implementation; its capacity result is recorded separately after completion. This checkpoint fixes finality and slot occupancy semantics, not a throughput guarantee. Mainnet activation remains off. Hosted provider, funding, wallet, mixed-load, restore and release qualification remain required against the integrated plan's ultimate goal.
