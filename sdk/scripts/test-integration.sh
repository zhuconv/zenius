#!/usr/bin/env bash
# SDK integration tests against a headless dev Zen, with a fresh profile on
# Linux. On the Mac the profile is kept (a first start there relaunches Zen,
# and fresh profiles meet Zen's refused xattr calls) unless ZENIUS_FRESH=1.
#
#   sdk/scripts/test-integration.sh                 instance "sdk-it-<checkout suffix>"
#   ZENIUS_IT_INSTANCE=zen-sdk sdk/scripts/test-integration.sh --reuse
#                                                   use an instance that is already running
#
# One instance per checkout, so workers sharing a machine don't collide.
set -euo pipefail
SDK=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ROOT=$(cd "$SDK/.." && pwd)
[[ -d $HOME/opt/node-v24.22.2-linux-x64/bin ]] && export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH
suffix=$(basename "$ROOT" | sed 's/^zenius-\{0,1\}//' | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')
NAME=${ZENIUS_IT_INSTANCE:-sdk-it-${suffix:-main}}
DEV="$ROOT/scripts/zen-dev.sh"

if [[ ${1:-} != --reuse ]]; then
  "$DEV" "$NAME" fresh >/dev/null
  trap '"$DEV" "$NAME" stop >/dev/null || true' EXIT
  "$DEV" "$NAME" start
fi
(cd "$SDK" && node build.mjs)
node "$SDK/scripts/protocol-coverage.ts" --instance "$NAME" | head -1 || true
cd "$SDK"
ZENIUS_INSTANCE=$NAME node --test --test-concurrency=1 --test-reporter=spec "test/integration/*.it.ts"
