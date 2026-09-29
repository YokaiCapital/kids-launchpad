# A3: private creator artwork, 26 September 2026

Status: implemented and locally qualified, not hosted or enabled for public creation.

## Implementation

- Pinned Sharp 0.35.4 decodes PNG/JPEG in a short-lived child process with a
  minimal environment, bounded input/output, 16-million-pixel limit, one decoding
  thread, no process-local queue, and a kill deadline. It auto-orients and
  re-encodes to PNG without EXIF/XMP/ICC/IPTC. PFPs must be square; banners 3:1.
  They are reduced without upscaling to at most 1024 square / 1800 by 600. PNG
  transparency remains. Arbitrary remote URLs, SVG, GIF and video are not inputs.
- Schema 17 stores immutable owned descriptors, idempotency keys, attempt quotas
  and fenced processing leases. No raw or processed image bytes enter PostgreSQL.
  Short shared admission enforces owner/global active limits and daily attempt/
  byte ceilings across replicas. The byte charge reserves the maximum output.
  Uncertain attempts retain their charge; retries are bounded to three. Network
  requests and decoding happen outside database transactions.
- The private AWS S3 adapter uses conditional writes (`If-None-Match: *`), verifies
  stored content hashes and lengths, and requires all four bucket public-access
  blocks plus a nonpublic bucket policy. It returns no object URLs. It uses the
  official SDK 3.1141.0 with bounded requests and no automatic write retry.
  Interrupted writes reconcile the same immutable key rather than overwrite it.
- Optional account-service composition provides binary uploads and authenticated
  image previews. Wallet session, exact pilot wallet, origin and CSRF checks occur
  before upload parsing. Preview responses are PNG, `private, no-store`, vary by
  cookie, forbid cross-origin embedding, and use `nosniff` and a restrictive CSP.
- Drafts can reference only ready images owned by that wallet, with matching kind
  and hash. Browser-supplied URLs and `sanitized` flags are discarded for owned
  references. V3 review requires an owned PFP and explicit consent to permanent
  publication. Legacy reviews do not gain publication consent automatically.

The upload policy requires per-wallet/global quotas, bounded input checks and
retaining uncertain provider charges. KIDS uses PostgreSQL for shared concurrency
and durable quota accounting.

## Evidence and limits

The focused PostgreSQL/auth/creation/worker/market regression suite passed **361
tests, zero failures and zero skips**. The production client/SSR build passed.
Coverage includes real Sharp decoding, metadata removal, orientation/transparency,
invalid files, pixel bombs, timeouts, busy workers, parallel replicas, expired
lease fencing, owner isolation, quota rollback, lost storage responses, private
HTTP previews, logout/CSRF denial and v3 publication consent. The publication
scanner checked 780 files with zero findings; this is not an exhaustive audit.

S3 behavior was tested with deterministic SDK transport fixtures, not a provisioned
cloud bucket. No credentials, provider writes or public publication were used.
The existing five npm audit findings remain (bigint-buffer dependency chain and
stream-json dependency chain); no new Sharp/S3 findings were reported. Existing
runtime hardening remains verified. This is not a zero-vulnerability claim.

## Deployment requirements still open

1. Provision and verify the actual private bucket and least-privilege media-only
   credentials; no bucket list, write or read keys in the browser or mint signer.
   Runtime readiness must run privacy verification and health probes. Never use
   a public S3-compatible bucket merely because the adapter interface matches.
2. Run processing in a separate resource-limited media container/role. The child
   deadline and V8 heap limit are not an OS sandbox or a native-memory ceiling.
   Apply CPU/memory/process/egress restrictions, body/rate limits at the edge, and
   readiness/queue monitoring. Keep financial worker capacity independent.
3. Exercise real SDK retries, bucket permission changes, TLS/provider failures,
   restart recovery and backup/restore. Add bounded orphan/retention maintenance;
   never delete accepted/published campaign artwork through draft cleanup.
4. Wire the creator crop/upload/progress/resume UI and explicit permanent-publication
   consent. Hosted composition remains disabled; the general creation button is
   still disabled. Optional video needs its own bounded validation/storage path.
5. Qualify actual Pinata publication, complete funding/provisioning, real external
   wallets, hosted mixed load and security/release gates before activation.

## Ultimate-goal check

Closes private media ownership and retry gaps while preserving old campaigns and
keeping media work out of fee/claim/refund lanes. It does not complete A3 or imply
the entire public-launch product is production ready.

References: [Sharp input limits](https://sharp.pixelplumbing.com/api-constructor/),
[Sharp output metadata defaults](https://sharp.pixelplumbing.com/api-output/),
[S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).
