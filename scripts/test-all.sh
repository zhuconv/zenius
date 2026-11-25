#!/usr/bin/env bash
# Every headless suite that guards main: the smoke test, each component's
# tests/<area>/run.sh (the ported e2e suite's among them), and the SDK's unit
# and integration tests. Run it before merging into main. The bench suite
# isn't included: it compares targets and takes longer.
#
#   scripts/test-all.sh            all suites; exits non-zero if any fails
#   scripts/test-all.sh smoke ux   only the named suites (smoke, <area>, sdk-unit, sdk-it)
#
# Each suite starts its own fresh dev instance named after this checkout, so
# workers sharing a machine don't collide. On Linux the suites run in
# parallel: a run then takes about as long as the longest suite instead of the
# sum, and main moves less while a merge check runs. ZENIUS_SERIAL=1 runs them
# one after another, which is the default on the Mac (the user's laptop).
# Logs go to $TMPDIR/zenius-test-all/. On Linux each suite also gets a
# temporary folder of its own (see "lane" below). A failed suite's summary
# lists every test its log names as failed, then the log's last 20 lines.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[[ -d $HOME/opt/node-v24.22.2-linux-x64/bin ]] && export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH
suffix=$(basename "$ROOT" | sed 's/^zenius-\{0,1\}//' | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')
# On Linux each suite's temporary folder sits right in TMPDIR (see "lane"
# below), and a test's Unix socket path inside it must fit in 108 bytes. The
# deepest, the input lane's keyring control socket, ends 61 bytes below
# TMPDIR. A longer TMPDIR, such as a tool's scratch folder, fails the
# socket tests in ways that don't name it, so it stops the run here, before
# anything is written there.
TMPDIR_MAX=40
if [[ $(uname) == Linux ]]; then
  base=${TMPDIR:-/tmp}
  base=${base%/}
  # Bytes, as the socket limit counts them: in a UTF-8 locale ${#base}
  # counts characters.
  bytes=$(printf '%s' "$base" | LC_ALL=C wc -c)
  if ((bytes > TMPDIR_MAX)); then
    echo "test-all: TMPDIR is $((bytes)) bytes long, too long for the tests' Unix sockets (108 bytes). Use one of at most $TMPDIR_MAX bytes, or unset it for /tmp." >&2
    exit 1
  fi
fi
LOGS=${TMPDIR:-/tmp}/zenius-test-all/${suffix:-main}
# Owner-only, both levels: on a shared machine, /tmp is open to every account.
# A level that another account made first (after /tmp was emptied) is
# refused, not used: its owner could swap what's inside.
(umask 077; mkdir -p "$LOGS")
for level in "${LOGS%/*}" "$LOGS"; do
  if [[ -L $level || ! -d $level || ! -O $level ]]; then
    echo "test-all: $level isn't a folder of this account's own. Remove it, or set TMPDIR to a private folder." >&2
    exit 1
  fi
  chmod 700 "$level"
done
# A developer's gh may be signed in, with a token that can post wherever they
# can. No suite reaches GitHub (a test that needs gh uses a fake), so every
# lane runs with an empty gh config and a placeholder token: gh takes GH_TOKEN
# before its config and the system keyring, and GitHub refuses it, so a gh
# call that a test didn't fake fails instead of posting.
(umask 077; mkdir -p "$LOGS/gh-config")
export GH_CONFIG_DIR=$LOGS/gh-config GH_PROMPT_DISABLED=1
export GH_TOKEN=zenius-test-all-signed-out GH_ENTERPRISE_TOKEN=zenius-test-all-signed-out
unset GITHUB_TOKEN GITHUB_ENTERPRISE_TOKEN
# On Linux, where /tmp is open to every account, each suite runs with a
# temporary folder of its own (TMPDIR), which mktemp makes right in the base
# temporary folder: owner-only, kept from other accounts by /tmp's sticky
# bit, and short whatever the checkout's name, since a test's Unix socket
# path inside it must fit in 108 bytes. Its name, zt-<suite>-XXXXXX, has no
# dot: with one, a random part of only letters reads as a host and path to
# zenius feedback's cleaning (zt-sdk-unit.qtZmxi/...), which turns a
# feedback test's home folder into <link>. A passing suite's folder goes when
# the suite ends, with whatever it left there: what a test killed before its
# after hooks couldn't remove, or an install test's folders. The summary says
# how much that was, the by-design caches aside, so a leak shows. A failing
# suite's folder stays for a look (the e2e runner keeps a failed run's
# results there) until that suite's next run; $LOGS/<suite>.tmpdir names it.
# The Mac keeps its per-user temporary folder: no other account can read it,
# and it's the one Zen's content sandbox there allows.
TMPBASE=
if [[ $(uname) == Linux ]]; then
  TMPBASE=${TMPDIR:-/tmp}
  TMPBASE=${TMPBASE%/}
fi
cd "$ROOT"

serial=${ZENIUS_SERIAL:-}
[[ -z $serial && $(uname) == Darwin ]] && serial=1

wanted() { ((${#ONLY[@]} == 0)) && return 0; local s; for s in "${ONLY[@]}"; do [[ $s == "$1" ]] && return 0; done; return 1; }
ONLY=("$@")
now() { node -e 'console.log(Date.now())'; }
entries() { if (($1 == 1)); then echo "1 entry"; else echo "$1 entries"; fi; }

suite() {
  case $1 in
    smoke) scripts/test-smoke.sh ;;
    sdk-unit) (cd sdk && npm test --silent) ;;
    sdk-it) ZENIUS_IT_INSTANCE="sdk-it-${suffix:-main}" sdk/scripts/test-integration.sh ;;
    *) "tests/$1/run.sh" ;;
  esac
}
# Runs one suite and leaves "PASS|FAIL <ms> <entries left in its temporary
# folder>" in its .result file.
lane() {
  local t0 tmp= kept entry verdict=FAIL left=0; local -a leftovers=(); t0=$(now)
  if [[ -n $TMPBASE ]]; then
    # The folder a failing run of this suite kept: removed only if its path
    # is exactly one that mktemp makes for this suite (no "..", nothing
    # after it), and it's a folder of this account's, not a link.
    if [[ -f $LOGS/$1.tmpdir ]]; then
      kept=$(<"$LOGS/$1.tmpdir")
      if [[ $kept =~ ^"$TMPBASE/zt-$1-"[A-Za-z0-9]{6}$ && -d $kept && ! -L $kept && -O $kept ]]; then rm -rf -- "$kept"; fi
      rm -f -- "$LOGS/$1.tmpdir"
    fi
    if ! tmp=$(mktemp -d "$TMPBASE/zt-$1-XXXXXX" 2>"$LOGS/$1.log"); then echo "FAIL 0 0" >"$LOGS/$1.result"; return; fi
    echo "$tmp" >"$LOGS/$1.tmpdir"
  fi
  # A subshell, so that a serial run's next suite doesn't inherit the folder.
  if (if [[ -n $tmp ]]; then export TMPDIR=$tmp; fi; suite "$1") >"$LOGS/$1.log" 2>&1; then verdict=PASS; fi
  if [[ -n $tmp ]]; then
    # The CLI's compile cache (Node's own folder, from a CLI before 0.1.4),
    # the sandboxed CLI's own folder, and a dev Zen's working folders are
    # made there by design. Anything else is a suite's leftover.
    while IFS= read -r entry; do
      case $entry in zenius-compile-cache-* | node-compile-cache | zenius-sandbox-* | zenius-dev-*) ;; *) leftovers+=("$entry") ;; esac
    done < <(ls -A "$tmp" 2>/dev/null)
    left=${#leftovers[@]}
    if ((left)); then
      { echo "test-all: the suite left $(entries "$left") in its temporary folder:"; printf '  %s\n' "${leftovers[@]:0:20}"; } >>"$LOGS/$1.log"
    fi
    if [[ $verdict == PASS ]]; then rm -rf -- "$tmp" && rm -f -- "$LOGS/$1.tmpdir"; fi
  fi
  echo "$verdict $(($(now) - t0)) $left" >"$LOGS/$1.result"
}

