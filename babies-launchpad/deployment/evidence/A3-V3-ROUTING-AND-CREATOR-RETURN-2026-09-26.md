# A3: explicit issuer routing and creator setup return

Local qualification, 26 September 2026. Not a production activation.

## Implemented

Registry schema 13 preserves grant IDs, ordering, revoked/expired history and
indexes while permitting an explicit issuer version 3. A current signing lease
must match the registered campaign version. The new registry signer selects its
configured version, never an inferred layout or a legacy fallback. Version 3
inherits only the already qualified keeper tags; setup return tag 27 is **not**
operator-grantable. Legacy deployment/program IDs are unchanged.

Lifecycle, recovery, fee and market services accept an explicit server-owned
`programVersion: 3`; omission retains version 2. Wallet configuration uses
`KIDS_PUBLIC_PROGRAM_VERSION=3` only alongside its exact new program and genesis.
Public activation remains localnet-only and wallet-pilot gated.

The creator receives a separate `Unused setup SOL` group in the existing claim
card. Availability comes from the canonical setup PDA and terminal campaign
state in a batched chain read. Unread balances remain unknown, not zero. The
button returns funds only to the recorded creator; it does not claim consumed
rent/fees are refundable. Participant entitlements remain separate.

The browser independently checks the new instruction's program, campaign,
authority, destination, genesis, exact shape and permissions. The wallet service
persists the approved packet and signed bytes before sending. Unknown submission
outcomes retain the same transaction across restart, rather than prompting a
fresh transaction.

## Evidence

- 292 focused tests passed, zero failures/skips, including real PostgreSQL.
- Migration tests preserve nonempty revoked grant history on SQLite and PostgreSQL.
- Scoped signer tests exercise both versions, current leases and revocation.
- Full v3 PostgreSQL + SBF validator rehearsal: 1 passed, zero skips (~88 seconds).
  Settlement, oversubscription/full refunds, interrupted worker recovery,
  permanent LP lock, participant/dev claims, swaps, fee collection/distribution,
  token-side burns and finalized market indexing all completed.
- Two genuine swaps indexed; fee/LP operations were not represented as trades.
- Separate v3 SBF setup-return test passed (~46 seconds), including the actual
  wallet prepare/independent decode/sign/journal/submit/status path. The creator
  received 2,000,000 lamports less its quoted network fee in that wallet test.
- Existing v2 program account AND program-data bytes/upgrade metadata remained
  identical through that rehearsal. This is local preservation evidence.
- Frontend production build passed. No hosted deployment was made.

Rendered flow: existing ClaimsSummary → Return SOL → disabled pending approval.
A temporary isolated component harness used the real component and project CSS
at `http://127.0.0.1:4298/`, 1280×900 and 390×844. Available, funding, unavailable
and zero-balance states were checked, plus page identity, nonblank render,
no framework overlay, console health and horizontal overflow. Screenshots were
visually inspected. Browser plugin unavailable; bundled Playwright with installed
Chrome was used (the matching bundled headless binary was absent). No dependency
was installed for this check. Harness wallet approval was a UI callback, not an
external-wallet extension test. Browser artifacts remain outside the repository.

Local issuer binary SHA-256:
`a5af979f601e051c7de0c104ddcdfab3ee8912295358f94f9b15e0105869c8da`.
Local program: `2T1K7xegEghMfR5RxtpJurG5bQhesHK6y8cvhpSos7CV`.
Local genesis: `7Sxh5h588K957C1to4Pvx6zQY6CLpghPCeG3ZeyrZJef`.
These are not mainnet deployment identifiers.

## Goal comparison and remaining work

Verifiable funds and preservation: **partial, improved**, supported by the
adversarial tests and actual chain reconciliation. Understandable participant/
creator recovery: **partial, improved**, with an independently checked return
and a separate visible entitlement. Complete creator journey and public
operating readiness: **not yet demonstrated**.

Durable media/mint creation, a qualified complete funding plan and ongoing
operational funding, external-wallet creation recovery, representative mixed
load, hosted pilot and independent security review remain release requirements.
The new return is one completed subflow, not a complete launch platform.
