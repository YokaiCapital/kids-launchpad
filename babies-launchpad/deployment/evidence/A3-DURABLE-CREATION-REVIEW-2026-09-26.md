# Durable creation review, 26 September 2026

The next creation boundary is implemented but not enabled in the hosted app.
Schema 11 adds server-owned expiring quotes and one durable creation request per
creator/draft. The review service is loopback-localnet only and requires an explicit
server setup plan. There is no production switch or inferred platform funding.

Quotes bind the authenticated wallet, saved draft revision/hash, exact ledger/program,
manifest hash and setup-plan hash. Client-supplied costs, recipients and owners are
ignored. A duplicate request returns the original quote rather than silently refreshing
its economics. Acceptance atomically freezes the draft and creates one request; another
tab cannot start a second request. A retry after acceptance resumes the same request,
even after quote expiry. Editing a draft requires a fresh review.

Acceptance is NOT a wallet signature, mint reservation, transfer or funded campaign.
The stored state is `accepted` and `fundingEnabled` remains false. The API adapter has
optional authenticated `creation/quote`, `creation/accept` and `creation/status` routes;
runtime composition intentionally leaves that service unset pending the full planner.

The cost reader verifies the network, canonical AMM config and tier, then reads rent
for every planned account size and the base signature fee from the cluster. It accounts
for each auxiliary signature, fee-state rent, recipient token-account rent and bounded
priority fees. The old helper's fixed ATA rent was removed. Unknown or stale network
fees fail the quote; they never become zero. The AMM config can carry a nonzero optional
creator rate while standard pool initialization leaves creator fees disabled; this
matches the existing launch program's enforcement rather than treating that config
field as an extra active pool fee.

## Verification

- 263 focused tests passed, zero failures/skips, including actual PostgreSQL.
- Replica tests cover concurrent issuance/acceptance, expiry, changed drafts,
  cross-wallet/configuration refusal and save-versus-accept races.
- Acceptance creates no wallet packet and leases no mint.
- Existing pilot tests also refuse another wallet on all new routes.
- Read-only actual local-validator quote: 305633706 lamports for the specified test
  plan (8 transactions, 11 signatures, 9 ATAs, one lock/fee state, 10000-lamport
  priority cap, 15% margin); slot 2990, base signature fee 5000, token rent 2039280.
  These are test-plan counts, not a qualified production quote. The clone uses 2%.

## Remaining A3 gates

The quote covers bounded setup only. It is not an all-in promise covering arbitrary
receipt settlement, ongoing keepers, failed setup recovery, storage fees or indefinite
operations. Those funding policies, exact packet planner, durable metadata upload,
inventory-backed mint signing, provisioning budget custody/refunds and external wallet
completion remain to be integrated and qualified. Recheck costs/configuration before
preparing any funding transaction. No creator is charged by this change.

Ultimate-goal comparison: improves explicit financial review and retry safety while
preserving the live system; a full create-to-launch user flow is still not ready.
