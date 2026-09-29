# Application security review of the pilot stack, 28 September 2026

Read-only review done inside the project before the private mainnet pilot (not a third-party audit). The full report
follows the status table. Status words: **fixed** (code on the branch with a test), **owner** (needs the owner's
action), **open** (not done, tracked in the release checklist).

| Id | Finding | Status, 28 September 2026 |
| --- | --- | --- |
| B1 | Gateway allowed none of the hosted creator, upload, trade or media routes | fixed: exact allowlist, binary uploads with the server's caps and checked headers, ranged media reads (`interaction-review/staging/gateway.mjs`, `gateway-pilot.test.mjs`) |
| B2 | File media store refused the object keys the artwork and video services produce | fixed: exactly the two key shapes accepted, slash mapped to a marker no other key contains (`media-store.mjs`, `media-store-keys.test.mjs`) |
| B3 | Pilot browser refused the server's sign-in challenge (origin bound to the public site) | fixed: the pilot build defines the expected site origin (`vite.config.mjs`, `Account.jsx`); the server side is unchanged |
| M1 | Sign-in denial of service: a wallet locked out by foreign challenges; anonymous callers shared one budget | fixed: the oldest pending challenge gives way in both stores; the gateway derives an identity from the peer address (`account-store.mjs`, `postgres-account-store.mjs`, `gateway.mjs`) |
| L1 | `/statusz` served the full status body (volume path, error text, key) | fixed: the gateway serves a trimmed public body (`publicStatusBody`, `service-status.mjs`) |
| L2 | Image and video decoders run as root in the container | open: before public creators upload media; documented in the release checklist |
| L3 | Supervisor environment checks incomplete; legacy money routes installed on the pilot API | fixed: wider refusals on the pilot API, worker and indexer; legacy money routes answer 404 without background services (`deployment/mainnet/*-supervisor.mjs`, `account-plugin.mjs`) |
| L4 | Gateway replay set capped throughput at about 136 requests per second | fixed: 65,536 entries, pruned from the oldest (`shared/trusted-gateway.mjs`) |
| L5 | Pilot session cookie stored for 127.0.0.1, shared with other local ports | owner: sign out after each pilot session; noted in the runbook |
| I1 | Replica CSRF token format not forwarded | fixed: both formats pass the gateway and the gate |
| I2 | Raw error text on legacy routes | open: those routes are off on the pilot API; review before the public opening |
| I3 | `.dockerignore` parity, signer listener notes | fixed (`*.pem`, `*.key`); the signer never gets a public domain (runbook) |
| gate | The public site's edge gate needs the same route list before the public opening | open: release checklist |

# Application security review: KIDS public-launch pilot

**Result: no Critical, no High. 1 Medium, 5 Low, 3 Info. Three fail-closed gaps stop the pilot as the runbook describes it: the gateway does not allow the creator routes, the media store refuses its own object keys, and the pilot sign-in refuses the server's challenge. Fix those three first; none of them exposes funds or data.**

Read-only review, 28 September 2026. Branch `feature/public-launches` at commit `85d9c52`.
Checkout root:
```
/tmp/kids-public-integration
```
App root:
```
babies-launchpad
```
Nothing was modified, signed, sent or probed live. Line numbers are from the files at that commit. Private folders, environment files and keypair files were not opened. Secrets are named by variable only.

## Summary in three lines
- **Money and keys are protected.** Every wallet or creator transaction is built by the server, checked byte for byte on submit, signed only by the user's wallet, journaled before broadcast; the pilot wallet restriction cannot be bypassed from the browser; the signer is token-gated on the private network with capability, lease, fencing and budget checks.
- **Three pilot blockers are fail-closed bugs, not holes.** The gateway allowlist, the file media store and the browser challenge check are each stricter than the new hosted flow needs. Their fixes must keep the same strictness, listed per item below.
- **One Medium for the public opening.** Anyone with the site's service token can lock a chosen wallet out of sign-in for as long as they like, and the sign-in budget has no per-client cap for anonymous callers. Not reachable during the pilot because only the owner's machine holds that token.

## Counts
| Severity | Count | Items |
| --- | --- | --- |
| Critical | 0 | |
| High | 0 | |
| Medium | 1 | M1 |
| Low | 5 | L1 to L5 |
| Info | 3 | I1 to I3 |
| Pilot blockers, fail closed | 3 | B1 to B3 |