names=()
wanted smoke && names+=(smoke)
for dir in tests/*/; do
  area=$(basename "$dir")
  # live runs agents against public sites (zen-eval's harness): never here.
  # mac is zen-eval's Mac-only suite (tests/mac/README.md), run on the Mac
  # against a checkout with the agent's sidebar: not here either.
  case $area in fixtures | golden | bench | live | mac) continue ;; esac
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
  verdict=FAIL ms='?' left=0
  read -r verdict ms left 2>/dev/null <"$LOGS/$name.result"
  if [[ $verdict == PASS ]]; then
    note=
    ((${left:-0} > 0)) && note="; it left $(entries "$left") in its temporary folder, listed at the end of its log"
    echo "PASS $name ($ms ms$note)"
  else
    note= kept=
    [[ -n $TMPBASE && -f $LOGS/$name.tmpdir ]] && kept=$(<"$LOGS/$name.tmpdir")
    [[ -n $kept && -d $kept ]] && note="; its temporary folder stays at $kept"
    echo "FAIL $name, log $LOGS/$name.log$note:"
    # Every test its log names as failed, then the log's last lines: a
    # second failure in a suite mustn't hide behind the one its tail shows,
    # such as a known flake's (scripts/lib/test-all-failures.mjs).
    list=$(node "$ROOT/scripts/lib/test-all-failures.mjs" "$LOGS/$name.log" 2>/dev/null)
    if [[ -n $list ]]; then
      printf '%s\n' "$list" | sed 's/^/    /'
      echo "    The log ends:"
    fi
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
