# Private staging dependency review

Reviewed 2026-09-20. Frontend Vite patched to 6.4.3; clean npm 11.19 installation, build and 62 tests passed. The repaired lock includes optional websocket peer dependencies required by Linux clean installs.

The frontend audit retains four moderate transitive Solana/jayson alerts and no high alerts. The localnet dependency graph retains six moderate and three high alerts inherited through Solana packages. These are unresolved upstream advisories, not a clean security bill of health. Do not use an automatic force downgrade to obsolete SPL Token/web3 versions to silence the report.

The reviewed jayson browser RPC client uses UUID v4, while the reported output-buffer issue affects other UUID algorithms. Its streaming parser/filter API is not used by these application paths. The native bigint-buffer advisory has no compatible patch; the container installs with `--ignore-scripts` so that addon is not compiled, leaving the JavaScript fallback. SPL layouts use fixed-width integer slices. Reassess these assumptions on dependency or call-site changes.

This reachability review and internal contract review do not replace independent security review before mainnet funds. Keep the remote environment on isolated localnet, with server-side credentials and operator-only test-wallet signing.

## Standard branch refresh, 27 September 2026

The frontend now pins jayson's UUID dependency to 11.1.1, matching the backend's
existing narrow override. A fresh isolated `npm ci --ignore-scripts`, browser-client
RPC request/response check and public-launch-enabled Vite build pass. The old
shared checkout's installed dependencies were not overwritten during the ongoing
financial qualification. Deployment must use the committed lock via clean install.
The [UUID advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq) is patched
without an obsolete web3 downgrade or a major JSON-RPC client replacement.

Current production-dependency audit counts: frontend two moderate; localnet two
moderate and three high transitive findings. They remain visible in the audit.
The [stream-json issue](https://github.com/advisories/GHSA-528h-pc64-c93x) affects
path filters; the actual jayson browser RPC path does not load stream-json. The
backend additionally hash-verifies and installs bigint-buffer's upstream pure-JS
entrypoint, and its poison-loader test refuses native binding loads. This is
stronger than relying only on an unavailable compiler after `--ignore-scripts`.
The [native bigint advisory](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg)
remains in package audit because the package version is still upstream 1.1.5.

Do not label these remaining reports fixed or suppress them globally. Require the
harden step and runtime dependency test in every backend image, revisit reachability
on call-site changes, and review upstream compatible fixes when available. This
refresh is not an independent security audit or a public-release authorization.
