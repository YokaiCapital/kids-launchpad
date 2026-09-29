# Hosted private environment recovery

This runbook applies only to the dedicated Railway **localnet** project. It does not authorize mainnet deployment or resetting a ledger.

The active service runs one API writer under a kernel lock, uses fsync-backed intent journals and retains exact signed transaction bytes before broadcasting. On a timeout, retry the same intent. Never replace the ledger, keys, campaign registry or signed bytes to clear an error. Finalized chain state determines transaction outcome.

## Backups

Railway volume `2ffe0d13-6a58-4b7c-b5b4-62ebb386c6f6`, instance `adfd8546-3cc0-441e-a090-6399708fda44`, has DAILY, WEEKLY and MONTHLY backup schedules. The pre-hardening backup created September 20 is `20395988-9a6e-4144-a8e4-d7fa30692e87`. Backups contain private test keys and must remain private. Provider backup creation is verified; a full restore drill remains a separate release gate. A hot volume snapshot is crash-consistent, not proof of cross-database/chain consistency.

Before changes, verify a fresh backup exists using the provider API. Restore into an isolated recovery environment where possible; do not overwrite the active volume while users can submit requests. Keep the password gate closed and financial writes disabled throughout recovery.

## Provider volume restore drill

Run the drill in a separate, disposable Railway project with fresh test keys, never against the active volume. Sequence: create a known finalized commitment and a signed-in session, archive the finalized intent, take a provider backup, then write a post-snapshot marker file. Restoring a backup creates a **new detached volume**; it does not overwrite the source volume. Detach the original volume, attach the restored one at the same mount path, redeploy and only then verify: the marker must be absent, the SQLite session must still authenticate, genesis hash, program, campaign, mint and committed total must be unchanged, replaying the persisted intent must return the original signature without a second commitment, and the archived intent must be found by rebuilding the archive index without any broadcast. Keep the private checkpoint file (it holds a session cookie) out of logs and repositories. Delete the disposable project and both volumes only after the verification passes, keeping the evidence.

Status, 20 September 2026, 16:27 UTC: the drill PASSED on the restored volume in the isolated project. The post-snapshot marker was absent, the SQLite wallet session authenticated, program, campaign, genesis hash, mint, receipt count and the 0.001 SOL committed total were unchanged, replaying the persisted intent returned the original signature with no second commitment, and the archived intent was found by rebuilding the archive index without any broadcast. The disposable project and both of its volumes were then deleted; the main project, its volume and its backups were untouched. This drill does not by itself make an old backup current: newer chain transactions still need reconciliation before financial writes reopen.

## Restart and recovery checks

1. Verify saved program ID, program binary hash, genesis hashes and campaign address before starting service. Bootstrap rejects identity changes.
2. Run the API under `flock --nonblock --no-fork /data/localnet/api-writer.lock node interaction-review/server/runtime.mjs`. A second writer must fail. Stop the API and acquire the same lock before a CLI script that writes its intent journals. Read-only probes do not need it.
3. Check gateway `/healthz` (process liveness) and `/readyz` (cached API/validator readiness). The API checks both ledger identities and the active program/campaign. A 503 is not authorization to reset anything.
4. Reconcile pending signatures against finalized chain history. Return already confirmed receipts. Retry ambiguous requests using their persisted bytes; do not issue new transactions merely because an HTTP request timed out.
5. Verify a known commitment/claim receipt and replay without a second balance change. Check refunds, operator authentication, viewer isolation and private asset gating.
6. Only reopen private testing when these checks pass. Restoring an old snapshot requires reconciling all newer chain transactions; a successful filesystem restore alone is insufficient.

## Startup reconciliation gate (20 September 2026)

The API now refuses every financial write (prelaunch prepare and submit, legacy refunds, post-launch claims and trades; HTTP 503 with the same-request-ID retry hint) and reports not-ready until each intent journal has reconciled its signed rows against the chain: escrow, active launch, post-launch claims and post-launch trades each run their chain classification (`reconcile()` in the module, driven by `localnet/startup-reconcile.mjs`), rows with a finalized outcome are archived, and rows whose outcome is still unknown stay hot and keep refusing to be rebuilt. If the ledger does not answer, the pass is retried with backoff and writes stay closed. `/_health/ready` carries the reconciliation state (complete, unresolved signed rows, time). Reads and sign-in keep working during the pass. This is the "reconcile before reopening writes" rule for restores; it does not make an old backup current on its own, but an old backup can no longer reopen payouts before the chain has been consulted.

