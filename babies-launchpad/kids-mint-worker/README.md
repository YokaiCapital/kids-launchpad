# KIDS vanity mint reserve

A self-contained address generator using native Ed25519 key generation, a bounded process pool, and AES-256-GCM encrypted SQLite inventory. It generates addresses ending in exact lowercase `kids`; ordinary-address fallback is disabled. It does not send transactions or expose a public endpoint.

## Run and verify

Requires Node.js 24 or newer. From this directory:

```sh
npm ci --omit=dev --ignore-scripts
npm test
npm run stage
```

Deploy `.stage` with the included Dockerfile. No parent repository or external workspace source is needed. Configuration:

- `KIDS_MINT_ENCRYPTION_KEY`: 64 lowercase hexadecimal characters, provided as a secret.
- `KIDS_MINT_DATA_DIR`: persistent directory, defaults to `/data/kids`.
- `KIDS_MINT_PROCESSES`: requested process count, defaults to 4; resource guards can reduce it.

The worker stops refilling at its 100,000-address reserve target. Progress reports contain counts and throughput, never private keys. Preserve the encryption secret together with its persistent storage.

## Storage compatibility

This standalone distribution uses a KIDS-specific database namespace and encryption authentication domain. Use a fresh persistent directory. It is not a drop-in upgrade for older inventories: those require a separately verified migration using their original encryption domain. No deployed service or existing inventory was changed while preparing this repository.

`npm test` checks suffix matching, process-pool startup, and rejection of a wrong encryption key using temporary storage. Generated addresses are not yet connected to launch reservation.
