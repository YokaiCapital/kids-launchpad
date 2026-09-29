# Bounded signer lookup, 26 September 2026

The registry-backed v2 signer previously loaded every stored capability before filtering
by ledger/program. It now receives the requested campaign from the signing endpoint and
selects exactly its newest grant with `LIMIT 1`, scoped by genesis, program and campaign.
Migration 9 adds an index ordered by those fields and descending grant time/ID.

Revocation and expiration are deliberately checked after selecting the newest row.
Filtering them out in SQL would resurrect older permissions. The existing active-lease
check still revalidates current grant, lease, operation key and fencing token against
database time before signing. Existing Map providers and zero-argument callback providers
remain compatible. No signer quotas, spend limits or mainnet configuration changed.

Verification: **161 focused tests passed, zero failures/skips**, including actual
PostgreSQL. A separate legacy signer/operator regression suite passes **34 tests,
zero failures/skips** (`/tmp/kids-signer-legacy-regression.log`). The signer integration
test forbids any full capability-list call, proves
exact scope selection, then verifies that a revoked or expired newest grant is refused
even when an older valid grant and live job lease exist. SQLite parity checks cover the
same latest-row semantics. The source pattern scan checked 720 files with zero findings;
that is not proof of the absence of all secrets. Schema 9 was applied only to isolated
test schemas. Hosted release must migrate before starting schema-9 workers/signers.

This removes a per-request operation whose cost grew with every campaign's grant history.
It does not establish fleet throughput, signer HA, provider capacity or public readiness.
The single-owner signer volume and the remaining release gates still apply.
