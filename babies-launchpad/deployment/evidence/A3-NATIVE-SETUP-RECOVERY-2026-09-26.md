# A3: native setup retry — 26 September 2026

Schema 21 gives native-custody approvals their own immutable revision sequence,
separate from campaign creation. Recovery retains all original terms and requires
terminal signature evidence, finalized expiry of all old offers, no existing
campaign and unchanged mint custody. Existing native custody is verified if
present; the instruction remains the SPL idempotent ATA creation instruction.
A fresh creator signature is required. Recovery itself never broadcasts.

The same refresh/approval lock and generation check reject an old signature after
recovery. Recovery also closes a previously signed outbox record as failed or
expired in the same transaction as revision creation. It does not leave the old
record apparently unresolved after admitting a successor. Old signed bytes and
all evidence are retained.

PostgreSQL tests exercise eight concurrent native recoveries, immutable creation
timing, rejection of the old offer, successful finality of the replacement,
subsequent independent creation recovery, and refusal of unresolved/successful
signatures. The full regression suite passes **395 tests, zero failures/skips**:
`/tmp/kids-native-recovery-regression.log`.

This extension is qualified with database/executor tests. The preceding fresh-
mint localnet rehearsal qualified creation-timing recovery and both original
setup instructions; it did not exercise an expired native approval on-chain.
No production configuration, existing program or funded campaign was changed.

Ultimate-goal check: another early wallet failure can now be recovered without
changing mint/economics or replacing an unresolved transfer. Remaining A3 work
includes mint-signing expiry, full creator UI/service composition, operating
funding and external-wallet/hosted qualification. It is not production readiness.
