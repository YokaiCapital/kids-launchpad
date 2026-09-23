# Market decoder fixtures (public mainnet data)

Fetched read-only from the public Solana RPC on 23 September 2026 with
`getTransaction(signature, {encoding:"jsonParsed", maxSupportedTransactionVersion:0})`
for the Raydium CPMM pool `FAThun8yCqyatCAmcUAfqdmD83zHN3RZieEk6FkB5Zcn`
(coin `8P47V2fj1yfg1C76YAZEXJBVzDJBFfURUUTeJjVJq5bz`, 6 decimals, quote WSOL, 9 decimals).

| file | signature (start) | what it is | expected decode |
| --- | --- | --- | --- |
| swap-direct-buy.json | e93Xu1rk | top-level `swap_base_input` by an ordinary wallet at launch: 20000 lamports in, 3632394060 raw coin out | one buy |
| swap-nested-sell-router.json | 42ESxokn | `swap_base_input` nested under an aggregator route (v0 transaction with a lookup table), then a CLMM leg on another pool: 1383367409292 raw coin in, 1679349 lamports out | one sell, nested |
| swap-nested-sell-fund.json | khdQoaHq | `swap_base_input` nested under the same router by the fee-fund wallet, then a Raydium AMM v4 leg: 4459366261 raw coin in, 5404 lamports out | one sell, nested |
| swap-nested-sell-v1.json | hY5B6iKC | **version 1** transaction (`transactionConfig` in the message): `swap_base_input` nested under the FLASHX8 router: 74992737749797 raw coin in, 96461003 lamports out; fetched with `maxSupportedTransactionVersion:1` | one sell, nested |
| fee-collect-withdraw.json | 3sTyKZB1 | keeper fee collection: lock program `CollectCpFees` calling CPMM `withdraw` (LP burn, both vaults pay out) | no trade |
| collect-fund-fee.json | aMyhsP9h | Raydium `collect_fund_fee` by the fund wallet (both vaults pay out, no swap) | no trade |
| launch-initialize.json | 4x6SEETK | the launch: CPMM `initialize` nested under the KIDS program, plus the lock | no trade |
| swap-failed.json | 4foKpD1A | `swap_base_input` that failed (custom error 6000) | no trade, `failed` |
