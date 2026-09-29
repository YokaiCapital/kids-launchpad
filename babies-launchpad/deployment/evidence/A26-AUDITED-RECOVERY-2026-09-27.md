# A26: audited job recovery and durable funding evidence

27 September 2026. Isolated v3 only; no public activation.

## Recovery

The retained 100-campaign mixed fixture now completes: all 800 receipts verified, exactly 100 SOL accepted and 100 SOL refunded, all LP locks verified, zero outstanding signed packets and zero held operating exposure. Its 100 background pools have 100 finalized buys and 100 finalized sells; economic fee work drained, with only 100 aggregate lamports of rounding residue and no remaining token dust. It required diagnosis and restart. This is recovery evidence, not an uninterrupted close-capacity pass.

One prematurely exhausted refund job was explicitly requeued through the new private audited recovery function. Schema 38 preserves its exact old result, hash, fencing token, operator identity and reason. Compare-and-set plus a keyed database transaction permits one reviewed retry; stale, changed, wrong-scope, auth-failed, deadline-expired or pending-signed cases are refused. No financial packet, capability or balance is erased. No HTTP endpoint exposes this function.

The resume also encountered unavailable historical funding RPC data. A new read-only `credited` check verifies the persisted finalized proof, its exact funding intent and the corresponding atomic budget operation. It cannot create a credit; missing evidence still requires ordinary chain verification. This removes a needless restart dependency on RPC retention without trusting a balance alone. Backup provenance remains a separate gate.

## Capacity honesty

Reports now separate the closing window and job classes, including first-start-per-job quantiles, from overall queue history. Pre-close polling and repeated quick checks cannot dilute a delayed closing burst. Recovery reports are explicitly tagged. Newly signed attempts reset their own confirmation-check backoff without resetting actual transient failures.

The next fresh local profile prewarms two lifecycle and two recovery processes, with one each for provisioning, accounting, harvest and economics. Eight processes share the same signer and database; four execution slots per process. Lifecycle and recovery each reserve 60 RPC/s, the other four lanes 30 each: 240 total worker RPC/s. Signer evidence keeps its independent 30 RPC/s guard; signing and spend ceilings are unchanged. Interactive/indexing allocations and fixture traffic are additional, not silently claimed to fit a 240 RPC/s hosted plan. This is an experimental isolated capacity configuration, not a provider quota or production sizing claim.

See [private recovery operations](../decisions/FAILED-JOB-RECOVERY.md). Hosted composition, operating-funding policy, wallet/provider qualification, external recovery provenance and release review remain open.

Validation: 713 regression tests pass with zero failures/skips, including disposable PostgreSQL, concurrent recovery replay, stale-fence refusal, preserved failed results, funding proof/accounting consistency, packet-specific confirmation backoff, fixed replica/RPC bounds and undiluted close-window measurements. Real codec and database dump tools were enabled.

Follow-up restoration after schema 38: the stopped two-campaign fixture restored all 62 tables and 140 rows with matching table fingerprints, covering eight approvals and eight fences. A rolled-back signer journal was refused. No signed transactions were sent during restoration. External immutable checkpoint provenance and hosted PITR remain unqualified.
