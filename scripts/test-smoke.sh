#!/usr/bin/env bash
# Smoke test to run before merging into main: start a fresh headless dev Zen,
# create a space and pages, goto a local page, evaluate, check that the
# user's view didn't change, stop.
#
#   scripts/test-smoke.sh            instance "smoke-<checkout suffix>"
#   ZENIUS_SMOKE_INSTANCE=x scripts/test-smoke.sh
#   ZENIUS_FRESH=1 scripts/test-smoke.sh   start from an empty profile on the Mac too
#
# The profile is prepared with `zen-dev.sh <name> fresh`: removed on Linux,
# kept between runs on the Mac, where Zen's first start on a new profile
# relaunches itself and takes about 13 s.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[[ -d $HOME/opt/node-v24.22.2-linux-x64/bin ]] && export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH
# One instance per checkout, so workers sharing a machine don't collide.
suffix=$(basename "$ROOT" | sed 's/^zenius-\{0,1\}//' | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')
NAME=${ZENIUS_SMOKE_INSTANCE:-smoke-${suffix:-main}}
DEV="$ROOT/scripts/zen-dev.sh"

ZENIUS_FRESH=${ZENIUS_FRESH:-${ZENIUS_SMOKE_FRESH:-}} "$DEV" "$NAME" fresh >/dev/null
trap '"$DEV" "$NAME" stop >/dev/null || true' EXIT
# Time with node: macOS's date has no %N and its bash 3.2 no EPOCHREALTIME.
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
t0=$(now_ms)
"$DEV" "$NAME" start
echo "  startup              $(( $(now_ms) - t0 )) ms"
node "$ROOT/scripts/smoke.mjs" --instance "$NAME"