## Finished test campaign renewal (22 September 2026)

`KIDS_ACTIVE_CAMPAIGN_RENEW=finished` on a private test service: at boot, a campaign that ended `failed` with every commitment refunded and every receipt settled is moved to `/data/localnet/archive/<campaign>/` and a new 24-hour campaign is provisioned. With `any:<token>`, applied once per token, a launched campaign is archived too, but only when every receipt is settled and no signed claim, trade or commitment is unresolved. The archive also carries the intent archive folders. To put an archived campaign back, stop the service, move the files back out of the archive folder and remove the variable. Never set this on an environment holding real funds.

## Program upgrades on a live ledger (20 September 2026)

Campaigns, journals and intents record the program binary hash they were created under, and every identity check used to demand the current hash, so an in-place program upgrade orphaned all existing records (this happened on the desktop ledger on 20 September after two upgrades; the hosted ledger was untouched). The manifest `atomic-launch-program.json` now carries `lineage`: every hash ever deployed under this program id on this ledger, oldest first, with `sha256` the current one. `localnet/atomic-launch-deploy.mjs` appends the previous hash on each upgrade, and every identity check accepts a recorded hash that is current or in the lineage (`localnet/program-lineage.mjs`); a hash outside the lineage is still a different program and is refused. The hosted bootstrap upgrades in place when the image carries a newer binary and the admin key holds the upgrade authority, then writes the lineage; it never resets a ledger. Program id, genesis, campaign, mint and signer bindings are unchanged.

## Release and traffic limits

Vercel edge limits plus the gateway's bounded request queue provide layered protection. Cloudflare is not configured. A single localnet container and volume are not a highly available mainnet architecture. Deployments restart the validator/API and can briefly return 502/503; the browser must preserve pending intent IDs. Run sustained read and write qualification before raising limits, and use a separate production RPC and signing/keeper service before mainnet.

GitHub CI runs locked dependency installation, frontend build, authorization/journal tests, Linux writer-lock tests, publication scanning and Rust contract tests. Passing CI is not an independent smart-contract audit. Mainnet remains blocked by verified token/treasury identities, deployment and authority governance, economic oracle/route controls, external review and recovery qualification.

## Isolated application-journal restore qualification

Run from the KIDS repository root:

```sh
node --test localnet/test/backup-restore.test.mjs localnet/test/durable-json.test.mjs
```

The drill uses newly generated, disposable test keys and temporary source, backup and
recovery directories. It exercises the actual wallet-signed claim intent service and
signature validation, but substitutes an independent in-memory chain receipt ledger.
It never contacts hosted RPC, reads production keys, or changes the active volume.

Verified cases:

- A signed, broadcast transaction whose response was lost is restored from a journal
  snapshot into a separate directory. An independently finalized receipt is returned
  without a second broadcast or payout.
- An ambiguous transaction with no chain receipt is retransmitted using exactly the
  backed-up signed bytes. Its transaction is never rebuilt or re-signed.
- Restored journals reject a different owner, genesis hash or program binary identity.
- Corrupt backup JSON fails closed. A backup predating an intent returns unavailable;
  it does not invent replacement bytes or silently reconstruct that transaction.
- Recovery leaves the backup checksum unchanged. File/directory flush fault tests
  separately verify durable-write ordering and failure propagation.

These tests qualify application recovery behavior, **not** a Railway volume restore,
Agave ledger/snapshot restoration, SQLite crash recovery, or recovery from an old
backup against a newer live blockchain. The full isolated provider restore drill
remains open. In particular, missing intent records from an older backup require
on-chain reconciliation before financial writes reopen; test success does not make
an old backup current.

### Independent readiness checks

`.github/workflows/readiness.yml` runs the credential-free `deployment/health-check.mjs` every 15 minutes and supports manual dispatch. It verifies both gateway liveness and backend readiness with per-request deadlines and three attempts. Failures are visible in GitHub Actions; delivery of GitHub notifications depends on the account's existing notification settings. Scheduled Actions can be delayed and are not an uptime SLA, paging service, resource monitor, or substitute for a full restore drill. No service credentials or wallet keys are exposed to this job.
