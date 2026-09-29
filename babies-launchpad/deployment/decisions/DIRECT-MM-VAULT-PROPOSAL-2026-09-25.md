# Direct launch reserve-sale and trading vault proposal

Status: owner requested feasibility/design; not activated or implemented. Separate prospective
Direct feature/new program IDs. Existing parent, Standard and funded campaigns are unchanged.
This is distinct from the daily temporary-LP recycling program and from treasury/dev fee income.

## Owner-requested behavior

1. Allocate 10% of initial fixed token supply to program custody at launch.
2. For the first hour, sell an amount linked to 10% of each eligible buy.
3. Burn unsold initial inventory when that hour ends.
4. Keep sale proceeds in the coin's SOL trading treasury.
5. After that hour the dev may request buys/sells, but cannot withdraw assets.

## Decisions requested, not assumed

- Source of the 10%: proposed 43.5% participants / 43.5% pool / 3% dev / 10% vault,
  versus 38.5% participants / 48.5% pool / 3% dev / 10% vault. The Standard split decided
  on 27 September 2026 is 47.5 / 47.5 / 5, so any vault share would come out of those
  numbers. No extra minting or taking from paid claims/funded terms.
- Meaning of 10%: token units received by a buyer versus a SOL proceeds target.
  Those are not equivalent after AMM price impact, trading fees and delay.
- Exact every-buy synchronous execution requires a different AMM/routing architecture.
  The existing Raydium CPMM path needs asynchronous keeper follow-up; this is not equivalent.
  Do not silently promise exact synchronous coverage or change the venue to obtain it.
- Safety limits on post-hour dev trading and the authority policy must be sealed and disclosed.

## Execution feasibility and trust boundary

Solana programs execute when invoked by transactions; they do not wake themselves on another
program's swap or a wall-clock deadline. Current Raydium CPMM swaps have no callback into this
new controller. A swap wrapper can enforce a follow-up only for buys routed through it;
external users can call the pool directly. A keeper can observe supported pool swaps across
apps and submit follow-ups, subject to latency, outages, RPC gaps, cost and price guards.

A program cannot trust arbitrary keeper-supplied historical buy amounts/signatures. RPC logs
are not an on-chain proof merely because their signature exists as a string. Options needing
separate review: a native AMM counter/hook, an authenticated observation/attestation pipeline
with disclosed signer trust and hard on-chain limits, or a redesigned mechanism independent
of arbitrary historical per-trade claims. A trusted keeper alone must not have arbitrary sale
amount or output-recipient authority. Source-pool binding and minOut are necessary but do not
prove a real buy occurred. A new custom AMM also has integration/security costs.

For an asynchronous implementation, unique evidence keys include genesis, program, pool,
transaction signature and instruction/inner-instruction index. Reconcile confirmed/finalized
state and forks; account for swaps within aggregator routes without counting transfers,
liquidity deposits, fees, failed transactions or the same swap twice. Indexer persistence and
an authenticated on-chain cumulative budget must agree. Keepers need funded operations and
bounded batches. Exclude protocol recycling/MM buys to prevent a self-triggering sale loop.
Wallet labels cannot reliably exclude all dev-controlled or wash-trading wallets.

If token-unit matching is chosen, illustrative rule:
  authorized sold tokens <= min(initial reserve, floor(eligible bought tokens / 10))
Use cumulative raw units to avoid buy-splitting/rounding effects; define the ordering/finality
rules explicitly. Output SOL is determined by execution, not promised to equal 10% of spend.
Selling the whole 10% supply reserve under that rule requires gross eligible buy token volume
at least equal to the initial supply. Gross volume can include repeated trading of the same
coins; it is not unique demand and can be manufactured.

## Proposed custody and phases

- Allocate reserve once during atomic launch into a distinct program PDA token account. Bind
  launch/campaign, child mint, WSOL, canonical pool, dev capability, supply and policy hash.
  No delegate, transfer, arbitrary close destination, mint authority or discretionary sweep.
- Use verified pool trading-open time as the proposed start; define it in sealed terms before
  commitments. First-hour sale interval is [start, start+3600); chain execution time is decisive.
- Stop reserve sales at the boundary, including delayed backlog. No grace period allowing
  a keeper/dev to dump unsold reserve later without a newly approved policy.
- At or after the boundary, permissionless finalization burns all remaining INITIAL sale
  reserve. The keeper calls it, but nobody can guarantee an exact wall-clock burn transaction.
  Until finalization completes, reject post-hour MM trades. Finalization is idempotent.
- Initial-sale token custody stays separate from post-hour MM inventory so a replayed finalizer
  cannot burn newly bought MM tokens. Revoke child mint/freeze authority as in the launch design.
- All SOL proceeds remain program-owned; post-hour trade outputs can go only to the coin's
  bound vaults. Native SOL wrapping/unwrapping, account closure and rent handling must not
  introduce a hidden transfer path. Operations are separately funded, not an unlimited
  reimbursement destination controlled by the dev.
