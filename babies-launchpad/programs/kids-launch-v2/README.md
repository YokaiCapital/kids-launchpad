# kids-launch-v2

Program version 2 for KIDS public launches (plan `KIDS-PUBLIC-LAUNCHES-IMPLEMENTATION-PLAN-2026-09-24.md`,
stage P2). Native Rust with pinned `solana-program = 2.3.0`, the same toolchain as `programs/atomic-launch`.
Status: create, commit, finalize, settle, refund, assert-ready, the launch (tag 6), the custody claims and the fee
cycle (tags 20 to 26) are implemented with host tests, built for SBF without a stack-frame warning and rehearsed on a
localnet clone of the Raydium programs and the mainnet tier-2 config (see "Testing"); not deployed to mainnet. Reviewed once
(`deployment/evidence/KIDS-LAUNCH-V2-AUDIT-2026-09-24.md`; every High and Medium finding is fixed in this version).
Create refuses Family mode and any sealed distribution program, see "Family mode is disabled" below. The live Family
campaign stays on `programs/atomic-launch`; this program never reads or writes its accounts.

## What it does

A creator seals every financial term of a **Standard** (no parents) or **Family** (two parent mints) campaign in
one instruction. Wallets commit SOL into the campaign account between a sealed opening time and a sealed deadline;
reaching the hard cap does not close funding. After the deadline every receipt is settled with the same integer
rule the live program uses, `accepted_i = floor(commit_i × min(T, H) / T)`, the excess is refundable, and a
campaign that closed below the soft cap or whose launch deadline passed refunds everything. Refunds are
permissionless, bound to the receipt owner and idempotent. Dev tokens vest 1 % at launch plus 2 % linearly over
three UTC calendar months with month-end clamping; participants claim `floor(reserve × accepted_i / A)`.

The launch (tag 6, `src/launch.rs`) mirrors the reviewed path of `programs/atomic-launch/src/launch.rs` with the
sealed terms in place of that program's constants: the accepted SOL is wrapped, a Raydium CPMM pool is created on the
sealed AMM program and config with the launch authority PDA as pool creator, every LP token is locked forever through
the sealed lock program (the fee NFT is held by the campaign PDA), the mint and freeze authorities are revoked, and
the pool, vaults, lock position, mint and custody are read back before the campaign is written. Any failed check
fails the whole instruction, so no partial launch can exist. The liquidity reserve (its share plus the supply dust)
goes to the pool; participants, dev and, in Family mode, both parent reserves stay in the launch custody.

The fee cycle (`src/fees.rs`) mirrors `programs/atomic-launch/src/fees.rs` bound to the sealed terms: LP fees of the
locked position are collected into a per-campaign fee custody, the coin side is burned, the SOL side is split by the
sealed fee weights (treasury and dev are paid; the parent shares become buy-and-burn budgets, zero in Standard
mode), and each parent budget is spent through Jupiter and burned. The sealed treasury, which is the platform treasury
pinned in the program, names the operator (tag 20; on Standard campaigns any payer may open the cycle since 28 September 2026, the operator being inert there) and can replace it (tag 22). Collecting, distributing and burning
(tags 21, 23, 26) are permissionless: they move measured amounts to sealed destinations only, so anyone may run them
and nobody can withhold them. Only the operator runs the Jupiter buyback (tag 25); it chooses the slice, the route and
the quote, and its minimum output must clear a floor the program derives on chain from the parent's sealed reference
pool. Recipients, parent mints and weights come only from the sealed terms.

## Family mode is disabled

Create refuses Family terms with error 91 (`E_FAMILY_NOT_AVAILABLE`) after checking every other rule, and refuses a
sealed distribution program with error 90 (`E_DISTRIBUTION_NOT_WIRED`). Reason: a Family launch would keep 5 % of the
supply per parent in the launch custody, and no instruction of this program can pay those reserves to parent holders;
`programs/kids-distribution`, which pays such claims for the live campaign, reads only the version-1 campaign layout
(`KIDSESC3`) and a parents account this program does not have. Until the distribution program reads this layout (or a
parent-claim instruction bound to the sealed roots exists), Family campaigns would strand tokens, so they cannot be
created. The Family rules, the Family launch and the Family fee cycle stay implemented and tested (the tests seal a
Family campaign by hand after running the same validation) so the gate can lift without a layout change. Lifting it
also needs, per parent, a Raydium CPMM parent/WSOL pool to seal as the reference for tag 25, or another reference
source; a parent without one keeps its buyback budget in custody.

## Sealed terms

