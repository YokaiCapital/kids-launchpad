# Private staging API gateway

This is a localnet-only staging adapter, not a mainnet deployment. It exposes neither validator RPC nor the Vite development server. Run Vite on **127.0.0.1:4175**, with validator clients accessing loopback, and publish only `gateway.mjs` on the container's `PORT`.

Agave validator RPC listeners can bind wildcard interfaces; the container must live in a dedicated project/private network with no unrelated services. Only the gateway port may have public routing. A loopback client URL alone does not isolate an RPC listener.

Required server environment (never use `VITE_` prefixes):

- `KIDS_BACKEND_TOKEN`: random 32+ character credential held by the authenticated Vercel proxy and gateway.
- `KIDS_OPERATOR_BACKEND_TOKEN`: independent random 32+ character operator credential; send only after separate operator authentication.
- `KIDS_GATEWAY_INTERNAL_TOKEN`: a third independent random 32+ character secret shared only by the gateway and local Vite backend. Do not put it in Vercel browser responses.
- `KIDS_GATEWAY_HOST`: exact Railway gateway hostname, with port only if needed. Unknown Host headers fail closed.
- `PORT`: gateway listener port. Upstream is fixed to 127.0.0.1:4175.

The authenticated proxy must set `Origin: https://kids.fun`, `Authorization: Bearer <server credential>`, and preserve only `kids_session`, `x-kids-csrf`, and JSON content type. Operator-authenticated calls additionally carry `x-kids-operator-token`. All admin routes, `/api/account/local`, and local-only claim/trade-execute/dev-claim routes require that second credential. Backend checks also require it for test-wallet commitments, refunds and quotes, even if the wallet session outlives the operator login. Send it with `/api/account/state` for an authenticated operator to see Alice/Bob test identities; ordinary shared-password viewers cannot impersonate the local dev.

The gateway has an exact method/path allowlist; query strings, encoded path aliases, unknown routes, demo writes, compression and conflicting request framing are rejected. Limits are 2 MB request body, 4 MB response, eight in-flight authenticated requests and at most 128 queued authenticated reads. Reads have a 6,000/minute shared limit; writes have separate viewer (240/minute) and operator (120/minute) budgets and are never queued. Queue wait is bounded to 12 seconds, followed by at most 25 seconds of active processing (37 seconds total). Private responses are never cached or shared. These are bounded application protections, not a DDoS guarantee. Keep the existing hosting edge protections.

Internal requests carry a nonce, timestamp, role and HMAC bound to method/path and the fixed public origin. Backend middleware accepts this context only from a loopback peer with the exact local Host and a valid 15-second signature; replayed nonces fail closed. Ordinary loopback requests retain the original guards. Admin middleware independently requires the operator role, and demo data is read-only remotely. Wallet challenges use `https://kids.fun`; wallet cookies are HttpOnly, Secure, SameSite=Strict and scoped to `/api/account`.

Run `node --test staging/gateway.test.mjs` from `interaction-review`. Fourteen gateway/authentication tests cover credential separation, path/size restrictions, stripped headers, public-origin wallet challenges, HMAC tampering and replay, bounded queues and rate windows. A 100-request mixed-read handler test verifies all responses succeed with at most eight upstream calls active and preserves each distinct wallet session; this is not a live Railway load test. No deployment is performed by these files.

`GET /healthz` is the sole unauthenticated endpoint: a fixed `{"status":"ready"}` response, no backend proxy or identifiers, capped at 120/minute. The supervisor starts this listener only after bootstrap succeeds. It indicates gateway startup, not ongoing validator health.
