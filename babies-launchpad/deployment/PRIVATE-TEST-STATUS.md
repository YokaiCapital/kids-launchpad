# Private production-hosted test status

Updated 2026-09-20. The password-protected frontend is attached to https://kids.fun on Vercel. It connects to an authenticated gateway in a dedicated Railway project containing an isolated Solana **localnet**, with freshly generated test keys and a persistent volume. No real deposits or mainnet launch are enabled.

Verified end to end:

- Full native launch, liquidity lock, allocations, refunds, vested claims, fee routing and parent buy/burn qualification passed on the hosted test validator.
- Remote commitment reached the native escrow program; replay returned the same signature without adding another commitment.
- Remote canonical-pool purchase and replay passed.
- A vested developer claim passed through the Vercel domain and gateway.
- Restart preserved campaign/program identity, committed balance and both transaction intent signatures.
- 100 simultaneous authenticated mixed API reads through kids.fun: 100 successful responses, approximately 2.54 seconds p95. Direct gateway check: 100 successful responses, approximately 1.47 seconds p95. These are bounded smoke tests, not a sustained traffic or DDoS certification.
- Site password and separate operator password, Secure/HttpOnly cookies, service authentication, operator checks and CSRF boundaries passed HTTP integration checks. Anonymous asset/API requests remain gated on the custom domain and Vercel alias.
- Vercel WAF limits password attempts and API bursts. Gateway body, timeout, concurrency and queue limits remain enforced.

The hosted localnet program ID is `F5SFr87MGqnxrnrr5MgySRjYrynm2588e93eUUcrxoFv`; this is **not a mainnet address**. The desktop localnet uses its own program ID and ledger. The exact reviewed custom program SHA-256 is `e0b4051752422366e51ae6a5fe8eaeeeab773faa1448cec33a0990961c76e71d`.

## Before public mainnet launch

This environment is ready for private functional testing, not a claim of production fund safety. Mainnet still requires verified real mint and treasury configuration, canonical parent-pool routing and economic/price controls, a production keeper and durable transaction coordination appropriate to the deployment, independent contract/security review, upgrade-authority decisions, backup/recovery and sustained capacity qualification. Existing upstream program and snapshot-publisher trust boundaries must remain disclosed. Do not burn the fee keeper's required signing key; permanent LP locking and mint-authority revocation are separate operations.

Cloudflare is not currently the active DNS/WAF layer. Its integration requirements are documented separately. Current edge protection is provided by Vercel.

The browser login issue was resolved: the login page now uses a same-origin referrer policy, preserving the origin required by the form POST while withholding cross-origin referrers. Password submission was verified in Chrome through to the rendered KIDS home page; cross-origin and null-origin login attempts remain rejected.

## Runtime hardening pass

The deployed release replaces Vite preview with a standalone loopback Node API. It runs under a nonblocking kernel writer lock, drains in-flight API requests before stopping validators, and exposes separate liveness/readiness checks. Readiness checks both ledger identities plus active program/campaign availability. Signed intent journals use private temporary files, file fsync, atomic rename and directory fsync before any broadcast, including retries.

External-wallet post-launch claim preparation/submission is implemented with recipient/account/instruction checks and durable exact-byte replay. The active post-launch page now binds to the launched active campaign; `/#shart-preview` explicitly selects the qualified rehearsal while `/#shart-live` remains unavailable before the active campaign launches. Standard wallet signing and bounded priority-fee signing both passed remote localnet commitments. This does not yet establish compatibility with every browser wallet.

Daily, weekly and monthly Railway volume backups are enabled. The initial backup exists; restoration has not yet been qualified. See [recovery runbook](RECOVERY.md) and the [machine-readable unresolved release gates](RELEASE-GATES.json). Those gates intentionally remain false/missing until supported by evidence. No test pass, preview or deployment automatically opens public access or enables real funds.

Hosted checks after this pass: 100/100 authenticated mixed requests through Vercel, p95 1.36 seconds. Direct gateway handled 1,000/1,000 mixed reads with concurrency 100 in 19.2 seconds, p95 1.49 seconds (maximum 10.96 seconds). This is a short load qualification, not a DDoS guarantee or sustained production SLO. The real Linux kernel writer-lock test passed on Railway. A wallet-signed dev claim through the domain confirmed and replayed without a second payout; the active prelaunch remained distinct from the rehearsal pool.

A subsequent hosted restart preserved the exact program/campaign identities and wallet session. Replaying the persisted external claim returned the original signature and unchanged claimed balance. Wallet-style bounded priority-fee commitment also passed after the restart.

## Active lifecycle engineering qualification

The active v3 adapter now has an automatic close/settle/launch worker and durable settlement/launch journals. A disposable-registry test on the desktop isolated validator exercised a 1,000 SOL commitment: 500 SOL accepted, 500 SOL refunded, one canonical locked pool, revoked mint/freeze authorities, participant claims, both parent communities and the developer launch unlock. A second below-soft campaign fully refunded. Original active campaign registry/journal hashes were unchanged. This is real-chain adapter qualification with local test wallets, not a browser-wallet or hosted long-lived campaign close.

