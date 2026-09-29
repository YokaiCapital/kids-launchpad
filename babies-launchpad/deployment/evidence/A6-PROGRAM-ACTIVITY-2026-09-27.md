# A6: Standard v3 program activity

Implemented isolated Standard v3 activity decoding, shared storage, bounded indexing/backfill jobs, authenticated reads and the coin-page Activity tab. Existing legacy/Family activity is untouched.

## Accuracy and isolation

- Explicit issuer version and Standard mode; v3 tag 22 is an operator rotation, never the legacy token sale. Tag 27 shows actual unused setup SOL returned to the creator.
- Reads executed transfers and burns, never planned instruction amounts. Failed attempts show no program asset movement. Unknown failed instructions cannot poison the indexer; successful unknown instructions require decoder support.
- Batched native refunds are attributed only when unique recipient balance changes, payer network fees and campaign custody reconcile exactly. Mixed/ambiguous refunds retain an explicit unknown amount, never a guessed payout or repeated transaction total.
- Migration 30 stores immutable finalized events and exact amounts by ledger/program/campaign/signature/path. Fenced atomic page/cursor/successor publication, keyset indexes and duplicate fingerprints protect replay/restart. Reads are bounded, cached and single-flight.
- Activity jobs have separate cursors and archive work from chart history, and stay in read lanes separate from fee collection/distribution and user financial actions. v2 service leases remain unchanged.
- Default view contains money movements. All events and failed attempts are separate filters, eight rows per page. Small nonzero burns remain nonzero with exact values on demand; explorer/copy links, partial-history warnings and stale/error states are included.

## Evidence

- Full bounded regression: **596 tests passed**, no failures or skips (`/tmp/kids-activity-regression.log`). Includes legacy market/activity tests, migrations, v3 movement/refund fixtures, fencing, idempotence, filtering, cross-campaign isolation, authenticated HTTP reads and 100-reader coalescing.
- Feature-enabled production build passed (`VITE_KIDS_PUBLIC_LAUNCHES=1 npm run build`), including the public route chunk.
- Browser checks at 1440, 768, 390 and 320: no page errors/overflow; filters, pagination, incomplete-history warnings, chart/trade and fee regressions passed (`/tmp/kids-activity-qa.json`).
- Read-only owned local validator qualification against campaign `62Vz43SXYiVv3eYJEQAtaz16ETNbAffHDGMH1LADVNQL` and v3 issuer `2T1K7xegEghMfR5RxtpJurG5bQhesHK6y8cvhpSos7CV`: verified campaign identity, worker publication and reader restart. Old program transactions had pruned; result correctly remained **partial, zero indexed events**, not a claim of zero lifetime activity. Positive movement decoding uses deterministic executed-transaction fixtures; this is not a new full on-chain activity lifecycle rehearsal.

No hosted activation, economic change, production program upgrade or production transaction occurred. These checks do not substitute for an archive-backed full lifecycle and representative hosted fleet qualification.

## Fresh joined lifecycle qualification (27 September)

A fresh actual Standard v3 campaign `GwoirjCVHVL7d3PDY9AmwoeCZJqjzxyThX4CxeXTTUGY` completed automatic settlement, launch, 1 SOL excess refund, fee setup/activation and all three independent fee jobs across controller and signer-journal restart. The creator then returned unused setup funds, claimed participant/dev tokens, burned tokens and bought from the pool. Current custody verification still passed afterwards.

The activity index covered initialization through claims with **11 finalized events**, exact refund/participant claim amounts, setup return and complete history. The chart indexed the actual buy and produced its verified candle. Operating accounting reconciled 40,000,000 funded lamports, 14,320,840 spent and zero held; this is a local fixture, not a public funding-policy decision.

Two earlier attempts correctly went stale when the validator's default 10,000-shred retention pruned the observation boundary (only approximately 40 retained slots at inspection). The owned 19199 validator was resumed from the same ledger/genesis with `--limit-ledger-size 1000000`, then a new campaign passed. Missing-history checks were not weakened. Hosted archive retention and provider failover still need qualification; this establishes the fresh local joined path only. Neither the 18999 nor 19099 validators was touched.
