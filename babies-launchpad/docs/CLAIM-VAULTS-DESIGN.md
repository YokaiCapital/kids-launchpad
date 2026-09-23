# Claim vaults with immutable distribution rules (design, 23 September 2026)

Answer to the owner-approved brief (claim vaults, 30-day parent expiry burns). Status: implemented in
`programs/kids-distribution` and integrated into the launch instruction (`programs/atomic-launch`), proven on the local
ledger on 23 September 2026 (`localnet/verify-distribution-launch.mjs`). NOT deployed to mainnet, NOT reviewed, NOT
immutable yet; the campaign layout offsets are 312 (distribution program) and 344 (activated flag).

## Summary in three lines

- A new, small, separately deployed program **kids-distribution** owns four purpose vaults per campaign (participants,
  parent A, parent B, dev) and pays every claim from the matching vault under fixed terms frozen at activation.
- The launch program keeps only what it needs (escrow, launch, liquidity, fee cycle). After activation it cannot move,
  reset or shorten anything in the vaults. The distribution program's upgrade authority is revoked after review.
- Only the two free parent allocations expire (30 days from the on-chain launch time); paid claims, refunds and dev
  vesting never expire. The existing test coin keeps its current terms (no expiry was disclosed for it).

## 1. Allocation table (unchanged economics)

| Purpose | Share of original supply | Amount for 1,000,000,000 coins | Rule |
| --- | --- | --- | --- |
| Participants (paid) | 43.5 % | 435,000,000 | proportional to settled accepted SOL; no expiry |
| Liquidity | 43.5 % | 435,000,000 | Raydium pool, LP permanently locked (unchanged, not a vault) |
| Parent A (Fartcoin) | 5 % | 50,000,000 | Merkle allocation, 0.05 % holding threshold; claimable 30 days from launch, then burnable |
| Parent B (Buttcoin) | 5 % | 50,000,000 | same |
| Dev, launch part | 1 % | 10,000,000 | claimable at launch, no expiry |
| Dev, vested part | 2 % | 20,000,000 | linear over three calendar months from launch, zero cliff, no expiry |

All amounts are computed from the **original** supply recorded at activation. A burn that lowers the mint supply changes
no entitlement.

## 2. Accounts (all PDAs of kids-distribution, seeds bound to the campaign and the mint)

`Distribution` (seed `["distribution", campaign]`, 512 bytes, written once at activation, then only counters change):

| Offset | Field | Notes |
| --- | --- | --- |
| 0 | magic `KIDSDST1` | |
| 8 | campaign (32) | launch-program campaign PDA |
| 40 | mint (32) | child mint, classic SPL, decimals 6 |
| 72 | launch program (32) | the program whose campaign settled the sale (read-only trust: receipts and settled totals are read from it) |
| 104 | original supply u64 | |
| 112 | settled accepted lamports u64 | denominator for participant claims, copied at activation |
| 120 | launch time i64 | copied from the campaign at activation |
| 128 | parent expiry i64 | launch time + 2,592,000 (checked add) |
| 136 | dev vesting start i64, end i64 | start = launch time (or the preserved start for a migrated campaign), end = three calendar months |
| 152 | parent roots (2 × 32) | copied from the launch program's parents account |
| 216 | parent supply (2 × u64), eligible totals (2 × u64) | copied |
| 248 | allocation (4 × u64) | participants 43.5 %, parent A 5 %, parent B 5 %, dev 3 % |
| 280 | claimed (4 × u64) | |
| 312 | burned (2 × u64) | parents only |
| 328 | dev claimed u64 (of 3 %) | preserved from the campaign on migration |
| 336 | flags u8 | bit 0 activated, bit 1 parent A burned, bit 2 parent B burned |
| 337 | bumps (5) | distribution + 4 vault authorities |

