# A3: funded Standard fee activation and recovery

27 September 2026. Isolated v3 Standard work. No hosted deployment, public enablement, program upgrade, or change to funded coins.

## Implemented transition

Fee setup can now opt into a private activation coordinator through the provisioning worker's explicit `feeActivation` configuration. Omission preserves the previous setup-only behavior. The configuration must name the operating policy and a positive minimum available reserve; there is no default economic amount. Only the existing loopback/localnet-rehearsal worker composition accepts it.

The setup job schedules one stable activation job. That job waits for its exact predecessor to complete with verified custody, then reads fresh finalized fee-state and token-account evidence. It checks the isolated ledger/program, registered v3 Standard campaign, sealed terms hash, treasury payer, exact setup recipients and current unrevoked/unexpired setup grant. Pending operating holds reduce the reserve available to activate.

One PostgreSQL transaction, fenced by the current job's locked row and the database clock, performs all three writes:

1. Replace setup rights with a keeper grant limited to refunds, harvesting, distribution and child burns: tags `3,21,23,26`.
2. Seed the independent `fee-harvest:0`, `distribution:0` and `token-burn:0` chains.
3. Record immutable activation evidence in schema 25.

The grant retains the setup grant's explicit expiry and any stricter limits. It cannot mint, change recipients, rotate the operator, withdraw principal, or perform parent swaps. A later revocation, expiry or replacement is not automatically undone. Crash recovery reads the activation record and cannot grant or seed again. This is database coordination, not a new program or source of custody authority.

Insufficient operating funding now has a specific v3 signer response. It issues no signature. The worker retains the same job, waits 30 seconds without consuming failure attempts, and resumes after funding is verified. Generic authorization failures, malformed packets and stale leases do not gain this behavior. Unknown signed transactions still reconcile their original identity before anything else.

## Recipient-account recovery

A dev or treasury owner can close their own wrapped-SOL payout account when unwrapping SOL. Repeated operator-funded recreation would allow repeated rent reclamation. Distribution therefore checks the canonical payout accounts only when a new economically useful payout is needed. A missing account defers payout, preserves the earned entitlement in program custody and records the owner, exact ATA and WSOL mint for owner-funded restoration. It schedules another check without spending rent or exhausting a retry chain. Harvest and child burns remain independent.

An existing pending/signed packet is reconciled before this repair check. An account with altered ownership, mint, delegation, freeze/native state or close authority fails closed rather than receiving a payout. Restoring a valid account allows the next check to resume. The management UI and wallet approval for owner-funded restoration are still an open delivery item; the backend does not claim that a missing account was repaired.

## Evidence

The bounded regression passes **512 tests, 0 failures, 0 skipped**. Focused tests include:

- Queue-write failure rolls back the new grant, activation evidence and all three seeded jobs.
- Restart after the atomic transition, before job completion, grants and schedules nothing twice.
- A revoked grant is not resurrected, and stale job fencing prevents activation.
- Insufficient reserve, existing pending holds and missing custody prevent activation.
- Two four-slot provisioning runners activate 100 PostgreSQL fixture campaigns, produce exactly 300 independent fee jobs, and leave 100 lifecycle jobs untouched. This is a database concurrency fixture, not a 100-coin live-RPC capacity claim.
- Repeated funding shortfalls preserve one resumable job; only the exact v3 funding response receives that treatment.
- Missing recipient accounts spend no rent, preserve repair details and do not stop collection/burns. Restored valid accounts resume payouts.

Actual local-chain activation passed on genesis `7Sxh5h588K957C1to4Pvx6zQY6CLpghPCeG3ZeyrZJef`, v3 program `2T1K7xegEghMfR5RxtpJurG5bQhesHK6y8cvhpSos7CV`, campaign `2eRimL3gUu5CKgGoZVNCBZZ1WEqWaE2WasBEthj5mfbE`:

- Lock transaction: `47Mr4Ke5fTiJdZPty8HM2bXdRodUhKcKAJ4GCM7gEL2piaELcy81X6kBFWsPWpsDqj4WUrLkZxDdz2CTZ7eoEPQz`.
- Fee funding transaction: `4W4LT8rErPsoR1fGM7K2VPaZEG7tr4HqiEBNdWma5hUmyYyxyv5EVjFZthoASedtCFefy5rKdAmKHADTFM2Svv1c`.
- Fee setup transaction: `3zGswCSgnaZVyxwQkHqjtVj3F6wvFTQRTtUtTvvYHpKMt6Pr4aSToybaFvEbf5BNddVVJDhwGoJqQXXwBiVMLGTL`.

The rehearsal refused unfunded signing, interrupted after durable signature persistence, resumed the same setup packet once, reconciled 6,088,040 lamports of rent/network cost, verified four canonical token accounts, activated the exact keeper tags and queued the three independent fee chains. The full 1 SOL participant refund liability remained in custody. Private packets, state files and local key material are outside tracked source.

A subsequent joined worker rehearsal passed on fresh campaign `Aw8gWtr8ZZpwMq6nb61txgg77GeNg6Vdxr3pRpi8qgcr`. Its fee setup transaction was `2QV5wz9TABYzy2r19QHq5Ub2XEfRkcWqNXa9ub9vchUYzheW7Uv8ccqQPp953ogpakrwk68u42D4mHocoe87S5Rg`. After activation, actual harvest/economics workers inspected the fresh pool, deferred all three dust operations and scheduled their successors without pointless transactions. The separate recovery worker then returned the full **1 SOL** excess to the original participant using the activated grant. Accounting reconciled its additional **5,000 lamport** network fee. The 12,000,000-lamport operating fixture ended at **6,093,040 spent, 0 held, 5,906,960 available**. No refund principal was booked as operating revenue or cost. This proves actual worker startup and refund continuity; it is not a positive-volume fee collection or production capacity test.

## Configuration and release limits

Private configuration adds `feeActivation: { policy, minimumReserveLamports }` to the explicit v3 provisioning worker. The policy must match that campaign/payer's funded ledger. This does not charge a creator, transfer any funds or select who ultimately bears ongoing costs. Creator-paid quoted setup with KIDS-funded ongoing operations remains a proposed business policy until selected and qualified.

Migration 25 must run before these worker binaries start; autoscaled workers do not run migrations. Keep a single writer for the existing signer state volume. Use shared provider admission across all replicas and reserve independent capacities for provisioning, accounting, lifecycle, refunds, collection and economics. Rehearsal admission limits are not production sizing evidence.

The grant lifetime is not extended automatically. Deployment needs explicit grant renewal/revocation operations and alerts before expiry. Low funding, missing payout accounts, denied custody evidence and uncertain signatures must be visible in monitoring and management; they must never silently become successful transactions.

Ultimate-goal comparison: verifiable money, sustainable fee operations, reliable concurrency and recovery remain **partial**, with stronger tested behavior. Complete creator-to-lifecycle funding/bootstrap, full management/repair UX, real external wallets and providers, mixed-workload/restore drills and security/release review still prevent public readiness. Existing Family and funded Standard launches remain unchanged. Direct recycling and Auto MM are still separate disabled versions.
