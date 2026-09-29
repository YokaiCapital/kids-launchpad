# Standard v3 (public launches) release checklist

Status words: **implemented** (code exists), **tested** (automated tests or an isolated-ledger rehearsal),
**deployed** (running on the hosted pilot services), **verified live** (checked on mainnet after deployment),
**owner** (waits for the owner's action), **open** (not done). Last updated 28 September 2026, 18:20 UTC. Evidence lives in
the documents named beside each row. Nothing here counts as an external audit.

## Private pilot (one wallet)

| Requirement | Status | Code | Tests and evidence |
| --- | --- | --- | --- |
| Sealed Standard economics (47.5 / 47.5 / 5, dev 1.5 % + 3.5 % over three months), presets, two-hour windows, 0.05 SOL minimum | implemented, tested; deployed on mainnet as build `f74b9458…` | `programs/kids-launch-v2/src/policy.rs`, `programs/kids-launch-v3`, `deployment/presets/public-presets-v1.json` | v2 69 + v3 6 host tests; browser reconstruction tests; decision record 27 Sep |
| Version-3 program deployed on mainnet, governance key as upgrade authority | verified live 27 Sep (`ABq14…`), upgraded 28 Sep 11:28 UTC to `71d0d62c…` and 14:57 UTC to `ec8f9951…` (tag 40) | `localnet/deploy-program-network.mjs --program launch-v3` | `deployment/MAINNET-IDENTITIES.json` `programV3`; program review 28 Sep confirms the bytes |
| Fee cycle opening (tag 20) possible without the treasury key | verified live 28 Sep 11:28 UTC: upgrade at slot 451305566, on-chain bytes `71d0d62c…` | `fees.rs` `init`, `localnet/protocol-v3/fee-setup.mjs` | host tests; program re-check 28 Sep |
| Release manifest verified by every hosted process before serving | implemented, tested | `localnet/hosted/release-manifest.mjs`, `make-release.mjs` | `make-release.test.mjs`; release files under `deployment/hosted/` |
| Hosted signer (capabilities, operating budget, durable journal) | deployed (`kids-signer-v3`, key stored, 0.2 SOL), verified live 28 Sep: status page ready; key-loading regression fixed and proven on chain 28 Sep 21:44 UTC (settlement `3gLNBN…`, launch `2rskAv…`; A38); open: accounting-lane `operating-refill` rows lacked the lease binding (fix built 28 Sep, not yet deployed; `queue-delay` alert until deployed and the legacy row is repaired) | `localnet/signer/main.mjs`, `deployment/mainnet/signer-v3-supervisor.mjs` | signer suites; A2, A20 |
| Worker lanes and indexer as separate services with liveness and readiness routes | deployed (six worker lanes, indexer), verified live 28 Sep: all lanes observed alive on `/statusz`, queues empty | `localnet/jobs/service.mjs`, `localnet/market/public-service.mjs`, `localnet/hosted/health-listener.mjs` | `health-listener.test.mjs` |
| Pilot API (hosted creator flow, wallet-restricted, no operator key, legacy money routes off) | deployed (`kids-api-pilot`), verified live 28 Sep 15:03 UTC on build `ec8f9951…`: release checks true, one-transaction creation on, address reserve 3 of 3 | `deployment/mainnet/api-pilot-supervisor.mjs`, `interaction-review/server/hosted-creator-services.mjs` | `hosted-creator-services.test.mjs`; application review B1 to B3 fixed |
| Gateway allowlist covers creation, uploads, trade, operations and media | implemented, tested | `interaction-review/staging/gateway.mjs` | `gateway-pilot.test.mjs` |
| Pilot UI on the owner's machine with the service token kept out of the browser | implemented, tested (dev server answers) | `interaction-review/vite.config.mjs`, `deployment/hosted/pilot-ui.sh` | manual check 27 Sep |
| Creator operating reserve, refill accounting, return after refunds (option 1) | implemented, tested on isolated ledgers | `localnet/creation/operating-reserve.mjs`, `localnet/jobs/operating-refill.mjs`, `operating-return.mjs` | A34, A35 |
| Available reserve shown apart from pending refills; low-reserve alert before funds run out | implemented, tested | `interaction-review/server/creator-operations.mjs`, `localnet/jobs/observability.mjs` | `creator-operations.test.mjs`, `observability.test.mjs` |
| Funded-but-unscheduled campaign alert | implemented, tested | `observability.mjs` (`unscheduled-funded-campaign`) | `observability.test.mjs`; A33 |
| Alert delivery (status page, webhook, GitHub readiness monitor) | implemented, tested; **owner**: set `KIDS_ALERT_WEBHOOK` and the `KIDS_PILOT_API_BASE` repository variable, then run the stop-a-worker test (runbook 6) | `localnet/jobs/status-observer.mjs`, `alert-delivery.mjs`, `deployment/health-check.mjs`, `.github/workflows/readiness.yml` | `status-observer.test.mjs`, `alert-delivery.test.mjs`, `status-alerts.test.mjs` |
| Database backup and restore drill | implemented, locally tested; hosted attempt blocked by PostgreSQL client 17.11 vs server 18.6; upgrade client tools and rerun (A40) | `localnet/hosted/registry-drill.mjs`, `deployment/hosted/pilot-registry-drill.sh` | `registry-drill.test.mjs`; A40 (hosted restore not yet passed) |
| Security review of the pilot stack | done inside the project 28 Sep; blockers and Medium fixed; L2 and the edge gate open | `deployment/reviews/APPLICATION-SECURITY-PILOT-2026-09-28.md` | status table in that file |
| Adversarial review of the version-3 program | done inside the project 28 Sep; no Critical or High; tag 20 change re-checked | `deployment/reviews/PROGRAM-LAUNCH-V3-2026-09-28.md` | status table in that file |
| One click, one wallet approval, one transaction to create a coin (owner rule, 28 Sep) | implemented, tested on the isolated ledger (A37); program build `ec8f9951…` verified live on mainnet 28 Sep 14:57 UTC (slot 451352437); deployed on the hosted API with the records push; **owner**: the pilot launch itself (runbook 7) | `programs/kids-launch-v3/src/lib.rs` (tag 40), `localnet/protocol-v3/client.mjs`, `localnet/creation/mint-packet.mjs`, `interaction-review/src/public/creator-signing.mjs` | `compact-create.test.mjs`, `mint-packet-v2.test.mjs`, creator flow/controller/signing suites; `deployment/evidence/A37-ONE-TRANSACTION-CREATION-2026-09-28.md` |
| Hosted approval preserves the site network at the final pre-sign check | implemented, regression tested; deployed as `b32803d`, both CI runs green and nine services SUCCESS; owner wallet verification pending | `interaction-review/src/public/creator-controller.mjs` | A38; mainnet and devnet controller regression |
| Compact creator progress, correct early transaction mode, bounded publication response and recovery repairs | implemented, regression tested; hosted timing and owner-wallet verification still open | creator flow, publisher and journey | A39; 1–5 second target / 10-second ceiling not yet verified |
| Single-form creator, durable continuation, explicit prepublication and automatic activation | implemented, locally tested and deployed as `ff31e2d`; all nine services SUCCESS and schema 40 ready; extension signing and hosted timing qualification pending | registry schema 40; A40 | required regressions and Chrome inspection |
| One complete Standard launch through the UI: creation, commitments, settlement, launch, lock, claims, excess refunds, fee collection | **owner** (runbook 7) | | evidence to be written under `deployment/evidence/` |
| One failed launch with refunds and the reserve return | **owner** (runbook 8) | | evidence to be written |

## Before the public opening

| Requirement | Status | Notes |
| --- | --- | --- |
| Remove the pilot preset from the manifest; write the presets activation record | open | decision register |
| Upgrade authority on a hardware wallet or multisig | **owner** decision | program review M1 |
| Public site's edge gate forwards the creator, upload and media routes | implemented and edge tested; production frontend deployment unverified | A40; 4 MiB hosted video input cap |
| Image and video decoders not run as root | open | application review L2 |
| External review of the program and the stack | open | the 28 Sep reviews were internal |
| Operating vault for automatic refills at public scale | proposal only | decision register, 27 Sep |
| Site published with the public-launches flag, README and docs aligned | open | |
