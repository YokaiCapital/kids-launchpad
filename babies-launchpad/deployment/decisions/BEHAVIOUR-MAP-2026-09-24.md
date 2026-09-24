# Current behaviour versus the public-launch target (P0 behaviour map)

24 September 2026. What the deployed system does today (build 5, release e24c5eb) and what the public product changes.
Everything in the "today" column stays true for the live Shartcoin campaign; the new behaviour applies only to campaigns
created on the new program version.

| Area | Today (Family campaign 9FjwHicb…, build 5) | Public launches target | Where it changes |
|---|---|---|---|
| Campaign creation | Operator provisions one campaign at boot from `deployment/mainnet/campaign-plan.json`; the creator is the operator key | Creator wallet creates a sealed campaign through the wizard; unique nonce per creator; scheduled opening enforced on chain | new program version (P2), creator flow (P3/P4) |
| Modes | Family only: two parent mints are mandatory (lib.rs tag 0/9 guards, claims.rs configureParents) | Standard (no parents, no parent liabilities) and Family | P2 |
| Supply split | 43.5 % funders / 43.5 % pool / 5 % + 5 % parents / 3 % dev, encoded in Rust and JS separately | One versioned policy spec with Rust and JS test vectors; Standard 48.5/48.5/3 proposed | P2 |
| Terms | Soft, hard, deadline, launch deadline in the campaign account; pool tier chosen by code (`AMM_CONFIG`) | Sealed terms hash: caps, dates, split, vesting rule, exact AMM program/config and fee policy, routing policy and recipients, metadata hash | P2 |
| Funding window | Opens at on-chain creation (API creates at `plan.opensAt`); hard cap does not close funding | Opens-at enforced by the program; same oversubscription rule | P2 |
| Settlement | Keeper settles every receipt (tag 4) then refunds (tag 3) after the deadline; launch (tag 6) when settled == count and accepted >= soft | Same integer semantics preserved; permissionless refund path after the sealed failure deadline; receipts enumerated and reconciled against on-chain counts before launch | P2/P3 |
| Launch | Keeper creates the Raydium CPMM pool, locks LP, mint authority revoked; 24 h launch window | Same atomic path; partial success impossible; live only after verification of pool, reserves, lock, fee rights, revoked authorities | P2/P3 |
| Custody | Launch authority PDA holds funders', parents' and dev shares together; per-receipt claim flags | Separate purpose vaults with their own authorities and permitted recipients (kids-distribution program, built, not deployed) | P2 |
| Claims | Funders tag 7, parents tag 10 with Merkle proofs, dev tag 8; no expiry | Same entitlements; free-parent expiry only if sealed for the new version | P2 |
| Fee keeper | Operator == campaign creator; harvest, burn coin side, distribute 98/20/25/25, parent buybacks through Jupiter (build 5) | Narrow keeper capability separate from the creator; Standard routing 148/20 proposed; batch buybacks by threshold; slippage and route allowlist independent of user preference | P2/P3 |
| Signer | One signer service, policy by tag, served campaigns from the plan file, replay registry per operation id | Same signer, per-campaign capability list from the registry; no recipient/supply/claim/root power | P3 |
| Backend state | JSON journals on the API volume for one active campaign; sqlite for market data; renewal archives the active campaign | Postgres registry: campaigns, profiles, drafts, intents, commitments/claims, mint leases, budgets, jobs, chain events, market cursors; chain authoritative | P1 |
| Campaign selection | `readActive()` / `resolvePostlaunchCampaign('active')` everywhere; one campaign per process | Campaign id in every route and job; legacy read adapters for the active, archived and historical campaigns | P1 |
| Workers | Keepers started by the API process (account-plugin) with in-memory busy flags | Durable jobs with leases and fencing tokens; fair queue across campaigns; reconciliation before any retry | P3 |
| Vanity mints | One key ground by hand and pinned in the plan (`KIDS_ACTIVE_MINT_SECRET`) | Encrypted inventory with atomic leases per campaign, signer-side validation of the creation message, consumed mints never recycled | P3 |
| Site | One coin: launch page, coin page, docs, believers, blocked; password gate | Explore directory, creator wizard, `/coin/:campaignId`, Portfolio, My launches, Guide; same gate until rollout | P4 |
| Market data | One feed per process keyed to the active campaign | Cursors and candles keyed by genesis + pool + interval + denomination; shared upstream subscriptions | P5 |
| Moderation | Site-side blocklist journal (458 wallets); refusal of commits and trades through the site | Same, plus on-chain commit restriction in the new version if activated; never blocks refunds or paid claims | P2 |
| Upgrade authority | Governance key on the owner's machine | Documented upgrade model, hardware wallet or multisig before third-party deposits | owner |

## Legacy adapters required by P1

| Campaign | Program build | Read path today | Adapter |
|---|---|---|---|
| 9FjwHicb… Shartcoin (live) | 5 (created on 2) | active manifest on the volume, `readActive`, `postlaunch` record, fee journal | `legacy-v3` reader over the volume files and chain; claims and trades keep working through the existing routes until the multi-campaign routes replace them |
| 8VGyvxec… test (launched 23 Sep 17:33) | 2 | archived on the volume (`archive/8VGy…`) | `legacy-v3` reader over the archive folder; claims still possible on chain |
| 8LmwBAa5… first test (launched 23 Sep 02:08) | 1/2 | archived | same |
| 4y13ccgN…, 9zT7cyDv… | 1 | archived, never launched | listed as ended with refund state from chain |

Nothing in the table above is migrated or rewritten; the registry imports identities and points to the existing files.
