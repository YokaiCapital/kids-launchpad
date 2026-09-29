# A15: database clock for worker custody

27 September 2026. Review before mixed-load qualification found that worker job
leases used process wall clocks while signer authorization used database time.
Fast or slow worker hosts could mis-schedule retries, extend apparent leases or
publish results after database-time expiry. The isolated public-launch path now
uses PostgreSQL time for all job lease acquisition, renewal, expiry checks and
result publication, including the less-used single-job leasing API.

Updates acquire the job row before evaluating expiry. This prevents a writer
waiting on an unchanged locked row from completing with a predicate evaluated
before the lease expired. Lane selection still uses SKIP LOCKED and increasing
fencing tokens. Signer authorization reads its grant, lease and database time in
one statement and conservatively subtracts the monotonic response duration.
Workers anchor scheduling to the database lease timestamp and advance that
baseline monotonically. They retain unknown transaction outcomes for chain
reconciliation. SQLite's deterministic test clock is unchanged.

Verification:

- Full regression: **649 passed, zero failed/skipped**, including the isolated
  scale-bootstrap checks. No frontend changes were made in this checkpoint.
- Real PostgreSQL tests inject hosts one day ahead/behind, exercise all three
  acquisition APIs, renewal, expiry, publication, takeover, not-before, due lists
  and runner deadlines/retries.
- A held database row delays completion beyond a one-second lease; completion
  correctly fails with STALE_LEASE without changing the job result.
- Existing independent-lane qualification still runs 100 synthetic closes,
  100 fees, 100 refunds and 2,000 backfill jobs without lane starvation. This is
  scheduling evidence, not a chain throughput result.

Against the ultimate goal, worker custody and recovery improve. This does not
make PostgreSQL time monotonic through failover or excuse host time monitoring.
The database primary and replacements need controlled clock synchronization;
coordinated restore/failover remains a release gate. Chain time and finalized
chain evidence remain authoritative for financial eligibility and settlement.
No existing program, funded coin, economics or public activation is changed.
