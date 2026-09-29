# Shared operational accounting and capability checkpoint

26 September 2026 · `feature/public-launches` · no production changes.

Campaign budgets now require stable operation keys. A credit, spend reservation or
return and its idempotency record commit together. Repeating a request returns its
original result; changed parameters are refused. This includes insufficient-budget
results: after funding changes, a fresh decision uses a new operation key. No RPC or
signer call runs inside a retried database transaction.

PostgreSQL serializes only the same full campaign/payer budget identity. Concurrent
workers cannot spend the same remaining balance, draw on another campaign's credit or
use another payer's reservation. Counters use integer decimal strings and reject spends
plus returns exceeding reservations. Quotes reject negative fees and malformed counts.

This is accounting infrastructure, **not evidence that a wallet funded an account** and
not a transfer executor. Runtime integration must bind credits to verified chain evidence,
reserve spend before signing, reconcile actual costs once, and never return funds that
an unresolved signed transaction can still spend. That integration remains a release gate.

Signer capability loading awaits PostgreSQL, and stored grants now preserve an explicit
program version. Existing grants default to version 1, retaining their prior semantics;
new version-2 grants must request version 2. This does not broaden permitted tags or
change the live signing service. Its admission budgets and registry-backed lease checks
still need integration with the new role runtimes.

## Evidence and ultimate-goal comparison

The combined local gate passed **110 tests, zero failures or skips** before the additional
quote-validation assertions. It includes real PostgreSQL replicas, local HTTP/signing
tests, operator crash cases and database restore. Twenty simultaneous copies of one
credit add it once. Twenty distinct 100-lamport debits against 1,000 lamports admit exactly
ten; replaying all requests changes nothing. A second replica sees grant version and
revocation correctly. The quote-validation tests are part of the subsequent verification.

Money/permissions and shared-state recovery remain **partial, improved**. Full creator
flow, inventory release/signing races, physical worker isolation, RPC/signer capacity,
fee orchestration, mixed-load testing and hosted operational readiness remain incomplete.
These changes are preserved local checkpoints, not public launch sign-off.