---

## Pilot blockers: fail closed, fix before the first launch

### B1. The gateway does not allow any hosted creator route
- **Where:** `interaction-review/staging/gateway.mjs:7-8` lists the account routes. It has `launches/drafts`, `drafts/save`, `positions`, `prepare`, `submit`, `status`, `cancel` and `campaigns` only. The hosted flow serves many more in `interaction-review/server/public-launch-account.mjs:50-97`: `launches/artwork/upload`, `launches/video/upload`, `GET launches/artwork/<id>`, `GET launches/video/<id>`, `launches/operations/read`, `launches/portfolio/read`, `launches/activity/read`, `launches/market/read`, `launches/trade/*`, `launches/creation/{quote,accept,prepare,status}`, `launches/creation/flow/*`, `launches/creation/setup/*`.
- **Also blocking uploads:** `gateway.mjs:39` refuses any POST that is not JSON; `gateway.mjs:41` and `:113` cap bodies at 2 MB while artwork allows 5 MiB and video 100 MiB, see `interaction-review/server/artwork-http.mjs:9` and `interaction-review/server/video-http.mjs:23`; `gateway.mjs:45-47` rebuilds the upstream headers with `content-type: application/json` and forwards neither `x-kids-upload-id`, `x-kids-artwork-kind` nor `range`, which the browser sends in `interaction-review/src/public/artwork-upload.mjs:5`.
- **Scenario:** The owner follows the runbook, `deployment/hosted/PILOT-RUNBOOK.md:98-127`. The pilot proxy sends `POST /api/account/launches/creation/quote` to the gateway. The gateway answers `404 Route unavailable`. No create, upload, trade or operations panel works. The last commit did not touch the gateway; `gateway.test.mjs` covers the legacy routes only.
- **Impact:** None on security. The pilot cannot run end to end.
- **Fix, keeping the same strictness:**
  - Add exactly the routes above to the allowlist, by explicit path, no prefix wildcard.
  - On the two upload routes only: accept `image/png`, `image/jpeg`, `video/mp4`, `video/webm`, forward only `x-kids-upload-id` and `x-kids-artwork-kind` after the same regex checks the server applies, and raise the body cap to the server's own limits for those two paths only.
  - On `GET launches/video/<id>` only: forward a `range` header matching `^bytes=\d*-\d*$`.
  - Keep `classifyRequest` putting uploads in the `submit` class, or add a `media` class with its own small budget.
  - The public site's gate has the same list at `interaction-review/deployment/gate.mjs:51-54` and the same header handling at `:68-78`; it needs the same change before the public opening, not for the pilot.

### B2. The file media store refuses the object keys the artwork and video services produce
- **Where:** `interaction-review/server/media-store.mjs:7` allows keys matching `^[A-Za-z0-9_.:-]{1,160}$`, no slash. `localnet/creation/artwork.mjs:54-55` writes `creator-artwork/<64 hex>.png`; `localnet/creation/video.mjs:47-48` writes `creator-video/<64 hex>.mp4` and `.png`. The hosted composition chooses this file store at `interaction-review/server/hosted-creator-services.mjs:90`.
- **Scenario:** The owner uploads a picture. The sanitizer succeeds, `storage.put` throws `Invalid media object key`, the catch at `artwork.mjs:58-61` sets the row back to `pending` and answers `Artwork processing did not complete. Retry the same upload.` Every retry does the same, and each one spends the daily upload quota, `artwork.mjs:39-43`. After three attempts the asset is marked `failed`. The test at `interaction-review/tests/hosted-creator-services.test.mjs:17` only uses a colon-style key, so it never exercised this path.
- **Impact:** None on security. No artwork can be stored, so no quote, publication or launch is possible.
- **Fix:** Accept exactly the two key shapes, mirroring `localnet/creation/private-s3.mjs:8-11`, and map the one slash to a fixed subdirectory or an underscore inside `file()`. Keep the regex otherwise. Add a test that puts and reads `creator-artwork/<hex>.png` through `createFileObjectStore`.

