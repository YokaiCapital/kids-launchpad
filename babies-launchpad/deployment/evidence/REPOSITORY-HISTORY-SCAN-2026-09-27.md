# Repository history scan

Date: 27 September 2026. Local branch history through `e638536`.

Gitleaks scanned 219 commits / approximately 9.50 MB with redacted output. Its
13 generic-key matches were reviewed, rather than silently allowlisted:

| Matches | Location | Classification |
| --- | --- | --- |
| 1 | `localnet/market/public-ingest.mjs` | Code expression involving an operation key and cursor read, not a credential. |
| 1 | `localnet/jobs/handlers.test.mjs` | Deterministic fixture operation identifier passed to a test queue, not authentication material. |
| 2 | `deployment/inventory/PRODUCTION-INVENTORY-2026-09-24.json` | Public pool configuration account addresses in `poolConfigs.tiers`, not signing keys. |
| 8 | `localnet/test/fixtures/market/` | Parsed transaction `accountKey` fields containing public account addresses. |
| 1 | `localnet/test/mainnet-parent-snapshot.test.mjs` | Explicit uppercase fixture/key/number literal for an injected fake Helius transport; not a provider credential. |

No usable secret was identified among those findings. Reports remained local and
redacted; no candidate credential was copied into this evidence. The scan does not
prove the absence of all secrets, inspect every remote branch or establish safety
of historical external uploads, caches or deployment environments. Staged changes
must continue to pass the separate redacted scan before each release commit.
