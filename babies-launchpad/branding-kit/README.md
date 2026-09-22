# KIDS — designer handoff

Current site identity • 20 September 2026 • v1

Open `brand-board.html` for the visual guide. All resources are bundled; no network is required. This kit captures the current selected site direction, not a new identity proposal. Source: interaction-review/AGENTS.md, src/bubblegum.css, src/refinement.css and src/responsive.css.

## Brand architecture

**KIDS** is the platform name. **kids.fun** is the lowercase domain-style wordmark. Use KIDS in prose and on the beanie; preserve the supplied italic kids.fun wordmark artwork. Domain ownership is not verified by this kit.

“Two communities. One kid.” describes the mechanism. Parent communities lead to a separate child coin. **SHART / $SHART** is the first child coin concept, Fartcoin × Buttcoin. The pink dog represents KIDS, not SHART. Parent references do not imply endorsement or affiliation.

## Included assets

| File | Use | Format / dimensions |
|---|---|---|
| assets/kids-logo-integrated-v1.png | Primary platform logo, dog integrated above italic wordmark | Transparent PNG, 2172 × 724 |
| assets/wordmark-kids-v2.png | Wordmark-only alternative | Transparent PNG, 2172 × 724 |
| assets/kids-mutt-v4.png | Mascot reference, KIDS on beanie | PNG, 1254 × 1254; opaque white background |
| fonts/manrope-variable.woff2 | Current interface typeface, weights 200–800 | WOFF2 + OFL license |
| tokens.json / tokens.css | Color and font handoff | DTCG-style JSON / CSS |
| brand-board.html | Offline visual guide | Responsive HTML, print styles |
| manifest.json | Provenance, dimensions and file checksums | JSON |

Keep source filenames for traceability. The logo is raster artwork, not an editable vector; do not treat it as a font. No SVG/AI/Figma master is currently available. The standalone mascot is not transparent; only the supplied logo assets are transparent. Do not silently substitute older KID-beanie, lime or detailed mascot variants.

## Logo and mascot

Use the integrated logo on dark plum, at its natural 3:1 canvas ratio. Keep its full canvas; no circular avatar container, background tile, stretching, filters or added outline. Do not put a vertical divider beside it. Leave breathing room below it before rules/content.

Recommended handoff guardrail: clear space of at least 1/4 logo height around the canvas; minimum displayed width 150 px for the integrated logo. The existing very narrow mobile header uses about 128–138 px, but the beanie detail becomes tiny there. Use a larger version where space allows. These are practical recommendations, not pre-existing registered brand standards.

The dog should remain simple, playful and easy to meme: pink body, purple beanie marked KIDS, big black nose, dot eyes, asymmetric floppy ears and a tiny tongue. Keep the chunky silhouette. Avoid realistic fur, intricate rendering, a miserable expression, or sexualized/creepy treatment. Do not use the platform dog as the visual identity for SHART.

## Color and typography

Dark plum #130D1B is the canvas; #21142E is a raised surface. Bubblegum #FF77CE is the primary action. Grape #A88AFF is secondary. Ice #8CECFF is navigation/focus emphasis. Text #FFF4FC, muted text #B9A9C6, rules #43304F. Use dark #250D2A text on pink actions. Keep coin dashboards restrained: dusty pink #C982B0 for funded SOL, #61546E for refunds, #77668E for the paired token. Never rely on color alone to explain values.

Manrope 800 for headlines; 500–600 body/UI; 700–800 buttons and key values. Current site uses system monospace for tickers, parent labels and technical values. The italic wordmark is an image and should not be retyped in Manrope. Suggested composition scale: 48–72 px desktop hero, 28–36 px mobile hero, 24–32 px section title, 14–16 px body, 12–13 px secondary labels. These are handoff recommendations, not a replacement for the app's responsive CSS.

## Layout, media and icons

Compact, wide desktop coin pages: introduction/video, funding progress and a right commitment rail. Exact **3:1 banners**; exact **16:9 video**, contain without cropping, no autoplay. Parent icons stay inline with parent names. X and website links overlay the upper-right of the banner, with accessible names and clear contrast. Use the current Phosphor icon system (@phosphor-icons/react); avoid mixing icon stroke styles. Icon library artwork is not bundled in this kit.

Funding progress should show the total, cap, refundable excess and stage visually with short labels. Motion: subtle progress transitions, occasional sheen and active-stage pulse; honor reduced motion. Never animate fabricated transactions or totals to imply real demand.

## Voice

Short, cheeky, clear. “Two communities. One kid.” / “Meet their kid.” / “Commit SOL” / “Dev updates”. Use dev rather than owner in product UI. Explain parentage before mechanics. Humor belongs in coin stories; balances, fees, claims and risks need precise wording. Avoid promises of profit or invented popularity.

## Designer deliverables next

1. Faithful vector master of the supplied integrated logo and wordmark, preserving shape and spacing.
2. Transparent standalone mascot master and small-size simplified mark, for review before adoption.
3. Expression/pose sheet, keeping the current mascot recognisable.
4. Social/banner compositions using the specified media ratios; clearly distinguish platform branding from coin branding.

## Rights and scope

Manrope redistribution is covered by the included OFL. Existing logo/mascot assets are supplied from the project for the user's designer handoff; no trademark registration or external rights clearance is asserted. Third-party Fartcoin and Buttcoin icons are deliberately not bundled as KIDS-owned assets. SHART uses a temporary typographic S! badge in the site; final coin artwork is not selected. Financial allocations, fee schedules and deployment status are intentionally not encoded into evergreen brand assets.
