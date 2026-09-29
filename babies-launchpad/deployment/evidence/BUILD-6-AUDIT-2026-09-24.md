# Build 6 audit (atomic-launch, commit 7f1804a) — read-only, 24 September 2026

**Result: no Critical, no High, no Medium. 4 Low, 7 Info.** The upgrade needs no migration; every live account parses
under the build 6 code with its current bytes. Tag 11 can only burn `reserve - claimed - burned` per parent. Tag 27
cannot move WSOL beyond the two pending parent budgets or through any pool but the campaign's own.

Scope: `/tmp/kids-fresh-repo/babies-launchpad/programs/atomic-launch/src/{lib,claims,fees,launch,host_tests}.rs` at
7f1804a, diffed against the parent (build 5). Mainnet reads through the public RPC at slot 450101575 (read-only).
Host tests re-run: 37 passed, 0 failed. The SBF binary was not rebuilt here.

## Live state checked (public RPC, read-only)

- **Campaign** `9Fjw…` 384 bytes, magic `KIDSESC3`, phase 3, parents flag 1, `launch_time` 1790213669 at offset 232,
  pool at 240 = `82BH…`, dev claimed (304) = 0, distribution program (312) zero, activated (344) 0, bytes 345..384 zero.
  Window closes at 1790213669 + 2,592,000 = **1792805669** (matches the decision note).
- **Parents** `3Ckn…` 256 bytes, magic `KIDSPAR1`, campaign bound, claimed A (208) = 0, claimed B (216) = 0,
  bytes 224/232/240/248 all zero. So today nothing has been claimed; tag 11 after the window would burn the full
  100,000,000,000,000 raw units (100 M coins).
- **Launch custody** `E2t3…` (launch authority `qbd1…`) holds 130,015,432,290,621 raw = 100 T parent reserves + 30 T dev +
  15.4 G participant remainder. After a full tag 11 burn 30.015 T stays, which is exactly what tags 7 and 8 still need.
- **Fee state** `6eMz…` 128 bytes, `KIDSFEE1`. Read atomically with its WSOL custody `684Z…`: liability
  66,128,371,463 = custody 66,128,371,463 (**invariant holds exactly**), pending A 0, pending B 66,128,371,460,
  treasury and dev owed 0, `child` 0 = child custody 0. (A first non-atomic read showed custody 4.1 SOL under liability;
  that was read skew while the build 5 keeper spent slices, not a live breach.)
- **Pool** `82BH…` 637 bytes, `PoolState` discriminator, config `ESLj…` (mainnet 2.5 % tier), token 0 = WSOL, token 1 =
  child, both classic Token, byte 390 (`enable_creator_fee`) = 0, creator fee counters (397/405) = 0. Vaults: 2,884 SOL
  and 150.98 T coin. A 0.5 SOL slice moves the price by about 0.035 %.
- **Child mint** 82 bytes, supply 960,217,089,915,182, 6 decimals, no mint or freeze authority.
- **Retired-path leftovers**: fee authority `6DAn…` Fartcoin ATA (classic) balance 0, Buttcoin ATA (Token-2022) balance 0.

## Findings

### Low

**L1. Tag 10's reserve cap ignores `burned`.** `claims.rs:82` checks `claimed + allocation <= reserve` but not
`claimed + burned + allocation <= reserve`. If a tag 10 could ever run after a tag 11 it would pay from custody beyond
the reserve, that is from participant or dev tokens. Reachability: tag 10 needs `now < expires_at` (`claims.rs:70`) and
tag 11 needs `now >= expires_at` (`claims.rs:109`); the runtime clock is non-decreasing along one fork (bank
`update_clock` clamps the estimate to the ancestor timestamp), so the order tag 11 then tag 10 cannot happen on the
canonical chain. Defence in depth only.
Fix: in tag 10 read `OFF_BURNED + 8*index` and require `claimed + burned + allocation <= reserve`.

**L2. Tag 27's on-chain floor is relative to same-transaction reserves.** `fees.rs:92-98` computes the floor from the
vault balances the instruction sees, so a trade earlier in the same block moves the floor with it; the sealed 1 %
(`fees.rs:20`) bounds fill quality against that state, not against a pre-manipulation price. The real sandwich guard is
the keeper's `min_out` (99 % of the quote-time spot, expiry ≤ 120 s): a pump above 1 % makes Raydium revert, a pump
below 1 % earns less than the 2 × 2.5 % the attacker pays. On the live pool (2,884 SOL depth) the whole 66 SOL budget
spent in one block moves the price about 4.5 %, and a self-sandwich by the creator (the only signer) would pay more in
fees than it captures. No third-party path to profit found. README already says "not oracle-based pricing".
Fix (optional): add a second floor from the pool observation account (account 13 is already bound) or keep the
keeper's `min_out` at 99 % of a quote taken at most a few seconds before sending.

**L3. Removing tags 24/25 strands two empty custody accounts.** The fee authority's Fartcoin ATA `DSiv…` and
Buttcoin Token-2022 ATA `9DbR…` hold 0 tokens and about 0.0015 SOL rent each, and no build 6 instruction can move,
sweep or close them. Any future Fartcoin or Buttcoin sent to them is stuck for good. `burned_a`/`burned_b`
(fee state 104/112) become frozen history. Nothing of value is stranded today (verified balances 0).
Fix: none required; document the two addresses as dead, or add a creator-signed close for zero-balance parent ATAs.

