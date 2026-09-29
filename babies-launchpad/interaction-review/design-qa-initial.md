# kid.fun interaction review — visual gate

final result: blocked

This is a working interaction study, not the final visual implementation. Do not replace the current v4 visual references with this prototype or raise the overall design score based on a successful build.

## Evidence

Source visual truth: ../docs/kid-fun-v4/02-full-ballot.png and 03-submission-review.png; Today source: 01-today.png.
Rendered evidence: evidence/desktop-ballot.png, evidence/desktop-submission.png, evidence/mobile-ballot.png, evidence/mobile-vote-review.png.
Desktop CSS viewport 1488 × 1058, screenshots 1488 × 1058; source ballot 1488 × 1058, source submission 1488 × 1059. No density resampling. Mobile 390 × 844 at 1×.

Source and implementation images were opened together in the same comparison tool response, first for ballot and submission, then again for the revised ballot. Full-resolution text was readable; the full-view comparisons sufficed for component typography and spacing review without an additional crop. No pixel-perfect match is claimed.

State: desktop ballot page 1, Sprout selected but not submitted. Source uses Discover; implementation uses Most voted to put the six original example records first. Source bottom-row identities are not available as standalone assets. Submission uses Sprout, ALPHA/BETA, Review. This data/order difference is intentional for the interaction test and prevents claiming exact reference parity.

## Findings

- P1, Today: the standalone original KID mascot is not integrated into this prototype. The existing source remains the approved visual direction; the text-only Today route is a navigation stub. Finish this using the original identity, never substitute Sprout for KID.
- P2, brand/typography: the current text wordmark is narrower and lighter than the reference. Space Grotesk is reused from the existing project, but display typography and submission heading hierarchy remain below source fidelity. Integrate the approved wordmark asset and align display weight/width.
- P2, submission illustration: the original family composition includes both parent artworks around the child. Current review reuses the available single Sprout asset and shows parents as text. Restore the family composition with corresponding assets before visual sign-off.
- P2, assets: 248 synthetic records deliberately reuse six saved characters. Suitable for pagination stress testing, insufficient evidence for recognition and discoverability across hundreds of distinct proposals. Dot/Bean/Zig assets are absent.
- P2, scope: parent lookup uses example dropdowns, not the specified name/mint search or identity evidence. Proposal deep links, wallet switching, full lifecycle states, and a mobile wallet menu remain to be prototyped. These are not implemented product guarantees.

## Five fidelity surfaces

Fonts: local Space Grotesk loads; mono quantities remain separate. Display weight/wordmark remain mismatched as above.
Spacing: three-column desktop cards and separated sticky vote panel are present. First comparison exposed excessive vertical spacing and a narrow vote panel. Reduced desktop toolbar margins and widened the panel from 345 to 390px. Revised screenshot preserves readable cards. Added preview/local-time copy intentionally consumes space absent in the raster mock.
Colors: #10110E canvas, #D5FF3F actions, #F3F4ED foreground and #A6AFA0 secondary text match the written token spec. Native form controls now use dark color-scheme.
Images: original supplied Sprout/Miso/Nib/Fizz/Gloop/Pip PNGs reused consistently and not regenerated. Parent and KID hero assets remain absent from implementation. No fidelity pass is claimed.
Copy: fixed 0.05% threshold and same-rules design retained. Explicit demo language, absolute cutoff and local time are intentional additions. Total turnout now equals the actual synthetic candidate totals; replacement moves one demo allocation rather than double counting.

## Iteration history

1. First desktop/mobile review: too much desktop toolbar space, narrow vote panel, light native radios, radio hit target too small on mobile, inconsistent hardcoded turnout/winner. Corrected spacing/panel, dark controls, 48px mobile label target, and derived turnout/result.
2. Re-captured desktop ballot and compared against source again. Remaining art/wordmark/Today/submission differences above keep the visual gate blocked.
3. Keyboard review exposed Escape focus loss caused by StrictMode effect re-entry. Store opener in a ref, close native dialog during cleanup and restore opener. Retest returned focus to the Review vote button.

## Verified behavior

See VALIDATION.md. No browser warnings/errors observed in this session. Browser success does not prove chain behavior, real signing, backend validation or overall usability with real users.

## Implementation checklist

1. Complete original KID and parent artwork composition; use an actual approved wordmark.
2. Align heading weights and complete mobile wallet/identity flows.
3. Prototype direct proposal links and durable accepted-receipt/submission history.
4. Re-capture and repeat visual QA, then conduct user comprehension testing.
5. Keep public launch activation separate; economics requires chain qualification described in ECONOMICS.md.
