# Operator transaction recovery checkpoint

26 September 2026 · `feature/public-launches` · local implementation only.

The v2 chain adapter now requires a registry-backed operator outbox for writes. It
stores the complete prepared transaction, including auxiliary NFT signatures, before
asking the keeper to sign. It stores the signed bytes before broadcasting. It never
stores auxiliary private keys. Read-only adapters can still run without a journal.

Stable identities include the ledger, program, campaign and full operation key. The
descriptor binds the payer, compute budget and instruction intent. A launch additionally
binds the sealed terms hash. Competing builders choose one immutable packet. Signer
replay IDs hash the entire identity/message rather than truncating long strings.

A replacement worker checks the stored signature first. It can rebroadcast the exact
persisted bytes if unobserved; a new packet is allowed only on a later handler pass after
a finalized execution failure or proven blockhash expiry. Expiry requires finalized
block height and a subsequent history response whose context is at least that finalized
slot. RPC errors, lagging responses, processed errors and ambiguous simulation failures
retain uncertainty. Confirmed packets cannot be rewritten into failed/expired attempts.
Normal success still uses confirmed commitment, followed by the handler's chain readback;
this is not a claim that confirmed state can never fork.

Lease ownership is checked before preparation, signing and broadcast. Once signed, a
packet remains recoverable even if the original lease dies. On-chain idempotence and the
packet journal remain necessary: a fencing token cannot revoke a signature already made.
SQLite registry writes now use `synchronous=FULL`; PostgreSQL durability still depends on
the hosted database's configuration and recovery procedures.

## Evidence

The combined local suite passed **98 tests, zero failures or skips**, with real PostgreSQL
16 and two independent pools. Shared crash cases ran against SQLite and PostgreSQL:

- Stop after prepare, sign or broadcast; recover the same packet and auxiliary NFT.
- Lose the broadcast response after landing; detect confirmation without a second send.
- Keep uncertainty through unavailable/lagging RPC and processed execution errors.
- Record proven expiry before allowing another attempt; refuse stale unsigned signing.
- Lose the lease after durable signing; no broadcast from that worker.
- Race two builders; only one packet identity can be broadcast.
- Reject changed financial instructions and a signer changing the approved message.
- Fail journal persistence; never broadcast an unrecorded signed packet.
- Dump/restore PostgreSQL and compare pending operator signed bytes exactly, alongside
  user packets, auth rows, campaigns and queued jobs.

Chain behavior in the crash cases is simulated. These are real database/concurrency
tests, not a new deployed-program rehearsal or hosted failover test. The existing v2
localnet rehearsal was updated to pass its registry into the adapter; its execution
remains a separate gate. CI includes the operator tests but has not run remotely.

## Ultimate-goal comparison and next work

Money/recovery is **partial, improved**: operator identities now survive process death,
but the outbox is not yet integrated into separately deployed multi-campaign services.
Concurrent operations remain **partial** until physical worker isolation, RPC/signer
budgets, provisioning and the mixed-load rehearsal are complete. Creator/participant UI
and public readiness are unchanged from the shared-state checkpoint. Existing mainnet
programs and live routes were not changed, and no production deployment occurred.

Next: finish asynchronous mint/budget/capability consumers, preserve inventory signing
and release invariants, integrate isolated role runtimes and shared admission limits,
then complete the approved creation/discovery UI and qualification gates.
