# Chunked settlement and refund recovery drill, 2026-09-25

Localnet only: in-memory chain emulation of one kids-launch-v2 campaign (`localnet/protocol-v2/chain-emulation.mjs`), the job runner (`localnet/jobs/runner.mjs`) and the settle and refund handlers (`localnet/jobs/handlers.mjs`). No network, no keys, no real program. Rerun: `node localnet/protocol-v2/recovery-drill.mjs --receipts 196 --crash-after 73 --write deployment/evidence/A1-RECOVERY-DRILL-2026-09-26.md`.

Result: PASS (every scenario finished, no receipt settled twice, no lamport refunded twice, the stale runner wrote nothing).

Campaign: 196 receipts, committed 347332090 lamports, hard cap 260499067 (oversubscribed), soft cap 34733209.

## settle crash and restart

- receipts: 196
- crashAfter: 73
- landedAtCrash: 73
- leaseHeldByCrashedRunner: true
- finalState: done
- settleCallsTotal: 196
- settledOnChain: 196
- settledTwice: 0
- settledAcceptedMatches: true
- settledAccepted: 260498945
- expectedAccepted: 260498945
- fencingTokenAtEnd: 4
- attempts: 1
- resultCategory: null

## refund crash and restart

- receipts: 196
- settledBefore: 196
- crashAfter: 65
- landedAtCrash: 65
- leaseHeldByCrashedRunner: true
- finalState: done
- refundCallsTotal: 196
- refundsLanded: 196
- refundedLamports: 86833145
- expectedRefundLamports: 86833145
- refundedMatches: true
- receiptsOverRefunded: 0
- fencingTokenAtEnd: 5

## stale runner refused

- receipts: 20
- staleSideEffects: 0
- settleCallsAfterFresh: 0
- settledOnChain: 20
- settledBeforeStaleAttempt: 20
- finalState: done
- resultPublishedBy: fresh
- fencingTokenAtEnd: 2

## ambiguous send reconciled

- receipts: 30
- ambiguousReceipts: 2
- outcomes: unknown > unknown > done
- finalState: done
- settleCalls: 30
- settledOnChain: 30
- settledTwice: 0

Scope: the emulation proves the runner, the fencing and the handlers; it does not prove RPC behaviour, the signer or the real program. Those are P5 gates.
