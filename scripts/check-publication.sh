#!/bin/sh
# Run against the exact final upload tree; do not substitute source-only scans.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ "$#" -eq 1 ] || { echo 'Provide exactly one final upload tree.' >&2; exit 2; }
python3 "$root/scripts/secret-scan.py" artifacts "$1"
python3 "$root/babies-launchpad/scripts/check-publication.py" "$1"
