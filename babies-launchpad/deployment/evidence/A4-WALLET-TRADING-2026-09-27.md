# Per-campaign wallet trading and recovery

The private Standard v3 flow now has a wallet-owned buy/sell service and a compact
trade panel. It reuses the existing CPMM packet builder, slippage math and signed
message validation through `localnet/trade-packet.mjs`. The legacy service imports
those same primitives; it does not gain a new program ID or changed economics.

The new service binds genesis, program, campaign, sealed terms, live pool, fee
config, reserves, mint authorities and wallet accounts. Quotes expire after 30
seconds. The actual pool tier supplies the displayed fee; the local rehearsal
pool charges 2%, and the 2.5% tier is separately exercised by the packet tests.
Browser decoding checks the exact pool, signer accounts, amounts and slippage.
The user wallet and a browser-generated temporary WSOL account sign; no operator
key signs trades. Temporary account rent returns to the same wallet.

Approved bytes are stored in PostgreSQL before broadcast. A lost acknowledgement
remains unknown. Retries and the authenticated resume endpoint use only the stored
signature/packet, including after a browser reload or service replacement. The
financial pause covers prepare, submit and resume; status/cancel remain available.
Confirmed packets can advance to finalized. Missing, pruned transaction history
does not automatically become a failed or expired transaction.

The local HTTP composition requires an explicit shared `wallet-trade` admission
policy. Actual fetches abort after eight seconds and SDK rate-limit retries are
disabled. A timeout during a send is treated as ambiguous, not permission to
create another swap. An unsigned restored quote is labelled as unsubmitted,
instead of saying its signature is being confirmed.

## Verification

- The broad regression executed 574 tests: 572 passed initially; a recovery
  subtest and its enclosing suite hit the existing 12-second deadline during
  heavy local load. That unchanged recovery suite and the updated UI copy tests
  then passed independently: 24 tests, zero failures/skips. The timeout was not
  relaxed in production code.
- The subsequent trade/resume, HTTP authorization/pause and admission regression
  passed five tests. Two admission/transport tests additionally verify method
  binding, refusal before upstream calls, and actual HTTP abort.
- Browser checks used the actual wallet hook, actual cryptographic signatures
  and mocked HTTP: one wallet approval, one initial submission, one saved-packet
  resume after remount, editable slippage, unsigned sell cancellation and invalid
  slippage rejection. Widths 1440, 768, 390 and 320 had no horizontal overflow or
  browser errors. Visual inspection corrected input styling and mobile controls.
- Chart regression passed at the same widths: real canvas, opening reference,
  eight trades per page, intervals, stale warning, foreign-pool refusal and
  disconnect cleanup. Production frontend build passes.

## Actual local chain

Existing owned localnet campaign
`62Vz43SXYiVv3eYJEQAtaz16ETNbAffHDGMH1LADVNQL`, mint
`CEgLNoDmk4bWT7fsZz9MT7udxf43QEQDUVbK6r48Ay98`:

- Buy 1,000,000 lamports: `5ge54sxhqzLWf3HQe3mVoDKwXW6PR2RbGBajaeDG291ujrfmMd5g7cxa7oRXPqbWYBXvxZMtnpe87RxhPrcsaee3`.
- Sell 417,396,264,287 base units: `2DRaXL3kHupBttU7ZQM8wAbLkgagdNJEsuphfv1Mxc2CpRzusWcYrSQihCmrfQZUq9JAQCJChxpwiVQQCLdJzYgQ`.

Both finalized through a newly instantiated service. Both temporary accounts
closed. Earlier 60-second local finality waits timed out while transactions were
confirmed; read-only checks established finalization before another rehearsal.
The qualification harness allows ten minutes per side on a loaded local machine
and reports the exact signature on timeout. This is not a production latency SLO.

## Release boundary

This improves the participant journey and transaction recoverability to partial.
It does not activate hosted trading, fund public creation, alter existing coins,
or certify mainnet/wallet-provider compatibility. Full activity/fee projections,
portfolio coverage, funded creator activation, mixed-load and hosted restore /
security qualification remain separate gates. No public production-ready claim
is made by these results.
