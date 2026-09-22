# Engineering rules

Owner rules, 20 September 2026. They govern every change to KIDS (and Pairz). Companion: [RELIABILITY-RULES.md](RELIABILITY-RULES.md).

**The governing rule: when evidence is incomplete, preserve funds and recoverability, expose the uncertainty, and avoid irreversible actions.**

## Protect funds and state

- Enforce financial rules in the smart contract. Frontend validation and admin controls are not security boundaries.
- Define and test conservation invariants: commitments equal accepted funds plus refunds; token allocations never exceed supply; claims and payouts cannot execute twice.
- Use integer arithmetic for money and tokens. Explicitly define rounding, dust, decimal conversions and overflow handling.
- Bind every operation to its network, program, campaign, mint and authorized signer. Reject mismatches.
- Freeze agreed economic terms at the appropriate lifecycle boundary. Admin edits must not retroactively change participant entitlements.
- Emergency controls must have narrowly defined powers. Document whether pausing affects withdrawals, refunds and claims.

## Make changes recoverable

- Preserve existing data and pending transactions across deployments. Version stored formats and test migrations against representative backups.
- Never reset a ledger, regenerate identities or delete journals to make a test pass.
- Test crashes between each critical step: persistence, broadcast, confirmation and accounting update.
- Restore procedures must reconcile with the chain before reopening writes. An old backup must not permit duplicate payouts.
- A backup is unproven until successfully restored and checked. Record recovery time and potential data loss.
- Rollbacks must account for database and contract compatibility; reverting frontend code alone may be insufficient.

## Secure the application

- Authenticate and authorize every sensitive server request. Hidden buttons and unguessable URLs do not provide authorization.
- Validate wallet sign-in challenges, prevent replay and invalidate sessions appropriately after account changes.
- Validate uploaded media and external URLs. Prevent script injection, dangerous embeds and server-side requests to private infrastructure.
- Give services minimal permissions. Separate development, testing and production secrets; plan rotation and revocation.
- Pin dependencies and verify build provenance. Review relevant vulnerabilities rather than blindly upgrading or suppressing warnings.

## Operate honestly

- Maintain a single authoritative source for campaign state. Clearly handle loading, stale data, unavailable services and pending transactions.
- Measure realistic mixed workloads, including signing submissions, claims, RPC latency and keeper activity, not only cached reads.
- Configure actionable alerts for stalled keepers, unresolved transactions, disk exhaustion, backup failures and accounting discrepancies. Test alert delivery.
- Never weaken validation, remove failing tests or substitute fake data to produce a green result.
- Keep a release checklist linking each requirement to code, tests and deployment evidence. Distinguish implemented, tested, deployed and verified live.
- Reuse Pairz only after checking its assumptions, dependencies and tests. Document meaningful differences instead of maintaining two subtly incompatible implementations.
- Finish independent work when external inputs are missing, but never invent recipient addresses, verified mints, audit approval or production readiness.
