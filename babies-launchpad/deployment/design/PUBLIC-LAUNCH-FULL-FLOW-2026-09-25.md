# KIDS full launch experience: implementation and design review plan

Date: 25 September 2026. This supplements PUBLIC-LAUNCH-DISCOVERY-2026-09-25.md.
User request: include revised minimum-target/participants rows, the complete launch flow and the missing supporting experiences; show designs before implementing them. Compact-list concept is the working direction based on the user's row feedback, not approval to implement every visual.

## Coverage map

| Screen | Primary task / next action | Required information | State variants |
|---|---|---|---|
| Explore | Find and open a coin | Stage; raising progress toward MINIMUM; smaller maximum; unique participant wallets; stage-appropriate countdown or market data | Loading, no launches, no results, pagination, stale/error, new arrivals |
| Wallet connection | Authenticate intentionally | Chosen wallet, readable sign-in reason, network; no funds authorization | Missing extension, rejection, timeout, changed account, revoked/expired session, private-pilot denial |
| Create 1: Coin | Select supported launch type and identity | Standard; name; exact ticker; creator/dev wallet | Family capability pending/available; duplicate names allowed, mint distinguishes; validation; signed-out; saved draft |
| Create 2: Profile | Publish usable coin media and description | Square PFP, exact 3:1 banner, description, X, website, optional 16:9 video with caption; live preview | Upload progress/retry, invalid media, image framing, remove/replace, unavailable storage, unsaved vs server-saved |
| Create 3: Terms | Choose qualified preset and schedule | SOL minimum/maximum, fixed funding window, opens/closes UTC and local equivalent, supply split, dev vesting, fee and liquidity policy | Immediate vs scheduled, outdated quote/preset, invalid/past time, disabled unsupported modes |
| Create 4: Review | Understand costs and sealed terms before signing | Profile summary, cap/schedule, all allocations/vesting, fee split, authority/lock evidence, exact creator cost quote, setup-budget/refund rules | Quote unavailable/expired, insufficient SOL, changed draft, last confirmation, wallet request |
| Creation progress | Resume safely until the campaign exists | Prepare → wallet → submitted → confirmed → ready, actual signature, next step | Rejected, not submitted, pending unknown, expiry proven, recovery, partial setup, paused service |
| Upcoming coin | Understand future commitment window | Identity/profile, minimum/maximum, opens-in timer, UTC opening, disabled Commit, terms | Missing/changed schedule, stale status, opening boundary |
| Raising coin | Commit SOL and inspect personal estimate | Minimum-first progress, max retained, participants, closes-in, actual SOL balance, input, estimated allocation/refund, current position, security links | Under minimum, minimum met, oversubscribed still open, low balance, stale read, wallet/network mismatch |
| Launching coin | Track settlement and creation | Closed commitments, accepted/refundable amounts when final, current factual processing step, signature/receipts | Pending settlement, pool creation, retry, launch deadline, failure; no premature Live label |
| Live coin | Trade and claim | Real chart/trades, MC/FDV basis, LP, volume, holdings, claimable/refundable assets, buy/sell form, editable slippage, exact fees | No trades, stale quote, insufficient funds, wallet rejection, submitted/confirmed/unknown, claims already done |
| Your activity: Positions | Find money needing action across every launch | Claimable tokens, refunds, committed SOL, token holdings, pending actions, exact eligibility reason | Multiple coins, already claimed, not eligible, unavailable checks, paginated complete wallet index |
| Your activity: Your launches | Resume drafts and manage launched coins | Draft/setup/upcoming/raising/launching/live statuses; exact next action; fundraising; dev vesting and fee earnings | Failed setup/launch, recoverable operation, saved profile, pending update, restricted permissions |
| Creator coin management | Update permitted content and post updates | Profile/media editor, text/image/video posts, preview, allowed social links; immutable terms displayed read-only | Ownership verification, upload failure, publishing pending, archived edit/audit, unsafe content rejected |
| Claims/refunds | Collect exact entitled assets | Recipient, token/SOL amount, entitlement basis, snapshot eligibility for Family, vesting schedule | Not eligible, already claimed, nothing vested, expired free parent claim only if policy says so; no expiry for paid claims/refunds |
| Failed launch | Recover committed SOL | Failure reason, minimum and actual raised, wallet's refundable amount, full refund claim, evidence | Below minimum, qualified processing timeout, partial prior refund, confirmed/refundable/unknown |
| Transparency | Verify the actual program and custody | Program/version/upgrade authority, mint/freeze status, vaults, actual lock proof/fee rights, allocation custody, treasury/dev routing, source links | Verified, unavailable, mismatch; never substitute a generic safe badge |
| Guide / rules | Understand mechanics | Standard vs Family, caps, pro-rata, refunds, supply, dev vesting, actual fees, risks and authority model | Version-specific rules; no future features represented as active |