Submission testing exposed RPC acceptance without inclusion. The operator now periodically rebroadcasts identical persisted signed bytes, cancels confirmation subscriptions at its bounded deadline, and uses abortable HTTP RPC timeouts. Replacement remains gated on finalized expiry or finalized failure. Application backup tests restore durable signed intent snapshots and reconcile chain receipts without duplicate payout; a full provider-volume/Agave/SQLite restore remains outstanding.

The active fee worker now also passed the disposable real-chain lifecycle test: canonical child trades generated earnings, collection used the Fee Key position’s own locked LP amount, actual WSOL recipient deltas matched 98:20:25:25, and both parent mint supplies decreased by the purchased-and-burned amounts. It is wired into the localnet API timer, with one operation per tick and collection rate limiting. Spot quotes remain explicitly unsuitable as mainnet oracle/MEV protection.

## Multi-wallet connector (20 September 2026, evening)

The wallet panel now lists every Solana wallet found through the Wallet Standard registry, with an injected Phantom/Solflare/Backpack fallback, and the one selected wallet is reused for commitments, refunds, claims, trades and the legacy ballot. Sign-in requires an explicit click, validates the server challenge (origin, wallet, nonce, expiry) before signing, times out stalled prompts, rejects account switches, and sign-out revokes the session even when the extension does not answer. Transaction validation is unchanged: raw wallet-returned bytes are checked against the approved message, only bounded compute-budget additions are accepted, and there is no sign-and-send fallback.

Evidence: 8 unit tests, a full local suite of 181 tests (180 passed, 1 Linux-only skip) and the frontend build. A browser test with a disposable mock Wallet Standard wallet against the local dev server passed discovery, sign-in, a 1 SOL localnet commitment signed by the mock wallet and confirmed on chain, session revocation on sign-out and a keyboard-reachable list at 390 px and 1280 px widths. Real extension approval and signing (Phantom, Solflare, Backpack and others) is NOT qualified yet; wallets that simulate against mainnet may refuse localnet transactions and must fail safely. Wallet sign-in works only on the kids.fun origin because the gateway binds the challenge to that origin.

## Provider volume restore drill (passed 20 September 2026)

An isolated, disposable Railway project was created for a full provider-level restore: a finalized 0.001 SOL commitment and a signed-in session were created, the intent was archived, a provider backup was taken, a post-snapshot marker was written, the backup was restored into a new volume, the original volume was detached, the restored volume was attached and the service redeployed. Verification at 16:27 UTC passed: marker absent, SQLite session restored, same genesis/program/campaign/mint/commit total, exact same-signature replay without a second commitment, archived intent found without broadcast. The disposable project and both volumes were deleted afterwards; the main project was untouched. The recovery gate stays partial because post-restore chain reconciliation, sustained mixed read/write capacity and tested alerting are still open.

## Frontend deployment with the multi-wallet connector

Vercel production deployment `dpl_2bhMqkfQc2MzN6RLL8Y9YaTdLzYP` (20 September 2026, 16:26 UTC) is live on https://kids.fun. Verified through the gate: anonymous HTML and assets still gated, password login, authenticated frontend served, the bundle contains the wallet list, the Wallet Standard registry and the bounded-prompt code, and the authenticated account API answers with a CSRF token. Source: the private KIDS repository commit 2559dd4, CI green.

Phantom is paused in the wallet list (visible, disabled, "Waiting for Phantom whitelisting") because Phantom flags kids.fun as malicious until the domain is whitelisted with Phantom. Other detected wallets remain selectable. Browser check: a mock Phantom rendered disabled and inert while a mock Solflare stayed usable. Deployed as Vercel `dpl_EjaaiQ3knuBTEnj6jsTqEYL3Dgb6` (17:00 UTC) and verified on kids.fun and the alias: gate intact, bundle carries the pause, Phantom install link removed. Source commit 9eb741b, CI green.

## Mainnet parent snapshot reader (20 September 2026)

`localnet/mainnet-parent-snapshot.mjs` reads the two real parent communities through the server-side Helius URL: the index nominates, the chain decides (finalized read-back with a minimum context slot), two concurrent passes are unioned, Token-2022 is decoded with an explicit extension policy, and evidence is create-once. A live trial of both parents completed in 56 seconds (Fartcoin 170 eligible owners, Buttcoin 284). This is a reader with evidence, not an authorized snapshot: the campaign, the announced window, the treasury address and the owner's decision on caps and exclusions come first (see `PARENT-SNAPSHOT-POLICY.md`).

Snapshot lookups now follow the reliability rules (classified bounded retries, explicit unresolved outcomes, completeness gate on publication). With the owner's confirmed exchange exclusions applied, the 17:55 UTC run resolved every lookup and completed both parents in under a minute; further flagged owners are listed as proposed and stay eligible until confirmed.

## Token-2022 parent rehearsal (20 September 2026)

The desktop localnet program now accepts Token-2022 parents with an on-chain extension policy, and the full launch, claims, fee and parent-burn verification passed with parent B under Token-2022 (see ACTIVE-FEES.md). The hosted localnet still runs the reviewed classic-only binary. Separately, the mainnet buyback venue question is open: the program's Raydium CPMM tier has no parent liquidity on mainnet; Buttcoin trades on PumpSwap and Fartcoin on Raydium AMM v4.

