# A16: canonical 2.5% launch rehearsal

27 September 2026. The previous isolated validator retained the older 2% AMM
configuration. A separate local ledger now clones the qualified v3 program and
venue programs, plus the canonical public 2.5% configuration. It does not reset
or change the original validator, any live deployment or any funded coin.

The bootstrap rejects an occupied RPC port, wrong source genesis/program binary,
wrong AMM owner, discriminator, PDA, index, fee rates or disabled pool creation.
The externally read account was public chain data. Local key files remain private
runtime inputs; they are not included in this evidence or any repository asset.

Canonical configuration: `ESLj2Rzmvn3RhDo4Z18hY1wYmGyC9xM4ZtRXhvoFkDAi`
(index 7). Account-data SHA-256:
`7d060a13c637a9254090ed5d18afb90f53d0779a904a70ba1a1bf9eaf2940ce6`.
The new ledger is loopback-only, with genesis
`JDaL29FzwQ8LjBGpMArZpfVNKP5UBbaatjkehtFg3ebp`.

Actual-chain result:

- Campaign: `2gvswNGdnGAqw1P2RgEHMbt7sNsj5UiQrMsYKxXErSeg`.
- Mint: `4xf9SBvL9DMGefHLrk6cXshdGz52KjjpmCQAJhGVcEkk`.
- Controller and signer journal restart; automatic settlement, launch, 1 SOL
  excess refund, fee setup/activation and three independent initial fee jobs.
- Participant/dev claims, setup return, token burn and buy finalized. Opening
  candle and buy indexed; 11 activity events include exact refund/claim values.
- Current custody and lock verification passed after those transactions.
- Operating funding 40,000,000 lamports; actual spend 18,399,400; held zero;
  available 21,600,600. These are local test amounts, not a production quote.

An initial fixture failed safely because its finalized clock lagged beyond the
program's opening-time tolerance on the loaded validator. Scheduling now uses a
current confirmed chain clock with a longer test funding window; financial
assertions still require finalized state. No contract checks were relaxed.

Against the ultimate goal, the new fee preset is qualified through a joined local
lifecycle. This is one campaign, not fleet capacity, hosted throughput or external
wallet qualification. The run started before A15's clock implementation was
loaded; the forthcoming multi-process fleet rehearsal exercises that version.
Public activation, operating funding policy and other release gates remain open.
