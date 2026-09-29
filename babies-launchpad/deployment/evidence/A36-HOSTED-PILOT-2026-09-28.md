# A36: hosted private pilot, mainnet, 28 September 2026

Status: hosted stack deployed and verified; the pilot launch itself not yet run. This file is the timeline and the
evidence of the deployment; launch evidence is added below as it happens. Times are UTC.

## Program

- 11:28 upgrade of `ABq14qMonDrPbRJUbyfACsazK2ESaiKWcw5u66qy6f7T` to build
  `71d0d62c3582c28bb702b5e0e33c3d9cb41d7881ee93394eb25c527800ab6869` (201,640 bytes), transaction
  `BrUvyR8nM6DfhF6XPRk31mEKDxLzPRRDRN1ajxXx6pHuFLHVVy7sCnrZ7JcbWhEHCD1anD51ve6YKh8T4qg4kQR`, slot 451305566,
  program-data extended to 211,728 bytes; on-chain bytes read back through the public RPC and hashed equal to the
  clean reproduction. The owner's run lost its network connection at the verification step after the deploy had
  landed; the records were completed from the reproduced binary (`release-mainnet.json` verified against the chain).

## Services (Railway project kids-mainnet, branch feature/public-launches)

| Service | Result | Evidence |
| --- | --- | --- |
| Postgres | created; schema 39 created at boot by the accounting worker (`schema-ready version=39 migrated=true`) | worker log 12:17 |
| kids-signer-v3 | key stored on the volume, release checks all true, listening on 4177; key variable deleted afterwards | signer log 12:17; variable list |
| kids-worker-lifecycle, -recovery, -provisioning, -harvest, -economics, -accounting | `schema-ready`, `public-worker-started` in hosted mode with the mainnet scope | worker logs 12:17 to 12:18 |
| kids-indexer | first deploy crashed: generated config lacked its RPC admission block (fixed in `make-release.mjs`, config regenerated, test added); running after the rebuild, presence alive | status page 12:38 |
| kids-api-pilot | first deploy crashed: server modules outside localnet could not resolve packages in the image (one dependency tree now linked at the application root, test added); running after the rebuild: `release-verified` (genesis, program, binary, ammConfig, presets, registrySchema all true), `hosted-creator-flow-composed`, `public-launch-observer-started`, `startup-reconcile-complete`, `pilot-api-ready` | API log 12:34; `/statusz` |

Status page at 12:38:43: `status ready`, `publicLaunch.status observed`, no alerts, every lane alive (provisioning,
lifecycle, recovery, accounting, harvest, economics, indexing: 1 each). Legacy campaign import: 5 records.

## Setup defects found and fixed on the day

- The database has no public address: the migration moved inside the platform (`schema-boot.mjs`); the restore drill
  and the operator tool run through `railway ssh` on the accounting worker.
- The Railway command-line tool crashed on volume creation after creating the volume; the script re-checks the
  listing and otherwise leaves the volume to the dashboard.
- The signer token appeared on the owner's screen once through the tool's prompt echo; the script now sends every
  secret through standard input, and the token was rotated before any service used it.
- The indexer service had not been connected to GitHub by the script (connect refused once); connected by hand.

## Pilot launch

(to be written: campaign address, operator grants, commitments, settlement, launch, claims, refunds, fee collection)
