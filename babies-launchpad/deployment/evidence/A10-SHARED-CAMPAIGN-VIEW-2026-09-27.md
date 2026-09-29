# A10: finalized campaign views for new launches

Date: 27 September 2026. Isolated Standard v3 composition, no public activation.

The creator directory now reads shared finalized campaign observations instead of serving an unconnected registry row. A separate signer-free campaign-index job observes campaign, chain clock, current AMM configuration and the derived pool in one finalized context. It verifies ownership, PDA/genesis, immutable terms, slot progression and clock freshness before publication. Committed SOL, caps, phase and current fee come from decoded accounts. Unavailable current AMM fees remain unknown rather than reverting to marketing constants.

Schema 34 stores the observation and cursor. A fenced transaction publishes the snapshot, updates registry phase filters and schedules the successor; no old worker can overwrite it. API reads perform no RPC and retain the original observation timestamp. Missing/stale snapshots are explicitly unavailable with no invented zero balance. Registration schedules only read jobs; it does not grant signing or activate financial workers.

Verification: **620 regression tests pass, 0 failed/skipped**, including real PostgreSQL restart/CAS/stale/ownership/phase tests. Enabled build passes. The read-only actual-chain qualifier (`localnet/market/qualify-campaign.mjs`) observed campaign `A8ZJ6FGCS1jYJWwvYvibXpqS8g79bgzk36Z78k3W7yca` at finalized slot 121303, 2 SOL committed and its actual 200 bps pool fee. Restart and HTTP filtered-directory reads returned the same values without an active RPC-reading worker. This older local pool is 2%, not the new 2.5% preset; the difference is deliberately preserved.

Ultimate-goal comparison: participant discovery and current money/status visibility improve, still **partial** overall. Creator media/profile publication and operating funding, full external wallet journeys, representative mixed-chain load, hosted restore/monitoring and the release/security bundle remain. No existing coin or program was changed.
