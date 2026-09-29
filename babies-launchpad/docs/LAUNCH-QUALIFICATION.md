# Launch integration qualification

Status: the combined v3 launch, claims and fee-routing rehearsal passed on isolated localnet. Production launch remains disabled. The local UI uses the long-lived v3 campaign on port 19099 and preserves legacy v1 refunds. This is a separate fixture, not a public Shartcoin (`$Shartcoin`) launch; `SHART` remains the internal configuration key.

## Verified components

- Immutable v1 escrow: commitments, pro-rata excess refunds, below-soft-cap full refunds and missed-launch full refunds.
- Separate immutable v2 settlement fixture: counts registered receipts, freezes each accepted amount, accumulates exact accepted SOL on-chain, and refuses readiness until all receipts settle. Refund rounding stays reserved. No withdrawal or launch-success instruction exists in this version.
- Pinned upstream CPMM build: genuine pool creation, 2% config, exact pool reserves, atomic mint/freeze authority revocation, real swaps and protocol/fund fee accrual.
- Actual canonical CPMM and Burn & Earn binaries cloned into a separate validator: pool creation, all LP locking and mint authority revocation in a single versioned transaction. Failed locking rolls back pool creation. Fee Key holder can collect swap-generated token and SOL earnings; unrelated wallets and direct LP withdrawals are rejected.

The nominal 2% trading fee is allocated as 0.98% KIDS treasury, 0.20% dev, 0.25% to buy and burn each parent, and 0.32% Raydium protocol/fund. Convert collected child-token fees to WSOL, then apply cumulative weights 98:20:25:25/168 to actual realized WSOL proceeds, without deducting protocol fees twice. Parent budgets are equal spending allocations, not equal token counts. Cumulative integer accounting retains rounding dust until distributable. The v3 fee module now collects with the campaign PDA, pays immutable recipients, and buys and burns both parents atomically. See [fee distribution specification](FEE-DISTRIBUTION.md).

The canonical fee configuration currently contains an optional 500 ppm creator rate. The tested legacy pool initialization disables creator fees at the pool. Production validation must check this flag rather than assume configuration metadata alone establishes the effective rate.

- New v3 atomic escrow: fixed mint and one-billion-token supply, complete on-chain settlement, exact accepted SOL funding, canonical pool creation, full LP locking, campaign-owned Fee Key, mint/freeze revocation and preserved excess refunds. Downstream lock failure rolls back the entire transaction. Campaign/source/native-vault donations are handled. This development program remains upgradeable.

## Reproduce

Legacy v1 / fixture vesting validator stays on `127.0.0.1:18999`; active v3 uses the separate `19099` validator:

```sh
node babies-launchpad/localnet/deploy-cpmm.mjs
node babies-launchpad/localnet/verify-cpmm.mjs
node babies-launchpad/localnet/verify-cpmm-swap.mjs
node babies-launchpad/localnet/launch-escrow-deploy.mjs
node babies-launchpad/localnet/launch-escrow-verify.mjs
```

The lock rehearsal uses a separate ledger on `127.0.0.1:19099`. First startup downloads public mainnet program/account data; it does not send transactions to mainnet. Fixture wallets are newly generated and funded by the local faucet:

```sh
node babies-launchpad/localnet/start-lock-rehearsal.mjs
# Separate terminal:
node babies-launchpad/localnet/verify-burn-earn.mjs
node babies-launchpad/localnet/atomic-launch-deploy.mjs
node babies-launchpad/localnet/atomic-launch-verify.mjs
node babies-launchpad/localnet/verify-atomic-fees.mjs
```

The local admin page (`/#admin`) also provides **Run local launch test**. It starts a fixed local-only fixture command and displays its recorded addresses/checks. It does not migrate the active Shartcoin campaign or enable production deposits.

Reports and chain state are stored under ignored `localnet/.runtime/`. Clone ProgramData slots/authorities are local metadata, not evidence about mainnet upgrade control. The rehearsal records hashes of cloned executable bytes. The source-built CPMM test additionally compares the deployed ELF bytes against the recorded build hash and rejects changed bytes, malformed loader layouts and nonzero deployment padding.

## Combined verification evidence

The current development binary SHA-256 is `e0b4051752422366e51ae6a5fe8eaeeeab773faa1448cec33a0990961c76e71d` (177,880 bytes). Both reports record this same binary and campaign `46yuTsZ5J2RNp5tjaPD4wKwG2Xp5R2kyzFKL6vn96x91` on the separate `19099` ledger. The launch/claim harness passed 26 checks; the fee harness passed 9 checks.

Participant claims pay the 43.5% reserve proportionally to accepted contributions. Each parent has a 5% reserve with the 0.05% holder threshold, immutable pre-commit roots, recipient-bound Merkle proofs and replay protection. Dev claims pay 1% at actual launch plus elapsed vesting from the remaining 2% over three UTC calendar months. Tests cover altered proofs, recipient substitution, prefunded claim PDAs, voluntary circulating-token burns and repeated claims.

Snapshots obtain supplies and token-account balances from one finalized bank. The on-chain root still trusts the authorized publisher: this mechanism does not independently prove historical balances or complete account enumeration. Parent token fixtures are not production token identities.

Fee tests cover actual campaign-owned Fee Key collection, child-fee conversion, cumulative treasury/dev routing, parent purchases and SPL burns, expired/unsafe quotes, unauthorized keepers, redirection, failed-swap rollback, spent-budget replay and preservation of donated parent tokens. Fee custody is separate from claim reserves. Creator keepers remain trusted for economic execution timing; the 98% spot-quote floor and 120-second expiry do not replace an external oracle or MEV controls. This integration pins canonical CPMM index-2 pools and does not provide arbitrary routes.

## Remaining integration gates

1. Complete after-close execution of the persistent v3 localnet campaign, external wallet claim signing, verified production parent identities and production authorization. The local application now uses v3 while retaining legacy v1 refund access; the post-launch preview still targets its separate test fixture.
2. Qualify full application success/failure/recovery paths, snapshot publication controls, keeper operation, quote safety and operational retry procedures. Dev terminal vesting has unit coverage; the real-time fixture verifies launch and elapsed claims rather than waiting three months.
3. Obtain independent security review, production deployment and reproducible-build verification, and resolve upgrade controls before real deposits. Local v3 remains upgradeable; no mainnet launch is enabled.

## Upstream source boundary

KIDS integration code is published under the repository license. Raydium CPMM is pinned to upstream commit `59fb845a9e5bb569c8b2f3415f13b0c0ebcc6b92`; its original Apache-2.0 license is retained in generated build staging. Local build substitutions are limited to the program ID, fee recipient and upstream localnet-admin feature.

Raydium explicitly lists its Burn & Earn contract source as not publicly available. Testing its deployed executable does not make that dependency source-verifiable or independently audited by KIDS. See [Raydium's source registry](https://docs.raydium.io/reference/program-addresses) and [Burn & Earn](https://docs.raydium.io/user-flows/burn-and-earn). The Fee Key must be retained to collect earnings; burning it would remove that right.
