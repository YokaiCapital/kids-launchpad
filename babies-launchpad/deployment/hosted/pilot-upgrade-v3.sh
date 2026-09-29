#!/bin/zsh
# Owner command: upgrade the version-3 launch program on mainnet to the reviewed build. Second run (28 September, afternoon):
# tag 40, the compact creation, lets the creator's single transaction create the token, its custody, the campaign, the
# setup budget and the operating reserve with one wallet approval (owner rule: one click, one transaction). First run
# (28 September, 11:28 UTC, build 71d0d62c…): tag 20 (opening a campaign's fee cycle) signed by any payer for Standard
# campaigns. Then the release files are rewritten for the new bytes; the hosted API turns the one-transaction path on
# only once its release names this build. Signed by the governance key, paid by the operator wallet (the program-data account grows by 152
# bytes, the tool extends it first; most of the cost comes back when the write buffer closes). Shartcoin's program is
# not touched.
#   KIDS_HELIUS_RPC_URL=<url> zsh deployment/hosted/pilot-upgrade-v3.sh --check-only   (prints the cost, changes nothing)
#   KIDS_HELIUS_RPC_URL=<url> zsh deployment/hosted/pilot-upgrade-v3.sh                (the upgrade + release files)
set -e
set -o pipefail
: "${KIDS_HELIUS_RPC_URL:?set KIDS_HELIUS_RPC_URL to your server-side Helius URL first}"
export KIDS_NETWORK=mainnet
cd "$(dirname "$0")/../.."
BIN=$HOME/.local/share/solana/install/active_release/bin
EXPECT=ec8f995140f3e2f2c49af14aa4a60518192f1c1eb9c969599205ef4ccc1a68c8
OUT=$(mktemp -d)/build
echo "building programs/kids-launch-v3 for mainnet (no localnet features)"
BUILD_LOG=$(mktemp)
"$BIN/cargo-build-sbf" --manifest-path programs/kids-launch-v3/Cargo.toml --sbf-out-dir "$OUT" -- --locked 2>&1 | tee "$BUILD_LOG"
# A function whose frame exceeds the 4 KiB stack still links but is undefined behaviour at run time (same rule as the
# localnet deploy script): such a build is never deployed.
if grep -E -q "overwrites values in the frame|overflows the maximum allowed frame space" "$BUILD_LOG"; then echo "the build reports a stack frame overflow; stop"; exit 1; fi
SO="$OUT/kids_launch_v3.so"
ACTUAL=$(shasum -a 256 "$SO" | cut -d' ' -f1)
echo "binary sha256 $ACTUAL size $(stat -f%z "$SO") bytes (expected $EXPECT, 206464 bytes)"
[ "$ACTUAL" = "$EXPECT" ] || { echo "the build differs from the reviewed one; stop"; exit 1; }
export KIDS_PROGRAM_SHA256=$EXPECT
node localnet/deploy-program-network.mjs "$SO" --program launch-v3 ${1:-}
if [ "${1:-}" = "--check-only" ]; then exit 0; fi
cp "$SO" "$HOME/.config/kids/mainnet/kids_launch_v3.$EXPECT.so"
node localnet/hosted/make-release.mjs --network mainnet --rpc "$KIDS_HELIUS_RPC_URL" --program ABq14qMonDrPbRJUbyfACsazK2ESaiKWcw5u66qy6f7T --binary "$SO" --signer 7MESsrmBCSAnA32uA67K9V9cwXnkVNGr6C8eSLEGJkzi --treasury 91eLwFTAxkcQLPSMxbzdSFkTyEwyRYcoZk64HMZj8vX
echo
echo "DONE. Program upgraded to build $EXPECT; release files rewritten under deployment/hosted (I commit them). Next: zsh deployment/hosted/pilot-railway.sh"
