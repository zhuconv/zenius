#!/usr/bin/env bash
# The snapshot layer's runtime tests: start a headless dev Zen (fresh profile on Linux), run
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

# The dev Zen's zenius home: the caller's (test-all gives each lane one), or
# one of this run's own, which every way out removes once Zen has stopped.
. "$ROOT/tests/lib/scratch-home.sh"
own_zenius_home snapshot || exit 2
trap drop_own_zenius_home EXIT

# fresh: a new profile on Linux; on the Mac the profile stays unless
# ZENIUS_FRESH=1 (new profiles there trigger Zen's refused xattr calls).
"$DEV" "$NAME" fresh >/dev/null
trap '"$DEV" "$NAME" stop >/dev/null || true; drop_own_zenius_home' EXIT
"$DEV" "$NAME" start
if (($#)); then files=("$@"); else files=("$ROOT"/tests/snapshot/*.test.mjs); fi
ZENIUS_INSTANCE=$NAME node --test --test-concurrency=1 "${files[@]}"
