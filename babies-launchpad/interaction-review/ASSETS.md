# Visual assets — refinement pass

Built-in ImageGen was used in edit mode with the existing v4 screenshots as references. Files below are non-destructive sibling additions; originals remain unchanged. These are reference-derived raster extractions, not bit-identical pixel crops. KID retains the selected first alien identity and appears from the same file in the hero, token thumbnail and profile. The sample ALPHA/SPROUT/BETA illustration is shown only for that sample parent pair and sample artwork; custom characters use their uploaded image and current parent labels.

| Asset | Saved workspace path | Source |
|---|---|---|
| KID | public/assets/kid-v1.png | ../docs/kid-fun-v4/01-today.png |
| Sample family | public/assets/family-v1.png | ../docs/kid-fun-v4/03-submission-review.png |
| Wordmark | public/assets/wordmark-v1.png | ../docs/kid-fun-v4/01-today.png |

Final prompts sent to the built-in tool:

**KID:** Use case: background-extraction. Edit target: attached kid.fun Today screenshot. Extract ONLY the large lime alien mascot on the right as a standalone web hero image. Preserve its exact identity: lime oval head, two round-tipped antennae, smug heavy-lidded eyes, tiny seated body, folded arms, large feet, black cartoon outlines, faint handmade texture. Same pose, proportions, expression, colors. Do not redesign it or add leaves. Remove every interface element, all text, logos, number 01, dividers, shadows behind UI. Center the entire character with 5% padding, transparent background, square 1024x1024 PNG. This is the existing approved KID mascot, faithful extraction is critical.

**Family:** Use case: background-extraction. Edit target: attached kid.fun submission screenshot. Extract ONLY its three-character family illustration in the left half: purple cratered ALPHA sphere on left, lime leaf-eared seated SPROUT in center, cream little ghost BETA on right, including the thin ivory connector lines between them. Preserve their exact shapes, colors, expressions, line art and positions. Remove all labels and interface text, typography, stepper, backgrounds, footer, borders. A single standalone wide illustration, transparent background, 3:2 aspect, tight yet uncropped around the three characters. Do not include text; do not change character identities. This image is for the same submission review composition.

**Wordmark:** Use case: background-extraction. Extract ONLY the acid lime kid.fun wordmark from the top-left of the attached screenshot. Preserve the very thick forward-italic playful wide letterforms exactly, including the tiny TM. Exact text: kid.fun. No other words or elements. Transparent background. Wide horizontal logo canvas with minimal empty space around the wordmark, high resolution crisp edges. This is extraction of existing approved brand artwork, not a redesign.

All three outputs were inspected and have an alpha channel. Supplied character assets remain unchanged. Phosphor's existing icon components provide controls and explanatory icons. Manrope variable font is reused from the existing KIDS workspace; Space Grotesk and monospace remain for supporting labels/quantities. No new third-party font service is called.

- parent-buttcoin.png: user-supplied logo source https://s2.coinmarketcap.com/static/img/coins/64x64/39448.png. Visual identity selected; does not confirm parent mint.
- kids-mutt-v4.png: built-in ImageGen edit of kid-mutt-v3.png; change only beanie lettering from KID to KIDS, preserve character and style.

## Integrated KIDS logo
`public/assets/kids-logo-integrated-v1.png`: generated with image_gen from kids-mutt-v4.png and wordmark-kids-v2.png. Prompt: transparent horizontal white italic kids.fun wordmark, pink dog in KIDS beanie leaning over lettering; no avatar circle. Original generated alpha preserved.

Placeholder video: public/assets/shart-placeholder-v1.mp4 is the CC0 flower video from https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4. Paired with original code-native SHART poster shart-video-poster.svg. Temporary sample playback; replace via Dev controls.
