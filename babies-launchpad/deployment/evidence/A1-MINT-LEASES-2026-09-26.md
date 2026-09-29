# Mint orchestration and preservation checkpoint

26 September 2026 · `feature/public-launches` · isolated local implementation.

The mint lease adapter now awaits registry and inventory operations. It reuses the
existing encrypted inventory and its exact lowercase `kids` rule, rather than replacing
the generator, encryption format or signing checks. Ordinary-address fallback remains
refused by the production lease validator.

Two races were addressed:

1. Registry signing intent could race inventory release. The registry now claims
   `releasing` before crossing into the inventory. The inventory commits a public
   reservation release receipt with the release itself. After a crash between stores,
   that exact receipt completes the registry transition. Missing proof stays unresolved.
2. Rebinding a returned mint retained the old lease ID. It now assigns a fresh ID, so
   stale references cannot record signing intent against a new creator's reservation.

The registry enforces permitted state transitions and immutable recorded message digest
and signature. Concurrent reservation retries recover the winning binding. A changed
network, program, campaign or draft is refused. Signed/consumed mints cannot be released.
The inventory addition is backward compatible for callers that omit the new expected
reservation argument; deployment/cutover must nevertheless qualify the exact running
inventory version and its encryption authentication domain.

## Verification

- Focused shared-state suite: **128 passed, zero failed/skipped**, using real PostgreSQL
  16 and separate pools. Includes concurrent mint/signature operations, signing-versus-
  release races and recovery after a simulated cross-store process crash.
- Actual encrypted inventory: a release receipt survives closing/reopening the database;
  replaying an old receipt cannot release the next owner's reservation. These fixtures
  use generated ordinary keys only to test storage; they do not qualify vanity throughput.
- Broader application/preservation suite: **508 passed, zero failed, three skipped**.
  Skips cover unavailable local chain/deployment prerequisites and the Linux-only writer
  lock test on this host. The local context-cache test now checks that this checkout has
  its deployment manifest before using a desktop validator; setting
  `KIDS_REQUIRE_LOCALNET_TESTS=1` makes its missing prerequisites fail explicitly.
- Frontend production build passed. Existing warnings about the Vercel insights script
  and optional native bigint bindings remain; neither was reported as a build failure.
- Public-source pattern scan found no matches. No scan proves absence of every secret.

## Ultimate-goal comparison

Shared money/accounting and preservation are **partial, improved**. The foundation has
real replica/restore evidence, but an inventory count is not evidence of a launch-ready
mint. End-to-end provisioning must still prove exact-network absence/initialization,
required lookup/setup readiness, custody and authorities, one-use signing and recoverable
registration for a real generated `kids` address. Nothing here changes production stock,
public access, deployed programs or live coins.

Next phase: independent role runtimes and shared RPC/signer admission. Launch/refund
capacity must remain available while fee routes or index backfills are slow. Then wire
creation and the approved UI to those services and run the isolated chain, mixed-load,
wallet and security gates before the owner-only pilot.