Vault authorities: `["vault", campaign, purpose]` with purpose 0..3; each vault is that authority's associated token
account for the mint. Claim receipts: `["claim", campaign, purpose, owner]` (participant: 1 byte claimed; parent: the
Merkle leaf's allocation; dev: none, the counter lives in `Distribution`).

Nothing in `Distribution` is writable by the launch program, an admin, a keeper or the upgrade key after activation:
there is no instruction that writes offsets 0..279 once flag bit 0 is set.

## 3. Instructions

| Tag | Name | Signer | What it does |
| --- | --- | --- | --- |
| 0 | `activate` | launch authority PDA (CPI from the launch program) or the campaign creator, once | Reads the launched campaign (phase 3), copies terms, transfers allocation minus prior from the launch custody into the four vaults (the vault token accounts exist before the launch: the keeper creates them, activation creates no accounts so the launch packet stays under the nested-instruction limit), burns any pre-existing vault balance, sets the flag. 17 accounts, 5 inner instructions on a fresh launch. |
| 1 | `claim_participant` | owner | Reads the launch program receipt (settled, accepted), pays `allocation × accepted / settled_accepted` from vault 0, writes the claim receipt. Idempotent. |
| 2 | `claim_parent` | owner | Verifies the leaf and proof against the copied root (same leaf format as today: `kids-parent-v1`), requires `launch_time <= now < parent_expiry`, pays from vault 1 or 2, records the receipt. |
| 3 | `claim_dev` | dev wallet | Pays `entitled(now) − dev_claimed` where entitled = 1 % + 2 % × elapsed/(end − start), capped at 3 %. |
| 4 | `burn_expired` | anyone | Requires `now >= parent_expiry`, burns the whole remaining balance of vault 1 or 2 with SPL `Burn`, sets the burned counter and flag. A second call returns `AlreadyBurned` and touches nothing. |
| 5 | `sweep_donation_to_burn` | anyone | If a vault holds more than `allocation − claimed − burned`, the excess is burned. Donations never inflate entitlements; they are removed, never distributed. |

Every instruction binds campaign, mint, purpose, token program and the vault PDA; caller-chosen source accounts are
refused. There is no withdraw, no root replacement, no deadline change and no close of a funded vault.

## 4. Activation inside the launch transaction

The launch program's tag 6 (`launch`) today moves 43.5 % to the pool and keeps the rest in the launch authority's ATA.
With vaults, tag 6 gains a CPI at the end: transfer 43.5 % / 5 % / 5 % / 3 % from the launch custody into the four
vaults and call `activate`. If the CPI fails, the whole launch fails and the campaign stays in its pre-launch state
(refund path unchanged), so a launched pool never exists with unfunded claims. Transaction size: the launch packet
already uses a lookup table; the four vault accounts, four authorities, the distribution account and the program add
ten addresses, all in the table. A size check on localnet is part of the implementation gate.

Launch program changes: claims tags 7, 8 and 10 are refused for campaigns with an activated distribution (they read a
flag written by tag 6), and the custody ATA holds nothing after launch except donations.

## 5. Immutability path

1. Deploy kids-distribution with an upgrade authority held by the governance key; run the full localnet lifecycle and
   the tests in §7; reproducible CI build; independent review of the source.
2. Deploy to mainnet, verify bytes, run one complete test campaign through it (launch, all claim kinds, expiry burn on a
   short-expiry test build is NOT acceptable: the expiry is a constant; the test uses a test coin and the real 30 days
   are observed on a rehearsal with a modified constant only on localnet).
3. Revoke the upgrade authority (`solana program set-upgrade-authority --final`). Only after the read-back shows no
   authority is the custody described as immutable anywhere on the site.

The launch program stays upgradeable (fee cycle, future lanes) but cannot reach the vaults: it is not a signer for any
vault authority and the distribution program has no instruction it could call to move funds.

## 6. Migration of the launched test coin (campaign 8LmwBAa5…, coin 8P47V2fj…)

This coin was launched under the old terms (no parent expiry disclosed). Decision recorded here, per the brief:
**no expiry is applied retroactively**; its parents keep claiming under the old program. The migration instruction is
therefore built for the general case but the test coin is left where it is. If the owner decides otherwise, the
migration runs as follows, one time, atomically:

1. Read the finalized campaign, receipts, parent claims and dev counters right before the migration.
2. `migrate` (launch program, tag 11, creator-signed, once): computes remaining amounts per purpose = allocation −
   already claimed under the old program, transfers exactly those from the custody ATA into the new vaults, calls
   `activate` with the preserved launch time, dev start and claimed counters, and sets the "distribution activated"
   flag so the old claim tags refuse. If any step fails, nothing moves (single transaction).
3. Evidence: before/after balances of custody and vaults, the migration signature, and the invariant check
   `custody_before = Σ vault_after + donations`.

## 7. Tests required before any deployment (from the brief)

Conservation against original supply; activation funds exactly; all claim kinds open at launch; parent claim at
expiry − 1 s, at expiry, after expiry; burn before expiry refused; claim/burn in both orders; independent parent burns;
repeated burns; substituted mint, vault, program, campaign refused; burn lowers supply by exactly the amount and
mint/freeze stay null; paid claims and SOL refunds after burns; dev vesting three calendar months, zero cliff,
preserved start and prior claims; burned supply does not change entitlements; duplicate claims, bad proofs,
cross-campaign proofs, overdraw, donations; failed CPI rolls the launch back; migration partial failure; direct claims
with the site down (CLI in `localnet/claim-cli.mjs`); no admin path exists (negative tests enumerate every tag).

## 8. Website and disclosures

Coin page: one compact allocation row with six labelled parts and an expandable details area per part (allocated,
claimed, remaining, expiry in UTC with countdown, burned amount and signature). The participant card never shows the
parent timer. Facts only from finalized chain reads: vault addresses, program ids, upgrade authority read-back, mint and
freeze authorities, LP lock, fee key. No "safe" or "renounced" badge. Reminders at 7 days, 3 days and 24 hours before
the parent expiry are best-effort site banners.