## Journeys to walk through in the visual review

**Creator:** Explore → sign in → new draft → coin → profile → terms → review/cost quote → wallet approval → resumable setup → upcoming/raising coin → creator dashboard → launched coin → dev vested claim and verified fee earnings.

**Participant:** Explore → filter/search → upcoming or raising coin → understand minimum/maximum and time → sign in → input amount → estimated accepted/refundable split → wallet approval → pending → confirmed → Your activity → settlement → claim tokens and excess → trade.

**Refund:** minimum missed or qualified launch failure → refund state → exact refundable SOL → sign → pending → confirmed. The interface does not hide refund access just because creation or new deposits are paused.

**Family:** browse existing Family coin → see parents inline → eligibility and snapshot explanation → separate parent allocations/claims → trades and parent burns. New Family creation remains a capability-gated branch until the new distribution path is qualified. Standard has none of these parent fields. Do not reinterpret the existing 0.05% snapshot rule or invent a new expiry in design.

**Return after interruption:** sign back into the same wallet → recover server draft or outstanding transaction → reconcile actual signature → continue the same operation. Do not charge/create/lease again merely because the browser lost its response.

## Agreed economics and representation

- The initial Standard preset proposal is 50 SOL minimum / 100 SOL maximum retained, with larger 100 / 250 preset subject to activation. UI takes these from the qualified manifest; illustrative mock values do not activate it.
- Standard supply 47.5% participants / 47.5% liquidity / 5% dev (owner, 27 September 2026; sealed in the version-3 issuer as split policy 3). Dev receives 1.5% at launch and 3.5% linearly over three UTC calendar months (vesting rule 2), not a three-month cliff and not necessarily 90 days.
- Existing Family split 43.5 / 43.5 / 10 parents / 3 dev; preserve campaign-specific published rules.
- Show actual program/pool fee. Proposed standard trade fee is 2.5%, not the stale 2%. Child-token collected fees burn; collected SOL follows the selected verified treasury/dev/parent routing. Pool trading fee is not all platform revenue. Expand the fee detail rather than publish a misleading total.
- Creating a coin costs rent/network/setup/operational funding as quoted, separately from that creator's optional commitment. Never fill unknown quote amounts with zero. Distinguish nonrefundable expenses from refundable unused budget only where the contract actually supports it.
- Claims/refunds are actions, not automatic deposits unless an implementation actually performs them. Say “excess refundable” in the directory, not “automatically refunded” as an unqualified promise.
- Participants = distinct wallets, not distinct people and not number of transactions. Do not use that count as a fairness/Sybil guarantee.
- Total committed is not always total retained, pool value is not market cap, USD is not a guaranteed amount. Avoid fixed "$200K opening pool" when the accepted raise varies.

## Lifecycle source of truth

Upcoming requires a real enforced future opensAt. Raising requires the program permits commitments at current chain time. Reaching the minimum or maximum does not close funding. Closure is enforced by the campaign's deadline/state. Launching means processing is actually underway/awaited after closure. Live requires confirmed pool creation and supported readiness checks, not merely zero on a timer. Refundable follows contract state. Browser countdown reaches zero → request fresh status; no browser-only financial-state transition.

Postlaunch terminology must distinguish submission, confirmed and finalized where it affects the action. Pool evidence and source freshness are visible on demand. Stale/unavailable data is never silently replaced with a fixture, a zero or a cached enabled money button.

## Transaction and recovery states to design explicitly

1. Not signed: no transaction sent; cancel freely, retain form.
2. Awaiting wallet: one prompt, correct account/network; cancellation is not a chain failure.
3. Submitted: signature and explorer link, disable duplicate submission for this intent.
4. Confirmation unknown: checking status, no claim of failure and no automatic new transaction. Preserve the signed packet and reconcile.
5. Confirmed: exact operation result, refresh position and show the next action once.
6. Expired: only after blockheight and signature/history checks prove it did not land; safe reprepare bound to the same operation.
7. Partial creator setup: show actual completed steps and resumable missing ones. Mint cannot return to available inventory while a transaction may have landed.
8. Wallet switch/sign-out: stop unsigned operations; keep submitted operations recoverable for their original owner. Do not relabel someone else's draft or transaction.
9. Network/API/RPC outage: read-only stale state clearly labelled; stop new unsafe writes, leave status/refund recovery available as appropriate.

Tooltips: keyboard/focus and tap accessible, Escape dismisses; portal/positioning prevents clipping behind the sticky action rail. Critical economics and action status cannot live only in a tooltip.

## Content, fees and evidence surfaces missing from the initial mockups

