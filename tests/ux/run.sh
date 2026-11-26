#!/usr/bin/env bash
# The UI runtime tests: start a headless dev Zen, run tests/ux/*.test.mjs
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
#
# Each run has a zenius home and a working folder of its own, in a scratch
# home that it removes at the end (tests/lib/scratch-home.sh). The dev Zen
# keeps its sockets, records and self-check in that zenius home and its
# downloads in that folder, its sidebar's agents and their zenius servers
# take both from Zen, and every run of the CLI here gets a scratch HOME too.
# So nothing reaches the account's own ~/.zenius or working folder: on a Mac
# this suite runs beside the user's daily Zen.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# Node 24 first, where it's there: the Linux server's, and the Mac's Homebrew one (a
# Mac's own node 23.5 couldn't run the CLI's sources).
[[ -d $HOME/opt/node-v24.22.2-linux-x64/bin ]] && export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH
[[ -d /opt/homebrew/opt/node@24/bin ]] && export PATH=/opt/homebrew/opt/node@24/bin:$PATH
suffix=$(basename "$ROOT" | sed 's/^zenius-\{0,1\}//' | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')
NAME=${ZENIUS_UX_INSTANCE:-uxtest-${suffix:-main}}
DEV="$ROOT/scripts/zen-dev.sh"
# The agent's scripts (the sidebar and '>') load in this suite's Zen:
# tests/ux/sidebar.test.mjs drives them, with the mock's agents only.
export ZENIUS_AGENT_SCRIPTS=1

# The run's scratch home (above). The dev Zen's sockets are in it, and a
# Unix socket's path must fit in 104 bytes on macOS, where TMPDIR alone takes
# about 49: there it's in /tmp.
. "$ROOT/tests/lib/scratch-home.sh"
scratch_parent=${TMPDIR:-/tmp}
[[ $(uname) == Darwin ]] && scratch_parent=/tmp
scratch_home ux "${scratch_parent%/}" || exit 2
# Every way out removes it. Signals exit through the EXIT trap too.
trap 'rm -rf -- "${SCRATCH_ROOT:?}"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
export ZENIUS_HOME=$SCRATCH_ZHOME ZENIUS_DEV_WORKING_DIR=$SCRATCH_FILES

# The checkout's CLI has to run, before any Zen starts. The mock agents'
# opens and the self-check's end-to-end test use it. A fresh worktree has no
# sdk/dist, and a Node that can't strip types can't run its sources: on a
# Mac that showed up as 165 failures, not as one line.
if ! cli_err=$(HOME=$SCRATCH_HOME node "$ROOT/sdk/bin/zenius" --version 2>&1 >/dev/null); then
  echo "tests/ux: the checkout's CLI doesn't run on $(command -v node) ($(node --version 2>/dev/null)):" >&2
  echo "$cli_err" >&2
  exit 2
fi

if [[ ${ZENIUS_UX_FRESH:-} == 1 || $(uname) != Darwin ]]; then
  "$DEV" "$NAME" reset >/dev/null
else
  "$DEV" "$NAME" stop >/dev/null
fi
# Every way out stops Zen, which closes its window in a headed run, and
# then removes the scratch home.
trap '"$DEV" "$NAME" stop >/dev/null || true; rm -rf -- "${SCRATCH_ROOT:?}"' EXIT
if [[ ${ZENIUS_UX_HEADED:-} == 1 ]]; then
  "$DEV" "$NAME" start --headed
else
  "$DEV" "$NAME" start
fi
if (($#)); then files=("$@"); else files=("$ROOT"/tests/ux/*.test.mjs); fi
# A hung run mustn't keep Zen open: stop the tests after ZENIUS_UX_TIMEOUT seconds
# (default 900). The whole suite took 596 s on the Linux server beside a test-all run
# (with the self-check's tests), so 600 left no room.
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
