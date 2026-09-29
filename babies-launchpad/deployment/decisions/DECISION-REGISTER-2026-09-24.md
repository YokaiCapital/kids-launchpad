# KIDS public launches: decision register

## Update — 25 September 2026

Owner selected **preserve treasury/dev fee entitlements from both permanent and temporary
LP**, superseding the earlier unresolved fee choice and recycle-with-principal candidate.
Only temporary principal enters the new recycling mechanism. Preserve existing token-side
fee burns as well. Implement and verify fee harvesting/principal accounting before enabling
this policy; the existing numerical model does not provide that accounting. No promise of
unchanged future revenue as LP shrinks. Stopping rule remains undecided; this answer does not
select 90 cycles. Older checkpoint notes below are historical. Nothing is activated.


Started 24 September 2026 (P0 of the public-launches plan, `KIDS-PUBLIC-LAUNCHES-IMPLEMENTATION-PLAN-2026-09-24.md`).
Every economic or custody parameter of the public product is listed here with its status. Nothing marked *proposed*
is a live default: a preset becomes live only through an activation record below, signed off by the owner, with the
preset hash and policy version recorded in the release evidence. Existing funded campaigns keep their sealed terms.

## Agreed (owner, 23 to 24 September 2026)

| Rule | Behaviour | Source |
|---|---|---|
| Trading fee | 2.5 % total pool fee on new launches (Raydium CPMM config index 7, `ESLj2Rzmvn3RhDo4Z18hY1wYmGyC9xM4ZtRXhvoFkDAi`); no creator fee enabled on the pool (`enable_creator_fee` off, verified at launch read-back); the config is verified at creation and at launch | owner 23 Sep; Shartcoin live |
| Dev supply | 3 % of original supply: 1 % at successful launch, 2 % linear over three calendar months (UTC, month-end clamp), no cliff | owner; deployed vesting |
| Funding | Timed commitments to program escrow; reaching the hard cap does not close funding | deployed behaviour |
| Oversubscription | Proportional allocation `accepted_i = floor(commit_i × min(T,H) / T)`; excess refundable; no first-come priority | deployed behaviour (Shartcoin: 2,500 committed, 1,000 accepted) |
| Soft caps | New public launches around 50 to 100 SOL | owner, via the reviewer handoff |
| Liquidity | Accepted SOL funds the pool; LP principal permanently locked (Raydium lock, fee NFT to the program) | deployed behaviour |
| Authorities | Mint and freeze authority revoked at successful launch; program upgrade authority and metadata authority disclosed separately | deployed behaviour (freeze at creation, mint at launch on build 2+) |
| Token-side fees | Burned, never sold | owner 23 Sep; tag 26 |
| Wallets | Wallet Standard plus injected wallets; Phantom paused until whitelisted | owner 23 Sep |
| Public product | Launch replaces voting and submissions; compact responsive pages; real data only | owner |
| Blocklist | Site-side refusal now; on-chain enforcement in a later program version; refunds and paid claims never blocked by moderation | owner 23 Sep |

## Proposed, not activated

| Item | Proposal | Status | Activation record |
|---|---|---|---|
| Standard supply split (version-3 issuer) | 47.5 % participants / 47.5 % liquidity / 5 % dev; sealed as split policy 3 | decided by the owner 27 Sep 2026 | pending the release record |
| Family supply split | 43.5 / 43.5 / 5 / 5 / 3 (as Shartcoin) | proposed for the new version; matches the live Family campaign | none |
| Default public preset | soft 50 SOL / hard 100 SOL | decided by the owner 27 Sep 2026 | pending the release record |
| Larger preset | soft 100 SOL / hard 250 SOL, advanced option | decided by the owner 27 Sep 2026 | pending the release record |
| Funding duration | two hours; creator picks a future UTC start or opens on confirmation; start enforced on chain | decided by the owner 27 Sep 2026 | pending the release record |
| Launch execution window | two hours after funding closes | proposed; needs the worst-case settlement benchmark (Shartcoin: 196 receipts settled and refunded in 3 m 30 s) | none |
| Standard SOL-fee routing | 148/168 treasury, 20/168 dev; token side burns | proposed | none |
| Family SOL-fee routing | 98/168 treasury, 20/168 dev, 25/168 parent A, 25/168 parent B (as deployed) | proposed for the new version | none |
| Platform creation charge | zero marketing fee; creator funds the quoted setup and operation costs explicitly | proposed | none |
| Free parent-claim expiry | explicit policy for the new Family version only; existing campaigns never expire | unresolved | none |
| Minimum initial commitment | 0.05 SOL, enforced by the API at commit preparation for the version-3 issuer (no layout field; a top-up on an existing receipt is not limited) and shown in the commit form; about 25 times the platform's per-receipt settlement cost, so receipt griefing pays for itself | set 27 Sep 2026 under the owner's "do the rest"; implemented the same day; change before activation if wanted | pending the release record |
| Per-receipt operational funding | committing wallet pays its own receipt rent; any execution budget quoted, never deducted | unresolved | none |
| Per-wallet cap | none, as on the live campaign; proportional allocation already removes a first-come advantage | set 27 Sep 2026 under the owner's "do the rest" | pending the release record |
| Initial simultaneous-close admission | at most 50 campaigns closing inside any two-minute window for the restricted pilot; re-measure on the hosted composition before raising (A32: launch start p95 7.1 s at 100 closes on the local ledger) | proposed | none |

