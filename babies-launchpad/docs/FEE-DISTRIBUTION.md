# Fee distribution and parent buybacks

Approved nominal breakdown per trading volume:

| Destination | Rate |
| --- | ---: |
| KIDS treasury | 0.98% |
| Coin dev | 0.20% |
| Parent A buyback and burn | 0.25% |
| Parent B buyback and burn | 0.25% |
| Raydium protocol/fund | 0.32% |
| Total | 2.00% |

Raydium accrues LP earnings within pool reserves. The program collects child tokens and WSOL into separate fee-authority custody, converts child earnings through its own canonical pool, then allocates **actual realized WSOL proceeds** in cumulative weights **98:20:25:25 over 168**. Conversion incurs pool fees and market execution costs. These are weights of LP proceeds, not percentages to reapply to proceeds. The volume equivalents assume our locked position owns all fee-earning liquidity. Other liquidity providers dilute its share of LP earnings. Actual realizations and buyback execution prices vary; the nominal volume table is not a guarantee of realized proceeds per transaction.

For Shartcoin (`$Shartcoin`; internal key `SHART`), parent buyback targets are Fartcoin and Buttcoin. The two budgets have equal spending allocation; acquired and burned token counts depend on each token's price. Buying parent tokens is not itself a burn: a confirmed SPL burn must reduce the relevant mint's supply.

## Implemented in the separate v3 localnet program

`programs/atomic-launch/src/fees.rs` signs Fee Key collection with the campaign PDA. Collected assets belong to the separate `fee_authority` PDA, never the participant claim reserve. Actual receipt deltas exclude unsolicited token donations. Creator-authorized keepers can convert child fees, distribute fixed treasury/dev shares, and execute each parent's pending WSOL budget. They cannot choose another recipient or parent mint.

Each cumulative entitlement is `floor(realizedWSOL × weight / 168)`. Previously paid amounts and parent spending are tracked separately; retries cannot pay or spend a budget twice. At most three unallocated raw units remain in custody. The arithmetic module `localnet/fee-distribution.mjs` supplies the same weights; the on-chain settlement asset is WSOL, not a sum of unrelated token units.

Swaps require a creator signature, positive minimum output, and an expiry no more than 120 seconds ahead of chain time. Minimum output must be at least 98% of the execution-time constant-product quote after fees. Both conversion and parent purchases use canonical Raydium CPMM index 2, with the approved 2%/12%/4% trade/protocol/fund configuration and creator fees disabled on the pool. Other pools, routes and token programs are not supported by this integration.

Each parent purchase and SPL burn executes in one transaction. The program burns only newly acquired tokens, verifies the mint's supply decreased, and preserves any previously donated tokens. A failed swap or burn rolls back spending and keeps the budget available. This is an SPL supply reduction, not a transfer to a dead address.

Builders: `localnet/atomic-fees.mjs`. Real localnet harness: `localnet/verify-atomic-fees.mjs`. The final combined build passed 26 launch/claim checks and 9 fee checks against SHA-256 `e0b4051752422366e51ae6a5fe8eaeeeab773faa1448cec33a0990961c76e71d`. Nothing here enables mainnet trading or migrates the active public v1 UI.

## Trust and production limits

- The creator keeper selects transaction timing and supplies quotes. The spot-price bound is not an external oracle, manipulation defense or complete MEV protection.
- Parent mints and treasury/dev recipients are fixed in campaign terms. Parent snapshot roots still trust the authorized publisher; proof verification does not independently establish historical balances or snapshot completeness.
- The v3 program remains upgradeable on isolated localnet. Canonical index-2 parent pools must exist and have adequate liquidity. Missing routes retain budgets; there is no fallback to an arbitrary venue.
- Raydium's Burn & Earn dependency is closed source. Testing its executable is not an independent audit or production immutability guarantee.
- Runtime reports record collection, conversion, distribution and burn signatures, actual spending, burned quantities and retained budgets. Independent security review and production deployment verification remain required.

The 3% dev token allocation remains unchanged: 1% of supply at launch and 2% linear over three UTC calendar months. The nominal 0.20% trading-fee share is separate from this supply allocation. Other LPs dilute our fee-earning share, and conversion/trading costs affect realized proceeds.
