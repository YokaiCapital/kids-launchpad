# Restore drill (mainnet volumes)

A backup is unproven until it has been restored and checked (docs/ENGINEERING-RULES.md). This drill restores the
kids-api volume backup into a throwaway service, verifies that the restored state reconciles with the chain, and records
the recovery time and the data loss window. It never touches the live service or the live volume, and it never sends a
transaction: the throwaway service runs without a signer and with writes closed.

## What is on the volumes

| Volume | Path | Contents |
| --- | --- | --- |
| kids-api | `/data/localnet` | campaign manifest, keys file for the coin mint, intents and operator journals, fee event history, accounts database |
| kids-api | `/data/protocol` | program manifest written by the supervisor |
| kids-signer | `/data` | operator key (0600) and `signer-state.json` (hourly spend ledger, approved operation ids) |

The signer volume holds a key: it is restored only in a real disaster, by the owner, never in a drill.

## Steps (owner, Railway dashboard, about 20 minutes)

1. **Note the time** and the live service's `/statusz` (write it down: `writesOpen`, `reconciliation.complete`).
2. **Create the drill volume** from the latest kids-api backup: project kids-mainnet, the kids-api volume, Backups,
   pick the newest, "Restore to new volume". Name it `kids-api-drill`.
3. **Create a throwaway service** `kids-api-drill` in the same project from the same image as kids-api (Settings,
   Source: same GitHub repository and branch), mount `kids-api-drill` at `/data`, and set the variables:
   `KIDS_NETWORK=mainnet`, `KIDS_HELIUS_RPC_URL` (same as live), `KIDS_BACKEND_TOKEN` (a fresh random value, drill only),
   `KIDS_DRILL=1`, `KIDS_SIGNER_PUBKEY=AAuwkFNvXRimHyvdQfh7Zik9baw8W2ufSbc5cyBqsdoE` (the operator address, public). Do NOT set the signer URL or any key. Without a signer the service verifies the program, reconciles
   every journal against the chain, opens reads, and keeps every write refused ("signer unavailable").
4. **Wait for readiness** (`/readyz` 200), then read `/_health/status` through the drill service's own domain with the
   drill token. Expected: `reconciliation.complete: true`, `unresolvedSigned: 0`, `expiredUnverified` equal to the live
   value, campaign address and mint equal to the live `/api/account/prelaunch`.
5. **Compare** the drill's `/api/account/prelaunch` and `/api/account/postlaunch` with the live ones: same campaign, mint,
   pool, phase, receipt counts. A difference is the data-loss window: everything after the backup time until now.
6. **Record** in deployment/PRIVATE-TEST-STATUS.md: backup time, restore start, ready time (recovery time), the
   differences found (data loss), and the status lines. Then delete the drill service and the drill volume.

## Verification command

`node localnet/restore-drill-check.mjs <live-domain> <drill-domain>` reads both services with the tokens from
`~/.config/kids/mainnet-access.json` (live) and `KIDS_DRILL_TOKEN` (drill), prints the comparison and exits non-zero on a
mismatch. Nothing is written anywhere.

## What would make the drill a failure

- The drill service never becomes ready (restore incomplete or program hash mismatch): the backup is not usable.
- `reconciliation.complete` false with unresolved signed intents: the backup is older than money in flight; the
  reconciliation must resolve every one against the chain before a restored service may write.
- Campaign or mint differ from live: the backup is from another campaign generation; do not use it.
