# Role composition and real-program checkpoint

26 September 2026 · feature/public-launches · isolated rehearsal, not production.

## Delivered

- Independent local worker entry point for lifecycle (settle/readiness/launch) and refund
  lanes. It imports no API, legacy keeper, fee timer or market indexer. New workers require
  PostgreSQL, a matching schema, shared RPC/signing admission, exact genesis/program
  binding and an executable local program before leasing work.
- Atomic lease queries exclude other ledgers, programs and campaign versions before
  selecting a job. The refund worker serves only its implemented refund class; it does
  not claim unimplemented claims or generic reconciliation work.
- Registry-backed signer composition scopes grants to one ledger/program, requires v2
  capabilities and live leases, and refuses requests that omit their campaign. Existing
  production startup remains unchanged. Signer state is still a single-writer volume.
- Capability replacement is serialized per campaign with a monotonic ordering timestamp;
  concurrent same-millisecond grants cannot choose the winner by random UUID ordering.
- End-to-end test supports PostgreSQL as well as SQLite and fails explicitly when required
  validator prerequisites are missing. It exercises current registry-backed signer checks.

## Verification

143 focused tests passed, zero failures/skips. This includes PostgreSQL scope exclusion,
independent capacity, capability replacement/revocation, process composition and legacy
regressions. CI now includes the registry-signer integration test.

The current Rust program built for SBF with the **localnet-treasury** feature. There were
no stack-frame overflow warnings. Its source was not changed in this checkpoint.

Two actual-validator runs passed: SQLite-backed and PostgreSQL-backed, each with a
successful oversubscribed Standard campaign and a failed-minimum campaign. The test
simulates a paused/crashed runner after two successful settlements, then lets another
lease holder finish. It verifies the stale runner sends no further transaction and that
the signer refuses the old token. This is not an OS kill or mixed-load benchmark.

PostgreSQL run:

| Check | Observed |
|---|---|
| Accepted SOL | 1,999,999,998 lamports, proportional integer rounding |
| Excess refunded | 1,323,456,791 lamports, verified at participant wallets |
| Failed campaign refunded | 1,200,000,000 lamports, all commitments returned |
| Operator sends | 13 confirmed, 0 failed, 0 unresolved |
| Pool | Created; canonical pool/vaults and fee NFT verified |
| LP | Permanently locked, except AMM's fixed minimum liquidity; launch authority holds zero LP |
| Child mint | Mint and freeze authorities revoked |
| Claims | Participant amounts reconciled; repeat claims do not pay twice |
| Dev vesting | 1% initial entitlement plus elapsed linear share verified |

Local-only identifiers, **not mainnet deployment addresses**:

- Genesis: `7Sxh5h588K957C1to4Pvx6zQY6CLpghPCeG3ZeyrZJef`
- Program: `C92rDge6sQFBcWetywn3NgHRXQUiqZenr2cG1guwRxYE`
- SBF SHA-256: `056fcda7963baf8c3fff0a771a88e9a8aec05d8f21543ea47badbb9f8e010b14`
- Pool: `4ifSmgpqsmbtKBqdq7zAh9Q7UM7tjXn6WyaqHvTV116m`
- Launch signature: `33FiyvwvndmDuqRB7gxjd7JUpaDUhhKAs27v3nVi7Rfqyv28AVEAW9Rx19ZdSG2tk72jeqiiexRJx2DrSECVs3oa`

The actual-validator test uses generated ordinary mints; it does not qualify a vanity mint,
creator browser flow, hosted signing, wallet compatibility or fee recycling. PostgreSQL
runners in this test share one pool; separate-pool races are covered by focused DB tests,
not by a claimed distributed validator benchmark. No production funds or ledger changed.

## Ultimate-goal comparison and remaining gates

Money-flow correctness now has **actual-program local evidence**, beyond emulation.
Multi-coin production operation remains **partial**: role code alone is not deployment.

Next: extract fee harvest/economics/live-index/backfill runtimes with their own capacity;
finish durable creator provisioning and usable vanity-mint qualification; connect the full
approved interface; then run representative combined load, wallet and security gates.
The new worker entry point deliberately rejects public/mainnet activation. Direct LP
recycling, reserve sales and Auto MM remain separately versioned, disabled workstreams
with the unresolved decisions recorded in the controlling plan.
