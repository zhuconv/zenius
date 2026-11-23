#!/usr/bin/env bash
# The e2e suite on zenius: Ego Lite's real-browser cases as ported
# (tests/e2e/cases) and zenius's own (tests/e2e/zen-cases), against a fresh
# headless dev Zen. It passes when every case that runs passes.
#
# manifest.mjs keeps out the cases that don't run on zenius, each with its
# reason: N/A (a CDP- or Chromium-only surface, or Ego's legacy helpers), or
# a deliberate difference (zenius refuses what the case tests, such as a
# task's service worker, and a case in zen-cases checks the refusal). A case
# the manifest doesn't list runs, and has to pass.
#
#   tests/e2e/run.sh                      instance "e2e-<checkout suffix>"
#   tests/e2e/run.sh --only "name,name"   just those cases (the runner's options pass through)
#   ZENIUS_E2E_TIMEOUT=<s>                the run's limit (default 900; a run takes about 120)
#
# It needs sdk/node_modules ('npm ci' in sdk/), as the SDK suites do. The
# results file goes to a private temporary folder, which stays, and is
# named, only when cases ran and the suite failed.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
[[ -d $HOME/opt/node-v24.22.2-linux-x64/bin ]] && export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH
suffix=$(basename "$ROOT" | sed 's/^zenius-\{0,1\}//' | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')
NAME=${ZENIUS_E2E_INSTANCE:-e2e-${suffix:-main}}
DEV="$ROOT/scripts/zen-dev.sh"
LIMIT=${ZENIUS_E2E_TIMEOUT:-900}

if [[ ! -d $ROOT/sdk/node_modules/esbuild ]]; then
  if [[ ${ZENIUS_SKIP_SDK:-} == 1 ]]; then echo "SKIP e2e: no sdk/node_modules to build the CLI (ZENIUS_SKIP_SDK=1)"; exit 0; fi
  echo "tests/e2e/run.sh: building the CLI needs sdk/node_modules: run npm ci in $ROOT/sdk" >&2
  exit 1
fi

TMP=${TMPDIR:-/tmp}
WORK=$(mktemp -d "${TMP%/}/zenius-e2e.XXXXXX")
run=; watchdog=
cleanup() {
  # Nothing here may end the cleanup early (set -e), or Zen stays open.
  set +e
  if [[ -n $watchdog ]]; then pkill -P "$watchdog"; kill "$watchdog"; fi 2>/dev/null
  if [[ -n $run ]]; then pkill -P "$run"; kill "$run"; fi 2>/dev/null
  "$DEV" "$NAME" stop >/dev/null 2>&1
  # A failed run's results stay; the CLI copy, and a folder with no results, go.
  rm -rf -- "$WORK/cli"
  [[ -s $WORK/results.json ]] || rm -rf -- "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# tests/lib/targets.mjs splits ZENIUS_CLI at spaces.
case $WORK in *" "*)
  echo "tests/e2e/run.sh: the temporary folder's path has a space; set TMPDIR to one without" >&2
  exit 2 ;;
esac
# The watchdog does nothing once its sleep is killed (&&), and keeps its own
# stderr quiet; its message goes to ours (fd 3).
exec 3>&2
(sleep "$LIMIT" && echo "tests/e2e/run.sh: no result after ${LIMIT}s; stopping $NAME" >&3 && kill $$) 2>/dev/null &
watchdog=$!

# The cases run a private copy of the CLI, with its own bundle built now. In
# scripts/test-all.sh's parallel run, the SDK suites delete and rebuild
# sdk/dist while this one runs, and a case that started the checkout's
# launcher then could load no bundle or half of one. A launcher with no
# sources beside it always runs its bundle (sdk/bin/zenius), and it runs
# under the Node the runner would pick for the checkout's.
mkdir -p "$WORK/cli/bin"
cp "$ROOT/sdk/bin/zenius" "$WORK/cli/bin/zenius"
(cd "$ROOT/sdk" && ZENIUS_BUILD_DIST="$WORK/cli/dist" node build.mjs >/dev/null)
NODE=$(node -e 'import(process.argv[1]).then(m => process.stdout.write(m.zeniusNode()))' "$ROOT/tests/lib/targets.mjs")
export ZENIUS_CLI="$NODE $WORK/cli/bin/zenius"

# fresh: a new profile on Linux; on the Mac the profile stays unless
# ZENIUS_FRESH=1, as for the other suites.
"$DEV" "$NAME" fresh >/dev/null
"$DEV" "$NAME" start
# In the background, so the watchdog's TERM ends the wait at once.
node "$ROOT/tests/e2e/runner.mjs" --target zenius --instance "$NAME" --results "$WORK/results.json" ${1+"$@"} &
run=$!
status=0
wait "$run" || status=$?
run=
if ((status == 0)); then
  rm -rf -- "$WORK"
  exit 0
fi
if [[ -s $WORK/results.json ]]; then
  echo "e2e: FAIL; the results are in $WORK/results.json" >&2
else
  echo "e2e: FAIL before any result was written; the runner's output above says why" >&2
fi
exit 1
