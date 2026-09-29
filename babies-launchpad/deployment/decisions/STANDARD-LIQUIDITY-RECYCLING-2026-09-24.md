# Direct launches: separate permanent and temporary liquidity feature

## Update — 25 September 2026

Owner selected **preserve treasury/dev fee entitlements from both permanent and temporary
LP**, superseding the earlier unresolved fee choice and recycle-with-principal candidate.
Only temporary principal enters the new recycling mechanism. Preserve existing token-side
fee burns as well. Implement and verify fee harvesting/principal accounting before enabling
this policy; the existing numerical model does not provide that accounting. No promise of
unchanged future revenue as LP shrinks. Stopping rule remains undecided; this answer does not
select 90 cycles. Older checkpoint notes below are historical. Nothing is activated.


Status: **implementation authorized for a separate Direct feature; remaining economic parameters unresolved; isolated Rust kernel and offline SDK implemented; no on-chain account/CPI integration yet**.
No activation, deployed program, transaction builder or keeper is provided by this change.

## Subsequent owner decisions — 24 September 2026

Standing owner rule: all new on-chain mechanics must use separately deployed **new program IDs**, preserving old programs and funded campaigns. See [program versioning policy](PROGRAM-VERSIONING-POLICY.md).

The owner selected **50% of initial received LP permanently locked / 50% temporary**, and then selected **3% of the remaining temporary LP per daily cycle**. This is not 3% of total pool liquidity or original LP every day. The first cycle therefore redeems 1.5% of initial received LP, before accounting for Raydium minimum LP or outside LP changes.

The owner subsequently authorized implementation ("do it") and clarified: **keep parent launches; Direct is a separate new feature with no parents of its own**. Preserve existing launch options and funded campaigns. Direct keeps the established commitments, caps, proportional allocation, refunds, participant claims and dev vesting. Its changed liquidity mechanics start at pool creation. Start delay, final deadline, execution guards, fee rights and controller authority policy remain unresolved. The seven-day delay and roughly 90-cycle sunset discussed earlier are proposals, not newly approved terms.

The old candidate/model envelope below still covers only 5–10% temporary LP and 0.5–1% daily. It does not implement or validate the selected 50/50, 3% design. Do not remove its bounds and describe existing tests as evidence for the new design. Implementation authorization does not activate production, authorize an upgrade to an existing program, or change funded terms. Build the new version separately and keep its creation path disabled until release gates are met.

## Scope and approval (historical record, superseded by the Direct scope above)

The owner approved splitting future Standard launch LP into permanent and temporary allocations, each with explicit rules. The temporary allocation may use this cycle: redeem LP, burn withdrawn child tokens, spend all withdrawn WSOL buying that same child mint from that same pool, burn the purchased tokens. This is not an ordinary two-asset liquidity deposit. The SOL returns through a swap. Parent launches are excluded.

This supersedes the all-LP-permanent design direction only for a future, explicitly versioned Standard policy. Existing funded campaigns, Family campaigns, the v1 manifest and the v2 program retain their original all-LP lock. There is no migration or unlock of Raydium-locked LP. No user can commit under the new policy until its implementation and terms are reviewed and activated.

The original research awaited selection of permanent/recyclable split and daily rate/sunset. The owner has since selected 50/50 and 3%; sunset remains unresolved. The research manifest carries 95/5 and 90/10 LP splits, 1% and 0.5% of **remaining temporary LP** per day, and a 90-day sunset as candidates only. There is no selected default. Execution-price limits, minimum economic batch, operation-cost budget and controller upgrade policy also remain release decisions.

The 2.5% configured trading fee, participant/dev token reserves, dev vesting, pro-rata commitments and refunds remain separate terms. No extra token allocation is created: the split is of LP units received when the pool is formed, not total token supply, committed SOL or refund reserves. All accepted SOL still initially enters the pool.

## What is implemented in this change

The subsequent Direct implementation adds `programs/kids-liquidity-v1` (nondeployable Rust library)
and `localnet/recycling/direct-policy.mjs`. These implement the approved 50/50 split and 300bps
remaining-budget rate with explicit candidate schedule/fee choices, canonical draft codecs,
receipt-effect checks, replay prevention and remainder-lock accounting. See the crate README
for precise limits and the missing chain integration. Neither accepting a caller-supplied effects
object nor passing these host tests proves a real token burn or secure on-chain custody.

The following initial research remains historical:

