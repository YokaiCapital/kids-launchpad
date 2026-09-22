# Private Vercel frontend

This deployment packages **only** the already-built `dist/client` and the access middleware. It never ships the loopback Vite API, local validator, signing keys, SQLite database or test ledgers. It does not enable online deposits, claims or admin transactions.

1. Run the frontend build.
2. Run `node deployment/prepare.mjs /absolute/isolated/deployment-directory`.
3. Configure encrypted production and preview environment variables `KIDS_ACCESS_PASSWORD` (random, minimum 20 characters) and `KIDS_ACCESS_SECRET` (independent random secret, minimum 32 characters).
4. Deploy the isolated directory using Vercel's prebuilt Build Output API. Never deploy the monorepo root or local runtime.
5. Verify login gating on root, JS, images and video before attaching the domain. Verify `/api/*` remains HTTP 503 after authentication.

The password form creates an eight-hour HMAC-signed, Secure, HttpOnly, SameSite=Strict host-only cookie. Login requests require same-origin POST and a bounded body. Missing configuration fails closed. Rotating the session secret revokes existing sessions. This shared password is access control for a closed review site, not a replacement for individual admin identity or wallet authentication.

Vercel platform DDoS protection is separate from application rate limiting. Configure and verify a WAF rule limiting POST `/__access` attempts per source IP. Do not claim this rule is installed based on this file alone. No Cloudflare zone, proxy, or nameserver migration is implied.

`node --test deployment/gate.test.mjs` verifies missing-secret failure, asset protection, origin checks, session expiry, forgery rejection, bounded bodies, and 100 concurrent middleware requests. That last test is a local concurrency check, not a remote infrastructure load-test guarantee.

A production transaction service still needs durable storage, isolated RPC/indexing, wallet-signed authorization, permissioned operations, monitoring, backup/recovery and reviewed deployed contracts. Do not expose or tunnel the existing local test API to fill that gap.

## Verified deployment — 20 September 2026

The closed frontend is deployed at https://kids.fun on Vercel. The current production deployment is `dpl_FNquYBbRKWL6cbTGH56vxNHwjQZq` (22 September 2026: admin view, link and route removed from the uploaded frontend; gate refuses /api/admin); its alternate alias is https://kids-fun-flax.vercel.app. Earlier verified deployments were `dpl_8yXYmFAHaQyYgqR3oQSFtFAZXHSn`, `dpl_EjaaiQ3knuBTEnj6jsTqEYL3Dgb6`, `dpl_2bhMqkfQc2MzN6RLL8Y9YaTdLzYP`, `dpl_3GeW24Y3RyKypz8AoB99z2NJLHBi` and `dpl_A5toC8J1HNsfW5mLB5Jqoso1ZR9F`. Both are subject to the access middleware. The domain is verified and uses Vercel DNS/CDN. No Cloudflare account, zone, proxy or nameserver changes have been configured.

Remote verification confirmed anonymous HTML/assets/API gating, successful password login, authenticated frontend and image access, HTTP 503 for APIs, and anonymous gating again after authenticated cache population. An authenticated HTML-only burst completed 100/100 requests successfully in 3,171 ms, with p95 2,863 ms. This is one bounded test, not sustained capacity or transaction-backend certification.

The active Vercel WAF rule limits POST `/__access` to ten requests per minute per source IP. Vercel platform DDoS protection remains enabled. IP limits can affect users sharing a NAT, and neither this rule nor platform protection guarantees immunity from every attack.

## Operator maintenance

Access secrets are encrypted Vercel project environment variables. The initial local handoff file is `/tmp/kids-vercel-access.json`, mode 0600; it is **not** part of the repository or deployment. Move this temporary file into the operator's password manager or private configuration storage, then remove the temporary copy. Never paste its contents into tickets, logs, source or documentation. The session-signing secret is internal and must not be shared with site visitors; share only the site password through a private channel.

To rotate access, generate a new random site password and independent signing secret, update both production and preview environment variables, then redeploy. Rotating only the password does not revoke existing sessions; rotate the signing secret as well. Re-run anonymous, authenticated, asset and API checks on both the custom domain and Vercel aliases. Keep WAF changes scoped to the project and verify the active configuration after applying them.

Before rollback, verify the target deployment contains the access middleware and fails closed when its secrets are absent. Do not roll back to an unprotected build. Temporarily remove the custom domain or pause the deployment if a safe protected rollback is unavailable; do not bypass protection to recover availability. Check alternate deployment aliases as well as the custom domain.

Keep deployment IDs and smoke-test results in an operator record. Monitor Vercel errors, WAF blocks and traffic; review unusual increases before raising rate limits. API deployment remains prohibited until a separate production backend is reviewed and provisioned.

If Cloudflare is introduced later, first confirm domain ownership, choose a supported DNS/proxy configuration and test TLS, origin protection, cookie handling, POST login and direct Vercel aliases. A Cloudflare-only access rule cannot protect a publicly reachable Vercel origin by itself. Preserve the application password gate and do not migrate nameservers merely to claim Cloudflare support.

## Private staging bridge

The optional server-side bridge accepts only the fixed account/admin route list and an HTTPS `*.up.railway.app` origin. Configure `KIDS_BACKEND_ORIGIN`, `KIDS_BACKEND_TOKEN`, `KIDS_OPERATOR_BACKEND_TOKEN`, and a separate `KIDS_OPERATOR_PASSWORD` in encrypted production environment settings. Without the backend configuration APIs remain disabled. Never expose these variables using a frontend prefix.

The site password unlocks viewing. `/__operator` additionally unlocks local test identities and operator actions for eight hours. The operator password must differ from the site password. Both cookies are Secure, HttpOnly and SameSite=Strict. Wallet sessions remain separate; a local test identity cannot keep signing after operator access expires. The private gateway authenticates the service and operator independently, signs its internal request context, and preserves only the wallet session cookie and CSRF header. Backend responses and authenticated API reads are never publicly cached.

Apply the login WAF rate rule to both `/__access` and `/__operator`. Static media is served by Vercel; the Railway backend deployment does not need large public videos/images. The gateway queues bounded read bursts with eight concurrent upstream requests, while writes have a separate admission budget. Overload produces a controlled error rather than unbounded work. A short 100-request test is a smoke check, not sustained capacity or DDoS certification.

Cloudflare can be introduced later as the DNS/WAF layer with Full (strict) TLS and cache bypass for `/api/*`, `/__access`, `/__operator` and password-gated HTML. Preserve Secure cookies and origin checks, avoid challenge pages on signed transaction API POSTs, and retain Vercel's gate/WAF because the Vercel alias remains reachable. Do not claim Cloudflare protection is active until zone ownership, DNS, TLS and bypass tests are verified. Current protection is Vercel's edge plus application limits.

## Admin stays local (22 September 2026)

The uploaded frontend contains no Admin view, link or route, and the gate refuses every `/api/admin` path with 404 regardless of cookies; the hosted gateway does the same. Admin functions run only on the local development server (`npm run dev` on 127.0.0.1), where the admin plugin is loopback-bound. The `/__operator` login still unlocks the local test identities on the private site and now returns to the home page.
