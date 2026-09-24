# Local prototype validation — 19 September 2026

Working directory: babies-launchpad/interaction-review. Local Vite preview: http://localhost:4175/. Public launches remain closed. No real wallet, API, mint, pool, signature or deployment was used.

## Completed

- Existing empty scaffold continued; original assets copied, not overwritten or regenerated.
- 248 synthetic candidates, full-set search, parent filters, stable session-seeded Discover, New and Most voted, 28 pages.
- Selection distinct from accepted vote, review dialog and illustrative receipt. A failed replacement retains the prior accepted choice.
- Three-step submission with duplicate-parent rejection, editable character fields, sample art/upload control, local draft autosave and message-signing explanation.
- Demo submission status, correction feedback and resubmission path; upcoming, skipped/result and allocation explanatory states.

## Browser checks actually performed

Reviewer in-app browser at 1488×1058 and 390×844:
- Selected Sprout 97, went to final page: selection retained, final five entries accessible, Page 28 of 28.
- Selected final-page Fizz 82 and recorded a demo vote. Chose Nib 81; simulated offline acceptance failure. Fizz 82 receipt remained unchanged.
- Searched KID248 from another page; returned Miso 248 while previous selection remained.
- Selected identical parents: rejected with fields retained. Corrected to ALPHA/BETA and completed character/review.
- Draft survived page reload/HMR and was recovered as Sprout. Submitted demo proposal and opened actionable Changes requested feedback.
- Zero-power scenario disables simulated signing. Closed scenario rejects late acceptance.
- Mobile: 390px document width equals viewport width. Review bar ends at 784px and navigation begins there, ending at 844px; no overlap between persistent controls. Native review dialog remains readable.
- Escape closes review; after correction, keyboard focus returns to Review vote.
- Browser dev log query returned no warnings or errors.

## Automated checks

`npm run build` passed. `node --test tests/ballot.test.mjs tests/sites-worker.test.mjs`: 9 passed.
Tests cover full candidate cardinality/last page, off-page search/parent filtering, deterministic shuffle and full eligibility, ordering, turnout conservation, static worker behavior and expected packaging artifacts.

## Boundaries and remaining work

See design-qa.md: visual gate remains blocked. Today and Archive are explanatory navigation stubs, not final views. Six repeated sample artworks do not validate recognition across hundreds of unique kids. Parent mint lookup, direct links, real moderation and receipt verification are not implemented. Submission/accepted-vote history is session state; only the draft persists locally. Uploaded-file error paths exist but were not browser-tested. 200% browser zoom, screen-reader testing, actual user comprehension, all failure permutations and real network recovery remain untested.

Economics was not requalified in this pass. Existing SDK arithmetic and documented limitations remain authoritative; no chain graduation, final-fill, fee or claims rehearsal occurred. Do not raise its 7.5 design-stage score on this evidence.

## Visual refinement continuation

The next visual step is complete, with scoped visual QA in design-qa.md. The former report is preserved as design-qa-initial.md.

Added source-derived KID, family and wordmark assets; variable typography; complete Today presentation; mobile wallet and filter sheets; accessible review bottom sheets; route-bound proposal links; local demo receipt and proposal persistence; Most voted ordering includes accepted demo weight. The old statement that only drafts persist is superseded by this continuation.

Verified in Chrome at 1488×1058, 390×844 and 320×740 after in-app screenshot emulation became mis-scaled. No horizontal overflow at the two mobile widths. BETA filtering yielded 124 records; reset showed 248. Saved receipt survived reload. K009-248 deep link survived reload and showed the correct frozen proposal. Wallet sheet reached allocations. Escape restored focus to Review vote. App-filtered console logs were empty; unfiltered logs contained unrelated installed-wallet-extension errors.

Build passed; 10 model/worker tests passed including the new replacement-weight ordering check. Public launches remain closed. No economics qualification, real signing, deployment, real mint lookup or claim rehearsal was performed. This step does not certify all areas above 9.

