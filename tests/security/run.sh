#!/usr/bin/env bash
# The escape suite (SPEC §3.9 I5): nothing an agent's script does through
# zenius may get out through the browser. A fresh headless dev instance runs
# escape.test.mjs, where "the user" acts through the dev channel, then
# restarts without dev methods, as live runs start theirs, for dev-off.test.mjs
# and sandbox.test.mjs. The sandbox part is the canary of the launcher
# scripts/install-cli.sh --sandbox writes: it installs one from a copy of this
# checkout into the run's own folder, never ~/.local/bin or ~/.zenius/cli, and
# runs scripts through it.
#
#   tests/security/run.sh                 every part; instance "sectest-<checkout suffix>"
#   tests/security/run.sh escape          one part (escape, dev-off or sandbox)
#   ZENIUS_SECURITY_TIMEOUT=<s>           the run's limit (default 900)
#   ZENIUS_SECURITY_SOCKETS=<a>:<b>       more sockets the sandbox must not reach,
#                                         such as a machine's own agents'
#   ZENIUS_SECURITY_SOCKETS_FILE=<file>   adds one socket path per line (default
#                                         ~/.zenius-dev/security-sockets, kept
#                                         outside the repo; # starts a comment)
#
# Scripts run through a private build of this checkout's CLI, so the SDK
# suites rebuilding sdk/dist beside this one in scripts/test-all.sh can't
# change it mid-run.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
[[ -d $HOME/opt/node-v24.22.2-linux-x64/bin ]] && export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH
suffix=$(basename "$ROOT" | sed 's/^zenius-\{0,1\}//' | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')
NAME=${ZENIUS_SECURITY_INSTANCE:-sectest-${suffix:-main}}
DEV="$ROOT/scripts/zen-dev.sh"
LIMIT=${ZENIUS_SECURITY_TIMEOUT:-900}
if (($#)); then parts=("$@"); else parts=(escape dev-off sandbox); fi
# A machine's own sockets, listed outside the repo, join the ones it names.
list=${ZENIUS_SECURITY_SOCKETS_FILE:-$HOME/.zenius-dev/security-sockets}
if [[ -f $list ]]; then
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    ZENIUS_SECURITY_SOCKETS="${ZENIUS_SECURITY_SOCKETS:-}${ZENIUS_SECURITY_SOCKETS:+:}$line"
  done <"$list"
  export ZENIUS_SECURITY_SOCKETS
fi
for part in "${parts[@]}"; do
  [[ $part == escape || $part == dev-off || $part == sandbox ]] || { echo "tests/security/run.sh: no part $part (escape, dev-off, sandbox)" >&2; exit 2; }
done

if [[ ! -d $ROOT/sdk/node_modules/esbuild ]]; then
  if [[ ${ZENIUS_SKIP_SDK:-} == 1 ]]; then echo "SKIP security: no sdk/node_modules to build the CLI (ZENIUS_SKIP_SDK=1)"; exit 0; fi
  echo "tests/security/run.sh: building the CLI needs sdk/node_modules: run npm ci in $ROOT/sdk" >&2
  exit 1
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/zenius-security.XXXXXX")
run=; watchdog=
cleanup() {
  # Nothing here may end the cleanup early (set -e), or Zen stays open.
  set +e
  if [[ -n $watchdog ]]; then pkill -P "$watchdog"; kill "$watchdog"; fi 2>/dev/null
  if [[ -n $run ]]; then pkill -P "$run"; kill "$run"; fi 2>/dev/null
  "$DEV" "$NAME" stop >/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# The watchdog does nothing once its sleep is killed (&&), and keeps its own
# stderr quiet; its message goes to ours (fd 3).
exec 3>&2
(sleep "$LIMIT" && echo "tests/security/run.sh: no result after ${LIMIT}s; stopping $NAME" >&3 && kill $$) 2>/dev/null &
watchdog=$!

mkdir -p "$WORK/cli/bin"
cp "$ROOT/sdk/bin/zenius" "$WORK/cli/bin/zenius"
(cd "$ROOT/sdk" && ZENIUS_BUILD_DIST="$WORK/cli/dist" node build.mjs >/dev/null)
export ZENIUS_SECURITY_INSTANCE=$NAME ZENIUS_SECURITY_CLI=$WORK/cli/bin/zenius

# Whether this machine can make the sandbox install-cli.sh --sandbox asks for.
sandbox_ready() {
  case $(uname) in
    Linux) command -v bwrap >/dev/null && bwrap --ro-bind / / --unshare-all --die-with-parent true 2>/dev/null ;;
    Darwin) [[ -x /usr/bin/sandbox-exec ]] ;;
    *) return 1 ;;
  esac
}

# The launcher, as scripts/install-cli.sh --sandbox installs it, from a copy
# of this checkout whose bundle is built for it (the SDK suites rebuild
# sdk/dist beside this one). The launcher's ~/.zenius stays the real one: it
# holds the instance's registry record and socket.
install_launcher() {
  local copy=$WORK/checkout path
  mkdir -p "$copy/scripts" "$copy/sdk" "$copy/skill" "$copy/runtime/vendor"
  cp "$ROOT/scripts/install-cli.sh" "$copy/scripts/"
  for path in bin src sandbox package.json; do cp -R "$ROOT/sdk/$path" "$copy/sdk/"; done
  cp -R "$ROOT/skill/zenius" "$ROOT/skill/guide.md" "$copy/skill/"
  cp -R "$ROOT/runtime/vendor/fx-autoconfig" "$copy/runtime/vendor/"
  (cd "$ROOT/sdk" && ZENIUS_BUILD_DIST="$copy/sdk/dist" node build.mjs >/dev/null)
  mkdir -p "$WORK/sandbox/tmp" "$WORK/sandbox/downloads"
  if ! ZENIUS_INSTALL_NO_BUILD=1 ZENIUS_CLI_DIR=$WORK/sandbox/cli ZENIUS_BIN_DIR=$WORK/sandbox/bin \
    ZENIUS_SKILL_DIRS=$WORK/sandbox/skills TMPDIR=$WORK/sandbox/tmp \
    "$copy/scripts/install-cli.sh" --sandbox --output-dir "$WORK/sandbox/out" --read-dir "$WORK/sandbox/downloads" >"$WORK/sandbox/install.log" 2>&1; then
    echo "tests/security/run.sh: install-cli.sh --sandbox failed:" >&2
    sed 's/^/  /' "$WORK/sandbox/install.log" >&2
    return 1
  fi
  export ZENIUS_SECURITY_LAUNCHER=$WORK/sandbox/bin/zenius ZENIUS_SECURITY_LAUNCHER_CLI=$WORK/sandbox/cli
}

"$DEV" "$NAME" fresh >/dev/null
status=0
for part in "${parts[@]}"; do
  if [[ $part == sandbox ]]; then
    if ! sandbox_ready; then
      echo "SKIP security sandbox: no bubblewrap that can make a sandbox here (Linux), or no sandbox-exec (macOS)"
      continue
    fi
    install_launcher || { status=1; continue; }
  fi
  if [[ $part == escape ]]; then "$DEV" "$NAME" restart >/dev/null
  else ZENIUS_DEV_METHODS=0 "$DEV" "$NAME" restart >/dev/null; fi
  node --test --test-concurrency=1 --test-timeout=600000 --test-reporter=spec "$ROOT/tests/security/$part.test.mjs" &
  run=$!
  wait "$run" || status=1
  run=
done
exit "$status"