### B3. The pilot browser refuses the server's sign-in challenge
- **Where:** `interaction-review/src/wallet-connection.mjs:92-95` requires the first line and the `URI:` line of the challenge to equal `location.origin`, called from `interaction-review/src/Account.jsx:33-36`. Through the gateway the server builds the message for `https://kids.fun`: `interaction-review/server/account-plugin.mjs:56` takes the origin from the gateway context, which is the constant at `shared/trusted-gateway.mjs:4`; the message text is at `interaction-review/server/account-store.mjs:23`. The pilot proxy sets that origin at `interaction-review/vite.config.mjs:48`, while the page runs at `http://127.0.0.1:5173`.
- **Scenario:** The owner clicks sign in. The browser throws `Sign-in challenge does not match this site and wallet.` before the wallet is asked. No session, so nothing in the pilot is reachable.
- **Impact:** None on security. The check is a phishing defence and is doing its job.
- **Fix:** Keep the check. In development mode only, and only when the pilot proxy is on, let the Vite config define the expected site origin, for example `import.meta.env.VITE_KIDS_PILOT_SITE_ORIGIN = "https://kids.fun"`, and have `validateWalletChallenge` compare against that value instead of `location.origin`. Keep the nonce, issued-at and expiry checks unchanged. The wallet prompt will then say `kids.fun wants you to sign in` while the page is at `127.0.0.1`; that is the intended binding and the owner should expect it. Do not weaken the server side.

---

## Medium

### M1. Sign-in denial of service: a chosen wallet can be locked out, and anonymous callers share one budget
- **Where:** `interaction-review/server/account-store.mjs:20-21` deletes expired challenges, then refuses a new one when the wallet already has five pending. `interaction-review/server/postgres-account-store.mjs:19-20` does the same. The challenge route at `interaction-review/server/account-plugin.mjs:95` needs only the service token and a CSRF token, which `GET /api/account/state` hands to anyone at `:78`. At the gateway, `interaction-review/staging/gateway.mjs:84` skips the per-client cap when the identity is `anon`, and `:61-65` derives identity only from the `x-kids-client` header, which the public site's gate sets and a direct caller can omit. The `auth` class budget is 600 per minute for everyone, `:66`.
- **Scenario, after the public opening:** Any visitor has the service token through the site's gate. They post `POST /api/account/challenge {"owner":"<the pilot creator address>"}` five times, and again every five minutes. The owner's own sign-in then fails with `Too many pending sign-in requests` for as long as the attacker keeps going. The creator address is public in every campaign record. A second variant: a few hundred challenge posts per minute from a handful of addresses exhaust the shared `auth` budget, so every visitor gets `429` on sign in.
- **During the pilot:** Not reachable. Only the owner's own machine holds `KIDS_BACKEND_TOKEN` for the pilot service, and every other request stops at `gateway.mjs:36` with `401`.
- **Impact:** Availability of sign-in, targeted or site-wide. No data or funds.
- **Fix:**
  - In both stores, replace the refusal with eviction: delete the oldest pending challenge for that wallet and insert the new one, keeping five rows at most. The wallet that signs the newest challenge always gets in.
  - At the gateway, give `anon` an identity too, for example a hash of the peer address, so the per-client `auth` cap of 30 per minute applies to everyone.
  - Add a test: five foreign challenges do not block the wallet's sixth.

---

## Low

### L1. `/statusz` serves the API's full status body to anyone on the internet
- **Where:** `interaction-review/staging/gateway.mjs:105` answers `/statusz` before any token check with the body of `/_health/status`, built at `interaction-review/server/runtime.mjs:24` by `statusSnapshot` in `shared/service-status.mjs:17-19`. It carries the volume path and free bytes under `disk`, the signer public key, the reconciliation service names, the release block from `runtime.mjs:74`, and `registry.lastError.message` from `localnet/registry/startup.mjs:43-44`, which redacts database passwords and `api-key` values but can still carry an internal hostname, an address or a table name from a driver error.
- **Scenario:** `GET https://<pilot api domain>/statusz` from anywhere returns the runtime path `/data/localnet`, whether writes are open, and the last registry error text.
- **Impact:** Operational detail for an attacker; no secret. The comment at `service-status.mjs:2` calls it public by design.
- **Fix:** Require the service token for `/statusz`, or serve a trimmed body: `status`, `writesOpen`, `release.checks` and `at` only. Keep the full body on loopback `/_health/status` for the operator.