- An offline BigInt policy/custody model, deterministic hash, integer LP split, bounded daily redemption, no accumulated catch-up and sunset/dust relocking state.
- A constant-product arithmetic model of withdrawn amounts, both token burns, the same-pool purchase and input-fee accounting. No signing, RPC or movement of funds.
- Tests for raw/economic SOL distinction, custody conservation, replay timing, policy changes, sunset precedence, dust and a seller who reverses the mechanical price increase.
- Existing v2 term encoding and v1 preset generation explicitly refuse a future `liquidityPolicy` instead of silently dropping it from the signed/hash-covered terms.
- A reproducible candidate comparison: `node localnet/recycling/report.mjs`.

This is **not** an on-chain implementation, Raydium parity test, audit, activation record or proof of economic safety.

## Custody architecture to implement next

Use a new campaign layout and a separate controller program. The controller's LP token account must be owned by its own PDA, have no external delegate and no discretionary close/withdraw recipient. The old upgradeable campaign must not be able to sign for this custody. A retained controller upgrade authority can replace its restrictions; publish that risk and do not call custody immutable until upgrade authority is actually revoked. Immutability requires completion of tests and independent review first.

At atomic pool creation, measure LP actually received (excluding Raydium's minimum permanently retained LP):

1. `temporary = floor(receivedLP * temporaryBps / 10000)`.
2. Permanently lock `receivedLP - temporary` with the canonical Raydium locker; retain the fee NFT under the established fee policy.
3. Move only `temporary` into the controller PDA and seal its initial budget.
4. Re-read both custodies and authorities before marking the launch live. Any failed check rolls back everything.

Seal identity (genesis/program/campaign/pool/mints/token programs/LP mint), actual initial LP budget, policy version/hash, start/end times, rate, lifetime ceiling, execution guards and fee treatment before funds are accepted. Where an actual amount cannot exist until launch, seal its deterministic calculation and write the measured amount once at launch. Do not put an unsigned JSON-only policy beside an old campaign account.

The permanent percentage means a share of **initial minted LP units**; it is not a promise that a fixed number of SOL stays available forever. Sellers can remove SOL through normal swaps. External liquidity providers and subsequent LP supply changes alter percentages of the current pool.

## Scheduling and operation

- Chain clock only. First eligible cycle after one full day; at least 86400 seconds between successful cycles. No midnight-boundary double execution.
- Amount is derived on-chain from tracked remaining temporary budget, never passed as a caller-controlled redemption amount or taken from an arbitrary account balance.
- Missed time never creates a backlog of purchases. One run after downtime makes one bounded cycle. Failed transactions leave the cycle eligible; successful receipts prevent duplicate application.
- Sunset wins over a cycle at the exact end timestamp. For a 90-day window starting at launch, with the first cycle at day 1, this means at most 89 successful daily cycles. UI must describe this accurately.
- At sunset, or when redemption would round to dust, permanently lock all tracked remaining LP. No final unrestricted withdrawal, purchase, payment to dev, or sweep of participant claims/refunds.
- LP donations do not increase the original budget. A separate constrained instruction may permanently lock donated LP. Other donated assets must never be mixed with measured cycle receipts or used to fake SOL-return/burn evidence.
- Keepers pay from a separately funded operation account. No tips, rent or execution costs deducted from the withdrawn SOL. Minimum economically meaningful batch/cost ceiling remains unresolved.

## Atomic cycle and required assertions

One Solana instruction performs fixed CPIs only: canonical Raydium withdraw, child `BurnChecked`, canonical same-pool WSOL->child swap, child `BurnChecked`. If transaction/account/compute limits prevent this, fail the design review; do not casually replace it with a wallet holding SOL between steps. Do not accept an arbitrary Jupiter route, output mint, account list, recipient or program.

Before/after checks must establish:

- Both protected permanent custody and all user claim/refund/dev reserves are untouched.
- Exactly the allowed LP amount was redeemed and its mint supply changed consistently with the pinned AMM program.
- Exact WSOL receipt was measured as a balance delta, all of it became swap input, and no cycle WSOL remains or is sent elsewhere.
- Child mint supply decreased by the measured withdrawn plus purchased tokens; no unrelated burn is attributed to the cycle.
- Pool vault and fee-account changes reconcile with the exact deployed AMM fee rules. Raw vault balances include accrued protocol/fund fees; returning all SOL does not preserve all usable SOL reserves.
- Controller state is advanced only after every assertion passes. Event contains policy hash, sequence, amounts, before/after reserves and both burn amounts.

## Fee rights must be resolved explicitly

The current all-LP-lock uses the fee NFT for revenue collection. A temporary, unlocked LP position has fees embedded in its redeemable reserves and no corresponding locked-position fee NFT. Burning its redeemed token fees and swapping its redeemed SOL fees can change the effective treasury/dev earnings compared with the current route. Do **not** claim the original fee economics remain identical without specifying and proving how those temporary-position fees are separated/accounted for.

Choose and disclose either a reviewed harvesting/accounting mechanism preserving the current fee entitlements, or a separately approved prospective fee policy for this allocation. Never silently take existing dev/treasury entitlements. Recycling swaps themselves incur pool fees and must be labelled protocol-generated activity, not organic demand. The research model does not implement harvesting or fee-NFT collection.

## Price and economic protection

Atomicity stops interleaving inside the cycle, not trading before or after it. A pool's current reserve ratio can already be manipulated. `minOut` derived solely from that ratio is insufficient as an economic guard. Review a manipulation-resistant reference, minimum observation history, freshness rules, deviation limits, execution-price impact and protected submission. References to the same thin market must be stress-tested, not treated as independent oracles. If reliable pricing cannot be established, skip recycling and preserve the funds; never fall back to `minOut=0/1`.

Simulate and rehearse adversarial buys/sells around execution, persistent selling, no organic volume, external arbitrage, added/removed outside LP, manipulated reference observations, low reserves, integer dust, fee changes, fee harvesting, donations, keeper outages and replay. Establish release limits from these results rather than aiming for a target candle or market cap. No guaranteed price floor or chart path exists.

No-fee counterexample: 100M tokens / 100 SOL -> recycle 1% -> 98.01M / 100 SOL. An external sale of 990,000 tokens obtains 1 SOL and returns the pool to 99M / 99 SOL at the original price. This is why immediate SOL restoration cannot be marketed as permanent preservation of quote liquidity.

## UI/UX contract

Keep the existing launch choices. Add a distinct **Direct** choice only when its new version is activated; do not relabel or replace Family/parent or existing Standard launches. Direct creation has no parent picker, parent mint fields, snapshot checks, parent rewards, parent claims or parent buybacks. Its creator review and participant commitment pages must show the selected, sealed policy **before** commitment: Direct mode, permanent percentage, temporary percentage, daily percentage with its denominator, sunset date, cumulative maximum, fee treatment and program/authority evidence. No preselected research candidate may appear active.

On live pages use one compact liquidity card:

- **Permanent LP:** initial LP units locked, current ownership share if verified, canonical lock explorer link and remaining fee rights.
- **Recycling allocation:** remaining / original LP budget, small progress bar, policy link, sunset; this is not a guaranteed SOL balance.
- **Results:** redeemed LP, withdrawn tokens burned, purchased tokens burned, total percentage of original token supply burned and external fees accrued. Use exact values on demand and never round positive burns to zero.
- **State:** waiting / eligible / unavailable price reference / pending transaction / confirmed / sunset awaiting lock / permanently closed. Eligibility is not an exact execution-time promise. Stale data stays unknown.

An expandable receipt shows all four operations and reserve deltas under one signature. Keep live activity compact and identify protocol cycles separately from user trades. Remove “100% liquidity permanently locked” wherever this policy applies. Do not hide withdrawal events or relabel them as fee collections. Third-party scanners may still flag the temporary position as unlocked; expose proof and explain the restriction without promising scanner acceptance.

## Release sequence / acceptance evidence

1. Resolve exact economics, fee rights, price reference and authority policy; record the owner's choices separately from this research envelope.
2. New sealed layout / controller ABI / strict SDK encoding and registry reader. Unsupported policy versions fail closed in every route and signer.
3. Atomic launch custody split, restricted cycle and permissionless remainder-lock instruction. Preserve existing paid claims/refunds indefinitely.
4. Differential tests against the exact deployed Raydium withdraw/swap/lock programs and full real-validator replay; adversarial and invariant tests, SBF stack/compute/transaction-size checks.
5. Keeper leases, signature persistence, status reconciliation, observation indexing, public evidence and frontend actions with actual chain data.
6. Independent security/economic review, controller authority verification, evidence-backed preset activation and explicit feature release. No changes to existing pools.

The numerical model can guide the next review; it cannot substitute for any of these gates.
