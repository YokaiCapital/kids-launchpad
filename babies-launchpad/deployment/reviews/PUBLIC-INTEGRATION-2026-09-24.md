# Public-launch integration handoff — 24 September 2026

Branch: `feature/public-launches`, based on `5127e60`. This is a tested integration slice, **not public-launch activation or a production-readiness certificate**. Existing Shartcoin transactions, funds, supply, claims and production configuration were not changed.

## Implemented

- A versioned registry/chain → UI contract, preserving the existing flat API fields. The campaign directory now supplies normalized views and the proposed preset manifest. Live reads are deduplicated, cached for ten seconds, limited to four concurrent reads, and bounded to 200 cached entries.
- A v2 reader validates the ledger genesis, program account owner, campaign PDA and sealed terms hash. The current AMM config supplies the displayed fee; an unavailable fee/creator-fee read stays unknown. The chain clock drives campaign phases. Unread commitments are not converted to zero.
- Authenticated wallet-owned drafts, revision-conflict protection and bounded fields/media URLs. The wizard saves and resumes drafts. Temporary browser media URLs are refused, never persisted as if uploaded. New Family creation is disabled to match the program's actual capabilities.
- An explicitly localnet-only public wallet service: commit, refund, participant claim and dev vesting claim. It uses existing v2 instruction builders and exact integer policy helpers. Commitments remain open after the hard cap until their deadline. Receipt sequences come from chain.
- SQL migration 3 persists approved packets, ownership, idempotency descriptors, signed bytes and status. Signed bytes are recorded before broadcasting. RPC ambiguity remains pending; restarts check the same signature. Finalized blockheight plus transaction-history checks determine expiry. Confirmed results cannot be downgraded. Only unsigned packets can be cancelled. Outstanding packets are listed independently of later completed transactions and bounded per wallet.
- Independent browser checks of the program, campaign, wallet, commitment amount, genesis, recipients and ATA instructions before signing. The existing bounded wallet priority-fee validator is reused on both sides. Account switches, altered instructions and invalid signatures are rejected.
- Wallet balance, per-campaign receipts, integer allocations/refunds, dev vesting and live token balances are read from chain. Unavailable eligibility stays unknown. UI transaction status and reload recovery are connected, and repeated submission is disabled while pending.
- Explicit gate/gateway route allowlists, account session/CSRF checks and financial-startup gating for new prepare/submit routes. Status recovery remains accessible while financial writes are gated. Mainnet is deliberately refused by this experimental wallet service.
- Missing creation quotes display unavailable rather than zero. Creation remains disabled until the full provisioning path exists. Mobile review addresses no longer squeeze field labels into individual syllables.

## Local configuration

Existing registry import remains opt-in through `KIDS_REGISTRY_URL`. To exercise the new wallet routes on an isolated localnet, set:

```
KIDS_NETWORK=localnet
KIDS_REGISTRY_URL=/absolute/private/runtime/public-registry.sqlite
KIDS_PUBLIC_WALLET_ACTIONS=1
KIDS_PUBLIC_PROGRAM_ID=<deployed-v2-program-address>
KIDS_PUBLIC_GENESIS_HASH=<that-validator-genesis>
KIDS_PUBLIC_RPC_URL=http://127.0.0.1:19199
VITE_KIDS_PUBLIC_LAUNCHES=1
VITE_KIDS_PUBLIC_LAUNCHES_FIXTURES=0
```

These are configuration names and placeholders, not credentials. Never commit runtime databases, signer material, environment files or personal absolute paths. Both Vite and the standalone API share the account/manifest service factory. The standalone runtime still requires its existing startup reconciliation and health checks; do not bypass those for a production release. A real external wallet must target the same localnet ledger; no server-held participant key or local signing bypass was added.

## Validation completed

- 200 Node tests pass: frontend/server regressions, gateway routes, registry migration/startup and the new wallet service tests.
- New service tests cover exact commitment sequences and amounts, oversubscription, identity mismatches, tampering, excessive priority fees, chain entitlements, ownership isolation, optimistic draft revisions, RPC ambiguity, restart recovery, cancellation and expiry.
- Public-launch frontend build passes.
- Browser checks use installed Chrome through Playwright (the Browser skill/plugin was unavailable), with a local harness and explicitly mocked API data. Save → leave → resume works. Disabled Family/creation states and unknown claim eligibility are visible. Checked 1440, 768 and 390 px widths; no horizontal overflow or page errors. This does **not** substitute for real-wallet transaction testing.
- The pre-existing v2 validator at port 19199 was unavailable during this pass. New route transactions have **not** been rehearsed on an actual validator in this pass. Do not report mocked RPC tests as on-chain evidence.

## Required before calling public launches complete

1. **Creation provisioning:** connect authenticated creator drafts to the existing encrypted `kids` mint inventory/lease signer, durable provisioning steps, real rent/fee cost quotes, creator funding, metadata uploads and chain registration. No arbitrary mint key or one-off generator workaround. Keep Create disabled until mint custody, setup budget, metadata and recovery are proven. Uploaded media needs authenticated durable storage with size/type validation; the current file picker is only an unsaved preview.
2. **Family:** complete separate distribution custody, snapshot/claim policy and the v2 program paths currently refusing Family creation. Existing Family claims must remain on their original adapters. Never turn on Family based only on UI availability.
3. **Full portfolio/creator queries:** the new positions endpoint reads at most 24 requested campaign IDs. The current UI requests the loaded directory's first 24. A complete portfolio needs wallet-indexed campaign discovery and paginated owner/creator queries across the entire registry, not just the current directory page. Directory cursor pagination still needs a server-backed UI flow. Direct links to an off-page campaign now resolve through its item API.
4. **Market/trade/activity and creator dashboard:** connect campaign-scoped live markets, swaps, receipts/activity, fee breakdowns, updates and profile management. The current public live-page scaffold is not a complete trading terminal.
5. **Infrastructure:** Postgres is still a deliberately refusing adapter. Complete multi-instance storage, rate limits/quotas, indexing, SSE/cache strategy, load tests and lifecycle worker/signer orchestration before traffic activation. The small SQL draft/packet APIs here do not make the existing SQLite-only registry a horizontally scalable production system.
6. **Rehearsal/release:** real validator → wallet → API → keeper → lock/authority checks → allocation/refund/dev claim; failure recovery, concurrent requests, signer restarts, expiry and browser reloads. Reconcile old/new migration data and retain program upgrade/custody disclosures. Activate only the reviewed preset hash. Existing funded terms remain immutable to this rollout.

Do not merge this branch into `release`, deploy it, or enable public money flows solely because the UI builds or these tests pass.
