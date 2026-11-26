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
#     TMPDIR (screenshots without a path);
#   - read, write and delete files in the working folder, where downloads
#     land and the CLI writes what a relative path names. The install sets
#     it (install-cli.sh --working-dir, ~/zenius-files by default), and
#     ~/.zenius/config.json names it. If it is $HOME, a temp folder or above
#     one, or holds or is inside the CLI, ~/.zenius, Zen's profiles, this
#     launcher, the node it runs, ~/.config, ~/.local, ~/Library, a
#     credentials folder or /run/user, or is a project's (it holds .git or
#     .envrc, or sits in a git work tree), every command stops with the
#     reason: git, direnv, npm, pytest, make and agents run what a project
#     holds, outside the sandbox;
#   - read the current folder, where the command started, held to the same
#     rules, unless it holds more than a task's files. Never write it, for
#     the same reason (hooks, core.fsmonitor, .envrc, .venv/bin, conftest.py,
#     Makefile). On Linux, a socket inside it can be reached;
#   - read the folder the install names for it (install-cli.sh --read-dir),
#     such as ~/Downloads, for uploads, held to the same rules; never write
#     it;
#   - connect to the instance's socket, which it picks as the CLI does.
# With --sidebar (zenius mcp --sidebar, the agent sidebar's server), neither
# the current folder nor the read folder: the working folder alone, where the
# command starts (docs/mcp.md, "script").
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
# The folder scripts may also read (install-cli.sh --read-dir), such as
# ~/Downloads, as given; empty for none.
READ_DIR=@READ_DIR@

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
# (Codex 0.169.0, checked on the eval harness's Mac). Earlier steps can fail
# first, with misleading words.
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
# The folder of the node as installed, such as Homebrew's opt/node@24/bin, by
# its real path, as the folders it's compared with are.
node_dir=$(cd -P "${NODE%/*}" 2>/dev/null && pwd -P) || node_dir=${NODE%/*}

# The instance, picked as the CLI picks it: the last --instance, which takes
# the next argument whatever it is, then ZENIUS_INSTANCE.
instance=${ZENIUS_INSTANCE:-default}
take=0
# --sidebar only narrows what this grants, so it's taken wherever it stands.
narrow=0
for arg in "$@"; do
  if [ "$take" = 1 ]; then instance=$arg take=0; continue; fi
  case $arg in
    --instance) take=1 ;;
    --instance=*) instance=${arg#--instance=} ;;
    --sidebar) narrow=1 ;;
  esac
done
case $instance in '' | *[!A-Za-z0-9._-]*) fail "an instance name has only letters, digits, '.', '_' and '-'" ;; esac
# Its socket, by real path as sandbox rules need it. ZENIUS_SOCKET from
# outside is ignored: it could name any socket, such as Docker's.
run=$(cd "$ZHOME/run" 2>/dev/null && pwd -P) || run=$ZHOME/run
sock=$run/$instance.sock
registry=$(cd "$ZHOME/instances" 2>/dev/null && pwd -P) || registry=$ZHOME/instances

# Whether granting the folder $1 (a real path) would hand over more than a
# task's folder. A shared folder (home, the temp folders) is refused, and so
# is a folder above one. A folder a script must never reach (zenius itself,
# the node it runs, Zen's profiles, credentials, the user's runtime sockets)
# is refused inside it too.
home=$(cd "$HOME" 2>/dev/null && pwd -P) || home=$HOME
tmp=${TMPDIR:-/tmp}
tmp=${tmp%/}
too_wide() {
  [ "$1" = / ] && return 0
  for shared in "$home" /tmp /var/tmp /private/tmp /private/var/tmp /dev/shm "$tmp" "/private$tmp"; do
    case $shared/ in "$1"/*) return 0 ;; esac
  done
  for kept in "$ZHOME" "$CLI" "$BIN_DIR" "$node_home" "$node_dir" /run/user/@UID@ "$home/.zenius-dev" "$home/.zen" \
    "$home/.config" "$home/.local" "$home/.ssh" "$home/.gnupg" "$home/.aws" "$home/.docker" "$home/.kube" "$home/Library"; do
    case $kept/ in "$1"/*) return 0 ;; esac
    case $1/ in "$kept"/*) return 0 ;; esac
  done
  return 1
}

# $1's real path: its existing part's links resolved, the rest kept, as the
# installer resolves the paths it writes in here.
real_path() {
  rp=$1 rest=
  case $rp in /*) ;; *) rp=$(pwd -P)/$rp ;; esac
  while [ "$rp" != / ] && [ "${rp%/}" != "$rp" ]; do rp=${rp%/}; done
  while [ "$rp" != / ] && [ ! -d "$rp" ]; do
    rest=/${rp##*/}$rest
    rp=${rp%/*}
    [ -n "$rp" ] || rp=/
  done
  rp=$(cd -P "$rp" 2>/dev/null && pwd -P) || rp=
  rp=${rp%/}$rest
  printf '%s\n' "${rp:-/}"
}

# Whether the .git at $1 makes its folder a project's, as git takes it
# (scripts/working-folder.sh's wf_git_found). An empty folder (a real one,
# not a link, that can be listed) is no repository to git, which looks on
# above it, nor here: Codex's sandbox on Linux makes one in each folder its
# commands may write, while each runs. Anything else there counts: a link
# (dangling or not), a file, a folder with anything in it, or one that can't
# be listed.
git_found() {
  [ -e "$1" ] || [ -L "$1" ] || return 1
  [ -d "$1" ] && [ ! -L "$1" ] || return 0
  inside=$(ls -A -- "$1" 2>/dev/null) || return 0
  [ -n "$inside" ]
}

# A ZENIUS_HOME or ZENIUS_WORKING_DIR from outside never moves what this
# install grants. One that names another folder than this install's stops
# every command: whoever set it (a dev Zen, a test) meant another install's
# folders, and this one would reach the user's own instead. One that names
# the same folder, by any path, or is empty, changes nothing.
if [ -n "${ZENIUS_HOME:-}" ] && [ "$(real_path "$ZENIUS_HOME")" != "$(real_path "$ZHOME")" ]; then
  fail "ZENIUS_HOME is $ZENIUS_HOME here, but this install's zenius home is $ZHOME: unset it, or run the zenius installed with it (a dev Zen's agents run its checkout's plain CLI)"
fi

# The working folder: the one ~/.zenius/config.json names, on a line of its
# own as the installer writes it (scripts/working-folder.sh), else
# ~/zenius-files. It's made if it's missing, as the installer makes it. It is
# the install's choice, so one that holds more than a task's files, or a
# project's, stops every command with the reason. ~/zenius-files is the
# default only while this install's zenius home is ~/.zenius: one moved
# elsewhere (ZENIUS_HOME at install) has none, and without its config file
# every command stops, making nothing.
config=$ZHOME/config.json
reinstall="reinstall with scripts/install-cli.sh --working-dir <a folder such as ~/zenius-files>"
if [ -e "$config" ]; then
  wf=$(sed -n 's/^[[:space:]]*"workingFolder"[[:space:]]*:[[:space:]]*"\([^"\\]*\)"[[:space:]]*,\{0,1\}[[:space:]]*$/\1/p' "$config" 2>/dev/null) || wf=
  plain=$(printf '%s' "$wf" | tr -d '[:cntrl:]')
  case $wf in
    /*) [ "$plain" = "$wf" ] || wf= ;;
    *) wf= ;;
  esac
  # No installer writes a ".." part. After a link it leads to the target's
  # parent for cd -P below, but drops the link's name for the SDK's
  # path.resolve, so the two would name different folders.
  case $wf in */../* | */..) wf= ;; esac
  [ -n "$wf" ] || fail "$config doesn't name the working folder on a line of its own, as the installer writes it: $reinstall"