The create body is the campaign account's bytes 8 to 808 (`state::SEALED_LEN` = 800). The program validates
every field, copies the bytes into the account and stores `sha256("kids-launch-v2-terms" ‖ bytes)` as the terms
hash; `Campaign::decode` refuses an account whose terms bytes no longer hash to the stored value. No instruction
changes a sealed byte. `localnet/protocol-v2/policy.mjs` has the same encoder (`encodeTerms`) and hash
(`termsHash`), checked against the Rust side through `localnet/protocol-v2/test-vectors.json`.

Policy tables live in `src/policy.rs` and are selected by id; the program refuses a sealed table that its id does
not describe. They are proposals until the decision register carries an activation record:

- split policy 1 (Standard, version 2 only): 48.5 % participants, 48.5 % liquidity, 3 % dev
- split policy 2 (Family): 43.5 % participants, 43.5 % liquidity, 5 % parent A, 5 % parent B, 3 % dev
- split policy 3 (Standard, version 3; owner decision 27 September 2026): 47.5 % participants, 47.5 % liquidity, 5 % dev
- vesting rule 1: 100 bps at launch, 200 bps linear, 3 calendar months
- vesting rule 2 (version 3 Standard): 150 bps at launch, 350 bps linear, 3 calendar months
- the version-3 issuer refuses a Standard creation whose sealed body does not carry split policy 3 with vesting rule 2
  (`E_V3_ECONOMICS`); the version-2 program keeps policy 1 with rule 1 for its own identity
- fee routing version 1: Standard 148/168 treasury and 20/168 dev; Family 98/168, 20/168, 25/168, 25/168
- AMM config tiers: index 2 (2 %, localnet clone) and index 7 (2.5 %, mainnet, agreed 23 September 2026). Both
  carry `creator_fee_rate` 500 at offset 108 of the config; the program does not read that field. A creator fee is
  charged only by a pool whose own `enable_creator_fee` switch is on, and only Raydium's `initialize_with_permission`
  can switch it on; the launch sends plain `initialize` and refuses a pool that reads back with the switch on.

Dust rule: every reserve is `supply / 10000 × bps`; the remainder `supply % 10000` is added to the liquidity
reserve, so participants + liquidity + parent A + parent B + dev equals the minted supply exactly and no dust is
owed to anyone.

## Campaign layout

1,024 bytes, magic `KIDSLV2C`, layout version 2. Bytes 8 to 808 are sealed and hashed.

- 8 layout version u16, 10 mode u8, 11 decimals u8, 12 split policy u8, 13 vesting rule u8, 14 fee routing
  version u8, 15 creator fee enabled u8 (always 0)
- 16 genesis hash, 48 creator, 80 nonce u64, 88 dev, 120 treasury, 152 child mint, 184 supply u64
- 192 opens at i64, 200 deadline i64, 208 launch deadline i64, 216 soft u64, 224 hard u64
- 232 AMM program, 264 AMM config, 296 trade fee rate u64 (per 1,000,000), 304 config index u16
- 306 fee weights 4 × u16, 314 split bps 5 × u16, 324 vesting instant bps u16, 326 linear bps u16, 328 months u8,
  329 buyback max slippage bps u16 (Family 1 to 500, Standard 0), 331 one zero byte
- 332 lock program, 364 distribution program (all zero when none)
- 396 parent mints 2 × 32, 460 parent token programs 2 × 32, 524 snapshot slots 2 × u64, 540 roots 2 × 32,
  604 parent supplies 2 × u64, 620 eligible totals 2 × u64, 636 parent expiry seconds u64 (0 = never)
- 644 metadata hash, 676 metadata URI length u8, 677 metadata URI 128 bytes
- 805 parent reference config 2 × u8 (0 = no reference pool, n = Raydium CPMM AMM config index n - 1 of the
  parent/WSOL pool tag 25 quotes against), 807 one zero byte
- 808 terms hash, 840 phase u8, 841 bump u8, 842 flags u8 (bit 0 distribution activated), 843 five zero bytes
- 848 total u64, 856 refunded u64, 864 receipt count u64, 872 settled count u64, 880 settled accepted u64,
  888 participant claimed u64, 896 dev claimed u64, 904 parent claimed 2 × u64, 920 launch time i64,
  928 pool, 960 fee NFT, 992 reserved 32 bytes

Receipt: 128 bytes, magic `KIDSLV2R`, PDA `["commitment", campaign, owner]`: 8 campaign, 40 owner, 72 committed,
80 refunded, 88 sequence, 96 accepted, 104 claimed tokens, 112 bump, 113 settled, 114 claimed.

Phases: 0 scheduled or funding (the clock decides), 1 closed and funded, 2 refund only, 3 live.

## Instructions

