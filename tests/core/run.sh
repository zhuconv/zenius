#!/usr/bin/env bash
# zen-core runtime tests: start a headless dev Zen (a fresh profile, except
# on the Mac: see zen-dev.sh fresh), run
# tests/core/*.test.mjs against it, stop it. A full run also runs the I4
# guard, tests/core/i4/guard.test.mjs, beside them.
#
#   tests/core/run.sh                       instance "coretest-<checkout suffix>"
#   tests/core/run.sh tests/core/pages.test.mjs
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
[[ -d $HOME/opt/node-v24.22.2-linux-x64/bin ]] && export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH
suffix=$(basename "$ROOT" | sed 's/^zenius-\{0,1\}//' | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')
NAME=${ZENIUS_CORE_INSTANCE:-coretest-${suffix:-main}}
DEV="$ROOT/scripts/zen-dev.sh"

# The dev Zen's zenius home: the caller's (test-all gives each lane one), or
# one of this run's own, which every way out removes once Zen has stopped.
. "$ROOT/tests/lib/scratch-home.sh"
own_zenius_home core || exit 2
trap drop_own_zenius_home EXIT

"$DEV" "$NAME" fresh >/dev/null
trap '"$DEV" "$NAME" stop >/dev/null || true; drop_own_zenius_home' EXIT
"$DEV" "$NAME" start
# The I4 guard (tests/core/i4/guard.test.mjs) starts Zens of its own and
# never uses this instance, so a full run starts it beside the other files
# (Linux only: the I4 tool reads /proc). It takes about 2 min, and up to
# about 6 when a loaded machine makes it run an arm twice.
guard=
guard_log=
if ((! $#)) && [[ $(uname) == Linux ]]; then
  guard_log=$(mktemp)
  node --test --test-timeout=500000 "$ROOT/tests/core/i4/guard.test.mjs" >"$guard_log" 2>&1 &
  guard=$!
fi
if (($#)); then files=("$@"); else files=("$ROOT"/tests/core/*.test.mjs); fi
# A hung test fails after 3 min, so the EXIT trap still stops Zen.
status=0
ZENIUS_INSTANCE=$NAME ZENIUS_DEV="$DEV" node --test --test-concurrency=1 --test-timeout=180000 "${files[@]}" || status=$?
if [[ -n $guard ]]; then
  guard_status=0
  wait "$guard" || guard_status=$?
  echo "--- the I4 guard, tests/core/i4/guard.test.mjs (exit $guard_status) ---"
  cat "$guard_log"
  rm -f "$guard_log"
  ((guard_status == 0)) || status=1
fi
exit "$status"
