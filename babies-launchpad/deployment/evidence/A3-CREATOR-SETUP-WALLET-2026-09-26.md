# A3: creator setup wallet boundary — 26 September 2026

Implementation and local qualification only. Public creation and hosted service
composition remain disabled. No deployment, mainnet transaction, or existing
program/economic change was made.

## Implemented

Schema 19 stores immutable, wallet-owned setup offers for native SOL custody and
campaign creation. Each offer binds the accepted setup intent, exact transaction
bytes and server-owned blockhash expiry. Only one unsigned offer per stage can
be open. Parallel replicas converge on that offer instead of invalidating each
other's wallet prompts.

Preparation and approval share the operation's PostgreSQL advisory lock. The
executor checks the offer again inside the transaction that records signed bytes.
A superseded signature cannot win after refresh, even when its earlier RPC checks
were still in progress. Submission never trusts browser-supplied expiry, amount,
recipient, instruction or stage. Approval records bytes before any broadcast.
The internal record method is not directly exposed to HTTP.

An approved offer is never silently replaced. Duplicate submission returns its
existing signature, including after expiry. Pending/unknown broadcasts remain
reconcilable using the same bytes. Failed or expired signed operations require
attention; replacement generations are not enabled by this change.

Campaign signing requires finalized native custody. The review returns the exact
campaign, mint, caps, opening/deadline, reserve destination and reserve amount.
Its cost coverage says **pool initialization only**, not an all-in operating fee.
An expired opening time produces a review-schedule result without a transaction
or a silent date change. Wallet preparation RPCs have bounded deadlines.

The optional account service accepts POST actions at:
`/api/account/launches/creation/setup/{prepare,submit,status,resume}`.
These routes use the existing signed wallet session, pilot allowlist, origin and
CSRF checks. Owner fields supplied in the body cannot select another wallet.
Missing setup service returns unavailable. Prepare, submit and resume are blocked
by the financial startup/reconciliation gate; status remains readable. Resume is
classified as a write because it can rebroadcast previously approved bytes.
No production composition or UI create capability was turned on.

## Verification

- 385 tests passed, no failures/skips, in the registry/jobs/creation/signer/market/
  wallet/auth regression suite. Log: `/tmp/kids-provision-wallet-regression.log`.
- PostgreSQL race tests use real executor journals and synthetic RPC responses:
  ten parallel preparations/submissions converge; old in-flight approval loses
  to refresh; tampered/unsigned/wrong-stage packets and wrong owners fail;
  unknown sends and expired signed requests cannot produce replacement offers.
- An added assertion explicitly exercises confirmed-but-not-finalized native
  custody. The focused suite was rerun: 7 passed, no failures/skips.
- HTTP tests sign actual synthetic wallet challenges and exercise authenticated
  requests through AccountStore and the API runtime. Wrong session, origin and
  CSRF are rejected; body-owner spoofing cannot change the session owner;
  reconciliation blocks writes without blocking status. The setup handler is a
  fixture in these HTTP tests; PostgreSQL/executor tests cover its implementation
  separately. This is not a real browser-extension or chain rehearsal.
- Production bundle builds. Log: `/tmp/kids-provision-wallet-build.log`.
- Publication scanner checked 804 files with zero pattern findings. This is not a
  guarantee that no secrets exist. No source was published by this work.

## Remaining gates

- Immediate-start signing-delay recovery and reconciled replacement generations.
  A sealed opening time currently has a 30-second approval preflight margin.
  Native custody can take long enough to exhaust it. The current refusal is safe,
  but not a complete creator experience. Do not widen dates silently or rebuild
  unknown signed transfers. Design recovery around finalized expiry, account
  evidence, immutable approved terms and a new explicit wallet review.
- End-to-end creator progress/resume UI and composition, including existing mint
  signing, setup, registration and external wallet qualification.
- Complete operational funding policy, budget caps, return accounting and worker
  activation. The pool reserve alone cannot fund lock/fee-state/receipt work.
- Private media/provider qualification, public profile publication, independent
  security review and mixed hosted load/recovery evidence.

## Ultimate-goal check

This closes the owned setup-signing boundary and its concurrency/authentication
risks. It preserves isolation across campaigns and existing funded programs.
It does not yet satisfy the complete creator journey or public production gate.
