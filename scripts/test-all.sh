#!/usr/bin/env bash
# Every headless suite that guards main: the smoke test, each component's
# tests/<area>/run.sh, and the SDK's unit and integration tests. Run it
# before merging into main. zen-eval's e2e and bench suites aren't included;
# they compare targets and take longer.
#
#   scripts/test-all.sh            all suites; exits non-zero if any fails
#   scripts/test-all.sh smoke ux   only the named suites (smoke, <area>, sdk-unit, sdk-it)
#
# Each suite starts its own fresh dev instance named after this checkout, so
# workers sharing a machine don't collide. On Linux the suites run in
# parallel: a run then takes about as long as the longest suite instead of the
# sum, and main moves less while a merge check runs. ZENIUS_SERIAL=1 runs them
# one after another, which is the default on the Mac (the user's laptop).
# Logs go to $TMPDIR/zenius-test-all/.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[[ -d $HOME/opt/node-v24.22.2-linux-x64/bin ]] && export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH
suffix=$(basename "$ROOT" | sed 's/^zenius-\{0,1\}//' | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')
LOGS=${TMPDIR:-/tmp}/zenius-test-all/${suffix:-main}
# Owner-only, both levels: on a shared machine, /tmp is open to every account.
(umask 077; mkdir -p "$LOGS")
cd "$ROOT"

serial=${ZENIUS_SERIAL:-}
[[ -z $serial && $(uname) == Darwin ]] && serial=1

wanted() { ((${#ONLY[@]} == 0)) && return 0; local s; for s in "${ONLY[@]}"; do [[ $s == "$1" ]] && return 0; done; return 1; }
ONLY=("$@")
now() { node -e 'console.log(Date.now())'; }

suite() {
  case $1 in
    smoke) scripts/test-smoke.sh ;;
    sdk-unit) (cd sdk && npm test --silent) ;;
    sdk-it) ZENIUS_IT_INSTANCE="sdk-it-${suffix:-main}" sdk/scripts/test-integration.sh ;;
    *) "tests/$1/run.sh" ;;
  esac
}
# Runs one suite and leaves "PASS|FAIL <ms>" in its .result file.
lane() {
  local t0; t0=$(now)
  if suite "$1" >"$LOGS/$1.log" 2>&1; then echo "PASS $(($(now) - t0))" >"$LOGS/$1.result"
  else echo "FAIL $(($(now) - t0))" >"$LOGS/$1.result"; fi
}

names=()
wanted smoke && names+=(smoke)
for dir in tests/*/; do
  area=$(basename "$dir")
  # live runs agents against public sites (zen-eval's harness): never here.
  # mac is zen-eval's Mac-only suite (tests/mac/README.md), run on the Mac
  # against a checkout with the agent's sidebar: not here either.
  case $area in fixtures | golden | e2e | bench | live | mac) continue ;; esac
  [[ -x $dir/run.sh ]] && wanted "$area" && names+=("$area")
done
sdk=()
failed=()
if [[ -d sdk/node_modules/esbuild ]]; then
  wanted sdk-unit && sdk+=(sdk-unit)
  wanted sdk-it && sdk+=(sdk-it)
elif [[ ${ZENIUS_SKIP_SDK:-} == 1 ]]; then
  wanted sdk-unit && echo "SKIP sdk-unit: ZENIUS_SKIP_SDK=1"
  wanted sdk-it && echo "SKIP sdk-it: ZENIUS_SKIP_SDK=1"
elif wanted sdk-unit || wanted sdk-it; then
  # The SDK's contract suite is the API-level check of every runtime method,
  # so a merge check without it isn't one.
  echo "FAIL sdk: no sdk/node_modules. Run 'npm ci' in sdk/ once (36 MB), or set ZENIUS_SKIP_SDK=1 for a partial run that isn't a merge check."
  failed+=(sdk)
fi

for name in ${names[@]+"${names[@]}"} ${sdk[@]+"${sdk[@]}"}; do rm -f "$LOGS/$name.result"; done
t0=$(now)
if [[ -n $serial ]]; then
  for name in ${names[@]+"${names[@]}"} ${sdk[@]+"${sdk[@]}"}; do lane "$name"; done
else
  for name in ${names[@]+"${names[@]}"}; do lane "$name" & done
  # sdk-unit and sdk-it both rebuild sdk/dist, so they share one lane.
  if ((${#sdk[@]})); then (for name in "${sdk[@]}"; do lane "$name"; done) & fi
  wait
fi

for name in ${names[@]+"${names[@]}"} ${sdk[@]+"${sdk[@]}"}; do
  result=$(cat "$LOGS/$name.result" 2>/dev/null || echo "FAIL ?")
  if [[ $result == PASS* ]]; then
    echo "PASS $name (${result#PASS } ms)"
  else
    echo "FAIL $name, log $LOGS/$name.log:"
    tail -20 "$LOGS/$name.log" | sed 's/^/    /'
    failed+=("$name")
  fi
done
mode=$([[ -n $serial ]] && echo serial || echo parallel)
if ((${#failed[@]})); then
  echo "test-all: ${#failed[@]} failed: ${failed[*]} ($mode, $(( ($(now) - t0) / 1000 )) s)"
  exit 1
fi
echo "test-all: ok ($mode, $(( ($(now) - t0) / 1000 )) s)"
