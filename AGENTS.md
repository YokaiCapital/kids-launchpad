# KIDS repository safety rules

These rules apply to every contributor and agent, including release/hotfix work.

- Before **every commit**, install the tracked hooks (`sh scripts/install-secret-hooks.sh`) and pass `python3 scripts/secret-scan.py staged` on the exact index being committed. After staging changes again, rerun it. Never use `--no-verify`, disable hooks, or commit if the scanner is missing or fails.
- Before **every push**, pass `python3 scripts/secret-scan.py history`. CI must run the mandatory `secret-scan` check on every push and pull request.
- Before **every deployment/publication**, scan the exact generated/uploaded tree with `python3 scripts/secret-scan.py artifacts <path>`. Source checks alone do not qualify bundles, archives, source maps or deployment output. Run the existing publication check too.
- Never commit or publish API/RPC credentials, passwords, signing keys, seed phrases, private environment files, authenticated URLs, session cookies or runtime databases. Never print detected values in logs, reports, review comments or chat.
- Findings block the operation. Investigate with redacted output. Confirmed exposed credentials require owner-coordinated revocation/rotation; deleting a file does not remove exposure from history or caches. Do not test live credentials to prove validity.
- Exceptions must be exact rule + repository-relative file + SHA-256 of the reviewed non-secret value in `.secret-allowlist.json`, with a reason. No broad directory/rule/commit exclusions, inline bypasses or blanket baselines. Public addresses and clearly synthetic fixtures may qualify; real credentials never do.
- Local hooks are not a server boundary. Protected branch/ruleset required checks and provider push protection must remain enabled; report unavailable permissions instead of claiming enforcement exists.

- Previous first-party projects, brands, team affiliations and source-provenance links are confidential. Do not name them in source, docs, filenames, commit messages, issues, PRs, logs, bundles or public-facing materials. Approved current KIDS/Shartcoin branding and legitimate third-party providers remain allowed; retain legally required third-party notices.
- The confidential-project rule has no allowlist exceptions. Commit messages are scanned by `commit-msg`; pre-push scans all reachable history and metadata. Existing prohibited history blocks pushes until a coordinated history cleanup; do not bypass the guard.
- Keep the repository PRIVATE until the owner-authorized confidentiality cleanup and exposure review pass for history, branches/tags, PR references/cached originals, metadata and publication assets. The owner has conditionally authorized restoring PUBLIC visibility after those checks pass; no second routine visibility approval is required. A clean source scan alone is insufficient. Never merge old unsanitized history into a cleaned branch.

- Final upload trees must pass `sh scripts/check-publication.sh <absolute-output-directory>`. The frontend deployment preparer and worker stager run this gate automatically. Manual provider uploads must run it immediately before uploading the same tree.

- Real confidential terms are private policy, not public source, regexes, byte arrays or fixtures. Provision `KIDS_CONFIDENTIAL_TERMS` privately (newline-separated) or the owner-only file reported by `git rev-parse --git-path info/kids-confidential-terms`; CI uses the repository secret of the same name. Missing policy blocks checks. Never print policy values or expose them to untrusted fork code. Synthetic regression terms are not the real policy.
