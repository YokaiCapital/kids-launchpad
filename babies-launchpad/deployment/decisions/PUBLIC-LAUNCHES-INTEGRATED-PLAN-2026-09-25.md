# Public launches and new Direct mechanics: integrated implementation plan

Date: 25 September 2026. Consolidated after source review at `72a264d` on `feature/public-launches`.
Planning artifact, not activation, an implementation-completion claim or a production audit.
Scope: preserve existing parent/Family, Standard and funded launches. Introduce new mechanics
only through explicit new launch versions, new affected program IDs and isolated custody.

**Implementation owner: platform engineering. Status: GREEN received; phased implementation in progress.** This document
supersedes the earlier execution handoff. GREEN authorizes implementation; mainnet
changes and public enablement still require the release evidence gates below. The previous owner has been notified
to hold overlapping work; delivery of that notice is not an acknowledgement.

## Ultimate goal — the test for every implementation decision

**Make KIDS a production launch platform where anyone can create a coin through a clear,
complete flow; participants can understand and verify the rules governing their funds;
many coins can raise, launch and trade concurrently; and claims, refunds, fee collection
and burns remain reliable as demand grows—all without changing existing coins' promises.**

The commercial aim is sustainable public-launch adoption and transparent platform revenue,
earned through a product creators and traders want to use. The technical and UX work must
serve that outcome. More mechanisms, higher transaction counts or impressive mockups are
not success by themselves. We do not promise token price appreciation, guaranteed returns,
unlimited capacity or an absence of risk.

The first real proof is a wallet-restricted pilot with complete, reconciled journeys. The
public goal is reached only after tested operating limits, security review, transparent
authorities/custody, monitoring and a deliberate public-release decision. Innovative Direct
mechanics are valuable only when they improve the product under measured risk and can be
shipped as separate qualified versions; they must not compromise the foundation.

### Mandatory goal comparison

At the start of each phase, before adding scope, at each milestone report and before any
activation, compare the proposed/resulting work against the following scorecard. This rule
persists across sessions and handoffs. Re-read this section when resuming work.

| Goal dimension | What must be demonstrated |
|---|---|
| Complete creator journey | Create with real media, exact terms/costs and a usable mint; safely resume interruptions; manage the resulting coin. No manual developer intervention for the ordinary qualified path. |
| Understandable participant journey | Discover the right stage, understand min/max and oversubscription, commit, inspect the personal allocation, then trade/claim/refund with clear status on desktop and mobile. |
| Verifiable money and permissions | Exact asset accounting, durable transaction identity, known authorities, no cross-campaign access or duplicated financial effect; real source/program/custody evidence. |
| Reliable concurrent operation | The declared mixed launch/user/fee workload meets per-service latency and recovery targets; background work cannot consume critical capacity. |
| Sustainable fee operations | Correct collection, distributions and burns with bounded costs, independent service capacity and truthful accrued/pending/confirmed reporting. |
| Preservation and recoverability | Existing coins keep their rules and access; outages, rollbacks and pauses do not erase paid claims/refunds or abandon uncertain transactions. |
| Public operating readiness | Qualified presets only, transparent docs, tested wallet compatibility, monitoring/alerts, restore/incident runbooks and a verified release bundle. |

Use the statuses **meets / partial / not demonstrated / blocked**, with a concrete evidence
link and the next gap for each affected dimension. Do not average scores: a failing custody,
recovery or security condition blocks the affected release regardless of visual polish.

Every progress report should answer: (1) which goal dimension improved, (2) what proves it,
(3) what still prevents the ultimate goal, and (4) the next highest-impact step. If a proposed
feature adds complexity or recurring cost without advancing a dimension, defer it or explain
the tradeoff before including it. No silent change of this goal to fit what happens to be built.

## Review contract and complete scope

GREEN approves the phased implementation described here, beginning with the restricted
public-launch foundation. RED means revise the plan. Unresolved economic choices in section 2
remain unresolved even after a general GREEN: their affected presets stay disabled until their
terms are chosen and qualified. Production activation remains a distinct evidence-based gate.

The target experience is **Explore → create → fund → settle → launch → trade/claim → manage**,
with failed raises, interruptions, support, transparency and mobile behavior included. It must
work across many independent coins without putting users and launch deadlines behind fee work.

This is the controlling implementation plan. These supporting specifications form part of it:

- [Full screen/state inventory and launch journeys](../design/PUBLIC-LAUNCH-FULL-FLOW-2026-09-25.md).
- [Directory layout and interaction specification](../design/PUBLIC-LAUNCH-DISCOVERY-2026-09-25.md).
- [Worker isolation, scaling findings and capacity qualification](PUBLIC-LAUNCH-CAPACITY-2026-09-25.md).

The visual review packet contains eleven screens: directory, four creation steps, raising coin,
live coin, positions/claims, creator management/recovery, failed raise and mobile commitment.
Use the corrected review/raising/dashboard versions. The user likes this visual direction;
implementation follows the approved consolidated plan. Do not treat generated amounts,
dates, logo variations or raster proportions as authoritative program terms or new brand assets.

### What the first release includes

- Wallet-exclusive pilot for the owner's already supplied public address, enforced on the
  server and on-chain for new creation; actual wallet compatibility and transaction recovery.
- Complete Standard creation and lifecycle, existing Family coin support, durable metadata,
  usable `kids` mint inventory, exact caps/quotes/allocations and dev vesting.
- Approved browse-first design, complete creator and participant journeys, accessible mobile
  controls, market/fee/activity data and verification evidence.
- Shared durable storage, independently scalable API/workers, protected fee throughput,
  operational monitoring, load/failure qualification and release/runbook documentation.

New Family creation, Direct recycling, first-hour reserve sale and Auto MM are separately
gated releases in this same roadmap. Do not show them as usable public presets early or change
the terms of existing launches. Basic Standard public launches do not wait for an unproven MM strategy.

## 1. Product judgment

The reliable public-launch workflow is the strongest immediate improvement: clear terms,
proportional allocations/refunds, verified custody and a usable post-launch market. Predictable
supply reduction and a transparent coin trading reserve could differentiate KIDS. More
mechanisms are not automatically a better product or better token economics.

- Recycling reduces supply and mechanically changes spot price, but does not guarantee demand
  or a lasting price increase. Its price/depth effects must be measured in both directions.
- First-hour reserve sales finance the coin trading reserve by selling additional inventory
  against buyers. That competes with early buying pressure and requires prominent disclosure.
- Fees, MM rebalancing and recycling can make the system trade against itself, pay costs and
  alter the same price signals. Combined behavior needs its own tests, not just unit tests per module.
- Actual MM provides executable liquidity. A bot swapping to a target portfolio is a trading
  strategy, with price/MEV/cost risk, not proof of better liquidity or token growth.

Recommendation: ship the production public-launch foundation first; add fee-preserving
recycling to a separately reviewed Direct preset; introduce the reserve-sale/trading-vault
preset only when its full lifecycle exists; add true automated liquidity management only if
simulation and pilot measurements outperform simpler alternatives. No retrofit of funded launches.

## 2. Decisions and terminology

Confirmed:
- Parent/Family launches stay; Direct is additional and has no parents of its own.
- Existing commitment, cap, proportional settlement/refund and vesting mechanics remain.
- Direct LP: 50% of initially received LP permanent, 50% temporary; each cycle redeems 3%
  of remaining temporary PRINCIPAL budget after verified fee accounting.
- Preserve treasury/dev fee entitlements from both LP halves. Preserve existing token-side
  fee burns. Earnings are not guaranteed to remain constant as positions/volume change.
- New on-chain features use new program IDs; no upgrades to introduce them into old programs.
- User requests a 10% initial token reserve, first-hour matched sales, burning unsold initial
  inventory, retaining SOL in coin custody and post-hour trading without withdrawals.

Terms to use everywhere:
- KIDS treasury: company/platform fee revenue.
- Dev earnings: dev's fee entitlement and, separately displayed, vested token entitlement.
- Coin trading reserve: program-owned sale proceeds and later MM inventory; neither company
  nor dev may cash it out. It is not claim/refund money and not a promise of redemption to holders.
- Pool liquidity: AMM assets represented by LP positions; distinguish permanent and temporary.

Still pending (recommendations below are NOT approvals):

| Decision | Recommendation / implementation condition |
|---|---|
| Recycling ending | Recommend 90 successful cycles, then permanent lock; owner has not selected it. Disclose that outages make this longer than 90 calendar days. Also decide a maximum wall-clock life; do not invent an emergency discretionary withdrawal. |
| First-cycle delay | Seal explicitly, at least 24 hours; seven-day delay previously discussed is not approved. |
| Source of 10% reserve | Propose 43.5% participants / 43.5% pool / 3% dev / 10% reserve; alternative 38.5 / 48.5 / 3 / 10. Neither selected. Without reserve, the Standard economics decided on 27 September 2026 apply: 47.5 / 47.5 / 5 (dev 1.5% at launch, 3.5% linear over three months). |
| What 10% of buy means | Recommend 10% of received token units; not equivalent to 10% of SOL spend. Requires owner selection. |
| Every-buy trigger | Choose asynchronous Raydium follow-up with an explicit authenticated evidence/trust model, or a separate native-hook AMM. Exact synchronous matching cannot be promised on ordinary external Raydium buys. |
| MM strategy and risk parameters | Choose only after evaluation. Do not silently turn a trading bot into a CLMM deployment or change the original pool venue. |
| Earnings from any additional managed LP | Distinguish them from the two launch LP positions. Proposed MM strategy earnings stay with the coin trading reserve; this is a separate decision, not already approved by fee preservation. |
| Authority and execution controls | Review immutable authority model, external program risks, price references, minimum batch, cost funding, budget ceilings, pause scope. |

Supply examples are proposed allocations, not a code or active-manifest change. For new Standard
campaigns on the version-3 issuer the dev policy is 5% total, 1.5% at launch and 3.5% linear over the
existing three-calendar-month rule (owner, 27 September 2026); existing coins keep their sealed 3%.
Validate the actual AMM config and display its fee; do not silently change the agreed fee tier.

## 3. Baseline evidence and gaps at GREEN

This paragraph records the baseline before implementation; the dated checkpoints below
record the current state. Inspected integration includes versioned registry reads, wallet-owned drafts, localnet-only
commit/refund/claim services, durable transaction packets/reconciliation and frontend scaffolding.
Creation still lacks complete durable provisioning; the Postgres adapter is deliberately disabled;
Family-v2 creation is disabled until distribution is wired; market/portfolio/creator flows and
real-wallet validator rehearsals remain incomplete. Existing historical Family service is separate.

