# Local protocol and preview persistence

Public launches remain closed. Nothing here sends transactions or creates a coin.

`npm start` runs the signed protocol service on loopback port 4181. `npm test` checks signed challenges, durable receipts, immutable ballots, replacement votes and launch gating. This service is not yet connected to a real browser wallet or chain snapshot.

The frontend Vite plugin separately exposes `/api/demo` on localhost:4175. It stores one shared simulated account in `.runtime/preview.sqlite`. Submissions, review decisions and vote replacements persist across reloads and restarts. Requests have idempotency keys and an expected state revision; stale tabs must refresh before overwriting records. Actual parent mints are rechecked by the server on submission. Sample parents remain synthetic.

The demo endpoint is local development/preview only, requires a local Host and same-origin JSON writes, and is not included in the Sites worker. It does not authenticate users or prove token ownership. Existing browser-only history remains in the old localStorage keys; it is not automatically promoted into the server ledger. Drafts remain browser-local.

Run frontend persistence tests with `node --test ../interaction-review/tests/*.test.mjs`. Do not deploy the demo endpoint as a multi-user service. Wallet integration, production storage, moderation authorization, chain snapshots and qualified launch execution remain separate work.
