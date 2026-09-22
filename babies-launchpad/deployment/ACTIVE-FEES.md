# Active localnet fee keeper

`localnet/active-fee-keeper.mjs` exports `createActiveFeeKeeper()`. The account service invokes it every 15 seconds under an independent keeper lease; importing the module alone does not start a timer. One tick performs at most one
new signed operation; overlapping ticks return `busy`. Existing operator sender
logic controls same-wire rebroadcasts. Run under the API's single-writer runtime
lock, not in a second process sharing its journal.

The default resolver accepts only the registered, launched **active localnet**
campaign on `127.0.0.1:19099`. The local admin must equal its creator. The manifest,
program/genesis identity, mint, Fee Key, treasury/dev and both parents are bound to
the journal. Parent mints must also match the on-chain parent configuration.

Before any operation, the child and both parent routes must exist at their canonical
Raydium CPMM index-2 addresses with the approved 2% configuration and matching vaults.
A missing, frozen, altered or disabled route fails closed; no fallback pool is chosen
and no parent pool is created automatically. Campaign custody and recipient ATAs are
created idempotently, one transaction per tick, and existing accounts are validated.

Collection reads the Fee Key NFT's `locked_liquidity` PDA, verifies its Anchor
discriminator, exact layout, locking-program owner, pool, NFT, launch authority and
LP mint, and uses that position's `locked_lp_amount`. The shared lock vault balance
is only an upper-bound custody check: another user's locked LP cannot inflate our
collection bound. The layout is pinned to the [official Raydium CPI interface](https://github.com/raydium-io/raydium-cpi/blob/115df2779d53bacc7db9d0be2773a4b48a6d372b/programs/locking-cpi/src/states.rs).

Operations initialize fees, create required ATAs, convert child earnings, distribute
cumulative 98:20:25:25 shares, and buy/burn each outstanding parent budget. Collection
runs no more often than once per five chain-clock minutes by default (minimum allowed
interval: one minute). Tiny amounts that cannot produce an integer quote are retained
for a later tick. The on-chain program preserves donation balances and burns only
newly purchased parent tokens.

`active-fee-operator.json` contains a bound identity, current operation, monotonic
operation number and exact signed operator attempts. Current operations persist
before submission and remain current on errors; a restart resumes the same operation
through `createOperatorSender`. A replacement blockhash is only allowed after that
sender establishes definitive failure or finalized expiry. Quotes are recalculated
for a newly built attempt, with a 90-second expiry and the existing 99%-of-spot
minimum output. No extra payout percentages are introduced.

## Qualification and limitations

Policy tests cover cumulative budgets, replay-resistant remaining amounts, malformed
accounting, identity gates, absent campaigns, overlapping ticks and Fee Key position
identity/amount validation. `node localnet/qualify-active-lifecycle.mjs` additionally
runs a disposable campaign through real commitments, launch, claims, child buy/sell,
fee collection/conversion, recipient balance deltas at 98:20:25:25, and both parent
mint-supply burns. The following idle tick must leave counters unchanged. Burn
signatures finalize before the next campaign snapshots parent supplies. Evidence is
written to `.runtime/active-lifecycle-qualification.json`, with original active
registry/journal hashes checked unchanged. Parent pools, mint supplies and test-wallet
balances on the shared local validator do change.

The harness does not inject a process crash mid-fee-transaction or manipulate prices
through quote expiry. Those scenarios rely on the separately tested durable operator
sender and on-chain expiry/minimum-output guards; a dedicated fee crash/expiry
integration qualification remains outstanding.

**Spot quotes are not oracle or MEV protection. This keeper is not mainnet ready.**
It inherits the existing canonical-program quote policy, creator authority, upstream
locking dependency and single-process journal limits. Parent routes must already be
registered and liquid. There is no dynamic routing, threshold based on economic gas
profitability, adaptive batching, log archival, or independent external price check.
Confirmed state is the localnet confirmation policy. Pruned historical transaction
receipts may require operator reconciliation rather than automatic advancement.
Collection can incur fees even when the locking program yields no new earnings.
The interval limits this cost but does not estimate collection profitability.

## Token-2022 parents (20 September 2026)

Buttcoin on mainnet is a Token-2022 mint, so the program and the keeper now treat each parent's token program as a fact read from the mint account, never assumed. On chain (`programs/atomic-launch/src/lib.rs`): a parent mint may be classic or Token-2022; a Token-2022 parent mint may carry only the metadata pointer, token metadata and mint-close-authority extensions, and anything else (transfer fee, hook, permanent delegate, confidential transfer, non-transferable, default frozen, pausable) is refused with error 71; parent custody accounts are decoded under the parent's program; the buy-and-burn instruction takes the parent's token program as its eighteenth account, which must equal the mint account's owner, and uses it for the swap output side and the burn; the pool's recorded token programs must equal the owners of the two mint accounts. Off chain, `localnet/atomic-fees.mjs`, `cpmm.mjs`, `active-fee-keeper.mjs` and `parent-snapshot.mjs` carry the per-mint program. `localnet/token2022-fixture.mjs` builds a Buttcoin-shaped Token-2022 parent for the desktop localnet; `KIDS_PARENT_B_TOKEN_2022=1 node localnet/full-launch-verify.mjs` runs the full launch, claims, fee collection, conversion, distribution and both parent burns with parent B under Token-2022.

Rehearsal result, 20 September 2026, desktop localnet, program SHA-256 `88ddba9dd298b3906de3c821cd98c47b41dbe1893fb494b0017ba027d42a6fb1`: 26 launch and claim checks passed with parents `spl-token` and `token-2022`; both parent burns executed (89,711,851 raw units each for 915,510 lamports); a buy-and-burn built with the wrong token program was rejected on chain. The disposable lifecycle qualification (`localnet/qualify-active-lifecycle.mjs`) then passed its 11 checks in both modes with the keeper collecting, converting, distributing and burning both parents, parent B under Token-2022. The Rust unit suite is 20 tests. This binary is NOT the reviewed SBF pinned by the hosted image (`e0b4…e71d`); shipping it to the hosted localnet needs the deployment artifact and its Dockerfile hash updated through the reviewed path, and mainnet needs the reproducible build and review gates as before.

## Parent buybacks through Jupiter (owner decision, 20 September 2026)

Public launches pair arbitrary parents, so the buyback leg cannot depend on hand-picked pools. The program now has a second buy-and-burn instruction (tag 25) that forwards a Jupiter v6 `route_v2` and verifies its effects; the direct CPMM instruction (tag 24) stays for localnets without Jupiter.

On chain (`programs/atomic-launch/src/fees.rs`): only Jupiter's program may be called; only a `route_v2` (non-shared) is accepted, so the swap's user accounts are the fee custody accounts and the campaign's fee authority signs the transfer; the route's input amount must equal the slice; the slice is capped at 0.5 SOL; slippage is capped at 100 bps; no platform fee; 1 to 8 steps; the quoted output minus the allowed slippage must clear the keeper's minimum; after the call the WSOL custody must have dropped by exactly the slice and the parent custody risen by at least the minimum, and the received amount is burned under the parent's own token program with the supply checked. The route's remaining accounts are forwarded with their writable flags and no signer flags. Jupiter is an upgradeable third-party program (authority CvQZZ23q…), the same class of dependency as Raydium.

Off chain (`localnet/jupiter-route.mjs`): the mainnet fetcher asks Jupiter's API for a non-shared, unwrapped route for the fee authority and refuses anything the program would (shared-accounts route, setup or cleanup instructions, platform fee, slippage above 1%, slice above 0.5 SOL, user accounts that are not the custody accounts); lookup tables from the API are resolved and the keeper sends a version-0 transaction. `KIDS_PARENT_BUYBACK_ROUTE` selects `cpmm` (default), `jupiter-localnet` (a single Raydium CPMM step through the cloned Jupiter program, for rehearsals) or `jupiter` (API). The Jupiter API URL is `KIDS_JUPITER_API`.

Rehearsal, 20 September 2026, on a throwaway validator with Jupiter, Raydium CPMM, the Raydium locker and Metaplex cloned from mainnet (the hosted and desktop ledgers predate Jupiter and cannot clone it without a new genesis): program SHA-256 `409e791147e064590cccc2fba682bb51e569fcfb461b1f1eca7f5c0211f3c034`; full launch, claims, fee collection, conversion and distribution; both parents bought through Jupiter's Raydium CPMM adapter and burned (parent B under Token-2022, 89,711,851 raw units each for 915,510 lamports); on-chain rejections proven for a route quoted below the minimum, a slice above 0.5 SOL, an impossible swap, the wrong parent token program and a replay; then the lifecycle qualification passed its 11 checks with the keeper on the Jupiter path. Rust tests 21. The Jupiter API path is covered by fixture tests only: a mainnet route has not been executed.

Build provenance: the CI workflow `sbf-build.yml` compiles this source on ubuntu-22.04 and ubuntu-24.04 with the pinned Anza toolchain and both produced SHA-256 `ef584ae7555415215b8cda0597cfff8362a7ecdbb31fdc07aa747c3f63368923` (run 35533998732). macOS builds of the same source hash differently (`409e79…` in the throwaway rehearsal), so the Linux CI artifact is the canonical binary for any deployment and for the hosted image's pinned hash.

Still open for mainnet: a reference-price check (Fartcoin has a Pyth feed, Buttcoin does not), the keeper signing service, and a hosted environment whose genesis includes Jupiter.

## Parent buyback venues on mainnet (background, 20 September 2026)

The buy-and-burn leg swaps through one Raydium CPMM fee tier (config index 2). On mainnet neither parent has meaningful liquidity there (Fartcoin about 0.003 SOL, Buttcoin under a millionth of a SOL). Real venues: Fartcoin trades on a Raydium AMM v4 pool (about $8.2M) and newer aggregator venues; Buttcoin trades on its canonical PumpSwap pool (about 3,970 SOL). So the direct CPMM leg cannot execute on mainnet; the owner chose the aggregator route above.

## Reference-price guard for aggregator buybacks (20 September 2026)

`localnet/price-guard.mjs` reads Pyth's sponsored on-chain price accounts (shard 0 under `pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT`) through the keeper's own RPC: the parent's USD feed when the identities file names one, and SOL/USD. Both must be fully verified, at most 60 s old and with a confidence interval under 2%. The keeper's `jupiter` mode refuses a route whose quoted price deviates more than 300 bps from the Pyth-implied price, or whose price impact exceeds 50 bps; a parent without a feed (Buttcoin today) gets the impact cap only and a 0.1 SOL slice instead of 0.5 SOL, and the journal records `referenceCheck: none`. Fartcoin's feed is `58cd29ef…3608`. The guard is fixture-tested; it has not run against a live Jupiter quote yet.

## Operator signing service (20 September 2026)

The keeper, the settlement operator and the launch operator no longer need the operator key in their own process. `localnet/operator-signer.mjs` gives them a signer: the local admin keypair by default (localnet), or, when `KIDS_SIGNER_URL` is set, a remote signer that sends only the transaction message to `localnet/signer-service.mjs`, verifies the returned Ed25519 signature against `KIDS_SIGNER_PUBKEY` and attaches it. The service holds the key (`KIDS_SIGNER_KEY_FILE`), listens on `KIDS_SIGNER_LISTEN` (default loopback 4176), requires a bearer token of at least 32 characters (`KIDS_SIGNER_TOKEN`), and signs only when the fee payer is the operator key, every instruction targets the KIDS launch program (`KIDS_SIGNER_PROGRAM_ID`) or the short allowlist (compute budget, associated token, both token programs, address lookup table), and fewer than 60 signatures were issued in the last minute; it logs sanitized facts (programs, instruction count, version), never message bytes. The operator sender's journal and same-wire resend logic are unchanged: a signature request is never retried on its own. Rehearsal, 20 September 2026, desktop localnet: with the service running as a separate process holding the admin key and the API pointed at it, the disposable lifecycle qualification passed its 11 checks while the service signed all 22 operator transactions (21 legacy, one version-0 launch); its log showed only the launch program, compute budget, associated-token and lookup-table programs and no message bytes. On Railway the service belongs in its own service on the private network with the key on its own volume; that deployment has not been created yet.