Direct has a NONDEPLOYABLE Rust state/effects library and an offline JS policy codec/model.
The approved fee-preservation mode fails explicitly because its accounting is absent. There is
no Direct controller entrypoint, authenticated account adapter, fixed CPI execution or deployment.
Reserve sale and Auto MM currently exist only as design documents. No mainnet readiness inferred.

## 4. Architecture and money boundaries

Use independently identified components, reusing reviewed source where appropriate:

1. Versioned launch issuer/escrow: sealed launch terms, commitments, proportional settlement,
   refunds, atomic pool creation and activation, routing supply to the declared custodies.
2. Participant claims and dev vesting: durable, bounded recipients and entitlements; no paid
   claim/refund expiry. Separate custody from all operations and strategy funds.
3. New liquidity controller: temporary LP budget, fee accounting, restricted recycle operations,
   canonical remainder locking and public receipts. Permanent Raydium lock is separate.
4. New coin-reserve controller: initial 10% inventory, sale evidence/budget, one-hour deadline,
   reserve finalization, post-hour SOL/token custody and bounded trading capabilities.
5. Version-specific execution workers/indexers: submit constrained operations, reconcile chain
   state, maintain views and alerts. Workers are not the authority for balances or entitlements.

A component is not necessarily a new microservice. Use the existing signer/worker architecture
where suitable; make on-chain capabilities/custody separate. No global operator key can move
all assets. Every campaign binds genesis + issuer ID + controller IDs + campaign + mints + pool
+ terms/policy hashes. SDK, signer, API, indexer and UI all dispatch on this identity.

Do not add a new capability to an already funded campaign by editing an allowlist, changing
an environment variable, transferring its LP or upgrading its controller. New-feature releases
get new affected program versions. Old keepers/claim/refund adapters stay operational.

## 5. Workstream A — finish the public-launch foundation

Implementation:
1. Audit/reuse current KIDS components by contract and tests, not by copying secrets.
   Reuse wallet discovery, exact transaction validation, durable submit/status handling, signer
   isolation, market indexing, media pipeline and the already-working encrypted mint inventory.
2. Creation wizard: metadata/media, verified setup-cost quote, schedule/caps, reviewed preset,
   immutable economics preview, wallet funding and explicit signing. No arbitrary user-supplied
   program IDs, treasury recipients or unsafe token extensions.
3. Provisioning state machine: draft -> validation -> leased vanity mint -> uploaded immutable
   metadata -> setup funded -> campaign created -> registered/open. Persist each signed intent
   before broadcast. Reconcile before retrying; never recycle a mint lease whose use is uncertain.
   Concurrent creators must not receive the same `kids` mint or leak its private key.
4. Real Postgres adapter/migrations with unique chain identities, wallet ownership, revision
   checks, durable job leases and one intent per campaign/action/sequence. Implement paginated
   directory, creator launches and complete wallet-position discovery across all campaigns.
5. Keep oversubscribed commitments open until deadline. Use integer pro-rata allocations and
   refund excess; soft-cap failure returns commitments. Rehearse settlement rounding and many
   small receipts. Per-wallet limits alone do not prevent Sybil concentration.
6. Full lifecycle workers: open/close, settle, launch, verify lock/authority state, service refunds,
   participant/dev claims, fee handling and market indexing. Failures must leave known recovery
   and exit paths, not silently change campaign parameters.
7. Family-v2 gets explicit separate distribution/snapshot/eligibility implementation and tests
   before creation is enabled. Do not redirect existing parent claims into this new code.
8. Assets: authenticated uploads, size/type/content checks and safe URL fetch rules; immutable
   launch metadata, signed authorization for editable creator posts/social links. Store no keys
   or private runtime assets in Git. Prevent SSRF/XSS and cross-creator edits.

Acceptance: multiple unrelated creators can create, fund and launch concurrently; real external
wallets can commit, reload mid-transaction, receive exact allocations/refunds and claim on the
correct program/network. An API/signer/worker restart produces no duplicate payment or mint reuse.

## 6. Workstream B — fee-preserving temporary LP accounting (critical prerequisite)

This must precede recycling. A temporary CPMM LP position's earned fees are embedded in its
redeemable assets; the current kernel's raw LP budget cannot stand in for separated principal.

Implementation:
1. Pin the exact Raydium pool/locker binaries and account layouts used in the target deployment.
   Master-branch source is a reference, not proof of deployed ABI. Rehearse existing Fee Key
   harvest semantics and reusable accounting with the actual programs.
2. Define principal shares/baseline and separate accrued-fee liabilities. Model pool fee growth,
   protocol/fund deductions, LP deposits/withdrawals, donations, rounding and collector actions.
   Price gains are not fees. Do not infer fee income solely from SOL/USD valuation changes.
3. Design a constrained harvesting adapter for temporary LP that preserves the agreed fee
   entitlements without paying principal out as income. Track any LP units redeemed to harvest
   earnings separately from recycling LP. Do not count raw LP balance as an unchanged principal
   budget after harvesting. Account for fees generated by our own recycling swaps only once.
4. Route verified SOL fee earnings according to sealed treasury/dev weights. Burn verified
   child-token fees under the existing policy. Donations need a separately constrained treatment.
5. Prove fee entitlement and principal conservation against an independent model and canonical
   locker behavior. If safe separation cannot be demonstrated for this venue, do not enable this
   preset or claim preservation; propose a different explicit position design for new launches.

Acceptance: fee-only collection cannot reduce accounted principal, recycle cannot consume fee
liabilities, harvest and recycle ordering cannot double-spend, and extreme rounding cannot pay
principal as fees. Publish the exact meaning and limits of fee preservation.

## 7. Workstream C — daily LP recycling

Implementation:
1. Finish the new sealed Direct layout/controller adapter. Authenticate every owner, PDA, mint,
   authority, delegate, pool/config and canonical program. Check account aliases before CPIs.
2. Atomic launch: measure actual LP received; lock permanent half with odd-unit dust favoring
   permanence; transfer temporary half into the controller; verify every custody and revoke
   child mint/freeze authority before marking launch live. Refund/claim reserves stay untouched.
3. Recycle only after the explicit delay and at least 86,400 seconds since the previous success.
   Derive 3% from remaining principal accounting ON CHAIN after fee treatment. No caller-chosen
   amount, no backlog burst, no donated-LP budget increase. State sequence makes retries safe.
4. One atomic instruction: constrained withdraw -> burn measured withdrawn child -> spend all
   measured principal WSOL on that child in the same pool -> burn measured output. Fees and
   operational costs are separate. Chain-measured deltas, never caller-supplied Effects.
5. Enforce reviewed price/history/freshness/deviation/impact gates and economic minimum batch.
   No trusted off-chain quote alone; no minOut=0 fallback; a thin pool's own spot is manipulable.
6. Finalize after the selected limit/dust rule by permanently locking remainder. A timeout must
   not create discretionary withdrawals. Tiny asset-output batches require an explicit skip/end
   policy; do not silently round up or liquidate the whole remainder.
7. Publish receipt: principal LP redeemed, fee LP harvested separately, tokens burned from
   withdrawal, tokens bought/burned, principal SOL returned, protocol costs and both custody states.

Acceptance: actual validator tests with pinned AMM CPIs, LP/mint-supply deltas, malicious account
substitution, CPI failure rollback, stale pricing, external LP changes, donations, repeated txs,
outages and preserved claim/refund balances. SBF stack, compute and transaction-size evidence.

UI: show 50% initially permanent / 50% temporary, current tracked remainder, 3% denominator,
next eligibility, end policy and verified burns. Never label the whole LP permanently locked,
authorization as execution, or remaining SOL as a guaranteed floor. Real removal events remain visible.

## 8. Workstream D — first-hour reserve sale and coin trading reserve

Implementation:
1. Resolve supply source and matching units. Add an explicit new supply-policy ID; update
   entitlements, pool inventory/opening price, SDK hashes, review UI and accounting tests together.
2. Allocate initial reserve once into its own PDA token custody at launch. The first-hour window
   uses verified trading-open chain time. No reminting or access to previously funded reserves.
3. Resolve the source-event trust architecture before code claims every-buy compliance:
   - ordinary Raydium: keeper observes/swaps asynchronously; a reviewed authenticated evidence
     mechanism and bounded on-chain budget are required; RPC logs/signature strings alone are
     not proofs a Solana program can authenticate;
   - routed wrapper: synchrony only for routed buys, bypassable by direct AMM callers;
   - native AMM hook/counter: separate AMM integration and security effort; no automatic support
     across wallets/aggregators/scanners. Do not silently change venue for launch urgency.
4. For token-unit matching, cumulative authorized sale <= min(initial reserve, floor(eligible
   gross token buys / 10)); subtract already sold/reserved intents. Deduplicate signature plus
   instruction index, handle failed transactions/forks/aggregator swaps and exclude our own
   protocol/MM/recycle activity. Cannot identify every wash trader by wallet address.
5. Fixed pool, fixed vault outputs, nonzero verified minOut, bounded impact and meaningful batch
   size. A delayed keeper cannot burst the entire reserve or sell after deadline. Inventory
   exhaustion stops sales early. Pending operations reconcile against the same signature.
6. At deadline reject all further initial sales and backlog. Permissionless finalizer burns
   unsold initial reserve and opens post-hour mode. Actual burn needs a transaction; permissionless
   fallback and alarms cover keeper failure. Post-hour inventory has a separate account.
7. Keep all net proceeds in the coin trading reserve. No SOL unwrap/close/rent/fee/sweep escape.
   Until MM or reviewed bounded trading is ready, do not enable a complete preset that promises it.

Acceptance: conservation of initial 10% = sold + unsold + burned; SOL proceeds reconciled net of
actual costs; no late sale or finalizer replay against purchased inventory; forged evidence cannot
expand sell budget; no-volume case burns all initial reserve and leaves no invented SOL balance.

UI: before commit, prominently disclose the 10% reserve and first-hour sell rule. At launch show
remaining/sold/burned, time, net SOL retained and any observer lag. This is sell pressure to fund a
coin reserve, not a buyer transfer tax or platform revenue. Scanners may flag initial concentration.

## 9. Workstream E — true Auto MM versus treasury trading

Use two separate definitions in designs and UI:
- Automated treasury trader: swaps to rebalance token/SOL inventory; consumes AMM liquidity.
- Automated liquidity manager: places/manages two-sided liquidity positions or executable quotes.

Recommendation: evaluate actual liquidity management, not automatically deploy the previously
suggested dip-buy/rally-sell bot. The existing CPMM already makes markets; an extra bot is not
necessary for swaps to work.

Implementation/evaluation:
1. Benchmarks: reserve idle; reserve as additional same-pool CPMM LP; managed concentrated
   liquidity (new venue/position adapter); bounded inventory-rebalancing swaps. Include all
   swap fees, outside arbitrage, transaction costs, adverse selection and liquidation stress.
