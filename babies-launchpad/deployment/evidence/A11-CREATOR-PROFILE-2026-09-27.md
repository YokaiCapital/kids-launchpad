# A11: creator-approved profile publication

Date: 27 September 2026. Isolated Standard v3; public activation remains off.

The ordinary creator path now publishes a verified PFP, optional 3:1 banner,
description and HTTPS social/site links into the shared campaign profile. Only
fields approved in the immutable creation request can be published. Owner,
accepted-body hash, scope, publication descriptors, hashes, content addresses and
token metadata URI are checked before registration. No draft notes, object keys,
credentials or wallet packets reach the display profile.

Schema 35 journals supplemental banner publication separately from immutable
token metadata. Interrupted requests resume the existing publication receipt;
unknown provider results cannot trigger another blind upload. Registration
resumes supplemental publication before its database transaction, then atomically
registers the profile and read jobs. Retries cannot override later moderation.
Public image URLs permit the fixed Pinata gateway and content-address path only;
video has no new external-origin permission. Authenticated drafts remain private
until the creator explicitly approves public publication.

Verification:

- **623 tests pass, zero failed or skipped**, including publication recovery,
  request ownership, moderation preservation and delayed registration.
- Enabled production build passes. Browser checks at 1440, 768, 390 and 320 px
  pass with exact CSP, images, description, links, wallet/discovery interactions
  and no horizontal overflow or console errors. Narrow tabs retain whole labels.
- A fresh actual owned-chain creator rehearsal generated and used mint
  `ERbNLHj7vy1terTAYk9MPbK6WhWsvipxyNmAgCRykids`, created campaign
  `8zB1EtbJ5QZSRRRFdRxca8StMAVuzp6NyPyYzr4zqdeQ`, resumed after service restart,
  finalized registration and verified the published profile. Three independent
  wallet approvals were required. Only three read jobs were registered; no
  financial worker was activated.
- That rehearsal used synthetic pin receipts and an owned local test key. It
  does **not** qualify hosted Pinata, a real wallet extension or public deployment.

Video publication remains a separate unfinished requirement. The ordinary wizard
does not offer a local-only video selection when durable publication is disabled;
saved video drafts must remove it, and the server refuses unsupported video before
accepting a creation. This prevents silent loss, not a claim of video completion.

Against the ultimate goal, durable creator identity and resumability improve.
Video, the explicit operating-funding/bootstrap policy, hosted wallet/provider
qualification, representative mixed-chain capacity and restore/security release
gates remain. Existing funded programs and coins are unchanged.
