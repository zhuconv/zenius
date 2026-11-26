#!/usr/bin/env bash
# The observe layer's runtime tests: start a fresh headless dev Zen, run
# tests/observe/*.test.mjs against it through RPC, stop it.
#
#   tests/observe/run.sh                          instance "obstest-<checkout suffix>"
#   tests/observe/run.sh tests/observe/dialogs.test.mjs
#   ZENIUS_OBSERVE_HEADED=1 tests/observe/run.sh tests/observe/mac/mac.test.mjs   (the Mac checks)
#   ZENIUS_OBSERVE_TIMEOUT=<s>   the run's limit (default 900, headed 180)
#
# The boundary tests (surfaces, I5, caps, control) are their own suite,
# tests/observe-vectors, which runs through this script on another instance.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
[[ -d $HOME/opt/node-v24.22.2-linux-x64/bin ]] && export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH
suffix=$(basename "$ROOT" | sed 's/^zenius-\{0,1\}//' | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')
NAME=${ZENIUS_OBSERVE_INSTANCE:-obstest-${suffix:-main}}
DEV="$ROOT/scripts/zen-dev.sh"

# The dev Zen's zenius home: the caller's (test-all gives each lane one), or
# one of this run's own, which every way out removes once Zen has stopped.
. "$ROOT/tests/lib/scratch-home.sh"
. "$ROOT/tests/lib/node-test.sh"
own_zenius_home observe || exit 2
trap drop_own_zenius_home EXIT
# The agent's scripts (the sidebar and '>') load in this suite's Zen too:
# sidebarlimits.test.mjs and sidebarcli.test.mjs test the sidebar's limits.
export ZENIUS_AGENT_SCRIPTS=1

# A run that hangs must not keep Zen open, least of all a visible window on
# the user's Mac: the whole run gets a time limit (seconds), and every exit,
# including Ctrl-C and kill, stops Zen.
HEADED=${ZENIUS_OBSERVE_HEADED:-}
LIMIT=${ZENIUS_OBSERVE_TIMEOUT:-$([[ $HEADED == 1 ]] && echo 180 || echo 900)}

# fresh: a new profile on Linux; on the Mac the profile is kept (the core's
# convention: new Mac profiles trigger refused xattr calls).
"$DEV" "$NAME" fresh >/dev/null
run=; watchdog=
cleanup() {
  # Nothing here may end the cleanup early (set -e), or Zen stays open.
  set +e
  # Children first: the watchdog's sleep, and node's test processes.
  if [[ -n $watchdog ]]; then pkill -P "$watchdog"; kill "$watchdog"; fi 2>/dev/null
  if [[ -n $run ]]; then pkill -P "$run"; kill "$run"; fi 2>/dev/null
  "$DEV" "$NAME" stop >/dev/null
  drop_own_zenius_home
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ $HEADED == 1 ]]; then
  "$DEV" "$NAME" start --headed
else
  "$DEV" "$NAME" start
fi
if (($#)); then files=("$@"); else files=("$ROOT"/tests/observe/*.test.mjs); fi
ZENIUS_INSTANCE=$NAME node --test $(node_test_flags "$@") --test-concurrency=1 --test-timeout=120000 "${files[@]}" &
run=$!
# The watchdog does nothing once its sleep is killed (&&), and keeps its own
# stderr quiet ("Terminated"); its message goes to ours (fd 3).
exec 3>&2
(sleep "$LIMIT" && echo "tests/observe/run.sh: no result after ${LIMIT}s; stopping $NAME" >&3 && kill "$run") 2>/dev/null &
watchdog=$!
status=0
wait "$run" || status=$?
run=
exit "$status"