## Continuation — 19 September 2026

- Build passed; all 14 Node tests passed, including malformed stored state, review-stage validation, canonical frozen vote recovery, failed replacement preservation and retry idempotency.
- Browser verified sample-parent search, unknown result, duplicate-parent disabled choice; draft restoration; submit receipt; corrections resetting permission, resubmission retaining ID; approval frozen for round 010 without changing round 009's 248 entries.
- Mobile browser verified review/acceptance and repeat acceptance with unchanged receipt. Parent sheet visually inspected at 390×844; document/dialog widths also checked at 320×740. No horizontal overflow. Localhost warning/error log empty. Browser's unrelated extension errors excluded as in prior QA.
- Evidence: `evidence/v6-parent-picker-mobile.png`.
- Scope limits: parent lookup remains four explicitly labeled samples, not chain mint verification. Submission history is a single local proposal; frozen edits are disabled. No backend, moderator auth, real signature or production state machine is implemented.
- Economics now has 36 passing offline final-fill quote cases and an isolated pinned dependency lock in `../docs/kid-fun-v4/qualification/`. This is not a transaction simulation or launch qualification.

## Live mint lookup, version history and simpler home — 19 September 2026

Build and all 20 Node tests passed. Added exact integer supply/threshold, invalid/unsupported mint response checks, finalized read-only RPC request, real-parent draft persistence, immutable approved versions and independent proposal IDs. Existing ballot and Sites packaging tests remain intact.

Browser through CUA/Chrome: 1488×1058 and reference-sized 1776×1268 desktop; 390×844 mobile; 320×740 no horizontal overflow. Real USDC mint lookup returned finalized mainnet supply/slot with exact 0.05% threshold. Selected and submitted a real-parent draft, approved v1 locally, changed the name and submitted v2; both survived reload with v1 unchanged. Invalid address message and duplicate selection disabled verified. Mobile live-mint sheet inspected. Homepage Explore KID modal and roadmap scroll worked. Localhost console warnings/errors query empty; unrelated wallet extension logs remain excluded.

Evidence: v7-home-desktop.png, v7-home-reference-size.png, v7-home-mobile.png, v7-live-mint-desktop.png, v7-live-mint-mobile.png, v7-history-desktop.png.

Limits: real lookup is a local read-only service, not hosted backend; Token-2022 selection unsupported; mint address is authoritative identity, metadata/name endorsement not provided. Approval and ballots remain local simulations. Supply refreshed on submission is observational, not the future eligibility snapshot. Full execution, signatures, claims and screen-reader testing remain open. See ../docs/kid-fun-v4/SCORECARD.md and qualification evidence.

## Localnet and operator pass — 20 September 2026

- Validator isolated at 127.0.0.1:18999; verified four SPL mints, each 1 billion supply, six decimals.
- End-to-end round `verify-1789866230293`: two separately authenticated wallets submitted distinct proposals; operator approved both; finalized RPC snapshot froze two candidates; both signed votes; turnout 2,000,000 KIDS; quorum reached; finalization returned `elected-pending-launch-checks`.
- Auth tests reject incorrect signer, expired/reused nonce, cross-wallet proposal modification and unauthorized moderation. API checks reject missing CSRF, cross-origin requests and legacy moderation bypass.
- Browser: Alice sign-in persisted after reload; admin chain check verified all mints; configuration save displayed success. Admin checked at 320, 390, 768 and 1440 pixels; no horizontal overflow. Fixed inherited mobile navigation styles that initially pinned admin tabs over the main navigation.
- Regression suite: 39 tests passed (frontend/storage/identity/config/protocol/HTTP/Sites). Production frontend build passed. No mainnet or devnet writes.
- Incomplete: the SHART preview commitment/refund controls are not on-chain. Escrow, liquidity deployment, funded claims, production admin authorization and production hosting are not qualified. Do not infer launch readiness from the passing governance checks.
