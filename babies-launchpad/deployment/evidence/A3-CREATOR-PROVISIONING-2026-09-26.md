# A3: creator campaign provisioning, 26 September 2026

Status: implementation and isolated local qualification; not public activation.

## What changed

- Schema 18 adds immutable shared provisioning plans. A plan binds the accepted
  creator review, exact itemized pool reserve, finalized mint evidence, metadata,
  schedule, cap preset, issuer and configured treasury. Concurrent replicas seal
  one plan. An old review without the new reserve breakdown cannot gain approval
  silently. Reading a stored plan never refreshes its schedule or amount.
- Standard v3 setup reuses the existing program instruction builders and fixed
  economics: 48.5% participants / 48.5% permanent LP / 3% dev; 1% immediate and 2%
  linear over three UTC calendar months. (Later note, 27 September 2026: the owner
  re-sealed Standard v3 as 47.5 / 47.5 / 5 with 1.5% immediate and 3.5% linear; this
  evidence records the run as it happened under the earlier proposal.) Future LP recycling, reserve and Auto MM
  fields are rejected, not ignored. No old program or funded launch is upgraded.
- Native SOL token custody preparation is a separate 338-byte creator-signed
  packet. Campaign creation and its exact setup-reserve transfer are atomic in a
  1122-byte packet. Combining all three instructions would be 1260 bytes, above
  Solana's 1232-byte transaction limit. A duplicate create fails before the transfer.
- The private PostgreSQL outbox persists and verifies the exact signed packet
  before broadcast. It only rebroadcasts identical bytes. Unknown responses remain
  pending; confirmed transactions wait for finality. Finalized failure/expiry needs
  reconciliation, never an automatic replacement or a second payment.
- Finalized read-back checks sealed campaign bytes/hash, program ownership, rent
  plus commitment liability, setup SOL at the program-derived authority, canonical
  native custody, full token custody, immutable metadata and revoked mint/freeze
  authorities. Donations and early direct commitments are not treated as faults or
  credited as creator setup funding.
- Verified setup can register one private directory row. Concurrent retries do not
  overwrite later chain state or moderated names. Registration grants no signer
  capability, invents no balance and starts no financial worker. The chain reader
  remains responsible for current status; the registrar does not guess from time.
- New v3 cost reviews separately identify the reserve the launch authority can
  actually spend: AMM creation fee, pool/observation/LP mint rent, two pool vaults
  and the authority LP token account, plus the quoted margin. Mint costs, native
  custody preparation, transaction fees and keeper/treasury-paid costs are not
  transferred to this reserve or charged for a second time.

## Evidence

**378 tests passed, zero failures and zero skips**, covering PostgreSQL, creation,
worker lanes, signer boundaries, market reads, private media, auth and registry.
Production client/SSR build and `git diff --check` passed. These tests do not
substitute for hosted/mainnet qualification.

An actual localnet creator setup used the previously qualified inventory mint:

- Genesis: `7Sxh5h588K957C1to4Pvx6zQY6CLpghPCeG3ZeyrZJef`
- Issuer: `2T1K7xegEghMfR5RxtpJurG5bQhesHK6y8cvhpSos7CV`
- Mint: `9NoVuTBqZdvF5xDEJV5Po4wwyP7nsi6i9fmV8Fspkids`
- Campaign: `5XdQGc5UebRfWYTdpCmJqUKUPgAR7wzpyWkwfcWUDy44`
- Native custody transaction:
  `5wUwbB98i6uvqGoZbBbGspL8TAvzAbSdxoFXQjH2XWxYGfQ5d58gUfGNmdgPGbeCwDBdYTbwiwFfvssCcFPggt7x`
- Atomic create/fund transaction:
  `55bqwEyv6aZ965HbbzEDWbgtC8KRbLrzU5dFoGtycVJDi5jwYqHDRSPcX978uuyXjcCAroLKEovDyhwQAmqSTLhs`

Both transactions recovered after deliberate post-broadcast interruptions, using
new executor instances and the persisted signed bytes. The setup authority held
exactly 300,000,000 lamports: an explicit synthetic local reserve, not an all-in
production quote. Duplicate creation simulation failed and changed no balance.
The initial rehearsal did not include registration; private registration is
covered by PostgreSQL tests. The reusable qualifier now also tests that step.

An additional later read-only attempt to reconstruct the old rehearsal from its
signature could not proceed because the local RPC returned no historical status.
It sent nothing and did not infer finality. This does not invalidate the earlier
captured finalized result; it reinforces the requirement to retain the durable
finality journal and qualify archive/history retention and backup restoration.
The qualification's temporary PostgreSQL schema had intentionally been dropped.

## Remaining A3 and release gates

1. Persisted creator wallet offers for both setup stages, protected account routes,
   progress/resume UX and complete creator-flow integration. These modules are
   internal; do not mount the record method with browser-supplied block/expiry.
2. Reconciled signing generations and immediate-start timing. The existing program
   only allows the sealed opening time up to 60 seconds in the past at creation;
   the new preflight leaves a 30-second confirmation margin. A delayed wallet is
   refused, not silently assigned a new start. Current frozen plans do not yet
   recover that delay. Scheduled starts require at least 180 seconds at sealing.
3. Full operating-funding policy and qualification. The authority's pool reserve
   cannot pay keeper lock creation, treasury fee-state setup or indefinite receipt
   processing. Funding caps/charge/sponsorship and return accounting for those
   costs must be explicit before activation. No transfer to an operator wallet or
   silent campaign cross-subsidy was introduced. Seeding worker jobs and issuing
   scoped signer capabilities remains behind that gate.
4. Shared public profile publication (including banner/video), real private bucket
   and publication provider qualification, real external-wallet tests, independent
   security review, mixed hosted load and release evidence. No public creation,
   hosting rollout or mainnet action took place.

## Ultimate-goal check

The creator's approved mint can now be turned into an on-chain campaign with
atomic program custody funding and recoverable transaction evidence. This closes
one real A3 execution gap and preserves concurrent-campaign isolation. It is not
completion of the end-to-end public launch product or a production-ready claim.
