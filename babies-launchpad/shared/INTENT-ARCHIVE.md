# Intent archive integration contract

`intent-retention.mjs` integrates `intent-archive.mjs` into active escrow, legacy
escrow, external claims and postlaunch trades. At9000hot rows, new preparation scans
at most10candidates before applying the10000pending-history limit. Run only under
the existing single-writer process lock and service preparation/compaction mutex.
Expensive qualified contexts are memoized per campaign for one compaction pass only;
a later pass revalidates the chain identity.

The namespace binds service and schema; each immutable record retains its genesis,
program and campaign identity, revalidated against the qualified context before
replay. A global per-service lookup ensures old IDs fail closed after ledger changes. `append(key, fullIntent, finalizedProof)` durably writes
an immutable content-addressed JSON object before atomically publishing an exact-key
reference. Keys are hashed into filenames. Earlier generations remain in `objects`;
low-level references select the latest written generation. Service replay instead
uses an immutable checkpoint chain committed with the hot-journal marker. Readers
verify identity and checksum.
This is corruption detection, not protection against a privileged disk attacker.

Every service lookup consults the retention adapter (hot row or committed archive) before
creating a request or accepting a submit. Never treat a missing hot record as a new
request. Confirmed archived responses should return their original signature;
same-ID renewal is permitted only for a conclusively finalized failed signature.
Expired unsigned messages require a fresh request ID after balances are refreshed;
signed unknown/pruned outcomes require signature reconciliation. Neither expiry nor
a missing historical RPC status proves that a wallet never sent the old message.
Never broadcast an archived successful transaction or silently change its terms.

`compactIntentHistory` requires a `describe` adapter that validates each row's ledger
identity and provides its connection, signature and last valid block height. Signed
rows without retrievable finalized status stay hot, including pruned history.
Confirmed status is insufficient. An unsigned issued transaction can be archived
only after finalized block height passes its validity window; this proves future
execution impossible, not that a wallet never submitted it independently. The full
unsigned message remains archived for audit and existing expiry behavior.

`isBusy` must protect both submit and prepare operations. Candidates are checked again
after asynchronous RPC work; changed rows remain hot. Once a record is archived,
hot removal and persistence happen without an await. If hot persistence fails, the
in-memory row is restored. A crash at any intermediate point leaves either the old
hot row, an archive duplicate, or the completed archive reference. Use the returned
scan cursor on later passes so unresolved prefixes cannot starve finalized history.
The cursor is advisory and can restart after a process restart.

Include the **entire archive directory** in backup, restore and integrity validation.
A reserved `__kidsIntentArchive` marker in the hot journal points to a hash-linked
checkpoint chain. Startup validates every committed checkpoint and referenced full
record. Missing or corrupt archive data refuses service initialization, preventing
an old request from being mistaken for a new one after a partial restore. Archive
objects written ahead of a failed hot commit remain unreferenced and harmless. Full signed
transaction bytes remain in immutable objects and require the same private-storage
permissions as active journals. Records are not deleted, so filesystem capacity and
archive backup growth still need monitoring; compaction bounds hot JSON rewrite work,
not total financial audit retention. Multiple process writers and cross-host shared
filesystems are outside this module's supported locking model.

Run `node --test localnet/test/intent-archive.test.mjs localnet/test/intent-retention.test.mjs localnet/test/claim-archive.test.mjs` for restart lookup, immutable
generations, corruption/identity rejection, terminal classification, persist failure,
concurrent mutation, busy/scan bounds and unresolved-prefix scan progression.
