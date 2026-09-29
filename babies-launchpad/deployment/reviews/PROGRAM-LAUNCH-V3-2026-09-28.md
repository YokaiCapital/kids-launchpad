# Adversarial review of the version-3 launch program, 28 September 2026

Read-only review done inside the project before the private mainnet pilot (not a third-party audit). The full report
and its same-day re-check follow the status table. Status words: **fixed** (code on the branch with a test),
**owner** (needs the owner's action), **open** (not done, tracked in the release checklist).

| Id | Finding | Status, 28 September 2026 |
| --- | --- | --- |
| M1 | One hot upgrade key on the owner's machine can replace the program | owner: hardware wallet or multisig before the first real campaign; decision register |
| L1 | Tag 20 (fee-cycle opening) needed the treasury's signature, which no hosted service holds | fixed in source: Standard campaigns accept any payer (`fees.rs` `init`, host tests), adapter updated (`localnet/protocol-v3/fee-setup.mjs`); build `71d0d62c3582c28bb702b5e0e33c3d9cb41d7881ee93394eb25c527800ab6869` (the re-check below measured `fb7f4463…` before comment-only edits moved line numbers; the code is the same); deployed 28 September 2026, 11:28 UTC, slot 451305566, on-chain bytes verified |
| L2 | Browser did not pin program id, genesis and treasury at build time | fixed: the mainnet build carries the release pins and the creator flow refuses a differing quote (`vite.config.mjs`, `creator-controller.mjs`, `creator-release-pins.test.mjs`) |
| L3 | No code encoded the launch authority's rent floor for the setup margin | fixed: `quoteAuthorityFunding` refuses a margin under 890,880 lamports (`setup-funding.mjs`, test) |
| L4 (re-check) | A front-run fee-cycle opening could stall the hosted fee setup for one campaign | fixed: any recorded operator is accepted for Standard, missing custody accounts are created alone and idempotently (`fee-setup.mjs`, test) |
| I1 to I7 | Tag numbering note, permissionless launch, freeze authority, metadata update authority, unrecoverable donations, equal caps, build hygiene | noted; I4 and I5 are disclosure items for the public opening; stale treasury-only wording updated in the comments and the program README |
| T40-M1 | Tag 40 (compact creation) had no end-to-end run on a validator with its exact source | fixed by evidence: A37 (isolated ledger, one creation transaction, 11 instructions) re-run on the final build; duplicate nonce refused on chain, raw 31-day window refused with error 104 |
| T40-L1 | The mainnet upgrade script compared the hash only and did not refuse a build with a stack-frame warning | fixed: `pilot-upgrade-v3.sh` stops on a frame warning (same rule as the localnet deploy); CI's sbf-build workflow already builds kids_launch_v3 on two runners |
| T40-L2 | The treasury the client expects in the sealed bytes comes from the release pin, the program seals its constant; a mismatch is found after funds move | accepted with mitigations: the browser refuses a quote whose treasury differs from the build-time pin, the hosted scope takes it from the verified release, `features: []` is a checked field of every accepted build, a mismatch parks the request for an operator and no funds are lost |
| T40-L3 | No on-chain upper bound on the windows or the opening time (prior L4) | fixed: the program refuses a window over 30 days and a scheduled opening more than 30 days ahead (`CREATE_V3_MAX_WINDOW_SECONDS`, `CREATE_V3_MAX_SCHEDULE_SECONDS`, tests, JS mirror, shared vectors); build `ec8f9951…` |
| T40-I1 to I7 | Dead URI length check, duplicate constant, unnamed error codes, CID rule, tier 2 accepted, no compute limit instruction, duplicate mint across campaigns | I2 fixed (constant imported), I3 fixed (`ERRORS_V3`, `programErrorNameV3`), I6 measured (92,183 units for the whole packet, 21,804 for the create), the rest noted |

# kids-launch-v3 adversarial audit, 28 September 2026 (read-only)

**Summary.** No Critical or High finding. The deployed program is byte-identical to the audited source and every fix from the 24 September audit still holds.
Counts: Critical 0, High 0, Medium 1, Low 3, Info 7. The Medium is the single hot upgrade key, not a code bug.
Before the first real campaign: move the upgrade key to a hardware wallet or multisig, and decide who signs the one treasury-only fee instruction per campaign.

## 1. Scope and method

- **Target.** `programs/kids-launch-v3` at commit `85d9c52` on branch `feature/public-launches`, checkout `/tmp/kids-public-integration`. The wrapper compiles `programs/kids-launch-v2` as a library. Mainnet program id:

```
ABq14qMonDrPbRJUbyfACsazK2ESaiKWcw5u66qy6f7T
```

- **Read in full.** v3 `lib.rs` and `tests.rs`; v2 `lib.rs`, `state.rs`, `policy.rs`, `handlers.rs`, `launch.rs`, `fees.rs`, `vector_tests.rs`; the host test names; the prior audit `deployment/evidence/KIDS-LAUNCH-V2-AUDIT-2026-09-24.md`; the browser packet reconstruction `interaction-review/src/public/creator-signing.mjs` and its controller; the client encoders `localnet/protocol-v2/policy.mjs`, `client.mjs` and `localnet/protocol-v3/client.mjs`; the server packet builder `localnet/creation/provision-packet.mjs`; the hosted fee-setup path; the deployment records.
- **Not called by v2.** `programs/kids-liquidity-v1` is not a dependency of v2 or v3 and no symbol of it is referenced. It is a library-only kernel and out of scope.
- **Nothing was modified.** No file in the repository was edited, no worktree created, no commit made, no key file opened, no transaction signed or sent. Builds and tests used a scratch target directory outside the repository. `git status` on the program crates stayed clean.
- **One correction to the brief.** Tag 22 is not retired. It is `TAG_FEES_ROTATE_OPERATOR`, treasury-signed, added by the 24 September fixes. The unassigned tag is 24.

## 2. Tests and build

- **Host tests ran offline.** `cargo test --offline --locked` with a scratch `CARGO_TARGET_DIR`:
  v3 crate 6 passed, 0 failed. v2 crate 68 passed, 0 failed.
- **Clippy.** One `too_many_arguments` on `custody_transfer` and one rustc `unused import: entrypoint` when v2 is compiled as a library. No behaviour impact.
- **SBF build reproduced the deployed bytes.** `cargo build-sbf --offline -- --locked` with the installed platform tools v1.53 produced:

```
sha256  f74b9458446e862363fc00bb0fde4335ad4cd6a97aec7aa42350339138d17ce9
size    201488 bytes
```

## 3. Deployment verification

- **On-chain bytes match the source.** Three read-only calls to the public mainnet RPC from this machine, no Helius key was available in the session. Program data account:

```
Eka6EsKEHJrhd1DTXzm25iUqtA76vhSLP8FAJafZgu7x
```

  The 201,488 ELF bytes hash to `f74b9458…d17ce9`, the tail after them is all zero, the upgrade authority is `EPwoPzJ5wuFgvMxUs7gQyUgb48dfZh4k6TxpZsTpWf2Y`, last deploy slot 451136509. The recorded deploy signature confirmed without error at 2026-09-27 22:52:40 UTC.
- **The deploy includes the 27 September economics.** Commit `57d92d2` that added split policy 3, vesting rule 2 and `E_V3_ECONOMICS` landed at 2026-09-27 20:16 UTC, before the deploy. The reproduced hash from the current source confirms it.
- **No localnet feature in the deployed build.** The features list in `deployment/MAINNET-IDENTITIES.json` is empty and the hash matches a build without features. The mainnet pilot key and treasury are therefore the ones compiled in:

```
PILOT_CREATOR      JBjY3ETQWkJa79G1URqFsgzqxKqxWeNfNycccQLkGVgn   (v3 lib.rs:26)
PLATFORM_TREASURY  91eLwFTAxkcQLPSMxbzdSFkTyEwyRYcoZk64HMZj8vX    (v2 lib.rs:123)
```

## 4. Findings

### Medium

**M1. One hot key can replace the whole program.**
- **Where.** Upgrade authority `EPwoPzJ5…` on chain, recorded as a keypair file on the owner's Mac in `deployment/MAINNET-IDENTITIES.json`.
- **Attack.** Whoever holds that key uploads a new program. The new code owns every campaign account, every launch-authority and fee-authority PDA, so it can move all committed SOL, all custody tokens and all collected fees. No timelock, no second signer.
- **Impact.** Total loss of every pilot campaign if the key leaks. Likelihood depends only on laptop hygiene.
- **Fix.** Move the authority to a hardware wallet or a multisig before the first campaign. After the pilot decide between making the program immutable and keeping a documented, multi-party upgrade path.

### Low

**L1. The fee cycle needs the treasury's signature once per campaign, and the hosted signer is not the treasury. Needs verification.**
- **Where.** `fees.rs:211` tag 20 requires `signed_by(treasury)`; tags 21, 23 and 26 read the fee state and fail until it exists, `fees.rs:203`. Hosted side: `localnet/protocol-v3/fee-setup.mjs:11-12` refuses unless the keeper key equals the sealed treasury; `localnet/jobs/service.mjs:98-104` gives the provisioning lane the remote signer as keeper; `deployment/hosted/release-mainnet.json` records that signer as `7MESsrmBCSAnA32uA67K9V9cwXnkVNGr6C8eSLEGJkzi`, not `91eLw…`.
- **Failure.** As configured, the fee-setup job throws "Fee setup requires the sealed Standard treasury" for every campaign. Trading fees keep accruing inside the locked Raydium position and nobody can collect, distribute or burn them until tag 20 is signed by the treasury. Nothing is lost and nothing can be stolen.
- **Fix.** Either sign tag 20 by hand from the treasury for each pilot campaign, or a small program change: in Standard mode accept any payer for tag 20, because the operator has no power there. Tag 25 is refused for Standard campaigns at `fees.rs:280`, so the operator field is inert.

**L2. The browser reconstruction does not pin the program id or the treasury at build time.**
- **Where.** `creator-signing.mjs:65,75` take `treasury` from `scope`; `creator-controller.mjs:16-20,32` build `scope` from the accepted quote and the API status. Only `network` comes from the build, `CreatorJourney.jsx:12`.
- **Failure.** An API compromised before the quote is accepted can name another program id and treasury. The browser would then approve a mint packet whose custody belongs to a foreign program's PDA, and a create packet that sends the setup budget to that program. The on-chain treasury pin fails closed, `handlers.rs:45`, but nothing on chain can catch a wrong program id.
- **Impact.** Bounded to the pilot wallet's own mint and setup budget. Participants would only be exposed if the site were also compromised.
- **Fix.** Embed program id, genesis and treasury from `deployment/hosted/release-mainnet.json` into the site build and compare the packet against those constants, not only against the served quote.

**L3. The setup budget must never leave the launch authority rent-paying.**
- **Where.** `launch.rs:145-153`: the launch authority pays the pool fee and pool rents from its balance. Solana rejects a transaction that leaves a System account with more than zero but less than 890,880 lamports. `localnet/creation/setup-funding.mjs:15-16` sizes the budget as costs plus a margin; `localnet/creation/live-costs.mjs:9` defaults the margin to 15 percent.
- **Today.** Pool costs are around 0.2 SOL, so the margin is around 0.02 SOL, well above the floor. The 26 September rehearsal returned 2,000,000 lamports, consistent with that.
- **Failure mode.** If the margin were ever lowered below the floor, every launch would fail until the launch deadline and every campaign would refund. No code encodes the floor.
- **Fix.** Assert in `quoteAuthorityFunding` that the margin is at least the zero-data rent floor, and add a test.

### Info

- **I1. Tag numbering.** Tag 22 rotates the operator, treasury-signed. Tag 24 is the unassigned one.
- **I2. Launch is permissionless.** Any signer can be the keeper at `launch.rs:97` and chooses only the fee NFT keypair. Every other account is derived or pinned, and the fee NFT mint ends with no mint authority, `launch.rs:168`. The pool opens at the sale price, so a bundled first buy has no edge over participants. A keeper who passes its own wallet as the fee NFT mint account would turn its wallet into a mint account; self-harm only.
- **I3. Fee NFT freeze authority is not read back.** `launch.rs:168` checks supply 1 and no mint authority. Only Raydium's lock program could hold a freeze authority. Harmless.
- **I4. Metadata update authority stays with the creator wallet.** `creator-signing.mjs:55` creates the metadata with the creator as update authority. Name and URI can be changed after launch. Acceptable for the pilot, worth disclosing.
- **I5. Unrecoverable donations.** SOL sent to the campaign account, WSOL sent to the launch custody and lamports on the fee authority stay there forever. Tag 27 covers only the launch authority. Prior item L3, now half addressed.
- **I6. Browser accepts equal caps, the program does not.** `creator-signing.mjs:66` allows hard equal to soft; `handlers.rs:49` needs hard at least one percent above soft. The result is only a failed create.
- **I7. Build hygiene.** Unused `entrypoint` import when v2 is compiled as a library, `v2 lib.rs:13`. Guard it with `#[cfg(not(feature = "no-entrypoint"))]`.

## 5. Prior audit, 24 September: every fix re-checked in the current code

| Item | Status now | Evidence |
|---|---|---|
| H1 fee-cycle capture | Fixed, holds | tag 20 `fees.rs:211`, tag 22 `fees.rs:221`, 21/23/26 take any caller `fees.rs:183-198`, tag 25 floor `fees.rs:300` |
| M1 soft equal hard bricks by rounding | Fixed, holds | `handlers.rs:39,49` |
| M2 treasury creator-chosen | Fixed, holds | `handlers.rs:45`, constant `v2 lib.rs:123`, checked by `vector_tests.rs:55-61` |
| M3 Family reserves stranded | Fixed by refusal, holds | `handlers.rs:103` |
| M4 tag 25 trusts the quote | Fixed, holds | `fees.rs:126-149,300` |
| L1 distribution program sealed but unlaunchable | Fixed, holds | `handlers.rs:104`, `launch.rs:100` |
| L2 WSOL parent | Fixed, holds | `handlers.rs:61`, `fees.rs:285` |
| L3 launch-authority surplus stranded | Half fixed | tag 27 returns it, v3 `lib.rs:51-74`; fee authority still has no sweep |
| L4 no window bound | Deferred, unchanged | browser bounds 60 s to 7 days, `creator-signing.mjs:67` |
| L5 receipt spam | Deferred, unchanged | keeper batches 4 receipts per transaction, `worker-lifecycle.json:38` |
| L6 config drift | Deferred, unchanged | `handlers.rs:26-31` |
| I1 Jupiter header layout | Deferred, moot for v3 | tag 25 is Family-only and Family creation is refused |
| I2 funds check after first CPI | Fixed, holds | `launch.rs:134` runs before `native_sync` at `:137` |
| I3, I4 dust | Deferred, unchanged | at most 167 lamports and receipt_count minus one units |
| I5 clippy | Fixed except `too_many_arguments` | as recorded |

No regression found.

## 6. What was checked and found sound

- **Wrapper gate.** v3 `lib.rs:35-40`: a create must have `PILOT_CREATOR` as account 0 and a body with mode 0, split policy 3, vesting rule 2. v2 then requires that account to sign and to equal the sealed creator, `handlers.rs:87,43`, and requires the split table to be exactly 4750/4750/0/0/500 and the vesting table exactly 150/350 over 3 months, `handlers.rs:50-51`, `policy.rs:36,77`. Fee weights are forced to 148/20/0/0, `handlers.rs:52`. The wrapper's byte offsets 2, 4 and 5 of the body are the campaign offsets 10, 12 and 13.
- **No bypass with another discriminator.** v2's entry point is compiled out, `v2 Cargo.toml` feature `no-entrypoint`, so v2 code runs only through v3 `process_instruction`. Only tag 0 creates a campaign; tags 1 to 8 and 20 to 26 all start from `Campaign::read`, which requires owner equal to the v3 program, magic, length 1024, layout version, canonical PDA and stored bump, and the terms hash, `state.rs:198-217`. Tag 27 never creates. Unknown tags are refused, `v2 lib.rs:188`.
- **No bypass with crafted terms bytes.** The body must be exactly 800 bytes, `handlers.rs:79`. Every byte of the sealed region is a decoded field except two padding bytes at 331 and 807, and both must be zero, `handlers.rs:83`. Encode of decode is the identity, so one set of terms has one hash. The hash is domain-separated and re-checked on every read, `policy.rs:196-197`, `state.rs:207`.
- **Browser reconstruction matches the program.** `creator-signing.mjs:72-80` writes layout 2 at 8, decimals 6 at 11, policy 3 at 12, rule 2 at 13, routing 1 at 14, creator fee 0 at 15, dev equal to creator at 88, tier fee rate times 100 at 296, weights at 306, split at 314, 150 at 324, 350 at 326, 3 at 328, lock program at 332, zero parent block, metadata hash and URI; then tag 0 plus bytes 8 to 808, four accounts in the program's order, plus one transfer to the launch authority. The server builder `provision-packet.mjs:41-45,60` seals the same numbers. The JS encoder offsets in `policy.mjs:195-200` equal `state.rs:53-95`, and `vector_tests.rs:147-163` proves Rust and JS produce the same bytes and hash.
- **Signers.** Create: creator. Commit: owner. Launch: keeper and fee NFT mint. Fee init and rotate: treasury. Buy-burn: operator. Everything else is permissionless by design and pays only sealed or derived destinations.
- **Owner and program-id checks.** Campaign, receipt and fee state check owner and address. Token accounts must be owned by the Token program with the sealed mint and the expected owner, no delegate, no close authority, `handlers.rs:215-218`. AMM config and pool state check owner and bytes. Every CPI target is a pinned constant or a sealed value that was compared to a constant at create: System, Token, Associated Token, Raydium CPMM, Raydium lock, Metadata, Jupiter, `handlers.rs:54-55`, `launch.rs:106-107`.
- **PDAs.** All derived with `find_program_address`, stored bumps compared to the canonical bump, distinct seed prefixes `campaign`, `commitment`, `launch_authority`, `fees`, `fee_authority`. Distinct magics and lengths, 1024, 128, 160, so no type confusion.
- **Arithmetic.** Shares use `supply / 10000 * bps`, no overflow. Settlement, participant tokens, vesting and fee entitlements compute in u128. Every addition is checked. Reserves sum to supply exactly with the dust on liquidity, `policy.rs:58-66`. Dev entitlement is bounded by the dev reserve and is exactly instant plus linear at the end. The 1.5 plus 3.5 rule equals the 5 percent dev share.
- **Conservation.** Campaign lamports equal rent plus total minus refunded before launch, and rent plus the unpaid excess after launch, `launch.rs:131-134,179`. Per receipt, accepted plus refundable equals committed. Refunds are cumulative and idempotent and can never dip into rent, `handlers.rs:192-199`. Claims are once per receipt and bounded by the reserve, `handlers.rs:243-246`. No instruction closes an account.
- **Lifecycle.** Commit only in phase 0 before the deadline. Settle and refund only at or after the deadline. Launch only inside the launch window with every receipt settled. A refund at or after the launch deadline flips the phase to refund-only, which no clock can undo, and a launch in the same second is impossible because it needs `now` strictly below the deadline, `policy.rs:182-192`. Tag 27 only in live or refund-only.
- **Tag 27.** Reads the campaign, binds the genesis, derives the launch authority itself, requires it System-owned and empty, pins the destination to the sealed creator and refuses aliasing with the source or the campaign, `v3 lib.rs:52-67`. Moves lamports only, to exactly zero, which the rent rule allows. The launch authority needs no lamports afterwards: claims use it only as a PDA signer.
- **Launch read-back.** Custody holds supply minus liquidity, WSOL custody is back to its prior balance, the creator LP account is empty and the lock vault holds every LP unit, the fee NFT sits in the campaign's account with no mint authority, the locked position names the pool, NFT, authority and LP mint, the vaults hold exactly what was sent plus any pre-funded native surplus, the pool has the sealed config, the authority as creator, status 0, creator fee off and LP supply equal to the locked amount plus Raydium's 100, `launch.rs:163-179`. The campaign is written last.
- **Mint authority revocation.** `child_mint_matches` accepts only an absent authority or the launch authority, `handlers.rs:208-213`; the launch revokes whatever is left and verifies both authorities absent, `launch.rs:161-163`; claims re-check absence on every transfer, `handlers.rs:226`.
- **Re-entrancy.** Raydium, the lock program and Jupiter cannot call back into this program; the runtime allows only direct self-recursion. One instruction commits all or nothing.
- **Griefing by pre-funding.** Any address can receive lamports. Campaign, receipt and fee-state creation top up the rent instead of failing, `v2 lib.rs:168-174`. Pool, vaults and observation are created by Raydium's own allocate-or-create path, and a native surplus on the WSOL vault is expected in the read-back, `launch.rs:139-140,172-174`.
- **Whale crowding.** A very large commitment only dilutes small receipts pro rata; every lamport not accepted is refundable right after the deadline. The one-percent cap margin keeps flooring from making a funded campaign unlaunchable.

## 7. Files

- `programs/kids-launch-v3/src/lib.rs`
- `programs/kids-launch-v3/src/tests.rs`
- `programs/kids-launch-v2/src/{lib,state,policy,handlers,launch,fees,host_tests,vector_tests}.rs`
- `interaction-review/src/public/creator-signing.mjs`
- `interaction-review/src/public/creator-controller.mjs`
- `localnet/creation/provision-packet.mjs`
- `localnet/creation/setup-funding.mjs`
- `localnet/protocol-v2/policy.mjs`
- `localnet/protocol-v2/client.mjs`
- `localnet/protocol-v3/client.mjs`
- `localnet/protocol-v3/fee-setup.mjs`
- `localnet/jobs/service.mjs`
- `deployment/MAINNET-IDENTITIES.json`
- `deployment/hosted/release-mainnet.json`
- `deployment/evidence/KIDS-LAUNCH-V2-AUDIT-2026-09-24.md`
- Test and build logs: a private review workspace (not kept)

## 8. One question

Do you want the small program change that lets any payer run tag 20 for Standard campaigns, so the hosted signer can bootstrap fees without the treasury key? Recommended default: not for the pilot. Sign tag 20 by hand from the treasury for each pilot campaign, and decide the program change after the pilot.

## Re-check, 28 September 2026

**Verdict.** The Standard-mode tag 20 change is safe on chain: a stranger who creates the fee state can neither move nor block funds, cannot delay tags 21, 23 or 26, and cannot touch the treasury's rotate. The Family path is unchanged. The new build reproduces exactly. One new Low, off chain: a front-run init can stall the hosted fee-setup job for that campaign. The deployed program still carries the old rule.

**What was re-read.** Uncommitted `programs/kids-launch-v2/src/fees.rs` and `host_tests.rs`, plus the uncommitted `localnet/protocol-v3/fee-setup.mjs`, which the tree also changes. Nothing was modified.

**1. Permissionless Standard init, on chain.**
- **The change.** `fees.rs:214`: Family keeps `signed_by(treasury)`; Standard only needs account 1 to sign. The state is written as all-zero counters plus the operator, `fees.rs:219`. `process` still requires a live campaign and the derived fee authority first, `fees.rs:186-187`.
- **Funds.** Init moves only the payer's own rent into the fee-state PDA through `create_pda`. It reads no custody balance and writes no counter. A pre-funded address only lowers the payer's top-up.
- **Every use of `FeeState.operator`.** Struct, decode, encode; written by init at `:219` and by rotate at `:227`; read once, by tag 25 at `fees.rs:281`, which then refuses every Standard campaign at `fees.rs:284`. Tags 21, 23 and 26 (`fees.rs:234,261,326`) never read it. So on a Standard campaign the operator is inert whoever names it, even the payer itself.
- **Blocking or delay.** Tags 21, 23 and 26 need the fee state to exist, `fees.rs:202-206`. A front-run creates it earlier, so those tags become runnable sooner, not later. The keeper's own init then fails with `AccountAlreadyInitialized`, harmless. Nobody can prevent creation: the address is a PDA and only this program can allocate it.
- **Rotate.** Tag 22 is untouched, `fees.rs:223-227`: treasury signature, reads the state, replaces the operator only. It works the same on a state a stranger created.
- **Ordering nit, no impact.** For Standard the signer check runs before the account-count check; nothing is written before `create_pda`, so a refused call leaves no trace.

**2. Family path.** Unchanged: treasury must sign and pays the rent; a creator or operator signer is refused with `E_FEE_OPERATOR`; an unsigned treasury with `MissingRequiredSignature`. Covered by `family_fee_state_is_created_by_the_sealed_treasury_only`. Family creation stays refused at create, so no Family campaign can exist under v3 today.

**3. Build and tests, offline, scratch target directory.**

```
sha256  71d0d62c3582c28bb702b5e0e33c3d9cb41d7881ee93394eb25c527800ab6869
size    201640 bytes
tests   v2 69 passed, v3 6 passed, 0 failed
```

The hash equals the one reported. It differs from the deployed bytes `f74b9458…` (201,488 bytes), so the on-chain program still requires the treasury for tag 20 until an upgrade.

**4. What changes in the report above.**
- **L1** is addressed on chain and in the adapter: `fee-setup.mjs:14` no longer requires the keeper to be the treasury. It stays open until the new build is deployed and the records updated. The deploy tool refuses a hash it does not know, `localnet/deploy-program-network.mjs:20`, so `KIDS_PROGRAM_SHA256` or an accepted-build entry for `fb7f4463…` is needed. The upgrade is layout-compatible: no account layout changed.
- **New L4 (Low, off chain). A front-run init can stall the hosted fee setup for one campaign.** `fee-setup.mjs:24` throws unless the recorded operator is the configured operator or the payer; the runner classifies that message as permanent, `localnet/jobs/runner.mjs:22-34,119`. If the stranger did name an acceptable key, `fee-setup.mjs:26` yields forever with `recipient-account-repair-required` because the four custody accounts are only created together with init at `:22`. Cost to the attacker: about 0.002 SOL. Nothing is lost, and anyone can run tags 21, 23 and 26 by hand. Fix: for Standard campaigns accept any recorded operator, and when the fee state already exists send the idempotent token-account instructions alone. The treasury can also repair by tag 22.
- **Stale wording (Info).** `v2 lib.rs:35` and `:94`, `fees.rs:6` and `:180`, `README.md:34`, `:160`, `:164` still say tag 20 is treasury-signed. The prior audit's H1 status now describes a superseded rule for Standard.
- **Everything else stands.** M1, L2, L3, I1 to I7 and the sound list are unaffected. The on-chain byte verification in section 3 applies to `f74b9458…` only.

## Re-check of tag 40 (compact creation), 28 September 2026, afternoon

**Verdict.** Safe to upgrade on the code: no way was found to substitute an account, forge a sealed field, replay a
creation or move funds through tag 40. Counts: Critical 0, High 0, Medium 1 (a readiness gap, not a code defect),
Low 3, Informational 7. Rust tests 8 passed (9 with the shared-vector test added afterwards), JavaScript parity 6
passed; the Rust expansion and the three JavaScript mirrors produce the same 800 sealed bytes.

**What was read.** The uncommitted tag-40 change in `programs/kids-launch-v3/src/lib.rs` and `tests.rs`; the
version-2 crate it wraps (`handlers.rs`, `state.rs`, `policy.rs`, `launch.rs`, `lib.rs`, `host_tests.rs`); the mirrors
`localnet/protocol-v3/client.mjs`, `localnet/creation/mint-packet.mjs`, `mint-result.mjs`, `mint-execution.mjs`,
`mint-plan.mjs`, `interaction-review/src/public/creator-signing.mjs`, `creator-controller.mjs`; the deploy tools and
records. Scratch probes pushed edge bodies through `expand_create_v3` and `validate_terms`. Two read-only mainnet reads
(slot 451342821) confirmed both sealed AMM config accounts with the sealed rates.

**Findings and what was done.**
- **T40-M1 (Medium, readiness).** The new money path had never run end to end with this source. Done: the isolated
  ledger rehearsal A37 (`deployment/evidence/A37-ONE-TRANSACTION-CREATION-2026-09-28.md`) ran the whole eleven-instruction
  creation; a second compact create with the same nonce was refused on chain ("instruction requires an uninitialized
  account"); a raw body with a 31-day window, sent past the client check, was refused with custom error 104. Shared
  cross-language vectors (`localnet/protocol-v3/test-vectors.txt`) are checked from both sides.
- **T40-L1 (Low).** The mainnet upgrade script now refuses a build whose log reports a stack-frame overflow. The final
  build's log is clean.
- **T40-L2 (Low).** Treasury: the compact body carries none; the program seals `PLATFORM_TREASURY`; the client's expected
  bytes take it from the verified release. Accepted with the mitigations in the table; a mismatch needs a wrong release
  file first, is caught by the verifier, parks the request for an operator and loses no funds (they sit at the campaign,
  the launch authority and the keeper as designed).
- **T40-L3 (Low).** Bounds now live in the program: each window at most 30 days, a scheduled opening at most 30 days
  after the chain's time (the hosted quote stays at 60 s to 7 days). Refusal code 104. Unit tests cover the bound on
  both sides of the limit; the JavaScript encoder and expander refuse the same.
- **Informational.** I1 (dead URI-length check) kept as a defensive check. I2 fixed: `FEE_ROUTING_VERSION_1` is imported
  from the version-2 policy. I3 fixed: `ERRORS_V3` and `programErrorNameV3` in `localnet/protocol-v3/client.mjs`. I4:
  the CID rule is a base58 character check on both sides; Pinata returns version-0 CIDs. I5: tier 2 is accepted by both
  create paths; the quote decides. I6: measured on the isolated ledger, 92,183 compute units for the whole packet
  (create 21,804) against the default 1.4 million ceiling. I7: a second campaign can seal the same mint under another
  nonce (confirmed on the isolated ledger); only one can ever launch, the other fails its launch and refunds; only the
  pilot creator can create and the lease system prevents it in practice.

**The seven questions, in short.** Accounts: creator signs and pays, campaign PDA derived and compared with the
canonical bump, System program by key, AMM config derived from the sealed index and checked for owner, index, rates and
open pool creation; exactly four accounts; the pilot check is unconditional in both builds. Body: exact length, base58
CID of 1 to 64 bytes, URI at most 98 bytes, tier looked up, checked arithmetic, refusal before any account is touched.
Expansion: every `Terms` field set by a struct literal, padding zero, identical to the full path byte for byte; the
creator influences only genesis, nonce, mint, opening, windows, caps, tier, metadata hash and CID. Clock: read once per
instruction; opening 0 seals the chain time; the verifier reads the opening back from the account and rebuilds the
bytes. Replay: same nonce fails at `create_pda`; the packet is atomic, so a refused create takes the mint leg down with
it. Stack: `Terms` 800 bytes, worst case about 2.6 KB per frame, no frame warning in the build. Error codes 100 to 104
are distinct from the version-2 codes.

**Build after the fixes.**

```
sha256  ec8f995140f3e2f2c49af14aa4a60518192f1c1eb9c969599205ef4ccc1a68c8
size    206464 bytes, no stack frame warning, features []
tests   v3 9 passed (incl. shared vectors), v2 69 passed
```

Deployed on 28 September 2026 at 14:57 UTC (transaction `4og1tfAo8LPt…`, slot 451352437); on-chain bytes verified equal to the
build over the public RPC after the upgrade.

