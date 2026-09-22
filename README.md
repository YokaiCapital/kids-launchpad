# KIDS launchpad

KIDS combines two parent communities into a new coin. Shartcoin (`$Shartcoin`) is the first concept: Fartcoin × Buttcoin.

**Status: local development and localnet testing. Mainnet deposits are not enabled.** Configured Commit SOL transactions transfer test SOL to program-controlled localnet escrow. Proportional excess refunds and full failure/timeout refunds are enforced on-chain. A separate v3 localnet rehearsal now executes escrow settlement, pool creation and full LP locking atomically. Participant/parent claims, launch-triggered dev vesting, and fee routing are implemented in that separate development program; the final combined localnet run passed. The local UI now uses a persistent v3 campaign on port 19099; legacy v1 refunds remain available separately. The development v3 program remains upgradeable. Production qualification remains unfinished.

## Programs and deployment evidence

- [Public program and mint registry](docs/deployments.json)
- [Verification commands, authorities and release requirements](docs/VERIFICATION.md)
- [Atomic launch qualification and remaining gates](docs/LAUNCH-QUALIFICATION.md)
- Localnet dev vesting program: `HV3Bo9fEdmToXMhFCoXAaDee8nk4NVspyuCzgN5vQPWZ`
- Mainnet escrow, Shartcoin mint, pool and liquidity lock: **not deployed**.

The addresses describe isolated test ledgers; each deployment records its RPC and genesis hash. A fresh setup generates its own IDs. Local FARTCOIN and BUTTCOIN mints are fixtures, not the real parent tokens.

## What works

| Component | Current status |
| --- | --- |
| Coin page, featured video and parent identity | Implemented; public voting/submission entry points replaced by launch countdown |
| Signed wallet sessions, proposal ownership and moderation | Local service implemented |
| Holder snapshots, signed voting and frozen ballots | Localnet implemented |
| Admin settings, content, rounds and audit records | Loopback-only local operator panel |
| Dev allocation and vesting claims | Funded and tested on localnet |
| Active v3 SOL escrow and on-chain refunds | Persistent campaign on localnet :19099; legacy v1 refund access retained |
| Atomic escrow → AMM pool → permanent LP lock | Tested on separate localnet; available through admin rehearsal |
| Fee distribution and parent buyback/burn | Implemented in v3 localnet; combined localnet verification passed |
| Participant/parent claims and launch-triggered dev vesting | Implemented in v3 localnet; combined localnet verification passed |
| External wallet claim signing and production authorization | Pending |

## Approved launch economics

| Allocation | Total supply |
| --- | --- |
| Prelaunch participants | 43.5% |
| Liquidity | 43.5% |
| Parent holders | 10%, split 5% per parent |
| Dev | 3%: 1% at launch, 2% linear over three calendar months, no cliff |

The **$40K soft cap and $200K hard cap are total opening pool values**, consisting of $20K–$100K accepted SOL plus equal opening value in Shartcoin. They are not market-cap targets. SOL denomination depends on the published price source and lock time; these production rules remain to be finalized. The prototype uses a fixed example rate. Below the SOL soft cap, the local escrow enforces full refunds.

Above the hard cap, accepted SOL is proportional to commitments and excess is refunded. Selected design: Raydium CPMM Shartcoin/SOL with a 2% trading fee, permanent liquidity locking that retains fee rights, no token transfer tax, and mint/freeze authority revocation at launch. The nominal 2% trading fee breaks down as 0.98% KIDS treasury, 0.20% dev, 0.25% parent A buyback/burn, 0.25% parent B buyback/burn and 0.32% Raydium protocol/fund. The v3 router converts collected child-token fees to WSOL, then splits actual realized WSOL using cumulative 98:20:25:25/168 weights. Parent budgets execute canonical-pool purchases and SPL burns atomically; combined localnet verification passed. The 2% is the total swap fee, not a promise of 2% paid to the dev. Parent eligibility requires at least 0.05% of a parent's supply at its snapshot.

## Repository layout

- `interaction-review/`: active React/Vite UI and local APIs.
- `protocol/`: signed proposal and voting protocol with persistence.
- `localnet/`: isolated validator setup, launch policy and vesting tools.
- `shared/`: minimal reused chain and HTTP helpers.
- `kids-mint-worker/`: standalone suffix generator and encrypted inventory.
- `branding-kit/`: designer assets and tokens.
- `docs/`: deployment registry and verification documentation.

## Install and run

