# Reliability rules for reads, retries and evidence

Owner rules, 20 September 2026. They apply to every read-only lookup, snapshot and evidence step in KIDS, and they are enforced by `localnet/mainnet-parent-snapshot.mjs` and its tests.

1. **Classify errors.** Retry transient connection failures, timeouts, HTTP 429 and the appropriate 5xx responses. Respect `Retry-After`. Never repeatedly retry invalid requests, authentication failures or malformed responses.
2. **Bound retries.** Exponential backoff with jitter, a per-request timeout that actually aborts the request, and an overall operation deadline. For read-only lookups four total attempts is the starting point, not a universal rule.
3. **Preserve uncertainty.** Return explicit resolved, not-found and unresolved outcomes. Exhausted retries are never read as an empty account, a normal wallet or a clean custodial assessment.
4. **Completeness is mandatory.** Record expected, successful and unresolved lookups. Block publication of authoritative snapshots or eligibility decisions when required evidence is missing. Keep incomplete results marked incomplete.
5. **Preserve snapshot consistency.** A later successful lookup may see changed state. Record RPC context and enforce the snapshot's consistency policy. Retrying against another endpoint must never silently mix networks, commitments or incompatible account states.
6. **Separate facts from heuristics.** Account ownership alone does not prove an address is custodial. Store evidence, classification rationale and confidence separately. Never exclude holders automatically on an unreliable heuristic.
7. **Control traffic.** Bound concurrency, deduplicate lookups, avoid retry storms. Cache only with a network and state identity and a freshness policy. Never cache a transient failure as a valid negative result.
8. **Make reruns safe.** Resume or rerun read-only analysis without duplicating records. Publish completed output atomically. Preserve the previous valid result if a refresh fails.
9. **Transaction retries are different.** Never apply the read-retry wrapper to commits, payouts or swaps. Reconcile the persisted signature and the chain outcome; an ambiguous response is not permission to create another transaction.
10. **Test failure paths.** Timeout, 429, temporary failure followed by success, permanent failure, malformed response, partial completion and provider inconsistency. Verify incomplete evidence cannot produce a passing result.
11. **Observable evidence.** Record sanitized failure categories, attempts, latency, completeness and snapshot context. Strip API keys, including keys embedded in RPC URLs, from logs and errors.
12. **Report scope honestly.** "The lookup recovered and this step completed" is a valid conclusion. "Production ready" requires the wider release gates, security review and end-to-end evidence.

For any step that fails: identify the error, implement and test bounded retries, rerun, then verify completeness and consistency before using the result.
