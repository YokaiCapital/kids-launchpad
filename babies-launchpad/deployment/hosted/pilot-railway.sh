#!/bin/zsh
# Owner command: create or complete the private-pilot services on Railway (project kids-mainnet) from the public-launches
# branch. Safe to re-run at any point: a service that exists is completed, not recreated; a generated secret that
# exists is kept; a volume, a domain or a GitHub connection that exists is left alone; every Railway call is retried
# on a network hiccup. No secret is ever printed: secrets reach Railway through standard input, so the output of this
# script can be shared.
#
# Creates: the pilot database, the version-3 signer, six worker lanes, the indexer and the pilot API, each with its
# variables, the two volumes and the pilot API's public domain, then connects every service to GitHub so the builds
# start. Shartcoin's services (kids-api, kids-signer, believers-worker) are not touched.
#
# Needs: the Railway CLI logged in (railway whoami) and the version-3 signer key file from the deploy step
# (~/.config/kids/mainnet/signer-v3-keypair.json; read once here, sent to the signer service, never printed).
# Optional: export KIDS_ALERT_WEBHOOK=<https Telegram sendMessage or Discord webhook URL> first and the pilot API posts
# alert changes there. Export KIDS_PILOT_ROTATE_SIGNER_TOKEN=1 to replace the signer token (the signer and the workers
# that use it are redeployed at the end).
set -e
PROJECT=6f623b65-d0e5-4416-acb0-61d4e3507ac9   # kids-mainnet
ENVIRONMENT=production
REPO=YokaiCapital/kids-launchpad
BRANCH=${KIDS_PILOT_BRANCH:-feature/public-launches}
PILOT_WALLET=JBjY3ETQWkJa79G1URqFsgzqxKqxWeNfNycccQLkGVgn
MANIFEST=deployment/hosted/release-mainnet.json
KEY=$HOME/.config/kids/mainnet/signer-v3-keypair.json
ACCESS=$HOME/.config/kids/mainnet/pilot-access.json
cd "$(dirname "$0")/../../.."        # repository root: Dockerfile and railway.json live here
[ -f Dockerfile ] && [ -f "babies-launchpad/$MANIFEST" ] || { echo "run this from the kids-launchpad checkout"; exit 1; }
[ -f "$KEY" ] || { echo "signer key file missing: $KEY (run the deploy step first)"; exit 1; }
railway whoami >/dev/null || { echo "railway login first"; exit 1; }

# Every Railway call is retried on a transient failure (the CLI times out on a flaky line).
rw(){ local n=0; until "$@"; do n=$((n+1)); [ $n -ge 4 ] && return 1; echo "  (network error, retrying: $1 ${2:-} ${3:-})" >&2; sleep 5; done; }
token(){ openssl rand -hex 32; }
services(){ rw railway status --json 2>/dev/null | python3 -c "import sys,json;raw=sys.stdin.read();d=json.loads(raw[raw.index('{'):]);print('\n'.join(e['node']['name'] for e in d['services']['edges']))"; }
have(){ services | grep -qx -- "$1"; }
var_names(){ rw railway variable list --service "$1" --json 2>/dev/null | python3 -c "import sys,json;raw=sys.stdin.read();print('\n'.join(json.loads(raw[raw.index('{'):]).keys()) if '{' in raw else '')"; }
has_var(){ var_names "$1" | grep -qx -- "$2"; }
setvar(){ printf '%s' "$3" | rw railway variable set "$2" --stdin --service "$1" --skip-deploys >/dev/null 2>&1; }   # value via stdin, never printed
setvar_keep(){ has_var "$1" "$2" || setvar "$1" "$2" "$3"; }                                                      # generated once, kept on re-runs
ensure_service(){ have "$1" || { echo "creating $1"; rw railway add --service "$1" --json </dev/null >/dev/null; } }
has_volume(){ rw railway volume list --json 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);print(any(v.get('serviceName')==sys.argv[1] and v.get('mountPath')=='/data' and not v.get('isPendingDeletion') for v in d.get('volumes',[])))" "$1" | grep -q True; }
service_id(){ rw railway status --json 2>/dev/null | python3 -c "import sys,json;raw=sys.stdin.read();d=json.loads(raw[raw.index('{'):]);print(next((e['node']['id'] for e in d['services']['edges'] if e['node']['name']==sys.argv[1]),''))" "$1"; }
MISSING_VOLUMES=""
ensure_volume(){ # the CLI (5.49) crashes on some volume adds; try by name, then by id, else leave it to the dashboard and go on
  has_volume "$1" && return 0
  echo "  volume /data for $1"
  railway volume -s "$1" add -m /data </dev/null >/dev/null 2>&1 || railway volume -s "$(service_id "$1")" add -m /data </dev/null >/dev/null 2>&1 || true
  sleep 5   # the volume appears in the listing a moment after the call, even when the CLI crashed after creating it
  has_volume "$1" || { MISSING_VOLUMES="$MISSING_VOLUMES $1"; echo "  (the CLI could not add it; add a volume with mount path /data to $1 in the Railway dashboard, then re-run this script)"; }
}
connect(){ echo "connecting $1 to $REPO@$BRANCH"; railway service source connect --repo "$REPO" --branch "$BRANCH" --service "$1" >/dev/null 2>&1 || echo "  ($1 already connected, or refused; check the dashboard)"; }
common(){ setvar "$1" KIDS_ROLE "$2"; setvar "$1" PORT "$3"; setvar "$1" KIDS_REGISTRY_URL "$REG"; setvar "$1" KIDS_RPC_URL "$RPC"; setvar "$1" KIDS_RELEASE_MANIFEST "$MANIFEST"; }

