# A3 mint retry recovery — 26 September 2026

Scope: isolated v3/localnet, PostgreSQL and the existing encrypted asset
signer. No deployment, production grants, public creation, old-program changes,
or funded worker activation.

Schema 22 records proof-bound, contiguous retry permissions. Signing generation 0
is the original mint packet; generations 1 and 2 are the only permitted retries.
The immutable mint intent, reserved address, encrypted key and prior signatures
remain unchanged. Recovery requires the exact fully signed prior packet,
finalized failure/expiry, finalized expiry of every saved offer, current account
absence and matching ledger. Lagging RPC history, timeouts, merely confirmed
errors, conflicting accounts, stale approvals or exhausted generations do not
permit another signature. Each retry requires a fresh creator signature.

Approval recording, lease digest replacement and retry consumption share a short
PostgreSQL lock/transaction. General lease transitions still forbid digest or
signature replacement. Capturing the full signed packet and binding its signature
are atomic. No network work is performed under that lock. The signer is reused
without modifying its encryption, reservation or generation implementation.

## Verification

- 403-test regression suite passed before the additional wallet retry and creator
  orchestration tests. Focused wallet retry tests also passed (including concurrent
  fresh offers, stable mint address, old-approval rejection and final consumed reads).
- `qualify-mint-retries.mjs` completed against the owned isolated validator, using
  fresh encrypted stock, actual creator/mint signatures and real finalized expiry.
- Original and first retry were intentionally never broadcast. The second retry
  minted once; a simulated crash immediately after broadcast recovered by reading
  the same persisted signature. Mint/freeze authority null, immutable metadata,
  full supply in intended custody and consumed lease were verified on-chain.
- The first harness run failed correctly at the wallet-offer foreign key because
  this mint-only test had no accepted draft. The corrected harness uses the
  internal journal for that mint-only scope. Wallet offers have separate shared
  plan/accepted-draft integration tests; this is not external-wallet qualification.

Public localnet evidence:

- Genesis: `7Sxh5h588K957C1to4Pvx6zQY6CLpghPCeG3ZeyrZJef`
- Program: `2T1K7xegEghMfR5RxtpJurG5bQhesHK6y8cvhpSos7CV`
- Mint: `8dahkt7H1uan8dEPY6p2kA5WRRWTmtzqL8SrY5Xukids`
- Final signature: `5Ns15tXDjrz7LUAJW4SsZeSUvid338bzUNghNcauuqsNzLCH5hUs7Ce7GFtctJUY3jcccH33vVmYJ3QfKXo376TW`
- Packet: 719 bytes; elapsed rehearsal: 240270 ms.

Remaining: joined creator journey/real-wallet UI, complete operating funding,
worker activation, hosted provider qualification, release/security/load gates.
The mint-only rehearsal does not create a campaign or publish metadata externally.
