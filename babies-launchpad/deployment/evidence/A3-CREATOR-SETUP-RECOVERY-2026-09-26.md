# A3: explicit setup recovery — 26 September 2026

Isolated v3 implementation only. This changes neither an on-chain binary nor
any funded campaign, and does not activate public creation.

## Recovery rules

Schema 20 preserves the original setup plan and appends reviewed creation
revisions. Native-custody execution always uses the original plan and its durable
receipt. Campaign creation uses the latest validated revision and a separate
operation identity, preventing reuse of an old approval for new timing.

A creator explicitly requests recovery using the expected intent hash. For an
immediate-start launch, only the opening and derived deadlines can change; mint,
nonce, supply, recipients, setup reserve, caps, fees and funding duration remain
identical. A scheduled launch keeps its exact opening; a missed scheduled start
requires reviewing the launch rather than moving it silently.

Before any new revision, the service requires:

- the authenticated pilot owner and the original accepted quote;
- finalized native custody;
- no confirmed/finalized successful creation in the durable journal;
- terminal chain evidence for any signed creation attempt;
- finalized block height beyond **every** old offer's validity, even offers not
  submitted through the API, because a wallet could relay signed bytes elsewhere;
- a fresh account read at or after that finalized observation: no campaign account,
  unchanged full mint custody, revoked authorities and valid native custody;
- an unchanged genesis, original request, offer set and approval journal.

The final rechecks and revision insertion use the same PostgreSQL lock as
approval. Offers are superseded atomically. An approval whose RPC preflight began
before recovery cannot be recorded after the revision wins. Lost recovery replies
return the same revision when retried with the same expected hash. Unknown RPC
results leave the existing operation intact. Recovery sends no transaction.

The next signing offer exposes the new intent hash and generation for review.
`creation/setup/recover` is optional, signed-session/pilot/CSRF/origin protected,
and blocked while startup financial reconciliation is closed. No hosted service
mounts it automatically.

## Verification

- 393 regression tests passed, no failures/skips:
  `/tmp/kids-provision-recovery-regression.log`.
- PostgreSQL tests cover concurrent recovery, old approval versus recovery,
  unknown and confirmed signatures, unsigned-offer expiry, unavailable/stale RPC,
  fixed scheduled times, changed custody/ledger/owner and unchanged economics.
- Production frontend build passes: `/tmp/kids-setup-recovery-build.log`.
- Publication scanner checked 809 files with zero pattern findings. Pattern
  scanning is not a guarantee of absence of every possible secret.
- The reusable `localnet/creation/qualify-creator-setup.mjs` rehearsal creates a
  fresh encrypted-inventory mint, deliberately ages out an immediate opening,
  recovers it, signs/finalizes both setup stages, registers privately, and checks
  that duplicate create-and-fund fails atomically. Its live run is recorded below
  when complete; unit tests are not substituted for that evidence.

## Remaining scope

Native-custody and mint approvals which themselves expire still require their own
reconciled generation policy. This implementation recovers campaign-creation
approvals and delayed opening times; it must not be described as universal retry
recovery. Complete creator wizard/service composition, actual external-wallet
qualification, full operating budgets, media/provider qualification, independent
security review and hosted mixed-load/recovery gates remain.

## Ultimate-goal check

Creators can review a fresh creation request after a proven expiry without
repeating native setup or altering approved economics. This is progress toward
the full safe creator journey; it is not public production readiness.

## Completed local-chain rehearsal

The fresh-mint run passed on isolated genesis
`7Sxh5h588K957C1to4Pvx6zQY6CLpghPCeG3ZeyrZJef`, program
`2T1K7xegEghMfR5RxtpJurG5bQhesHK6y8cvhpSos7CV`.

- Mint: `BH4gdtVMBnPZzdf76bKTBbcoLqazWySTAgt5zPnqkids`.
- Campaign: `CEYtL1fH3peYXzsx9qVWLW4coZQLiYucQeoqCyVWAEEp`.
- Mint signature: `65Ydma6BVQakXfJtkv2j6JfRsTpUdWxbsTy7epKAxWp55bPaxxqQGvu6U6JjveKQEprTDkSYKK6T7X9ywab9a6UD`.
- Native setup: `3H5GbxywhZYUfMkhm9zLWcHpaGBt3H5yA5XS5FstiEbPDmWpgQEraBRPzox4BpJ3SqtUYdoWDivwN6MsKsVY9z93`.
- Create/fund: `53DDj2WYuqKxC84cFcuaqGQwR5EcrzTKsRcgVnbHoE9YVdmW9EEPcFoyscFxyvAyzPvUq9uxxjJEDVHJWUR8eVor`.

Generation 2 moved the immediate opening from ledger time 1790416199 to
1790416231. Both setup stages recovered simulated post-broadcast process loss.
The authority held exactly 260,527,992 lamports from the synthetic local reserve
review. Duplicate create/fund simulation failed without changing that balance.
Private registration was idempotent. No workers were activated. The metadata URI
was a rehearsal fixture, not publicly published; mint-plan publication and an
external wallet were not qualified by this run.

Log: `/tmp/kids-creator-setup-e2e.log`. Report:
`/var/folders/nn/j4s3b1ps2qv3rdktzcdt_0z40000gn/T/kids-mint-qualification-grhOHZ/creator-setup-report.json`.
The private temporary PostgreSQL schema was removed after capture. The generated
inventory and its recovery material remain private and must never be published.