echo "linking this folder to project kids-mainnet ($ENVIRONMENT)"
rw railway link -p "$PROJECT" -e "$ENVIRONMENT" -s kids-api >/dev/null

# 1. Database (private network only; the schema is created at boot by the pilot API and the accounting worker) --------
DB=$(services | grep -i -m1 '^postgres' || true)
if [ -z "$DB" ]; then
  echo "creating the pilot database"; BEFORE=$(services)
  rw railway add -d postgres --json </dev/null >/dev/null
  for i in $(seq 1 30); do DB=$(comm -13 <(echo "$BEFORE" | sort) <(services | sort) | grep -i -m1 postgres || true); [ -n "$DB" ] && break; sleep 2; done
  [ -n "$DB" ] || { echo "the database service did not appear; check the Railway dashboard"; exit 1; }
fi
echo "database service: $DB"
REG='${{'"$DB"'.DATABASE_URL}}'
RPC='${{kids-api.KIDS_HELIUS_RPC_URL}}'

# 2. Version-3 signer ---------------------------------------------------------------------------------------------
ensure_service kids-signer-v3
echo "variables for kids-signer-v3"
common kids-signer-v3 signer-v3 4177
setvar kids-signer-v3 KIDS_SIGNER_CONFIG deployment/hosted/signer-v3.json
ROTATED=0
if [ "${KIDS_PILOT_ROTATE_SIGNER_TOKEN:-0}" = 1 ] || ! has_var kids-signer-v3 KIDS_SIGNER_TOKEN; then setvar kids-signer-v3 KIDS_SIGNER_TOKEN "$(token)"; ROTATED=1; echo "  signer token set"; fi
ensure_volume kids-signer-v3
if ! has_var kids-signer-v3 KIDS_SIGNER_KEY_JSON; then rw railway variable set KIDS_SIGNER_KEY_JSON --stdin --service kids-signer-v3 --skip-deploys < "$KEY" >/dev/null 2>&1; echo "  signer key sent (the first boot stores it; then delete the variable)"; fi
SIGNER_TOKEN_REF='${{kids-signer-v3.KIDS_SIGNER_TOKEN}}'

# 3. Worker lanes and the indexer --------------------------------------------------------------------------------
for LANE in lifecycle recovery provisioning harvest economics accounting; do
  NAME=kids-worker-$LANE
  ensure_service "$NAME"
  echo "variables for $NAME"
  common "$NAME" worker 8080
  setvar "$NAME" KIDS_WORKER_CONFIG "deployment/hosted/worker-$LANE.json"
  if [ "$LANE" = accounting ]; then setvar "$NAME" KIDS_REGISTRY_MIGRATE 1; else setvar "$NAME" KIDS_SIGNER_TOKEN "$SIGNER_TOKEN_REF"; fi
