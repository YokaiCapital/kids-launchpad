# Public-launch private pilot checkpoint

The owner requested stage 1 (public-launch foundation) visible and usable only by their wallet. This checkpoint gates the existing public-launch branch; it does not complete creator provisioning or enable mainnet transactions.

## Boundary

- Set KIDS_PUBLIC_PILOT_WALLET on the API server to the owner's canonical public wallet address. Missing/empty denies everyone; invalid configuration rejects startup when the registry is configured.
- A signed AccountStore session is required. UI capability comes from account/state and successful verification, not a browser allowlist. Logout removes the capability.
- Private directory reads use /api/account/launches/campaigns so the existing HttpOnly session cookie path remains unchanged. Origin checks run before authentication. The middleware attaches verified identity through a server-only Symbol, not a forwarded owner header.
- Old /api/campaigns routes cannot bypass authentication. Drafts, positions, prepare, submit, status and cancel enforce the pilot wallet before opening the registry or calling workers. Writes retain CSRF and existing startup checks.
- Existing Shartcoin pages, old claims/refunds and trading endpoints are not gated by this feature.
- A frontend feature flag only includes UI code; it is never authorization. Public source and chain data are not confidential. This gate cannot prevent direct calls to a permissionless on-chain program. A wallet-exclusive mainnet financial pilot needs an enforced program policy or separately qualified restricted campaign; it must not rely solely on the website API.

## Local configuration

The owner's address is stored in the ignored localnet/.runtime/pilot.env, not copied into published browser code or this report. That file is a local configuration fragment, not evidence of a deployment. Supply KIDS_REGISTRY_URL to the intended private runtime database as well. Frontend: VITE_KIDS_PUBLIC_LAUNCHES=1 and VITE_KIDS_PUBLIC_LAUNCHES_FIXTURES=0. New transaction service remains localnet-only under its existing explicit flags and verified program/genesis configuration.

## Still required

The wizard currently saves/resumes drafts but onCreate is unset. Upload persistence, verified creation costs, mint inventory leasing/provisioning, campaign creation and lifecycle recovery must be integrated before calling this a working launch pilot. Full-registry search/paging and wallet positions, Postgres/shared workers, real extension qualification and load/security evidence remain in the integrated plan. No existing program may be upgraded to introduce the experimental new mechanisms.

Design proposal: deployment/design/PUBLIC-LAUNCH-DISCOVERY-2026-09-25.md.

## Validation at this checkpoint

- 203 Node regression tests passed, including real Ed25519 session verification against a temporary HTTP API, default-deny configuration, incorrect wallet/body spoofing, CSRF, directory authorization and logout revocation.
- Production frontend build passed with public UI included and fixture fallback disabled.
- Chrome/Playwright UI checks passed at 390, 768 and 1440 px: anonymous/wrong-wallet navigation hidden, approved-session wizard/directory visible, search interaction, logout removes access, no horizontal overflow or page errors. UI data and capabilities were mocked; this is not evidence of a real-wallet transaction or chain launch. Browser plugin/skill was unavailable, so the installed Playwright runtime was used.
- Publication scan: 653 export files checked, zero pattern findings. Pattern scanning is not a complete security audit.
- Changes are local on feature/public-launches. No production deployment or mainnet activation is implied.
