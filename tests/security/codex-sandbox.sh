#!/usr/bin/env bash
# Does zenius work inside Codex's sandbox? Runs, through Codex's own sandbox
# runner (`codex sandbox`), a probe and zenius itself under each policy:
#
#   - the probe: may the command write its current folder, the dev Zen's
#     run/ and /tmp, and connect to a Unix socket in that run/ and to
#     loopback TCP? The dev Zen's zenius home stands in for ~/.zenius, where
#     a user's sockets are: it's under HOME, outside the project folder the
#     sandbox runs in and outside /tmp, which a sandbox may let it write.
#   - zenius --version, zenius doctor and a short zenius nodejs script, for a
#     plain CLI and for the sandboxed launcher.
#
# No credentials, no model calls, and the user's Codex config stays out of it:
# CODEX_HOME is a fresh folder. The CLI copies are installed as
# tests/security/run.sh does, into the work folder, so ~/.local/bin, the skill
# folders and ~/.zenius/cli stay as they are. They're installed and run with a
# scratch HOME and ZENIUS_HOME (tests/lib/scratch-home.sh) and a working
# folder of their own, so ~/.zenius/config.json and ~/zenius-files stay as
# they are too; the scratch zenius home's run/, instances/ and selfcheck/ are
# links to the dev Zens' own. A headless dev instance, zen-sdk-codex, runs for
# the check and stops at the end.
#
#   PATH=<Node 24>/bin:$PATH tests/security/codex-sandbox.sh
#   ZENIUS_CODEX_POLICIES="proxy+sockets" ...   (only these rows)
#
# It needs Node 24 first on PATH (the launcher needs it), Codex on PATH (or
# CODEX=<path>), and bubblewrap on Linux. Results print as a table; each run's
# output is in $ZENIUS_CODEX_CHECK_DIR/logs (default ~/.zenius-dev/codex-check,
# outside /tmp: Codex's Linux sandbox can't find its helper when CODEX_HOME is
# under /tmp). Not part of test-all, which mustn't need Codex. The dev
# profile stays; `scripts/zen-dev.sh zen-sdk-codex reset` removes it.

set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=../lib/scratch-home.sh
. "$ROOT/tests/lib/scratch-home.sh"
WORK=${ZENIUS_CODEX_CHECK_DIR:-$HOME/.zenius-dev/codex-check}
NAME=zen-sdk-codex
CODEX=${CODEX:-$(type -P codex || true)}
NODE=$(type -P node || true)
[[ -x $CODEX ]] || { echo "codex-sandbox.sh: no codex on PATH; set CODEX=<path>" >&2; exit 2; }
[[ -x $NODE && $("$NODE" -p 'process.versions.node.split(".")[0]') == 24 ]] ||
  { echo "codex-sandbox.sh: put Node 24 first on PATH" >&2; exit 2; }
POLICIES="read-only workspace-write +network +network+files full-access profile+sockets proxy+sockets"
for p in ${ZENIUS_CODEX_POLICIES-}; do
  case " $POLICIES " in *" $p "*) ;; *) echo "codex-sandbox.sh: no policy $p; the policies are: $POLICIES" >&2; exit 2 ;; esac
done

# Before any Codex call, --help included: each one starts by making a folder
# in its CODEX_HOME (tmp/arg0-<platform>), which mustn't be the user's.
mkdir -p "$WORK/logs" "$WORK/project" "$WORK/bin" "$WORK/codex-home"
export CODEX_HOME=$WORK/codex-home

# Codex 0.169.0's `codex sandbox <command>` uses the platform's sandbox
# (bubblewrap and seccomp on Linux, Seatbelt on macOS); some versions name it
# instead, as `codex sandbox macos` or `codex sandbox linux`.
SANDBOX=(sandbox)
case $(uname) in Darwin) sub=macos ;; *) sub=linux ;; esac
# The help is read first: under pipefail, Codex's exit on grep's early close would fail the test.
help=$("$CODEX" sandbox --help 2>/dev/null)
if printf '%s\n' "$help" | grep -qE "^  $sub( |$)"; then SANDBOX=(sandbox "$sub"); fi

# A time limit that macOS has too (it has no timeout(1)).
limited() { perl -e '$s = shift; alarm $s; exec @ARGV or die "exec: $!"' "$@"; }