Commands below assume this folder is `babies-launchpad/` at repository root. Use Node.js 22.18+ with `node:sqlite` and TypeScript stripping support; Node 24+ recommended. Local chain tests additionally require Solana/Agave CLI, `solana-test-validator`, `cargo-build-sbf`, Rust and `spl-token`. Set `SOLANA_BIN` to the directory containing the Solana executables if not installed in the default location. No production credentials are needed.

```sh
npm ci --ignore-scripts --prefix babies-launchpad/interaction-review
npm ci --ignore-scripts --prefix babies-launchpad/localnet
node babies-launchpad/localnet/start.mjs
```

Keep the validator running. In another terminal:

```sh
node babies-launchpad/localnet/setup.mjs
npm --prefix babies-launchpad/interaction-review run dev -- --host 127.0.0.1 --port 4175
```

Open `http://localhost:4175/`. Coin: `/#shart`; post-launch preview: `/#shart-live`; launch countdown: `/#launch`; admin: `/#admin`. Legacy escrow/vesting RPC is `http://127.0.0.1:18999` (WebSocket 19000); active v3 uses `http://127.0.0.1:19099` (WebSocket 19100). Provision the v3 campaign after the canonical-program setup and atomic qualification, following [active campaign operations](localnet/ACTIVE-LAUNCH.md). Local admin access relies on loopback/Host/Origin/CSRF checks and must not be exposed publicly. Keys, ledger and databases are generated under ignored `.runtime/` directories. Start/setup preserve the ledger; do not reset it to fix an error.

## Build and test

```sh
npm --prefix babies-launchpad/interaction-review run build
node --test babies-launchpad/interaction-review/tests/*.test.mjs
node --test babies-launchpad/protocol/test/*.test.mjs
node --test babies-launchpad/localnet/test/*.test.mjs
python3 babies-launchpad/scripts/check-publication.py .
```

Protocol HTTP tests bind a temporary loopback server. For real localnet vesting transactions, after setup:

```sh
node babies-launchpad/localnet/deploy-rewards.mjs
node babies-launchpad/localnet/dev-vesting.mjs
node babies-launchpad/localnet/verify-vesting.mjs
```

These commands deploy an immutable test program, fund schedules and submit claims using local test identities. They change the local ledger. Funding is designed to be idempotent; keep runtime records. The pinned upstream program source is fetched by the deployment script with its license. See [localnet details](localnet/README.md).

The worker has its own [setup and storage migration notes](kids-mint-worker/README.md). Do not attach an existing inventory to a differently named encryption namespace without a verified migration.

## Security, publication and licensing

Do not publish private keys, runtime state, environment secrets or recovery notes. The publication check scans filenames, contents and ZIP members for excluded identifiers and common credential patterns; it is not proof of zero secrets. Review assets and git history before making a repository public. Dependency advisories remain to be resolved or qualified before production use. Do not send funds based on preview screenshots.

KIDS-owned code is **source available under PolyForm Noncommercial 1.0.0**, with mandatory preservation of the KIDS attribution notices. Commercial use outside that license requires separate permission; giving credit alone does not permit it. This is not an OSI open-source license. See [licensing scope](docs/LICENSING.md), [license](LICENSE.md) and [notices](NOTICE). Third-party code retains its original licenses; the upstream MIT-licensed rewards program cannot be made noncommercial by these terms. Media and branding are excluded from the software license. The repository remains private pending public-release review.

Pool creation, swap and atomic Burn & Earn qualification: [launch integration status](docs/LAUNCH-QUALIFICATION.md). The active v3 operator path uses the same atomic builder, but its 24-hour campaign has not yet reached after-close launch.

Display identity is **Shartcoin**, ticker **$Shartcoin**. The internal `SHART` configuration key and existing routes remain for compatibility; this is not a mint-address change.

Run `node localnet/atomic-failure-verify.mjs` from `babies-launchpad` after the atomic launch fixture to verify failure and refund recovery. Five on-chain checks passed against the current `e0b4051752422366e51ae6a5fe8eaeeeab773faa1448cec33a0990961c76e71d` binary.

Active localnet campaign operations and tested intent recovery: [active v3 service](localnet/ACTIVE-LAUNCH.md). The coin page commits to this long-lived campaign; post-launch preview trading/claims still target the separate qualified test pool.

## Hosted private test environment

See [private test status](babies-launchpad/deployment/PRIVATE-TEST-STATUS.md) for verified hosted localnet flows, capacity checks and remaining launch limitations.
