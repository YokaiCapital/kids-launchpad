# A29: directory query work under mixed load

27 September 2026. Local qualification only; no public activation.

The 400-campaign directory served all 3,000 requests from 1,000 logical clients, but initially missed the one-second p95 target: 1,083 / 1,080 / 1,200 ms. The client uses 64 keep-alive connections, and timing includes the client's connection queue. These are not 1,000 independent geographically distributed browser sessions.

Two redundant costs were removed: identical simultaneous PostgreSQL list queries now share only their in-flight result, and the immutable release-file preset manifest is read/derived once per process. An explicit live manifest provider still runs per request. Every request is authorized before joining shared work. Settled list results are not cached, so subsequent registry status/visibility changes are read again; query keys and outstanding sharing are bounded.

The next mixed-load run served all 3,000/3,000 reads at p95 750 / 712 / 688 ms. Shared projection reads were 1,080, with zero visitor-triggered RPC calls. This occurred later in the same active financial run, so the load phases are not identical and the latency difference is not a controlled causal estimate. Both measurements are retained. The qualification uses warm indexed views and a local service-token boundary, not real wallet authentication or hosted edge infrastructure.

All 13 directory route tests pass, including concurrent authorization, bounded enrichment, changed registry rows, live manifest changes and redacted database failures. The separate financial-lane latency gate is not satisfied by this HTTP result.