2. Start with constrained same-pair custody; whitelist specific venue/program/pool identities.
   A secondary CLMM adds routing, fragmentation, indexer and audit requirements and needs an
   explicit venue decision. It must not replace or unlock the original permanent position.
3. If a candidate wins, implement a new reviewed strategy controller/version with per-action and
   rolling budgets, token exposure ceiling, SOL reserve floor, minimum interval, price/reference
   and impact rules. No-trade bands must exceed modeled execution/round-trip costs where relevant.
4. Keeper proposes, program authorizes. Dev may pause/resume within the published policy; any
   manual trading obeys the same limits. No discretionary recipients, routes, price limits or
   budget override. Program upgrades are also a capability that needs transparent restriction.
5. After initial reserve burn, gradually acquire any required inventory rather than spend all
   SOL immediately. MM-bought tokens are retained for future sale/liquidity; LP-recycle-bought
   tokens are burned. Track inventory/PnL/fee treatment separately. Empty reserve means no trades.
6. Queue/serialize MM actions and recycling around a campaign execution lease, with chain
   sequence and current-state validation if another actor changes the pool. Do not self-trigger
   first-hour matching, or mistake protocol-created price changes for independent demand.
7. If pricing is unsafe, no action. Finite budgets bound damage, not guarantee no loss or no
   indirect extraction. A manipulated thin-market reference needs adversarial tests, not faith in TWAP.

Acceptance: improve executable depth/slippage against baseline without unacceptable reserve loss;
report inventory value at conservative realizable prices, costs, exposure and stress drawdown.
Define tolerances BEFORE seeing results. No guaranteed price/volume/market-cap targets. If no
candidate beats a simpler baseline under agreed risks, keep Auto MM disabled. It is an optional
new-preset feature, not a dependency for all public launches.

## 10. Public UI/UX and API integration

Approved design direction: compact rows and current KIDS plum/pink/grape/ice identity. Retain
actual approved wordmark/mascot assets. Existing Shartcoin remains its own coin identity.

| Surface | Implemented behavior required |
|---|---|
| Explore | Search and cursor pagination over the full registry; Upcoming / Raising / Launching / Live / Refunding filters; real stage and relevant countdown. Participants means distinct committed wallets. Minimum target is primary; max retained is secondary. |
| Wallet | Multi-wallet discovery and readable sign-in; correct network; account switch/rejection/session expiry; server authority independent of the selected client address. |
| Creation 1: Coin | Qualified type, name, exact ticker and identified creator/dev wallet; saved draft. |
| Creation 2: Profile | Square PFP, 3:1 banner, description, X/website, optional 16:9 video/caption; authenticated durable uploads, crop/validation, progress and retry. |
| Creation 3: Terms | Qualified preset, minimum/maximum, opening/closing UTC plus local equivalent, supply, vesting, actual fees and liquidity policy. |
| Creation 4: Review | Exact expiring setup quote and itemized cost, immutable financial terms, authorities/custody, budget refund rules and wallet confirmation. Unknown price never becomes zero. |
| Creation progress | Durable intent, signature and stage; interrupted setup resumes safely. Completion means funding page ready, not trading live. |
| Upcoming / Raising | Compact funding progress, min/max, opens/closes countdown; oversubscription remains open to deadline; personal position and estimate for the additional commitment. |
| Launching | Funding closed, settlement progress and verified pool creation/readiness; no timer-only transition to Live. |
| Live coin | Real chart/trades, liquidity and market metrics, clear holdings/claims/refunds, quote expiry, minimum received, fees and user-editable slippage. |
| Your activity | Complete wallet positions with available claims/refunds first; concise transaction history; exact eligibility/availability reasons. |
| Your launches | Drafts, resumable setup, profile/posts, dev vesting and fee earnings; sealed terms remain read-only. |
| Failed raise | Actual reason, exact full refundable commitment, safe signing/status flow and persistent refund access. |
| Transparency / Guide | Version-specific rules, source/builds, real program IDs, upgrade powers, authorities, custody, lock/fee rights and explorer evidence. |

Example directory text: `38 / 50 SOL minimum` with `Max retained: 100 SOL`; then `72 SOL ·
Minimum reached`; over maximum `143 SOL · 1.43× subscribed · Still open`. Progress uses a
fixed 0-to-max scale with the minimum marker in its correct position. Display pro-rata/refund
rules once above the list, with details available on the coin page. Live rows use live metrics,
not a funding countdown. Participant counts do not establish unique humans or Sybil resistance.

Specify and test each surface's loading, empty, unavailable, stale, permission-denied and
transaction states. Remaining detailed visuals include upcoming/launching variants, wallet
interaction, transparency, dev earnings and mobile creation/trading/claims. Review these during
their phase before coding the corresponding screen; do not silently invent a different layout.

Creation:
- Keep parent/Family and existing Standard choices; add a clearly distinct Direct policy once
  activated. Explain the actual LP policy rather than relying on the word Direct alone.
- Prefer a few audited presets. Do not expose unchecked combinations of fee, reserve, supply,
  slippage, authorities, AMM or recipient settings to public creators.
- Four steps: Coin -> Profile -> Terms -> Review, then wallet confirmation and recoverable
  creation progress. Block ambiguous terms and unavailable quotes rather than pretending zero.
- Review shows supply allocation, fee breakdown, permanent/temporary LP, recycling schedule,
  reserve-sale pressure, coin-reserve permissions, program IDs and claim/refund rules before funding.

Prelaunch:
- Progress with soft/hard markers, time and unmistakable 'Still open — pro-rata allocation;
  excess refundable' above hard cap. Distinguish committed SOL, accepted SOL and refunds.
- A compact 'Your position' with commit/estimated allocation/refund; avoid fake certainty before close.
- 3:1 banner, correct PFP, inline social icons, optional 16:9 video and concise developer updates.
- Transaction status: wallet -> submitted -> confirmed; ambiguous timeout stays pending with
  recovery. Skeleton geometry preserves layout; no alarming technical loading banners.

Post-launch:
- Above fold: identity, real market/price/liquidity, trade panel and personal claims/refunds.
- Compact panels: liquidity policy/proof; supply burns; coin trading reserve/strategy. Company
  and dev fee earnings are distinct from reserve capital. Values have as-of times and unknown states.
- Cap visible rows, group operations under a signature, filter trades/recycling/fees/MM, expand for
  full receipts. Nonzero dust uses meaningful precision; no empty 'no movement' rows as actions.
- Mobile action bar and accessible click/focus tooltips; responsive numeric formats/full-value expand.
- Trust page: verified program IDs, reproducible source/builds, authorities, custody, lock evidence,
  fee rights, strategy permissions and explicitly disclosed remaining powers.

## 11. Infrastructure, security and operations

Target topology: edge protection/CDN → stateless API replicas → shared durable Postgres and
read cache; independent worker services pull their own due jobs; restricted private signers
authorize operator transactions; RPC providers and chain indexing serve shared read projections.
Uploaded media lives in object storage. Browsers never receive operator/mint secrets. Read
load balancing and financial job scheduling are distinct mechanisms.

| Execution service | Capacity protected from other services |
|---|---|
| Interactive API/transactions | User commits, trades, claims/refunds, quote/status and authentication; does not wait for operator fee jobs. |
| Provisioning | Mint lease, immutable media readiness, creation/registration; separate from scheduled funding closes. |
| Lifecycle | Bounded settlement, launch and verification with deadline-aware fair service across campaigns. |
| Recovery | Unknown signatures, restart repair and operator-assisted refund work, including after normal action deadlines. |
| Fee harvest | Active-pool checks and economically justified collections; separate from swap route latency. |
| Burns/distributions/buybacks | Confirmed asset movement, bounded guarded routes, qualified token burns; future strategy versions separately budgeted. |
| Market/activity | Live shared ingestion and candles; historical backfill cannot exhaust live capacity. |
| Vanity generation | Independent CPU resources, encrypted stock and verified mint readiness. |

These services can share one reviewed codebase/image. They require separate execution slots
and RPC/signer admission budgets; a single prioritized queue or unrestricted shared pool is
not sufficient. Shared Postgres job storage is acceptable with lane-filtered transactional
leases and independent consumers. Across campaigns work runs concurrently; conflicting writes
within a campaign/pool are coordinated. No global lock around all coin work.

Extract persistent sessions, drafts, operations and jobs before replicating API processes.
At GREEN the working branch was SQLite/volume based and Postgres was a throwing placeholder.
The 26 September checkpoints below implement shared storage and local recovery evidence;
hosted cutover and runtime replication remain unqualified.
Railway documents that volumes cannot use replicas. Do not clone local signer security state
to fake horizontal scale. Qualify shared replay/spend/fence state and capabilities before any
signer partitioning; preserve all limits and isolate secrets from ordinary workers.

Autoscaling uses oldest due-job age, deadline slack, arrivals/completions, slot occupancy and
upstream headroom. Keep warm minimum capacity, pre-scale before scheduled closes and enforce
cooldowns/cost ceilings. CPU is only one signal. Queue-driven scaling requires a configured
controller; it is not assumed to exist merely because Railway offers resource/replica scaling.

Initial rehearsal topology: two stateless API instances, at least two bounded lifecycle workers,
and independently warm recovery, fee/economic and indexing capacity. Final replica counts,
concurrency and RPC/signing limits come from measured workload, not from this illustrative count.
Cap total database connections across replicas. When saturated, slow/restrict new creation
before accepting setup funding; protect already committed launches and user recovery paths.

Fee UX and scheduling: distinguish accrued → confirmed collected → pending burn/distribution
→ confirmed burned/distributed. Include both token and SOL assets with freshness. Use thresholds,
coalesced checks and jitter; cold coins are polled less frequently without starving them.
Each failed buyback route is isolated. Do not create dust transactions just to show activity.

Proposed qualification targets, not promised chain confirmations: interactive internal queue
p95 < 1 s; due lifecycle job start p95 < 5 s; economical fee-harvest start p95 < 60 s; economical
burn/distribution work start within 5 minutes. Track external wallet and chain wait separately.
Launch settlement completion is additionally measured against the sealed launch deadline with
tested headroom. Show truthful processing/freshness when external services are degraded.

- Postgres transactions/uniqueness plus durable job leases; shared cache/rate limits across API
  instances. One chain-indexing stream per source with fan-out, not one RPC poll per browser.
- Caches and bounded historical queries; cursor-based activity/trade pagination; single-flight
  quote/status requests; backpressure and per-wallet/IP/campaign quotas without blocking recovery.
- Idempotent signer intents persisted before send, bounded capability and exact instruction checks,
  nonces/sequences, expiry and finalized reconciliation. Never regenerate a transaction on timeout
  before checking the original. Secrets only in private runtime/volume; redact logs and headers.
