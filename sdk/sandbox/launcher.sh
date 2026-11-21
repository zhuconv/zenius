#!/bin/sh -p
# zenius, sandboxed (zenius-sandbox-launcher 1). scripts/install-cli.sh
# --sandbox wrote this file from sdk/sandbox/launcher.sh, and --uninstall
# removes it.
#
# Every zenius command comes here. The CLI copy runs inside an OS sandbox
# (bubblewrap on Linux, sandbox-exec on macOS) and under Node's permission
# model inside that, on the Node 24 that --sandbox found, never the PATH's.
# The CLI, and the scripts it runs, can:
#   - read the CLI copy and the instance registry;
#   - read and write a temporary folder of this run's own, which is their
#     TMPDIR (screenshots without a path, download copies);
#   - read and write an output folder of this run's own, outside the working
#     folder, where the CLI writes what a relative path names; and read the
#     output folders of the same working folder's earlier runs;
#   - read the working folder, unless it is $HOME, a temp folder or above
#     one, or holds or is inside the CLI, ~/.zenius, Zen's profiles, this
#     launcher, the node it runs, ~/.config, ~/.local, ~/Library, a
#     credentials folder or /run/user. Never write it: git, direnv, npm,
#     pytest, make and agents run what a project holds, outside the sandbox
#     (hooks, core.fsmonitor, .envrc, .venv/bin, conftest.py, Makefile). On
#     Linux, a socket inside it can be reached;
#   - connect to the instance's socket, which it picks as the CLI does.
# Nothing else: no other files, no programs, no network or other sockets,
# and only the environment variables listed below. The browser adds nothing
# to that: zenius gives agents only web pages, and opens no path they name.
set -eu
# Until its env -i below, this shell has the caller's environment, so it takes
# nothing from it. -p keeps bash (macOS's /bin/sh) from running what SHELLOPTS
# and PS4, BASH_ENV or an exported function name; dash takes -p and reads none
# of those. The PATH is fixed, since a folder on the caller's PATH, such as a
# project's .venv/bin, can be one a script writes.
export PATH=/usr/bin:/bin
unset IFS
CLI=@CLI@
ZHOME=@ZHOME@
# The node, by the path --sandbox found it at, such as Homebrew's
# /opt/homebrew/opt/node@24/bin/node: a link that an upgrade moves to the new
# 24.x, so each start follows it, and the CLI checks it's still NODE_MAJOR.
NODE=@NODE@
NODE_MAJOR=@NODE_MAJOR@
BIN_DIR=@BIN_DIR@
# Where runs' output folders go (install-cli.sh --output-dir), and how many
# days a run's folder is kept.
OUT_ROOT=@OUT_ROOT@
OUT_KEEP_DAYS=7

fail() {
  echo "zenius (sandboxed): $*" >&2
  exit 70
}

# Codex's sandbox sets this while its network access is off, which on Linux
# blocks every socket: Zen's, and the loopback that bubblewrap sets up (Codex
# 0.169.0). Nothing here can work then, so say why instead of failing on the
# first step. On macOS a Codex profile may still allow a Unix socket, so it
# isn't taken as a block there.
if [ @PLATFORM@ = linux ] && [ "${CODEX_SANDBOX_NETWORK_DISABLED-}" = 1 ]; then
  fail "Codex's sandbox has network access off, which blocks every socket, Zen's included. Rerun this zenius command outside Codex's sandbox (sandbox_permissions \"require_escalated\"), where zenius's own sandbox still applies, or ask the user to turn on network access for the workspace."
fi
# On macOS, Codex runs each command inside Seatbelt (CODEX_SANDBOX=seatbelt in
# every policy but full access), and macOS lets no sandbox start inside
# another: sandbox-exec fails with "sandbox_apply: Operation not permitted"
# (Codex 0.169.0, checked on zen-eval's Mac). Earlier steps can fail first,
# with misleading words.
if [ @PLATFORM@ = macos ] && [ "${CODEX_SANDBOX-}" = seatbelt ]; then
  fail "this runs inside Codex's Seatbelt sandbox, and macOS lets no sandbox start inside another, zenius's included. Rerun this zenius command outside Codex's sandbox (sandbox_permissions \"require_escalated\"), where zenius's own sandbox still applies."