# The dev Zen's zenius home, where the instance's socket and record are:
# always one of this run's own, in the work folder, which the cleanup
# removes once Zen has stopped. Never a caller's, which may well be in /tmp,
# as the usual export makes it: the home stands in for ~/.zenius (the
# header), so a sandbox that lets a command write /tmp, or reach a socket
# there, must not make this check pass where a user's ~/.zenius/run fails.
unset ZENIUS_HOME
own_zenius_home cx "$WORK" || exit 2
trap drop_own_zenius_home EXIT
RUNTIME_HOME=$ZENIUS_HOME
SOCKET=$RUNTIME_HOME/run/$NAME.sock
PROBE_SOCKET=$RUNTIME_HOME/run/.codex-probe-socket

cat > "$WORK/bin/probe.mjs" <<'EOF'
// Inside Codex's sandbox: what may this command write, and reach?
import { unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";
const [socketPath, tcpPort] = process.argv.slice(2);
const out = [];
// run/: the dev Zen's, where the probe's socket is too (the header).
for (const [name, path] of [["cwd", `./.codex-probe-${process.pid}`], ["run/", `${dirname(socketPath)}/.codex-probe-${process.pid}`], ["/tmp", `/tmp/.codex-probe-${process.pid}`]]) {
  try {
    writeFileSync(path, "");
    unlinkSync(path);
    out.push(`write ${name} yes`);
  } catch (error) {
    out.push(`write ${name} ${error.code}`);
  }
}
const reach = (options) =>
  new Promise((resolve) => {
    const socket = connect(options);
    const timer = setTimeout(() => (socket.destroy(), resolve("timeout")), 3000);
    socket.on("connect", () => (clearTimeout(timer), socket.destroy(), resolve("yes")));
    socket.on("error", (error) => (clearTimeout(timer), resolve(error.code)));
  });
out.push(`unix ${await reach({ path: socketPath })}`, `tcp ${await reach({ host: "127.0.0.1", port: Number(tcpPort) })}`);
const codex = Object.keys(process.env).filter((name) => /^CODEX_(SANDBOX|NETWORK_PROXY)/.test(name)).map((name) => `${name}=${process.env[name]}`);
console.log([...out, ...codex].join(", "));
EOF
cat > "$WORK/bin/servers.mjs" <<'EOF'
// Outside the sandbox: a Unix socket and a loopback TCP port for probe.mjs.
// It prints its port and pid, and goes by itself after 30 minutes in case
// nothing stops it.
import { createServer } from "node:net";
import { unlinkSync } from "node:fs";
try { unlinkSync(process.argv[2]); } catch {}
const unix = createServer((socket) => socket.end()).listen(process.argv[2]);
const tcp = createServer((socket) => socket.end()).listen(0, "127.0.0.1", () => console.log(`${tcp.address().port} ${process.pid}`));
const stop = () => { unix.close(); tcp.close(); process.exit(0); };
process.on("SIGTERM", stop);
setTimeout(stop, 30 * 60_000);
EOF

# What the run starts or makes goes at exit, however it ends: the probe's
# servers, the dev instance, the checkout's copy and the scratch home. The
# trap comes before the install, so a failed install cleans up too.
copy= servers= started= SCRATCH_ROOT=
cleanup() {
  [[ -n $servers ]] && kill "$servers" 2>/dev/null
  [[ -n $started ]] && "$ROOT/scripts/zen-dev.sh" "$NAME" stop >/dev/null 2>&1
  [[ -n $copy ]] && rm -rf "${copy:?}"
  [[ -n $SCRATCH_ROOT ]] && rm -rf "${SCRATCH_ROOT:?}"
  drop_own_zenius_home
  return 0
}
trap cleanup EXIT

# The scratch home the CLIs are installed and run with, in the work folder.
# Their working folder is in it, as ~/zenius-files is in a home, since the
# working folder's git work tree check stops at home (the work folder may be
# in one, below the account's own home). It's made now, so a policy that
# can't write the work folder still finds it.
scratch_home codex "$WORK" || exit 1
FILES=$SCRATCH_HOME/zenius-files
mkdir -m 700 "$FILES" || exit 1
for sub in run instances selfcheck; do
  (umask 077 && mkdir -p "$RUNTIME_HOME/$sub") && ln -s "$RUNTIME_HOME/$sub" "$SCRATCH_ZHOME/$sub" || exit 1
done
# The CLIs' environment inside Codex's sandbox.
AS_SCRATCH=(env "HOME=$SCRATCH_HOME" "ZENIUS_HOME=$SCRATCH_ZHOME")

# The two CLIs, from a copy of this checkout whose bundle is built for it,
# in the system's temp folder: the install copies what it needs.
copy=$(mktemp -d "${TMPDIR:-/tmp}/zenius-codex-check.XXXXXX") || exit 1
mkdir -p "$copy/scripts" "$copy/sdk" "$copy/skill" "$copy/runtime/vendor"
cp "$ROOT/scripts/install-cli.sh" "$ROOT/scripts/working-folder.sh" "$copy/scripts/"
for path in bin src sandbox package.json; do cp -R "$ROOT/sdk/$path" "$copy/sdk/"; done
cp -R "$ROOT/skill/zenius" "$ROOT/skill/guide.md" "$copy/skill/"
cp -R "$ROOT/runtime/vendor/fx-autoconfig" "$copy/runtime/vendor/"
(cd "$ROOT/sdk" && ZENIUS_BUILD_DIST="$copy/sdk/dist" "$NODE" build.mjs >/dev/null) || exit 1
guard_home "$SCRATCH_HOME" "$SCRATCH_ZHOME" codex-sandbox.sh || exit 1
for kind in plain sandboxed; do
  flags=(--working-dir "$FILES")
  [[ $kind == sandboxed ]] && flags+=(--sandbox)
  mkdir -p "$WORK/$kind/tmp"
  if ! HOME=$SCRATCH_HOME ZENIUS_HOME=$SCRATCH_ZHOME ZENIUS_INSTALL_NO_BUILD=1 ZENIUS_CLI_DIR=$WORK/$kind/cli ZENIUS_BIN_DIR=$WORK/$kind/bin \
    ZENIUS_SKILL_DIRS=$WORK/$kind/skills TMPDIR=$WORK/$kind/tmp \
    "$copy/scripts/install-cli.sh" "${flags[@]}" >"$WORK/logs/install-$kind.log" 2>&1; then
    echo "codex-sandbox.sh: install-cli.sh for the $kind CLI failed; see $WORK/logs/install-$kind.log" >&2
    exit 1
  fi
done

# Set first, so a start that fails half way is stopped too.
started=1
"$ROOT/scripts/zen-dev.sh" "$NAME" start >"$WORK/logs/zen.log" 2>&1 || { cat "$WORK/logs/zen.log" >&2; exit 1; }
# Its pid comes from itself: bash 3.2 sets no $! for a process substitution.
exec 3< <(exec "$NODE" "$WORK/bin/servers.mjs" "$PROBE_SOCKET")
read -r PORT servers <&3

SCRIPT='const task = await taskSpace("codex check " + Date.now());
const page = await task.newPage();
await page.goto("data:text/html,<title>codex check</title><p>reached Zen</p>");
console.log(JSON.stringify({ title: await page.evaluate(() => document.title) }));
await task.finish({ keep: [] });'

# Each policy's codex sandbox options. The legacy settings first, then
# permission profiles. A profile's network.unix_sockets ({path = "allow"})
# is enforced with Codex's network proxy, which starts only with the
# network_proxy feature and network.enabled; Codex runs no proxy while
# network is off. Linux refuses it ("macOS-only"), so there proxy+sockets
# blocks every socket. Codex ignores a key it doesn't know without a word:
# the old row's allow_unix_sockets is a requirements.toml key, which a
# profile doesn't have. So the header line checks each profile key below:
# Codex must refuse a wrongly typed value for it.
# The CLIs may reach the instance's socket by the scratch home's link too.
UNIX_SOCKETS="{\"$SOCKET\" = \"allow\", \"$SCRATCH_ZHOME/run/$NAME.sock\" = \"allow\", \"$PROBE_SOCKET\" = \"allow\"}"
policy() {
  case $1 in
    read-only) args=(-c 'sandbox_mode="read-only"') ;;
    workspace-write) args=(-c 'sandbox_mode="workspace-write"' -c 'sandbox_workspace_write.network_access=false') ;;
    +network) args=(-c 'sandbox_mode="workspace-write"' -c 'sandbox_workspace_write.network_access=true') ;;
    +network+files) args=(-c 'sandbox_mode="workspace-write"' -c 'sandbox_workspace_write.network_access=true'
      -c "sandbox_workspace_write.writable_roots=[\"$FILES\"]") ;;
    full-access) args=(-c 'sandbox_mode="danger-full-access"') ;;
    profile+sockets) args=(-P zenius -C "$WORK/project" -c 'permissions.zenius.extends=":workspace"'
      -c "permissions.zenius.network.unix_sockets=$UNIX_SOCKETS") ;;
    proxy+sockets) args=(--enable network_proxy -P zenius -C "$WORK/project" -c 'permissions.zenius.extends=":workspace"'
      -c 'permissions.zenius.network.enabled=true' -c "permissions.zenius.network.unix_sockets=$UNIX_SOCKETS") ;;
  esac
}
# Does this Codex know the profile key $1? It does if it refuses a value of
# the wrong type. (No pipe into grep: under pipefail, Codex's own exit 1
# would fail the test.)
known() {
  local said
  said=$(limited 60 "$CODEX" "${SANDBOX[@]}" -P zenius -C "$WORK/project" -c 'permissions.zenius.extends=":workspace"' \
    -c "permissions.zenius.$1=7" -- /bin/sh -c : 2>&1)
  case $said in *"invalid type"*) echo "$1 known" ;; *) echo "$1 UNKNOWN" ;; esac
}
# What a run said: the probe's line, the version, doctor's lines that aren't ok, or the script's JSON or error.
summary() {
  case $1 in
    probe | version) tail -n 1 "$2" | cut -c1-200 ;;
    doctor) grep -vE '^(ok |zenius doctor|$)' "$2" | head -n 2 | cut -c1-150 | tr '\n' '|' ;;
    script) { grep -m1 -E 'Error|error:|^\{|zenius \(sandboxed\)' "$2" || tail -n 1 "$2"; } | cut -c1-150 ;;
  esac
}

