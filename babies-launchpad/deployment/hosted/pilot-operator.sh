#!/bin/zsh
# Owner command: an operator action for one pilot campaign (status, grant-keeper, schedule, grant-refund, grant-return),
# run inside the accounting worker's container where the database and the RPC are reachable. Nothing is signed: the
# tool reads the chain and records the grant or the schedule in the shared registry. Example:
#   zsh babies-launchpad/deployment/hosted/pilot-operator.sh grant-keeper --campaign <address>
#   zsh babies-launchpad/deployment/hosted/pilot-operator.sh schedule --campaign <address>
set -e
[ $# -ge 1 ] || { echo "usage: pilot-operator.sh <status|grant-keeper|schedule|grant-refund|grant-return> --campaign <address> [--hours N]"; exit 1; }
PROJECT=6f623b65-d0e5-4416-acb0-61d4e3507ac9
railway ssh -p "$PROJECT" -e production --service kids-worker-accounting -- node localnet/operator-lifecycle.mjs "$@"
