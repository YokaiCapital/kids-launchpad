# KIDS multi-launch product design proposal

Status: proposed, not a claim that the redesign is implemented. The private public-launch pilot is the next delivery; future liquidity recycling and coin trading-reserve modes remain disabled. Existing Family launches stay intact.

## Direction

Move from a single-coin landing page to a launch directory. Keep the KIDS wordmark and mascot as the platform identity; each coin owns its artwork. Give someone three obvious jobs: find a launch, manage their position, create a coin. A new visitor should understand the stage, money involved and next action without opening a tooltip.

Retain the current tokens: dark plum #130D1B; pink #FF77CE for primary actions; grape #A88AFF for secondary highlights; ice #8CECFF for selection and useful status; foreground #FFF4FC; muted #B9A9C6; borders #43304F. Use quiet surfaces and one action color per row. Market gains/losses require signs and labels as well as color. Avoid decorative gradients, blinking counters and multiple glowing panel borders.

## Directory interaction requirements

Use consistent patterns for cursor paging, retained page/filter state, explicit loading and retry, row/card choice, identity links, safe artwork handling and market timestamps. Extend the existing KIDS explorer stack.

KIDS already has ExploreFilters, CoinListRow, CapMeter, ExactAmount, DataFreshness, wallet discovery, campaign normalization and transaction recovery. Extend these. Finalized-coin cards are not suitable unchanged for open raises: KIDS needs deadlines, oversubscription, claims and refunds. Avoid presenting cached metrics as live.

## Desktop directory

Header: KIDS logo | Explore | Your activity | Guide | Launch a coin | wallet.

During the pilot, new navigation exists only after the server grants the signed-in wallet pilot access. Other users retain the existing site. The pilot label is visible only to the allowed wallet. Do not put the wallet allowlist into browser code.

A compact introduction, at most about 100–120 px high, says “Find your next coin.” One short explanation and Launch a coin action; no giant mascot hero above the directory. The origin story moves to Guide and a small first-launch feature.

Below it:
- Search by name, ticker, mint or campaign address.
- Stage tabs: Raising, Live, Upcoming; All and Ended available as filters.
- Type filter: All / Standard / Family. Family rows show the two parent icons inline. Standard rows do not reserve an empty parent row.
- Stage-specific sort with an explicit basis: closing soon / newest opening / recently launched / 24h volume when reliable market data exists. Do not label something “trending” without a defined, abuse-tested ranking.
- Rows as the default for scanning many launches; an optional art-card view using the same data and controls. Persist preference locally. Do not run separate data requests for each layout.

Use the width: fluid directory with a roughly 1600 px maximum, 24–32 px desktop gutters, 80–96 px rows, sticky column headings. Each row has one primary navigation target; copy and watch buttons remain independent. Do not make nested buttons trigger navigation.

### Raising row

Approved row revision, 25 September 2026:

56 px coin image; name/ticker; Standard or parent pair; progress toward the MINIMUM; unique participant wallets; stage and countdown; View launch. Replace the repeated Allocation column with Participants. Count distinct on-chain receipt owners with accepted successful commitments, not transaction count or estimated people; repeat commitments by one wallet count once. Unknown counts remain unavailable. This is not a Sybil-resistant count of people.

Before the minimum: **38 / 50 SOL minimum**. Under it: **Max retained: 100 SOL**. At/above minimum: **72 SOL · Minimum reached**. Above hard cap: **143 SOL · 1.43× subscribed · Still open**. In every case the smaller cap caption retains **Min 50 · Max 100 SOL**, and the countdown remains visible. The meter spans 0–hard-cap with the soft-cap tick at soft/hard (50% for 50/100); excess is not depicted as invented space beyond the scale. Never let a full bar imply that commitments closed.

Explain proportional allocation and refundable excess ONCE above the directory, with accessible details. Do not repeat the same paragraph in every row. The commit preview explains the actual wallet's estimated accepted/refundable split. Terms and details remain accessible without depending on hover. Use SOL as the primary unit. Optional pool-dollar values must show their quote timestamp and whether they are estimates.

### Live row

Image/name/ticker/type; market cap or FDV with the basis named; liquidity; 24h volume; age; optional sparkline from real trades; View coin. No funding meter once live. Missing metrics show an em dash or unavailable label, never zero. A launch event or carried-forward candle must not invent trade volume.

### Upcoming / failed row

Upcoming shows opens-in time and sealed terms. Failed/expired shows “Refunds available” when true; no cheerful graduation styling. Transitioning launches show “Creating pool” with a recoverable state, never a misleading failure during confirmation uncertainty.

### Updates and pagination

Preserve scroll and ordering while the user reads. Collect new arrivals behind a “N new launches” button; do not jump rows under the pointer. Update numeric values in place with a brief, reduced-motion-safe highlight. Use cursor pages and server-side filtering/search across the whole registry. Counts and searches must not silently cover only the first 24 loaded campaigns. Query changes reset the cursor and cancel older requests. Back from a coin restores filters and position.

## Coin pages

