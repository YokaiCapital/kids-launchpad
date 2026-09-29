# kids-launch-v2 adversarial audit (read-only)

Status column added 24 September 2026 after the fix patch (P2c): every finding below carries a `Status` line, either
"fixed in this patch" with the rule and the test that fails without it, or "deferred" with the reason. Fixed findings
were each checked by reversing the rule in the source and watching the named test fail. The audit text itself is
unchanged.

Target: `babies-launchpad/programs/kids-launch-v2` on `feature/public-launches`, commit 09078d0.
Compared with the live program `babies-launchpad/programs/atomic-launch/src` (build 5, main).
Method: full read of lib.rs, state.rs, policy.rs, handlers.rs, launch.rs, fees.rs, the host tests, and the
production lib.rs, launch.rs, claims.rs, fees.rs. The crate was exported to the scratchpad and `cargo test`
run there: 55 passed, 0 failed. `cargo clippy`: 6 style warnings, nothing security-relevant.
Nothing in the repository was modified. No transaction was signed or sent.

## Summary (three lines)

No Critical found. One High: a public creator can capture the fee cycle at tag 20 and, in Family mode, route the
parent buy-burn budget to a pool he controls; he can also withhold treasury and dev fees forever.
Counts: Critical 0, High 1, Medium 4, Low 6, Info 5. Escrow, settlement, refunds, launch read-back and claims are sound.

## What was verified as sound

- **Signer, owner and PDA checks on every tag.** Campaign: owner = program, magic, length 1024, PDA
  `["campaign", creator, nonce]` and stored bump (state.rs:200-206). Receipt: owner, magic, length 128, PDA
  `["commitment", campaign, owner]`, campaign field and bump (state.rs:234-240). Fee state: PDA, owner, magic,
  length 160, campaign field (fees.rs:72-78). Distinct seed prefixes and lengths, so no type cosplay or seed collision.
- **Sealed terms.** The create body is copied byte for byte, padding bytes must be zero (handlers.rs:68), the hash is
  domain-separated (policy.rs:159-160) and re-checked on every read (state.rs:196). Encode(decode(x)) == x, so the
  hash can only mismatch if bytes were altered. No instruction writes bytes 8..808 after create.
- **Settlement arithmetic.** `accepted = floor(commit x min(T,H) / T)` in u128 (policy.rs:122-125). Per receipt
  `accepted + refundable = commit` exactly (policy.rs:127). Aggregate bounded by `min(total, hard)` and by
  `receipt_count` (handlers.rs:155). Extremes tested at u64::MAX.
- **Conservation.** Campaign lamports = rent + total - refunded - (settled_accepted once launched). Launch keeps
  `rent + (total - settled_accepted - refunded)` (launch.rs:126-129, 167). Refunds never touch rent (handlers.rs:178-179).
  Split reserves sum to supply with dust to liquidity (policy.rs:50-58). Participant claims bounded by the reserve
  (handlers.rs:229). Dev entitlement bounded by the dev reserve (handlers.rs:241).
- **Phase guards.** Commit only in `[opens_at, deadline)` and phase 0. Settle and refund only at or after the deadline.
  Launch only in `[deadline, launch_deadline)`; a refund at or after `launch_deadline` sets phase 2, which no clock
  can undo (policy.rs:145-147, 152-155). Live campaigns never fail, so no full refund after launch. Refund of the
  excess after launch is covered by the reserve kept at launch. No settle after a full refund changes any amount.
- **No claim twice.** Receipt `claimed` flag (handlers.rs:226, 231); dev claims are cumulative against `dev_claimed`.
- **Launch (tag 6).** Every account is derived or pinned before the first CPI (launch.rs:90-118). Programs must be
  executable. Pool, vaults, LP mint, observation, lock state, fee NFT, mint authorities, custody balances, WSOL custody,
  pool state fields, status and LP supply are all read back (launch.rs:152-167). This read-back is stricter than
  production (production checks only owner and non-empty for the lock state and does not check pool status).
  Rollback claim holds: a single instruction either commits all writes or none; the campaign is written last.
- **Jupiter guard (tag 25).** Byte-identical rules to production fees.rs:240-251, plus the same aliasing guard
  against the coin custody and the other parent's custody (fees.rs:210-213 vs production 191-198). Effect checks bound
  the WSOL spend to exactly `amount` and the parent received to at least `min`, then burn everything received.