## Architecture decisions taken in P0

| Decision | Choice | Why |
|---|---|---|
| Program versioning | New program version for public campaigns; the live Family campaign stays on the current program and its claims path | a shared-program feature upgrade needs its own compatibility review; the 24 Sep buyback upgrade showed how a small change can stall a live keeper |
| Campaign identity | (genesis hash, program id, campaign address); slug is an alias only | plan §8 |
| Operational records | Postgres for registry, intents, jobs, leases, chain events, market cursors; chain stays authoritative for balances and entitlements | plan §8 |
| Signing | Existing policy-bound signer service, per-campaign keeper capability with no recipient, supply, claim or root power; creator wallet never signs operations | plan §7 |
| Branch | `feature/public-launches` in the one checkout, rebased onto `main` daily, merged by the deployer when the owner says ship | repository rules, section 1 |

## Architecture decisions taken in P2

Taken while fixing the read-only audit of `programs/kids-launch-v2` (`deployment/evidence/KIDS-LAUNCH-V2-AUDIT-2026-09-24.md`,
24 September 2026). Program rules, not presets: they hold for every campaign the program creates.

| Decision | Choice | Why |
|---|---|---|
| Treasury pinned | `PLATFORM_TREASURY` is a program constant (the mainnet treasury wallet of `deployment/MAINNET-IDENTITIES.json`); create refuses any other sealed treasury (error 92); the dev stays creator-chosen; localnet builds override it through the `localnet-treasury` feature | audit M2: a public creator could seal himself as treasury and take 148/168 of every SOL fee; nothing on chain told such a campaign from a platform one |
| Permissionless collect, distribute, burn | Tags 21, 23 and 26 accept any caller, signed or not; every amount they move is measured against the custody and every destination is sealed | audit H1: an operator who never runs them withholds treasury and dev fees for ever; with no discretionary output there is nothing to protect by a signature |
| Operator-only buy-burn with an on-chain floor | Tag 20 (name the operator) and the new tag 22 (replace it) are signed by the sealed treasury only; tag 25 is signed by the operator and its `min_out` must clear a floor the program derives from the parent's sealed Raydium CPMM reference pool (config index sealed per parent at bytes 805 and 806, slippage cap at 329) less the sealed slippage cap (at most 5 %); a parent without a sealed reference pool is refused | audit H1 and M4: a creator-named operator could route the parent budget through his own pool with `quoted = min = 1`; the floor makes the fill price a chain-checked fact and the treasury can replace a lost or dishonest operator |
| Family v2 disabled pending distribution | Create refuses Family terms (error 91) and any sealed distribution program (error 90) after checking every other rule; the Family rules, launch and fee cycle stay implemented and tested by hand-sealed campaigns | audit M3 and L1: a Family launch would strand 10 % of the supply in custody with no instruction able to pay parent holders, and a sealed distribution program could never launch; lifting the gate needs the distribution program to read this layout (or a parent-claim instruction) and a reference pool per parent |
| Soft and hard cap margin | Create requires `soft > 0` and `hard >= soft + ceil(soft / 100)` (`least_hard_cap`) | audit M1: with equal caps, one extra lamport makes every receipt round down and the settled total falls below the soft cap; the campaign could never launch and refunded everything at the attacker's cost of a receipt |
| WSOL parent refused | Create refuses WSOL as a parent mint (error 16); tag 25 keeps the same guard | audit L2: the buyback's input and output custody would be one account, so that parent's budget could never move |
| Funds check before the first CPI | Tag 6 checks the campaign can fund the accepted total plus rent and the refund liability before SyncNative | audit I2: no refused launch reaches a CPI, as the README claims |
| AmmConfig creator fee rate is not a rule | `amm_config_matches` checks the config is enabled, carries the sealed index and trade fee rate and the standard protocol and fund shares; it does not compare `creator_fee_rate` (offset 108). "No creator fee enabled" is the pool-level `enable_creator_fee` switch: tag 6 sends plain `initialize` (32-byte body, checked before the CPI; only `initialize_with_permission` carries a `creator_fee_on` argument) and refuses a pool that reads back with the switch on (error 81); tag 25 refuses a reference pool with the switch on (error 66) | localnet rehearsal, 24 Sep: both mainnet tiers (index 2 and 7) carry `creator_fee_rate` 500, so the earlier rule (`creator_fee_rate == 0`) refused the real configs with error 18; `programs/atomic-launch`, which made the live pool, never checked that field; Raydium cp-swap 0.2.0 charges the rate only when `pool_state.enable_creator_fee` is true (`adjust_creator_fee_rate`) |