## Jupiter buyback rehearsal (20 September 2026)

Parent buybacks now route through Jupiter (program tag 25) with on-chain caps; the full launch, fee and burn verification and the lifecycle qualification with the keeper passed on a throwaway validator that has Jupiter cloned (see ACTIVE-FEES.md). The hosted localnet ledger predates Jupiter, so it cannot rehearse this path without a new genesis; the API route has fixture coverage only.

## Reproducible build, alerts and reconciliation (20 September 2026)

- The reproducible-build workflow compiled the program on two independent runners with the pinned Anza toolchain and both produced the same SHA-256 (run 35533998732); the hash is compared with local builds in ACTIVE-FEES.md.
- The readiness workflow can be dispatched with `simulate_failure=true`; run 35534207290 failed on purpose at 20:01 UTC so the owner can confirm GitHub's failure notification reached them. Until that is confirmed, alert delivery is unproven.
- The API now reconciles every intent journal with the chain before reopening financial writes (RECOVERY.md).

## Mixed read and write workload through kids.fun (20 September 2026, 20:15 UTC)

Through the password gate and operator gate, against the live hosted active campaign (open): 15 concurrent authenticated readers over the state, prelaunch and post-launch routes (60 reads, all HTTP 200, p50 243 ms, p95 999 ms, max 1,061 ms) while a writer prepared, submitted and replayed five 0.001 SOL operator-signed test-identity commitments (5 of 5 confirmed, whole prepare-submit-replay cycle p50 880 ms, max 1,907 ms, submit p95 756 ms; every replay returned the original signature). The campaign's committed total rose by exactly 5,000,000 lamports. This is a bounded mixed smoke test with one writer, not a sustained capacity figure or a claim about many concurrent external-wallet signers.

## In-place program upgrade rehearsal (20 September 2026, 21:10 UTC)

On the desktop ledger, whose active campaign and journals predate three program upgrades, the deploy script upgraded the program in place (lineage e0b405… → e0e5bd… → 88ddba… → 409e79…), the running API kept serving the existing campaign without a restart, and the disposable lifecycle qualification passed its 11 checks on the upgraded program. The hosted bootstrap gained the same upgrade path (RECOVERY.md); it has not been exercised on the hosted ledger yet, which still runs the reviewed classic-only binary.

## Hosted deployment 812ff1a5 (20 September 2026, 21:55 UTC)

Uploaded from a fresh allowlisted context (345 source files, reviewed program binary e0b4…e71d unchanged, scanner finding only the documented compiler-path exception in that binary). It carries the startup chain-reconciliation gate, program-lineage identity checks, the signer-ready operators (local signing still in use; no signer service deployed), the Token-2022 and Jupiter code paths (inert on this ledger, whose program and genesis predate them) and the hardened snapshot tooling. After the restart the gateway reported ready, and the mixed check through kids.fun passed again: 60 of 60 authenticated reads (p95 913 ms) and 5 of 5 operator-signed test commitments with exact replays, committed total moved by exactly 5,000,000 lamports. The previous deployment df1e8340 remains the rollback target.

## Second hosted environment with Jupiter (20 September 2026, 22:30 UTC)

A new isolated Railway project, kids-jupiter-localnet, boots a fresh localnet whose genesis clones Jupiter v6 beside Raydium CPMM, the Raydium locker and Metaplex, runs the CI-built program `ef584ae7…8923` (pinned through `KIDS_PROGRAM_SHA256`) and rehearses both new paths at first boot (`KIDS_PARENT_B_TOKEN_2022=1`, `KIDS_PARENT_BUYBACK_ROUTE=jupiter-localnet`). Gateway: https://kids-jupiter-localnet-production.up.railway.app (service and operator tokens in the owner's private config, never in the repository). The first boot failed once when that validator's older Token-2022 refused the embedded-metadata initialisation; the fixture now falls back to a metadata-pointer-only mint when that happens, the empty volume was replaced, and deployment 917e9b6c completed: launch and claims with a classic and a Token-2022 parent, fee collection, conversion, distribution, both parents bought through Jupiter's Raydium CPMM adapter and burned (89,711,851 raw each), the below-minimum route, oversize slice, impossible swap, wrong token program and replay all rejected on chain. Through the gateway: anonymous calls refused, authenticated state, test-identity sign-in, prelaunch and rehearsal reads and the admin state all answered. Program id on that ledger: `EDKHHJDBbcgNkLCbaw66AQnJnEYEqx2Mge95y5qzuTxa`. This environment is a rehearsal ledger; it is not the site's backend and the original private environment is unchanged.

Wallet reconnect fix (owner report: "Select the signed-in wallet before approving this transaction" on commit) deployed as `dpl_8yXYmFAHaQyYgqR3oQSFtFAZXHSn` and verified on kids.fun and the alias at 21 September 00:05 UTC: the bundle reconnects to the signed-in account and names both accounts on a mismatch. The owner's retry with a real extension is pending.

## Admin removed from every uploaded artifact (22 September 2026)

Owner rule: the Admin link and admin functions must not be uploaded; they remain local. The production frontend build no longer contains the Admin view, navigation entry or route (verified by inspecting the built assets), and both the Vercel gate and the hosted gateway refuse `/api/admin` with 404 even with the operator credential (tests updated). Admin remains available only on the local development server.

