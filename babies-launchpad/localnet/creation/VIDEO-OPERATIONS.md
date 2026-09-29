# Creator video processing

The Standard v3 local composition accepts an explicit `sanitizeVideo` dependency
and separate `videoLimits`. Without both, video publication is unavailable and
the form hides its upload control. No environment flag adds video to the existing
hosted API or signer.

Accepted input is MP4 or WebM, at most 100 MiB and 120 seconds, with one video
track and at most one audio track. The decoder emits H.264/AAC MP4, 1280×720,
30 fps, fitting the source inside the frame without cropping; output is bounded
to 32 MiB. A 640×360 PNG poster is generated. User metadata, chapters, attachments
and extra tracks do not propagate. Container/codec identification fields can
remain; this is not a promise of a literally metadata-free MP4.

Each replica buffers at most one admitted HTTP upload until processing completes.
Separate PostgreSQL quotas and 180-second fenced leases bound video work across
replicas; the decoder defaults to one concurrent process, two codec threads and
a 90-second total deadline. An expired worker cannot mark a replacement's output
ready. A failed partial object write can be retried with the same request ID and
bytes. Both output hashes and storage receipts must verify before an asset is
ready. Uploads stay in private, access-blocked object storage. Authenticated owner
routes serve video ranges/posters with `private, no-store` caching. Public URLs
are issued only for the approved files through the publication journal.

## Hosted release requirements

The in-process local composition is a qualification adapter, **not a hosted
decoder sandbox**. Before hosted enablement:

- Run decoding in a secret-free isolated service/container with no network
  egress, read-only root, an ephemeral bounded scratch directory, non-root UID,
  dropped capabilities, process/CPU/memory limits and a maintained codec build.
  It must not share a process, filesystem, volume or credentials with a signer.
- The service holding database/object-store credentials must communicate with
  that sandbox over a bounded, authenticated local transport. Do not give those
  credentials to the decoder container. Restrict its input/output to the current
  job's files; never fetch arbitrary creator URLs.
- Reserve at least the measured memory headroom for buffered input and decoded
  frames; qualify the 100 MiB / 4K / 120-second worst cases and adversarial files
  under the actual cgroup limits. Local small fixtures do not certify capacity.
- Enforce edge connection, per-wallet body/rate and request-time limits before
  forwarding; keep media replicas independent of lifecycle, refunds and fees.
- Qualify private bucket policy, conditional writes, encryption, live Pinata
  publication/reconciliation and the deployed gateway's video range behavior.
  Synthetic provider receipts do not satisfy these checks.
- Pin/review decoder versions, periodically patch them and require the actual
  media integration tests in CI using `KIDS_TEST_FFMPEG` / `KIDS_TEST_FFPROBE`.
  Missing binaries skip codec tests; skipped tests cannot qualify a release.
- Monitor active/expired leases, rejections, processing latency, output failures
  and storage growth. Remove abandoned private objects only after proving no
  accepted/in-progress creation references them; never expire active recovery
  dependencies with an unconditional bucket lifecycle rule.

The subprocess uses explicit demuxers, a file/pipe protocol allowlist, disables
MOV external data references, strips environment credentials and limits output
and execution. These follow the [FFmpeg options](https://ffmpeg.org/ffmpeg.html),
[protocol controls](https://ffmpeg.org/ffmpeg-protocols.html) and
[ffprobe](https://ffmpeg.org/ffprobe.html) interfaces. Those controls are defense
in depth, not an operating-system security boundary.
