# kids-distribution

Claim vaults for a launched KIDS campaign. Native Rust with pinned `solana-program = 2.3.0`, the same toolchain as
`programs/atomic-launch`. Design: `docs/CLAIM-VAULTS-DESIGN.md`. Status: implemented with host tests; not deployed,
not reviewed, not immutable. Nothing about it may be described as "safe" or "renounced" until the immutability path in
the design has been walked and read back.

## Purpose

The launch program (`programs/atomic-launch`) is upgradeable because it has to keep evolving (fee cycle, new lanes).
Holders should not have to trust that upgrade key with their claims. This program holds the claimable supply in four
**purpose vaults** per campaign, pays every claim under terms copied once at activation, and has no instruction that
withdraws, resets, replaces a root, moves a deadline or closes a funded vault. Once its upgrade authority is revoked
the terms cannot change.

## Vaults and terms

Every amount is a share of the **original supply** recorded at activation, using the launch program's integer rule
`supply / 10000 * bps`. The remainder `supply % 10000` (below 0.01 token at six decimals; zero for the fixed
one-billion supply) stays in launch custody and is owed to nobody.

- **Purpose 0, participants**, 43.5 %: `allocation × accepted / settled_accepted` per settled launch receipt. No expiry.
- **Purpose 1 and 2, parent A and parent B**, 5 % each: Merkle allocation copied from the launch program's parents
  account, 0.05 % holding threshold, claimable from the launch time until **parent expiry** (launch time plus
  2,592,000 seconds, 30 days). From the expiry on, anyone can burn what is left in that vault, once per parent.
- **Purpose 3, dev**, 3 %: 1 % at launch plus 2 % linear over three calendar months from launch, month end clamped,
  no expiry. The dev wallet is copied from the campaign at activation, so a later launch-program change cannot
  redirect it.

Donations into a vault never raise an entitlement: anyone can burn the excess with `sweep_donation_to_burn`.

## Accounts

- **Distribution** `["distribution", campaign]`, 512 bytes, magic `KIDSDST1`. Offsets follow the design: campaign 8,
  mint 40, launch program 72, original supply 104, settled accepted 112, launch time 120, parent expiry 128, dev
  vesting start 136 and end 144, parent roots 152, parent supplies 216, eligible totals 232, allocation 248 (4 × u64),
  claimed 280 (4 × u64), burned 312 (2 × u64), dev prior 328, flags 336 (bit 0 activated, bit 1 parent A burned,
  bit 2 parent B burned), bumps 337 (distribution plus four vault authorities), dev wallet 344. Everything below
  offset 280 is written once at activation; later instructions rewrite only claimed, burned and flags.
- **Vault authority** `["vault", campaign, purpose]` for purpose 0..3. The vault is that authority's associated token
  account for the child mint (classic Token program, six decimals).
- **Claim receipt** `["claim", campaign, purpose, owner]`, 88 bytes, magic `KIDSDCL1`: campaign, owner, purpose, bump,
  claimed byte at 74, amount paid at 80. Participants and parents get one; the dev counter lives in Distribution.

The launch program's accounts are read but never written: campaign (384 bytes, `KIDSESC3`), parents (256 bytes,
`KIDSPAR1`) and participant receipts (112 bytes, `KIDSREC3`), each checked for owner, length, magic and PDA seeds.

## Lifecycle

`activate` (tag 0, body: four `u64` prior counters) runs once, signed by the launch program's launch authority PDA
(a CPI at the end of the launch instruction) or by the campaign creator. It reads the launched campaign (phase 3) and
the parents account, copies the terms, creates the four vault token accounts, burns anything a vault already held,
moves `allocation − prior` per purpose from the signer's source token account into each vault, and requires each vault
to hold exactly that amount afterwards. The prior counters are what the launch program already paid before this
activation: zero for a fresh launch; for a migrated campaign the parent and dev priors must equal the launch program's
own counters, and the participant prior is the sum of receipts already paid.

`claim_participant` (tag 1) is signed by the receipt owner, who pays the receipt rent. It refuses unsettled receipts
and receipts already paid by the launch program, pays once from vault 0, and is a no-op when the claim receipt exists.

`claim_parent` (tag 2, body: index, balance, allocation, proof) is signed by the leaf owner. The leaf is
`hashv("kids-parent-v1", campaign, index, owner, balance_le, allocation_le)` with sorted-pair hashing up the tree. It
requires `launch_time <= now < parent_expiry`, the vault not burned, balance at or above the threshold, allocation equal
to `reserve × balance / eligible`, and the proof to reach the copied root.

`claim_dev` (tag 3) is signed by the dev wallet and pays `entitled(now) − claimed`. Nothing to pay is a no-op.

`burn_expired` (tag 4, body: index) needs no signer, requires `now >= parent_expiry`, burns the whole vault balance,
records it and sets the flag. A second call returns `AlreadyBurned` (custom error 12) and touches nothing. Parents are
independent: burning A leaves B claimable until its own burn.

`sweep_donation_to_burn` (tag 5, body: purpose) needs no signer and burns whatever a vault holds above
`allocation − claimed` (or above zero for a burned parent vault). Counters do not change.

Every tag above 5 is refused. Custom error codes are the `E_*` constants at the top of `src/lib.rs`.

## Testing

```
cargo test
```

Host tests cover the allocation table and conservation for several supplies, threshold and pro rata rounding, dev
vesting at start, middle, end and after with month-end clamping, the parent window and burn decisions at every
boundary second, Merkle proofs for every leaf of a small tree, the Distribution and claim receipt layouts, instruction
parsing for every tag, and the handlers. A syscall stub serves the clock and rent and emulates Token transfers and
burns, so `claim_dev`, `burn_expired` and `sweep_donation_to_burn` are checked end to end on the host, including the
vault authority signer seeds. Account creation (System and Associated Token CPIs) is refused by the stub, so
`activate`, `claim_participant` and `claim_parent` are checked up to that point; their funding and receipt paths need
the localnet lifecycle in the design's test list, which is not part of this crate.

## Build

```
cargo build
cargo-build-sbf
```

Deployment, the launch-program CPI hook, migration of an already launched coin and the upgrade-authority revocation
follow the design document and are not done here.