## Later direction: separate Direct launch feature

The owner approved implementation of a **separate Direct launch feature**, not replacement of parent/Family
or existing Standard launches. Direct has no parent allocations, claims or buybacks. Preserve the established
commitment, cap, proportional settlement, refund, participant claim and dev vesting mechanics; new liquidity
behaviour starts at pool creation.

Approved LP policy: **50% of initial received LP permanently locked, 50% temporary; 3% of remaining temporary
LP per daily cycle**. Redeem that temporary slice, burn its child tokens, buy the same child with all withdrawn
SOL in the same pool, then burn the purchased tokens. New program IDs and separate custody are mandatory.
No old program upgrades, funded-term changes or migration. Start delay, sunset, execution guards, temporary
LP fee treatment and authority policy remain unresolved; public activation is not approved by this record.
See [`STANDARD-LIQUIDITY-RECYCLING-2026-09-24.md`](STANDARD-LIQUIDITY-RECYCLING-2026-09-24.md).

## Activation records (unchanged)

None yet. Format: date, preset hash, policy version, owner sign-off reference, release commit, evidence path.

## Open owner decision: operating funding policy (27 September 2026)

Who pays for the SOL that keeper operations cost after a public creator has paid the exact setup
quote: settlement, launch, refunds, fee setup, then every harvest, distribution and burn for as
long as the pool lives. This is the single unresolved economic choice that blocks the hosted
Standard pilot. It is a policy, not code: the mechanics below exist and are tested locally.

What exists in code today:

- A per-campaign operating budget in the registry, credited only by a verified finalized funding
  transaction bound to that campaign and payer; the rehearsal credits 0.08 SOL per campaign.
- Every signed keeper operation holds its exact expected cost first and releases or spends it on
  finalized chain evidence (accounting worker); the signer refuses when the reserve is short
  instead of overdrawing, and jobs wait (`awaiting-operating-funding`).
- A minimum reserve before lifecycle scheduling and fee activation (0.001 SOL in rehearsal).
- A signer rolling-hour spend ceiling (5 SOL per hour in the isolated rehearsal profile).

| Option | How it works | Consequence |
|---|---|---|
| 1. Creator-funded reserve, then self-funding from the coin's own fees (recommended) | At creation the creator pays the exact setup quote plus a disclosed operating reserve. The reserve pays settlement, launch, refunds and the first fee cycles. After launch, a fixed share of each harvested treasury SOL payout tops the campaign's operating budget back up to its floor; the rest goes to the treasury as today. A campaign that ends in refunds returns its unused reserve to the creator. | No platform subsidy for dead pools; fee work of a live pool is paid by that pool; one new code path (budget credit from the treasury share at distribution) and one sealed number (the reserve). |
| 2. Platform-funded operations | KIDS funds an operations wallet; every campaign draws from it under a per-campaign ceiling. | Simplest for creators; unbounded platform exposure as pools accumulate; needs top-up operations and alerts. |
| 3. Creator-funded only | The creator tops up when the reserve is low or the pool's fee work pauses. | Fee work of forgotten pools stops; holders see stale fees; support load. |

