# A8: shared launch-allocation discovery

Date: 27 September 2026. Scope: isolated Standard v3 local rehearsal only.

## Result and boundaries

Portfolio pages now discover participant receipts and creator/dev allocations from a shared PostgreSQL index, independently of website transaction history. Each page returns at most 20 scoped campaign identities; current balances and available actions still require authenticated, finalized wallet reads. This discovery index never grants transaction authority.

The index does **not** claim to discover arbitrary transferred tokens or holdings acquired elsewhere. Portfolio copy explicitly identifies this limitation and reports incomplete/stale campaign coverage. Existing Family programs and funded coins are unchanged; hosted/public activation is still disabled.

## Implementation

Schema 32 adds immutable wallet/campaign receipt membership and fenced snapshot cursors. A signer-free indexing job reads the finalized campaign and chain clock together, verifies program/PDA/genesis identity, enumerates receipt accounts only when the count changes, verifies each receipt and then rechecks the count. Concurrent commitments, truncated enumeration, stale providers and identity mismatch fail closed. A quiet refresh does not repeat program-account enumeration. Enumeration is bounded to 10,000 receipts per campaign; this is an explicit qualification limit, not unlimited scale.

Snapshot publication, lease/CAS checks and the next job are atomic. Newly discovered receipts insert in bounded batches; lost workers cannot advance a cursor. The API binds discovery to the authenticated wallet, with keyset paging and no RPC scan for each visitor. Browser detail reads are bounded to four at once, preserve registry order despite out-of-order responses, and cancel on scope change. Unknown records remain errors rather than zero balances. Read jobs may be scheduled on verified registration without activating any financial job or budget grant.

## Verification

- Full bounded regression: **614 passed, 0 failed, 0 skipped**. Focused order/abort checks also pass after the deterministic-order fix.
- Enabled production bundle builds successfully.
- Browser checks: 65 campaigns, indexed positions beyond the first 24, creator pagination, partial coverage, wallet switching, StrictMode and 1440/768/390/320 widths; no observed horizontal overflow or console errors. Mock handlers can finish after client abort, so this is not a server throughput claim.
- Actual owned-validator read-only qualification, via `localnet/market/qualify-positions.mjs`: genesis `7Sxh5h588K957C1to4Pvx6zQY6CLpghPCeG3ZeyrZJef`, program `2T1K7xegEghMfR5RxtpJurG5bQhesHK6y8cvhpSos7CV`, campaign `A8ZJ6FGCS1jYJWwvYvibXpqS8g79bgzk36Z78k3W7yca`, finalized observation slot 120118. One actual receipt was discovered without website history; coverage complete for the one registered campaign; fresh store/restart preserved membership. No signing or hosted changes.

## Ultimate-goal comparison

Understandable participant access and bounded shared reads improve, but remain **partial**: offsite token-holding discovery, global directory ordering, full creator operating-funding composition, representative mixed-chain load, hosted wallets/providers, restore/monitoring and release/security qualification remain. This evidence does not declare production readiness.
