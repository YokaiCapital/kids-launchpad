# Creator-first mint packet and durable approval

## Delivered

The isolated Standard-v3 mint leg uses the existing token/metadata instructions
and encrypted asset signer. It creates the reserved `kids` mint, initializes
six decimals with no freeze authority, sends the fixed 1-billion-token supply to
the derived campaign custody, creates immutable metadata and revokes mint authority
in one transaction. It neither creates a pool nor transfers SOL to a dev wallet.
Mixed-case tickers are preserved. The fixed supply/profile is not a new configurable
creator parameter, and future liquidity features cannot enter these packet bytes.

The immutable intent binds request, lease, ledger, program, creator, nonce, custody,
mint, supply, rent and metadata document hash/URI. The attempt blockhash is separate
from that permanent inventory intent. Rebuilding from persisted JSON produces the
same message. Maximum branding/URI lengths fit below Solana's 1232-byte packet bound.

The creator must sign first. Invalid/missing signatures, a mint signature supplied
by the caller, different blockhash/instructions/accounts, extra transfers, trailing
packet bytes and noncanonical encoding are refused. No private key reaches the API.

`mint-approval.mjs` reuses the PostgreSQL packet outbox. It stores the exact creator
approval before crossing into the encrypted signer and records the exact full packet
before returning it for broadcast. The inventory authorizer independently reloads
the trusted plan, checks the lease binding and configured local ledger, and rebuilds
the message. Invalid/expired blockhashes fail closed. Ten concurrent requests produce
one approval; a service/inventory restart reuses it. No new database migration.

## Verification

- 318 focused regressions passed, zero failures/skips, including shared PostgreSQL,
  wallet boundaries, mint leases, workers, market data and UI adapters.
- Creator-specific tests cover exact destinations/supply/authority removal,
  immutable metadata, maximum UTF-8 fields, forged and changed approvals, parallel
  requests, changed plans/reservations, wrong ledger and expired/unavailable blocks.
- Actual local validator + real generated inventory stock + PostgreSQL approval
  journal qualification passed in 134.9 seconds. Reopening both inventory and the
  journal authorizer recovered the identical signed message before broadcast.
- Finalized account reads verified supply, custody, null mint/freeze authorities,
  immutable metadata and exact name/ticker/URI. The lease was consumed.

Local program: `2T1K7xegEghMfR5RxtpJurG5bQhesHK6y8cvhpSos7CV` (v3).
Genesis: `7Sxh5h588K957C1to4Pvx6zQY6CLpghPCeG3ZeyrZJef`.
Mint: `3cxFCbtgy43yj2DamiNqQ7piZbxCUE7We91Uxf83kids`.
Transaction: `SYCLkLYFga9ViDB68VtFdDMFGbVox4CGbqRxXFXTZUUR8MmdUZbuWgJ7AQqYBHAjwT8GWj5TrVL4uR2G7RZtFYH`.
Packet: 719 bytes. Logs: `/tmp/kids-creation-journal-e2e.log` and
`/tmp/kids-creator-mint-regression.log`.

## Ultimate-goal comparison and remaining boundaries

This qualifies another A3 signing/recovery boundary, not complete creator onboarding
or a production release. The local qualifier's trusted intent comes from its private
durable file; production must load the accepted plan, owned media receipt and saved
wallet offer from shared trusted storage. Never wire `record` to request-provided
intent, block validity height or arbitrary transaction instructions. The fixture
metadata URI is not a published IPFS document. No campaign account/pool is created
by this test, and no external wallet extension is used.

Only the first signing generation is implemented. An expired/failed attempt is NOT
silently replaced or its mint released: bounded new-generation recovery still needs
finalized chain reconciliation, proof of absent mint, persisted prior-message linkage
and fresh creator approval. The reused inventory already supports bounded generations;
the shared mint-lease digest deliberately remains immutable until that bridge is
qualified. Do not label this expiry path production-complete.

Next A3 work: shared media ownership and staged pinning, trusted plan/offer persistence,
complete funding and provisioning, explicit recovery/cancel, registration and connected
wizard. Requirements: staged charging, uncertain outcome accounting, image-hash
reuse and owner/mint binding. Durable quotas and concurrency use shared PostgreSQL
in the replicated KIDS API. Retain private asset access until explicit publication.

Existing deployed programs and production services were not changed. Private pilot
intake/funding and public launches remain disabled pending the remaining gates.