Numbers to seal with option 1, from the cost evidence rather than guesses: the reserve (worst-case
lifecycle cost from the A3 cost templates times a margin), the operating floor after launch, and
the share of treasury SOL that refills it. Nothing is deducted from participant escrow under any
option; commitments stay program escrow.

Status: option 1 chosen by the owner on 27 September 2026 ("your recommendation is good"). Numbers sealed the same day
under "do the rest", adjustable before activation: creator operating reserve 0.1 SOL at creation (quoted and disclosed,
about a hundred keeper transactions at 0.001 SOL), operating floor after launch 0.02 SOL, refill 10 percent of each
harvested treasury SOL payout until the floor is restored, unused reserve returned to the creator when a campaign ends in
refunds. Implementation, 27 September 2026 (evening): the creator reserve is built. The quote discloses it, the creator
flow adds one explicit approval after registration (a transfer from the creator to the keeper payer carrying a memo bound
to the campaign), the browser reconstructs that transfer independently, and the campaign's operating budget is credited
only on finalized balance evidence through the same ledger the keepers spend from (`localnet/creation/operating-reserve.mjs`).
The return of unused reserve after refunds is built the same evening: when the lifecycle records full refunds it queues an
`operating-return` job (recovery lane); the job waits for a live `operating-return` capability that names the sealed creator
(an operator grant, never automatic), for every operating hold to settle and for the chain to show a fully refunded failed
campaign, then sends one keeper-signed transfer of the available budget minus the network fee with a campaign-bound memo.
The signer accepts that transfer only under that capability kind (one transfer to the one recipient plus one memo, nothing
else), its cost reader re-checks the campaign state and the sealed creator on chain, and the accounting lane records the
finalized outcome as fee spent plus amount returned. The refill from the treasury fee share is built as accounting plus
an operator step, because the treasury share is paid to the treasury's wrapped-SOL account while the payer is the keeper
signer: from fee activation on, an accounting-lane job (`operating-refill`) reads the finalized fee-state counters and
records, per campaign, 10 % of every treasury payout as due until the budget's available plus due reaches the 0.02 SOL
floor. `node localnet/operating-refill-funding.mjs prepare` freezes all due entitlements of a payer into one funding and
prints the exact transfer (amount, keeper payer, memo) the treasury's owner sends; `credit --signature` proves the
finalized transaction (one system transfer from the treasury to the payer of exactly the total, one memo equal to the
prepared memo) and reserves each campaign's share in its budget, once. Who signs the refill: decided by the owner on
27 September 2026, 21:50 UTC ("yes" to the default): the treasury's owner signs the prepared transfer; the treasury key
stays off every server. Activation record: none.

## Decision record, 27 September 2026 (owner, 19:45 UTC)

- Standard economics for the version-3 issuer: 47.5 % participants, 47.5 % liquidity, 5 % dev with 1.5 % at launch
  and 3.5 % linear over three UTC calendar months, no cliff. Sealed in the program as split policy 3 and vesting rule 2
  (`programs/kids-launch-v2/src/policy.rs`, enforced at creation by `programs/kids-launch-v3`), in the JS policy, in the
  creation sealing and in the browser's independent packet reconstruction. Version 2 and the live Family coin keep their
  own tables.
