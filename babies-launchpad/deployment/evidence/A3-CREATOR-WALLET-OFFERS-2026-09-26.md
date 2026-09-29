# A3: creator mint wallet offers, 26 September 2026

Status: internal v3/localnet wallet boundary; public creation still disabled.

## Behavior

Schema 16 persists immutable unsigned wallet offers against the sealed mint plan.
The browser-facing service accepts only a request ID, offer ID and signed packet.
Blockhash, validity height, mint, metadata and instruction bytes are read from the
server record. The exact creator signature is verified before the approved packet
can enter the existing signer journal.

Concurrent preparation calls share one open offer. An unsigned expired offer can
be superseded; its old signature is then rejected. Approval and offer replacement
share one short database lock, closing the race where a signature arrives during
a refresh. The offer update, approved packet and mint-intent binding commit
together. No signing, RPC request or broadcast happens inside that transaction.

Once an approval is recorded, prepare returns resume/status rather than a new
wallet prompt. Identical submission retries remain idempotent after block expiry.
They cannot replace the approved packet. Unknown blockhash validity fails closed;
an unexplained signing/consumed reservation does not receive another offer.

No mint signer, public endpoint, frontend action or hosted service is activated by
this module. The service must be composed behind existing wallet authentication,
pilot access, origin/CSRF checks and bounded RPC transport. Actual extension-wallet
compatibility and replacement of a *previously approved* expired signing generation
remain separate requirements.

## Tests

The 347-test focused regression suite passed with PostgreSQL enabled and no skips.
New coverage includes ten concurrent preparations, ten concurrent submissions,
server-owned expiry height despite a different browser value, a deterministic
refresh-versus-approval race, invalid creator approval and expired duplicate replay.

The same creator wallet service is now used by the opt-in actual inventory mint
rehearsal. Its provider/source fixture remains synthetic; a successful mint does
not imply real IPFS publication or a complete campaign launch.

The actual local validator rehearsal passed with a freshly generated `kids` mint:
`9NoVuTBqZdvF5xDEJV5Po4wwyP7nsi6i9fmV8Fspkids`. Transaction:
`3hPvFxF6TAJRb7CRMj7DSjBG9eFbnY2ky9dmkw5jnYs4pmUjgXKcvRjPBFM7tXArYmmHYtwqHmADDmFDsHiwHka3`.
The 718-byte packet passed saved-offer approval, shared-plan verification,
post-broadcast recovery, immutable metadata and revoked-authority checks. The
inventory lease ended consumed. This is mint-path evidence only; no campaign was
created and no real metadata was published. The 524-second runtime includes
fresh vanity grinding; user requests must reserve existing qualified inventory,
never wait for grinding. Production client/SSR builds and the publication scanner
also passed (769 files scanned, zero findings; not an exhaustive security audit).

## Ultimate-goal check

Closes another creator retry and replica-consistency gap without changing old
programs, supply, fees, claims or refunds. Complete private upload storage,
provisioning/funding, creator UI, real-wallet tests and hosted qualification remain
required before production activation.
