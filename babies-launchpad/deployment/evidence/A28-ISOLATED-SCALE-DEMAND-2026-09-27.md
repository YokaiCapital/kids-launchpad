# A28: isolate blocked campaign demand

27 September 2026. Private capacity advice; no provider changes or public activation.

Previously a single campaign's expired or revoked grant blocked scaling for every financial lane. One funding-wait job also held its whole lane. That would let an abandoned campaign suppress capacity for healthy new launches.

The database observer now reports aggregate due and scheduled demand excluding each affected campaign/job, with separate blocked-authority and blocked-funding counters. Existing queue totals and alerts remain visible. The planner uses those counts for growth, preserves warm minima, and still refuses growth against unavailable or exhausted upstream admission. Older observations retain their conservative blocking behavior. Active, unresolved, failed or pending work still prevents speculative downscaling.

These counts are conservative scheduling hints, not grants or a funding attestation. Every worker and signer still checks the exact capability, operation, scope, lease and operating budget. No authority, ledger, financial packet or signing policy is modified. The provider controller remains unimplemented; advice has `apply: false`.

Validation: 716 regression tests pass, zero failures/skips, including actual PostgreSQL classification of three campaigns (healthy, expired, unfunded), concurrent observations, prewarming, malformed demand refusal and preserved upstream limits. Real codec and database backup tools were enabled. No hosted capacity claim is made.