fi

# The node's real path and its install, as sandbox rules need them.
node=$NODE hops=0
while [ -L "$node" ] && [ "$hops" -lt 32 ]; do
  link=$(readlink "$node") || break
  case $link in /*) node=$link ;; *) node=${node%/*}/$link ;; esac
  hops=$((hops + 1))
done
nodebin=$(cd -P "${node%/*}" 2>/dev/null && pwd) || nodebin=
node=$nodebin/${node##*/}
if [ -z "$nodebin" ] || [ -L "$node" ] || [ ! -f "$node" ] || [ ! -x "$node" ]; then
  fail "the node it was installed with is gone ($NODE): reinstall with scripts/install-cli.sh --sandbox"
fi
node_home=${nodebin%/*}
case $node_home in '' | /) node_home=$nodebin ;; esac

# The instance, picked as the CLI picks it: the last --instance, which takes
# the next argument whatever it is, then ZENIUS_INSTANCE.
instance=${ZENIUS_INSTANCE:-default}
take=0
for arg in "$@"; do
  if [ "$take" = 1 ]; then instance=$arg take=0; continue; fi
  case $arg in
    --instance) take=1 ;;
    --instance=*) instance=${arg#--instance=} ;;
  esac
done
case $instance in '' | *[!A-Za-z0-9._-]*) fail "an instance name has only letters, digits, '.', '_' and '-'" ;; esac
# Its socket, by real path as sandbox rules need it. ZENIUS_SOCKET from
# outside is ignored: it could name any socket, such as Docker's.
run=$(cd "$ZHOME/run" 2>/dev/null && pwd -P) || run=$ZHOME/run
sock=$run/$instance.sock
registry=$(cd "$ZHOME/instances" 2>/dev/null && pwd -P) || registry=$ZHOME/instances

# The working folder, unless granting it would hand over more than a task's
# folder. A shared folder (home, the temp folders) is refused as the working
# folder or above it. A folder a script must never reach (zenius itself,
# the node it runs, Zen's profiles, credentials, the user's runtime sockets)
# is refused inside it too.
work=$(pwd -P)
home=$(cd "$HOME" 2>/dev/null && pwd -P) || home=$HOME
tmp=${TMPDIR:-/tmp}
tmp=${tmp%/}
grant=1
[ "$work" = / ] && grant=0
for shared in "$home" /tmp /var/tmp /private/tmp /private/var/tmp /dev/shm "$tmp" "/private$tmp"; do
  case $shared/ in "$work"/*) grant=0 ;; esac
done
for kept in "$ZHOME" "$CLI" "$BIN_DIR" "$node_home" "${NODE%/*}" /run/user/@UID@ "$home/.zenius-dev" "$home/.zen" \
  "$home/.config" "$home/.local" "$home/.ssh" "$home/.gnupg" "$home/.aws" "$home/.docker" "$home/.kube" "$home/Library"; do
  case $kept/ in "$work"/*) grant=0 ;; esac
  case $work/ in "$kept"/*) grant=0 ;; esac
done

# A temporary folder of the sandbox's own. It must be this user's, and no
# link: on a shared machine someone else could make it first. Each run gets a
# folder of its own in it, so no run reads what another left, such as its
# screenshots; now and then, empty ones over a day old go.
box=$tmp/zenius-sandbox-@UID@
# A run that can't make it says so; the check below would blame the folder,
# as it did inside Codex's read-only Seatbelt. Another launcher may make it
# meanwhile, and a link in its place falls to that check.
if [ ! -e "$box" ] && [ ! -L "$box" ] && ! mkdir -m 700 "$box" 2>/dev/null && [ ! -e "$box" ]; then
  fail "can't make $box: set TMPDIR to a folder zenius may write; if this runs inside another sandbox, it must let zenius write $tmp"
fi
if [ -L "$box" ] || [ ! -d "$box" ] || [ ! -O "$box" ]; then
  fail "$box isn't a folder of yours: remove it, or set TMPDIR to a folder of your own"
fi
chmod 700 "$box" 2>/dev/null || fail "can't make $box writable only by you; if this runs inside another sandbox, it must let zenius write $tmp"
box=$(cd "$box" && pwd -P)
if [ $(($$ % 16)) = 0 ]; then
  find "$box" -mindepth 1 -maxdepth 1 -name 'run.*' -type d -empty -mmin +1440 -exec rmdir {} + 2>/dev/null || true
fi
box=$(mktemp -d "$box/run.XXXXXX") || fail "can't make a folder in $box"

# The run's output folder: OUT_ROOT/<working folder's name>-<cksum of its
# path>/run.XXXXXX. The run writes only its own; it can read the others of
# the same working folder (a download to upload later), and none of another
# folder's. It must never land inside the working folder. Now and then, runs
# over OUT_KEEP_DAYS days old go, and empty ones over a day old.
sum=$(printf '%s' "$work" | cksum) || fail "can't name the output folder"
name=${work##*/}
outs=$OUT_ROOT/${name:-root}-${sum%% *}
if [ "$grant" = 1 ]; then
  case $outs/ in "$work"/*) fail "the output folder ($OUT_ROOT) is inside the working folder, where a script must not write: reinstall with scripts/install-cli.sh --sandbox --output-dir <a folder outside your projects>" ;; esac
fi
[ -e "$OUT_ROOT" ] || mkdir -p -m 700 "$OUT_ROOT" 2>/dev/null || true
if [ -L "$OUT_ROOT" ] || [ ! -d "$OUT_ROOT" ] || [ ! -O "$OUT_ROOT" ]; then
  fail "$OUT_ROOT isn't a folder of yours: remove it, or reinstall with scripts/install-cli.sh --sandbox --output-dir <folder>"
fi
# A day's grace for empty folders, so no start removes one that another has
# just made.
if [ $(($$ % 16)) = 0 ]; then
  find "$OUT_ROOT" -mindepth 2 -maxdepth 2 -name 'run.*' -type d \( -mtime +"$OUT_KEEP_DAYS" -o -empty -mmin +1440 \) \
    -exec rm -rf {} + 2>/dev/null || true
  find "$OUT_ROOT" -mindepth 1 -maxdepth 1 -type d -empty -mmin +1440 -exec rmdir {} + 2>/dev/null || true
fi
[ -d "$outs" ] || mkdir -m 700 "$outs" 2>/dev/null || true
[ -d "$outs" ] && [ ! -L "$outs" ] || fail "can't make the output folder $outs; if this runs inside another sandbox, it must let zenius write $OUT_ROOT (Codex: sandbox_workspace_write.writable_roots)"
out=$(mktemp -d "$outs/run.XXXXXX") || fail "can't make a folder in $outs; if this runs inside another sandbox, it must let zenius write $OUT_ROOT (Codex: sandbox_workspace_write.writable_roots)"

# Node's permission model, inside the OS sandbox: no child processes,
# workers, add-ons, WASI or inspector, and files only where granted.
if [ "$grant" = 1 ]; then
  set -- --allow-fs-read="$work" "$CLI/sdk/bin/zenius" "$@"
else
  set -- "$CLI/sdk/bin/zenius" "$@"
fi
set -- --permission --allow-fs-read="$CLI" --allow-fs-read="$ZHOME/instances" --allow-fs-read="$sock" \
  --allow-fs-read="$box" --allow-fs-write="$box" --allow-fs-read="$outs" --allow-fs-write="$out" "$@"

case @PLATFORM@ in
linux)
  # A new mount namespace that holds only the system, node, the CLI copy,
  # the registry, the instance's socket, the working folder and the output
  # folders of its runs (all read-only), and the run's temporary and output
  # folders; and new network, PID, IPC and user namespaces. The socket is
  # bound as a file: the folder holds every instance's. Later binds win, so
  # the run's output folder comes after the folder of runs.
  if [ "$grant" = 1 ]; then
    set -- --ro-bind "$work" "$work" --ro-bind "$outs" "$outs" --bind "$out" "$out" --chdir "$work" "$node" "$@"
  else
    set -- --ro-bind "$outs" "$outs" --bind "$out" "$out" --chdir "$box" "$node" "$@"
  fi
  set -- @BWRAP@ --ro-bind /usr /usr @SYSBINDS@ --ro-bind /etc /etc \
    --proc /proc --dev /dev --tmpfs /tmp \
    --ro-bind "$node_home" "$node_home" --ro-bind "$CLI" "$CLI" \
    --ro-bind-try "$registry" "$ZHOME/instances" --ro-bind-try "$sock" "$sock" \
    --bind "$box" "$box" --unshare-all --cap-drop ALL --new-session --die-with-parent "$@"
  ;;
macos)
  # sdk/sandbox/zenius.sb in the copy: reads, writes, processes and sockets.
  # Without a working folder a script starts in the temporary one, as
  # bubblewrap's --chdir does on Linux.
  if [ "$grant" = 1 ]; then granted=$work; else granted=$box/no-working-folder; cd "$box"; fi
  set -- /usr/bin/sandbox-exec -f "$CLI/sdk/sandbox/zenius.sb" \
    -D "CLI=$CLI" -D "REGISTRY=$registry" -D "SOCK=$sock" \
    -D "BOX=$box" -D "OUTS=$outs" -D "OUT=$out" -D "WORK=$granted" -D "NODE=$node" -D "NODE_HOME=$node_home" "$node" "$@"
  ;;
esac

# The claim prompt's label for the agent (globals.ts's clientLabel), worked
# out here because the agent's own variables stay outside. It's a display
# name the runtime treats as untrusted, so it adds no reach.
client=${ZENIUS_CLIENT-}
if [ -z "$client" ]; then
  if [ "${CLAUDECODE-}" = 1 ]; then
    client="Claude Code"
  elif [ -n "${CODEX_SANDBOX-}${CODEX_SANDBOX_NETWORK_DISABLED-}" ]; then
    client=Codex
  fi
fi

# Only these variables reach the CLI: no NODE_OPTIONS, tokens or the rest.
# ZENIUS_TASK_SPACE is the task id the agent sidebar gives a resumed chat's
# zenius mcp (docs/mcp.md). The server checks it, and a script can already
# name any task by its id, so it adds no reach.
exec /usr/bin/env -i HOME="$HOME" PATH=/usr/bin:/bin TMPDIR="$box" ZENIUS_OUTPUT_DIR="$out" \
  ZENIUS_HOME="$ZHOME" ZENIUS_INSTANCE="$instance" ZENIUS_SOCKET="$sock" ZENIUS_NODE_MAJOR="$NODE_MAJOR" \
  NODE_DISABLE_COMPILE_CACHE=1 ${client:+"ZENIUS_CLIENT=$client"} \
  ${LANG+"LANG=$LANG"} ${LC_ALL+"LC_ALL=$LC_ALL"} ${LC_CTYPE+"LC_CTYPE=$LC_CTYPE"} \
  ${TERM+"TERM=$TERM"} ${TZ+"TZ=$TZ"} ${COLUMNS+"COLUMNS=$COLUMNS"} \
  ${NO_COLOR+"NO_COLOR=$NO_COLOR"} ${FORCE_COLOR+"FORCE_COLOR=$FORCE_COLOR"} \
  ${ZENIUS_TIMING+"ZENIUS_TIMING=$ZENIUS_TIMING"} \
  ${ZENIUS_TASK_SPACE+"ZENIUS_TASK_SPACE=$ZENIUS_TASK_SPACE"} \
  ${EGO_BROWSER_PAGE_BUDGET+"EGO_BROWSER_PAGE_BUDGET=$EGO_BROWSER_PAGE_BUDGET"} \
  ${EGO_BROWSER_RESPONSE_TIMEOUT_MS+"EGO_BROWSER_RESPONSE_TIMEOUT_MS=$EGO_BROWSER_RESPONSE_TIMEOUT_MS"} \
  "$@"