- **Clock.** `Clock::get()` is a syscall; no sysvar account can be spoofed.
- **Arbitrary CPI.** Every CPI target is a pinned constant or a sealed value that was pinned at create
  (RAYDIUM_CPMM, RAYDIUM_LOCK, TOKEN, ATA, System, Metadata, Jupiter).

## Findings

### High

**H1. The creator can capture the fee cycle and, in Family mode, divert the parent buy-burn budget.**
- Where: fees.rs:139-149 (tag 20 by creator OR treasury, first caller wins, operator permanent), fees.rs:196-231
  (tag 25: `min`, `quoted`, `expiry` and the whole route plan are chosen by the operator).
- Attack: a public creator calls tag 20 right after launch naming a key he controls. From then on only that key
  can run tags 21, 23, 25, 26. He can (a) never call tag 21 or 23, so treasury and dev never receive a lamport while
  fees accrue in the locked position; or (b) in Family mode call tag 25 with a Jupiter route through a pool he
  created for parent/WSOL at a bad price, with `quoted = min = 1`. All header rules pass (in_amount == amount,
  quoted >= min, slippage 1 percent of 1 is 0). The effect checks pass (exactly `amount` spent, 1 unit received and
  burned). The 25/168 + 25/168 SOL share per parent lands in his pool. In production the creator is the platform, so
  this trust model was acceptable there; in public launches it is not.
