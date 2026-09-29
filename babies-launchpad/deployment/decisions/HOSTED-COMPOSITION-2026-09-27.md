# Hosted composition for public launches (Standard v3 pilot)

Started 27 September 2026. This is the composition the hosted pilot runs on. It replaces the
local-only rehearsal wiring with explicitly reviewed hosted entry points; it does not delete the
rehearsal guards. Nothing in this document is deployed yet. Status of every part is marked.

## Services

| Service | Role | State it owns | Replicas | Status |
|---|---|---|---|---|
| `kids-pg` | PostgreSQL 16, the shared registry (schema 39) | all durable operational records | 1 primary, PITR backups | not provisioned |
| `kids-api` | public API and site backend | mint inventory and media on its volume | 1 for the pilot | existing legacy service; registry mode, release verification and the hosted creator flow implemented (`KIDS_REGISTRY_URL`, `KIDS_RELEASE_MANIFEST`, `KIDS_CREATOR_FLOW=hosted`), not enabled in production |
| `kids-worker-<lane>` | one service per lane: provisioning, lifecycle, recovery, accounting, harvest, economics | none; leases in PG | lifecycle 2, recovery 2, others 1, from measurements | code: hosted mode implemented (`KIDS_ROLE=worker`), not deployed |
| `kids-signer-v3` | policy signer for version 3 keeper capabilities | durable signer state file on its own volume; spend and replay journals | exactly 1 | code: hosted entry point written (`localnet/signer/main.mjs`, `KIDS_ROLE=signer-v3`), not deployed |
| `kids-indexer` | market and activity ingestion per campaign | cursors in PG | 1 | code: hosted mode implemented, not deployed |
| `kids-mint-worker` | encrypted vanity inventory | encrypted inventory on its own volume | 1 | existing |

Old services (`kids-api` legacy keepers, `kids-signer` build 6, `believers-worker`) keep running
unchanged. The new fleet never shares their volumes or keys.

## What a hosted process must prove before doing work

Every worker verifies the release manifest (`localnet/hosted/release-manifest.mjs`) against the
ledger and its registry at start, and refuses to run otherwise:

- genesis hash matches the manifest network (`mainnet` or `devnet`);
- the program is an executable upgradeable program whose data bytes hash to `binarySha256`
  over exactly `binarySize` bytes with a zero tail;
- the sealed Raydium CPMM tier account hashes to `ammConfigHash`;
- `deployment/presets/public-presets-v1.json` hashes to `presets.sha256`;
- the registry schema version equals `registrySchemaVersion`.

The manifest is a committed file per release. The worker reads its path from
`KIDS_RELEASE_MANIFEST`; the config file may not carry it, nor the RPC endpoint.

## Endpoint and secret rules (implemented in `validateWorkerConfig`)

- `mode: "hosted"` only with program version 3 and a scope equal to the manifest.
- RPC endpoint from `KIDS_RPC_URL` (provider, https, no loopback, no credentials in the URL
  path or userinfo; provider keys stay in the environment of the service that uses them).
- Signer endpoint: https, or http on a private-network hostname (`*.railway.internal`).
  Never loopback, never a public http host.
- Signer token from `KIDS_SIGNER_TOKEN` in the environment of each worker, never in a file.
- Registry URL from `KIDS_REGISTRY_URL` (postgres, private network or TLS).
- Admission partitions (`rpcAdmission`, `signerAdmission`) are required and are shared across
  replicas through the registry; no replica gets its own provider budget.

## Service roles in the one image

Every service runs the repository image (`Dockerfile`, `deployment/mainnet/supervisor.mjs`) and picks its role with
`KIDS_ROLE`: unset for the legacy API and keepers (Shartcoin, unchanged), `signer` for the legacy build-6 signer,
`signer-v3` for the version-3 policy signer, `worker` for one public-launch lane. The version-3 signer takes its key
once from `KIDS_SIGNER_KEY_JSON` on first boot (written to its volume as `/data/signer-v3/signer-keypair.json`, then
the variable is removed), its secret-free config from `KIDS_SIGNER_CONFIG` (listener, RPC admission partition, fee
operator, policy) and refuses to listen unless the key matches the manifest's `signerPublicKey` and the release
verifies.

## Environment matrix

| Variable | api | worker | signer | indexer |
|---|---|---|---|---|
| `KIDS_REGISTRY_URL` | yes | yes | yes | yes |
| `KIDS_RELEASE_MANIFEST` | yes | yes | yes | yes |
| `KIDS_RPC_URL` | yes | yes | yes | yes |
| `KIDS_WORKER_CONFIG` (lane file, no secrets) | no | yes | no | yes |
| `KIDS_SIGNER_TOKEN` | no | yes | yes | no |
| `KIDS_SIGNER_URL` | yes (status only) | in config | no | no |
| `KIDS_SIGNER_CONFIG` (secret-free file) | no | no | yes | no |
| `KIDS_CREATOR_FLOW=hosted`, `KIDS_PUBLIC_PILOT_WALLET`, `KIDS_MINT_ENCRYPTION_KEY`, `KIDS_PINATA_JWT` | yes | no | no | no |
| `KIDS_MARKET_WORKER_CONFIG` (lane file, no secrets) | no | no | no | yes |
| `KIDS_SIGNER_KEY_JSON` (first boot only, then removed) | no | no | yes | no |
| signer key file on the signer volume | no | no | yes | no |

## Deployment order

1. Provision `kids-pg` with backups and PITR; run migrations from the release image once
   (`registry.migrate()`), never from workers (they refuse a schema mismatch).
2. Deploy `kids-signer-v3` alone; confirm ownership acquisition and journal coverage in its log;
   no worker exists yet, so nothing can be signed.
3. Deploy the accounting worker (signer-free), then lifecycle and recovery workers, then
   provisioning, harvest and economics. Each logs `public-worker-started` with its scope.
4. Enable the registry-backed API paths (`KIDS_REGISTRY_URL` on `kids-api`) with public
   launches still hidden behind the wallet-restricted pilot flag.
5. Run the wallet-restricted pilot (section A7 of the integrated plan) and record evidence.

## Budgets and readiness

- Total PostgreSQL connections are capped across replicas (worker pools `max: 4`; API pools
  sized so `api replicas × pool + workers × 4 + signer + indexer` stays under the instance
  limit with headroom for migrations and operators).
- RPC and signer admission budgets come from the measured profiles in the capacity evidence,
  not from this document.
- Readiness for a worker is its `public-worker-started` event plus presence rows in PG;
  readiness for the signer is its ownership row; both are exported by observability.

## Not covered yet (blocking a hosted pilot)

- Provider autoscaling actuation and alert delivery.
- Offsite backup checkpoint and a restore drill on the hosted database.
- The operating-funding policy was decided on 27 September 2026 (option 1: the creator funds a
  disclosed operating reserve at creation, and the coin's own treasury fee share refills the
  campaign's operating budget after launch). The creator reserve step is implemented in the local creator
  composition (`operating-reserve` stage); its hosted composition must pin the reserve payer to this manifest's
  `signerPublicKey`. The return of unused reserve after refunds is implemented (recovery lane job `operating-return`,
  signer capability kind `operating-return` issued by the operator per refunded campaign). The refill from the treasury
  share is accounting (accounting-lane job `operating-refill` from fee activation on) plus the operator tool
  `localnet/operating-refill-funding.mjs` (prepare, credit, void); the treasury-signed transfer itself is the owner's step.
