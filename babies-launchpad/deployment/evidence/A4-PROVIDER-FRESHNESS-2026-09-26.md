# Finalized provider freshness and queue isolation

Live market ingestion now reads a finalized slot and that slot's block time before
reading a pool's signature page. `minContextSlot` binds that page to at least the
observed head. A regressed head retries as an upstream failure. A head over 120
seconds old, over 30 seconds ahead, missing, or malformed cannot refresh the cursor.
These are conservative liveness bounds, not a claim that finalized trades appear
instantly. The reader exposes provider slot/age separately from time since polling;
old cursors without head evidence are stale until a qualified new poll.

No trade is fabricated for an inactive pool. Historical candles remain available
when freshness is stale. Backfill uses its separate lane and does not refresh live
provider evidence. The two extra RPC reads per live poll consume that lane's shared
admission budget; include them in the remaining hosted load qualification.

## Tests

- 25 market tests passed with PostgreSQL, zero skips; stale/future/missing/regressed
  source heads, idle pools, context binding and fresh-poll/stale-provider cases.
- 304 focused regressions passed before the final explicit RPC error-classification
  test; the latter and runner/ingestion tests passed separately (21 tests).
- Full **v3 + PostgreSQL + actual local validator** lifecycle passed in 87.7 seconds:
  settlement crash recovery, launch/lock, refunds, claims, two swaps, finalized market
  indexing/reader, fee collection/distribution and child burn. 16 keeper sends
  confirmed, no failed or unknown sends, stale signer request refused.
- Accepted SOL: 1999999998 lamports. Oversubscription refund: 1323456791;
  failed-campaign refund: 1200000000. Fee collection: 2426720; treasury: 2137824;
  dev: 288895; child burn: 535726381833 base units.
- Local pool: `2vmpzVUknbE4Zdn1as5xK6Q98jvZShsbjnn3Dza57VEy`.
- Local launch: `5uxpYFhKXY4SqUBAR8N13v1kvoXDuyTpPC2d7vbgeduf5mLJaKpzTFXxWpyb89tgQWFY6oVGoQgYfaA3jCBiki5D`.

Run with `KIDS_ISSUER_TEST_VERSION=3`, `KIDS_REQUIRE_LOCALNET_TESTS=1` and
**`KIDS_V2_TEST_POSTGRES_URL`** for `localnet/test/protocol-v2-e2e.test.mjs`.
That lifecycle test uses this explicit URL, not the generic test database variable.
Log: `/tmp/kids-market-head-pg-chain.log`.

## 100-campaign lane isolation

`localnet/jobs/lane-capacity.test.mjs` uses real PostgreSQL, separate role pools,
100 launch jobs, 100 fee-harvest jobs, 100 refund jobs and 2000 backfill jobs. All
four lifecycle slots are deliberately blocked. All 100 fee jobs and 100 refunds
complete before any launch job is allowed to finish. Repeated scheduling produces
no duplicate fee jobs; after release there are exactly 300 completed effects and
2000 untouched backfill jobs. The measured independent-lane time was 108 ms on
this machine, with synthetic chain handlers; **this is not a mainnet throughput
measurement or SLO**. Log: `/tmp/kids-lane-capacity.log`.

Ultimate-goal comparison: prevents apparently fresh but stalled market data and
proves logical fee/refund isolation during a simultaneous launch backlog. Hosted
provider faults, network/signing throughput, 100 real closes, browser traffic,
autoscaling and alert/restore qualification remain. No production activation.
