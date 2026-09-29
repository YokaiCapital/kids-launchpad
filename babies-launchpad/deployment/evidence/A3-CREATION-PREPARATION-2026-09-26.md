# Durable creation identity and usable stock bridge

## Delivered

Schema 14 adds a separate creation-preparation record. An accepted, immutable review
gets one nonce, campaign PDA and setup authority before reserving any mint. PostgreSQL
serializes only that request across replicas. The same creator/request always uses
the same inventory `asset:` binding; the original creator draft remains linked
through its creation request. Inventory encryption and the asset signer are reused.

An empty inventory reports waiting-for-mint. There is no ordinary-key fallback. A
lost inventory response resumes the same reservation. Released, rebound, quarantined
or unexpectedly signed stock requires reconciliation; it is never silently replaced.
Status rechecks the lease rather than advertising a stale reservation as usable.

Preparation is explicitly v3, loopback localnet, PostgreSQL, configured pilot wallet,
genesis, policy hash and plan hash only. Its optional authenticated account endpoint
uses the existing origin/session/CSRF/pilot boundary. It cannot sign, move funds or
register a coin as open. `fundingEnabled` remains false. Runtime composition has not
enabled the unfinished creator wallet flow or exposed this on the hosted site.

## Verification

- 299 focused database, wallet, worker and UI-adapter tests passed, zero skips.
- Creation tests include 12 concurrent replicas/requests, inventory response loss,
  empty stock replenishment, stale leases, foreign wallet/network/policy and changed
  review rejection. State-machine stock is synthetic and explicitly labeled.
- Real stock bridge: `KIDS_QUALIFY_CREATION_STOCK=1` plus the isolated test database
  runs `localnet/test/creation-inventory-e2e.test.mjs`. Passed in 60.4 seconds.
- Reused generator produced `7e2g1HXJQPCMLED6PQZhHwzYw9iGemwPuUc5FAFMkids`.
  A persisted accepted review reserved it; recreating the preparation service returned
  the identical campaign/lease. The inventory signed the independently rebuilt,
  creator-approved message, reopened, and recovered the identical transaction.
- The actual local validator finalized the 521-byte mint transaction. Supply is
  1000000000000000 base units, six decimals, mint and freeze authorities null, all
  tokens in the derived custody. Lease consumed. No key exported or logged.

Local program: `2T1K7xegEghMfR5RxtpJurG5bQhesHK6y8cvhpSos7CV` (v3).
Genesis: `7Sxh5h588K957C1to4Pvx6zQY6CLpghPCeG3ZeyrZJef`.
Transaction: `4MEcc4utk3Mw2MdYpRCp5hmdRRHQdLUJbMcruWHBxUYJJwSe97YT6FQTz3HCdKu6UcDa3dWMvPMhb7DEVHvKZsN6`.
Logs: `/tmp/kids-preparation-regression.log`, `/tmp/kids-creation-stock-e2e.log`.

This qualification creates a mint, **not a campaign account or pool**. It is not an
external wallet, hosted inventory, throughput or full creation qualification.

## Other checks in this checkpoint

API dependencies use the reviewed upstream pure-JS bigint build and patched UUID;
see `localnet/security/DEPENDENCIES.md` for exact mitigations and residual findings.
127 wallet/market tests passed (one optional PostgreSQL test skipped in that command).
The actual v3 validator lifecycle/return test passed after dependency changes,
including 1500000000 lamports of participant refunds. Metadata pinning now preserves
the exact uploaded CID instead of appending a filename extension; all three metadata
tests pass. None of these changes have been deployed to a hosted environment.

## Ultimate-goal comparison / next work

This closes duplicate launch identity and unusable inventory-binding risks in A3.
It does not complete media ownership/storage, bounded and disclosed operating
funding, durable multi-step creator packets, cancellation/reconciliation, registration,
or the connected creator wizard. The asset signer's production authorizer must use
durable server-owned plans and wallet approval, never request-supplied transactions.
The existing mint qualifier's private file authorizer is a test harness only.

Keep A3 implementing; no activation or production-ready claim. Existing deployments,
program authorities, parent launches and paid claims/refunds remain untouched.
