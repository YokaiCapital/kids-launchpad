# A24: bounded page enrichment under mixed load

The fresh mixed run reached 300 registered campaigns. Its first 3,000-request
directory check returned every response, but p95 was 1000/826/824 ms: the first
round failed the strictly-below-one-second target. The per-coin cache held 200
entries and concurrent requests repeatedly evicted in-flight enrichment for
the same pages, causing 18,580 shared projection reads.

The directory now coalesces identical public-page enrichment for one second,
bounded to 64 entries. Each request still authenticates and queries the current
registry. Complete public rows form the cache key, and per-coin caching also
invalidates when that row changes. This does not cache an authorization decision,
expand a user's visibility or increase the 200-entry coin cache. Live-source
freshness rules and no-store response headers remain intact.

Repeating the same 1,000-client × three-round workload while actual launches,
refunds and fees were still processing produced:

- 3,000 successful responses, no failures;
- p95 **815/817/815 ms**, p99 845/849/847 ms;
- **580** shared projection reads, zero per-viewer Solana RPC calls;
- 300 campaigns and 64 persistent origin connections, client queue time included.

These remain local measurements with warm projections and service-token auth,
not external browser-wallet or CDN qualification. They do not establish financial
worker latency; that is measured separately.

The route also now emits fixed public failures for unexpected registry errors and
fixed open-failure log events, preventing driver diagnostics from exposing internal
details. Known invalid filters/cursors still return 400; unavailable data returns
503. Twelve route tests pass, including concurrent pages larger than the coin cache,
registry changes, authorization, isolation and redacted failure responses.

Against the ultimate goal, directory demand and error confidentiality improve.
Hosted/load/operating-funding/security gates remain; no public financial activation.
