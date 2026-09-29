# API dependency review — 26 September 2026

This applies to `localnet/package-lock.json` and the API image built from the
root / mainnet / Railway Dockerfiles. It is not a zero-vulnerability claim for
the frontend, mint worker, other branches or deployed images.

After **every** `npm ci --ignore-scripts`, run `npm run harden` in `localnet`.
The checked-in Dockerfiles and CI run it explicitly. Do not enable arbitrary
package lifecycle scripts to achieve this. Do not use `npm audit fix --force`:
the proposed downgrade of Solana libraries removes required functionality.

| Finding | Action / remaining limitation |
| --- | --- |
| [bigint-buffer GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg) | No patched upstream release. Build uses the package's own pure-JS distribution in place of its native-capable Node entry. Both original files and version are hash checked. Unexpected package contents fail the build. Apache-2.0 notices remain. Tests poison the native loader and round-trip exact integers, including empty and oversized buffers. npm audit still flags the package version; this is an explicit mitigation, not a hidden clean audit. |
| [uuid GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | The `jayson` transitive dependency is overridden to patched `11.1.1`, retaining CommonJS support. A real web3 RPC request test verifies UUID v4 request IDs and response handling. |
| [stream-json GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x) | Still present transitively in jayson. The installed web3 transport imports `jayson/lib/client/browser`, which does not load stream-json. The affected pick/ignore/filter/replace paths are not used by this transport. A loaded-module regression check fails if RPC starts loading stream-json. Do not import the full jayson server/stream transport without a new review. This is scoped reachability evidence, not remediation of stream-json itself. |

The Docker context excludes all node_modules, preventing a local native build
from replacing the hardened dependencies during COPY. Hash enforcement after
COPY also checks the final image tree. No hosted image has been deployed by this
checkpoint. Independent security review and remaining dependency scopes are
still release work.