Hosted deployments 9d0bcac0 (private localnet) and 81fc89ed (kids-jupiter-localnet), 22 September 2026: both gateways ready afterwards and refusing `GET /api/admin/state` and `POST /api/admin/settings` with 404 even with the operator credential, account routes unaffected. Upload contexts are now source-only (2.7 MB; media the container never serves is left out) because a 59 MB upload timed out on the owner's line.

Frontend deployment `dpl_FNquYBbRKWL6cbTGH56vxNHwjQZq` (22 September 2026) verified on kids.fun and the alias: no admin view, route or navigation in the served bundle, `/api/admin` refused by the gate with 404, wallet reconnect fix present, anonymous access still gated.

## Test campaign renewal (22 September 2026)

The hosted private campaign closed on schedule at 2026-09-21 06:09 UTC as `failed` (0.016 SOL committed against the 100 SOL soft cap); the keeper refunded every commitment and settled all six receipts, which is the intended outcome, but the site then showed no open campaign. `KIDS_ACTIVE_CAMPAIGN_RENEW=finished` (set on the private localnet service only) makes the bootstrap archive such a campaign into `/data/localnet/archive/<campaign>/` (files moved, never deleted) and open a fresh 24-hour test campaign before the API starts. Only a campaign in phase `failed` with refunds equal to the total and every receipt settled qualifies; a launched campaign, or one with anything outstanding, is left in place and the skip is logged. The variable is a private-test convenience and must stay unset anywhere real funds could exist.

Hosted deployment 4d85a855 (private localnet, 22 September 2026, 19:59 UTC) carries the renewal code; the gateway reported ready afterwards and the finished campaign is unchanged because `KIDS_ACTIVE_CAMPAIGN_RENEW` was not yet set (setting it is an owner action: the tool policy refused the variable change from this session).

## Short test campaigns and wallet test SOL (22 September 2026)

Owner request: real tests need a 1 SOL soft cap and a five-minute funding window so the launch and pool creation can be watched. New campaigns take their terms from `KIDS_ACTIVE_SOFT_CAP_SOL`, `KIDS_ACTIVE_HARD_CAP_SOL` and `KIDS_ACTIVE_DEADLINE_SECONDS` (defaults unchanged: 100 SOL, 500 SOL, 24 hours; the 24-hour launch window and the 500 SOL ceiling are fixed; invalid values refuse provisioning). The manifest validator now accepts any terms inside those bounds instead of the literal production numbers, and the pool figures shown on the site are derived from the caps. On the loopback test validator only, a wallet that cannot cover its commitment is topped up from the localnet faucet before the unsigned transaction is built (`KIDS_LOCALNET_FAUCET=0` turns it off); the check is bound to the manifest's fixed loopback rpcUrl, so it cannot run against any other network. `KIDS_ACTIVE_CAMPAIGN_RENEW=any` also renews a launched test campaign once every receipt is settled and no signed intent is unresolved; the old coin stays on the ledger but is no longer reachable from the site. Unit tests: 124 localnet, 87 site; web build clean.

Correction, 22 September 2026 21:40 UTC (amended 22:05 UTC): `KIDS_ACTIVE_CAMPAIGN_RENEW=finished` was set by the owner running the first version of `/tmp/kids-renew-campaign.sh` (his terminal output shows the variable being set); the refused command from this session did not run. Deployment 41cfddc7 then renewed the finished campaign at boot with the default terms (100 SOL soft cap, 24 hours, open until 23 September 20:20 UTC). So that the short test terms can replace it, mode `any` now also archives an open campaign with zero receipts and zero lamports committed; a campaign holding anyone's money is never replaced.

## First real-wallet launch on the hosted ledger (22 September 2026, 21:12 UTC)

