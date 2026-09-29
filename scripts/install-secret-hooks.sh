#!/bin/sh
set -eu
root=$(git rev-parse --show-toplevel)
command -v gitleaks >/dev/null || { echo 'Install gitleaks 8.30.1 first.' >&2; exit 1; }
[ "$(gitleaks version)" = '8.30.1' ] || { echo 'gitleaks 8.30.1 required.' >&2; exit 1; }
existing=$(git config --local --get core.hooksPath || true)
[ -z "$existing" ] || [ "$existing" = '.githooks' ] || { echo 'Existing hook path requires integration; refusing to replace it.' >&2; exit 1; }
git config --local core.hooksPath .githooks
chmod +x "$root/.githooks/pre-commit" "$root/.githooks/pre-push" "$root/.githooks/commit-msg"
python3 "$root/scripts/secret-scan.py" policy
echo 'Mandatory pre-commit, commit-msg and pre-push scans installed.'