- Full upload/validation/cropping and optional video flow, not just a fake upload box.
- Cost quote, balance sufficiency and signature review.
- Publish/create progress and interruption recovery.
- Creator posts/media editor with ownership checks; financial terms remain sealed.
- Exact wallet accepted/refundable estimate before committing and final position afterward.
- Claims/refunds and dev vesting placed where users find them.
- Postlaunch chart/trades, no-trade state, editable slippage, fee disclosure and transaction feedback.
- Meaningful activity covering launched-token burns as well as parent operations; small nonzero amounts never rendered as zero.
- Program/authority/liquidity evidence and version-specific documentation.
- Mobile-specific navigation, action placement, keyboard and touch behavior.
- Spam/duplicate/abuse considerations, pagination and whole-registry search: no first-page-only search presented as global.

## Implementation sequence (no visual redesign begins before review)

Capacity requirements are detailed in ../decisions/PUBLIC-LAUNCH-CAPACITY-2026-09-25.md. Fee collections, burns/buybacks, lifecycle settlement, user actions and indexing require reserved independent execution and upstream budgets; a single prioritized worker pool is not the production design. UI must distinguish accrued, collected, awaiting burn and confirmed burned, with freshness and truthful degraded states.

1. Confirm screen/state coverage with this design packet; refine the chosen compact direction. Desktop critical flows first, then phone equivalents before visual implementation.
2. Complete signed-session private pilot integration. Current branch has the API/UI gate; deployed status is separate. Mainnet wallet exclusivity also needs an on-chain restriction because web/API authentication alone cannot restrict permissionless instructions. Do not upgrade old programs.
3. Define versioned read/write API contracts for drafts, durable media, preset quote, creation intent, campaign state, complete positions, creator management and market data. Include cache/freshness and explicit capability fields.
4. Reuse existing encrypted kids mint inventory and lease state machine. Integrate authenticated provisioning, verified quotes, bound signing, persistence-before-broadcast, registration and crash recovery. No fresh independent key generator or browser secret storage.
5. Localnet end-to-end creation, multiple commitments, oversubscription, settlement, launch, claims/refunds, dev vesting, burns and market display. Qualify unsuccessful launch and interrupted create paths too.
6. Complete indexed directory filters/search/cursor pagination and wallet-indexed positions. Extend proven paging/market primitives and existing KIDS adapters. Read aggregation is shared, not a per-user RPC fanout.
7. Implement approved desktop and mobile views, connected to real capabilities and data; no mock capability becomes an enabled money action.
8. Durable jobs/Postgres/shared limits and operational monitoring; corruption/restart/concurrency/load tests; permission and secret-publication review. Independent program security review before mainnet expansion.
9. Explicitly restricted real-wallet pilot and evidence-based release review; separate public enablement. Existing Shartcoin/Family routes and old programs remain intact.

## Definition of done

Every screen/state above has a source, design, implementation owner, test and current status. A working draft form is not a completed creation flow. A rendered transaction banner is not chain evidence. Prove no double creation, spending, claim or lease under retries; no owner spoof; exact arithmetic; no secret metadata in public assets; approved content destinations; immutable economics; known authorities and custody.

Visual checks at 320/390/768/1024/1440/1920 px include browse → coin → commit/claim, creator draft → quote → sign → resume, and mobile navigation/keyboard/tooltip boundaries. Load evidence and chain evidence are separate from screenshots. Publish a status checklist that records implemented, qualified, disabled and proposed rather than one generic production-ready badge.

## Design packet delivered for review

Eleven visual proposals cover Explore; four creation steps; raising/commit; live/trade/claim; wallet positions; creator management/setup recovery; failed-raise refunds; and a phone commitment screen. A separate local gallery includes supporting states and the delivery sequence. It is a review artifact, not product implementation. Mock values, coin identities, quotes and dates are illustrative.

The coverage matrix above is the full required surface inventory. Wallet connection, upcoming and launching variants, detailed transparency, dev earnings, individual transaction error states and mobile creation/trading/claims still need detailed interaction review; do not claim every variant has a finished visual merely because it is specified. Existing application implementations must be reconciled against this inventory, not overwritten blindly.

Implementation must correct remaining raster imprecision: use exact 3:1 banner and 16:9 video ratios; use a fixed 0-to-maximum funding scale with a mathematically positioned minimum tick; final failed-raise values are confirmed Retained/Refundable, not estimates. Full refunds are claimable, not an unconditional promise of automatic delivery. Generated logo details are illustrative and must not replace the actual approved KIDS brand assets.

The revised creation review explicitly ends at Funding page ready. The revised raising screen labels the 2.5% as the pool trading fee and separately explains collected coin-side fee burning. Live creator rows no longer show a funding countdown or Still open. These corrected versions supersede the first generated versions.

## Scope deferred from this foundation

50/50 temporary LP recycling, first-hour reserve selling, coin trading-reserve controls and Auto MM each need their own newly versioned programs, full economics decisions and testing. They are not extra toggles in this pilot. Keep existing parent functionality and permanent-liquidity launch promises intact.