- Private signer network, authenticated service requests, origin restrictions, edge protection,
  server-side upload quotas and verified network/genesis. Admin remains local-only. While gated,
  assets/API paths remain gated too. Public activation is a deliberate switch with no private leaks.
- Mixed-load gate: 100 simultaneous campaign closes with varied realistic receipt counts,
  another 100 fee-active pools, concurrent wallet actions and a separate 1,000+ browsing-client
  test. Include large campaigns, slow buyback routes, crashes and RPC 429s. Measure per-service
  p95/p99 and end-to-end settlement, signer/RPC saturation, fee age, database waits and exact
  accounting. This is a target to test, not a claim already met. No generic 'DDoS-proof' claim.
- Alerts: stale indexer/price, expiry/refund backlog, lease conflicts, signer problems, failed lock,
  unexplained balance delta, reserve-sale finalizer lag, failed burns, budget breach and mint depletion.
- Pause only unsafe new creation/optional strategy actions; preserve claims/refunds and safe
  finalization. Kill switches cannot authorize drains or retroactive economic changes.

## 12. Build order and release gates

The foundation stage is substantial and will be delivered in these reviewable increments,
owned by platform engineering after GREEN:

| Phase | Deliverable | Acceptance / stop condition |
|---|---|---|
| A0 Baseline and contracts | Reconcile actual branch/deployment status, preserve old adapters, dependency/reuse map, migrations and API/state contracts | No ambiguous program identity, undefined economics or secret-bearing fixtures; isolated test environment. |
| A1 Durable shared state | Real async Postgres, shared sessions, uniqueness, jobs/leases, packets, backup/restore | Concurrent replica and restart tests; persist-before-broadcast; unresolved signatures survive deadline and lease changes. |
| A2 Independent runtimes | Separate role services, fair job selection, continuously refilled slots, bounded settlement chunks, RPC/signer budgets | Fee/route outage cannot consume launch/user reserves; no stale runner or cross-campaign financial effect. |
| A3 Complete creation | Durable media, verified quote, ready mint lease, signing, provisioning, registration and resumable wizard | Create with actual external wallets on isolated chain; no double charge/mint lease across crashes; funds and permissions reconciled. |
| A4 Lifecycle and index | Multi-campaign funding/settlement/pool/claims/refunds/vesting, market and fee projections | Exact oversubscription/refund/vesting math, failure exits, evidence-based Live, complete portfolio and no duplicate fee/burn totals. |
| A5 Approved UI and docs | All directory/create/coin/portfolio/creator flows wired to authoritative data | Desktop/mobile and keyboard/touch verification; honest stale/error states; source/IDs/powers and current fee mechanics documented. |
| A6 Scale and security | Mixed 100-close/100-fee-pool workload, adversarial retries, wallet compatibility, abuse controls, independent contract review | Published qualification evidence meets selected limits; unresolved money/custody/security defects block activation. |
| A7 Restricted pilot | New creation visible/usable only to the approved wallet; representative on-chain verification | Source/build/manifest provenance, activity and balances reconcile; monitoring, rollback/recovery and support runbooks exercised. |
| A8 Public readiness | Review evidence, choose public admission limits, exact enabled presets and activation configuration | A separately recorded release decision; no public or mainnet enablement inferred from a GREEN for implementation. |

UI construction can overlap backend phases only against agreed typed/versioned contracts.
Fixtures remain clearly separated from real state and cannot enable money actions. Old live
programs, claims, refunds and keepers stay operational throughout. New Family creation needs
its own qualified distribution/snapshot path before being included in A8.

After the foundation, the remaining mechanism stages are:

| Stage | Deliverable | Must pass before moving on |
|---|---|---|
| 0 | Decision register, complete sealed preset specs, account/capability map, threat model | Unambiguous terms; no unapproved defaults; old/new identity separation |
| 1 | Production public-launch foundation and existing supported presets | Creator provisioning, Postgres, true wallet/validator lifecycle, recovery/load evidence |
| 2 | Fee-preserving LP accounting | Independent conservation/differential tests against exact AMM/locker; no principal paid as fees |
| 3 | New Direct issuer + liquidity controller + compact UI | Atomic launch/recycle/remainder proof, attack tests, independent review and authority plan |
| 4 | First-hour reserve-sale + full post-hour trading vault | Approved supply/trigger semantics; authenticated evidence; deadline/volume/dev-abuse tests |
| 5 | Auto MM strategy evaluation, then optional new-version implementation | Beats simpler baseline on execution quality at bounded risk; no invented PnL/organic-volume claims |
| 6 | Combined-preset validation and public readiness | All-module adversarial/restart tests, no circular triggers/double accounting, full UI/docs/evidence |
| 7 | Controlled launch, then broader creation | Observe reconciled real operation, capacity and exit paths; publish monitoring/support/runbooks |

A stage release includes only COMPLETE activated presets. A later module does not get switched on
inside an already funded old campaign. New mechanisms ship to future launches on their own new
program versions. Basic public launch availability should not depend on an unproven Auto MM strategy.

Go-live evidence per preset: fixed source commit, program IDs/binary hashes, authority status,
review findings resolved, end-to-end signatures and balance reconciliation, load/failure report,
wallet compatibility, public docs and exact activation hash. Internal host tests alone never qualify.

## 13. Execution rules and handover evidence

Use this as a dependency plan, not permission to deploy incomplete code or modify old programs.
Inventory and reuse the current branch components first. Do not copy credentials, private keys,
DB snapshots, private communications or personal files to GitHub. Read the versioning policy and
keep coordination messages explicit about who owns which files. Publish progress as concrete tested
deliverables and distinguish model, mock-RPC, validator and deployed evidence. Reconcile account/layout
assumptions with deployed pinned dependencies before building around them. No retroactive migration,
claim expiry, reserve seizure or silent economic substitution. Keep README/user docs aligned with
actual on-chain behavior, including remaining powers and scanner-visible withdrawal/custody facts.

Record each milestone as not started / implementing / qualified / disabled, with commit, test
environment and evidence. Do not equate mock screens with connected flows, mocks with validator
tests, or local tests with deployed proof. Estimate runtime/cost only after the first representative
benchmark. No hidden requirement to ask permission for routine reversible work after GREEN, but
no unresolved economic decision is invented and no security limit is removed merely to pass load.

Release bundle: exact source/build identifiers, program IDs and authority model, manifest/preset
hashes, migration/restore evidence, wallet and conservation tests, load/error-injection report,
dashboards/alert owners, incident runbooks, verified public README/docs and privacy/secret scan.
Rollback can stop new intake and route to qualified code; it cannot rewind confirmed chain
transactions. Submitted operations and paid claims/refunds remain recoverable during rollback.

References checked:
- https://solana.com/docs/core/programs/program-execution (explicit execution/keeper limits)
- https://github.com/raydium-io/raydium-cp-swap/blob/master/programs/cp-swap/src/states/pool.rs (pool fee/reserve accounting)
- https://github.com/raydium-io/raydium-cp-swap/blob/master/programs/cp-swap/src/instructions/swap_base_input.rs (swap interfaces)
- https://github.com/raydium-io/raydium-clmm (separate concentrated-liquidity venue)
- https://hummingbot.org/strategies/v1-strategies/strategy-configs/inventory-skew/ (MM inventory risk/quotes)

## Implementation checkpoint, 26 September 2026

[A1 shared state and initial A2 scheduling evidence](../evidence/A1-SHARED-STATE-2026-09-26.md)
records delivered code, local verification, configuration and the ultimate-goal scorecard.
[Operator packet recovery evidence](../evidence/A1-OPERATOR-PACKETS-2026-09-26.md)
adds persist-before-broadcast, auxiliary signer recovery and two-replica crash tests.
[Budget and capability evidence](../evidence/A1-BUDGETS-CAPABILITIES-2026-09-26.md)
adds idempotent shared operational accounting and explicit stored program versions.
[Mint lease and preservation evidence](../evidence/A1-MINT-LEASES-2026-09-26.md)
adds cross-store release recovery, stale-reference protection and broader regression results.
[Shared admission evidence](../evidence/A2-ADMISSION-2026-09-26.md) adds independent
upstream reservations, capacity-aware scheduling and shutdown-race recovery.
[Active signing lease evidence](../evidence/A2-SIGNER-LEASES-2026-09-26.md) adds current-grant
and lease checks and closes asynchronous rate/expiry validation races.
[Role and actual-validator evidence](../evidence/A2-ROLES-AND-VALIDATOR-2026-09-26.md) adds
isolated worker/signing composition and successful real-program launch/refund/claim flows
with both SQLite and PostgreSQL.
[Standard fee worker evidence](../evidence/A2-STANDARD-FEE-WORKERS-2026-09-26.md)
adds separate harvest and economic runtimes, restart-safe recurring jobs, dust gates,
and real local swaps followed by collection, sealed payouts and token-side burns.
Provisioning must also qualify funding and bounded repair of recipient token accounts;
a closed recipient account must never block harvesting or burning.
[Bounded signer lookup](../evidence/A2-BOUNDED-SIGNER-LOOKUP-2026-09-26.md)
replaces per-request full capability scans with an indexed, exact-scope newest-grant
lookup while retaining revocation, expiry and active-lease enforcement.
[Shared market worker evidence](../evidence/A2-SHARED-MARKET-WORKERS-2026-09-26.md)
adds separate indexing/backfill roles, atomic PostgreSQL projections and a real local
swap-to-candle check. Finalized-only latency and remaining API/qualification work are explicit.
[Durable creation review](../evidence/A3-DURABLE-CREATION-REVIEW-2026-09-26.md)
adds live setup-cost evidence and atomic quote acceptance across replicas. Acceptance
is not funding; complete provisioning, media, budget custody and wallet flow remain gated.
[Usable vanity-mint evidence](../evidence/A3-USABLE-KIDS-MINT-2026-09-26.md)
proves the reused encrypted inventory can sign after restart and create an actual lowercase
`kids` mint with revoked authorities on the isolated ledger. Hosted inventory and complete
creator-flow qualification are still required.
[Shared market reads](../evidence/A4-SHARED-MARKET-READS-2026-09-26.md)
adds verified shared identities, bounded database-only trade/candle queries, opening
references, cache concurrency controls and explicit freshness/history states. The real
local-chain regression also exercises this reader; live UI cutover remains separate.
A1/A2 are partial; neither hosted production capacity nor operator transaction recovery is
qualified by database tests alone. All unresolved economics and release gates remain in effect.

### 26 September: unused setup custody prerequisite

