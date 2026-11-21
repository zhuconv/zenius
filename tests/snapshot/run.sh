#!/usr/bin/env bash
# zen-snapshot runtime tests: start a headless dev Zen (fresh profile on Linux), run
# tests/snapshot/*.test.mjs against it, stop it.
#
#   tests/snapshot/run.sh                         instance "snaptest-<checkout suffix>"
#   tests/snapshot/run.sh tests/snapshot/aria.test.mjs
#
# To iterate against a running instance instead:
#   ZENIUS_INSTANCE=zen-snapshot node --test tests/snapshot/aria.test.mjs
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
[[ -d $HOME/opt/node-v24.22.2-linux-x64/bin ]] && export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH
suffix=$(basename "$ROOT" | sed 's/^zenius-\{0,1\}//' | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')
NAME=${ZENIUS_SNAPSHOT_INSTANCE:-snaptest-${suffix:-main}}
DEV="$ROOT/scripts/zen-dev.sh"

# fresh: a new profile on Linux; on the Mac the profile stays unless
# ZENIUS_FRESH=1 (new profiles there trigger Zen's refused xattr calls).
"$DEV" "$NAME" fresh >/dev/null
trap '"$DEV" "$NAME" stop >/dev/null || true' EXIT
"$DEV" "$NAME" start
if (($#)); then files=("$@"); else files=("$ROOT"/tests/snapshot/*.test.mjs); fi
ZENIUS_INSTANCE=$NAME node --test --test-concurrency=1 "${files[@]}"
