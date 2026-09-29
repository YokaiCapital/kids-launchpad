# V3 signer process ownership

Schema 28 adds one durable ownership row per genesis/program/payer. The new v3
registry signer must acquire it before examining or loading its private journal.
A second replica is refused. v2 and the existing production signer entry point
are unchanged; this does not fence arbitrary copies of a private key outside the
new composition. Deployment still needs one exclusive private volume and a
qualified key-access boundary.

The database grants a 30-second lease. Local monotonic time subtracts the whole
query round trip and a five-second safety margin. Renewal occurs independently
of request traffic. Any failed/late renewal or expired local window permanently
disables that process; it cannot silently regain authority after reconnection.
Signing checks ownership at ingress, after awaited policy reads, and after durable
journal flushing immediately before signing. Readiness returns 503 after loss.

Graceful `service.close()` stops signing, drains HTTP work and awaits release of
its exact owner/epoch. Old processes cannot release replacements. Callers must
await this method before starting a replacement. Crashed/unacknowledged owners
remain reserved until database expiry, then a replacement must pass journal and
shared-history verification again. This is intentionally not a repair that
creates an empty ledger.

Six PostgreSQL tests cover replica races, scope isolation, monotonic expiry,
stale release, lost database access, slow acquisition and late renewal. HTTP
signing tests cover loss during lookup and at the final signing boundary. The
bounded regression passes **558 tests, zero failed or skipped**.

## Operational limits

Time leases assume a single authoritative PostgreSQL timeline and bounded clock
adjustments. Database restore/failover to an independent or rolled-back timeline
must stop every signer and worker, reconcile chain/shared journal/volume state,
and then restart. Do not run both timelines, delete ownership rows to force a
rollout, share the key with an unfenced signer, or infer durable ownership from a
healthy HTTP process alone. Hosted volume/failover and coordinated PITR drills
remain release gates; this is local qualification, not public activation.

## Actual-chain restart

Owned localnet campaign `62Vz43SXYiVv3eYJEQAtaz16ETNbAffHDGMH1LADVNQL`
completed the lifecycle with enforced ownership and a graceful signer replacement.
It settled, launched, refunded 1 SOL, provisioned fees and ran all three independent
fee jobs. Claims, burn and buy succeeded afterward, current custody verified and
the independent indexer produced an actual trade candle. Operating accounting:
40,000,000 funded, 14,320,840 spent, zero held, 25,679,160 available lamports.
No hosted rollout, mainnet change or public activation occurred.
