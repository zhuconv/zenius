#!/usr/bin/env bash
# zen-input runtime tests: start a fresh headless dev Zen, run
# tests/input/*.test.mjs against it (Ego's Page API e2e cases plus zenius's
# own checks), stop it.
#
#   tests/input/run.sh                       instance "inputtest-<checkout suffix>"
#   tests/input/run.sh tests/input/ego.test.mjs
#   ZENIUS_INPUT_HEADED=1 tests/input/run.sh   a visible Zen; on the Mac only
#                                              tests/input/mac/ unless files are named
#
# With no files named and no visible Zen, tests/input/keyring.sh then runs
# the saved-card test on a Zen with a private keyring (Linux only).
#
# A visible Zen on the Mac shares the user's pasteboard. Only
# tests/input/system-clipboard.mjs may touch the system clipboard (on the Mac
# it only reads the change count), so this refuses to run while any other
# file in the suite, or a named file, uses a clipboard API.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
[[ -d $HOME/opt/node-v24.22.2-linux-x64/bin ]] && export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH
suffix=$(basename "$ROOT" | sed 's/^zenius-\{0,1\}//' | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')
NAME=${ZENIUS_INPUT_INSTANCE:-inputtest-${suffix:-main}}
DEV="$ROOT/scripts/zen-dev.sh"

# The dev Zen's zenius home: the caller's (test-all gives each lane one), or
# one of this run's own, which every way out removes once Zen has stopped.
. "$ROOT/tests/lib/scratch-home.sh"
own_zenius_home input || exit 2
trap drop_own_zenius_home EXIT

# Options (--test-name-pattern=…) go to node only: the file checks below
# read paths.
opts=()
paths=()
for a in "$@"; do
  if [[ $a == -* ]]; then opts+=("$a"); else paths+=("$a"); fi
done
if ((${#paths[@]})); then
  files=("${paths[@]}")
elif [[ ${ZENIUS_INPUT_HEADED:-} == 1 && $(uname -s) == Darwin ]]; then
  files=("$ROOT"/tests/input/mac/*.test.mjs)
  echo "tests/input/run.sh: a visible Zen on the Mac runs only tests/input/mac/ unless you name files" >&2
else
  files=("$ROOT"/tests/input/*.test.mjs)
fi
CLIPBOARD_API='Services\.clipboard|nsIClipboard|widget/clipboard|clipboardhelper|navigator\.clipboard|NSPasteboard|pbcopy|pbpaste|osascript'
rc=0
found=$(grep -rlE -e "$CLIPBOARD_API" --include='*.mjs' -- "$ROOT/tests/input" "${files[@]}") || rc=$?
if ((rc > 1)); then
  echo "tests/input/run.sh: the system-clipboard check couldn't read the tests (grep exit $rc)" >&2
  exit 1
fi
touching=$(printf '%s\n' "$found" | grep -vE '(^|/)tests/input/system-clipboard\.mjs$' | sed '/^$/d' | sort -u || true)
if [[ -n $touching ]]; then
  echo "tests/input/run.sh: only tests/input/system-clipboard.mjs may touch the system clipboard, and these do:" >&2
  echo "$touching" >&2
  exit 1
fi

# fresh: a new profile on Linux; on the Mac the profile is kept (new Mac
# profiles trigger refused xattr calls).
"$DEV" "$NAME" fresh >/dev/null
trap '"$DEV" "$NAME" stop >/dev/null || true; drop_own_zenius_home' EXIT
if [[ ${ZENIUS_INPUT_HEADED:-} == 1 ]]; then
  "$DEV" "$NAME" start --headed
else
  "$DEV" "$NAME" start
fi
status=0
ZENIUS_INSTANCE=$NAME node --test --test-concurrency=1 ${opts[@]+"${opts[@]}"} "${files[@]}" || status=$?
if ((!$#)) && [[ ${ZENIUS_INPUT_HEADED:-} != 1 ]]; then
  "$DEV" "$NAME" stop >/dev/null || true
  "$ROOT/tests/input/keyring.sh" || status=$?
fi
exit "$status"