- Inventory exhaustion stops first-hour selling early. With no sales, finalization burns the
  full initial reserve and leaves an empty MM treasury; there is no implied SOL guarantee.

## No withdrawal is necessary but insufficient

Unrestricted trading can indirectly extract value: the dev trades against a related wallet,
manipulates price before a vault buy, buys/sells in a harmful sequence, or accepts a bad route.
Even a fixed canonical pool cannot reliably identify all counterparties or stop every form
of economically adversarial trading. Do not market this as impossible to drain merely because
there is no withdraw instruction. An upgrade authority can replace restrictions too.

Recommended direction: dev can REQUEST execution within on-chain rules, not choose arbitrary
recipients, programs/routes, price tolerance or unlimited size. Seal per-trade and rolling
spend limits, inventory/SOL risk limits, minimum intervals and independently justified price,
freshness and impact checks. A thin pool's current spot-derived minOut is not a meaningful
manipulation defense. Unsupported/stale reference means refuse the trade, not fallback.
Simulate adversarial related-wallet trades and wash volume; bounded discretion limits damage
but is not a proof against indirect extraction. Stronger guarantees require a narrower,
automated execution policy rather than unrestricted dev buy/sell authority.

## Interaction with other new Direct mechanics

- Do not count MM proceeds as trading fees or commingle them with treasury/dev entitlements.
- Preserve the selected fee treatment from BOTH permanent and temporary LP positions.
- Initial LP recycling is no earlier than a full day under the draft kernel; the first-hour
  reserve sale ends first. Nonetheless later MM/recycling trades affect the same pool and
  need compatible price/impact controls and distinct attribution.
- Any changed supply split changes participant token allocation, pool inventory, opening
  price and vesting calculations; update sealed terms, SDK, tests and user review together.
- Treasury is exposed to market losses; no guaranteed market cap, profit, floor or price path.

## Required UI and verification

Disclose the 10% reserve and first-hour systematic selling before users commit. Show reserve
remaining/sold/burned, exact UTC window, actual net SOL raised, pending/confirmed operations,
keeper lag, treasury SOL/token holdings, dev permissions, trade limits and explorer evidence.
Call it a managed trading treasury unless actual two-sided market-making behavior is defined.
A percentage-based follow-up sale is not a buyer token transfer tax, though it adds sell pressure.
Scanners may flag the initial 10% custody concentration; show evidence rather than hiding it.

Before activation: test source-event forgery/duplicates/forks, cross-pool/mint substitution,
first-hour boundary races, backlog expiry, zero volume, reserve exhaustion, finalizer replay,
Token-2022 incompatibilities, balances/rounding, malicious dev trades, oracle manipulation,
program upgrades, permanent/claim/refund reserve isolation and real-validator AMM behavior.

Sources checked 25 September 2026:
- https://solana.com/docs/core/programs/program-execution
- https://github.com/raydium-io/raydium-cp-swap/blob/master/programs/cp-swap/src/instructions/swap_base_input.rs

## Auto MM extension requested

Owner asked whether Auto MM is possible. Proposed addition, not yet activated/implemented:
use the post-hour vault as an automated inventory-rebalancing treasury. Keep the distinction
between its active swaps and the Raydium LP, which already provides passive market making.

- After the initial reserve is finalized/burned, gradually establish a bounded token inventory
  using treasury SOL. Retain those purchased tokens for future MM sells; these purchases are
  separate from the LP recycling purchases that MUST be burned.
- Rebalance only outside a disclosed no-trade inventory/price band, using reviewed reference
  data and limits. No random volume generation, guaranteed price floor or promise of profit.
- Use small bounded trades, a SOL reserve floor, inventory ceiling, rolling spending/turnover
  limits and a minimum interval. The no-trade band must account for fees on both legs, price
  impact and transaction costs. Do not assume frequent trading increases treasury value.
- A keeper submits instructions; the program authorizes the action/amount against chain-verified
  data and the sealed policy. API suggestions/keeper signatures alone cannot bypass limits.
  Chain time, durable intents and sequence reconciliation prevent duplicate retries.
- Stale or manipulable reference data, excess price impact, exhausted budget, failed finalization
  or insufficient balances means no trade. A time-weighted price from the same thin pool is not
  automatically manipulation-resistant; validate through adversarial simulations first.
- Dev enable/pause/resume capability may be provided within the disclosed policy. Manual dev
  requests, if retained, obey exactly the same limits and custody constraints as automated ones.
  No arbitrary program/route/recipient or bypass via editable parameters/upgrade authority.
- Public UI shows automation status, holdings, recent protocol trades, costs and valuation
  freshness. Mark bot/recycling trades distinctly; do not present them as organic demand.

Target allocation, bands and budgets are engineering proposals to simulate, not approved numeric
defaults. This does not resolve the source of the 10% supply or the first-hour matching rule.
