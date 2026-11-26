#!/usr/bin/env bash
# The I1/I4 sweep in a fresh headless dev Zen (see sweep.mjs).
#   tests/observe/vectors/run.sh [vector …]
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
[[ -d $HOME/opt/node-v24.22.2-linux-x64/bin ]] && export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH
NAME=${ZENIUS_SWEEP_INSTANCE:-sweep-zen-observe}
DEV="$ROOT/scripts/zen-dev.sh"

# The dev Zen's zenius home: the caller's (test-all gives each lane one), or
# one of this run's own, which every way out removes once Zen has stopped.
. "$ROOT/tests/lib/scratch-home.sh"
own_zenius_home vectors || exit 2
trap drop_own_zenius_home EXIT
# Every exit stops Zen, and a hung sweep is stopped at its limit (seconds), so
# a visible window can't stay open.
LIMIT=${ZENIUS_SWEEP_TIMEOUT:-1500}
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
if [[ ${ZENIUS_OBSERVE_HEADED:-} == 1 ]]; then "$DEV" "$NAME" start --headed; else "$DEV" "$NAME" start; fi
ZENIUS_INSTANCE=$NAME node "$ROOT/tests/observe/vectors/sweep.mjs" "$@" &
run=$!
# The watchdog does nothing once its sleep is killed (&&), and keeps its own
# stderr quiet ("Terminated"); its message goes to ours (fd 3).
exec 3>&2
(sleep "$LIMIT" && echo "sweep: no result after ${LIMIT}s; stopping $NAME" >&3 && kill "$run") 2>/dev/null &
watchdog=$!
status=0
wait "$run" || status=$?
run=
exit "$status"