done
ensure_service kids-indexer
echo "variables for kids-indexer"
common kids-indexer indexer 8080
setvar kids-indexer KIDS_MARKET_WORKER_CONFIG deployment/hosted/market-indexing.json

# 4. Pilot API ---------------------------------------------------------------------------------------------------
ensure_service kids-api-pilot
echo "variables for kids-api-pilot"
common kids-api-pilot api-pilot 8080
setvar kids-api-pilot KIDS_NETWORK mainnet
setvar kids-api-pilot KIDS_HELIUS_RPC_URL "$RPC"
setvar kids-api-pilot KIDS_CREATOR_FLOW hosted
setvar kids-api-pilot KIDS_PUBLIC_PILOT_WALLET "$PILOT_WALLET"
setvar kids-api-pilot KIDS_PINATA_JWT '${{kids-api.KIDS_PINATA_JWT}}'
setvar_keep kids-api-pilot KIDS_MINT_ENCRYPTION_KEY "$(token)"
setvar_keep kids-api-pilot KIDS_CSRF_SECRET "$(token)"
setvar_keep kids-api-pilot KIDS_GATEWAY_INTERNAL_TOKEN "$(token)"
setvar_keep kids-api-pilot KIDS_OPERATOR_BACKEND_TOKEN "$(token)"
if [ -n "${KIDS_ALERT_WEBHOOK:-}" ]; then setvar kids-api-pilot KIDS_ALERT_WEBHOOK "$KIDS_ALERT_WEBHOOK"; echo "  alert webhook set"; fi
ensure_volume kids-api-pilot
DOMAIN=$(rw railway domain list --service kids-api-pilot --json 2>/dev/null | grep -oE '[a-z0-9-]+\.up\.railway\.app' | head -1 || true)
[ -n "$DOMAIN" ] || DOMAIN=$(rw railway domain --service kids-api-pilot --port 8080 --json 2>/dev/null | grep -oE '[a-z0-9-]+\.up\.railway\.app' | head -1 || true)
[ -n "$DOMAIN" ] || { echo "no domain for kids-api-pilot; create one in the dashboard (port 8080), then re-run this script"; exit 1; }
setvar kids-api-pilot KIDS_GATEWAY_HOST "$DOMAIN"
if ! has_var kids-api-pilot KIDS_BACKEND_TOKEN || [ ! -f "$ACCESS" ]; then
  BACKEND_TOKEN=$(token); setvar kids-api-pilot KIDS_BACKEND_TOKEN "$BACKEND_TOKEN"
  umask 077; printf '{"origin":"https://%s","KIDS_BACKEND_TOKEN":"%s"}\n' "$DOMAIN" "$BACKEND_TOKEN" > "$ACCESS"
  echo "  pilot access file written: $ACCESS (the UI command reads it; keep it private)"
fi

# 5. Connect every service to GitHub: this starts the builds (a service already connected is left alone) ---------------
for NAME in kids-signer-v3 kids-worker-accounting kids-worker-lifecycle kids-worker-recovery kids-worker-provisioning kids-worker-harvest kids-worker-economics kids-indexer kids-api-pilot; do connect "$NAME"; done
if [ "$ROTATED" = 1 ]; then for NAME in kids-signer-v3 kids-worker-lifecycle kids-worker-recovery kids-worker-provisioning kids-worker-harvest kids-worker-economics; do railway redeploy --service "$NAME" --yes >/dev/null 2>&1 || true; done; fi
echo
[ -z "$MISSING_VOLUMES" ] || echo "STILL NEEDED: a /data volume on$MISSING_VOLUMES (Railway dashboard: service, Settings, Volumes, mount path /data); those services keep restarting until it exists. Re-run this script afterwards."
echo "DONE. Pilot API domain: https://$DOMAIN"
echo "Builds take about five minutes. Check:"
echo "  railway logs -s kids-signer-v3 | grep -m1 signer-v3-listening"
echo "  railway logs -s kids-api-pilot  | grep -m1 pilot-api-ready"
echo "  curl -s https://$DOMAIN/readyz"
echo "Then remove the key variable from the signer once its log shows signer-v3-key-stored:"
echo "  railway variable delete KIDS_SIGNER_KEY_JSON --service kids-signer-v3"
echo "Pilot UI on this Mac: zsh babies-launchpad/deployment/hosted/pilot-ui.sh"
