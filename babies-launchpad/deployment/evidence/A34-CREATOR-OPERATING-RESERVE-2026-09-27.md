# A34: creator operating reserve on the isolated ledger

Date: 27 September 2026, 21:03 UTC. Branch: `feature/public-launches`. Isolated creator ledger
(127.0.0.1:19199, rebuilt version-3 program) only; no hosted service, real wallet or funded coin
was touched. Owner decision implemented: option 1, first part (creator-funded reserve).

## Result

The full creator HTTP rehearsal (`localnet/creation/qualify-creator-http.mjs`) ran the whole
journey through the real API composition, real PostgreSQL sessions and the browser controller,
with a fourth wallet approval that funds the operating reserve:

| Measure | Value |
|---|---|
| Independent wallet approvals | 4 (mint, native custody, create campaign, operating reserve) |
| Service restart and resume mid-journey | true |
| Campaign | `BcC8qeSqQ1ARidDedspML1LA2oSb8y7SMf9KEoejvAFU` |
| Mint | `592EiTBF7z1adgLaA7LJvjSUEKDt3dLCTjBh9E7Rkids` |
| Reserve transfer signature | `55xVzMssvLbRG16b8oqmdJdiyBtHNDGtnRQJ4LtVLGNQti46aZAPXN1tSeR22QhYNWGc6qGFf91m94sWyrTKxWMn` |
| Reserve paid to the keeper payer | 0.100 SOL to `5wL76N2RJAMCEGyDS6rkvpd57WeReg16VJPZaKeto61n` (finalized balance delta 100000000 lamports, slot 167260) |
| Campaign operating budget after credit | reserved 100000000 lamports, spent 0, policy `creator-funded-v1` |
| Read-only discovery jobs after registration | 3 (campaign, activity, position index) |
| Worker activation | false |

## What the step does

- The quote shows the reserve as its own line (separate approval after creation), with the
  refill share and floor from the manifest; the numbers come from the terms, never from fixed
  text.
- After registration the flow offers one transfer from the creator to the keeper payer for the
  sealed amount plus a memo bound to the campaign (`KIDS operating:` and the canonical hash of
  the funding terms). The browser rebuilds that transfer byte for byte from the accepted quote
  and refuses anything else (`creator-signing.mjs`).
- The offer lives in the durable operator-packet journal under one identity per campaign, payer
  and policy. A stale unsigned offer is superseded; an expired signed packet needs explicit
  recovery and a fresh attempt; the same bytes are re-broadcast, never different ones.
- The campaign's operating budget is credited once, only after the finalized transaction's
  balances reconcile, through the same ledger and proof reader the keepers spend from
  (`localnet/creation/operating-ledger.mjs`, `operating-proofs.mjs`).

## Not proven here

- Refill from the coin's own treasury fee share and the return of unused reserve after refunds
  are not implemented yet (register, operating funding policy).
- The hosted creator flow composition (payer = the release manifest's signer public key) is
  still open; this run used the rehearsal's local treasury key as the payer.
