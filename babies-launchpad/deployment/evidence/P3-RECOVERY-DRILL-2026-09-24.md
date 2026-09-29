# P3 recovery drill, 24 September 2026

Localnet only: in-memory chain emulation of one kids-launch-v2 campaign (`localnet/protocol-v2/chain-emulation.mjs`), the job runner (`localnet/jobs/runner.mjs`) and the settle and refund handlers (`localnet/jobs/handlers.mjs`). No network, no keys, no real program. Rerun: `node localnet/protocol-v2/recovery-drill.mjs --receipts 200 --crash-after 73 --write deployment/evidence/P3-RECOVERY-DRILL-2026-09-24.md`.

Result: PASS (every scenario finished, no receipt settled twice, no lamport refunded twice, the stale runner wrote nothing).

Campaign: 200 receipts, committed 357588100 lamports, hard cap 268191075 (oversubscribed), soft cap 35758810.

## settle crash and restart

- receipts: 200
- crashAfter: 73
- landedAtCrash: 73
- leaseHeldByCrashedRunner: true
- finalState: done
- settleCallsTotal: 200
- settledOnChain: 200
- settledTwice: 0
- settledAcceptedMatches: true
- settledAccepted: 268191000
- expectedAccepted: 268191000
- fencingTokenAtEnd: 2
- attempts: 1
- resultCategory: null

## refund crash and restart

- receipts: 200
- settledBefore: 200
- crashAfter: 66
- landedAtCrash: 66
- leaseHeldByCrashedRunner: true
- finalState: done
- refundCallsTotal: 200
- refundsLanded: 200
- refundedLamports: 89397100
- expectedRefundLamports: 89397100
- refundedMatches: true
- receiptsOverRefunded: 0
- fencingTokenAtEnd: 2

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