[Terminal setup return](../evidence/A3-TERMINAL-SETUP-RETURN-2026-09-26.md)
records a separate v3 issuer candidate: inherited v2 economics, pilot-only on-chain
creation and a terminal native setup-SOL return to the sealed creator. This solves
one missing custody primitive without upgrading existing programs. Layout remains
v2; program version/ID must select v3 explicitly. Public presets and funding remain
disabled pending adapter/provisioning/wallet and release qualification. Do not call
consumed costs refundable or equate this prerequisite with complete creation.

### 26 September: versioned workers and creator return flow

[Explicit v3 routing and creator return](../evidence/A3-V3-ROUTING-AND-CREATOR-RETURN-2026-09-26.md)
records schema-13 grant preservation, version-scoped workers/signers, 292 passing
focused tests, a full v3 PostgreSQL/SBF lifecycle and the creator wallet return
subflow. Existing claim cards display the separate setup entitlement on desktop
and mobile. No production activation or complete-creation claim follows from this
checkpoint; durable provisioning, full funding policy and release gates remain.

### 26 September: creation identity and stock preparation

[Creation preparation](../evidence/A3-CREATION-PREPARATION-2026-09-26.md) records
schema-14 durable nonce/campaign allocation, exact inventory bindings across retries,
299 passing regressions and an actual generated `kids` mint signed after inventory
restart from a persisted creation review. API dependency mitigations and the IPFS
image-URI correction are included. A3 remains implementing: metadata/media custody,
complete funding/packet orchestration, wizard integration and release tests remain.

### 26 September: provider liveness and 100-campaign lane isolation

[Freshness and isolation evidence](../evidence/A4-PROVIDER-FRESHNESS-2026-09-26.md)
adds finalized provider-head checks, explicit stale-provider reads and a passing
full v3/PostgreSQL/validator lifecycle. In a separate scheduling fault test, all
100 fee harvests and 100 refunds finish while four launch slots are blocked and
2000 history jobs wait. Synthetic handler speed is not hosted network throughput;
A5's real mixed-load and provider/signing capacity gates remain open.

### 26 September: creator-first mint approval and metadata

[Creator mint evidence](../evidence/A3-CREATOR-MINT-APPROVAL-2026-09-26.md)
records the exact immutable mint/metadata packet, durable PostgreSQL approval before
the reused inventory signer, 318 passing regressions and a real 719-byte finalized
local mint after signer/journal restart. It does not complete the wizard, publish
metadata, create a campaign or enable production. Shared media/plan ownership,
expired-attempt recovery and complete funding/provisioning remain on A3's critical path.

### 26 September: bounded v3 receipt batching

[Receipt batch evidence](../evidence/A2-RECEIPT-BATCHES-2026-09-26.md) records 100
actual localnet commitments, exact pro-rata refunds, atomic failure/replay checks,
measured packet/compute/fee bounds and a full v3/PostgreSQL/remote-signer lifecycle.
Explicit local v3 workers can batch up to eight receipts while preserving separate
settlement/refund/fee lanes; existing workers still default to one. This lowers the
measured base-fee component eightfold at full batches. It is not a mainnet throughput
claim or a decision about minimum commitments or who funds ongoing operations.

### 26 September: mint confirmation and restart recovery

[Mint recovery evidence](../evidence/A3-MINT-RECOVERY-2026-09-26.md) records bounded
reconciliation of stored creator-approved transactions, finalized authority/custody/
metadata verification and an actual local inventory mint recovered after a deliberate
post-broadcast crash. No mint replacement occurs on timeout. A3 still needs owned
media publication, shared plan storage, expired signing-generation recovery and the
complete funding/provisioning/wizard path; this does not activate public launches.

### 26 September: shared publication and immutable signer plans

[Publication and plan evidence](../evidence/A3-PUBLICATION-AND-MINT-PLAN-2026-09-26.md)
records schema-15 owned-content receipts, shared staged quotas, uncertainty-preserving
Pinata recovery and immutable PostgreSQL mint plans. Existing preparation retries
preserve matching signing/consumed plans. Only the original approved packet can be
recovered after expiry; replacement generations remain separate. Private upload
storage/sanitization, draft/review wiring and real provider qualification remain
explicit prerequisites, alongside full funding/provisioning and release gates.

### 26 September: persisted creator wallet offers

[Creator wallet offer evidence](../evidence/A3-CREATOR-WALLET-OFFERS-2026-09-26.md)
records schema-16 unsigned offers, server-owned blockhash/expiry, atomic approval
versus refresh, and idempotent approval retries. Browser-supplied instructions or
expiry cannot alter the sealed mint plan. The 347-test focused suite passes; public
endpoints and funding remain disabled pending full creator-flow qualification.

### 26 September: private owned artwork and publication consent

[Private artwork evidence](../evidence/A3-PRIVATE-ARTWORK-2026-09-26.md) records
schema-17 shared quotas/leases, bounded metadata-free PNG re-encoding, conditional
private S3 storage, authenticated binary upload/preview handlers and v3 review
ownership/consent checks. The 361-test focused suite and production build pass.
Hosted media isolation/provider qualification, creator UI, video, complete funding/
provisioning and real-wallet/release gates remain outstanding. No public activation.

### 26 September: creator artwork interaction qualification

[Creator artwork UI evidence](../evidence/A3-ARTWORK-CREATOR-UI-2026-09-26.md)
records exact PFP/banner cropping, private owned previews, same-request retry,
explicit resettable publication consent and passing desktop/mobile interaction
checks. A3 remains implementing: campaign provisioning, complete creator signing,
video, hosted media/provider qualification and release gates are still open.

### 26 September: atomic creator setup and private registration

[Creator provisioning evidence](../evidence/A3-CREATOR-PROVISIONING-2026-09-26.md)
records schema-18 immutable setup plans, separately quoted authority reserves,
creator-signed native custody preparation and atomic campaign creation/funding.
Actual localnet setup recovered from post-broadcast interruptions; duplicate
creation cannot repeat its reserve transfer. The 378-test suite and build pass.
Private registration is idempotent and grants no spending authority. A3 remains
implementing: protected wallet offers/UI orchestration, delayed-signature recovery,
complete operating funding, profile publication and hosted release gates remain.

26 September 2026 — creator setup wallet boundary:
[Setup wallet evidence](../evidence/A3-CREATOR-SETUP-WALLET-2026-09-26.md)
records schema 19 immutable offers for native custody and campaign creation,
server-owned expiry, atomic refresh/approval races, and optional authenticated
pilot routes protected by startup reconciliation. 385 regression tests and the
production build pass. Confirmed native custody alone cannot authorize campaign
setup; finalized custody is required. Public composition and creation remain off.
The next A3 dependency is explicit recovery for delayed immediate-start signing,
then complete creator progress/resume composition and operational funding.
Compare each change against the ultimate goal: a safe retry boundary is necessary,
but does not yet make the end-to-end launch product ready for public use.

26 September 2026 — explicit creator setup recovery:
[Recovery evidence](../evidence/A3-CREATOR-SETUP-RECOVERY-2026-09-26.md)
records immutable schema 20 revisions, finalized expiry/account checks, old-offer
race protection and fixed scheduled times. A fresh encrypted-inventory mint was
created on localnet; its expired immediate opening recovered into generation 2,
both setup stages recovered process loss, and registration/balance/duplicate-
funding checks passed. 393 regression tests pass. Remaining A3 work includes
native/mint approval expiry, full creator orchestration/UI and operating funding;
public activation and production qualification remain incomplete.

26 September 2026 — native setup retries:
[Native recovery evidence](../evidence/A3-NATIVE-SETUP-RECOVERY-2026-09-26.md)
records independent schema 21 native revisions, terminal outbox closure and fresh
creator approvals after finalized expiry. 395 regression tests pass. Next mint
recovery must reuse the existing asset signer's bounded contiguous retry
capability; it must preserve the reserved key, prior signatures and immutable
mint intent rather than replacing stock or rewriting key storage.

26 September 2026 — bounded mint retries:
[Mint retry evidence](../evidence/A3-MINT-RETRY-RECOVERY-2026-09-26.md)
records schema 22 recovery permissions and reuse of existing encrypted
asset signer. A fresh localnet address survived two finalized expiries and minted
once on the final permitted generation, including post-broadcast crash recovery.
The address, original intent and key storage were preserved. The 403-test suite
and additional wallet retry checks pass. A3 still needs the joined creator UI,
operating funding and activation; this does not satisfy the ultimate public-launch
readiness goal or authorize hosted deployment.

26 September 2026 — joined creator backend:
[Creator flow evidence](../evidence/A3-CREATOR-FLOW-2026-09-26.md) records the private
coordinator and local service composition, authenticated/reconciliation-gated
routes, stable stage-bound offers and 410 passing regression tests. A fresh mint
with accepted review/publication fixtures completed actual local-chain minting
and joined setup, delayed-start recovery, private registration and duplicate-fund
prevention. The build passes. Against the ultimate goal, the backend journey is
now joined, but browser/external-wallet qualification, complete operating funding,
worker activation, hosted providers and release gates remain open. No production
readiness claim or public activation.

### 26 September: browser creator approvals and resume

[Browser creator evidence](../evidence/A3-CREATOR-BROWSER-2026-09-26.md) records the
local wizard quote/resume path, independent browser reconstruction of all three
creator packets, owner-change protection and exact-byte ambiguous submission recovery.
419 regression tests passed; four Chrome viewport checks and real validator setup
approvals through the browser controller passed. Creator journey and custody remain
**partial**, public readiness **not demonstrated**: real extensions, full authenticated
wizard integration, providers/video and complete operating funding remain open.
Next critical dependency is verified campaign-specific operating funding/reservations,
then activation and mixed-workload qualification. Existing coins are unchanged.

### 26 September: operating funding proofs and concurrent holds

[Operating accounting evidence](../evidence/A3-OPERATING-ACCOUNTING-2026-09-26.md)
records schema 23, chain-bound funding receipts, durable exact-message exposure,
PostgreSQL concurrency and an actual local-validator fee reconciliation. Unknown
transactions keep their holds; generic spending/returns cannot consume reserved
funds. The 430-test regression passed. The ultimate goal remains **partial**:
only fee-only settlement is qualified, and nested CPI rent must be accounted for
before signer/worker activation. Hosted funding policy and all release gates
remain open. No old funded programs or public deployment were changed.

### 26 September: nested launch-cost ceiling

[CPI cost evidence](../evidence/A3-CPI-COST-EXPOSURE-2026-09-26.md) records the v3
signer's live rent ceiling for lock and fee-state creation, combined rent limits
and refusal on expired evidence before signing. All 437 regression tests passed.
Legacy signing behavior is preserved. Actual rent settlement and campaign budget
coupling remain the next operating-safety dependencies; no public activation.

### 26 September: finalized fee-state rent settlement

