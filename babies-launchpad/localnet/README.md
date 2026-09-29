# KIDS localnet

This is an isolated local validator, not devnet or mainnet. The running frontend is `http://localhost:4175`; the local operator panel is `/#admin`.

## Running

Requires the existing Solana CLI installation and Node 25 used by this workspace.

1. `node babies-launchpad/localnet/start.mjs` — keeps the existing ledger; never resets it.
2. `node babies-launchpad/localnet/setup.mjs` — idempotent wallet/mint setup.
3. Run the existing interaction-review Vite app on port 4175.

RPC: `http://127.0.0.1:18999`; WebSocket: port 19000. The installation uses its own ledger, not the user's Solana CLI configuration. Wallet keys are mode 0600 under ignored `.runtime/`. Do not upload this directory. SOL and tokens on this ledger have no market value.

## Implemented and verified

- Four standard SPL mints: KIDS, FARTCOIN, BUTTCOIN, SHART, each with 1 billion tokens and six decimals.
- An admin key and two test identities, Alice and Bob. Each test identity has local SOL and 1 million KIDS/FARTCOIN/BUTTCOIN.
- Wallet signature sign-in with expiring, single-use, origin-bound challenges; HttpOnly, SameSite=Strict sessions; logout.
- Local test identity signing stays on the server; no private keys enter the browser.
- Wallet-owned proposal history, idempotent submission, revision checks, admin moderation and immutable approved versions.
- Operator panel: verified local mint replacement, admin address, SOL reference price, profile/banner/logo/video/social links, dev posts, review queue, voting rounds, chain checks, audit log.
- Finalized local KIDS holder snapshots, immutable ballots, signed replacement votes, quorum and closing results. Admin treasury is excluded from electorate. The protocol core is reused.
- Minimal reused HTTP guards, key generation and signature helpers are bundled in `shared/`; no separate project checkout is required.

`node babies-launchpad/localnet/verify.mjs` adds two clearly named local test proposals, approves them, opens a one-minute round and signs two votes. Use **Admin → Rounds → Finalize result** after close. This is an intentional integration test that persists its fixtures; it is not a production migration.

## Not production-ready

Configured SHART funding reads the localnet escrow and submits signed test-SOL transactions. The old concept ballot remains separate from the localnet voting ledger. No mainnet funding is enabled.

Still required: AMM escrow settlement, token allocation claims, AMM pool creation and LP custody/locking, funded parent distributor, production wallet authorization for admin/dev actions, production deployment/storage, and full recovery/security qualification. The existing Railway `kids-mint-worker` remains separate; reservation and launch consumption are not wired in.

Approved policy is 43.5% prelaunch / 43.5% liquidity / 10% parents / 3% dev (1% of total supply unlocked at launch, 2% linear over three calendar months, no cliff; localnet dev vesting implemented and funded; production launch integration pending), Raydium CPMM SHART/SOL at 2% trading fees, permanent liquidity locking with fee collection retained, and mint/freeze authority revocation. `launch-policy.mjs` stores this policy; the mainnet tier reference is not a deployed localnet account. Dev/platform revenue shares remain unassigned. Pool execution must verify actual fee configuration before deposits. Settings cannot enable deposits while the program is absent. Operator access is deliberately local-machine access, matching the existing KIDS local admin model; changing `config.admin` does not change that network boundary.

The Sites worker is unchanged and does not host these local APIs. Backend data and secrets must never be included in a static Sites upload.


## Dev vesting (implemented on localnet)

`npm ci --ignore-scripts --prefix babies-launchpad/localnet` installs the isolated client dependencies. `node babies-launchpad/localnet/deploy-rewards.mjs` builds and deploys the pinned Solana Foundation rewards program used by KIDS. Only its declared program ID changes for this local deployment; no contract logic is rewritten. Deployment removes the upgrade authority. Builds require the Solana SBF toolchain and access to the upstream GitHub repository.

`node babies-launchpad/localnet/dev-vesting.mjs` creates and funds the schedules once; retries use the persisted plan and existing on-chain accounts. Alice is the test dev. One billion local SHART supply gives 10 million available at the test launch timestamp and 20 million streaming until three calendar months later (UTC, month-end clamped). The launch portion uses a timestamp gate, so funding before launch cannot unlock it early. Both distributions have revocation disabled and the clawback timestamp set to maximum i64. Their wallet, amounts and schedules are bound by the existing KIDS Merkle leaf format. Keep `.runtime/dev-vesting.json`: it contains the public claim schedules and funding receipts, not secrets.

`node babies-launchpad/localnet/verify-vesting.mjs` sends real transactions against localnet: early launch rejection, wrong claimant, changed schedule, overclaim, partial claim, admin clawback rejection, final unlock and duplicate claim rejection. Separate small fixtures use shifted timestamps to test boundaries without changing the real three-month allocation. It also claims the currently vested balance of Alice's real test allocation. Results are in `.runtime/vesting-verification.json`.

The SHART page has a collapsed **Dev allocation** card with on-chain balances and claims. Sign in as local Alice to claim; Bob and anonymous users cannot. The local API enforces sessions, CSRF, loopback and genesis identity. The client additionally checks program immutability, root, amount, mint, authority, seed, funding and revocation state. Local key files never reach the browser.

Limitations: external wallet transaction signing and production launch-trigger integration remain pending. This test starts at provisioning, not at a live pool opening; it does not announce a SHART launch. Escrow, AMM creation, LP locking and parent claims remain separate unfinished work. The standalone distribution model has no short-term admin clawback; recovery of unclaimed funds is deliberately unavailable. Existing standard-SPL test mint authority is unchanged by this test. Dependencies are installed with scripts disabled; npm audit reports upstream legacy Solana-client dependency advisories (including bigint-buffer, whose native binding is not loaded here). These need qualification before any public backend deployment; do not use audit's suggested incompatible ancient SDK downgrades.
