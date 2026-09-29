# A12: durable creator video

27 September 2026. Standard v3 local qualification; public activation stays off.

Optional creator video now follows authenticated binary upload, private storage,
processing, immutable creator approval and journaled publication. MP4/WebM input
is capped at 100 MiB / 120 seconds. Sanitization produces a 16:9 H.264/AAC MP4
and PNG poster, strips user metadata and limits execution and output sizes.
Separate shared quotas and fenced leases prevent stale completion and bound
storage use. Private owner previews support byte ranges without public caching.

HTTP uploads, playback storage reads and publication source reads have bounded
concurrency. Disconnection cannot release a playback slot before its storage
read finishes. Identical immutable publication requests share an in-flight
operation; unrelated requests return a retryable pending result when saturated.
Unknown provider results recover through existing receipts rather than repeat
blind uploads. Schema 36 retains existing supplemental publication receipts on
both PostgreSQL and SQLite while adding video/poster stages.

Verification:

- **635 tests pass with zero failed or skipped**, including real FFmpeg MP4/WebM
  processing, metadata stripping, malformed input, deadlines, interrupted writes,
  ownership, concurrency, migration preservation and publication recovery.
- Enabled frontend production build passes. Browser checks at 1440, 768, 390 and
  320 px exercise failed-upload retry with the same identity, disabled save during
  processing, actual private playback, caption and removal. No overflow/errors.
- Fresh actual owned-chain creator qualification generated and used mint
  `G7SHoeKG5MM7TTyAHwPrv2i9qP6SLgLvfArwQ1ZWkids` and campaign
  `HqsTLYN2VEjD49M5CJFCqKLpAngbjJU5h2a3JkSAw4Vu`. It uploaded/processed video via
  authenticated HTTP, verified unauthorized refusal and partial playback,
  required three independent wallet approvals, resumed after restart and
  finalized registration with the approved video profile and three read jobs.
- The chain rehearsal used synthetic publication receipts and an owned test
  wallet. It started before the final memory admission refinements; those
  refinements are covered by the subsequent full regression. No hosted provider,
  extension wallet or decoder sandbox qualification is implied.

The local decoder is not an operating-system sandbox. Hosted activation requires
an isolated secret-free/no-egress media service, actual resource-limit tests and
private storage/provider qualification as specified in
[video operations](../../localnet/creation/VIDEO-OPERATIONS.md). No decoder runs in
a signer and no hosted entry point was enabled.

Against the ultimate goal, durable creator media and recoverability improve.
Explicit operating funding, hosted integration, representative concurrent chain
load, liveness/restore and release security gates remain. Existing financial
programs and funded coins are unchanged.