The owner opened a 1 SOL, five-minute campaign with `/tmp/kids-renew-campaign.sh` (deployment a19293b2), committed 1 SOL from his Jupiter wallet on kids.fun (the wallet warned "Simulation failed" because it simulates against mainnet, where the program does not exist; he continued and the commit confirmed on the test ledger with the faucet top-up), and 27 seconds after the deadline the keeper settled and launched by itself. Campaign `FwSXhZFVUG4wD25cYsSV4mr7hfqHCoHSQzBxEg24bKnL`, mint `8wxqJJeeNeJsBKa3Q7JRFxvop6uRryS1JeY3hbhhBdvA`, pool `73LdhWiXocBcmRnoaicos5N2AaFmdAkBNh3bQYzvrf6y`, launch signature `2fuhoto5…kmn1`: 435,000,000 coins and 1 SOL in the pool, mint and freeze authority revoked, liquidity lock created by the launch instruction itself (the program refuses a launch without the lock accounts; the API does not yet read the lock account back, so the site shows "LP lock verified at launch"). Claims and trading are open on the site. Owner feedback the same minute: the "confirmed on localnet" line was too small; replaced by a green banner (b35f705, needs the owner's Vercel deploy).

Claim and trade with a real wallet (22 September 2026, about 21:40 UTC): the owner claimed his allocation and sold part of it through the site with his Jupiter wallet; both confirmed on the test ledger. Pool moved from 435,000,000 coins / 1 SOL to 465,155,407 coins / 0.953 SOL. Fee counters were still zero at that moment because the fee keeper collects every 300 seconds; the collection is being watched. Found on the way: a direct link in a new tab lost the wallet choice (sessionStorage) while the sign-in cookie held, so the claim asked to connect; fixed in 0341783 (localStorage plus account-based wallet restore).

Renewal made one-shot (22 September 2026, 22:20 UTC): with `KIDS_ACTIVE_CAMPAIGN_RENEW=any` left on the service, every restart would have archived the launched test coin. Deployment 40e0e15e (plain-language errors and the trade balance guard) was removed while building for exactly that reason and re-uploaded as c5f42dcf with the fix: mode `any` needs a token and applies once per token; the owner's script sends a fresh token per run. The launched coin `8wxqJJee…hBdvA` stays on the site.

Parent buybacks blocked on the main hosted ledger (found 22 September 2026, 21:36 UTC): after the owner's trade the keeper collected, converted and split the fees (treasury 0.0102 SOL, dev 0.0021 SOL, 0.0026 SOL per parent) but every buy-burn attempt failed with program error 60. Cause: the main ledger still runs the reviewed program `e0b4…e71d`, which predates the Token-2022 change, while the keeper now passes the parent token program as an extra account (tag 24). Remedy: upgrade that program in place to the CI-built `ef584ae7…8923` (Dockerfile and bootstrap defaults now point at it; the upload folder carries that binary). The upload itself was refused by this session's tool policy, so the owner runs `/tmp/kids-upgrade-program.sh`. Nothing is lost meanwhile: the parent allocations stay recorded and the keeper retries after the upgrade. Frontend note: the owner's two Vercel runs shipped the same pre-built bundle because the folder had not been re-prepared; it is re-prepared now (bundle index-dt2uet9x.js).

## In-place program upgrade on the hosted ledger (22 September 2026, 21:51 UTC)

The owner ran `/tmp/kids-upgrade-program.sh` (deployment e115f839). At boot the bootstrap found the deployed program `e0b4…e71d` different from the image's `ef584ae7…8923`, confirmed the admin key holds the upgrade authority, and upgraded in place (`solana program deploy … --program-id F5SFr87MGqnxrnrr5MgySRjYrynm2588e93eUUcrxoFv`, log 21:51:32). The program id is unchanged, the manifest lineage now lists both hashes, the gateway reported ready, and the launched campaign `FwSX…bKnL` with its pool, claims and fee journal stayed valid. This is the first hosted rehearsal of the upgrade path that the checklist had marked untested. Parent buybacks on this ledger are watched after the upgrade (the keeper's next cycle).

Parent buybacks after the upgrade (22 September 2026, 21:52 UTC): within a minute of the upgraded service coming up, the keeper spent both parent allocations (0.0026 SOL each) through the Raydium CPMM route and burned 254,555,896 raw of each parent. The main hosted ledger now runs the full fee cycle: collect, convert, split, buy back and burn.

Live page review (22 September 2026, 22:30 UTC): kids.fun screenshots through the gate at 1440 and 390 px, launch and coin pages. Found and fixed: the token reserve figure wrapped mid-number on phones. Bottom navigation appears mid-page only in full-page screenshots (it is fixed to the viewport). Added the buyback and burn section and the balance-aware swap panel (24046fb); API deployment 4a37ec8d carries the fee event journal and wallet balances.

## Mainnet build, steps 1 to 3 (22 to 23 September 2026)

Owner decision 22 September ~22:20 UTC: go to mainnet, reuse Pairz services, Helius RPC, real wallets, mainnet snapshot, program on mainnet. Built so far, all tests green (localnet 135, site 95): the network profile (`localnet/network.mjs`); operator key by network (`localnet/operator-key.mjs`, hosted: `KIDS_OPERATOR_KEY_JSON` written to the volume at first boot); the campaign plan tool (`plan-network-campaign.mjs`, nonce and terms fixed before the snapshot); the snapshot importer (`import-parent-snapshot.mjs`, evidence to Merkle trees with the capped balances and the eligible total); the real-network provisioning path with `KIDS_DRY_RUN=1` simulation; the deployment tool (`deploy-program-network.mjs`, reproducible binary only, RPC URL through a temp CLI config); the real-network service image (`deployment/mainnet/Dockerfile`, `supervisor.mjs`: program verified on chain against the recorded hash, manifest with lineage, idempotent provisioning, API plus gateway); the legacy escrow stands down off localnet. Keys created on the owner's Mac under `~/.config/kids/mainnet/` (program `BLiaZWNQoPm4mG4cXNm4sXifFqs1Xmxx12qD9T4Y5NeN`, operator `AAuwkFNvXRimHyvdQfh7Zik9baw8W2ufSbc5cyBqsdoE`, dev `EkqTC1NbAg9zjFxdWY4psYtyHU3JpXDeXCkerSahraSJ`) and `~/.config/kids/devnet/` for a rehearsal (devnet faucet rate-limited at 1 SOL so far). Not yet done: mainnet program deployment (needs about 3 SOL on the operator), the Railway project (script ready), the mainnet snapshot run, the first campaign plan, the mainnet site build and Vercel project.