- Also: the operator cannot be rotated. A lost key strands all future fees of that campaign.
- Fix: tag 20 signed by the sealed treasury only, with a rotate-operator instruction signed by the treasury. Make
  tags 21, 23 and 26 permissionless (they have no discretionary output; anyone may harvest and distribute). Keep
  tag 25 operator-only and add an on-chain price floor (for example require `min` to be at least a fixed fraction of
  a quote read from the parent's Raydium pool, as production tag 24 did) or restrict routes to venues the program
  can quote.
- Status: fixed in this patch. Tag 20 is signed by the sealed treasury only (`PLATFORM_TREASURY`, pinned; see M2) and the
  new tag 22 lets the treasury replace the operator. Tags 21, 23 and 26 are permissionless. Tag 25 stays operator-only and
  `min_out` must clear `policy::buyback_floor` of `fees::reference_floor`, derived from the parent's sealed Raydium CPMM
  reference pool (config index sealed at bytes 805 and 806, slippage cap at 329) with every address derived; a parent
  without a sealed reference is refused (error 66). Tests: `fee_state_is_created_once_by_the_sealed_treasury_and_names_the_operator`,
  `the_treasury_rotates_the_operator_and_nobody_else_can`, `standard_fee_cycle_is_permissionless_...`,
  `buy_and_burn_min_out_must_clear_the_floor_derived_from_the_reference_pool`,
  `buy_and_burn_reads_only_the_derived_reference_accounts_and_refuses_a_parent_without_one`.

### Medium

**M1. A campaign with `soft == hard` (or a gap of a few lamports) can be bricked for free by rounding.**
- Where: handlers.rs:39 allows `soft == hard`; readiness requires `settled_accepted >= soft` (policy.rs:153-154);
  each receipt floors (policy.rs:124).
- Attack: soft = hard = H, honest total T. The attacker commits `H - T + 1` lamports (one receipt). Now
  `total = H + 1 > hard`, and every receipt loses one lamport to flooring, so `settled_accepted = H + 1 - N < H = soft`
  when N >= 2. Launch is refused for ever; after `launch_deadline` everything, including the attacker's money, is
  refunded. Net cost to the attacker: receipt rent and fees. Inherited from production (same rule).
- Fix: refuse `soft == hard` at create and require `hard - soft` to be at least a sensible margin (for example 1
  percent of soft), or drop the `settled_accepted >= soft` readiness term and accept that the pool receives at most
  `receipt_count` lamports less than `min(total, hard)`.
- Status: fixed in this patch. Create requires `soft > 0` and `hard >= soft + ceil(soft / 100)` (`handlers::least_hard_cap`).
  Test: `create_refuses_every_out_of_range_or_inconsistent_sealed_field`.

**M2. Treasury and dev are creator-chosen; nothing on chain pins the platform.**
- Where: handlers.rs:35 accepts any non-zero `dev` and `treasury`.
- Failure: any wallet can call tag 0 with itself as treasury and receive 148/168 of every SOL fee. The program cannot
  tell such a campaign from a platform campaign. If the site, registry or keepers ever act on a campaign account
  without checking the sealed treasury against the platform key, revenue is lost.
- Fix: either pin the treasury as a program constant (like `RAYDIUM_CPMM`), or document that the registry must
  refuse any campaign whose sealed treasury is not the platform key, and enforce that in the registry import.
- Status: fixed in this patch for the treasury. `PLATFORM_TREASURY` is a program constant (the mainnet treasury wallet
  of `deployment/MAINNET-IDENTITIES.json`, checked by `vector_tests`); create refuses any other sealed treasury (error 92).
  The dev stays creator-chosen by design. Localnet builds override the constant through the `localnet-treasury` feature.
  Test: `create_refuses_every_out_of_range_or_inconsistent_sealed_field`.

**M3. Family parent reserves (5 percent + 5 percent of supply) are stranded.**
- Where: launch.rs:89 refuses any campaign with a distribution program; no tag pays the parent reserves;
  `parent_claimed` (state.rs:101) is never written; sealed roots, slots, supplies and expiry are never read.
- Failure: a Family campaign launches, 10 percent of supply sits in the launch custody with no instruction that
  can ever move it. Not a theft, but a broken promise to parent holders and a permanent lockup of tokens.
- Fix: do not allow Family mode at create until the parent claim path exists (either a tag 10 equivalent bound to
  the sealed roots or the distribution program wired for the v2 layout).
- Status: fixed in this patch by refusal. Create refuses Family terms (error 91, `E_FAMILY_NOT_AVAILABLE`) after every
  other rule; the README section "Family mode is disabled" records what lifting the gate needs. The Family rules, launch
  and fee cycle stay implemented and tested by hand-sealed campaigns. Tests:
  `create_refuses_family_and_a_distribution_program_after_every_other_rule_and_writes_nothing`,
  `create_refuses_parent_state_on_standard_and_requires_it_on_family`.

**M4. Tag 25 trusts the operator for the quote.**
- Where: fees.rs:198 (`expiry` is any value in `[now, now + 120]` chosen by the caller, not a signed quote),
  fees.rs:117-128 (`quoted` and `min` come from the same caller).
- Failure: the "quote valid 120 seconds" rule and the 1 percent slippage cap only bound the route against its own
  header. A dishonest or compromised operator sets `quoted = min = 1`. Same as production; listed here because the
  operator is no longer the platform (see H1). Fix as in H1.
- Status: fixed in this patch, with H1: the operator still names `quoted`, `min` and `expiry`, but `min` must clear the
  chain-derived floor, so `quoted = min = 1` is refused before any CPI (error 65). Test:
  `buy_and_burn_min_out_must_clear_the_floor_derived_from_the_reference_pool`.

### Low

**L1. A campaign that seals a distribution program is accepted at create but can never launch.**
- Where: handlers.rs:76-79 accept it; launch.rs:89 refuses it with error 90.
- Failure: participants commit SOL into a campaign that cannot launch; the accepted part is locked until
  `launch_deadline`, then refunded. Fix: refuse a non-zero `distribution_program` at create until it is wired.
- Status: fixed in this patch. Create refuses a sealed distribution program (error 90) after validating its account; tag 6
  keeps its own refusal for a campaign sealed before this rule. Test:
  `create_refuses_family_and_a_distribution_program_after_every_other_rule_and_writes_nothing`.

**L2. WSOL is allowed as a Family parent mint.**
- Where: handlers.rs:47-53 exclude the child mint and duplicates but not WSOL; production fees.rs:184 refuses WSOL.
- Failure: for that parent, custody input and output are the same account, so tag 25 always fails at fees.rs:227 and
  that parent's budget stays in custody for ever. Fix: `parent_mint[i] != WSOL` in `validate_terms`.
- Status: fixed in this patch. `validate_terms` refuses WSOL as a parent mint (error 16) and tag 25 keeps the same guard.
  Tests: `create_refuses_parent_state_on_standard_and_requires_it_on_family`, `buy_and_burn_refuses_wsol_as_a_parent_before_any_cpi`.

**L3. Lamports left on the launch authority PDA are unrecoverable; the fee authority's lamports are spendable by a route.**
- Where: launch.rs:91 (System-owned empty PDA holds the sponsored budget), no instruction sweeps the surplus;
  fees.rs doc lines 8-10 acknowledge routes may spend the fee authority's lamports.
- Fix: a sweep instruction for the launch authority's surplus to the keeper or treasury after launch; never leave more
  than the needed budget on the fee authority.
- Status: deferred. A sweep instruction is a new custody path (who may receive, when, how much) that needs an owner
  decision; the launch authority's surplus is bounded by the setup budget the keeper chose. Not in this patch.

**L4. No upper bound on the funding or launch window.**
- Where: handlers.rs:38 only orders the three times.
- Failure: a creator can seal a launch deadline years away; accepted SOL stays locked that long. Terms are public, so
  this is informed, but a bound (for example 30 days each) removes the foot-gun.
- Status: deferred. A window bound is a product preset (the register proposes two hours plus two hours) and the terms are
  public; the bound should land with the preset activation record, not as a program constant chosen here.

**L5. Receipt spam adds work to settlement.**
- Where: handlers.rs:128-132 (any wallet, 1 lamport, 128-byte receipt at about 0.0018 SOL rent, never reclaimable),
  policy.rs:154 (every receipt must be settled before launch).
- Failure: 10,000 receipts cost the attacker about 18 SOL and force about 500 settle transactions before
  `launch_deadline`. Feasible with a normal launch window; a very short window is the risk. Fix: batch settle
  (several receipts per instruction) and keep the launch window at least a day.
- Status: deferred. Batch settlement changes the settle instruction's account table and the keeper; the settlement
  benchmark the register asks for decides the batch size. The one-day launch window is a preset decision.

**L6. Raydium config drift bricks pending launches.**
- Where: launch.rs:94 re-reads the AMM config against the sealed rate and the fixed protocol and fund shares.
- Failure: if Raydium changes tier 7's rates, every unlaunched campaign refuses to launch and refunds. Inherited from
  production. Acceptable, but worth a keeper alert.
- Status: deferred. Inherited from production and intentional: a launch on a config whose rates changed must not run;
  the keeper alert belongs to the service, not the program.

### Info

**I1. Jupiter `route_v2` header layout could not be verified offline.** The parser assumes fixed fields before the
`route_plan` vec (fees.rs:119-121). The public IDLs reachable here only carry `route`. If the real layout is
vec-first, the header guard reads plan bytes, which fails closed for honest routes and, for a crafted route, only the
header rules (slippage cap, platform fee, steps) could be bypassed; the effect checks at fees.rs:226-229 still bound
the spend and the receipt. Verify against the live IDL before shipping. Same code as production.
- Status: deferred. Needs the live Jupiter IDL; the effect checks bound the spend and the receipt whatever the header
  layout, and the floor now bounds the receipt from below as well. Verify before shipping.

**I2. `E_LAUNCH_FUNDS` is checked after the first CPI.** launch.rs:121 runs SyncNative before the funds check at
launch.rs:129. Harmless (the instruction fails and rolls back), but the README's "no refused launch reached a CPI"
is not exact for this one check.
- Status: fixed in this patch. The funds check runs before SyncNative. Test:
  `a_campaign_short_of_its_accepted_total_plus_reserve_is_refused_before_any_cpi`.

**I3. Fee entitlements dust.** Up to 167 lamports per campaign stay in the fee custody for ever (policy.rs:118).
- Status: deferred. At most 167 lamports per campaign; documented in the README and the fee state's liability rule.

**I4. Participant dust.** Up to `receipt_count - 1` token units of the participant reserve stay in custody.
- Status: deferred. At most `receipt_count - 1` units; documented in the README dust rule.

**I5. Clippy.** Two `..= (*..)` warnings (lamport writes, correct as written), two `else if` style hints,
one too-many-arguments, one `div_ceil` hint. No behaviour change needed.
- Status: fixed in this patch except `too_many_arguments` on `custody_transfer` (restructuring an account-passing
  function is not a trivially safe change). `cargo clippy` reports that one warning.

## Keeper capability (checked)

The keeper of tag 6 can only choose the fee NFT mint keypair and pay rent. It cannot pick the pool, config, lock
program, vaults, recipients, amounts or the mint. Tags 3, 4, 5, 7 and 8 are permissionless and every destination is
bound to the receipt owner or the sealed dev. The fee-cycle operator chooses amounts, routes and quotes only
(see H1 for what that allows).

## Files

- `/tmp/kids-fresh-repo` branch `feature/public-launches`: `babies-launchpad/programs/kids-launch-v2/src/{lib,state,policy,handlers,launch,fees,host_tests}.rs`
- `/tmp/kids-fresh-repo/babies-launchpad/programs/atomic-launch/src/{lib,launch,claims,fees}.rs` (main)
- Test run: a scratch copy of the crate outside the repository.