### L2. The image and video decoders run as root inside the container
- **Where:** `Dockerfile` has no `USER` line, so every process is root. `localnet/creation/image-sanitizer.mjs:15` spawns the sharp child and `localnet/creation/video-sanitizer.mjs:35` spawns ffmpeg and ffprobe on creator uploads. The file header at `video-sanitizer.mjs:1-3` itself asks for a separate, resource-limited, secret-free media process.
- **Scenario:** A crafted PNG or JPEG that triggers a decoder bug in libvips runs as root in the API container, next to `KIDS_PINATA_JWT`, `KIDS_MINT_ENCRYPTION_KEY`, the registry URL and the mint inventory on the volume. During the pilot only the owner can upload; after the public opening any creator can.
- **Impact:** Turns a decoder bug into full API compromise instead of a contained one.
- **Fix, minimal:** Create the data directories at boot as root, `chown` them to the `node` user that the base image already has, then drop privileges before starting the supervisor, for example with `setpriv` from `util-linux`, which the image already installs. Keep the child processes' minimal environment as they are. Longer term, run the sanitizers in their own service as the code comments intend.

### L3. Supervisor environment checks are incomplete, and the legacy money routes stay installed on the pilot API
- **Where:** `deployment/mainnet/api-pilot-supervisor.mjs:9` refuses only `KIDS_OPERATOR_KEY*` and `KIDS_SIGNER_KEY*`. It does not refuse `KIDS_SIGNER_URL`, `KIDS_SIGNER_TOKEN`, `KIDS_ALLOW_LOCAL_OPERATOR_KEY` or `KIDS_DRILL`, and it never calls `resolveOperatorMode`. With a signer URL set, `interaction-review/server/runtime.mjs:94` would probe it, and the legacy Shartcoin routes at `interaction-review/server/account-plugin.mjs:113-124` are still installed and gateway-allowlisted on the pilot service. Today they fail closed on the empty volume, `localnet/active-launch.mjs:85` and `localnet/postlaunch-state.mjs:45` answer `configured:false`. The worker and indexer supervisors, `deployment/mainnet/worker-supervisor.mjs:4-5` and `deployment/mainnet/indexer-supervisor.mjs:3-4`, pass the whole environment through and strip no key variable; only the signer supervisor deletes `KIDS_SIGNER_KEY_JSON`, `deployment/mainnet/signer-v3-supervisor.mjs:13`.
- **Scenario:** An operator copies the legacy API's variables onto the pilot service. The pilot API starts, probes the build-6 signer, and the legacy `prelaunch`, `postlaunch` and `dev-vesting` routes become live on a service that was meant to have no operator signing at all. A key JSON pasted onto a worker by mistake sits in that process's environment for its lifetime.
- **Impact:** Weakens the "no operator key, no legacy keeper" guarantee of the pilot service by configuration mistake, not by attack.
- **Fix:** Extend the refusal to `^KIDS_(OPERATOR_KEY|SIGNER_KEY|SIGNER_URL|SIGNER_TOKEN|ALLOW_LOCAL_OPERATOR_KEY|DRILL)` on the pilot API; refuse `KIDS_SIGNER_KEY_JSON` and `KIDS_OPERATOR_KEY_JSON` on worker and indexer; when `KIDS_BACKGROUND_SERVICES=0`, do not register the legacy `prelaunch`, `postlaunch` and `dev-vesting` handlers at all, answer `404`.

### L4. The gateway's replay set is a hidden throughput ceiling that turns load into 403s
- **Where:** `shared/trusted-gateway.mjs:16-17` prunes nonces older than 30 seconds and returns no context once the set holds 4096 entries. Without a context the account routes fail the origin wall at `shared/local-http.mjs:40` and the directory fails `authorize` at `interaction-review/server/campaigns-plugin.mjs:90`, both `403`. The admission budgets at `interaction-review/staging/gateway.mjs:66` allow about 250 requests per second, roughly twice the 136 per second the replay set can hold.
- **Scenario, after the public opening:** Traffic above about 136 requests per second for 30 seconds, from real visitors or from a handful of abusive addresses each under the per-client cap, makes every request get `403` instead of `429 Retry-After`. Fail closed, but the site looks broken and the error is misleading.
- **Impact:** Availability at the public opening. Not reachable during the pilot.
- **Fix:** Raise the cap well above the admission ceiling, for example 65536 entries, and answer `503` with `Retry-After` when the set is full instead of returning no context.