Retain the compact left content plus 340–380 px right action rail. Banner remains exactly 3:1 in the right rail; social icons overlay a contrasting small backing. PFP 64 px with a 160–200 px preview on hover/focus and tap on touch. Video 16:9, optional, with a short description; no autoplay.

Raising: funding progress and countdown first; right rail commitment input and personalized estimated accepted/refundable SOL. Keep commitment controls enabled above the hard cap until closing, subject to chain policy and wallet balance. Expandable details cover full terms and evidence.

Live: chart and trades lead the left area, trade form in the same action rail. “Your position” is directly under identity or a compact strip above the chart: holdings, claimable, refundable, pending transaction. Claims must not hide below marketing, burns or developer posts. The action rail links to claims when available.

Below the initial viewport: Activity / About / Transparency. Activity defaults to meaningful confirmed asset movements; ongoing transactions have a separate compact pending area. Show 5–10 rows plus pagination, not 30 rows per metric. Burns of the launched token and parent tokens are distinct event types. Small nonzero values use exact-on-demand or less-than notation, never 0.00.

Per-launch policy comes from sealed terms and verified chain configuration. Show actual fees and supply split; do not hard-code the previous 2% tier or describe temporary liquidity as permanently locked. Future Direct mode would show “50% permanent / 50% scheduled recycling” with terms, evidence and next eligible execution. Hide unsupported modes entirely from creation until qualified.

## Your activity

Two tabs: Positions / Your launches. Put actionable claims/refunds and unresolved transactions first. Positions cover the complete wallet-indexed registry, not whichever campaigns happen to be loaded in Explore. Group multiple claims for one coin visually, but do not imply atomic bulk settlement if unavailable.

Creator area: Draft → Setup → Funding → Launching → Live, with the exact next action, transaction receipt and recovery path. Refresh or closing a tab must not lose a draft or cause another mint lease, launch fee or campaign. A creator can resume an existing creation operation rather than start again.

## Creation flow

1. Identity: name, ticker, image, 3:1 cover, short description, optional 16:9 video, socials. Persistent side preview. Actual durable upload with progress, replacement and validation; a blob preview is not a saved upload.
2. Terms: audited preset, soft/hard caps, opening and closing times; SOL first. Explain allocation and dev vesting with a segmented supply bar. Family remains a separate option only when its new-version path is qualified.
3. Review: complete fixed economics, authorities, lock rights, fees, schedule, verified cost quote and operational budget/refund treatment. Show real public addresses only once leased/provisioned, never secret material. One clearly labelled wallet signature step at a time.
4. Create and track: prepare → wallet approval → submitted → confirmed → ready. Show signature and pending recovery. Unknown confirmation cannot enable a duplicate create or reassign the mint. Successful creation opens that campaign's page.

Keep launch costs and deposits clearly distinct. No unsupported Create button disguised as a functioning launch path.

## Mobile

Same stage tabs and search; advanced filters in a sheet with visible applied chips. Cards/rows become two compact lines plus one stage metric row; 48 px artwork, 44 px tap targets, 16 px form inputs. Avoid horizontal tables and miniature charts.

Coin page: identity and funding/market summary, then primary action. Bottom bar provides Commit/Trade and Claims with a claimable indicator; respects safe-area insets and keyboard. The actual form opens as a sheet or scrolls to one existing form, never duplicates independent transaction state. Keep the chart above optional video and developer content. Full addresses copy on tap; essential information never depends on hover.

## Delivery order and acceptance

A. Signed-session pilot gate and existing-route regression tests.
B. Complete creation/provisioning, upload, cost quote and transaction recovery on localnet; do not paper over the currently disabled create path.
C. Directory paging, server search, status transitions and complete wallet positions.
D. Implement directory visual changes using existing KIDS components; review desktop and phone screenshots before expanding the design.
E. Connect campaign-specific market data/activity and postlaunch claims; qualify load and durability.
F. Private real-wallet pilot after code/chain restrictions are verified, then a separate public enablement.

Acceptance: 320/390/768/1024/1440/1920 px; keyboard and touch; empty/error/stale states; no horizontal overflow; exact small amounts; query/page restoration; no card movement under click; uploads survive reload; post-signing account changes abort safely; pending transactions survive reload; two concurrent creator requests cannot lease one mint; unapproved wallets cannot reach pilot APIs; existing Shartcoin money paths unchanged.

Load evidence must include registry sizes of 10, 100 and 10,000 records, 100 concurrent browsers against shared reads, and peak signed-write/reconnect bursts. Readers use indexed projections/cache; they must not cause one RPC fanout per visible card per visitor. Cache private pilot responses only behind authorization with correct wallet scoping; never publicly cache private responses. Set budgets and measure latency/error rates rather than declaring “traffic ready” from a frontend build.

## Full-flow supplement and visual review

See `PUBLIC-LAUNCH-FULL-FLOW-2026-09-25.md` for the complete screen inventory, journeys, failure/recovery cases, implementation mapping and review requirements. Design mocks are proposals with illustrative numbers. They do not enable a launch or prove the implementation exists. The broader visual redesign remains unimplemented until the user reviews it.