**L4. Tag 10 replay after the window returns error 45 instead of Ok.** Build 5 returned Ok for a valid replay
(`claims.rs:81`); build 6 refuses with 45 first (`claims.rs:70`). On chain this is harmless (nothing moves either way),
but a keeper or site that treats "45 on replay" as "never paid" would mislabel a paid claim after 24 October.
Fix: the site should check the `KIDSPCL1` claim PDA before calling tag 10, or move the window check after the replay
early-return (then a paid claim replays as Ok and an unpaid one is refused with 45).

### Info

**I1. Layout compatibility is sound.** Campaign `read`/`write` (`lib.rs:110-119`) touch the same bytes as build 5;
`KIDSPAR1` gains only writes at 224/232/240 (`claims.rs:115-117`), all zero live; fee state `State` (`fees.rs:37-42`)
is byte-identical; receipts and `KIDSPCL1` are untouched. No migration, and the live accounts above parse.

**I2. Tag 11 burns only the parent remainders.** `claims.rs:89-92` (`reserve - claimed - burned`, checked_sub, error
10 on a corrupt counter), summed with `add` (`claims.rs:113`), burned from the launch authority's canonical child ATA
only (`claims.rs:98`, `ata` binding), read back exactly (`claims.rs:101`). Participant (tag 7), dev (tag 8) and refunds
(tag 3) are never read or written. Idempotent: the second run has remainder 0, no CPI, and keeps the first burn time
(`claims.rs:117`; host test `expired_parent_reserves_burn_exactly_the_unclaimed_remainder_once`). A same-slot tag 10
and tag 11 see the same clock, so exactly one of them passes; sequential account locking makes tag 11 read tag 10's
`claimed` write.

**I3. Tag 27 cannot drain or misroute.** `amount ≤ 0.5 SOL` and `≤ pending A + pending B` (`fees.rs:149`); pool bound to
campaign offset 240 (`fees.rs:150`), owner CPMM, discriminator and PDA (`fees.rs:61-67`), config on the allowlist with
the standard 2 % or 2.5 % rate and protocol/fund shares (`fees.rs:83-85`), vaults, mints, vault authority and
observation bound to that pool (`fees.rs:86-90`); WSOL custody must fall by exactly `amount` (`fees.rs:154`), coin
custody must return to its starting balance and the mint supply must fall by exactly `received` (`fees.rs:157`), so
nothing bought stays unburned; `custody ≥ liability` is checked before (`fees.rs:152`) and after (`fees.rs:159`).
Bookkeeping A then B (`fees.rs:46-49`) is exact integer arithmetic; a refused slice books nothing.

**I4. Raydium byte offsets verified against current `raydium-cp-swap` master.** `PoolState`: 389 `creator_fee_on`,
**390 `enable_creator_fee`**, 397/405 creator fee counters, 341/349 protocol fees, 357/365 fund fees, 637 bytes.
`fees.rs:93` requires `enable_creator_fee == 0`, so the floor formula (trade fee only, `fees.rs:71-74`) matches what
Raydium charges; reserves subtract the same three fee counters Raydium subtracts (`fees.rs:94-97`). Raydium's own
`minimum_amount_out` check plus `received >= min` (`fees.rs:155`) close the loop.

**I5. Arithmetic.** `quote_floor` is u128 throughout with `input ≤ 5e8`, `rate < 1e6`, `bps < 1e4`; the u64 cast is
bounded by `reserve_out`. Parent reserve 5e13 each, total burn ≤ 1e14, `burned_child` ≤ 1e15: all far inside u64
(1.8e19). `parent_claims_expire_at` uses `checked_add` and refuses `launch_time ≤ 0` (`lib.rs:123`).

**I6. Authority.** The creator keeper gains no withdrawal path; tag 27 only changes what the parent budget buys (the
coin instead of the parents) and burns it. Tag 11 is permissionless by design (anyone may close the window; no admin can
reopen it). Campaigns with a distribution program are refused by tag 11 (error 40, `claims.rs:108`), so their parent
vaults have no expiry in build 6; none is live.

**I7. Operational.** A build 5 keeper against build 6 gets `InvalidInstructionData` on every tag 24/25 (`lib.rs:267`);
a build 6 keeper against build 5 gets the same on tag 27. Ship the keeper with the upgrade. Tag 27 does about fifteen
PDA derivations plus the swap and burn; set a compute limit (200k is ample). Tag 27 does not read pool `status`
(byte 329); a disabled pool simply fails the CPI.

## Verified sound (with evidence)

- Every live account byte layout: campaign, parents, fee state, pool, mint (decoded above).
- Tag 10 boundary: refused at `expires_at` and after, allowed at `expires_at - 1` (host test
  `parent_claims_close_thirty_days_after_the_recorded_launch_time`).
- Tag 11: only parent remainders, one burn, idempotent, records at 224/232/240, twelve refusals move nothing.
- Tag 27: wrong campaign pool, pool, config, vault, swapped vaults, foreign vault, mint, observation, custody, oversize
  slice, over-budget, zero min, stale or far expiry, unsigned or stranger signer, short body, missing account all refused
  before any CPI (host test `child_buyback_needs_the_campaign_pool_and_a_floor_one_percent_under_spot`).
- Fee liability invariant holds live (66,128,371,463 both sides) and is preserved by tag 27's exact debit.
- Tag 23 weights and fee offsets unchanged (host test `distribute_keeps_its_weights_and_the_fee_state_layout`).
- Tags 22/24/25 refused before any account is read (`lib.rs:267`).
- Clock: unix_timestamp is non-decreasing along a fork (Agave `update_clock` clamps to the ancestor timestamp), so
  the window boundary cannot be crossed backwards.
