# A3 funded signer boundary — 26 September 2026

Status: isolated v3 signer/HTTP/outbox/budget integration qualified. No production
funding model, custody policy, recurring worker or public activation is selected.

## Implemented

- The new v3 registry signer refuses startup without an operating-budget adapter.
  Legacy/v2 paths retain their existing behavior. This is an explicit service
  composition, not a hosted environment flag or bypass of activation gates.
- The adapter binds a request to the current durable worker packet, attempt,
  campaign, chain, payer, exact bytes, auxiliary signatures and operation key.
  It accepts cost templates only from a trusted server reader. HTTP input cannot
  classify its own cost or provide a funding receipt as proof.
- PostgreSQL reserves campaign exposure before the final live-lease check.
  There is still no awaited operation between that final check and local signing.
  Signed bytes are saved in an independent budget journal before any signature
  response. A worker crash cannot erase the signer's financial evidence.
- Insufficient funds, expired packets, altered references and storage uncertainty
  return no signature. Same-packet retries reuse the hold and signed record.
  Network errors and unknown outcomes retain the full exposure.
- Signed outcomes use the finalized-chain proof reader. Unsigned expiry is
  specific to this persist-before-response protocol: finalized block expiry and
  a compare-and-set transition prevent a concurrent signature from being returned
  after releasing its hold. A winning signature persistence instead requires
  normal signed-transaction reconciliation. This is not a general rule allowing
  an absent signature to be treated as a failed broadcast.
- Schema 24 makes a message unique per chain/payer across operating IDs. Testing
  exposed that different logical IDs could otherwise reserve/charge identical
  signed bytes more than once. Existing conflicting records make migration fail;
  financial history is never silently deleted or merged.

## Tests

The main bounded regression passed **454 tests**, with **34 additional legacy
signer/operator tests** passing. Subsequent focused checks passed **13 tests**,
adding direct PostgreSQL uniqueness enforcement and before/after-persistence
failure cases. These counts overlap and must not be added together.

Checks cover unfunded denial, altered journal references, two requests competing
for one remaining budget, same-packet replay, restart, RPC outage, finalized
charging, signed/unsigned expiry, lease loss, no signature on a failed storage
acknowledgement and refusal after an unsigned-expiry decision. No product deadline
was relaxed to pass these checks.

## Actual local-chain rehearsal

`localnet/creation/qualify-operating-signer.mjs` verified the isolated v3 deployed
binary and the test campaign's creator/treasury before making any transaction.
The existing HTTP remote signer client and durable sender initialized the fee
state on the campaign created in the preceding lock qualification.

- Campaign: `2xkfcfcgKpUtGPf8S9jgpPnepEV3btiMj86pw3JqAW2D`
- Operating funding: `ANPjgCi2QWCMC9btyQLW5AFye7bcU96EUcVAY33GrJVfuGcSPWqrVpmyNUvfY5F5i5wJFaTWbUUiAEe2mie2siV`
- Fee initialization: `5tjs1YJk6mSxb8QHd68uNzrdKp5siiRmomRaF4pHo8UqFkzn2rLBUNV52YT9EX8F9X9bkeF3N3Tjn9sEEoeWzyFY`
- Before funding: refused, no broadcast.
- After funding: interrupted after durable signing, before broadcast.
- Reconstructed budget service: same held signature resumed and broadcast once.
- Finalized actual cost: 2,009,480 lamports; available balance: 990,520 lamports.
- Duplicate send/reconciliation: no new broadcast or additional charge.

Only a disposable registry, a loopback signer and an owned local test campaign
were used. Test keys, bearer tokens, signed private packets and logs remain out
of the repository. No mainnet program, old funded campaign or hosted service changed.

## Ultimate-goal comparison / remaining work

Verifiable money and interruption recovery improve with a funded signing boundary.
Overall readiness remains partial. Hosted payer/funding/subsidy and minimum-commit
policy still need explicit terms; the qualified cost-reader composition must cover
each permitted worker packet, including standalone ATA creation. Budget maintenance
needs a dedicated reconciler and operational visibility so held transactions do not
depend on manual status calls. Activation/readiness must enforce these dependencies.
External wallets, hosted media/video, mixed RPC/signer workload testing and release
evidence remain required. Generic low-level signer fixtures are not a production
activation route; the v3 registry composition is the required new-program entrypoint.