## Program on mainnet (23 September 2026, 00:03 UTC)

The owner funded the operator wallet with 3 SOL and the deployment tool put the reproducible build `ef584ae7…8923` on Solana mainnet as program `BLiaZWNQoPm4mG4cXNm4sXifFqs1Xmxx12qD9T4Y5NeN` (signature `2Ty3yuDM…1jCga2`, upgrade authority the operator wallet, program data sized to the binary, on-chain bytes verified equal to the binary). The Railway project kids-mainnet (service kids-api, volume, domain `kids-api-production-fc8e.up.railway.app`) was created by the owner's command with its secrets; the first service upload follows. Commit history of the repository was rewritten by the owner on 22 September to remove tool attribution lines.

## Mainnet API and site live without a campaign (23 September 2026, ~00:20 UTC)

After two boot fixes (program hash check hashed the recorded binary size; real-network readiness probes the RPC genesis only) the kids-mainnet API came up ready on the owner's third upload (deployment 6903656c): program `BLiaZWNQ…` verified on chain, operator key on the volume, no campaign configured. The owner then published the mainnet site as Vercel project kids-mainnet; `https://kids-mainnet.vercel.app` serves bundle `index-BaQa7pHR.js` behind the same password gate, built for mainnet (footer 'Solana mainnet · Live', network guard refuses any other API). Deployment-hash URLs of that project sit behind Vercel's own login. kids.fun is unchanged. From the UX audit: the Launch page now shows the live status card instead of a timer to a past date, and a label placeholder rendered literally was fixed (eafc078). Remaining before the first mainnet campaign: the owner's go on terms and timing, then an upload that includes the campaign plan (creates the coin and the escrow on mainnet, ~0.35 SOL from the operator's remaining ~0.87 SOL), moving kids.fun or announcing the mainnet URL, and the audit's open blockers (single coin page, Your rewards entry, burn history wording, mobile order).

## Test-ledger outage (22 September 2026, 23:40 UTC to 23 September 00:12 UTC)

The owner reported kids.fun failing to fetch. The private localnet service (deployment 4a37ec8d) had lost its validator at 23:40:48 UTC: every keeper tick logged 'fetch failed' against the loopback RPC while the API and gateway stayed up and reported unavailable. No exit line reached the logs, so the cause is not proven (memory pressure of a long-running test validator is the likely one). A service restart at 00:07 UTC brought the persisted ledger back with the launched campaign intact; kids.fun fetched again at 00:12 UTC. Found in the same logs: the fee keeper was retrying a collection every tick because the accrued pool fees rounded to zero LP tokens (Raydium CPMM ZeroTradingTokens, 0x1776); fixed so the keeper releases that operation and waits for the next interval. The Railway CLI had lost its Homebrew link on the Mac; it runs from its Cellar path until relinked.

## Architecture audit items 1 to 3 (23 September 2026)

User instruction: treat the audit's high-priority findings as public-launch blockers and fix them in order with regression tests. Done: (1) chain-backed startup reconciliation, `localnet/chain-reconcile.mjs`, every signed row checked on chain regardless of archival thresholds, operator journals included, gate complete only with zero unresolved rows; (2) signer policy, `localnet/signer-policy.mjs`, the 1.4 SOL compute-only reproduction is refused, keeper templates only, campaign binding, fee and spending limits, lookup resolution, operation ids; (3) key isolation: the API runs in signer mode only on mainnet (`deployment/mainnet/operator-mode.mjs`), wipes any key on its volume, provisioning signs through the signer, a separate signer service supervisor exists, and the upgrade authority moves to a governance key with `/tmp/kids-mainnet-governance.sh`. Tests: localnet suite 150 (149 pass, 1 skipped). Not yet applied on the live mainnet service: the signer service variables and the API's switch to signer mode are owner commands.

## Representative tests after the architecture audit fixes (23 September 2026, 01:20 to 01:24 UTC, test ledger)

Deployment 615bbb0d of the private test ledger with all six audit items. Mixed load through the gateway: 40 workers, 320 reads (public and signed-in, three routes), all HTTP 200, p50 198 ms, p95 362 ms, p99 375 ms, 150 requests per second sustained for the run; four commit preparations during the same window answered 400 "Commitments are closed" (the campaign is launched), so the write class was admitted and refused by the API rule, not by admission. Write path: 24 concurrent trade quotes for the test identity, 20 accepted (p50 272 ms, p95 485 ms), every exact replay returned the same intent, 4 refused by the per-wallet pending-intent cap. Restart: `serviceInstanceRedeploy`, gateway ready 30 s after the restart began, reconciliation complete (7 journals, 0 unresolved), writes open, keeper heartbeats for active, fees and legacy on the status page within 2 minutes, campaign unchanged (launched, pool 73Ldh…rf6y), and a quote request id prepared before the restart replayed to the same intent afterwards. Recovery from a provider backup was drilled on 20 September for this ledger; the mainnet service has no backup yet (owner action). Status page disk: 17.9 % free on the test volume (ledger growth; alert threshold 10 %).

