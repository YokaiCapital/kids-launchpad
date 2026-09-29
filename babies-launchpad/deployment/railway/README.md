# Dedicated private remote localnet container

Build context must be the audited standalone KIDS export, not the development workspace. Add only `deployment-artifacts/kids_atomic_launch.so`, SHA-256 `ef584ae7555415215b8cda0597cfff8362a7ecdbb31fdc07aa747c3f63368923`, from the reviewed public SBF build. Never copy runtime directories, ledgers, SQLite files, environment files, wallet keys or mint-worker inventory. This qualified SBF retains official compiler standard-library paths from the upstream platform-tools CI runner; these are upstream build metadata, not the operator’s home or project paths. The generic publication path detector flags this binary; manual artifact review must distinguish those compiler strings from personal data, without weakening the scanner.

Deployment status: the isolated cloud Linux stack completed its initial full launch, claims and fee qualification on Agave 3.0.13. Authenticated v3 campaign, postlaunch and operator reads have passed through the gateway. Remote test-wallet commitments, trades and claims passed. Restart preserved the chain identity and state. A bounded 100-request authenticated backend read test returned 100 successful responses with p95 latency 1,473 ms. These are private localnet results, not a guarantee of arbitrary traffic capacity or mainnet readiness. The gateway remains password/proxy protected, with an independent operator credential for local test-wallet signing.

The Dockerfile pins official Agave v3.0.13 Linux x86_64 and verifies the GitHub release asset SHA-256. It installs locked Node dependencies and verifies the custom SBF. Build using:

```
docker build --platform linux/amd64 -f babies-launchpad/deployment/railway/Dockerfile -t kids-private-localnet .
```

Provision a **new, isolated Railway project** containing only this dedicated service and a new persistent volume mounted at `/data`. Do not place it on the private network used by unrelated services. The verified service uses a 2-vCPU/6-GB ceiling and one replica; no serverless sleeping. The initial 4-GB ceiling left little headroom after approximately 3.68 GB anonymous memory was measured; the current ceiling is 6 GB. Continue monitoring memory and ledger growth. Two existing desktop test validators consumed approximately 947 MB and 804 MB RSS respectively; Linux startup and peak qualification can differ. Do not change or attach the existing mint-worker volume.

Required environment:

- `KIDS_REMOTE_LOCALNET=1`
- Three independent, random secrets of at least 32 characters: `KIDS_BACKEND_TOKEN`, `KIDS_OPERATOR_BACKEND_TOKEN`, `KIDS_GATEWAY_INTERNAL_TOKEN`.
- `KIDS_GATEWAY_HOST`: exact assigned gateway hostname.
- `PORT=8080` (or the assigned service port).

The supervisor starts fresh validators accessed internally through 19099 (v3) and 18999 (compatibility), generates new test-only keys on the volume, verifies public upstream program binary hashes, runs the full launch/claims/fees qualification once, initializes compatibility mints/config using JS SPL Token, then starts the standalone Node API on loopback 4175 under a kernel writer lock and the authenticated gateway on the service port. It refuses to expose a gateway if qualification or bootstrap fails. No mainnet transactions are signed: public mainnet RPC is used only to clone upstream public accounts on the first boot. An upstream binary change fails closed pending requalification.

Persistent program ID, genesis and binary identity must match on restart. No automatic ledger reset or silent re-seeding is performed. Interrupted initial qualification requires explicit operator recovery of the dedicated test environment. Existing successful qualification is retained rather than rerun on every restart. Legacy escrow/rewards programs are intentionally not deployed; their legacy endpoints must report unavailable, never impersonate v3 state.

Agave RPC binds wildcard interfaces even when its validator bind-address is 127.0.0.1. Internal application clients still use loopback, but this does not constitute RPC network isolation. The dedicated Railway project/private network is required; no unrelated service may be deployed into that network. The only publicly routed port is the authenticated gateway. Do not enable TCP proxies or public domains for RPC, faucet, gossip, the internal API or SQLite. Verify listener addresses in the running container and verify that requests without service authentication fail before connecting Vercel. Vercel must retain its access gate and use server-only credentials for this gateway. The site password is not the operator secret.

Before enabling the bridge: build and boot on Linux, verify upstream clone hashes, execute full chain qualification, test authenticated reads/claims/trading, verify unauthenticated rejection, restart without changing genesis or keys, exercise request bounds, and run the bounded concurrency test. Configure gateway health checks only after the bootstrap readiness marker exists. A failed bootstrap must keep the deployment unhealthy. Measure memory and ledger growth before considering higher limits; do not silently increase resource ceilings.

The container is a private localnet test stack, not a mainnet production backend. It does not make the contracts audited or production-ready.

