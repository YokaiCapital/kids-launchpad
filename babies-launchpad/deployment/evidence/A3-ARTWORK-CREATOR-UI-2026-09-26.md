# A3: creator artwork UI, 26 September 2026

Implemented on the private public-launch branch; public creation remains disabled.

The creator profile now accepts PNG/JPEG files, displays a square PFP or exact 3:1
banner crop, and provides keyboard/touch zoom and pan controls. The saved preview
uses an authenticated owned asset reference. Save, Back and Continue wait while a
crop/upload is in progress. Failed or uncertain uploads retry the same bytes and
request ID; changing the crop creates a new request. Raw files are not persisted
in browser storage. Refresh before saving requires reselecting the file.

Review requires explicit consent to permanent public artwork/metadata publication.
Editing public profile fields resets consent. The upload feature is only passed
through when the server advertises artwork capability; absent composition does
not pretend that local previews are uploaded. The creation button is still disabled.

## Validation

- 25 client draft, artwork, route and adapter tests passed.
- Production client and SSR builds passed; publication scanner checked 785 files
  with zero pattern findings (not an exhaustive secret audit).
- Real rendered components tested in Chromium at 1440x1000 and 390x844. Checks:
  crop ratios, range keyboard controls, editing-state navigation locks, uncertain
  upload retry with the same ID, saved private previews, 3:1 saved banner, consent
  reset, disabled creation, no horizontal overflow, no application console errors.
- Browser plugin was unavailable, so existing Playwright was used. Local test URL:
  http://127.0.0.1:4311/ (temporary qualification harness, not production).
- The harness used the real Sharp decoder but an in-memory transport/storage
  fixture. Four intentional 503 responses exercised lost-response recovery. These
  are not production failures or evidence of a real S3 deployment. Separate server
  tests cover session/CSRF/owner isolation and PostgreSQL storage reconciliation.

Local screenshots (not uploaded): /tmp/kids-artwork-ui/{desktop,mobile}-{crop,saved,review}.png.
An initial screenshot exposed sticky footer overlap and a distorted saved banner;
both were fixed and the full interaction check rerun successfully.

## Remaining gates / ultimate goal

This closes the private creator artwork interaction loop, not the complete launch
flow. Optional video still needs durable validation/storage, real cloud media and
publication need qualification, and approved mint -> funded campaign -> discovery
needs completion. No existing funded program, hosted deployment or public flag
was changed. Financial worker lanes remain independent of media processing.
