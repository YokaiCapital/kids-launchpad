# kid.fun — visual refinement QA

final result: passed

**Scope:** the next visual refinement step requested on 19 September: Today/mascot, submission family/review, shared typography/wordmark, ballot controls and mobile wallet/filter/review surfaces. This is a pass for this local prototype refinement, not an above-9 score for the entire product, complete UX coverage, economics qualification or permission to launch. The initial blocked report is preserved in design-qa-initial.md.

## Source and rendered evidence

Source visual truth: ../docs/kid-fun-v4/01-today.png, 02-full-ballot.png, 03-submission-review.png and the companion DESIGN.md/BALLOT.md.

Implementation screenshots:
- evidence/v5-today-desktop.png
- evidence/v5-submission-desktop.png
- evidence/v5-ballot-desktop.png
- evidence/v5-today-mobile.png
- evidence/v5-submission-mobile.png
- evidence/v5-mobile-filters.png
- evidence/v5-mobile-wallet.png
- evidence/v5-mobile-vote-review.png

Desktop viewport: 1488 × 1058 CSS pixels, devicePixelRatio 1, screenshot dimensions 1488 × 1058. Today/ballot source 1488 × 1058; submission source 1488 × 1059. No resizing or density normalization needed. Chrome was used after in-app viewport capture produced a duplicated, mis-scaled screenshot (its natural-width page remained usable). Those malformed captures were excluded. Mobile: 390 × 844, plus 320 × 740 reflow checks.

Full-view comparison: each source and corresponding implementation were opened together in one image-tool response. Their text and component boundaries were readable at full resolution, so separate crops were not necessary. Compared source hero to closed genesis, source review to ALPHA/BETA + sample Sprout at Review, and source ballot to page-one Sprout selection. The final ballot screenshot is selected/unsubmitted after resetting the test receipt through the demo wallet menu. Most voted was used to place the six named samples first; source uses illustrative Discover. Synthetic bottom-row identities and added absolute/local deadline text are intentional dataset/content differences, not evidence of a pixel-exact clone.

## Findings and resolutions

- Original P1 missing KID: resolved. Reference-derived first lime alien now fills the Today hero, with the same file in thumbnail/profile. Sprout is not substituted for KID.
- Original P2 narrow text logo: resolved using the raster wordmark asset. Header size and divider now match reference proportions.
- Original P2 absent family: resolved for the supplied sample pair. Three-character family art, parent labels, stepper, correction link, rights declaration and eligibility detail are present. Custom uploads remain editable and display their own artwork.
- Original P2 heading hierarchy: replaced the incomplete static-font treatment with the existing variable Manrope font at weight 800; headings, body, controls and mono quantities now have consistent hierarchy.
- New P2 mobile truncated filters: resolved with a full-width Filter & sort trigger and bottom sheet. Search stays on the ballot; sheet changes apply to the whole dataset, and selection remains intact.
- Original P2 mobile allocations unreachable: resolved with a wallet sheet linking directly to allocations and submissions, plus explicit demo disconnect.
- Dense developer scenario controls moved below the main experience. Launches closed remains prominent on Today and demo wording remains in transaction/submission surfaces.
- Native dialogs become bottom sheets on mobile. Escape and focus restoration were retested; Review vote regained focus.

No unresolved P0/P1/P2 visual issue was found in the scoped final comparisons. Remaining workflow gaps below are explicitly outside this step and still prevent an overall product sign-off.

## Required fidelity surfaces

**Fonts/typography:** real local variable font, weight 800 display, readable 15–16px controls/body, mono amounts. Manrope is a close usable implementation of the raster reference, not a claim to recover its exact unidentified typeface. Different wrapping at 320px is intentional responsive reflow.

**Spacing/layout:** source two-column hero and review, three-column desktop ballot with vote panel, source-sized wordmark and bounded content width restored. Extra local deadline, receipt and demo explanations increase ballot height modestly. All content scrolls; sticky controls do not cover the final content because bottom clearance is reserved.

**Colors:** written #10110E / #D5FF3F / #F3F4ED / #A6AFA0 palette retained. Native controls follow dark mode; selected state includes text and radio state as well as lime.

