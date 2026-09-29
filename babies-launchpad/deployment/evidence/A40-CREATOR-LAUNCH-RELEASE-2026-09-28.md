# Creator launch simplification — 28 September 2026

## Scope and current qualification

This release implements the owner's approved launch-flow changes. It does not establish a public-opening approval or a hosted latency result. The wallet-restricted mainnet pilot remains restricted. The on-chain program and sealed financial terms are unchanged. Registry schema 40 adds off-chain continuation and publication preparation records.

## Implemented behavior

- One creation form with image, name, ticker, optional description, launch size and the full cost. Socials, optional media, allocation and scheduling are collapsed. Images are automatically cropped; schedules use the browser's local timezone and persist UTC. Drafts save automatically without retrying failed saves indefinitely.
- An explicit permanent-publication checkbox can prepare the name, ticker and image before the final Create click. Private uploads remain private before that consent. The original consent and draft revision are persisted. Editing publication fields clears consent; previously published copies remain permanent.
- Prepared image/document receipts are reused only for the same owner and exact content hash. Acceptance during an unresolved upload reconciles the original provider operation instead of posting again. A changed name creates a new document. No publication receipt is treated as a wallet approval.
- Accepted creation is atomically enqueued. A server coordinator reserves, publishes, waits for the wallet, resumes the approved packet, registers finalized evidence and credits the reserve. Work leases have fencing tokens and expire after worker loss. Repeated non-wallet failures pause for an explicit retry.
- The wallet sees the existing version-2 compact launch packet: one approval, two required signers and eleven instructions. Independent reconstruction, account binding, economic checks and signature/message restrictions remain in place. Near-expired unsigned offers are refreshed before prompting.
- Already approved bytes are stored in IndexedDB, scoped to network, program, owner and request. Reload validates the stored offer and message before resubmission. Web Locks prevent simultaneous wallet prompts across same-origin tabs. No wallet key or session credential is stored there.
- A confirmed coin view appears before final registration. Automatic activation requires finalized registration, the creation-bound reserve credit, the configured creator and treasury, the Standard v3 mode and adequate operating funds. It uses the existing restricted keeper grant and lifecycle scheduler. Registration is not inferred from a timeout.
- Banner/video/poster publication completes after creation and activation. Supplemental media can update only the original approved profile; it cannot undo moderation or overwrite a later profile revision.
- The public edge allowlist now forwards creator, trade and read endpoints, bounded image/video uploads and private media reads. Session, origin, CSRF and backend authentication boundaries remain enforced. Hosted video input is capped at 4 MiB for this edge path; larger/direct-to-storage video uploads need a separate implementation.
- Fixed coin navigation subscriptions, the unknown-total BigInt crash and draft artwork thumbnails. Unknown chain balances stay unknown.

## Verification

- Required creator/protocol/UI suite: 438 tests, 437 passed, one optional media-transcode test skipped, zero failures.
- Additional regressions cover owner/receipt reuse, acceptance during publication, changed metadata, optional media deferral, moderation preservation, exact approval recovery after reload, concurrent tabs, fresh blockhashes, server queue restart/replicas, activation funding/binding and paused continuation recovery.
- Public frontend build and all nine Rust contract tests pass. The broader application/hosted/protocol checks passed 617 tests with four optional skips and zero failures; the later startup write-gate change also passed its targeted hosted/coordinator regressions.
- Edge tests: 14 passed, including creator forwarding, bounded binary uploads, private response headers and origin/allowlist rejection.
- Chrome: inspected the owner's signed-in session, verified the single form and empty-field errors without creating a mainnet launch. Responsive inspection at 390 CSS pixels found no horizontal overflow. No wallet approval was performed.
- The first isolated HTTP run reached a funded one-transaction creation and service-restart recovery, then failed its obsolete immediate-banner assertion. That run is not counted as a fully passed rehearsal. The updated rehearsal passed: one approval and one transaction, 3.899 seconds from prepared Create to confirmed, 2.242 seconds from approval to confirmed, 17.439 seconds from approval to finalized registration/reserve credit/activation, and successful service-restart recovery. It used the local validator, an owned test key and synthetic publication receipts; it is not a hosted or extension-wallet benchmark. See `A40-LOCAL-REHEARSAL-2026-09-28.json`.

## Performance acceptance

The previous hosted image/document/banner sequence took 22.656 seconds; image plus document alone took about 15 seconds. This release moves explicitly approved core publication before the final click and removes optional media from creation. The latency target is 1–5 seconds, with a 10-second ceiling for the confirmed coin view after a prepared Create click, excluding the creator's wallet decision time. Cold artwork preparation, quote/prepare time, wallet decision, submission/confirmation and finalized activation must be measured separately. No hosted percentile or extension-wallet result is asserted by unit tests or synthetic publication receipts.

## Release and remaining gates

Implementation commit `ff31e2d3656064c46ef1229032900d1749b22d7d` deployed to all nine pilot services with SUCCESS. At 18:17:46 UTC the API reported ready, writes open, schema 40, every release check true and no alerts. All five existing accepted creations resumed to the wallet boundary with no approvals manufactured. Chrome received the new preparation capability and retained the owner session.

CI found a signer test fixture still pinned to schema 39; the follow-up uses the release schema constant and reruns the full shared-state suite. The hosted restore drill did not pass: PostgreSQL client 17.11 is older than server 18.6. The failure handler also exposed a private connection string; its diagnostic now emits only bounded categories. The local captured log was redacted, and the exposed database credential must be rotated. Matching client tools and a successful hosted restore remain required. No restored-database success is claimed.

Required precommit checks plus the restore regressions: 440 passed, one optional skip; frontend build and nine Rust tests passed. The corrected full shared-state suite passed 593 tests with one optional skip and zero failures. The follow-up deployment and CI result will be recorded on the pull request.

 Before public opening: prove the real extension-wallet success path, measure hosted cold and prepared timings, complete the success and refund lifecycle pilots, safely reconcile abandoned unsigned reservations, close the media-decoder isolation finding, and complete the existing custody, credential, external-review, backup/restore and alert-delivery gates. These remain explicit release requirements.