else
  dot=$(cd -P "$home/.zenius" 2>/dev/null && pwd -P) || dot=$home/.zenius
  [ "$ZHOME" = "$dot" ] || fail "there's no default working folder: this install's zenius home, $ZHOME, isn't ~/.zenius, and it holds no config.json: $reinstall"
  wf=$HOME/zenius-files
fi
[ "$wf" = / ] || wf=${wf%/}
cant_make="can't make the working folder, $wf: make it, or $reinstall; if this runs inside another sandbox, it must let zenius write $wf (Codex: sandbox_workspace_write.writable_roots)"
# Its real path. One that's missing is checked by its parent's, and made
# only once every check below passes, so a refused one is never made.
missing=0
if [ -e "$wf" ] || [ -L "$wf" ]; then
  works=$(cd -P "$wf" 2>/dev/null && pwd -P) || fail "the working folder, $wf, isn't a folder: $reinstall"
  [ -O "$works" ] || fail "the working folder, $wf, isn't a folder of yours: $reinstall"
else
  parent=${wf%/*}
  works=$(cd -P "${parent:-/}" 2>/dev/null && pwd -P) || fail "$cant_make"
  works=${works%/}/${wf##*/}
  missing=1
fi
if [ -n "${ZENIUS_WORKING_DIR:-}" ] && [ "$(real_path "$ZENIUS_WORKING_DIR")" != "$works" ]; then
  fail "ZENIUS_WORKING_DIR is $ZENIUS_WORKING_DIR here, but this install's working folder is $wf: unset it, or run the zenius whose install names it (a dev Zen's agents run its checkout's plain CLI)"