## Mainnet services in signer mode (23 September 2026, 01:17 to 01:24 UTC)

The owner ran the four commands: signer service configured and uploaded (deployment 44abd124), API re-uploaded in signer mode (e6fedb5c), operator key removed from the API's variables, `KIDS_SIGNER_KEY_JSON` removed from the signer after its first boot, and the program's upgrade authority moved from the operator key to the governance key `EPwoPzJ5wuFgvMxUs7gQyUgb48dfZh4k6TxpZsTpWf2Y` (verified on chain). The mainnet status page reports the signer reachable with the expected public key, keepers heartbeating, reconciliation complete and writes open. Alerts: the readiness workflow now opens a repository issue on failure (issue #1 from the simulated run) and posts to an optional webhook; the owner did not receive GitHub's failure email, so the issue path is the proven one until GitHub notification settings are fixed.

## First mainnet launch (23 September 2026, 02:08:49 UTC)

Owner test on Solana mainnet, real SOL, everything signed through the policy-bound signer service with no key in the API. Attempt one (campaign `9zT7cyDv…`, 3-minute window) opened at 01:44 UTC and closed at 01:47 without a commitment: coin `GF28FYe4…` created, escrow created, nothing to refund. Attempt two (campaign `8LmwBAa5…`, 10-minute window): the API archived the failed campaign at boot (`KIDS_ACTIVE_CAMPAIGN_RENEW=finished`), provisioned the new one at 01:58 UTC, the owner committed 2 SOL from kids.fun, and 29 seconds after the 02:08:20 deadline the keeper settled and launched: coin `8P47V2fj1yfg1C76YAZEXJBVzDJBFfURUUTeJjVJq5bz`, Raydium CPMM pool `FAThun8yCqyatCAmcUAfqdmD83zHN3RZieEk6FkB5Zcn` with 2.006 SOL and 434,792,607 coins, mint and freeze authority revoked, liquidity locked by the launch instruction, launch signature `4x6SEETK…KQoba`. Status page: keepers active=launched, fees=completed. Copy fix: while launching, the card no longer counts down the 24-hour launch window (the program's deadline for the launch itself, after which everything is refunded); it says the launch is running.

## Economics change and scanner findings (23 September 2026, 02:30 to 03:10 UTC)

Owner decisions after the first mainnet launch: coin-side trading fees are burned, not sold (holders complained about sell pressure); pool fee tier 2.5 % (Raydium offers no 3 %; Raydium keeps 16 % of every fee). Program change: fee tag 26 burns the coin-side fees through the fee authority and records `burned_child` (offset 120 of the fee state); the AMM config is taken from the passed account and must be the 2 % localnet clone or the 2.5 % mainnet tier; the launch derives the pool from that config. Off-chain: the keeper burns instead of converting, the API serves the live fee tier and the launch-authority address (the 'top holder' scanners flag is the program's custody of unclaimed coins), the coin page shows a burned-from-fees tile and the custody note; the launch-authority top-up is 0.22 SOL (a mainnet launch used 0.18). Rust 21 tests, localnet 154 (153 pass, 1 skipped), site 98. Scanner claims checked on chain: the launched coin's mint and freeze authorities are null (Axiom showed a reading from the ten minutes before launch). Pending: reproducible CI build hash, the auditor's look at the diff, the upgrade with the governance key, and coin metadata via Pinata.

## 23 September 2026, ~06:40 UTC: mainnet API upload (source a6addde, upload folder at parity with main up to e8b9439)

- Live after the owner's upload: `/readyz` 200, `/statusz` ready, writes open, reconciliation complete (0 unresolved, 6 expired intents flagged "not proven absent"), schedule served (`next.opensAt` 2026-09-24T16:00:00Z) beside the launched test coin, post-launch data reads the live 2 % pool (tradeFeeBps 200, pool FAThun8y…).
- Verified fix: signed-in coin page `/api/account/postlaunch` 200 with a throwaway wallet through kids.fun's gate (was 400 "Wallet missing").
- Not yet live: signer upload (SEC-01/02 signer fixes run in the signer service), site bundle index-Cvuj5Hi1.js (card, PFPs, countdown), program build 2.

## 23 September 2026, ~07:15 UTC: program build 2 live on mainnet

- Upgrade signature `5CBxyEGn…zYf` (governance key); extension by 10,240 bytes paid by the governance key after a 0.0727 SOL top-up from the operator (`3XDsec3s…dyk`). Read back: program-data 209,293 bytes, first 200,784 bytes hash `9721a4d8…ae58`, tail zero, authority `EPwoPzJ5…Wf2Y` unchanged.
- Found live: the keepers reported "Active campaign ledger or program changed" because the live-upgrade path did not carry the previous build in the lineage; fixed in the service (test added). The API must be re-uploaded (or restarted) to run the keepers again.

## 23 September 2026, ~04:20 UTC: deploys now come from GitHub (release branch)

- kids-api deployment a18729fd and kids-signer 38945427 both built from YokaiCapital/kids-launchpad, branch release, commit 1f37128 (owner connected both services; the CLI upload is retired).
- Live after the deploy: ready, writes open, signer reachable, keepers running (active: launched, fees: completed), reconciliation complete.
- FIRST COIN-SIDE BURN on mainnet (build 2): 670,345.318218 coins burned at 04:17:57 UTC, signature `3iFTQBFjvkxGGFq397HG4NkbSGo1eRMGKkzccvSQwgsiypFyXJXHwJga3r6XL3vVimLz3D7wvrzAuzD3w4mA1YNQ`; childPending 0, childBurned 670345318218 raw.

## 23 September 2026, ~04:25 UTC: claim vaults proven on the local ledger (not deployed)

- `node localnet/verify-distribution-launch.mjs` on the desktop localnet: campaign 7JirULm5…, launch 34WNH2gE… funded the four vaults inside the launch (43.5 % / 5 % / 5 % / 3 % exactly, custody empty), old claim paths refused (0x28), participant, both parent and dev claims paid from their vaults with repeats paying nothing, forged leaf / altered proof / foreign receipt / below-threshold refused, burn before the 30-day expiry refused, a 1,000-unit donation swept to burn with the supply reduced by exactly that. Parent expiry recorded 2026-10-23T04:09:10Z (launch + 2,592,000 s).
- The classic path (campaign without a distribution program) re-verified on the same build with `atomic-launch-verify.mjs`.
- Builds: kids_atomic_launch.so 210,440 bytes `1f8d3dbe…2de5`; kids_distribution.so 128,576 bytes `75252cab…13d9` (local builds; CI reproducible hashes follow the push). Program tests 29 + 19.
- Still owed before mainnet: independent review of both programs, CI hashes, deployment of kids-distribution (governance key), recording its id in MAINNET-IDENTITIES.json (`distribution.programId`), a mainnet test launch on the vault path, then revocation of the distribution program's upgrade authority.

## 23 September 2026, ~05:20 UTC: authorities revoked at creation (localnet)

- Owner saw the test coin as "mintable" on a scanner: stale snapshot from the funding window (the chain shows both authorities gone). Fix: the freeze authority is revoked at creation from the next release; the mint authority too once build 3 is live (the launch accepts an already-revoked mint).
- Localnet, launch program build `3e6bf499…9067` (local): vault lifecycle with both authorities revoked before the campaign opened (launch 56zWViH2…, all claims paid), classic lifecycle unchanged. Build 3's CI hash changes with this source change; the identities record is updated after the next reproducible build.

## 23 September 2026, ~05:25 UTC: release 1eb7bc5 live (GitHub release branch) + site bundle index-oBi8LAVw.js

- API and signer both SUCCESS from release 1eb7bc5; ready, writes open, signer reachable, keepers running, reconciliation complete.
- Live checks: launched coin page swap panel 383 CSS px at 1280 and 375 (was 529/513), "Pool fee 2 % · Slippage 10 %", new picture at 512 px, no horizontal overflow. Live quote probe with a throwaway wallet: slippage 0 and 6000 bps refused ("between 0.01 % and 50 %"), 1000 and 250 bps accepted through to the balance check.
- Found live: the balance message said "on the test ledger" on mainnet; fixed in the clone (network-aware wording).

## 23 September 2026, ~06:05 UTC: release aae5b35 live (both services) + site bundle index-BNwHgEo4.js

- API and signer SUCCESS from release aae5b35 (keeper dust-harvest backoff, balance copy fix); ready, writes open, signer reachable, keepers running, reconciliation complete.
- Site live checks: Docs at #docs/start (10 topics, search), header shows Docs, launched coin page shows the claim strip ("Sign in to see what you can claim"), Trade/Claims rail, no horizontal overflow at 375. Banner icons render only with a destination (none configured on the test coin, so none shown).
- README with full transparency is on GitHub main/release (repository stays private, owner decision 23 September 2026).

## 23 September 2026, ~07:55 UTC: market data, activity feed and parent statistics live

- Release d83af66 (API 46b5ab2f, signer 62f3698e) + site bundle index-B5f8YgrN.js. Two site fixes were needed after the first deploy: the edge gate refused any query string (eb2588a) and the page read a different shape than the API served (7bc5d27).
- Live checks in a browser: price 0.000000001269 SOL, 24h change −75.02 %, volume 1.87 SOL / 47 trades (equal to the read-only chain run), candlestick chart rendered (7 canvases), 30 transactions listed, activity feed 118 events with real signatures (fee harvests, coin-side burns, distributions, buybacks). Status page: market and activity workers connected, lag 5 to 8 s, backfill complete to launch, 0 gaps, 0 decode failures.

## 23 September 2026, ~08:45 UTC: release ee19e4e live (API, signer, believers worker) + site bundle index-CMaM61vt.js

- API and signer SUCCESS on ee19e4e; ready, keepers running, market and activity feeds connected. Site: brand-style gate page (self-contained, no app bundle behind it), help popovers (11 on the launched coin page), parent reward cards, chart and activity verified in a browser at 1280 and 375.
- Believers worker: first build on 8a4b258 failed (Railway refuses a Docker VOLUME instruction); fixed in ee19e4e, build SUCCESS; runs on the */30 schedule; the API answers 404 "not published yet" until the first run publishes the list.
- Keeper economics live: buyback minimum budget 0.005 SOL, burn value gate 0.0005 SOL, harvest backoff.