[Rent settlement evidence](../evidence/A3-OPERATING-RENT-SETTLEMENT-2026-09-26.md)
records exact instruction/cost attribution and actual local-chain rent settlement
with duplicate charging prevented and unused exposure released. All 443 regression
tests pass. V3 ATA cost admission now refuses unqualified extension accounts.
Full lock-cost settlement and signer budget coupling still await qualification;
the authenticated creator journey can progress independently. Ultimate goal remains
partial, existing programs unchanged, hosted/public activation disabled.

### 26 September: authenticated creator HTTP composition

[Authenticated creator evidence](../evidence/A3-CREATOR-HTTP-2026-09-26.md)
records signed sessions, private artwork, exact server quotes and restart-safe
acceptance, with the treasury pinned through setup. The full bounded-concurrency
regression passes 444 tests. Full signed browser-to-chain qualification now passes
with three independent approvals, restart/resume and finalized private registration.
Four completion viewport overflow checks pass. External wallets, full-site visual
QA, hosted publication and complete operating funding remain open.
The ultimate goal remains partial, and production/public activation stays closed.

### 26 September: finalized lock-account cost settlement

[Lock settlement evidence](../evidence/A3-LOCK-COST-SETTLEMENT-2026-09-26.md)
records a real local v3/Raydium launch: exact keeper rent/fees, unused metadata
allowance released, participant refund liability preserved and all launch custody
checks passed. The bounded regression passes 448 tests. Signer budget coupling,
hosted operating funding policy and remaining release qualification are still open;
the ultimate goal remains partial, with existing funded programs unchanged.

### 26 September: campaign-funded signature boundary

[Funded signer evidence](../evidence/A3-FUNDED-SIGNER-2026-09-26.md) records mandatory
budget composition for new v3 registry signers, durable signature evidence before
response, unknown/expiry recovery and schema 24 message uniqueness. A real local
HTTP signer refused unfunded signing, survived interruption after signing, resumed
the same packet and charged once. Main regression: 454 passing tests; legacy signer
checks: 34 passing; subsequent focused storage-failure/uniqueness checks: 13 passing
(overlapping counts). The ultimate goal remains partial: hosted funding policy,
complete worker cost templates/reconciliation, activation, external wallets/providers
and mixed-workload/release qualification remain open. Existing coins are unchanged.

### 27 September: automatic operating-cost reconciliation

[Accounting worker evidence](../evidence/A3-OPERATING-RECONCILIATION-2026-09-27.md) records atomic hold/job creation, a signer-free worker with independent RPC capacity, 100-campaign PostgreSQL qualification and actual local-validator settlement across a worker restart. The funding proof and signed packet remain authoritative; unknown evidence never releases a hold. Verifiable money and concurrent operation remain **partial**. Trusted cost/provisioning composition and a complete operating-funding policy are the next dependencies; public activation stays off.

### 27 September: exact Standard cost templates and fee provisioning

[Standard fee setup evidence](../evidence/A3-STANDARD-FEE-SETUP-2026-09-27.md) records chain-derived exact worker cost templates, narrowly scoped v3 setup grants, atomic canonical fee-account creation, independent provisioning execution and finalized custody verification. A complete actual-chain rehearsal passed with durable signing interruption/recovery, automatic accounting after restart and existing-account rent excluded. It also exposed and fixed a confirmed/finalized context mismatch.

The current implementation improves verifiable money, sustainable fees and concurrent operation to **partial**; it does not complete public readiness. The next critical path is the explicit ongoing-cost policy and durable activation coordinator, then recipient-account recovery and the hosted wallet/provider, mixed-load, restore and security release gates. The economic choice presented is creator-paid quoted setup with KIDS-funded ongoing operations versus a separately disclosed creator operating reserve. No answer has been assumed, and participant terms remain unchanged.

Final bounded regression: **504 passed, 0 failed, 0 skipped** (including legacy signer checks). The local scripts and worker processes completed and shut down; no hosted deployment or push occurred.

### 27 September: funded activation and recoverable fee operation

[Activation evidence](../evidence/A3-FEE-ACTIVATION-2026-09-27.md) records schema 25 and an explicit local v3 coordinator. Fresh finalized custody, exact setup authority, immutable terms and available operating reserves precede one atomic grant/evidence/three-queue transition. Restart cannot duplicate it; revocation and expiry cannot resurrect it. Refund rights survive activation. Missing recipient accounts defer payouts without sponsoring repeated rent, and the exact v3 funding-shortfall response retains jobs without exhausting retries.

The full bounded regression passes **512 tests, 0 failures, 0 skipped**. Two provisioning replicas activated 100 PostgreSQL fixtures without consuming lifecycle or fee worker slots. A fresh owned-validator launch completed setup/signature recovery/accounting/activation, ran all three independent fee workers without dust sends, then returned the participant's full 1 SOL excess through the recovery worker. The additional refund network fee reconciled independently from principal.

Against the ultimate goal, verifiable money, sustainable fee operation, concurrency and recovery remain **partial**, with these concrete improvements. The ordinary creator journey still needs its reviewed operating-funding/bootstrap composition and management/repair UI; hosted wallets/providers, representative mixed-load/restore testing and the security/release bundle remain open. Creator-paid setup with KIDS-funded ongoing operations remains the working proposal, not an approved charging policy. Existing programs and funded coins are unchanged; no hosted deployment or push occurred.

### 27 September: joined lifecycle and creator recovery

[Joined lifecycle evidence](../evidence/A3-JOINED-LIFECYCLE-2026-09-27.md) records
schema 26, the restart-safe controller, independent settlement/launch/refund/setup
lanes, finalized current-custody verification and exact recipient-funded payout
repair. A fresh actual local-chain launch completed the automatic lifecycle and
fee activation across a controller restart. Verification also passed after claims,
a burn and a trade. All **527 regression tests** and the build pass; creator
management interactions and four responsive viewport checks pass.

The affected ultimate-goal dimensions remain **partial**. An explicit funded
creator bootstrap, hosted media and wallets, representative mixed-chain capacity,
restore/monitoring and security release evidence remain. Local operating fixtures
are not an approved public charging policy. Public activation remains disabled;
existing funded coins and programs are unchanged.

### 27 September: private queue, funding and authority observations

[Worker observation evidence](../evidence/A3-WORKER-OBSERVATION-2026-09-27.md)
records schema 27, a read-only aggregate collector command and five additional
PostgreSQL tests, including concurrent operation across 100 synthetic campaigns.
The full bounded regression and database restore drill pass **532 tests** without
failures or skips. Monitoring cannot spend quota, mutate work or expose private
packets. Concurrency and operating readiness remain **partial**: service liveness,
collector deployment and representative mixed-chain/release gates are not inferred
from database observations. Existing financial programs remain unchanged.

### 27 September: durable signer restart verification

[Signer recovery evidence](../evidence/A3-SIGNER-RESTORE-2026-09-27.md) records
startup refusal for mismatched journal/database history and durable flushing
before every v3 signature, including retries after storage failure. All **537
tests pass without skips**. A fresh actual-chain lifecycle passed controller
and signer restart, refund/setup/activation, claims, burn and trade verification.
Against the ultimate goal, recovery improves but remains **partial**: coordinated
restore, hosted single-writer ownership, complete creator funding, market/UI,
mixed-load and release/security gates remain. No public or hosted activation.

### 27 September: scoped live chart, trades and verified history

[Market evidence](../evidence/A3-SCOPED-MARKET-2026-09-27.md) records the new
private Standard live page's authenticated shared market projection, compact
paginated trades, exact values, stale-data handling and mobile shortcuts. Initial
history requires verified pool initialization; continuous quiet periods tolerate
an old pruned transaction cursor without accepting missing observation history.
A fresh actual-chain lifecycle through signer restart, claims, burn and buy
produced its verified market candle. **551 tests pass**, along with the build and
browser interactions at four viewport sizes.

Against the ultimate goal, clear money/action visibility and recovery improve
but remain **partial**. User-signed per-campaign trading, activity/fee projections,
explicit operating funding, hosted wallets/providers, mixed-load and coordinated
restore/security release gates remain. Existing funded programs are unchanged;
this evidence does not enable public launches or assert production readiness.

### 27 September: enforced signer process ownership

[Signer ownership evidence](../evidence/A3-SIGNER-OWNERSHIP-2026-09-27.md)
records schema 28, exclusive scoped database time leases, monotonic signing
windows, terminal refusal after lost renewal and graceful drain/release. The
bounded regression passes **558 tests**; a fresh actual local-chain lifecycle
passes signer replacement, subsequent refunds/claims/fees/trade and chart indexing.

Against the ultimate goal, recoverable operation improves but remains **partial**.
Hosted single-volume deployment, bounded database clock/failover assumptions,
coordinated restore, wallet trade UI and the existing economic/capacity/security
release gates still apply. This does not permit unfenced replicas of the key or
public activation, and does not modify older financial programs.

### 27 September: wallet-signed live trading and reload recovery

[Wallet trading evidence](../evidence/A4-WALLET-TRADING-2026-09-27.md)
records the reused CPMM primitives, scoped shared quotes/packets, browser approval,
saved-packet resume, financial pause, bounded RPC transport and corrected finality
reconciliation. Both buy and sell finalized on the owned local chain; browser
checks cover reload recovery, editable slippage and four viewport widths.

Participant clarity and verifiable recovery improve to **partial** against the
ultimate goal. Activity/fee projections, complete portfolio coverage and funded
creator activation remain next, followed by hosted wallets/providers, mixed-load,
restore and security qualification. These checks do not activate public money
routes or resolve the pending ongoing-cost policy.

### 2026-09-27 checkpoint: A5 finalized fee visibility

Implemented scoped cumulative fee reads and the compact coin-page fees/burns panel, with exact pending/paid/burned/dust reconciliation. Current counters have a dedicated read job so chart recovery cannot block them; financial queues remain separate. Evidence: `deployment/evidence/A5-FEE-READS-2026-09-27.md`. Full regression 583/583 passed. No hosted/public activation or changed economics. Next: program activity and wallet coverage before representative fleet/rollout qualification. Against the ultimate goal of understandable money movements and bounded shared infrastructure, this checkpoint meets the fee-read portion only.

### 2026-09-27 checkpoint: A6 program activity

Added version-specific Standard v3 program activity: exact executed transfers/burns, conservative batch-refund attribution, no zero-movement clutter by default, failed/all-event filters and eight-row paging. Shared finalized storage and independent read/backfill jobs preserve financial-lane isolation. Evidence: `deployment/evidence/A6-PROGRAM-ACTIVITY-2026-09-27.md`; 596/596 regression tests passed. Local retained-history limits remain explicit; archive-backed lifecycle qualification is still required. Against the ultimate goal, this closes the activity surface and persistence portion, not rollout/capacity gates. Next: wallet and directory pagination/coverage, then joined fleet and hosted qualification.

