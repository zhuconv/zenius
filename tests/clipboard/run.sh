#!/usr/bin/env bash
# Space clipboard tests (the UI): start a headless dev Zen, run tests/clipboard/*.test.mjs
# against it, stop it.
#
#   tests/clipboard/run.sh                     instance "cliptest-<checkout suffix>"
#   tests/clipboard/run.sh tests/clipboard/clipboard.test.mjs
#   ZENIUS_CLIP_FRESH=1 tests/clipboard/run.sh   start from an empty profile
#   ZENIUS_CLIP_HEADED=1 tests/clipboard/run.sh  in a visible window (Mac checks)
#   ZENIUS_CLIP_TIMEOUT=600 (default)  stop a run that hangs, after that many seconds
#
# On Linux every run starts from an empty profile. On the Mac the profile is
# kept between runs, as in scripts/test-smoke.sh: a new profile makes Zen
# relaunch itself there. Each test removes the Spaces it created.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
[[ -d $HOME/opt/node-v24.22.2-linux-x64/bin ]] && export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH
suffix=$(basename "$ROOT" | sed 's/^zenius-\{0,1\}//' | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')
NAME=${ZENIUS_CLIP_INSTANCE:-cliptest-${suffix:-main}}
DEV="$ROOT/scripts/zen-dev.sh"

# The dev Zen's zenius home: the caller's (test-all gives each lane one), or
# one of this run's own, which every way out removes once Zen has stopped.
. "$ROOT/tests/lib/scratch-home.sh"
. "$ROOT/tests/lib/node-test.sh"
own_zenius_home clipboard || exit 2
trap drop_own_zenius_home EXIT

if [[ ${ZENIUS_CLIP_FRESH:-} == 1 || $(uname) != Darwin ]]; then
  "$DEV" "$NAME" reset >/dev/null
else
  "$DEV" "$NAME" stop >/dev/null
fi
# Every way out stops Zen, which closes its window in a headed run. Signals
# exit through the EXIT trap too.
trap '"$DEV" "$NAME" stop >/dev/null || true; drop_own_zenius_home' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
if [[ ${ZENIUS_CLIP_HEADED:-} == 1 ]]; then
  "$DEV" "$NAME" start --headed
else
  "$DEV" "$NAME" start
fi
if (($#)); then files=("$@"); else files=("$ROOT"/tests/clipboard/*.test.mjs); fi
# A hung run mustn't keep Zen open: stop the tests after ZENIUS_CLIP_TIMEOUT seconds
# (default 600; the suite takes about a minute).
limit=${ZENIUS_CLIP_TIMEOUT:-600}
ZENIUS_INSTANCE=$NAME node --test $(node_test_flags "$@") --test-concurrency=1 "${files[@]}" &
pid=$!
(
  waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if ((waited >= limit)); then
      echo "tests/clipboard: no result after $limit s; stopping the run" >&2
      kill -TERM "$pid" 2>/dev/null
      exit 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
) &
watchdog=$!
status=0
wait "$pid" || status=$?
kill "$watchdog" 2>/dev/null || true
exit "$status"
