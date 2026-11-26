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
#
# The dev Zen gets a working folder of this run's own (ZENIUS_DEV_WORKING_DIR,
# removed at the end), and the tests' CLI and launcher runs get a scratch
# HOME and ZENIUS_HOME whose config names it (test/integration/scratch-env.ts):
# nothing reaches the user's own ~/.zenius/config.json or ~/zenius-files. A
# reused instance keeps the folder it was started with, which
# `zen-dev.sh <name> work` names.
set -euo pipefail
SDK=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ROOT=$(cd "$SDK/.." && pwd)
[[ -d $HOME/opt/node-v24.22.2-linux-x64/bin ]] && export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH
suffix=$(basename "$ROOT" | sed 's/^zenius-\{0,1\}//' | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')
NAME=${ZENIUS_IT_INSTANCE:-sdk-it-${suffix:-main}}
DEV="$ROOT/scripts/zen-dev.sh"

if [[ ${1:-} != --reuse ]]; then
  TMP=${TMPDIR:-/tmp}
  WORKING=$(mktemp -d "${TMP%/}/zt-it-files-XXXXXX")
  # The dev Zen's zenius home: the caller's (test-all gives each lane one),
  # or one of this run's own, which every way out removes once Zen stops.
  . "$ROOT/tests/lib/scratch-home.sh"
  own_zenius_home sdk-it || exit 2
  trap '"$DEV" "$NAME" stop >/dev/null || true; rm -rf -- "$WORKING"; drop_own_zenius_home' EXIT
  "$DEV" "$NAME" fresh >/dev/null
  ZENIUS_DEV_WORKING_DIR=$WORKING "$DEV" "$NAME" start
else
  # The instance the caller started, in its zenius home; as own_zenius_home
  # does, nothing of the caller's may send the tests to another Zen. Its
  # ZENIUS_DEV_WORKING_DIR stays: it's where that instance's files land, as
  # `work` says.
  unset ZENIUS_WORKING_DIR ZENIUS_SOCKET ZENIUS_INSTANCE
  WORKING=$("$DEV" "$NAME" work)
fi
(cd "$SDK" && node build.mjs)
node "$SDK/scripts/protocol-coverage.ts" --instance "$NAME" | head -1 || true
cd "$SDK"
ZENIUS_INSTANCE=$NAME ZENIUS_IT_WORKING_DIR=$WORKING node --import ./test/integration/scratch-env.ts --test --test-concurrency=1 --test-reporter=spec "test/integration/*.it.ts"
