# A3: operating exposure accounting

Isolated implementation on `feature/public-launches`. No hosted endpoints,
creator payments, signer budget hook, grants, worker activation or deployments.
This is an accounting/proof boundary, not a custody policy or release approval.

## Implemented

- Schema 23 stores finalized funding receipts and exact-message spend holds.
  A funding signature can credit only one campaign/payer on a ledger.
- PostgreSQL serializes credits, reservations, generic spending and returns
  under the same campaign/payer lock. In-flight signatures retain their full
  exposure across restarts. A confirmed transaction is not finality proof.
- Exact signed packets, chain identity, finality, source/destination balances
  and transaction fees are independently checked. Unknown, unavailable and
  malformed evidence does not release funds. Finalized expiry requires a fresh
  transaction-history check; finalized failures still incur their network fee.
- The qualified cost decoder handles network-fee-only packets. Account rent,
  transfers and incoming payer funds are refused, not silently treated as fees.
- A candidate memo-bound operating transfer builder is present for qualification;
  it is not a decision to route user commitments to a wallet. Commitments remain
  program escrow. Hosted operating-funding custody and economics remain open.

## Evidence

The 430-test regression passed with PostgreSQL and restore checks enabled, zero
skips. A subsequent malformed-execution-status case and focused accounting tests
passed (12 assertions/subtests in the focused run).

The owned local validator qualification used a fresh test payer and isolated
registry schema. Eight duplicate credits produced one 1,000,000-lamport credit.
The pending signature retained a 10,000-lamport reservation. Finality charged
5,000 lamports, released the remainder and reconciled 995,000 available lamports
with the payer's actual balance.

- Genesis: `7Sxh5h588K957C1to4Pvx6zQY6CLpghPCeG3ZeyrZJef`
- Funding: `yaaxTkPLGJHatGxhAgt54ouuQMCMxMYj24tVeuHieVK3bGQhtkpncvbG5Kgjnuc2S8b9rEDnFUBJevTTM9vFv5h`
- Fee transaction: `41Ltpf3htN4MidsUCgHVg16n3di1crXJUSixGZwws17JHB246v4yaB2bECMirCTbkt5GMHSEUpYnRgWouXGjdETx`

Local signatures are not mainnet evidence. Reproduce with
`localnet/creation/qualify-operating-accounting.mjs` using its guarded local
manifest and an isolated PostgreSQL test database.

## Ultimate-goal comparison

Concurrent campaign isolation advances; full operating lifecycle remains partial.
Review found that the generic signer estimate omits rent paid through launch/fee
initialization CPIs. New-version signing needs bounded CPI cost exposure before
activation. Full funding policy, cost settlement beyond fee-only transactions,
signer integration, multi-campaign qualification and release gates remain open.
Legacy funded programs and production behavior are unchanged.