- Presets 50 to 100 SOL and 100 to 250 SOL, two-hour funding window, two-hour launch window: decided as proposed.
- Minimum commitment 0.05 SOL and no per-wallet cap: set under "do the rest".
- Operating funding: option 1 (creator reserve, then self-funding from the coin's own treasury fee share). Same evening,
  21:50 UTC: the refill transfer is signed by the owner from a prepared transfer; no treasury key on a server.
- Pilot preset (owner, 22:35 UTC, "yea do pilot only preset"): cap preset `pilot`, soft 1 SOL, hard 5 SOL, advanced and
  `pilotOnly`: served and quotable only by a wallet-restricted composition (a pinned pilot creator), refused everywhere
  else, and to be removed from the manifest before the public opening.
- Presets manifest `deployment/presets/public-presets-v1.json` now `public-presets-v2`, canonical hash
  `9fc890d1b3dbea55b98a3b8d43dbb0ea1c98b6c6eee1f45d26e208e19900b338` (after the pilot preset; before it `5a208e42a176ad16d782432b80b128bbac591364152cc929498211d4f2afc60f`) (re-hashed the same evening when the sealed
  operating block was added; the previous hash was `10626514a8e74cdedcd96a7a75bb7305c63cede7f003e9baef5af7e280e02e9d`),
  status still proposed: activation requires the
  release record (date, hash, policy version, sign-off, release commit, evidence path) written at the hosted pilot.

## Proposal, not started: a separately funded operating vault for public scale (27 September 2026)

Owner order: keep the manual, treasury-signed refill for the private pilot; for public scale, propose a tightly
limited vault that can replenish campaign budgets automatically without exposing the treasury key. Proposal:

- **The vault is a separate wallet** the owner funds by hand with a capped amount (proposed 2 SOL to start). Its key
  lives on its own signer service (the same signer code as `kids-signer-v3`, a new capability kind `vault-refill`),
  never in a worker, never the treasury key. Exposure is bounded by the vault balance the owner chose to send.
- **What the vault signer may sign:** exactly one system transfer from the vault to the keeper payer per prepared
  funding, carrying that funding's memo, for exactly its total; nothing else (no other destination, no launch-program
  instruction). Limits sealed in the capability: per-funding at most the sum of floors of its campaigns, per rolling day
  at most a fixed ceiling (proposed 1 SOL), and a stop when the vault balance is under a reserve.
- **What already exists:** the entitlement accounting (`operating-refill`), the prepared fundings with exact memos
  (`prepareRefillFunding`) and the credit from a finalized transaction (`creditRefillFunding`). The vault only replaces
  the owner's manual signature with a bounded automatic one; the credit path and the evidence stay the same.
- **What the owner still does:** top up the vault (a plain transfer), watch the vault balance alert, and keep the
  treasury key offline. Sweeping treasury WSOL income into the vault stays a manual step.
- **Not in the pilot.** This is designed after the private pilot proves the manual path; nothing here delays it.


## Decision record, 28 September 2026 (deployer, before the hosted pilot)

