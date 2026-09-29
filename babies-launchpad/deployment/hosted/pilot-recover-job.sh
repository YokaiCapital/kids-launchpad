#!/bin/sh
# Owner command: the audited recovery of ONE permanently failed pilot job, or the audited binding repair of ONE queued,
# never-leased operating-refill row. Runs localnet/jobs/recover-failed-cli.mjs inside the accounting worker (hosted database
# access). Step 1, dry run: prints the row as reviewed and the exact write command. Step 2, write: run that printed command.
# The write path refuses if the row differs from the reviewed token, result hash or scope. Output is JSON lines; a line that
# says "refused" comes with a non-zero exit status: the script's exit status is the command's own status (POSIX sh; runs
# under sh, bash and zsh alike).
#   zsh deployment/hosted/pilot-recover-job.sh --job <job id> --reason <reason> --recovery-id <id> --dry-run
#   zsh deployment/hosted/pilot-recover-job.sh --action bind-refill --job <job id> --recovery-id <id> --dry-run
# Reasons: the reviewed set in localnet/jobs/recover-failed.mjs (transient-retry-reviewed, reconciliation-budget-correction,
# expired-grant-regranted, activity-decoder-fix-reviewed).
set -u
PROJECT=${KIDS_RAILWAY_PROJECT:-6f623b65-d0e5-4416-acb0-61d4e3507ac9}
if [ $# -lt 4 ]; then
  echo "usage: pilot-recover-job.sh [--action requeue|bind-refill] --job <job id> [--reason <reason>] --recovery-id <id> (--dry-run | --expected-token <n> [--expected-hash <sha256>] --genesis <hash> --program <address> --campaign <address>) [--actor <name>]" >&2
  exit 64
fi
cd "$(dirname "$0")/../.." || exit 1
# Capture first, filter afterwards: the exit status is the command's, never grep's.
out=$(railway ssh -p "$PROJECT" -e production --service kids-worker-accounting -- node localnet/jobs/recover-failed-cli.mjs "$@" 2>&1)
rc=$?
printf '%s\n' "$out" | grep -v "Config as Code\|Migrate:\|Existing files\|Using SSH key\|newer Railway CLI\|railway upgrade"
exit $rc
