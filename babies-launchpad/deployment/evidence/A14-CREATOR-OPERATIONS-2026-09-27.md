# A14: creator operations and reserve visibility

27 September 2026. The restricted Standard creator management page now has an
on-demand, collapsed Launch operations section. It distinguishes unscheduled,
working, queued, unresolved, funding-wait and failed background operations.
Available operating reserves, exact held exposure and actual operating spend are
separate from commitments, tokens, participant refunds and dev earnings.

The authenticated reader binds the requesting owner to the exact registered
creator/network/program/version. SQL aggregates one campaign's budgets and jobs;
it does not return internal reasons, signer grants, private policy identifiers,
packets, wallet secrets or company-wide balances. Negative/inconsistent reserves
fail closed. Opening or refreshing the section cannot create a transaction,
credit money, schedule financial work or authorize spending.

Verification:

- **644 tests pass, zero failed/skipped**, including owner/scope rejection,
  values above JavaScript's safe-integer limit, held exposure, unavailable
  composition, inconsistent accounting and read-only behavior.
- Enabled frontend production build passes.
- Browser checks at 1440, 768, 390 and 320 px pass in React StrictMode. Collapsed
  sections issue no operations reads, unresolved transactions stay explicit,
  stale timestamps are visible, failed refreshes hide old balances, and retry
  succeeds. No overflow or runtime errors. Mobile layout visually inspected.
- Browser plugin unavailable; validation used the existing Playwright fallback.
  Route fixtures cover rendered interaction; PostgreSQL tests cover authorization
  and exact accounting. This is not external-wallet or hosted qualification.

Against the ultimate goal, creator diagnosis and understandable money improve.
This does not decide who funds ongoing operations or provide an unapproved
funding button. The explicit ongoing-cost/bootstrap policy, hosted wallets/media,
representative mixed-chain capacity, coordinated restore and release gates remain.
Public activation and existing funded programs are unchanged.