- **Tag 0, create.** Body: the 800 sealed bytes. Accounts: 0 creator (signer, pays rent), 1 campaign PDA
  `["campaign", creator, nonce]`, 2 System, 3 the sealed AMM config; then the distribution program when sealed;
  then, for Family, the two parent mint accounts in order. Refuses an opening time more than 60 seconds in the past, a
  treasury other than `PLATFORM_TREASURY` (error 92), a hard cap below the soft cap plus one percent rounded up
  (`least_hard_cap`: equal caps can be made unlaunchable by settlement rounding), a Standard campaign with any parent
  field, a Family campaign without complete parent terms or with WSOL as a parent, a table that does not match its
  policy id, an AMM config that is disabled or whose bytes differ from the sealed index and rate or from the standard
  protocol and fund shares (`amm_config_matches`; the config's creator fee rate is not compared). After every rule:
  Family terms (error 91) and a sealed distribution program (error 90) are refused, nothing is written.
- **Tag 1, commit.** Body: genesis hash, amount, receipt sequence. Accounts: 0 owner (signer, pays the amount and
  its own receipt rent), 1 campaign, 2 receipt PDA, 3 System. Open in `[opens_at, deadline)` by the chain clock.
- **Tag 2, finalize.** Accounts: 0 campaign. Records funded or failed after the deadline; records the launch
  timeout after the launch deadline.
- **Tag 3, refund.** Accounts: 0 campaign, 1 receipt, 2 destination (the receipt owner). Permissionless,
  cumulative, idempotent.
- **Tag 4, settle.** Accounts: 0 campaign, 1 receipt. Once per receipt.
- **Tag 5, assert ready.** Accounts: 0 campaign. Succeeds only when a launch could run now.
- **Tag 6, launch.** No body. Accounts: 0 campaign, 1 keeper (signer, pays the lock rent), 2 launch authority PDA
  `["launch_authority", campaign]` (System-owned, empty, holding the sponsored setup budget: pool rent and the
  create-pool fee), 3 child mint, 4 child custody ATA holding the whole supply, 5 WSOL custody ATA, 6 fee NFT mint
  (fresh signer), 7 fee NFT ATA of the campaign, 8 locked liquidity PDA `["locked_liquidity", fee NFT]` of the lock
  program, 9 lock authority's LP ATA, 10 fee NFT metadata PDA, 11 Token, 12 Associated Token, 13 System, 14 Rent,
  15 the sealed AMM program, 16 the sealed AMM config, 17 AMM authority `["vault_and_lp_mint_auth_seed"]`, 18 pool
  state `["pool", config, mint 0, mint 1]`, 19 LP mint `["pool_lp_mint", pool]`, 20 launch authority's LP ATA,
  21 vault 0 `["pool_vault", pool, mint 0]`, 22 vault 1, 23 create-pool fee receiver, 24 observation
  `["observation", pool]`, 25 the sealed lock program, 26 lock authority `["lock_cp_authority_seed"]`, 27 Metadata,
  28 WSOL mint. Mint 0 is the lower of the child mint and WSOL. Requires readiness (funding closed, launch window
  open, not failed, not live, settled == count, accepted >= soft), the sealed mint (sealed supply and decimals,
  any remaining authority is the launch authority) and the sealed config read back; then, in order: SyncNative on
  the WSOL custody, the campaign's accepted total wrapped through the launch authority (System transfer), CPMM
  `initialize` with the liquidity reserve and the accepted SOL (`cpmm_initialize_data`: the discriminator and three
  u64 arguments, checked before the CPI to be exactly that, since only `initialize_with_permission` and its
  `creator_fee_on` argument can enable a creator fee), lock `lock_cp_liquidity` with every LP token
  received (`with_metadata` false), SetAuthority for the mint and freeze authorities that are still set. Read-back:
  mint authority and freeze authority absent, custody holds supply minus liquidity, WSOL custody back to its prior
  balance, the LP account empty and the lock vault holding the LP amount, the fee NFT (supply 1, no authority) in
  the campaign's ATA, the locked position (owner the lock program, LP amount, pool, fee NFT, launch authority and
  LP mint), each vault holding exactly what was sent (a donated WSOL vault's surplus is expected), the pool state
  (config, creator, vaults, LP mint, mints, token programs, observation, status 0, `enable_creator_fee` off, LP
  supply the locked amount plus the 100 units Raydium keeps), and the campaign still covering rent plus refund
  liability.
  Only then: `phase` 3, `launch_time`, `pool`, `fee_nft`.
- **Tag 7, participant claim.** Accounts: 0 campaign, 1 receipt, 2 launch authority, 3 child mint, 4 custody,
  5 the owner's associated token account, 6 Token. Once per receipt; refused with error 40 once a distribution
  program is activated.
- **Tag 8, dev claim.** Accounts: 0 campaign, 1 launch authority, 2 child mint, 3 custody, 4 the sealed dev's
  associated token account, 5 Token. Cumulative vesting.

Fee cycle. Common accounts of every fee tag: 0 campaign (live), 1 caller, 2 fee state PDA `["fees", campaign]`,
3 fee authority PDA `["fee_authority", campaign]`. The fee custody accounts are the fee authority's associated token
accounts. Tags 20 and 22 need the sealed treasury's signature at account 1 and tag 25 the recorded operator's; tags
21, 23 and 26 take any caller, signed or not. Tag 24 is not assigned: coin-side fees are burned (owner, 23 September
2026) and parents are bought through Jupiter (owner, 20 September 2026) against a floor from a Raydium pool.

- **Tag 20, init fees.** Body: the operator key (32 bytes). Accounts: 0..3, 4 System. Signed by the sealed treasury on Family campaigns, by any payer on Standard campaigns (28 September 2026),
  which pays the rent. Creates the fee state once and records the operator. The operator key may not be zero or the
  fee authority.
- **Tag 22, rotate operator.** Body: the new operator key (32 bytes). Accounts: 0..3. Signed by the sealed treasury.
  Replaces the operator and changes nothing else; a lost operator key no longer strands a campaign's buybacks.
- **Tag 21, collect.** Permissionless. Body: `fee_lp_amount` u64 > 0. Accounts: 4 child custody, 5 WSOL custody, 6 fee NFT ATA of the
  campaign, 7 locked liquidity PDA, 8 pool (the recorded one), 9 LP mint, 10 vault 0, 11 vault 1, 12 mint 0,
  13 mint 1, 14 lock authority's LP ATA, 15 the sealed AMM program, 16 AMM authority, 17 the sealed lock program,
  18 lock authority, 19 Token, 20 Token-2022, 21 Memo. The campaign PDA signs lock `collect_cp_fees` as the fee NFT
  owner; whatever arrived in the custody is added to the pending coin amount and the collected SOL total.
- **Tag 23, distribute.** Permissionless. No body. Accounts: 4 WSOL custody, 5 the sealed treasury's WSOL ATA, 6 the
  sealed dev's WSOL ATA, 7 Token. Pays each recipient its cumulative entitlement (`policy::fee_entitlements` of the
  collected total by the sealed weights) less what it already received and records the parent budgets. Dust below
  one denominator unit stays in custody.
