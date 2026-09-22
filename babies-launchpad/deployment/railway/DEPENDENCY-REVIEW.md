# Private staging dependency review

Reviewed 2026-09-20. Frontend Vite patched to 6.4.3; clean npm 11.19 installation, build and 62 tests passed. The repaired lock includes optional websocket peer dependencies required by Linux clean installs.

The frontend audit retains four moderate transitive Solana/jayson alerts and no high alerts. The localnet dependency graph retains six moderate and three high alerts inherited through Solana packages. These are unresolved upstream advisories, not a clean security bill of health. Do not use an automatic force downgrade to obsolete SPL Token/web3 versions to silence the report.

The reviewed jayson browser RPC client uses UUID v4, while the reported output-buffer issue affects other UUID algorithms. Its streaming parser/filter API is not used by these application paths. The native bigint-buffer advisory has no compatible patch; the container installs with `--ignore-scripts` so that addon is not compiled, leaving the JavaScript fallback. SPL layouts use fixed-width integer slices. Reassess these assumptions on dependency or call-site changes.

This reachability review and internal contract review do not replace independent security review before mainnet funds. Keep the remote environment on isolated localnet, with server-side credentials and operator-only test-wallet signing.
