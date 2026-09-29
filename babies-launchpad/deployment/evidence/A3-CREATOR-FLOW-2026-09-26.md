# A3 joined creator flow — 26 September 2026

The private v3/localnet coordinator now joins existing durable preparation,
publication, mint approval/execution, native custody, campaign creation and private
registration. An explicit local composition factory reuses the encrypted
inventory; no new key-storage or signing implementation was introduced.

## API and recovery contract

Optional authenticated routes under `/api/account/launches/creation/flow/`:

- `status`: read-only stage, action, public signatures and network; never sign/send.
- `prepare`: advance off-chain preparation or return the next persisted wallet offer.
- `submit`: accept an exact signed offer for its original stage.
- `resume`: recover the existing inventory signature / broadcast persisted bytes,
  reconcile chain results, or register verified setup.
- `recover`: explicit bounded mint/setup recovery. Never automatically re-sign on
  a timeout or fabricate a new intent to get past uncertainty.

Each request is scoped to the configured pilot, owned accepted request, immutable
review hash, ledger, program and policy. Status survives service recreation. An
old response cannot relabel a wallet offer as the next stage: `result.stage` and
`result.requestId` preserve the offer binding even if the enclosing snapshot has
advanced concurrently. A finalized mint with an unfinished lease is reconciled
before setup advances. A duplicate final signature capture verifies both actual
signatures and returns the existing packet without writes or broadcasts.

All new mutating routes remain behind startup reconciliation, signed session,
pilot authorization, CSRF and origin checks. Real HTTP tests verify these guards.
Default hosted composition does not install these services. Registration returns
`fundingEnabled:false` / `workerActivation:false`; it grants no workers or spending
capabilities and is not a claim that a campaign is ready for deposits.

## Verification

- Final focused regression: 410 passed, 0 failed, 0 skipped.
- Production frontend build passed. No rendered UI changed in this increment.
- Localnet `qualify-creator-setup.mjs`: fresh encrypted `kids` stock, accepted
  synthetic quote, owned-artwork fixture and synthetic publication receipts,
  shared mint plan and wallet offer, actual mint transaction, then joined setup
  coordinator through delayed-start recovery, native custody, create/fund and
  private registration.
- Simulated process loss after each setup broadcast recovered the same signature.
  Registration was idempotent. Duplicate create/fund simulation failed, and the
  authority reserve stayed exactly 260527992 lamports.
- The metadata provider was synthetic; no hosted Pinata upload or external wallet
  extension was tested. This is local-chain/backend qualification, not production
  readiness, wallet compatibility or operational-funding qualification.

Localnet evidence:

- Genesis: `7Sxh5h588K957C1to4Pvx6zQY6CLpghPCeG3ZeyrZJef`
- Program: `2T1K7xegEghMfR5RxtpJurG5bQhesHK6y8cvhpSos7CV`
- Mint: `AbtrEnK1GX4rBcDKm6hy4xkxTbmHq3h4m7J6U3fvkids`
- Campaign: `Apotn6MLntfH4CwzWPB1hmAiRCrQ14UL3jKx7ChDAUii`
- Mint signature: `5R37k2783yYFhiDMEoYs9FzcQqhDxcQg38nn7D19CifgFXJySGoMc9BxLkM9L9BBuyAQkKibU9SPhfTeSrQtvkK`
- Native custody: `435ERdyzywAo9UPSgsd19UwGjo9qp7kiTJt69wphMwUZfGdbkZ9SjRVC11NyJ7Vyp41f5bsTmLTwN6ovUE35r3bh`
- Create/fund: `4syfZaGTneSRBxkHFjeb7hGmDNsbrmsUsoT4XxZBXkEPfXa6C21iqoirk4KV6hFZstGe888poSanAK1baVjjbr7W`
- Immediate opening recovery: generation 2, `1790417753` → `1790417785`.

## Next dependencies against the ultimate goal

1. Connect the resumable browser creator journey with independent transaction
   review, exact stage binding, durable request recovery and external-wallet tests.
2. Complete itemized operating funding and return accounting. Pool-initialization
   reserve is not keeper/fee-state/lock rent, and cannot silently sponsor other
   campaigns or unlimited operation.
3. Qualify profile publication and hosted media/provider isolation; optional video
   is still separate from this image/metadata path.
4. Exercise funded activation/lifecycle, independent fee/refund/claim capacity,
   mixed load, hosted signer separation, recovery, security and release gates.
5. Keep existing funded programs intact; future Direct/Auto MM remain separate and
   inactive. No public or mainnet activation follows from these local results.
