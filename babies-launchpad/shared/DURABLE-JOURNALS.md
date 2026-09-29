# Transaction journal durability

`writeDurableJson(path, value)` synchronously writes a unique, private temporary file
on the same filesystem, flushes its contents, atomically replaces the destination,
and flushes the parent directory. Failure propagates to the caller. Before rename,
the prior complete journal remains available; after rename, a directory-flush
failure is an ambiguous durability result, never permission to broadcast.

The active and legacy escrow submitters flush the journal immediately before every
broadcast, including replay of already signed bytes. This matters because a failed
write can leave those signed bytes in process memory. A retry must establish durable
storage before it is permitted to transmit them. Already confirmed chain signatures
can be recovered without reconstructing transactions.

This is a **single-writer** primitive, not a distributed lock. Unique temporary files
avoid temporary-path collisions but cannot prevent stale snapshots from overwriting
another process's journal. Run one API writer per mounted runtime volume. On Linux,
wrap the API in a kernel `flock --nonblock` held for its entire lifetime, and have any
offline mutation scripts acquire the same lock before loading journals. Kernel locks
release when the process exits, including crashes; read-only scripts need no lock.
Do not use a PID file that can strand a restart or silently steal a live writer's lock.
Do not deploy multiple replicas against JSON intent stores. Multi-replica operation
requires transactional shared persistence and cross-process intent locking.

Tests inject write, file-sync, rename and directory-sync failures. They verify syscall
ordering, complete-file preservation, error propagation and successful retry. They do
not simulate host power loss, storage-controller caches or a distributed filesystem.

The Railway API supervisor now executes:

```sh
flock --nonblock --no-fork /data/localnet/api-writer.lock node interaction-review/server/runtime.mjs
```

`--no-fork` replaces the lock process with Node, preserving its directly supervised
PID for SIGTERM/SIGKILL while the inherited lock descriptor keeps the lease held.
The Docker image installs Debian util-linux, which supplies this implementation.
The lock file itself must not be deleted or replaced while any writer runs.

For an offline mutation, stop the API writer first and run the mutation command
under that same lock. A busy lock fails immediately; do not remove it to bypass a
live owner. Bootstrap runs before the API starts. Read-only checks do not acquire it.
The Linux-only `localnet/test/writer-lock.test.mjs` verifies exclusion, retained PID,
and automatic recovery after process termination; macOS skips that test because
its host does not provide Linux util-linux `flock`.
