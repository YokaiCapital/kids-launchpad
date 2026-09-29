# Private worker observations

Schema 27 adds a partial active-work index. A separate read-only PostgreSQL
observer reports bounded per-lane queue delay, due work, expired leases,
unresolved transactions, funding/capacity waits, latest grant expiry/revocation,
reserved operating exposure and projected RPC/signer quota headroom. Normal
future waits are not overdue. Completed historical budgets do not produce
low-reserve alarms. No wallet/job/signature/payload labels or driver errors are
exported. The JSON and Prometheus command is internal only and fails nonzero
when the observation is unavailable; it never reuses an old healthy result.

Qualification: **532 tests passed, 0 failed, 0 skipped**, including PostgreSQL
dump/restore. Five new observation tests cover scope isolation, held money,
revoked latest grants, elapsed quota refill, no observer mutations, bounded output
and concurrent draining of 100 synthetic campaigns through three independent
lanes. This is real database scheduling evidence, not a chain throughput benchmark.

Ultimate goal: reliable concurrency and operating readiness remain **partial**.
This supplies measurable alert/scale inputs. It does not deploy a collector,
measure process liveness, automatically scale replicas, increase signer limits,
or prove hosted/mainnet capacity. `liveness: not-measured` is explicit. External
monitoring must alert on missing/old observations and combine these signals with
service and chain/provider probes. Representative mixed-chain workload and
hosted restore/security qualification remain required.
