# Joined Standard lifecycle and creator recovery

Scope: isolated local v3 Standard only. No hosted deployment, public activation,
existing program upgrade or participant economic change.

## What is now joined

Schema 26 records a campaign's immutable lifecycle binding and initial authority.
An explicitly configured controller coordinates independent settlement, launch,
refund and provisioning lanes. It uses chain time, waits without exhausting
attempts before the close, distinguishes excess refunds from a later full refund,
and requires every excess refund before handing authority to fee setup. Handoff
preserves the original grant's expiry and spending limits. Restart, revocation or
an exhausted operating reserve cannot manufacture a new grant or funding.

The v3 launch verifier now checks current liabilities in a single finalized
account snapshot. Valid claims, trades, burns and additional liquidity no longer
fail an obsolete comparison with initialization balances. Revoked mint/freeze
authorities, remaining claim/refund custody, canonical pool, lock coverage and
campaign-owned fee rights remain mandatory. Existing v2 verification is unchanged.

Creator management exposes claims, unused setup SOL and a recipient-paid repair
for a closed canonical WSOL payout account. Both server and browser independently
verify the exact self-owned ATA instruction. Opening the panel cannot sign. An
unknown account read cannot be interpreted as a missing account. Lost submission
responses retain the original durable transaction identity.

## Evidence

- Full bounded regression: **527 passed, 0 failed, 0 skipped**, including real
  PostgreSQL isolation/concurrency and legacy signer checks. Build passed.
- Controller tests cover atomic rollback, stale leases, concurrent scheduling,
  restart, revoked/expired grants, funding shortfall, failed raises and late
  failure after partial excess refunds.
- Exact wallet repair tests reject changed recipients, mints, extra instructions,
  legacy versions and unsafe existing accounts. Signed-response recovery is tested.
- Actual local-chain rehearsal (`localnet/creation/qualify-lifecycle.mjs`) used a
  fresh campaign, six independent workers, durable HTTP signer and a controller
  restart. It completed settlement, pool launch, a 1 SOL excess refund, fee setup,
  fee activation and all three fee worker classes. No manual job sequencing.
- The explicit local operating fixture funded 40,000,000 lamports; 14,320,840 were
  finalized costs, 25,679,160 remained, and held exposure was zero. Participant
  principal was accounted separately.
- Participant/dev claims, a token burn and a pool trade then succeeded, and the
  current custody verification still passed.
- Browser management checks at 1440, 768, 390 and 320 pixels passed without
  horizontal overflow or page errors. The actual site theme was included, and
  desktop/mobile screenshots inspected. Expand/details/repair-confirmation and
  wallet disconnect/reconnect passed. Browser actions used callback fixtures;
  this is not a real wallet-extension qualification.

Local-chain public identities (not production deployments):

- Campaign: `3J2oAK8B1417ox9s6GXwnq2qNapbEWK4FSsTQ19AzDpk`
- Mint: `GBRoWYVBN6wqgx52brfu1XNd23aVNRUXPqs3dQW4riHW`
- Program: `2T1K7xegEghMfR5RxtpJurG5bQhesHK6y8cvhpSos7CV`
- Genesis: `7Sxh5h588K957C1to4Pvx6zQY6CLpghPCeG3ZeyrZJef`

Private packets and signer journals remain outside the repository. Disposable
schemas and qualification workers were shut down after the run.

## Ultimate goal and remaining gates

Creator journey, verifiable money, recoverability and sustainable fee operation
improve but remain **partial**. The ordinary creator journey still needs an
explicit funded bootstrap; this controller requires an existing narrow grant.
Operating funding/charging policy is not inferred from a test fixture. Hosted
media providers, real extensions, representative mixed-chain capacity, restore
and monitoring qualification, and the security/release bundle remain open.
This evidence does not declare production ready or authorize new public presets.