- **Tag 25, buy and burn.** Family only, signed by the operator. Body: parent u8, amount u64, min_out u64, expiry
  i64, then the Jupiter `route` or `route_v2` data verbatim. Accounts: 4 WSOL custody, 5 parent custody (the fee
  authority's ATA under the parent's token program), 6 the sealed parent mint, 7 WSOL mint, 8 Token, 9 the parent's
  sealed token program, 10 Jupiter, 11 Jupiter event authority, 12 the reference AMM config, 13 the reference pool,
  14 its parent vault, 15 its WSOL vault, 16.. the route's remaining accounts as Jupiter's API listed them. Rules:
  amount within the pending budget and at most 0.5 SOL per slice, quote valid for at most 120 seconds, route header
  spends exactly the amount, quote minus slippage clears the minimum, slippage at most 1 %, no platform fee, 1 to
  8 steps; no remaining account may be the coin custody or the other parent's custody; WSOL is never a parent. Price
  floor (`fees::reference_floor`): the reference config address is derived from the sealed index
  (`["amm_config", index]` under the sealed AMM program), the reference pool from the config and the parent and WSOL
  mints (`["pool", config, mint 0, mint 1]`), the vaults from the pool; the config must carry that index, the pool
  must be on the sealed AMM program with the parent's token program on its side and no creator fee. The reserves are
  the vault balances less the fees the pool holds for its protocol, fund and creator; `policy::reference_out` is what
  that pool would pay for the slice (trade fee rounded up, constant product) and `min_out` must be at least
  `policy::buyback_floor`, the reference output less the sealed `buyback_max_slippage_bps`, never below one unit
  (error 65). A parent without a sealed reference pool, or a pool that cannot quote (empty reserve, output of zero,
  creator fee on), is refused with error 66 before any CPI. After the route: exactly the amount left the WSOL custody,
  at least the minimum arrived, everything received is burned through the parent's program, the parent supply fell by
  that much. The fee authority PDA may hold lamports; a route may spend them (a Pump AMM leg funds a one-time
  accumulator from the swap user). The reference is read in the same transaction, so an operator who wants a lower
  floor must first move the price of that pool with real capital; a deep canonical pool is the intended reference.