**Images:** three PNG additions inspected, alpha preserved. KID antennae, expression and pose retained. Supplied six candidate assets remain untouched. The composed sample family includes a seated Sprout pose from the approved source; this is a documented sample illustration rather than a new selectable identity. Future production should unify final character assets after the user's final mascot work.

**Copy/content:** same fixed launch terms and 0.05% eligibility retained. No real wallet, mint, funded allocation or trading claim. Visible distinctions include selected, recorded demo vote, awaiting review and not launched. Most voted now includes the accepted demo replacement weight.

## Verification / iteration history

1. Generated and integrated three source-derived assets, shared typography, hero and family review.
2. Visual comparison exposed undersized family art and excess review spacing; corrected fit and removed the duplicate rules row.
3. Mobile screenshot exposed truncated dropdown labels; replaced them with a filter sheet. Verified BETA yields 124 of 248 candidates and reset returns all 248.
4. Captured corrected desktop and mobile views. Verified 320/390px document widths equal their viewport widths.
5. Verified demo vote receipt survives reload, proposal K009-248 deep link reopens the correct frozen proposal after reload, mobile allocations route works, and Escape restores focus.
6. Final build and model/worker tests passed (see VALIDATION.md). Console query filtered to localhost returned no app warnings/errors. Unfiltered Chrome logs include unrelated wallet-extension injection warnings/errors; these were not presented as application failures or silently counted as a clean browser profile.

## Remaining product work / P3 polish

- Six sample artworks reused across 248 records validate browsing capacity, not discovery with 248 unique characters. Final character library remains future work.
- Parent lookup still uses explicitly labeled sample tokens. Real mint search, identity evidence, moderation queue scale, full wallet/account switching and complete lifecycle coverage remain to implement/validate.
- Archive is an honest prelaunch empty state; no live markets exist. Real trade, claim or server receipt behavior is not implemented.
- Finish the final mascot/character artwork with the user later; minor raster texture and pose variations remain in the sample art set.
- Screen-reader testing, true 200% browser zoom, user comprehension testing and actual LaunchLab/graduation/claims qualification are still outstanding.

## Implementation checklist

- [x] Restore KID, wordmark, family composition and shared hierarchy.
- [x] Fix mobile filter and wallet access.
- [x] Preserve draft and demo receipt state, test shared proposal link.
- [x] Compare source/rendered screens and recapture after corrections.
- [ ] Complete the remaining product workflows and economic qualification before overall sign-off.

### Submission reliability follow-up

Added a searchable sample-parent sheet with duplicate prevention and explicit unsupported mint-address results. Mobile 390px sheet screenshot inspected; 320px dialog and document fit viewport. Kept established artwork, layout and typography. Correct/resubmit/approve journey and repeat vote acceptance verified in Chrome through the browser plugin (same previously documented in-app viewport issue). See VALIDATION.md for test evidence and remaining limitations. Full above-9 target is still open.

## Current override: clearer home hierarchy and functional parent lookup

final result: passed

Scope is the local UI pass only. User-provided screenshot “Screenshot 2026-09-19 at 22.37.11.png” supersedes the previous Today composition: lead with “Two communities. One kid.”, first-coin row, parent-family explanation and four-step roadmap. Render captured at the screenshot's 1776×1268 and at 1488×1058; mobile at390×844 and320×740. Source attachment and rendered screenshot were visually inspected. Existing alien identity retained intentionally; user feedback concerned comprehension, not a mascot change. Existing bounded content width retained. Parent placeholder question icons use the icon library; no new imagery was generated.

Restored: clearer headline, first KID status, parents pending, family relationship, sequential roadmap. Voting/submission live in an “After KID” row; main home navigation is Explore / KID / Allocations / Guide. Intentional content differences: proposed unfunded allocation and conditional launch language; demo wallet label; current approved alien instead of the historical furry mascot. No claim of a pixel-exact clone. No P0/P1/P2 layout issue found in these inspected states. Long mint addresses wrap in evidence; mobile sheet scrolls and duplicate selection is disabled. All app actions listed in VALIDATION.md were exercised. Real mint lookup supersedes the sample-only limitation in earlier sections; samples remain available separately.

Remaining: user comprehension confirmation, assistive-technology validation, final mascot polish if requested, and production economic qualification. Above-9 target remains unmet; see SCORECARD.md.
