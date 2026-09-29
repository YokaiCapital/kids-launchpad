# Chrome production readiness review — 28 September 2026

Verdict: not ready for a public opening. Inspected the owner's signed-in Chrome session at the local pilot UI, backed by the hosted mainnet pilot. No wallet transaction was approved during this review. This is a targeted product and source review, not a security audit or a complete wallet qualification.

## Journey and evidence

Screenshots are retained in the local owner review folder, not shipped as public repository assets.

1. Create form: four form pages, disabled Family option and technical copy obscure the primary task. Evidence: 04-chrome-creator-form.png. Needs a compact creation form with optional profile settings.
2. Wallet: incorrectly labelled localnet on the mainnet pilot. Fixed to use the site network; verified in Chrome, 06-chrome-wallet-network-fixed.png.
3. My launches: four setup drafts with no abandonment action; artwork was not passed to the thumbnail component. Thumbnail wiring fixed. Safe cancellation and reservation recovery remain open. Evidence: 05-chrome-my-launches.png.
4. Portfolio: zero positions; dense reconciliation terminology. No evidence of lost balances. Evidence: 07-chrome-portfolio.png.
5. Explore: five imported/test entries unavailable, several unnamed, with zero-looking funding bars despite unavailable live totals. Needs explicit unavailable values, usable names/accessibility labels and deliberate test-content visibility. Evidence: 08-chrome-explore.png.
6. Coin detail: View updated the URL without updating the reader subscription, leaving a skeleton. Once navigation was fixed, unavailable funding crashed the page through BigInt(null). Both fixed; unknown balances remain unknown and the page offers Retry. Evidence: 09-chrome-coin-blank.png is the loading skeleton before repair.
7. Creator progress: owner screenshots show four approvals before publication, nine internal stages, a narrow left-column card, two competing retry buttons and a raw timeout. Fixed: server supplies creation mode before publication; progress uses one compact card, no stage list or approval counts, one retry button and collapsed support details. A confirmed transaction is distinguished from finalized bookkeeping.

## Confirmed publication delay

Request 3805324c-b5b9-46ec-8d7b-2836be6b0d19 uses mint intent version 2 (one transaction), checked read-only in the hosted database. Image publication took 8.896 seconds, document 6.035 seconds and banner 7.685 seconds; total 22.656 seconds from first publication start to banner completion. The browser account request timeout is 20 seconds. The timeout did not prove publication failure: all three receipts were published and the plan was sealed.

Independent media now publish concurrently, retaining owned-media checks, immutable receipts and per-operation quota accounting. Metadata still depends on the image URI. Creator prepare returns pending after a 1.5-second publication wait and subsequent requests join the existing work, with a one-second UI polling delay. This avoids abandoning a healthy upload solely because the browser timeout is shorter than publication.

The owner's target is one transaction, 1–5 seconds, maximum 10 seconds. That target is NOT verified for hosted creation. The old measured image-plus-document dependency alone took about 15 seconds. Fast launch needs publication ready before the final launch click, or a measured faster publication path. A compact screen and responsive polling do not establish the target.

## Additional recovery repairs

Passive status refresh no longer clears a stopped/uncertain flow and triggers another wallet prompt. Recovery of the single launch transaction passes the prior signature to the recovery service. Signed-packet resubmission still uses identical bytes. An approved packet held only in browser memory can still be lost by closing the tab before server acceptance; durable recovery of that window remains open.

## Public-opening blockers

- Prove the owner-wallet single-transaction success path and failure/refund lifecycle on mainnet; exercise wallet fee changes and approval expiry without weakening transaction checks.
- Meet and measure the creation latency target, including publication, time to prompt and confirmation separately. Human wallet decision time is a separate measurement.
- Add a safe abandoned-request lifecycle. expireReserved exists but no runtime caller was found; do not release ambiguous or signed reservations.
- Complete public edge routing for creator/upload/media endpoints; current pilot routing is separate.
- Isolate media decoders from root privileges and sensitive service data (existing application review L2).
- Finish credential rotation, custody decision, external review, alert delivery drill and hosted backup/restore drill from the release checklist.

## Validation and scope

Automated regression suite: 429 passed, one optional media-transcode test skipped. Public build and nine Rust tests pass. Full HTTP rehearsal and release status are recorded separately after completion. Desktop Chrome was inspected; mobile, full keyboard/screen-reader coverage and actual extension signing were not qualified here.

Implementation follow-up: A40-CREATOR-LAUNCH-RELEASE-2026-09-28.md records the approved single form, durable queue, explicit prepublication, exact-packet reload recovery, automatic activation and edge routing changes. The findings above describe the audit checkpoint.