cd "$WORK/project" || exit 1
echo "$("$CODEX" --version 2>&1 | tail -n 1), $(uname -sm), \`codex ${SANDBOX[*]}\`, instance $NAME"
echo "profile keys: $(known network.enabled), $(known network.unix_sockets)"
for p in ${ZENIUS_CODEX_POLICIES:-$POLICIES}; do
  policy "$p"
  log=$WORK/logs/$p.probe.log
  limited 60 "$CODEX" "${SANDBOX[@]}" "${args[@]}" -- "$NODE" "$WORK/bin/probe.mjs" "$PROBE_SOCKET" "$PORT" >"$log" 2>&1
  printf '%-16s %-9s %-7s exit %-3s %s\n' "$p" probe "" "$?" "$(summary probe "$log")"
  for kind in plain sandboxed; do
    zen=$WORK/$kind/bin/zenius
    for what in version doctor script; do
      log=$WORK/logs/$p.$kind.$what.log
      case $what in
        version) cmd=("${AS_SCRATCH[@]}" "$zen" --version) ;;
        doctor) cmd=("${AS_SCRATCH[@]}" "$zen" doctor --instance "$NAME") ;;
        script) cmd=("${AS_SCRATCH[@]}" bash -c "\"$zen\" nodejs --instance $NAME <<'JS'
$SCRIPT
JS") ;;
      esac
      limited 120 "$CODEX" "${SANDBOX[@]}" "${args[@]}" -- "${cmd[@]}" >"$log" 2>&1
      printf '%-16s %-9s %-7s exit %-3s %s\n' "$p" "$kind" "$what" "$?" "$(summary "$what" "$log")"
    done
  done
done
# What a command under Codex's sandbox leaves in a writable root on disk,
# seen from outside, as Zen, an install or another zenius run would see it:
# while the command runs (on Linux, the mount points of what Codex protects
# there, such as an empty .git) and after it.
case " ${ZENIUS_CODEX_POLICIES:-$POLICIES} " in
  *" +network+files "*)
    policy +network+files
    limited 60 "$CODEX" "${SANDBOX[@]}" "${args[@]}" -- /bin/sh -c 'sleep 3' >"$WORK/logs/disk.log" 2>&1 &
    pid=$!
    during=
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
      during=$(ls -A "$FILES")
      [[ -n $during ]] && break
      perl -e 'select(undef, undef, undef, 0.25)'
    done
    wait "$pid"
    after=$(ls -A "$FILES")
    echo "the working folder on disk, from outside, in +network+files: during a command [$(echo $during)], after it [$(echo $after)]"
    ;;
esac
echo "logs: $WORK/logs"