### 2026-09-27 checkpoint: A7 bounded directory and wallet coverage

[Coverage evidence](../evidence/A7-DIRECTORY-WALLET-COVERAGE-2026-09-27.md) records 20-row keyset navigation, registry-side creator/search filtering, no silent wallet truncation, scoped cancellation and explicit portfolio coverage. Regression: 602/602; enabled build and four-width browser checks pass. Against the ultimate goal, user access to older positions improves; automatic indexed portfolio discovery and global sorting remain partial, alongside funding, fleet and hosted release gates. No existing funded program or public activation changed.

### 2026-09-27 checkpoint: A8 shared portfolio discovery

[Portfolio evidence](../evidence/A8-PORTFOLIO-DISCOVERY-2026-09-27.md) records finalized receipt discovery independent of website history, immutable/fenced shared membership, authenticated owner paging and explicit coverage boundaries. Full regression: 614/614; enabled build, four-width browser checks and actual local receipt/restart qualification pass. Against the ultimate goal, participant discovery improves but remains partial: arbitrary offsite holdings, global ordering, creator operating funding, mixed-chain capacity and hosted release gates remain. No financial activation or existing-program changes.

### 2026-09-27 checkpoint: A9 global directory ordering

[Ordering evidence](../evidence/A9-GLOBAL-DIRECTORY-ORDER-2026-09-27.md) records registry-side ordering with bounded keyset pages, indexed deadline/name scans and sort-bound cursors. Regression 616/616, enabled build and four-width browser checks pass. Against the ultimate goal, discovery improves but remains partial: current shared phase/commitment projection must be composed into the creator directory next; operating funding, hosted and release gates remain. No public activation.

### 2026-09-27 checkpoint: A10 shared current launch status

[Current-view evidence](../evidence/A10-SHARED-CAMPAIGN-VIEW-2026-09-27.md) records a shared finalized campaign projection and atomic phase-filter updates for the ordinary creator directory. Regression 620/620, enabled build and actual local-chain → database → HTTP/restart verification pass. Against the ultimate goal, current funding/status discovery improves; creator profile/media, funding composition, wallet/fleet and hosted release gates remain. Public activation remains off.

### 2026-09-27 checkpoint: full fresh activity lifecycle

The additional [A6 evidence](../evidence/A6-PROGRAM-ACTIVITY-2026-09-27.md) now includes a fresh actual-chain joined launch, restart, refund, setup return, participant/dev claims, burn and buy with 11 finalized activity events and exact reconciled amounts. The local retention fault was fixed in validator configuration, not bypassed in readers. Against the ultimate goal, full local money-history verification improves; hosted retention, funding/fleet and release gates remain partial and public activation remains off.

### 2026-09-27 checkpoint: A11 creator profile publication

[Profile evidence](../evidence/A11-CREATOR-PROFILE-2026-09-27.md) records resumable image/banner publication and immutable creator-approved display profiles. All 623 tests, enabled build and four-width browser checks pass. A fresh actual local-chain creator rehearsal used a generated `kids` mint, resumed after restart and finalized its profile and registration. Against the ultimate goal, creator identity improves; video, explicit operating funding, hosted wallet/provider, mixed-chain load and release gates remain partial. The [history scan](../evidence/REPOSITORY-HISTORY-SCAN-2026-09-27.md) classified 13 findings without identifying a usable secret; this is not a universal security guarantee. Public financial activation remains off.

### 2026-09-27 checkpoint: A12 durable creator video

[Video evidence](../evidence/A12-CREATOR-VIDEO-2026-09-27.md) records private upload/processing, bounded memory admission, retry-safe publication and approved 16:9 playback. All 635 tests, enabled build and four-width browser checks pass. A fresh actual-chain creator rehearsal registered its approved video after restart; external publication receipts remained synthetic. Against the ultimate goal, media improves but hosted decoder isolation/provider qualification, explicit operating funding, representative chain load, liveness/restore and release gates remain. No public financial activation or old-program changes.

### 2026-09-27 checkpoint: A13 worker presence

[Presence evidence](../evidence/A13-WORKER-PRESENCE-2026-09-27.md) records scoped boot heartbeats, exact role/class expectations and independent missing/stalled/slow-work alerts. All 641 regression tests pass, including 100 concurrent process identities and service start/drain. Against the ultimate goal, observability improves to partial; hosted monitoring, operating funding, representative mixed-chain capacity and restore/release qualification remain. No public activation or old-program changes.

### 2026-09-27 checkpoint: A14 creator operations

[Creator operations evidence](../evidence/A14-CREATOR-OPERATIONS-2026-09-27.md) records owner-scoped reserve/held/spent visibility and distinct background-operation states, with no financial mutation. All 644 regression tests, enabled build and four-width browser checks pass. [A13](../evidence/A13-WORKER-PRESENCE-2026-09-27.md) also passed a fresh full local-chain lifecycle after signer/controller restart. Against the ultimate goal, creator management and recoverability improve; funding policy, representative mixed-chain load and hosted/release gates remain partial. No public activation.

### 2026-09-27 checkpoint: A15 database lease clock

[Lease clock evidence](../evidence/A15-DATABASE-LEASE-CLOCK-2026-09-27.md) closes a worker/signer clock inconsistency: job custody now uses PostgreSQL time, row-lock waits cannot publish after expiry, and runner retry/deadline timing uses a monotonic database baseline. Regression 649/649 passes. Against the ultimate goal, reliable concurrent execution improves; representative mixed-chain load, database failover/restore, operating funding and hosted release qualification remain partial. No public activation or funded-program changes.

### 2026-09-27 checkpoint: A16 canonical 2.5% lifecycle

[2.5% evidence](../evidence/A16-CANONICAL-250BPS-REHEARSAL-2026-09-27.md) records a separate ledger and actual launch, refunds, claims, trade, candle and activity verification against the canonical tier-7 configuration. The old 2% rehearsal and funded programs remain untouched. Against the ultimate goal, new-preset integration improves; multi-process fleet/mixed-load, hosted providers, operating funding and release gates remain partial. No public activation.

### 2026-09-27 checkpoint: A17 bounded finality

[Finality evidence](../evidence/A17-BOUNDED-FINALITY-2026-09-27.md) records strict recovery finality and bounded v3 confirmation occupancy while retaining exact unresolved packets. Regression 660/660 passes. Against the ultimate goal, financial correctness and independent worker capacity improve; actual fleet/mixed-load and hosted release gates remain incomplete. No public activation or funded-program changes.

### 2026-09-27 checkpoint: A18 fleet recovery and HTTP load

[Fleet evidence](../evidence/A18-FLEET-RECOVERY-2026-09-27.md) records 100 actual launches, 800 verified receipts, exact 100 SOL accepted/refunded, zero remaining holds, and 3,000 successful pooled HTTP reads without visitor RPC fan-out. The recovery run missed lifecycle start latency and began after closing, so simultaneous-close/mixed capacity is still unqualified. Against the ultimate goal, reliability and read scaling improve, with journal completion, fresh mixed-load and hosted release work next. No public activation.

### 2026-09-27 checkpoint: A19 terminal transaction journals

[Journal evidence](../evidence/A19-TERMINAL-JOURNALS-2026-09-27.md) records exact packet-bound recovery and proof-bound budget journal completion. All 674 regression tests and a fresh two-campaign actual-chain smoke pass, with all receipts/locks verified and no unresolved signed rows or operating holds. Against the ultimate goal, financial recovery observability improves; mixed-load and hosted release gates remain open. No public activation.

### 2026-09-27 checkpoint: A20 restore integrity

[Restore evidence](../evidence/A20-RESTORE-INTEGRITY-2026-09-27.md) records a complete 61-table disposable restoration and stricter signed-approval/hourly-charge coverage after terminal reconciliation. All 676 regression tests pass. Against the ultimate goal, recovery improves to partial; externally anchored provenance, hosted PITR/failover, mixed load and public release remain unqualified. No public activation.

### 2026-09-27 checkpoint: A21 bounded scaling decisions

[Scaling evidence](../evidence/A21-SCALING-DECISIONS-2026-09-27.md) records measured worker slot durations and private, bounded scale advice that preserves independent minima and refuses growth against exhausted upstreams. Relevant observer/presence/scaling and runner tests pass. Against the ultimate goal, demand scaling improves to partial; provider actuation, pre-scaling, intake and hosted quota qualification remain open. No deployment changes or public activation.

### 2026-09-27 checkpoint: A22 mixed recovery and signer RPC

[Mixed recovery evidence](../evidence/A22-MIXED-RECOVERY-2026-09-27.md) records 100 new launches/800 receipts alongside 200 finalized trades on 100 existing pools, exact refunds/locks, zero outstanding operating holds, and correctly retained dust. Congestion now covers signer evidence reads through an independent shared budget. All 687 regression tests pass. Concurrent pooled read p95 remained below one second, but interruptions prevent a fresh-close capacity claim. Against the ultimate goal, correctness and upstream isolation improve; a fresh mixed run and the operating-funding/hosted/release gates remain open. No public activation or existing-program changes.

### 2026-09-27 checkpoint: A23 advance capacity

[Advance-capacity evidence](../evidence/A23-ADVANCE-CAPACITY-2026-09-27.md) records per-lane resource observations, the independent signer evidence budget and bounded prewarming from scheduled work. All 23 relevant PostgreSQL/observer/presence/scaling checks pass. Against the ultimate goal, capacity planning improves; hosted provider actuation, startup qualification and public release gates remain open. Scale advice cannot grant authority or change deployed replicas.

### 2026-09-27 checkpoint: A24 bounded directory coalescing

[Directory-load evidence](../evidence/A24-DIRECTORY-LOAD-2026-09-27.md) records a measured 300-coin cache-thrashing failure and its correction: shared reads fell from 18,580 to 580; 3,000/3,000 concurrent requests passed with p95 815–817 ms during real financial work. Twelve route tests pass, including redacted driver failures and update-aware caches. Against the ultimate goal, scalable discovery improves; financial lane latency and hosted release qualification remain separate gates. No public activation.

### 2026-09-27 checkpoint: A25 reconciliation integrity

[Recovery evidence](../evidence/A25-RECONCILIATION-RECOVERY-2026-09-27.md) records two real mixed-load faults and their fixes: exact-attempt reconciliation and separate transient retry accounting. Missing-history expiry now requires retained blockhash context across operators and creator setup. All 704 regression tests pass. Against the ultimate goal, financial recovery improves; the failed large fixture, closing-window latency, hosted composition and release gates remain incomplete. No public activation or existing on-chain program changes.

### 2026-09-27 checkpoint: A26 audited recovery

