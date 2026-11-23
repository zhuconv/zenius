#!/usr/bin/env bash
# zen-ux runtime tests: start a headless dev Zen, run tests/ux/*.test.mjs
# against it, stop it.
#
#   tests/ux/run.sh                     instance "uxtest-<checkout suffix>"
#   tests/ux/run.sh tests/ux/cursor.test.mjs
#   ZENIUS_UX_FRESH=1 tests/ux/run.sh   start from an empty profile
#   ZENIUS_UX_HEADED=1 tests/ux/run.sh  in a visible window (Mac checks)
#   ZENIUS_UX_TIMEOUT=900 (default)  stop a run that hangs, after that many seconds
#
# On Linux every run starts from an empty profile. On the Mac the profile is
# kept between runs, as in scripts/test-smoke.sh: a new profile makes Zen
# relaunch itself there. Each test removes the Spaces it created.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# Node 24 first, where it's there: the Linux server's, and the Mac's Homebrew one (the
# Mac's own node was 23.5 on 2026-11-22, and couldn't run the CLI's sources).
[[ -d $HOME/opt/node-v24.22.2-linux-x64/bin ]] && export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH
[[ -d /opt/homebrew/opt/node@24/bin ]] && export PATH=/opt/homebrew/opt/node@24/bin:$PATH
suffix=$(basename "$ROOT" | sed 's/^zenius-\{0,1\}//' | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')
NAME=${ZENIUS_UX_INSTANCE:-uxtest-${suffix:-main}}
DEV="$ROOT/scripts/zen-dev.sh"
# The agent's scripts (the sidebar and '>') load in this suite's Zen:
# tests/ux/sidebar.test.mjs drives them, with the mock's agents only.
export ZENIUS_AGENT_SCRIPTS=1

# The checkout's CLI has to run, before any Zen starts. The mock agents'
# opens and the self-check's end-to-end test use it. A fresh worktree has no
# sdk/dist, and a Node that can't strip types can't run its sources: on the
# night cut's Mac run that showed up as 165 failures, not as one line.
if ! cli_err=$(node "$ROOT/sdk/bin/zenius" --version 2>&1 >/dev/null); then
  echo "tests/ux: the checkout's CLI doesn't run on $(command -v node) ($(node --version 2>/dev/null)):" >&2
  echo "$cli_err" >&2
  exit 2
fi

if [[ ${ZENIUS_UX_FRESH:-} == 1 || $(uname) != Darwin ]]; then
  "$DEV" "$NAME" reset >/dev/null
else
  "$DEV" "$NAME" stop >/dev/null
fi
# Every way out stops Zen, which closes its window in a headed run. Signals
# exit through the EXIT trap too.
trap '"$DEV" "$NAME" stop >/dev/null || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
if [[ ${ZENIUS_UX_HEADED:-} == 1 ]]; then
  "$DEV" "$NAME" start --headed
else
  "$DEV" "$NAME" start
fi
if (($#)); then files=("$@"); else files=("$ROOT"/tests/ux/*.test.mjs); fi
# A hung run mustn't keep Zen open: stop the tests after ZENIUS_UX_TIMEOUT seconds
# (default 900). The whole suite took 596 s on the Linux server beside a test-all run
# (2026-11-22, with the self-check's tests), so 600 left no room.
limit=${ZENIUS_UX_TIMEOUT:-900}
ZENIUS_INSTANCE=$NAME node --test --test-concurrency=1 "${files[@]}" &
pid=$!
(
  waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if ((waited >= limit)); then
      echo "tests/ux: no result after $limit s; stopping the run" >&2
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