- **Tag 26, burn coin fees.** Permissionless. Body: amount u64. Accounts: 4 child custody, 5 child mint, 6 Token.
  Burns up to the pending coin amount.

Fee state: 160 bytes, magic `KIDSFEE2`: 8 campaign, 40 coin pending, 48 SOL collected, 56 treasury paid, 64 dev
paid, 72 parent A allocated, 80 parent B allocated, 88 parent A spent, 96 parent B spent, 104 parent A burned,
112 parent B burned, 120 coin burned, 128 operator. Liability (WSOL the custody must hold) is collected minus paid
minus spent; every fee tag checks it before and after.

Error codes are listed with their meaning at the top of `src/lib.rs`.

## Platform treasury

`PLATFORM_TREASURY` in `src/lib.rs` is the mainnet treasury wallet of `deployment/MAINNET-IDENTITIES.json`
(`91eLwFTAxkcQLPSMxbzdSFkTyEwyRYcoZk64HMZj8vX`); `vector_tests` checks the constant against that file and against
`PLATFORM_TREASURY_HEX` in `localnet/protocol-v2/policy.mjs`. Create refuses any other sealed treasury, so no campaign
of this program can route the treasury share elsewhere, and the treasury is the only key that can name or replace a
fee operator. The dev stays creator-chosen. A localnet build seals its own treasury with
`cargo build --features localnet-treasury`, which reads the key's 32 bytes as 64 hexadecimal characters from
`KIDS_LOCALNET_TREASURY_HEX` at build time; never enable that feature for a mainnet build.

## Testing

    cd programs/kids-launch-v2 && cargo test
    cargo clippy
    node localnet/protocol-v2/make-test-vectors.mjs   # only when the vectors change
    node --test localnet/protocol-v2/policy.test.mjs

Localnet build and rehearsal (24 September 2026): `node localnet/start-v2-rehearsal.mjs` starts a separate ledger
(RPC 19199) with the canonical Raydium CPMM, lock and Metadata programs, the create-pool fee receiver and the tier-2
AMM config cloned byte for byte from the local lock-rehearsal ledger (a mainnet clone), creator fee rate included;
`node localnet/deploy-kids-launch-v2.mjs` builds this crate with `cargo build-sbf --features localnet-treasury`,
refuses a build that reports a stack-frame overflow (the manifest records the empty `stackFrameWarnings` list) and
deploys it there; `node --test localnet/test/protocol-v2-e2e.test.mjs` runs two Standard campaigns through the job
runner, the signing service and the client (`localnet/protocol-v2/client.mjs`, `chain-adapter.mjs`) and checks that
the config on the ledger carries a creator fee rate while the pool the launch made has `enable_creator_fee` off.

Stack frames: the SBF stack frame is 4 KiB per function. The campaign account is about 1 KiB and the fee cycle
runs one tag per `#[inline(never)]` function (`fees.rs`, `FeeCall`) so no function holds the campaign plus every
tag's locals; `reference_floor` keeps its own frame. Tag 6 borrows the sealed terms instead of copying them.

The host tests emulate the System program, Token and Token-2022 (Transfer, SetAuthority, Burn, SyncNative), the
Raydium CPMM `initialize` (plain, 32-byte body, refusing any other), the Raydium lock `lock_cp_liquidity` and
`collect_cp_fees`, and Jupiter `route` and `route_v2`, each checking the signers and account identities its real
counterpart checks and producing the accounts the handlers read back. Every sealed config in the tests carries the
mainnet creator fee rate of 500. Every campaign, receipt, launch and fee state a test reads was produced by the handlers,
except that Family scenarios seal the campaign account by hand after the same validation, because create refuses
Family terms. Reference pools for tag 25 are foreign accounts a cluster would hold (config, pool state, vaults) and
are written as such. A failed call is rolled back as the runtime rolls back a failed instruction, and its account
bytes stay readable, so the tests prove that a launch which fails after its CPIs (a pool short of tokens, a mint
authority that survives the revocation) never wrote the campaign, and that no refused launch or fee step reached a
CPI. Every rule added after the audit of 24 September 2026 was checked by reversing it in the source and watching
its test fail (treasury-only tag 22 and Family tag 20, payer-signed Standard tag 20, permissionless 21, 23 and 26, operator-only tag 25, the price floor and
its derived accounts, the pinned treasury, the Family and distribution gates, the cap margin, the WSOL parent rule at
create and at tag 25, the funds check before the first CPI, the `enable_creator_fee` read-back of the new pool).
