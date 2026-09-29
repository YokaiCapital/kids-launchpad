# A25: packet identity, retry accounting and retained history

27 September 2026. Isolated v3 qualification only; no hosted activation or change to funded on-chain programs.

## Observed failures

The fresh 100-campaign / 800-receipt run alongside 100 active pools reached 98 launches and 98 completed refund jobs. Four jobs retained attempt-one reconciliation facts while attempt two had already been prepared. Looking up the latest packet rejected those valid older references indefinitely. A controlled process drain preserved every packet and operating hold.

After that lookup was corrected, recovery exposed a second bug: nine reconciliation checks had consumed the eight-attempt transient retry limit. An unsigned expired refund preparation then incorrectly exhausted the retry budget. That run is retained as failed evidence, not counted as a successful capacity qualification. No job row or packet was deleted to manufacture a pass.

## Corrections

- Reconcile the exact immutable `(operationId, attempt)`, checking signature and ledger/program scope. A later preparation cannot replace or strand earlier terminal evidence.
- Count actual transient retries independently from uncertain-transaction checks. Polls remain observable and backed off; they cannot exhaust the execution retry budget.
- Require a recorded blockhash context slot, finalized expiry, two signature-history reads, sufficiently fresh RPC context, and a retained-history boundary before and after the second read to declare a missing signed packet expired.
- Store that context for new operator packets and creator mint/setup offers. Operating-cost expiry checks use the same retention guard. Old signed packets without evidence stay unresolved if history is missing; confirmed/finalized evidence remains usable. Never infer expiry merely from a timeout or absent history.

## Validation and limits

704 regression tests pass, zero failures/skips, with real disposable PostgreSQL, restore tools and media codecs enabled. Tests cover both journal engines, crash boundaries, newer-attempt races, pruned history, pruning during a lookup, missing historical context, and twelve reconciliation polls followed by a genuine transient retry.

The failed large fixture still requires an explicit audited recovery path. The fresh-close lifecycle queue targets were also missed independently of these correctness bugs. Neither issue is concealed by successful HTTP load or small-chain smoke results. Production operating-funding policy, hosted capacity/recovery, external wallet/provider verification and release review remain open.

## Fresh actual-chain follow-up

The separate two-campaign smoke completed with 16 verified receipts, exactly 2 SOL accepted and 2 SOL refunded, both locks verified, no held operating exposure and no unresolved signed packet rows. All six independent workers started before the deadline. This is a correctness smoke, not a large-load claim. The subsequent A26 record covers audited recovery of the retained larger fixture.
