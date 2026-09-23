# Release checklist

Status words: **implemented** (code exists), **tested** (automated tests or a localnet rehearsal), **deployed** (running on the hosted private environment), **verified live** (checked on kids.fun or the hosted localnet after deployment), **open** (not done). Last updated 20 September 2026, 22:45 UTC. Evidence lives in the documents named beside each row; nothing here counts as an external audit.

| Requirement | Status | Code | Tests and evidence |
| --- | --- | --- | --- |
| Password-gated frontend with independent operator gate | verified live | `interaction-review/deployment/gate.mjs` | gate tests; deployment README; kids.fun checks 20 Sep |
| Multi-wallet connector (Wallet Standard, bounded prompts, Phantom paused) | verified live | `interaction-review/src/wallet-connection.mjs`, `Account.jsx` | 9 unit tests; mock-wallet browser test; live bundle checks (dpl_EjaaiQ3k…) |
| Real wallet extension approval flows | verified live: commit, claim and trade with the owner's Jupiter wallet (22 Sep 2026) | `active-launch.mjs` localnet faucet | owner's 1 SOL commit and automatic launch on the hosted ledger; wallets warn because they simulate on mainnet |
| Escrow commit, settle, refund, atomic launch, LP lock, claims | tested, deployed | `programs/atomic-launch`, `localnet/*` | 26 launch/claim checks; lifecycle qualification 11 checks; hosted rehearsal (PRIVATE-TEST-STATUS) |
| Fee collection, conversion, 98:20:25:25 distribution | tested, deployed | `fees.rs`, `active-fee-keeper.mjs` | fee verification; lifecycle qualification |
| Parent buybacks through Jupiter with on-chain caps | verified (hosted Jupiter environment); CPMM route verified live on the main ledger after a real-wallet trade (22 Sep 2026) | `fees.rs` tag 25, `jupiter-route.mjs` | Rust 21 tests; throwaway rehearsal; hosted kids-jupiter-localnet first-boot qualification 20 Sep (PRIVATE-TEST-STATUS); mainnet API route still fixture-only |
| Reference-price guard on buybacks | implemented, tested (fixtures) | `price-guard.mjs` | 3 tests; live Pyth reads through the KIDS RPC; not yet run against a live Jupiter quote |
| Token-2022 parents (Buttcoin) | deployed, verified (hosted Jupiter environment) | `lib.rs` parent helpers | Rust tests; desktop and hosted rehearsals 20 Sep |
| Parent snapshot: eligibility, union nomination, chain read-back, exclusions, 2% cap | tested, run live (evidence only) | `mainnet-parent-snapshot.mjs` | 15 tests; live runs 20 Sep (POLICY); exclusions v3; not yet an authorized snapshot |
| Startup chain reconciliation before writes reopen | rebuilt 23 Sep 2026: every signed row checked on chain, gate needs zero unresolved; unit-tested, live after the next upload | `startup-reconcile.mjs`, `runtime.mjs` | runtime test; hosted deployment 812ff1a5 restarted, writes reopened and passed the mixed check |
| Intent archival and fail-closed escrow retry | deployed, verified live | `shared/intent-archive.mjs` | archive tests; hosted deployment df1e8340 |
| Provider backup restore drill | verified (isolated project) | `deployment/RECOVERY.md` | drill passed 20 Sep 16:27 UTC; project deleted afterwards |
| Program upgrade lineage and in-place upgrade | verified live (hosted in-place upgrade e0b4→ef58, 22 Sep 2026, campaign kept) | `program-lineage.mjs`, `bootstrap.mjs` | lineage tests; desktop upgrade rehearsal; hosted 812ff1a5 runs the lineage-aware checks with the original binary |
| Operator signing service | policy built and tested (23 Sep 2026); separate kids-signer service created; switch of the mainnet API to signer mode is an owner command | `signer-service.mjs`, `signer-policy.mjs`, `deployment/mainnet/signer-supervisor.mjs` | 7 adversarial tests incl. the 1.4 SOL compute-only refusal; 3 client tests; lifecycle rehearsal with 22 remotely signed transactions; not deployed |
| Reproducible program build | verified (CI) | `.github/workflows/sbf-build.yml` | two runners, equal hash ef584ae7… |
| Alerts | monitor rebuilt 23 Sep 2026 (mainnet, test ledger, kids.fun, status thresholds); delivery to be confirmed by the owner after the simulated-failure run in the new repository | `readiness.yml`, `health-check.mjs`, `shared/service-status.mjs` | unit tests; simulated run pending |
| Mixed read/write load | tested (bounded) | | 60/60 reads, 5/5 signed commits through kids.fun 20 Sep |
| Mainnet identities | partial | `MAINNET-IDENTITIES.json` | parents verified on chain; dev wallet owner-supplied, unproven; treasury missing |
| Mainnet program deployment and upgrade authority | program deployed 23 Sep 2026 (BLiaZWNQ…, bytes verified); authority move to the governance key pending the owner's command | `localnet/deploy-program-network.mjs` | deploy signature 2Ty3yuDM…; `/tmp/kids-mainnet-governance.sh` |
| Independent contract and economic review | open | | owner's responsibility (external) |
| Hosted environment with Jupiter in genesis | verified live | `deployment/railway/*` | project kids-jupiter-localnet, deployment 917e9b6c, gateway smoke 20 Sep |
| Site opened to the public | open | | after every row above is verified live |