### L5. The pilot session cookie is stored for `127.0.0.1` and shared with every other local port
- **Where:** `interaction-review/server/account-plugin.mjs:106` sets `kids_session` with `Secure; SameSite=Strict; Path=/api/account`. The pilot proxy at `interaction-review/vite.config.mjs:46-48` passes it back unchanged, so the browser stores it for the host `127.0.0.1`. Browsers ignore the port for cookies and for the same-site rule, so any page served from `127.0.0.1` or `localhost` on another port is same-site with the pilot UI. Vite 6.4.3's default CORS, cross-origin resource sharing, allows those origins but does not allow credentials, so such a page can trigger cookie-bearing `GET` requests but cannot read the answers or send JSON posts.
- **Scenario:** While the pilot session is open, another local web page the owner opens, for example a documentation preview or a tool that opens a browser tab, can make the browser send the pilot session on plain reads. Money moves still need the wallet's signature.
- **Impact:** Small and local to the owner's machine.
- **Fix:** Serve the pilot UI on its own name, for example `http://pilot.localhost:5173`, add it to `allowedHosts`, and sign out when the pilot session is over.

---

## Info

### I1. The replica CSRF token format cannot pass the gateway or the gate
- **Where:** `shared/replica-csrf.mjs:9,11` issues `<13 digits>.<64 hex>`; `interaction-review/staging/gateway.mjs:46` and `interaction-review/deployment/gate.mjs:72` forward `x-kids-csrf` only when it is 48 hex characters.
- **Effect:** With `KIDS_ACCOUNT_STORAGE=postgres` every POST would fail `403 Refresh sign-in before trying again`. The runbook does not set it, so the pilot uses the SQLite account store with a per-boot token, and `KIDS_CSRF_SECRET` is required by the supervisor but unused. Fail closed; fix the two regexes before running more than one API replica.

### I2. Raw error text reaches clients on the legacy routes
- **Where:** `interaction-review/server/account-plugin.mjs:140` returns `e.message` as the `400` body for everything outside the launches service; the launches service maps its own errors to fixed texts at `interaction-review/server/public-launch-account.mjs:99`. A malformed JSON body returns the parser's message. No path or secret was found in a reachable message on the pilot service; review the legacy handlers before the public opening or drop them per L3.

### I3. Packaging and signer listener notes
- **Docker ignore parity:** `.dockerignore` lacks the `*.pem` and `*.key` lines that `.gitignore` has. Railway builds from the GitHub checkout, which tracks no such files, so nothing leaks today. Add them for parity.
- **Signer listener:** `deployment/hosted/signer-v3.json:2-4` binds `::` on port 4177 and `localnet/signer-service.mjs:43` serves `/healthz` without a token, showing the payer public key and the hourly spend. This is fine on the private network only. Never attach a public domain to `kids-signer-v3`.
- **Open from the 24 September review:** the loose transient match `\b5\d\d\b` is still at `localnet/jobs/runner.mjs:30`.

---

## Earlier findings re-checked

| 24 September item | Status now | Evidence |
| --- | --- | --- |
| M1 campaign route live without a flag | Holds | `campaigns-plugin.mjs:32` returns null without `KIDS_REGISTRY_URL`; hosted mode adds `authorize`, so `/api/campaigns` is `403` for everyone except the pilot wallet, `hosted-creator-services.mjs:109` |
| M2 fencing token not enforced | Holds | `signer-service.mjs:97` refuses a stale token, `:115` records only after signing, and version 3 also needs `authorizeLease`, `:86-96` |
| M3 media URLs unvalidated | Holds | `media-hosts.mjs:20-36` on every media field in `campaign-adapter.mjs:84,89,118`; the allow-list now includes `gateway.pinata.cloud` limited to `/ipfs/<cid>`, and profiles come only from creator-approved publication receipts, `creator-profile.mjs:9-14` |
| L1 internal plan fields | Holds | `campaigns-plugin.mjs:20-27` |
| L2 committed node_modules link | Holds | `git ls-files` shows none |
| L3 malformed coin link | Holds | `src/public/routes.mjs:9` guards the decode |
| L4 fee cycle before served-campaign check | Holds | `jobs/handlers.mjs:179-181` requires `servedCampaign` |
| L5 never-grantable tags | Holds | `registry/registry.mjs:329`, `registry/async-api.mjs:347` |
| I3 loose 5xx match | Open | `jobs/runner.mjs:30` |

