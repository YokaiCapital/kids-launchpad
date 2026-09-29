#!/bin/zsh
# Owner command: run the site on this Mac against the pilot API. The service token comes from the private access file
# written by pilot-railway.sh and never reaches the browser (the dev server adds it on the way out).
set -e
cd "$(dirname "$0")/../../interaction-review"
ACCESS=$HOME/.config/kids/mainnet/pilot-access.json
[ -f "$ACCESS" ] || { echo "missing $ACCESS (run pilot-railway.sh first)"; exit 1; }
export KIDS_PILOT_API_ORIGIN=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['origin'])" "$ACCESS")
export KIDS_PILOT_API_TOKEN=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['KIDS_BACKEND_TOKEN'])" "$ACCESS")
echo "pilot API: $KIDS_PILOT_API_ORIGIN"
VITE_KIDS_PUBLIC_LAUNCHES=1 VITE_KIDS_NETWORK=mainnet npm run dev