[Audited recovery evidence](../evidence/A26-AUDITED-RECOVERY-2026-09-27.md) records successful completion of the retained 100-launch/800-receipt mixed fixture, using an immutable recovery audit and verified durable funding evidence. No packets or failed history were deleted. New reporting isolates closing-window latency and the next local profile reserves additional independent launch/refund processes. Against the ultimate goal, recovery improves; the uninterrupted capacity and hosted/release gates still require evidence. No public activation.

### 2026-09-27 checkpoint: isolated scaling demand

[A28 evidence](../evidence/A28-ISOLATED-SCALE-DEMAND-2026-09-27.md) isolates healthy due/scheduled demand from abandoned or unfunded campaigns while retaining all authority and budget checks. All 716 regression tests pass. Against the ultimate goal, concurrent operation improves; provider actuation, measured mixed-load latency and hosted release remain open. Schema-38 restoration also passed the expanded 62-table integrity check, without claiming external backup provenance.

### 2026-09-27 checkpoint: signer spend capacity

[A30 evidence](../evidence/A30-SIGNER-SPEND-CAPACITY-2026-09-27.md) distinguishes the retained rolling-hour spending ceiling from RPC/request congestion, preserves the hard refusal and prevents replica growth from obscuring it. All 724 regression checks pass. Against the ultimate goal, operational clarity improves; capacity admission, hosted composition and release gates remain incomplete. Latest legacy main was merged and tested without deploying or changing funded programs.

### 2026-09-27 checkpoint: A31 environment clock, expired-window refunds and grant lifetimes

[A31 evidence](../evidence/A31-EXPIRED-WINDOW-REFUNDS-2026-09-27.md) records that the signer-balanced-360 run failed for an environment reason (a validator clock lagging wall time by about two hours on a host running four validators) and retains it as such; the fleet harness now guards the chain clock, follows the observed chain rate and classifies failures. The same 100-campaign cohort was then qualified through the supported failure path: launch window elapsed on chain, 200 SOL refunded in full, 800 receipts verified, no outstanding packets or holds, 92 campaigns refunded within a minute of worker start. That exposed and fixed a real defect: one-hour keeper grants expired before the cohort's own launch window, leaving refunds unpayable. Scheduling now requires grants that outlive the window plus a refund allowance, a refund-only continuation grant delivers refunds after an expired window without resuming launches, and a signer that serves no current grant pauses jobs instead of failing them permanently. Full regression 732 passed. The branch is published (draft PR 11) with CI green. Against the ultimate goal, recovery and reliable concurrent operation improve; fresh close capacity, hosted composition, fee-grant renewal for long-lived pools, the operating-funding policy and public release gates remain open. No public activation or funded-program change.

### 2026-09-27 checkpoint: A32 fresh close capacity

[A32 evidence](../evidence/A32-FRESH-CLOSE-CAPACITY-2026-09-27.md) records the first complete fresh-close run of the signer-balanced profile: workers up before the chain deadline, 100 launches, 100 exact excess refunds, 100 fee activations, 100 background pools traded and drained, zero holds and zero outstanding packets, 948 s wall time. From the observed close, lifecycle control (p95 4.2 s) and settlement (p95 3.3 s) meet the 5-second target, launch misses it (p95 7.1 s) and refunds are marginal (p95 5.4 s); fee harvest, distribution and burn starts meet their targets. A hosted composition foundation landed the same day: a verified release manifest and a hosted worker mode with strict endpoint rules. Against the ultimate goal, concurrent operation is measured for the first time on a fresh close; the admission limit for the pilot is proposed at 50 simultaneous closes per two minutes pending hosted measurements; hosted composition, the operating-funding policy, real-wallet checks, independent review and release gates remain open. No public activation or funded-program change.

### 2026-09-27 checkpoint: A33 refunds for a never-scheduled cohort

[A33 evidence](../evidence/A33-UNSCHEDULED-COHORT-REFUNDS-2026-09-27.md) records the refund of the cohort that the A31 scheduling rule had refused (100 campaigns, 200 SOL returned in 64 s, receipts verified, nothing held) through the operator action for a campaign without a lifecycle row: a fresh initial keeper grant sized by the lifetime rule, then scheduling. The fleet harness now separates that case from the refund-only continuation. Open: an alert for a funded campaign that has no lifecycle row.

### 2026-09-27 checkpoint: Standard economics sealed and the first-commitment minimum enforced

The owner's decision of 27 September 2026 (47.5 % participants, 47.5 % liquidity, 5 % dev with 1.5 % at launch and 3.5 % linear over three UTC calendar months; presets 50 to 100 SOL and 100 to 250 SOL; two-hour windows; operating funding option 1) is sealed as split policy 3 with vesting rule 2 in the program (the version-3 issuer refuses any other Standard economics at creation), in the JS policy and test vectors, in the creation sealing, in the browser's independent packet reconstruction and in the presets manifest (`public-presets-v2`, hash `9fc890d1b3dbea55b98a3b8d43dbb0ea1c98b6c6eee1f45d26e208e19900b338` (after the pilot preset; before it `5a208e42a176ad16d782432b80b128bbac591364152cc929498211d4f2afc60f`) after the operating block, still proposed until the release record). The minimum first commitment of 0.05 SOL is enforced by the API at commit preparation for the version-3 issuer (a top-up on an existing receipt is not limited) and shown in the commit form from the served manifest. The rehearsal ledgers (creator 19199 and scale 19499) run the rebuilt program, verified byte for byte against the build. Not done: the option 1 code path (creator operating reserve at creation, self-funding credit from the coin's treasury share).

### 2026-09-27 checkpoint: creator operating reserve (option 1, first part)

The sealed operating numbers (reserve 0.1 SOL, floor 0.02 SOL, refill 10 % of each treasury payout, unused reserve returned on refunds) live in the presets manifest under `agreed.operating` and are carried into every quote's terms. The creator flow gains one explicit approval after registration, `operating-reserve`: the server offers a transfer from the creator to the keeper payer with a memo bound to the campaign, journaled in the durable operator-packet journal (one identity per campaign, payer and policy; a stale offer is superseded, an expired signed packet needs explicit recovery); the browser reconstructs the transfer byte for byte from the accepted quote (`creator-signing.mjs`); the campaign's operating budget is credited only when the finalized transaction's balances reconcile, through the same operating ledger and proof reader the keepers use. Tests: PostgreSQL journal and ledger (`operating-reserve.test.mjs`), flow, controller and browser signing suites, site builds; [A34 evidence](../evidence/A34-CREATOR-OPERATING-RESERVE-2026-09-27.md) records the full creator rehearsal on the isolated ledger with the fourth approval (0.1 SOL to the payer, budget reserved 0.1 SOL). Not done: the refill from the treasury fee share, the return of unused reserve after refunds, and the hosted composition of the creator flow (the payer there is the release manifest's signer public key).

### 2026-09-27 checkpoint: return of unused operating reserve (option 1, third part)

A failed launch gives the creator back the unused reserve. The lifecycle's `refunded` stage queues an `operating-return` job for the recovery lane. The job waits, never fails, until the lifecycle row says refunded, the chain shows a fully refunded failed campaign, every operating hold has settled and an operator has issued an `operating-return` capability naming the sealed creator; then it sends one keeper-signed transfer of the available budget minus the network fee, with a memo bound to the campaign. The signer accepts such a transfer only under that capability kind (exactly one transfer to the one recipient plus one memo; keeper grants still cannot move SOL to anyone), and its cost reader re-checks the campaign state and the sealed creator on chain before the operating budget holds the amount. The accounting lane proves the finalized balances and records fee spent plus amount returned, so the budget ends at zero. Tests: signer capability and cost-reader suites, cost model, ledger, the handler on PostgreSQL, lifecycle. The fleet harness issues the grants after refunds and verifies the creator's balance rises by exactly the recorded returns: [A35 evidence](../evidence/A35-OPERATING-RESERVE-RETURNS-2026-09-27.md), 100 campaigns, 7.999 SOL back to the creator, every budget at zero, 265 s.

### 2026-09-27 checkpoint: refill from the coin's own fee share (option 1, second part)

Accounting only, by design: the treasury share of every payout lands in the treasury's wrapped-SOL account while the keeper payer is a separate signer, so the money moves only when the treasury's owner signs. From fee activation on, the accounting lane's `operating-refill` job reads each campaign's finalized fee-state counters and records 10 % of the treasury payout growth as due, capped so that available plus due never exceeds the 0.02 SOL floor; a counter that moves backwards fails the job permanently instead of guessing. The operator tool `localnet/operating-refill-funding.mjs` freezes all due entitlements of a payer into one funding (fresh nonce, exact memo), prints the transfer to send, and credits every campaign's budget once from the finalized transaction after proving its shape and balances; a funding that will not be paid is voided and its entitlements become due again. Registry schema 39 adds the two tables. Tests: entitlement rule, accounting job, prepare, credit, void, on PostgreSQL. Decided the same evening (owner, 21:50 UTC): the owner signs the prepared refill transfer; no treasury key on a server.

### 2026-09-27 checkpoint: reserve visibility, early funding alerts, hosted signer entry point

Owner order of 27 September, late evening: keep the manual treasury-signed refill for the private pilot; show the actual available reserve apart from pending refills and alert before funds become insufficient; then the hosted signer and creator flow. Done in this checkpoint: the creator's launch-operations panel shows available now, held, spent, the sealed floor, pending refills (of which prepared for the treasury transfer) and refilled so far, and reports `funding-low` as soon as available drops under the floor while work still runs; the worker observer defaults its low-reserve threshold to the same floor and raises `unscheduled-funded-campaign` when a funded version-3 campaign has no lifecycle row after ten minutes. The hosted version-3 signer entry point (`localnet/signer/main.mjs`, role `signer-v3` in the production supervisor, worker role `worker`) composes only from a complete environment, a verified release and the matching key, with the registry-backed funding-packet loader and the standard cost reader; tested on PostgreSQL. Next: the hosted creator flow composition.

### 2026-09-27 checkpoint: hosted creator flow and pilot tooling

The creator services accept a verified hosted release beside the localnet rehearsal through one scope rule (`localnet/creation/scope.mjs`); the hosted composition (`interaction-review/server/hosted-creator-services.mjs`, `KIDS_CREATOR_FLOW=hosted`) runs the same flow over the provider RPC with the release manifest's signer as the operating payer, the mint inventory and a private media store on the API volume, Pinata for publication, and the wallet routes enabled behind the pilot wallet. `localnet/hosted/make-release.mjs` writes the release manifest and every service config from the deployed program; `localnet/operator-lifecycle.mjs` gives the operator the keeper grant, scheduling, refund continuation and return grant with a status read; the production supervisor gains the `signer-v3`, `worker` and `indexer` roles. The owner's runbook is `deployment/hosted/PILOT-RUNBOOK.md`. Tested on PostgreSQL; nothing deployed.