---

## Checked and found sound

- **Gateway authentication.** Bearer compared by SHA-256 plus `timingSafeEqual`; exact host and `Origin: https://kids.fun`; method plus path allowlist with bounded query regexes; separate operator token for the four operator routes; JSON-only POSTs; 2 MB caps both declared and streamed; 25 second upstream timeout; JSON-only responses; only the `kids_session` cookie is forwarded and `Secure` is appended on the way back; `/healthz` and `/readyz` are constant cost. `gateway.mjs:23-48,97-133`.
- **API isolation.** The API listens on loopback only, `runtime.mjs:92`. Every account route passes the loopback, host and origin walls, `local-http.mjs:28-47`, and the gateway context is an HMAC, hash-based message authentication code, over method, path, origin, time and nonce with a 15 second window and replay set, `trusted-gateway.mjs:10-19`.
- **Pilot wallet restriction.** `createPublicLaunchAccess` refuses a non-canonical address and is closed when unset, `public-launch-access.mjs:6-14`. The verified owner travels only through a server-side Symbol set after the session check, `account-plugin.mjs:64-67`. `handle` re-checks the wallet on every launches call, `public-launch-account.mjs:44-45`. The artwork, video, publication, mint, setup and reserve services each pin `pilotCreator` again. The legacy market and activity feeds are off under `KIDS_BACKGROUND_SERVICES=0`, so `/api/market/*` answers `404`. The program itself seals the creator per the runbook.
- **Sign-in.** 32 random bytes per session stored hashed, 24 hour life, challenge single use with a 24 byte nonce, five minute expiry, origin-bound text, Ed25519 verification through `node:crypto`, challenge deleted in the same transaction as the session insert; SQLite path serialised by `BEGIN IMMEDIATE`, Postgres path `SERIALIZABLE` with retry. Cookie `HttpOnly; Secure; SameSite=Strict; Path=/api/account`; logout deletes the row. The browser re-checks the signed-in owner and the wallet's public key before every request and every signature, `usePublicWallet.jsx`, `wallet-connection.mjs:19-20,101`.
- **CSRF, cross-site request forgery.** Header token required on every POST before any handler, `account-plugin.mjs:81`, plus the exact origin check at the gateway and `SameSite=Strict`.
- **No open relay.** `public-wallet.mjs:157-170` and `public-trade.mjs:65-76` accept only a signed copy of the packet the server prepared: same payer and signers, same blockhash, instruction-by-instruction equality, compute budget bounded to 0.0001 SOL, owner signature verified, 1232 byte cap, `approved-message.mjs`. Signed bytes are journaled before broadcast and recovery re-sends identical bytes only.
- **Creator packets.** Mint, custody, campaign and operating-reserve packets are built server-side from sealed intents, offered with a persisted blockhash, and on submit compared byte for byte with the creator's signature verified, `mint-approval.mjs:63-102,117-136`, `provision-execution.mjs:60-82`, `operating-reserve.mjs:96-112`. The vendored inventory signs only the message the approval journal authorises, `mint-inventory.js:638-645`. The browser rebuilds every packet independently before the wallet sees it, `creator-signing.mjs`, `public-signing.mjs`.
- **SQL injection.** Every statement is parameterised. Sort is an allow-list, `registry.mjs:70-77`; search is escaped with `ESCAPE '!'`, `async-api.mjs:90`; `toPostgresPlaceholders` is safe because no shipped statement has a `?` inside a literal and only `->>` JSON operators are used; dynamic table or column names come only from constant maps, `publication.mjs:19-20`, `ownership.mjs:20`, `postgres-account-store.mjs:81`. Schema-name interpolation exists only in the `qualify-*` rehearsal tools, which are not served.
- **SSRF, server-side request forgery, and outbound calls.** RPC, remote procedure call, URLs come from the environment and pass `endpointUrl`: no credentials in the URL, https or a `*.internal` name, never loopback in hosted mode, `jobs/service.mjs:35-43`, `creation/scope.mjs`. Pinata calls go to two fixed hosts with `redirect:'error'`, bounded bodies, a CID regex, the JWT, JSON web token, in a header only, and every provider error swallowed, `pinata.mjs`. Media URLs in drafts are stored only after `safeMediaUrl` and never fetched server-side; publication reads owned assets by id, `publication.mjs:21-40`.
- **Path handling.** Media keys are regex-checked and joined under a real path root, `media-store.mjs:7-12`; object keys are server-derived; `assetId` and `requestId` regexes are used only as SQL parameters; mint inventory files sit under `KIDS_MINT_DATA_DIR`; the release manifest's presets path refuses `..`, `release-manifest.mjs:18`.
- **Uploads.** Magic bytes must match the declared type; 5 MiB and 100 MiB caps; per-owner and global daily attempt and byte quotas; concurrency caps; sanitizers run in child processes with a minimal environment; sharp is limited to 16 megapixels, 8192 pixels, one page, metadata stripped, `image-child.mjs:10-17`; ffmpeg gets `-protocol_whitelist file,pipe`, absolute binaries, fixed arguments, a temp directory and output caps, `video-sanitizer.mjs:44-57`; stored objects are `0600` in a `0700` directory with hash checks on read.
- **Secrets.** The signer key is written once at `0600` and the variable deleted, `signer-v3-supervisor.mjs:8-15`; the pilot API refuses operator and signer key variables; the RPC URL is never written to manifests or logs, `network.mjs:1-3`, and error text is redacted in `startup.mjs:33` and `service-status.mjs:5`; worker and indexer start-up failures log a fixed event only; the mint encryption key buffer is zeroed after use and refill children receive `{NODE_ENV}` only, `mint-refill-parallel.js:138`. The browser bundle references no token; `KIDS_PILOT_API_TOKEN` stays in the Node config, `vite.config.mjs:27`.
- **Vite pilot proxy.** Development mode only, https origin required, token at least 32 characters, server bound to `127.0.0.1`, `allowedHosts` limits DNS rebinding, token added on the Node side only, `vite.config.mjs:27,46-48`. See L5 for the one caveat.
- **Supply chain and packaging.** Exact dependency pins; `npm ci --ignore-scripts`; the bigint-buffer pure-JS hardening with pinned hashes runs and is tested at image build; Vite 6.4.3; workflows use SHA-pinned actions and contain no AI-agent action steps. The root `.dockerignore` copies only `babies-launchpad` and excludes `.env*`, keypair and secret JSON, databases, logs, `.runtime` and `node_modules`; `git ls-files` shows no secret-like tracked file; `.runtime` is a link to `/data`.
- **Signer service.** Token compared timing-safe, 8 KB bodies, 60 requests per minute, campaign capability required, operation id bound to one message hash, fencing high-water mark, active lease with a conservative deadline, operating budget held before signing and the signed packet recorded before the signature leaves, ownership lease re-checked at the signing boundary, `signer-service.mjs:42-133`, `registry-service.mjs`, `ownership.mjs`.
- **Rate limiting and DoS on unauthenticated routes.** Only `/healthz`, `/readyz` and `/statusz` are reachable without the token; `/statusz` makes at most one upstream fetch per 5 seconds. Everything else stops at `401` before admission. Upload readers have their own concurrency caps and timeouts.

## Not checked, and limits
- The Rust programs, the Railway and Vercel dashboards, the private handoff folder, environment files and keypair files were out of scope or off limits by instruction.
- No tests were run and no live endpoint was called. Findings are from reading the code paths end to end; the three blockers are asserted from the code and the existing tests, not from a failed pilot run.
- The `qualify-*` rehearsal tools were skimmed for SQL only.

## Method
Read the 24 September review and the two handoff notes first. Read every supervisor, the gateway, the gate, the runtime, the account plugin and stores, the hosted creator composition and every module it composes, the registry adapters and query builders, the signer and worker entry points, the wallet and trade services, the browser signing and upload code, the media store, the Pinata provider, the sanitizers, the Dockerfile and ignore files, the pilot runbook and the hosted configs. Grepped the tree for dynamic SQL, child processes, environment logging, secret-like file names and the routes each layer allows, and compared the lists.