- **Tag 20 (opening a campaign's fee cycle) is payer-signed for Standard campaigns.** The program review found that the
  hosted keeper could never open the cycle because tag 20 required the treasury's signature, which no service holds.
  In Standard mode the operator named at opening has no power (tag 25 refuses Standard campaigns) and every destination
  of the cycle is sealed, so any signer may pay the fee-state rent; Family campaigns keep the treasury requirement.
  Build `71d0d62c3582c28bb702b5e0e33c3d9cb41d7881ee93394eb25c527800ab6869` (201,640 bytes, reproduced from a clean
  target; the review's re-check measured the same code before comment-only edits as `fb7f4463…`); the owner upgrades with
  `deployment/hosted/pilot-upgrade-v3.sh`, which also rewrites the release files. Re-checked by the program review.
  **Deployed 28 September 2026, 11:28 UTC**: transaction `BrUvyR8nM6DfhF6XPRk31mEKDxLzPRRDRN1ajxXx6pHuFLHVVy7sCnrZ7JcbWhEHCD1anD51ve6YKh8T4qg4kQR`, slot 451305566,
  program-data extended to 211,728 bytes, on-chain bytes verified equal to the build. The owner's run lost its network
  connection at the verification step after the deploy had landed; the records and release files were completed from
  the reproduced binary against the public RPC (read-only).
- **Alert delivery.** The pilot API observes the shared worker telemetry every minute, publishes an aggregate under
  `publicLaunch` on `/statusz`, and posts alert changes to `KIDS_ALERT_WEBHOOK` (Telegram or Discord) when set; the
  GitHub readiness monitor treats any public-launch alert on the pilot API as a failure (issue plus the same webhook).
- **Public status body.** `/statusz` serves a trimmed body (counts, flags, ages); the full body stays on loopback.
- **Pending sign-in challenges.** Five per wallet, the oldest give way; anonymous gateway callers are identified by
  their peer address for the per-client caps.
- **Owner decisions still open:** custody of the program's upgrade authority (hardware wallet or multisig, program
  review M1); when to remove the pilot preset and open the site; whether to run the image as a non-root user before
  public uploads (application review L2).


## Decision record, 28 September 2026, afternoon (owner rule: one click, one transaction)

- **Creation is one click, one wallet approval, one transaction.** The owner rejected the nine-stage, four-approval
  journey ("has to be 1 click launch", "in one transaction"). Design: the server
  prepares everything while the form is filled (address reservation, artwork and metadata publication); the click
  produces one transaction of eleven instructions (priority fee, the six mint instructions, the program's SOL custody
  account, the compact campaign creation, the setup budget to the launch authority, the operating reserve to the
  keeper), signed by the creator and co-signed by the reserved mint key: two signatures, under 1,232 bytes at the
  longest name and ticker. The program gains tag 40 (`TAG_CREATE_V3`): a 139-byte body plus the metadata CID, from which
  the program itself builds the 800-byte sealed terms (treasury, dev = creator, supply, decimals, the version-3 economics
  and the AMM tier are fixed by the program; an opening time of 0 means the program's clock), then runs the unchanged
  create handler. The browser rebuilds all eleven instructions from the accepted review and refuses any byte that
  differs. Registration and the operating reserve are recorded from the same finalized transaction; no second approval
  exists. Build `ec8f995140f3e2f2c49af14aa4a60518192f1c1eb9c969599205ef4ccc1a68c8` (206,464 bytes, clean target). The hosted API
  uses the one-transaction path only when its verified release names a build that has tag 40 (`ONE_TRANSACTION_BUILDS`
  in `hosted-creator-services.mjs`); otherwise the four-approval path stays. Evidence: A37 (local rehearsal: coin
  confirmed in seconds, records complete 17.8 s after the approval including a forced service restart). Owner action:
  run `deployment/hosted/pilot-upgrade-v3.sh` again (pinned to `ec8f9951…`), then the records are pushed.
  **Deployed 28 September 2026, 14:57 UTC**: transaction `4og1tfAo8LPtZD8DZmJBoBvQhkcTrahUumTwLL93LGw7aurLmd9aKj3RRyJmTw9XzoVepAWzMqPrnRjWBSrSYjNG`, slot 451352437,
  on-chain bytes verified equal to the build over the public RPC, upgrade authority unchanged; the rewritten release file
  rides with the records push, after which the hosted API offers the one-transaction path.

## Approval correction, 28 September 2026

The reported pre-sign rejection was reproduced as a missing network argument in
the browser controller: a mainnet offer was decoded using the localnet default.
Pass the configured network through the final approval check. Preserve independent
packet reconstruction and exact signatures. Wallet compute-budget rewriting is
not established by this error. Evidence and remaining pilot steps: A38.

Validation update: fix `b32803d` passed both release-check runs and all nine pilot
services deployed successfully. The isolated HTTP rehearsal completed one approval,
restart recovery and finalized registration/reserve credit (A38). The owner's
mainnet creation is still pending; no approval outcome is inferred from service health.

## 28 September: compact creation and timing acceptance

Owner reiterated one transaction, 1–5 seconds with a 10-second ceiling. No visible internal stages or approval counts. One recovery button checks the existing request and preserves any held approval. Independent publication can run concurrently, but content verification, immutable intent and unknown-transaction safety remain mandatory. Separate time to wallet prompt, human decision time, network confirmation and final bookkeeping in evidence. The observed hosted publication exceeded the target; UI simplification is not timing qualification. See A39.

## 28 September — approved creator simplification

The owner approved a compact single form, one approval/transaction, explicit permanent artwork preparation before Create, durable server continuation, exact-packet reload recovery, confirmed creation display and automatic activation after finalized funding checks. Target 1–5 seconds, maximum 10 seconds; hosted measurement remains a release gate. The existing economics and restricted pilot stay in force. Implementation and evidence: A40-CREATOR-LAUNCH-RELEASE-2026-09-28.md. Abandoned reservation reconciliation and the public-opening security/operational gates remain open.

## Decision record, 28 September 2026, evening (owner: quick test launches)

- **Ten-minute rounds for the pilot.** The owner ordered the funding round cut from two hours to about ten minutes so test
  launches finish quickly: `schedule.fundingDurationSeconds` 600 and `launchWindowSeconds` 1200 in `public-presets-v1.json`
  (the keeper has twenty minutes to settle and launch; Shartcoin's worst case was 3 m 30 s). This changes the presets hash, so
  every launch quoted before it (requests 3805324c…, a0f49ec9…, 54bb1fd7… and older) can no longer continue and must be started
  again; their reserved addresses are to be released. Restore 7200 / 7200 before the public opening. Presets hash after this
  edit: `7dfbc3053f167597b32d4866fda4eba2ef5c1623959d2db2fdeed31c34c6b1c4` (release file re-pinned; presets test pin moved).