fi
too_wide "$works" && fail "the working folder, $wf, holds more than a task's files ($works): $reinstall"
if git_found "$works/.git" || [ -e "$works/.envrc" ] || [ -L "$works/.envrc" ]; then
  fail "the working folder, $wf, holds .git or .envrc, so it's a project's, and tools there run what scripts write: $reinstall"
fi
# Nor in a project's work tree, above it. A repository at the home folder or
# a temporary folder itself (dotfiles, or a stray one on a shared machine)
# doesn't count: every folder below sits in its work tree, and its .git is
# out of the scripts' reach.
dir=$works
while [ -n "${dir%/*}" ]; do
  dir=${dir%/*}
  case $dir in "$home" | /tmp | /var/tmp | /private/tmp | /private/var/tmp | /dev/shm | "$tmp" | "/private$tmp") break ;; esac
  if git_found "$dir/.git"; then
    fail "the working folder, $wf, is inside a git work tree ($dir), and tools there run what scripts write: $reinstall"
  fi
done
if [ "$missing" = 1 ]; then
  mkdir -m 700 "$works" 2>/dev/null || fail "$cant_make"
fi

# The current folder, unless granting it would hand over more than a task's,
# or the sidebar's server asked for the working folder alone. The sidebar's
# agents start in Zen's profile, which too_wide refuses anyway.
work=$(pwd -P)
grant=1
too_wide "$work" && grant=0
[ "$narrow" = 0 ] || grant=0
# The same folder as the agent's shell names it (PWD), when that is another
# spelling of it, through a link (macOS's /tmp and /var are links into
# /private). Node's permission model checks the path a script names, so it is
# granted too, read-only like the real path. Only a tidy spelling, with no
# ".", ".." or empty part, is taken: Node resolves a grant by its text, and
# after a link ".." leads elsewhere for the kernel than for that text.
named=
case ${PWD-} in
  */ | *//* | */./* | */. | */../* | */..) ;;
  /*) if [ "$(cd -P "$PWD" 2>/dev/null && pwd -P)" = "$work" ]; then named=$PWD; fi ;;
esac
[ "$named" != "$work" ] || named=

# The folder the install lets scripts read (--read-dir), by its real path. It
# is held to the same rules, and can't be the working folder or inside it,
# which scripts write. Unlike a current folder, which an agent picks, it is
# the install's choice, so a wide one stops every command with the reason.
# One that has gone is simply not granted, and the sidebar's server gets none.
reads=
if [ "$narrow" = 0 ] && [ -n "$READ_DIR" ] && reads=$(cd -P "$READ_DIR" 2>/dev/null && pwd -P); then
  too_wide "$reads" && fail "the folder this install lets scripts read, $READ_DIR, holds more than a task's files ($reads): reinstall with scripts/install-cli.sh --sandbox --read-dir <a folder such as ~/Downloads>, or --read-dir none"
  case $reads/ in "$works"/*) fail "the folder this install lets scripts read, $READ_DIR, is the working folder or inside it ($reads), where scripts write: reinstall with scripts/install-cli.sh --sandbox --read-dir <another folder>, or --read-dir none" ;; esac
else
  reads=
fi

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

# Node's permission model, inside the OS sandbox: no child processes,
# workers, add-ons, WASI or inspector, and files only where granted.
if [ "$grant" = 1 ]; then
  set -- --allow-fs-read="$work" "$CLI/sdk/bin/zenius" "$@"
  [ -z "$named" ] || set -- --allow-fs-read="$named" "$@"
else
  set -- "$CLI/sdk/bin/zenius" "$@"
fi
# The read and working folders by their real paths and as given, since a
# script names them as given (~/Downloads under a home that is itself a
# link).
if [ -n "$reads" ]; then
  set -- --allow-fs-read="$reads" "$@"
  [ "$READ_DIR" = "$reads" ] || set -- --allow-fs-read="$READ_DIR" "$@"
fi
set -- --allow-fs-read="$works" --allow-fs-write="$works" "$@"
[ "$wf" = "$works" ] || set -- --allow-fs-read="$wf" --allow-fs-write="$wf" "$@"
set -- --permission --allow-fs-read="$CLI" --allow-fs-read="$ZHOME/instances" --allow-fs-read="$sock" \
  --allow-fs-read="$box" --allow-fs-write="$box" "$@"

case @PLATFORM@ in
linux)
  # A new mount namespace that holds only the system, node, the CLI copy,
  # the registry, the instance's socket, the current and read folders (all
  # read-only), and the working folder and the run's temporary folder; and
  # new network, PID, IPC and user namespaces. The socket is bound as a file:
  # the folder holds every instance's. Later binds win, so the working
  # folder comes last: inside the current or read folder, it stays writable,
  # and a current folder inside it does too. Without a current folder, a
  # script starts in the working folder.
  set -- --bind "$works" "$works" "$node" "$@"
  [ "$wf" = "$works" ] || set -- --bind "$works" "$wf" "$@"
  if [ -n "$reads" ]; then
    set -- --ro-bind "$reads" "$reads" "$@"
    [ "$READ_DIR" = "$reads" ] || set -- --ro-bind "$reads" "$READ_DIR" "$@"
  fi
  if [ "$grant" = 1 ]; then
    set -- --ro-bind "$work" "$work" --chdir "$work" "$@"
    # So the name the shell gives it is there too, before the read and
    # working folders' binds, which win.
    [ -z "$named" ] || set -- --ro-bind "$work" "$named" "$@"
  else
    set -- --chdir "$works" "$@"
  fi
  set -- @BWRAP@ --ro-bind /usr /usr @SYSBINDS@ --ro-bind /etc /etc \
    --proc /proc --dev /dev --tmpfs /tmp \
    --ro-bind "$node_home" "$node_home" --ro-bind "$CLI" "$CLI" \
    --ro-bind-try "$registry" "$ZHOME/instances" --ro-bind-try "$sock" "$sock" \
    --bind "$box" "$box" --unshare-all --cap-drop ALL --new-session --die-with-parent "$@"
  ;;
macos)
  # sdk/sandbox/zenius.sb in the copy: reads, writes, processes and sockets.
  # Without a current folder a script starts in the working folder, as
  # bubblewrap's --chdir does on Linux.
  if [ "$grant" = 1 ]; then granted=$work; else granted=$box/no-current-folder; cd "$works"; fi
  set -- /usr/bin/sandbox-exec -f "$CLI/sdk/sandbox/zenius.sb" \
    -D "CLI=$CLI" -D "REGISTRY=$registry" -D "SOCK=$sock" -D "BOX=$box" -D "WORKING=$works" \
    -D "CURRENT=$granted" -D "READ=${reads:-$box/no-read-folder}" -D "NODE=$node" -D "NODE_HOME=$node_home" "$node" "$@"
  ;;
esac

# The task's source for the sidebar's list of tasks (globals.ts's taskSource):
# the hc terminal's id, if it's a plain one, and the current folder's name,
# never its path, even when the folder isn't granted. Both are display text,
# which the runtime keeps only within its label set.
case ${HC_TERMINAL_ID-} in '' | *[!A-Za-z0-9._-]*) terminal= ;; *) terminal=$HC_TERMINAL_ID ;; esac
[ ${#terminal} -le 64 ] || terminal=
folder=${work##*/}
# The sidebar's conversation id, which the UI gives the sidebar's zenius mcp
# (this launcher, on a sandboxed install): the sidebar matches on it, so it
# goes exactly as given or not at all. A script could set it itself, as it
# can any of the source, so it adds no reach.
case ${ZENIUS_SIDEBAR_TASK-} in '' | *[!A-Za-z0-9-]*) sidebar= ;; *) sidebar=$ZENIUS_SIDEBAR_TASK ;; esac
[ ${#sidebar} -le 64 ] || sidebar=

# What the server learns from here (docs/mcp.md, "script"): that it got the
# sidebar's grants, which it needs before it offers scripts to the sidebar,
# so an older launcher's wider grants never come with them; and the client's
# tool timeout in seconds, which the sidebar gives its server, as a whole
# number or not at all.
grants=
[ "$narrow" = 0 ] || grants=sidebar
case ${ZENIUS_TOOL_TIMEOUT-} in '' | *[!0-9]*) tool_timeout= ;; *) tool_timeout=$ZENIUS_TOOL_TIMEOUT ;; esac
[ ${#tool_timeout} -le 6 ] || tool_timeout=

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
exec /usr/bin/env -i HOME="$HOME" PATH=/usr/bin:/bin TMPDIR="$box" ZENIUS_WORKING_DIR="$wf" \
  ZENIUS_HOME="$ZHOME" ZENIUS_INSTANCE="$instance" ZENIUS_SOCKET="$sock" ZENIUS_NODE_MAJOR="$NODE_MAJOR" \
  NODE_DISABLE_COMPILE_CACHE=1 ${client:+"ZENIUS_CLIENT=$client"} ${reads:+"ZENIUS_READ_DIR=$READ_DIR"} \
  ${terminal:+"HC_TERMINAL_ID=$terminal"} ${folder:+"ZENIUS_FOLDER=$folder"} ${sidebar:+"ZENIUS_SIDEBAR_TASK=$sidebar"} \
  ${LANG+"LANG=$LANG"} ${LC_ALL+"LC_ALL=$LC_ALL"} ${LC_CTYPE+"LC_CTYPE=$LC_CTYPE"} \
  ${TERM+"TERM=$TERM"} ${TZ+"TZ=$TZ"} ${COLUMNS+"COLUMNS=$COLUMNS"} \
  ${NO_COLOR+"NO_COLOR=$NO_COLOR"} ${FORCE_COLOR+"FORCE_COLOR=$FORCE_COLOR"} \
  ${ZENIUS_TIMING+"ZENIUS_TIMING=$ZENIUS_TIMING"} \
  ${ZENIUS_TASK_SPACE+"ZENIUS_TASK_SPACE=$ZENIUS_TASK_SPACE"} \
  ${grants:+"ZENIUS_GRANTS=$grants"} ${tool_timeout:+"ZENIUS_TOOL_TIMEOUT=$tool_timeout"} \
  ${EGO_BROWSER_PAGE_BUDGET+"EGO_BROWSER_PAGE_BUDGET=$EGO_BROWSER_PAGE_BUDGET"} \
  ${EGO_BROWSER_RESPONSE_TIMEOUT_MS+"EGO_BROWSER_RESPONSE_TIMEOUT_MS=$EGO_BROWSER_RESPONSE_TIMEOUT_MS"} \
  "$@"