Railway runtime testing found that Agave4.0.1 requires Linux io_uring, which this host does not implement. The isolated rehearsal container therefore pins official Agave3.0.13, whose directory helpers retain the standard filesystem fallback. This is a test runtime difference from the desktop4.0.1 rehearsal and must be qualified end to end; it is not a claim of mainnet runtime equivalence. Failed pre-qualification4.x ledgers are preserved separately; the3.x test ledgers use distinct directories. See the [upstream filesystem implementation](https://github.com/anza-xyz/agave/blob/v3.0.13/accounts-db/src/utils.rs).

Runtime entrypoint is `interaction-review/server/runtime.mjs`. `/healthz` reports process liveness; `/readyz` is the deployment probe and checks cached backend/ledger readiness. The API is not a Vite preview server. See [recovery operations](../RECOVERY.md).

Program upgrades: when the image carries a newer `kids_atomic_launch.so` (update the Dockerfile hash pin to the CI reproducible hash), the bootstrap upgrades the deployed program in place under the admin upgrade authority and appends the previous hash to the manifest lineage; existing campaigns, journals and intents stay valid (see `deployment/RECOVERY.md`). The ledger is never reset for an upgrade.

Operator signing (optional, recommended before mainnet): run `node localnet/signer-service.mjs` as a separate private service with `KIDS_SIGNER_KEY_FILE`, `KIDS_SIGNER_TOKEN`, `KIDS_SIGNER_PROGRAM_ID` and `KIDS_SIGNER_LISTEN`; give the API service `KIDS_SIGNER_URL`, `KIDS_SIGNER_TOKEN` and `KIDS_SIGNER_PUBKEY` and remove the admin key from its volume. See `deployment/ACTIVE-FEES.md`.

A second environment for the Jupiter buyback route: a fresh project whose genesis clones Jupiter v6 (the supervisor adds it for fresh ledgers only), with `KIDS_PROGRAM_SHA256` set to the CI reproducible hash of the newer program binary placed in `deployment-artifacts/`, `KIDS_PARENT_BUYBACK_ROUTE=jupiter-localnet` and `KIDS_PARENT_B_TOKEN_2022=1` so the first-boot qualification rehearses both paths. The original private environment keeps the reviewed classic binary.

Upload size: build the context from source only (exclude `interaction-review/public` media, `docs/kid-fun-v4` and `branding-kit`); the API never serves media and a 59 MB upload can exceed the upload time limit on a slow line.

Test campaign renewal: with `KIDS_ACTIVE_CAMPAIGN_RENEW=finished` the bootstrap archives a campaign that closed as failed with every commitment refunded (files moved to `/data/localnet/archive/<campaign>/`, never deleted) and opens a fresh 24-hour test campaign; a launched campaign is never replaced this way. A redeploy or restart is the trigger. Leave the variable unset anywhere real funds could exist.

Test campaign terms: `KIDS_ACTIVE_SOFT_CAP_SOL`, `KIDS_ACTIVE_HARD_CAP_SOL` (SOL, up to 9 decimals, hard cap at most 500) and `KIDS_ACTIVE_DEADLINE_SECONDS` (60 to 604800) apply to the next campaign the bootstrap creates; an existing campaign keeps its terms. `KIDS_ACTIVE_CAMPAIGN_RENEW=any:<token>` also replaces a launched, fully settled test campaign, once per token (a plain `any` is refused, so a later restart never archives a launched coin by itself); applied tokens are kept in `/data/localnet/renew-applied.json`. `KIDS_LOCALNET_FAUCET=0` disables the loopback-only test-SOL top-up for wallets.

Real-network operator signatures (23 September 2026): the API service never holds the operator key. It runs in signer mode (`KIDS_SIGNER_URL`, `KIDS_SIGNER_TOKEN`, `KIDS_SIGNER_PUBKEY`) and refuses to boot if `KIDS_OPERATOR_KEY_JSON` is still set; a key left on its volume is wiped at boot. The signer is its own service (`KIDS_ROLE=signer`, same image, own volume) with the key delivered once through `KIDS_SIGNER_KEY_JSON`, then removed; it signs only decoded keeper operations for the campaigns it serves (`KIDS_SIGNER_CAMPAIGNS`), within compute, priority-fee and hourly spending bounds (`KIDS_SIGNER_MAX_HOURLY_LAMPORTS`), resolving lookup tables through `KIDS_SIGNER_RPC_URL`. Provisioning on launch day needs `KIDS_SIGNER_ALLOW_PROVISIONING=1` on the signer for that boot only. Program upgrade authority lives on the governance key, not the keeper key.

