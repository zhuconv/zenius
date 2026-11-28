#!/usr/bin/env bash
# Dev Zen instances for zenius: one profile per name, with this checkout's
# runtime copied in on every start, so editing runtime/ and restarting picks
# up the change.
#
#   scripts/zen-dev.sh <name> start [--headed]   create the profile if needed, launch, wait for the runtime
#                                     (--headed: a visible window that closes itself after
#                                     ZENIUS_HEADED_MAX_S seconds, default 1200; 0 = never)
#   scripts/zen-dev.sh <name> stop | restart [--headed] | status | log [-f] | path | reset
#   scripts/zen-dev.sh <name> work    the instance's working folder (below)
#   scripts/zen-dev.sh <name> quit    exit through the app, so Zen saves its session (stop kills)
#   scripts/zen-dev.sh <name> fresh   before a test run: reset on Linux; on the Mac keep the
#                                     profile (a first start there relaunches Zen and takes ~13 s)
#                                     unless ZENIUS_FRESH=1
#   scripts/zen-dev.sh <name> updates where Gecko keeps updates for this Zen's install, and
#                                     whether one is waiting there (then exit 3); starts nothing
#   scripts/zen-dev.sh --app path|status|remove
#                                     the Mac's dev copy of Zen.app: make it if needed and print
#                                     its zen binary; list the copies; remove every copy that no
#                                     Zen runs from
#
# The log, logs/<name>.log in ~/.zenius-dev, holds what Zen prints from its
# latest start; "log" prints it. Each earlier start's log is kept too: the
# core suite restarts Zen between tests, and a failing test's lines must
# outlive the starts after it. At each start the last log moves into
# logs/<name>/, named by the time its start began (UTC), as
# <YYYYMMDDTHHMMSSZ>.log; the ones before it are gzipped. An instance keeps
# its newest ZENIUS_KEEP_LOGS (default 50), and none stays past 3 days,
# whichever instance's it is.
#
# On the Mac a dev Zen never runs the user's Zen.app itself, but a copy with
# an identity of its own, made once per Zen version under
# ~/.zenius-dev/app.noindex/ (see ensure_dev_app). ZEN_APP=<app> copies
# another Zen.app than /Applications/Zen.app; ZEN_BIN=<binary> runs that
# binary as it is, with no copy, on either system.
#
# start refuses (exit 3) while an update is waiting in the install's update
# folder: every Zen started from the install applies it first, before it reads
# a profile or a pref, and on the Mac, with ZEN_BIN at the user's own Zen.app,
# that install is theirs.
# See refuse_waiting_update. Behind that guard, every dev Zen starts with
# MOZ_DISABLE_UPDATE_PROCESSING=1, which leaves a waiting update alone: an
# update that arrives after the check still isn't applied by a dev Zen.
# ZENIUS_START_WAIT_S=<s> start: how long to wait for the runtime before
#   stopping Zen (default 90 s, 40 s headed).
# ZENIUS_START_RETRIES=<n> start: how many times to start again after Zen dies
#   of a signal before the runtime is ready (default 3), or once after a start
#   that stalls before the runtime's first line. Both go in
#   ~/.zenius-dev/logs/startup-crashes.log; a stall also keeps its threads'
#   state beside it, in <name>-stall-<time>.txt.
#   Every dev profile but an installed one also gets
#   scripts/dev/startup-watch.uc.js, whose one line in the log says where a
#   window's startup stopped if it hasn't finished 30 s after the window's load.
# ZENIUS_DEV_METHODS=0 starts the profile without the dev.* methods (rubric C's live
# runs, tests/live/run.mjs: agent-written scripts reach the socket).
#
# ZENIUS_INSTALLED=1 start: run the runtime that scripts/install.sh put in the
# profile instead of copying this checkout's, and keep Zen's startup cache, as
# the daily Zen starts (for install tests).
#
# ZENIUS_AGENT_SCRIPTS=1 start: copy the agent's scripts too (the sidebar and
# the '>' dispatch, runtime/JS/agent-*: install.sh's COMPONENTS), which a dev
# profile leaves out otherwise, so every other suite's Zen runs zenius alone.
#
# ZENIUS_DEV_PREFS=<file> start: append that file's user_pref() lines to the
# profile's user.js, after the defaults below, so they win. For example
# browser.startup.page 3, which restores the previous session as the user's
# daily Zen does (the default 0 starts each run clean).
#
# ZENIUS_DEV_DEFAULT_PREFS="<pref> ..." start: leave those prefs at Zen's own
# default, as an untouched daily profile has them: their lines are dropped
# from user.js and prefs.js. user_pref() can't do that, since a value read from
# user.js stays a user value even when it equals the default (for example
# browser.startup.page, whose default in Zen 1.24.3b is 3).
#
# ZENIUS_HOME=<dir>: the zenius home where the instance keeps its socket,
# registry entry, state and self-check. It can't be the account's own
# ~/.zenius, which holds the user's config and their daily Zen's socket:
# start and restart refuse it (an unset ZENIUS_HOME with the account's HOME
# too), and nothing here reads or removes anything in it. By hand, give it
# one of its own, and the same to its clients: export ZENIUS_HOME=$(mktemp -d
# /tmp/zh-XXXXXX) (/tmp: a socket's path must fit in 104 bytes on macOS),
# removed after the stop. scripts/test-all.sh gives each suite one, and a
# suite's run.sh makes one when its caller gave none.
#
# ZENIUS_DEV_WORKING_DIR=<dir> start: the instance's working folder, where its
# finished downloads land (absolute; made 0700 if missing). By default it's
# zenius-dev-<uid>/<name> in the caller's TMPDIR (/tmp), made 0700, and fresh
# and reset remove it. A dev profile's runtime reads its pref,
# zenius.dev.workingFolder, never ~/.zenius/config.json, and what Zen starts
# gets ZENIUS_WORKING_DIR, which the CLI takes before that config, with this
# checkout's sdk/bin first on PATH, so its `zenius` is the plain CLI: no dev
# or test run reaches the user's own working folder. It can't be inside
# ~/.zenius-dev, which the agent's scripts must not reach.
#
# Never point this at the user's daily profile: it always uses ~/.zenius-dev/profiles/<name>.
set -euo pipefail

if [[ ${1:-} == --app ]]; then
  # No profile: a name can't start with "-".
  NAME=
  CMD=--app
  shift
else
  NAME=${1:?usage: zen-dev.sh <name> start|stop|quit|restart|status|log|path|reset|fresh|updates, or zen-dev.sh --app path|status|remove}
  CMD=${2:-start}
  shift 2 || shift $#
  [[ $NAME =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo "name must match [a-z0-9][a-z0-9_-]*" >&2; exit 2; }
  [[ $NAME == default ]] && { echo "'default' is reserved for the user's daily browser" >&2; exit 2; }
fi

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# A ZENIUS_DEV_HOME whose real path isn't ~/.zenius-dev's gives a Zen without
# the dev.* methods: the runtime turns them on only in a profile under the
# real ~/.zenius-dev/profiles/ (readSettings in modules/util.sys.mjs).
DEV=${ZENIUS_DEV_HOME:-$HOME/.zenius-dev}
PROFILE=$DEV/profiles/$NAME
PIDFILE=$DEV/run/$NAME.pid
WATCHDOG=$DEV/run/$NAME.watchdog
LOG=$DEV/logs/$NAME.log
# Earlier starts' logs (keep_log).
KEPT_LOGS=$DEV/logs/$NAME
CRASH_LOG=$DEV/logs/startup-crashes.log
CRASH_SIGNAL=
CRASH_WHAT=
STALL_FILE=
if [[ $(uname) == Darwin ]]; then
  # Empty: the dev copy of Zen.app, made when a command needs it (need_zen).
  ZEN=${ZEN_BIN:-}
else
  ZEN=${ZEN_BIN:-$HOME/opt/zen-1.24.3b/zen}
fi
READY_MARK="[zenius] window loaded, instance=$NAME"
mkdir -p "$DEV/profiles" "$DEV/run" "$DEV/logs"
# On Linux, Zen's temporary folder is one of this instance's own, emptied
# before each launch and removed at stop. Tests stop Zen at any moment, and
# what it was downloading then (the intermediate certificates, 4 MB, soon
# after a fresh profile starts) would otherwise stay in the machine's shared
# /tmp. The Mac keeps Zen's own: a per-user folder that the system empties,
# and the one Zen's content sandbox there allows.
ZEN_TMP=
[[ $(uname) == Linux ]] && ZEN_TMP=$DEV/tmp/$NAME
# The instance's working folder (ZENIUS_DEV_WORKING_DIR above).
WORK_PARENT=${TMPDIR:-/tmp}
WORK_PARENT=${WORK_PARENT%/}/zenius-dev-$(id -u)
WORK=${ZENIUS_DEV_WORKING_DIR:-$WORK_PARENT/$NAME}
[[ $WORK == / ]] || WORK=${WORK%/}
# zenius's home for this instance, where the runtime keeps its socket,
# registry entry, state and self-check: ZENIUS_HOME, else $HOME/.zenius. It
# must never be the account's own ~/.zenius, which holds the user's config
# and their daily Zen's socket: no test or dev Zen may touch the user's
# config or files. So start refuses it, and nothing here reads or removes
# anything in it. The account's home is its passwd entry's (account_zhome),
# not $HOME, which a caller may point at a scratch home; with one, an unset
# ZENIUS_HOME is fine. tests/lib/scratch-home.mjs's guardHome keeps the same
# rule for tests, scripts/test-all.sh gives each suite a zenius home of its
# own, and a suite's run.sh makes one when its caller gave none.
ZHOME=${ZENIUS_HOME:-$HOME/.zenius}
# Named to the Zen and the clients this starts, so they keep to the folder
# checked here: left unset, the runtime takes Gecko's home folder, which on
# macOS needn't follow HOME.
export ZENIUS_HOME=$ZHOME
# The path with every link resolved, up to its deepest folder that exists;
# the parts below that, which don't exist yet, as written.
real_path() {
  local p=$1 rest= real
  while [[ ! -d $p && $p == */* ]]; do
    rest=/$(basename -- "$p")$rest
    p=$(dirname -- "$p")
  done
  if [[ -d $p ]] && real=$(cd -P -- "$p" 2>/dev/null && pwd -P); then p=${real%/}; fi
  printf '%s%s\n' "$p" "$rest"
}
# Whether ZHOME is the account's own home, its .zenius, or inside that.
account_zhome() {
  local user home= zreal oreal
  # The account's passwd entry: getent's, by uid, where there's one (Linux,
  # whose account names may hold an @), else bash's ~user, which reads the
  # same entry for a name with only these characters, safe to expand.
  if command -v getent >/dev/null 2>&1; then
    home=$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6) || home=
  fi
  if [[ $home != /* ]]; then
    user=$(id -un 2>/dev/null) || user=
    if [[ $user =~ ^[A-Za-z0-9._@][A-Za-z0-9._@-]*$ ]]; then eval "home=~$user"; fi
  fi
  # No entry found (a name ~ can't expand stays "~name"): then HOME is all
  # there is.
  [[ $home == /* ]] || home=$HOME
  home=$(real_path "$home")
  oreal=$(real_path "${home%/}/.zenius")
  zreal=$(real_path "$ZHOME")
  [[ $zreal == "$home" || $zreal == "$oreal" || $zreal == "$oreal"/* ]]
}
refuse_account_zhome() {
  account_zhome || return 0
  echo "zen-dev.sh: $NAME's zenius home, $ZHOME, is the account's own ~/.zenius or in it: give the dev Zen one of its own, as scripts/test-all.sh and the suites' run.sh do, with export ZENIUS_HOME=\$(mktemp -d /tmp/zh-XXXXXX) before it starts (remove that folder after its stop), or run a suite through its run.sh or scripts/test-all.sh <suite>" >&2
  exit 1
}

# Is the pid file's process alive? Only for the launch, which wrote it a
# moment ago: anything that signals a pid asks ours/our_pid first.
# Is this pid a live process? kill -0 also succeeds on a zombie, and a Zen
# that has exited but isn't reaped yet runs nothing and holds no profile: a
# start right after a stop must not take it for the profile's Zen.
alive() {
  local stat
  [[ ${1:-} =~ ^[1-9][0-9]*$ ]] && kill -0 "$1" 2>/dev/null || return 1
  stat=$(ps -o stat= -p "$1" 2>/dev/null) || return 1
  [[ $stat != *Z* ]]
}

running() { [[ -f $PIDFILE ]] && alive "$(cat "$PIDFILE")"; }

# Does this pid hold the profile's lock? A running Zen keeps .parentlock
# open, fcntl-locked. The "lock" symlink is no proof: a Zen killed by a
# signal leaves it, and the pid it names can be any process's later, the
# user's daily Zen included. An open file's path comes back with symlinks
# resolved (Linux's /proc and the Mac's lsof alike: the Mac's temp folders
# under /var/folders are /private/var/folders), so it's compared with the
# profile's real path as well as the path as given (the eval harness's fix).
holds_lock() {
  local pid=$1 fd path files real
  real=$(cd "$PROFILE" 2>/dev/null && pwd -P) || real=
  if [[ -d /proc/$pid/fd ]]; then
    for fd in /proc/"$pid"/fd/*; do
      path=$(readlink "$fd" 2>/dev/null) || continue
      [[ $path == "$PROFILE/.parentlock" || ( -n $real && $path == "$real/.parentlock" ) ]] && return 0
    done
    return 1
  fi
  command -v lsof >/dev/null || return 1
  # lsof exits 1 when the pid has no such file: not an error here (set -e).
  files=$'\n'$(lsof -a -p "$pid" -Fn 2>/dev/null || true)$'\n'
  [[ $files == *$'\n'n"$PROFILE/.parentlock"$'\n'* || ( -n $real && $files == *$'\n'n"$real/.parentlock"$'\n'* ) ]]
}

# The pid the profile's lock symlink names ("lock -> 127.0.1.1:+<pid>"), if
# that process holds the lock: a Zen that relaunched itself (a safe-mode
# relaunch has no argv; the profile is in its environment).
lock_pid() {
  local pid
  [[ -L $PROFILE/lock ]] || return 0
  pid=$(readlink "$PROFILE/lock" | sed -n 's/.*:+\([0-9][0-9]*\)$/\1/p')
  if alive "$pid" && holds_lock "$pid"; then echo "$pid"; fi
}

# Is this pid this profile's main Zen? Its command line names the profile
# (exact arguments, so "x" never matches "x-2"), or it holds the profile's
# lock. A pid read from a file can be stale and reused by any process, the
# user's daily Zen included, since pids get recycled: never signal one that
# isn't ours.
ours() {
  local pid=${1:-} args
  alive "$pid" || return 1
  args=$(ps -o command= -p "$pid" 2>/dev/null) || return 1
  if [[ $args != *-contentproc* ]] && awk -v p="$PROFILE" '
      { for (i = 1; i < NF; i++) if ($i == "--profile" && $(i + 1) == p) found = 1 }
      END { exit !found }' <<<"$args"; then
    return 0
  fi
  [[ $(lock_pid) == "$pid" ]]
}

# This profile's running Zen, or nothing: the pid file's pid if it is ours,
# else the one found by the profile's path (a Zen that relaunched itself).
# A pid file that names another live process says so and is left alone.
our_pid() {
  local pid=
  [[ -f $PIDFILE ]] && pid=$(cat "$PIDFILE")
  if [[ -n $pid ]] && ! alive "$pid"; then
    pid=
  elif [[ -n $pid ]] && ! ours "$pid"; then
    echo "zen-dev.sh: $PIDFILE names pid $pid, which is not $NAME's Zen ($(ps -o command= -p "$pid" 2>/dev/null | cut -c1-160)); not signalling it" >&2
    pid=
  fi
  [[ -n $pid ]] || pid=$(profile_pid)
  echo "$pid"
}

# The main Zen process for this profile, found by its argv. On a fresh
# profile the Mac build relaunches itself (new pid, parent 1), so the pid we
# started is not always the one that runs.
profile_pid() {
  # Exact argv tokens, so profile "x" never matches profile "x-2".
  local pid
  pid=$(ps -axo pid=,args= | awk -v p="$PROFILE" '
    index($0, "-contentproc") == 0 {
      for (i = 2; i < NF; i++) if ($i == "--profile" && $(i + 1) == p) { print $1; exit }
    }')
  # A safe-mode relaunch has no argv at all (the profile is in its
  # environment), but it holds the profile lock.
  [[ -n $pid ]] || pid=$(lock_pid)
  echo "$pid"
}

ensure_program_files() {
  # fx-autoconfig needs two files next to the Zen binary. The Mac's dev copy
  # has this checkout's (make_dev_app); the user's own Zen.app, which ZEN_BIN
  # may name, has the user's, and we never modify it. A Linux tarball install
  # gets them here.
  local appdir; appdir=$(dirname "$ZEN")
  [[ $(uname) == Darwin ]] && appdir=$(cd "$appdir/../Resources" && pwd)
  if [[ ! -f $appdir/config.js ]]; then
    [[ $(uname) == Darwin ]] && { echo "fx-autoconfig is missing from $appdir; ask the user (never modify Zen.app yourself)" >&2; exit 1; }
    cp "$ROOT/runtime/vendor/fx-autoconfig/program/config.js" "$appdir/"
    mkdir -p "$appdir/defaults/pref"
    cp "$ROOT/runtime/vendor/fx-autoconfig/program/defaults/pref/config-prefs.js" "$appdir/defaults/pref/"
  fi
  # A Linux tarball install (the Linux server's) is ours, so an enterprise policy can turn
  # update checks off for every dev profile; on the Mac, user.js only defers
  # them. See the update prefs in ensure_profile.
  if [[ $(uname) != Darwin && -w $appdir && ! -e $appdir/distribution/policies.json ]]; then
    mkdir -p "$appdir/distribution"
    printf '{\n  "policies": {\n    "DisableAppUpdate": true\n  }\n}\n' >"$appdir/distribution/policies.json"
  fi
}

# Gecko's update folder for the install of the Zen binary $2, on platform $1
# (uname's name): nsXREDirProvider::GetUpdateRootDir. On the Mac it is
# ~/Library/Caches/<Vendor>/updates/ plus the path of the binary's folder, cut
# at its last ".app" (the user's own Zen's for /Applications/Zen.app:
# .../updates/Applications/Zen). Elsewhere it is the install's own folder.
update_root() {
  local platform=$1 bin=$2 target dir ini vendor app
  # The binary's real folder, as Gecko finds it.
  while [[ -L $bin ]]; do
    target=$(readlink "$bin")
    if [[ $target == /* ]]; then bin=$target; else bin=$(dirname "$bin")/$target; fi
  done
  dir=$(cd -P "$(dirname "$bin")" 2>/dev/null && pwd -P) || return 1
  if [[ $platform != Darwin ]]; then
    echo "$dir"
    return
  fi
  ini=$dir/../Resources/application.ini
  vendor=$(sed -n 's/^Vendor=//p' "$ini" 2>/dev/null | head -1 || true)
  [[ -n $vendor ]] || vendor=$(sed -n 's/^Name=//p' "$ini" 2>/dev/null | head -1 || true)
  [[ -n $vendor ]] || vendor=Mozilla
  app=${dir%.app*}
  echo "$HOME/Library/Caches/$vendor/updates/${app#/}"
}

# The update waiting in update folder $1, as "<update.status>, version <v>",
# or nothing (status 1) when there is none to apply. Gecko 160's states
# (UpdateService.sys.mjs): null, downloading, pending, pending-service,
# pending-elevate, applying, applied, applied-service, succeeded,
# download-failed and "failed: <code>". Zen applies pending and applied ones
# at startup (nsUpdateDriver's ProcessUpdates); the others mean an update is
# on its way. A state this doesn't know, or a status file it can't read,
# counts as waiting.
waiting_update() {
  local dir=$1/updates/0 status= version=
  if [[ -f $dir/update.status ]]; then
    if [[ -r $dir/update.status ]]; then
      IFS= read -r status <"$dir/update.status" || true
      status=${status%$'\r'}
    else
      status="unreadable update.status"
    fi
  fi
  case $status in
    "" | null | succeeded | download-failed | failed | "failed:"*) status= ;;
  esac
  # A download in progress sits in updates/downloading; update.status then
  # describes the update before it, if any.
  if [[ -z $status && -e $1/updates/downloading/update.mar ]]; then status=downloading; fi
  [[ -n $status ]] || return 1
  if [[ -r $dir/update.version ]]; then IFS= read -r version <"$dir/update.version" || true; fi
  echo "$status${version:+, version $version}"
}

# Never start a Zen whose install has an update waiting. On 2026-11-20 the
# user's own Zen staged 1.24.3b; a dev
# Zen started from /Applications/Zen.app then tried to switch the app to it,
# which asked for an admin password (SMJobBless), and hung until this
# script's timeout. Only the user applies an update to their Zen, by quitting
# and reopening it. This reads the folder and never changes it.
refuse_waiting_update() {
  local root what install
  if ! root=$(update_root "$(uname)" "$ZEN"); then
    echo "zen-dev.sh: not starting $NAME: can't find the folder of $ZEN to check it for a waiting update" >&2
    exit 3
  fi
  what=$(waiting_update "$root") || return 0
  install=$(cd -P "$(dirname "$ZEN")" && pwd -P)
  [[ $(uname) == Darwin ]] && install=${install%/Contents/MacOS}
  {
    echo "zen-dev.sh: not starting $NAME: an update is waiting for the Zen at $install ($what), in"
    echo "  $root/updates/0"
    echo "Every Zen started from that install, a dev Zen too, first tries to apply it, before it reads a profile or a pref."
    if [[ $(uname) == Darwin ]]; then
      echo "On the Mac that replaces the user's Zen.app and asks for an admin password."
      echo "The user applies it by quitting and reopening their own Zen. Start again once they have (zenius then runs on that version)."
    else
      echo "That would change the install under every dev Zen that uses it: ask its owner whether to apply it or remove it."
    fi
    echo "zen-dev.sh leaves that folder as it is."
  } >&2
  exit 3
}

updates() {
  local root what
  need_zen
  root=$(update_root "$(uname)" "$ZEN") || { echo "can't find the folder of $ZEN" >&2; return 3; }
  echo "Zen: $ZEN"
  echo "update folder: $root/updates/0"
  if what=$(waiting_update "$root"); then
    echo "waiting: $what (start refuses)"
    return 3
  fi
  echo "nothing waiting (start goes ahead)"
}

# The Mac's dev copy of Zen.app. A Zen started from /Applications/Zen.app is,
# to macOS, the user's own Zen: while one runs, even headless, opening Zen
# from the Dock only brings it forward (see other_zens in install.sh), and it
# shares Zen's macOS settings and privacy grants. So on the Mac a dev Zen
# runs a copy of the app with an identity of its own:
# - its own bundle id and name, and no claim on web links or files, so macOS
#   never takes it for the user's Zen or offers it as a browser;
# - its own Profile and RemotingName in application.ini, so even a start
#   without --profile never opens the user's profiles;
# - this checkout's fx-autoconfig program files, and an update policy;
# - an ad hoc signature on its top level only. --deep would rewrite every
#   binary in the app, and under the hardened runtime the ad hoc main binary
#   couldn't load Zen's XUL (another Team ID). The nested code keeps Zen's
#   signatures, so web content runs in Zen's own plugin-container.
# The copy is an APFS clone, which shares the app's blocks: only the files an
# edit or the signature rewrites take space, a few MB. Each Zen version gets
# its own copy, and a copy that no process runs from goes.
DEV_APP_ID=io.github.zhuconv.zenius.zen-dev
DEV_APP_NAME="zenius Dev Zen"
DEV_APP_PROFILE=zen-dev
# Raise it when make_dev_app makes the copy differently, so that each Mac
# makes it again.
DEV_APP_RECIPE=1
DEV_APP_SOURCE=${ZEN_APP:-/Applications/Zen.app}
# Spotlight leaves out a folder named *.noindex, so the copy isn't offered as
# an app.
DEV_APPS=$DEV/app.noindex
DEV_APP=
DEV_APP_TMP=
DEV_APP_LOCKED=

# The Zen binary to run: ZEN_BIN's, Linux's default, or on the Mac this Zen
# version's dev copy, made now if it isn't there yet.
need_zen() {
  if [[ -z $ZEN ]]; then
    ensure_dev_app
    ZEN=$DEV_APP/Contents/MacOS/zen
  fi
}

sha256() { if command -v shasum >/dev/null; then shasum -a 256; else sha256sum; fi | cut -d' ' -f1; }

# The copy's folder name: the app's BuildID, and a hash of what else makes
# the copy, so that a new Zen version, a new recipe or new loader files make a
# new one.
dev_app_key() {
  local ini=$DEV_APP_SOURCE/Contents/Resources/application.ini build hash
  build=$(sed -n 's/^BuildID=\([0-9]*\).*/\1/p' "$ini" 2>/dev/null | head -1 || true)
  if [[ ! $build =~ ^[0-9]{8,20}$ ]]; then
    echo "zen-dev.sh: no BuildID in $ini; is $DEV_APP_SOURCE a Zen app? (ZEN_APP names another, ZEN_BIN runs a Zen binary as it is)" >&2
    return 1
  fi
  hash=$({
    printf '%s\n' "$DEV_APP_RECIPE" "$DEV_APP_ID" "$DEV_APP_NAME" "$DEV_APP_PROFILE"
    cat "$ROOT/runtime/vendor/fx-autoconfig/program/config.js" "$ROOT/runtime/vendor/fx-autoconfig/program/defaults/pref/config-prefs.js"
  } | sha256)
  echo "$build-${hash:0:12}"
}

# Sets DEV_APP to this Zen version's dev copy, made now if it isn't there yet,
# and removes the copies of other versions that no process runs from.
ensure_dev_app() {
  if [[ ! -d $DEV_APP_SOURCE/Contents/MacOS ]]; then
    echo "zen-dev.sh: no Zen app at $DEV_APP_SOURCE to copy for dev Zens (ZEN_APP names another, ZEN_BIN runs a Zen binary as it is)" >&2
    exit 1
  fi
  local key copies
  key=$(dev_app_key)
  DEV_APP=$DEV_APPS/$key/zenius-dev-zen.app
  copies=("$DEV_APPS"/*/ready)
  if [[ -f $DEV_APPS/$key/ready && ${#copies[@]} == 1 ]]; then return 0; fi
  (umask 077 && mkdir -p "$DEV_APPS")
  chmod 700 "$DEV_APPS"
  trap dev_app_unlock EXIT
  dev_app_lock
  [[ -f $DEV_APPS/$key/ready ]] || make_dev_app "$key"
  remove_dev_apps "$key" || true
  dev_app_unlock
  trap - EXIT
}

# One start makes the copy while the others wait: a test run starts several
# dev Zens at once. The lock is flock(2) on the file .lock, held through this
# shell's fd 9. Perl takes it on the open file that fd shares with it, so it
# outlives Perl. The kernel drops it with its holder, a start killed while it
# made the copy included, so no start ever judges a lock dead and removes it:
# with a pid in a folder, one could remove another start's lock taken in the
# meantime. The holder removes the file before it lets go, and a start that
# then gets the lock, on a file no longer at .lock, tries again. Perl waits
# for the lock itself, so a waiting start goes on as soon as it's free.
dev_app_lock() {
  local lock=$DEV_APPS/.lock got pid= end=$((SECONDS + 300))
  command -v perl >/dev/null || { echo "zen-dev.sh: the dev copy's lock needs perl" >&2; exit 1; }
  while ((SECONDS < end)); do
    if [[ -d $lock ]]; then
      # An older zen-dev.sh's lock, a folder with its pid.
      pid=$(cat "$lock/pid" 2>/dev/null || true)
      if [[ -n $pid ]] && ! alive "$pid"; then rm -rf "$lock"; else sleep 0.25; fi
      continue
    fi
    (umask 077 && mkdir -p "$DEV_APPS")
    if ! exec 9>>"$lock"; then
      sleep 0.25
      continue
    fi
    got=$(perl -MFcntl=:flock -e '
      open(my $fh, ">&=", 9) or die "zen-dev.sh: fd 9: $!\n";
      $SIG{ALRM} = sub { print "busy"; exit };
      alarm $ARGV[1];
      flock($fh, LOCK_EX) or do { print "busy"; exit };
      alarm 0;
      my @fd = stat($fh);
      my @path = stat($ARGV[0]);
      print(@path && $fd[0] == $path[0] && $fd[1] == $path[1] ? "held" : "moved");
    ' "$lock" "$((end > SECONDS ? end - SECONDS : 1))" || true)
    if [[ $got == held ]]; then
      DEV_APP_LOCKED=1
      return 0
    fi
    exec 9>&-
    [[ $got == moved ]] || sleep 0.25
  done
  echo "zen-dev.sh: $lock has been held for 5 minutes${pid:+ by an older zen-dev.sh, pid $pid}; a zen-dev.sh is still making the dev copy, or is stuck" >&2
  exit 1
}

dev_app_unlock() {
  if [[ -n $DEV_APP_TMP ]]; then rm -rf "$DEV_APP_TMP"; fi
  DEV_APP_TMP=
  if [[ -n $DEV_APP_LOCKED ]]; then
    rm -f "$DEV_APPS/.lock"
    exec 9>&-
  fi
  DEV_APP_LOCKED=
}

avail_kb() { df -Pk "$1" | awk 'NR == 2 { print $4 }'; }

# Makes the copy for key $1: in a folder of its own beside the others, which
# takes the key's name only once the copy is whole.
make_dev_app() {
  local key=$1 src app before after plist ini res k
  src=$(cd -P "$DEV_APP_SOURCE" && pwd -P)
  # The maker's pid in the folder's name, from the start: remove_dev_apps
  # leaves the half-made copy of a maker that still runs.
  DEV_APP_TMP=$(mktemp -d "$DEV_APPS/.make.$$.XXXXXX")
  app=$DEV_APP_TMP/zenius-dev-zen.app
  echo "zen-dev.sh: making the dev copy of $src for this Zen version, in $DEV_APPS/$key" >&2
  before=$(avail_kb "$DEV_APPS")
  cp -cR "$src" "$app"
  after=$(avail_kb "$DEV_APPS")
  # A clone takes no space; a real copy takes the app's whole size (about
  # 0.6 GB), again for each Zen version.
  if ((before - after > 200 * 1024)); then
    echo "zen-dev.sh: the copy of $src took $(((before - after) / 1024)) MB, so it isn't an APFS clone (another volume, or not APFS); not keeping it. ZEN_BIN runs a Zen binary as it is" >&2
    exit 3
  fi
  # Every write below goes into the copy, never through a link into the app:
  # the copy is a folder of its own, and nothing below writes or removes in
  # it through a link, at the path or in a folder on the way there.
  if [[ -L $app || $(cd -P "$app" && pwd -P) != "$(cd -P "$DEV_APP_TMP" && pwd -P)/zenius-dev-zen.app" ]]; then
    echo "zen-dev.sh: the copy at $app isn't a folder of its own; not touching it" >&2
    exit 1
  fi
  for k in "$app"/Contents{,/Info.plist,/embedded.provisionprofile,/_CodeSignature,/_CodeSignature/CodeResources,/MacOS,/MacOS/zen,/Resources,/Resources/application.ini,/Resources/config.js,/Resources/defaults,/Resources/defaults/pref,/Resources/defaults/pref/config-prefs.js,/Resources/distribution,/Resources/distribution/policies.json} "$app"/Contents/Resources/*.lproj; do
    if [[ -L $k ]]; then
      echo "zen-dev.sh: ${k#"$app"/} in $src is a link, so a write in the copy could reach what it points to; not copying it" >&2
      exit 1
    fi
  done
  # Gatekeeper checks an app that carries the quarantine attribute, and would
  # refuse the now ad hoc copy.
  # -s: on a link's own entry, never on what it points to.
  xattr -drs com.apple.quarantine "$app" 2>/dev/null || true
  if xattr -p com.apple.quarantine "$app" >/dev/null 2>&1; then
    echo "zen-dev.sh: can't take the quarantine attribute off $app" >&2
    exit 1
  fi
  # Its own identity, and a name that says whose copy it is in any prompt or
  # list. A localized name would stand in for it.
  plist=$app/Contents/Info.plist
  plutil -replace CFBundleIdentifier -string "$DEV_APP_ID" "$plist"
  plutil -replace CFBundleName -string "$DEV_APP_NAME" "$plist"
  plutil -replace CFBundleDisplayName -string "$DEV_APP_NAME" "$plist"
  rm -f "$app"/Contents/Resources/*.lproj/InfoPlist.strings
  # No claim on web links, files or services: macOS never offers the copy as
  # a browser or as an app to open a file with.
  for k in CFBundleURLTypes CFBundleDocumentTypes UTExportedTypeDeclarations UTImportedTypeDeclarations NSServices; do
    if plutil -extract "$k" xml1 -o - "$plist" >/dev/null 2>&1; then plutil -remove "$k" "$plist"; fi
  done
  # Zen's provisioning profile backs Zen's own restricted entitlement (macOS
  # passkeys). The ad hoc copy claims no entitlement, so it has no use for it.
  rm -f "$app/Contents/embedded.provisionprofile"
  # Its own folder for profiles under ~/Library/Application Support and its
  # own name for remote commands: even a start without --profile never opens
  # the user's profiles, and a launch of one app never reaches the other.
  ini=$app/Contents/Resources/application.ini
  awk -v v="$DEV_APP_PROFILE" '
    function add() { if (app && !p) print "Profile=" v; if (app && !r) print "RemotingName=" v }
    /^\[/ { add(); app = ($0 == "[App]"); p = r = 0; print; next }
    app && /^Profile=/ { print "Profile=" v; p = 1; next }
    app && /^RemotingName=/ { print "RemotingName=" v; r = 1; next }
    { print }
    END { add() }' "$ini" >"$ini.new"
  mv "$ini.new" "$ini"
  if ! grep -qx "Profile=$DEV_APP_PROFILE" "$ini" || ! grep -qx "RemotingName=$DEV_APP_PROFILE" "$ini"; then
    echo "zen-dev.sh: $ini has no [App] section to give the copy a profile folder of its own" >&2
    exit 1
  fi
  # This checkout's fx-autoconfig program files, as on Linux: dev Zens don't
  # wait for the user to put config.js back after a Zen update.
  res=$app/Contents/Resources
  mkdir -p "$res/defaults/pref" "$res/distribution"
  rm -f "$res/config.js" "$res/defaults/pref/config-prefs.js"
  cp "$ROOT/runtime/vendor/fx-autoconfig/program/config.js" "$res/config.js"
  cp "$ROOT/runtime/vendor/fx-autoconfig/program/defaults/pref/config-prefs.js" "$res/defaults/pref/config-prefs.js"
  # No update checks, as on Linux, beside any policy Zen ships. The copy's
  # update folder is its own anyway: update_root names it after the copy's
  # path.
  command -v node >/dev/null || { echo "zen-dev.sh: making the dev copy needs node on PATH" >&2; exit 1; }
  node -e '
    const fs = require("fs");
    const [file] = process.argv.slice(1);
    let json = {};
    try {
      json = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
    json.policies = { ...(json.policies ?? {}), DisableAppUpdate: true };
    fs.writeFileSync(`${file}.new`, `${JSON.stringify(json, null, 2)}\n`);
  ' "$res/distribution/policies.json"
  mv "$res/distribution/policies.json.new" "$res/distribution/policies.json"
  # codesign refuses a bundle that carries Finder information or a resource
  # fork ("resource fork, Finder information, or similar detritus not
  # allowed"). The clone keeps the Finder information of Zen.app's folder and
  # of its Icon\r file, and that file's resource fork. Each attribute goes
  # from those by name first, so that neither rests on how xattr -r goes on
  # past a file without it, then from the whole copy.
  for k in com.apple.FinderInfo com.apple.ResourceFork; do
    xattr -ds "$k" "$app" 2>/dev/null || true
    if [[ -e $app/Icon$'\r' ]]; then xattr -ds "$k" "$app/Icon"$'\r' 2>/dev/null || true; fi
    xattr -drs "$k" "$app" 2>/dev/null || true
  done
  if ! codesign --force --sign - "$app"; then
    echo "zen-dev.sh: codesign refused the copy at $app; xattr -lr on it shows what the copy carries" >&2
    exit 1
  fi
  codesign --verify --deep --strict "$app"
  # Time Machine would back up each version's copy as a whole app.
  if command -v tmutil >/dev/null && ! tmutil addexclusion "$DEV_APPS" >/dev/null 2>&1; then
    echo "zen-dev.sh: couldn't keep $DEV_APPS out of Time Machine (tmutil addexclusion)" >&2
  fi
  printf 'source=%s\nkey=%s\nmade=%s\n' "$src" "$key" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$DEV_APP_TMP/ready"
  if [[ -f $DEV_APPS/$key/ready ]]; then
    # Another start made this version's copy meanwhile, as two starts can
    # when both took over a dead start's lock: keep that one, which a dev
    # Zen may already run from.
    rm -rf "$DEV_APP_TMP"
  else
    rm -rf "${DEV_APPS:?}/$key"
    mv "$DEV_APP_TMP" "$DEV_APPS/$key"
  fi
  DEV_APP_TMP=
}

# Does a process run from copy folder $1? A dev Zen and its content
# processes all run binaries inside its copy.
dev_app_in_use() {
  local dir real args
  dir=$1
  real=$(cd -P "$dir" 2>/dev/null && pwd -P) || real=$dir
  while IFS= read -r args; do
    args=${args#"${args%%[![:space:]]*}"}
    [[ $args == "$dir/"* || $args == "$real/"* ]] && return 0
  done < <(ps -axo args= 2>/dev/null)
  return 1
}

# Removes every copy but key $1's that no process runs from (a dev Zen keeps
# its copy until it stops), with LaunchServices's records of it and Gecko's
# update folder for it. Says which it keeps, and returns 1 if it kept any.
remove_dev_apps() {
  local keep=${1:-} dir tool real app made pid kept=0
  tool=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  [[ -x $tool ]] || tool=$(command -v lsregister || true)
  real=$(cd -P "$DEV_APPS" 2>/dev/null && pwd -P) || real=
  for dir in "$DEV_APPS"/*/; do
    dir=${dir%/}
    [[ -d $dir && ${dir##*/} != "$keep" ]] || continue
    if dev_app_in_use "$dir"; then
      echo "zen-dev.sh: keeping $dir while a Zen runs from it" >&2
      kept=1
      continue
    fi
    # LaunchServices keeps a record of the copy, and one of each app inside
    # it that has run: plugin-container.app, under Zen's own id, once content
    # processes start. -u on the copy leaves the others, so each goes by its
    # own path, the copy's included, while the files are there.
    if [[ -n $tool && -d $dir/zenius-dev-zen.app ]]; then
      while IFS= read -r -d '' app; do
        "$tool" -u "$app" >/dev/null 2>&1 || true
      done < <(find "$dir/zenius-dev-zen.app" -type d -name '*.app' -print0 2>/dev/null)
    fi
    rm -rf "$dir"
    remove_update_folders "$real" "${dir##*/}"
  done
  # Half-made copies of starts that were killed. Each folder's name holds its
  # maker's pid (make_dev_app), and one whose maker still runs stays: an
  # older zen-dev.sh, whose lock a start could take over from another that
  # still ran, could have two makers at once.
  for made in "$DEV_APPS"/.make.*; do
    [[ -d $made ]] || continue
    pid=${made##*/.make.}
    pid=${pid%%.*}
    if [[ $pid =~ ^[0-9]+$ && $pid != "$$" ]] && kill -0 "$pid" 2>/dev/null; then
      continue
    fi
    rm -rf "$made"
  done
  return "$kept"
}

# Gecko makes an update folder for each install it runs from, even with
# updates off: ~/Library/Caches/<Vendor>/updates/ plus the install's real
# path, cut at its last ".app" (update_root). So the copy at
# <copies>/<key>/zenius-dev-zen.app has .../updates/<copies>/<key>/zenius-dev-zen.
# Removes key $2's under the copies' real folder $1, or every copy's with no
# $2, then the folders above it left empty, up to updates/.
remove_update_folders() {
  local real=$1 key=${2:-} top upd
  [[ $real == /*/app.noindex ]] || return 0
  for top in "$HOME"/Library/Caches/*/updates; do
    upd=$top$real${key:+/$key}
    [[ -d $upd ]] || continue
    rm -rf "$upd"
    upd=${upd%/*}
    while [[ $upd == "$top"/* ]] && rmdir "$upd" 2>/dev/null; do upd=${upd%/*}; done
  done
}

dev_app_command() {
  if [[ $(uname) != Darwin ]]; then
    echo "zen-dev.sh --app: only the Mac runs a dev copy of Zen.app; dev Zens here run $ZEN" >&2
    exit 2
  fi
  local dir key
  case ${1:-path} in
    path)
      ensure_dev_app
      echo "$DEV_APP/Contents/MacOS/zen"
      ;;
    status)
      key=$(dev_app_key 2>/dev/null || true)
      for dir in "$DEV_APPS"/*/; do
        dir=${dir%/}
        [[ -f $dir/ready ]] || continue
        printf '%s' "$dir/zenius-dev-zen.app"
        if [[ ${dir##*/} == "$key" ]]; then printf ' (this Zen version'"'"'s)'; fi
        if dev_app_in_use "$dir"; then printf ', in use'; fi
        printf '\n'
      done
      ;;
    remove)
      [[ -d $DEV_APPS ]] || { echo "no dev copy of Zen.app"; return 0; }
      trap dev_app_unlock EXIT
      dev_app_lock
      local status=0 real
      real=$(cd -P "$DEV_APPS" && pwd -P)
      remove_dev_apps "" || status=$?
      dev_app_unlock
      trap - EXIT
      if ((status)); then exit 1; fi
      rmdir "$DEV_APPS" 2>/dev/null || true
      # Update folders left by copies removed some other way.
      remove_update_folders "$real"
      # The copy's settings and saved windows, which macOS keeps by its id.
      # defaults delete empties the settings, and cfprefsd leaves their file
      # behind, empty.
      defaults delete "$DEV_APP_ID" >/dev/null 2>&1 || true
      rm -f "$HOME/Library/Preferences/$DEV_APP_ID.plist"
      rm -rf "$HOME/Library/Saved Application State/$DEV_APP_ID.savedState"
      echo "dev copies of Zen.app removed"
      ;;
    *)
      echo "usage: zen-dev.sh --app path|status|remove" >&2
      exit 2
      ;;
  esac
}

ensure_profile() {
  mkdir -p "$PROFILE/chrome"
  rm -rf "$PROFILE/chrome/utils"
  cp -R "$ROOT/runtime/vendor/fx-autoconfig/profile/chrome/utils" "$PROFILE/chrome/utils"
  # Copy the runtime, don't link it: the macOS content sandbox refuses to read
  # through a link that leads out of the profile (the actor then never loads),
  # and the daily install copies too. Remove an old link before copying so the
  # copy can't land in the checkout.
  local d
  for d in JS resources; do
    [[ -z ${ZENIUS_INSTALLED:-} ]] || break
    if [[ -L $PROFILE/chrome/$d ]]; then rm "$PROFILE/chrome/$d"; fi
    rm -rf "$PROFILE/chrome/$d"
    if [[ -d $ROOT/runtime/$d ]]; then cp -R "$ROOT/runtime/$d" "$PROFILE/chrome/$d"; fi
  done
  # Their timings and modules would land in every suite's, I4's counts
  # included; their own tests ask for them.
  if [[ -z ${ZENIUS_INSTALLED:-} && ${ZENIUS_AGENT_SCRIPTS:-} != 1 ]]; then
    local c
    for c in agent-sidebar agent-urlbar; do
      rm -rf "$PROFILE/chrome/JS/$c.uc.js" "$PROFILE/chrome/JS/$c"
    done
  fi
  # Dev profiles only: a line in the log saying where a window's startup
  # stopped, if it never finished (scripts/dev/startup-watch.uc.js). An
  # installed runtime's profile stays as install.sh wrote it.
  if [[ -z ${ZENIUS_INSTALLED:-} ]]; then
    cp "$ROOT/scripts/dev/startup-watch.uc.js" "$PROFILE/chrome/JS/zen-dev-startup-watch.uc.js"
  fi
  # Zen's build id, so it doesn't greet a new dev profile as freshly updated.
  local appdir build_id
  appdir=$(dirname "$ZEN")
  [[ $(uname) == Darwin ]] && appdir=$(cd "$appdir/../Resources" 2>/dev/null && pwd)
  build_id=$(sed -n 's/^BuildID=//p' "$appdir/application.ini" 2>/dev/null | head -1 || true)
  local now; now=$(date +%s)
  cat > "$PROFILE/user.js" <<EOF
// Written by scripts/zen-dev.sh on every start. Edit the script, not this file.
user_pref("zenius.instance", "$NAME");
// zenius's agent sidebar starts no agent in a dev profile unless a test points
// this at its own config: never the user's real Claude Code or Codex.
user_pref("uc.agent-sidebar.config", "none");
user_pref("zenius.dev", $([[ ${ZENIUS_DEV_METHODS:-1} == 0 ]] && echo false || echo true));
user_pref("browser.dom.window.dump.enabled", true);
user_pref("devtools.console.stdout.chrome", true);
user_pref("devtools.chrome.enabled", true);
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
user_pref("zen.welcome-screen.seen", true);
// fx-autoconfig's one-time "being modified" notice would stack under our
// prompts in every fresh test profile (dev profiles only; the daily Zen
// shows it once).
user_pref("userChromeJS.firstRunShown", true);
// Skipping Zen's welcome flow also skips recording the version, so Zen would
// greet every new dev profile with its "Update Complete!" card and a window
// sweep (ZenUpdates.mjs). Dev profiles only.
user_pref("zen.updates.show-update-notification", false);
user_pref("zen.updates.last-build-id", "$build_id");
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.page", 0);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("startup.homepage_welcome_url", "");
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.tabs.warnOnClose", false);
// Update checks. About 30 s after start Firefox checks for an update and,
// with app.update.auto false, opens an "update available" doorhanger over the
// window's top-left that swallows clicks there (zen-eval's Mac takeover
// failures). Only an enterprise policy turns the check off (the Linux server's install
// and the Mac's dev copy have one: ensure_program_files, make_dev_app), and app.update.enabled
// has been dead since Firefox 63. So restart the check timer at every start:
// it then waits app.update.interval, which the timer caps at a day. Never set
// app.update.auto to true: on the Mac it would download an update into the
// user's Zen.app.
user_pref("app.update.auto", false);
user_pref("app.update.interval", 86400);
user_pref("app.update.lastUpdateTime.background-update-timer", $now);
// A dev Zen that runs past a day: a found update only badges the menu.
user_pref("app.update.suppressPrompts", true);
// Headed starts also check at once, bypassing the timer, when the build is
// older than app.update.checkInstallTime.days (BrowserGlue's
// _checkForOldBuildUpdates at the first window's delayed startup, which
// headless Zens never reach). On the Mac that check raised zen-eval's
// "update available" doorhanger within 6 s.
user_pref("app.update.checkInstallTime", false);
// Nothing downloads into the install's update folder, which on the Mac, with
// ZEN_BIN at the user's Zen.app, is the user's own Zen's: app.update.auto false
// above (off Windows a plain pref: UpdateUtils' PER_INSTALLATION_PREFS_PLATFORMS),
// and nothing staged, no background update task, and no restart to apply an
// update once the last window closes (macOS).
user_pref("app.update.staging.enabled", false);
user_pref("app.update.background.enabled", false);
user_pref("app.update.noWindowAutoRestart.enabled", false);
// Each quick start/stop cycle can count as a startup crash; after three,
// Zen relaunches itself in safe mode (no userscripts, profile lock held).
user_pref("toolkit.startup.max_resumed_crashes", -1);
user_pref("toolkit.startup.recent_crashes", 0);
user_pref("browser.newtabpage.enabled", false);
user_pref("extensions.autoDisableScopes", 15);
// A link change on the host (an interface or address that comes or goes, as
// containers do on a shared server) makes Necko close every connection that
// has no traffic 5 s later (network.http.network-changed.timeout). That ends
// a test's held or slow load as if the page had stopped it, and a call
// waiting on it then reads the old document.
user_pref("network.notify.changed", false);
EOF
  # Nothing of a dev Zen's own goes to an outside service: telemetry,
  # studies, connectivity checks, push, remote settings, Safe Browsing, DoH,
  # Suggest and add-on updates all stay off. Before ZENIUS_DEV_PREFS, so a
  # test that needs one of them can turn it back on.
  cat "$ROOT/scripts/dev/no-outside-traffic.js" >>"$PROFILE/user.js"
  # Downloads go to a folder of the profile's own, never the account's
  # Downloads: on the Mac that is the user's real folder, which a test
  # listing it would read, and which macOS may guard with a prompt for the
  # dev copy, headless too.
  local downloads=$PROFILE/downloads
  mkdir -p -m 700 "$downloads"
  downloads=${downloads//\\/\\\\}
  downloads=${downloads//\"/\\\"}
  printf 'user_pref("browser.download.folderList", 2);\nuser_pref("browser.download.dir", "%s");\n' "$downloads" >>"$PROFILE/user.js"
  # Finished downloads then move into the instance's working folder.
  local work=${WORK//\\/\\\\}
  work=${work//\"/\\\"}
  printf 'user_pref("zenius.dev.workingFolder", "%s");\n' "$work" >>"$PROFILE/user.js"
  # A dev sidebar's zenius server is this checkout's plain CLI, the one being
  # tested: an installed sandboxed launcher would read the user's own config
  # (and refuses the dev Zen's ZENIUS_WORKING_DIR). ZENIUS_DEV_PREFS can name
  # another.
  local cli=$ROOT/sdk/bin/zenius
  cli=${cli//\\/\\\\}
  cli=${cli//\"/\\\"}
  printf 'user_pref("uc.agent-sidebar.zenius-cli", "%s");\n' "$cli" >>"$PROFILE/user.js"
  if [[ $(uname) == Darwin ]]; then
    # macOS asks the user before an app's first notification, and the dev copy
    # is an app of its own: Gecko's own notification windows instead. A test
    # that needs macOS's sets this itself.
    echo 'user_pref("alerts.useSystemBackend", false);' >>"$PROFILE/user.js"
  fi
  if [[ -n ${ZENIUS_DEV_PREFS:-} ]]; then
    [[ -f $ZENIUS_DEV_PREFS ]] || { echo "zen-dev.sh: ZENIUS_DEV_PREFS: no file $ZENIUS_DEV_PREFS" >&2; exit 1; }
    { echo "// From ZENIUS_DEV_PREFS ($ZENIUS_DEV_PREFS)."; cat "$ZENIUS_DEV_PREFS"; } >> "$PROFILE/user.js"
  fi
  local pref file
  for pref in ${ZENIUS_DEV_DEFAULT_PREFS:-}; do
    for file in "$PROFILE/user.js" "$PROFILE/prefs.js"; do
      [[ -f $file ]] || continue
      # 1 = no line left, which is fine; 2 = an error, which stops here
      # rather than replace the file with what grep wrote.
      grep -vF "user_pref(\"$pref\"," "$file" >"$file.tmp" || (($? == 1))
      mv "$file.tmp" "$file"
    done
  done
}

# Moves the last start's log into KEPT_LOGS before a launch writes a new one,
# named by the time that start began (its first line says), or by now for a
# log without that line. Then gzips the ones before it and keeps the
# instance's newest ZENIUS_KEEP_LOGS. A step that fails costs only that log:
# the start goes on.
keep_log() {
  [[ -s $LOG ]] || return 0
  local keep=50 stamp file n=1 old
  # Base 10: a leading 0 would read as octal, and 08 would stop the start.
  [[ ${ZENIUS_KEEP_LOGS:-} =~ ^[0-9]{1,6}$ ]] && keep=$((10#$ZENIUS_KEEP_LOGS))
  (umask 077 && mkdir -p "$KEPT_LOGS") || return 0
  stamp=$(head -n 1 "$LOG" | sed -n 's/^\[zen-dev\] started at \([0-9]\{4\}\)-\([0-9]\{2\}\)-\([0-9]\{2\}\)T\([0-9]\{2\}\):\([0-9]\{2\}\):\([0-9]\{2\}\)Z.*/\1\2\3T\4\5\6Z/p') || stamp=
  [[ -n $stamp ]] || stamp=$(date -u +%Y%m%dT%H%M%SZ)
  # Two starts in one second: the later one's gets -2, -3 and so on.
  file=$KEPT_LOGS/$stamp.log
  while [[ -e $file || -e $file.gz ]]; do
    n=$((n + 1))
    file=$KEPT_LOGS/$stamp-$n.log
  done
  mv -f "$LOG" "$file" || return 0
  for old in "$KEPT_LOGS"/*.log; do
    if [[ $old != "$file" && -f $old ]]; then gzip -q -f "$old" || true; fi
  done
  # Newest first, by when each was last written: the rest past the newest
  # $keep go.
  ls -t "$KEPT_LOGS" 2>/dev/null | tail -n +$((keep + 1)) | while IFS= read -r old; do rm -f "$KEPT_LOGS/$old"; done || true
}

# Drops every instance's kept logs after 3 days, so a name no longer started
# (a removed checkout's) doesn't keep them for good; then the folders left
# empty that long, never one another start has just made.
expire_kept_logs() {
  find "$DEV/logs" -mindepth 2 -maxdepth 2 -type f \( -name '*.log' -o -name '*.log.gz' \) -mmin +4320 -exec rm -f {} + 2>/dev/null || true
  find "$DEV/logs" -mindepth 1 -maxdepth 1 -type d -empty -mmin +4320 -exec rmdir {} + 2>/dev/null || true
}

# One launch. Returns 0 once the runtime is ready, 2 if Zen died of a signal
# before that (CRASH_SIGNAL holds it), 3 if its start stalled before the
# runtime's first line (STALL_FILE names its threads' state), 1 otherwise.
launch() {
  # Again before each try: an update can arrive while a retry waits.
  refuse_waiting_update
  local args=(--profile "$PROFILE" --no-remote)
  [[ -n ${ZENIUS_INSTALLED:-} ]] || args+=(-purgecaches)
  [[ ${1:-} == --headed ]] || args+=(--headless)
  keep_log
  expire_kept_logs
  # The start line, which keep_log names the file by once the next start
  # moves it.
  local how=headless
  [[ ${1:-} == --headed ]] && how=headed
  printf '[zen-dev] started at %s: %s, %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$NAME" "$how" >"$LOG"
  # What Zen starts (the sidebar's agents and their zenius servers) writes
  # its files in the instance's working folder, never the user's, and finds
  # this checkout's plain zenius first on PATH: an installed sandboxed
  # launcher reads the user's own config, whatever this environment says.
  local tmp=(ZENIUS_WORKING_DIR="$WORK" PATH="$ROOT/sdk/bin:$PATH")
  if [[ -n $ZEN_TMP ]]; then
    rm -rf "$ZEN_TMP"
    (umask 077; mkdir -p "$ZEN_TMP")
    tmp+=(TMPDIR="$ZEN_TMP")
  fi
  # MOZ_DISABLE_UPDATE_PROCESSING: the second layer behind refuse_waiting_update.
  if [[ ${1:-} == --headed ]]; then
    MOZ_DISABLE_UPDATE_PROCESSING=1 MOZ_CRASHREPORTER_DISABLE=1 nohup env ${tmp[@]+"${tmp[@]}"} "$ZEN" "${args[@]}" >>"$LOG" 2>&1 &
  else
    # MOZ_HEADLESS too: a relaunched Zen drops --headless but keeps the
    # environment.
    MOZ_HEADLESS=1 MOZ_DISABLE_UPDATE_PROCESSING=1 MOZ_CRASHREPORTER_DISABLE=1 nohup env ${tmp[@]+"${tmp[@]}"} "$ZEN" "${args[@]}" >>"$LOG" 2>&1 &
  fi
  local launched=$!
  echo "$launched" > "$PIDFILE"
  # A headless start on a busy shared server (the Linux server at load 30, restoring a
  # session) can take over 40 s. A headed one keeps 40 s: a stuck window
  # stays on the user's screen no longer than that.
  local wait_s=${ZENIUS_START_WAIT_S:-90}
  [[ ${1:-} == --headed ]] && wait_s=${ZENIUS_START_WAIT_S:-40}
  local adopted status
  for _ in $(seq 1 $((wait_s * 4))); do
    if grep -qF "$READY_MARK" "$LOG" 2>/dev/null; then
      return 0
    fi
    if ! running; then
      adopted=$(profile_pid)
      if [[ -n $adopted ]]; then
        echo "$adopted" > "$PIDFILE"
        echo "$NAME: Zen relaunched itself as pid $adopted; following it" >&2
      else
        status=0
        wait "$launched" 2>/dev/null || status=$?
        if ((status > 128)); then
          CRASH_SIGNAL=$((status - 128))
          CRASH_WHAT="signal=$CRASH_SIGNAL"
          return 2
        fi
        echo "$NAME exited during startup (status $status); tail of $LOG:" >&2
        tail -30 "$LOG" >&2
        return 1
      fi
    fi
    sleep 0.25
  done
  # A Zen that never got ready is no use to anyone, and a headed one would
  # hold a visible window on the user's Mac until someone noticed.
  echo "$NAME: no '$READY_MARK' in $LOG after $wait_s s; stopping it. Tail of the log:" >&2
  tail -30 "$LOG" >&2
  # Not one line of the runtime's: the browser's own startup stalled before
  # zenius's service starts, which waits for the window's delayed startup.
  # The Mac's core run of 2026-11-22 had one: Zen restored its session and
  # never got to its own Zen Mods line. start retries that once, as a crash,
  # with the threads' state kept to say where it stopped.
  if ! grep -qF "[zenius] " "$LOG" 2>/dev/null; then
    STALL_FILE=$(record_stall "$(cat "$PIDFILE")")
    CRASH_WHAT="stalled=${wait_s}s threads=${STALL_FILE:-none}"
    stop >/dev/null
    return 3
  fi
  stop >/dev/null
  return 1
}

# Where the threads of a Zen whose start stalled are: macOS's sample of them,
# or Linux's name, state and kernel wait of each. Prints the file, if any.
record_stall() {
  local pid=$1 file t
  file=$DEV/logs/$NAME-stall-$(date -u +%Y%m%dT%H%M%SZ).txt
  if [[ $(uname) == Darwin ]]; then
    command -v sample >/dev/null && sample "$pid" 2 -mayDie -file "$file" >/dev/null 2>&1 || true
  elif [[ -d /proc/$pid/task ]]; then
    for t in /proc/"$pid"/task/*; do
      printf '%s %s %s %s\n' "${t##*/}" "$(cat "$t/comm" 2>/dev/null)" \
        "$(sed 's/^.*) //' "$t/stat" 2>/dev/null | cut -d' ' -f1)" "$(cat "$t/wchan" 2>/dev/null)"
    done >"$file" 2>/dev/null || true
  fi
  if [[ -s $file ]]; then echo "$file"; fi
}

# A visible dev window must not outlive the run that opened it, even when that
# run hangs or dies before its cleanup: a headed start closes itself after
# ZENIUS_HEADED_MAX_S seconds (0 = never). The watchdog calls "expire", which
# stops Zen only if this profile's Zen still has the pid it saw.
headed_watchdog() {
  local max=${ZENIUS_HEADED_MAX_S:-1200}
  ((max > 0)) || return 0
  nohup bash -c 'sleep "$1"; exec "$2" "$3" expire "$4"' _ \
    "$max" "$ROOT/scripts/zen-dev.sh" "$NAME" "$(cat "$PIDFILE")" >/dev/null 2>&1 &
  echo $! > "$WATCHDOG"
  echo "$NAME: the window closes itself after $max s unless stopped first (ZENIUS_HEADED_MAX_S)"
}

expire() {
  local pid=${1:?}
  # profile_pid finds Zen by this profile's path, so a reused pid, or the
  # user's own Zen, never matches.
  [[ $(profile_pid) == "$pid" ]] || return 0
  rm -f "$WATCHDOG"
  echo "[zen-dev] headed $NAME open for ${ZENIUS_HEADED_MAX_S:-1200} s; stopping it (ZENIUS_HEADED_MAX_S)" >>"$LOG"
  stop >/dev/null
}

# Headless starts on the Linux server sometimes die of a signal before the runtime loads,
# and work on retry. Count them here and retry once.
# A start that stalls before the runtime loads is counted here too.
record_crash() {
  {
    printf '%s %s profile=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$NAME" "$1" "$CRASH_WHAT"
    tail -5 "$LOG" | sed 's/^/    /'
  } >>"$CRASH_LOG"
}

# The working folder's path keeps the config file's rule
# (scripts/working-folder.sh): absolute, with no ".." part, double quote,
# backslash or control character. The runtime refuses a profile's
# zenius.dev.workingFolder that doesn't, and the CLI such a
# ZENIUS_WORKING_DIR: after a link, a ".." leads to the target's parent for
# the runtime's reads but drops the link's name for the SDK's path.resolve.
# Checked before anything starts or stops.
refuse_bad_work() {
  [[ $WORK == /?* ]] || { echo "zen-dev.sh: ZENIUS_DEV_WORKING_DIR must be an absolute path: $WORK" >&2; exit 1; }
  case $WORK in
    *'"'* | *'\'* | *[[:cntrl:]]* | */../* | */..)
      echo "zen-dev.sh: the working folder, $WORK, has a \"..\" part, a double quote, a backslash or a control character: name one without (ZENIUS_DEV_WORKING_DIR, or TMPDIR for the default)" >&2
      exit 1
      ;;
  esac
}

# Make the instance's working folder (0700) if it's missing. The default's
# parent sits in a temporary folder other accounts may share, so it must be
# this account's own folder, not a link.
ensure_working_folder() {
  if [[ -z ${ZENIUS_DEV_WORKING_DIR:-} ]]; then
    [[ -e $WORK_PARENT || -L $WORK_PARENT ]] || mkdir -m 700 "$WORK_PARENT" 2>/dev/null || true
    if [[ -L $WORK_PARENT || ! -d $WORK_PARENT || ! -O $WORK_PARENT ]]; then
      echo "zen-dev.sh: $WORK_PARENT isn't a folder of this account's own: remove it, or set ZENIUS_DEV_WORKING_DIR" >&2
      exit 1
    fi
    chmod 700 "$WORK_PARENT"
  fi
  if [[ -L $WORK ]] || { [[ -e $WORK ]] && [[ ! -d $WORK || ! -O $WORK ]]; }; then
    echo "zen-dev.sh: the working folder, $WORK, isn't a folder of this account's own" >&2
    exit 1
  fi
  [[ -d $WORK ]] || mkdir -m 700 "$WORK"
}

start() {
  local pid
  refuse_account_zhome
  refuse_bad_work
  pid=$(our_pid)
  if [[ -n $pid ]]; then echo "$NAME already running (pid $pid)"; return; fi
  need_zen
  [[ -x $ZEN ]] || { echo "Zen not found at $ZEN (set ZEN_BIN)" >&2; exit 1; }
  refuse_waiting_update
  local profile_state=kept
  [[ -d $PROFILE ]] || profile_state=fresh
  ensure_program_files
  ensure_working_folder
  ensure_profile
  # A crash comes in bursts under load: twice on 2026-11-20 (the Linux server, load 30+)
  # the retry died in the same second as the first try. So retry up to
  # ZENIUS_START_RETRIES times, waiting 2 s, then 4, then 6 before each. A
  # stall costs a whole wait, so it gets one retry of those at most.
  local status=0 try=1 retries=${ZENIUS_START_RETRIES:-3} stalled=0
  launch "$@" || status=$?
  while ((status == 2 || status == 3)); do
    if ((try == 1)); then record_crash "$profile_state"; else record_crash "$profile_state, retry $((try - 1))"; fi
    if ((try > retries || (status == 3 && stalled))); then
      if ((status == 3)); then
        echo "$NAME: its start stalled before the runtime loaded on $try tries (logged in $CRASH_LOG)" >&2
      else
        echo "$NAME: died of signal $CRASH_SIGNAL on each of $try tries; tail of $LOG:" >&2
        tail -30 "$LOG" >&2
      fi
      break
    fi
    if ((status == 3)); then
      stalled=1
      echo "$NAME: its start stalled before the runtime loaded (logged in $CRASH_LOG, its threads in ${STALL_FILE:-no file}); retrying in $((2 * try)) s" >&2
    else
      echo "$NAME: Zen died of signal $CRASH_SIGNAL before the runtime was ready (logged in $CRASH_LOG); retrying in $((2 * try)) s" >&2
    fi
    sleep $((2 * try))
    status=0
    launch "$@" || status=$?
    try=$((try + 1))
  done
  ((status == 0)) || exit 1
  echo "$NAME started (pid $(cat "$PIDFILE")), profile $PROFILE, log $LOG"
  if [[ ${1:-} == --headed ]]; then headed_watchdog; fi
}

clear_watchdog() {
  if [[ -f $WATCHDOG ]]; then
    local pid
    pid=$(cat "$WATCHDOG")
    # Only the watchdog this script started: its command line runs this
    # script's expire for this profile (see ours on reused pids).
    if [[ $pid =~ ^[1-9][0-9]*$ ]] && [[ $(ps -o command= -p "$pid" 2>/dev/null) == *"$ROOT/scripts/zen-dev.sh"*" $NAME "* ]]; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$WATCHDOG"
  fi
}

# The runtime removes its socket and its registry entry when Zen quits
# (quit-application). A Zen ended by a signal leaves both, and clients then
# find an instance that isn't there. Once no Zen runs this profile, remove
# this instance's two files: only its own name's, and only when the registry
# entry names this profile (another ZENIUS_DEV_HOME may use the name).
clean_instance_files() {
  local reg=$ZHOME/instances/$NAME.json sock=$ZHOME/run/$NAME.sock owner
  [[ -z $(our_pid 2>/dev/null) ]] || return 0
  [[ -z $ZEN_TMP ]] || rm -rf "$ZEN_TMP"
  # Never in the account's own zenius home (ZHOME above).
  ! account_zhome || return 0
  [[ -e $reg || -e $sock ]] || return 0
  if [[ -f $reg ]]; then
    owner=$(sed -n 's/.*"profileDir": *"\([^"]*\)".*/\1/p' "$reg" | head -1)
    if [[ $owner != "$PROFILE" ]]; then
      echo "zen-dev.sh: $reg names profile ${owner:-(none)}, not $PROFILE; leaving it and $sock" >&2
      return 0
    fi
    rm -f "$reg"
  fi
  rm -f "$sock"
}

stop() {
  local pid
  clear_watchdog
  pid=$(our_pid)
  if [[ -z $pid ]]; then rm -f "$PIDFILE"; clean_instance_files; echo "$NAME not running"; return; fi
  kill "$pid"
  for _ in $(seq 1 40); do alive "$pid" || break; sleep 0.25; done
  if ours "$pid"; then
    kill -9 "$pid"
    # Until it's gone: a start right after must find the profile free.
    for _ in $(seq 1 20); do alive "$pid" || break; sleep 0.25; done
  fi
  rm -f "$PIDFILE"
  clean_instance_files
  echo "$NAME stopped"
}

# A clean exit through the app (dev.evalChrome): Zen saves its session, with
# workspaces and tabs, as when the user quits. stop kills, which skips that.
quit() {
  local pid
  pid=$(our_pid)
  if [[ -z $pid ]]; then rm -f "$PIDFILE"; clean_instance_files; echo "$NAME not running"; return; fi
  node "$ROOT/scripts/zen-rpc.mjs" --instance "$NAME" dev.evalChrome \
    '{"code": "Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit); return true"}' >/dev/null 2>&1 &
  for _ in $(seq 1 60); do alive "$pid" || break; sleep 0.25; done
  if alive "$pid"; then stop; return; fi
  clear_watchdog
  rm -f "$PIDFILE"
  clean_instance_files
  echo "$NAME quit"
}

# The default working folder and what tests downloaded into it go with the
# profile. One ZENIUS_DEV_WORKING_DIR names is the caller's to remove.
remove_default_work() {
  [[ -n ${ZENIUS_DEV_WORKING_DIR:-} ]] || rm -rf "${WORK_PARENT:?}/${NAME:?}"
}

case $CMD in
  start) start "$@" ;;
  stop) stop ;;
  expire) expire "$@" ;;
  quit) quit ;;
  # Checked before the stop too, so a waiting update, the account's own
  # zenius home or a working folder it can't take doesn't leave it stopped.
  restart) refuse_account_zhome; refuse_bad_work; need_zen; refuse_waiting_update; stop; start "$@" ;;
  status) pid=$(our_pid); if [[ -n $pid ]]; then echo "$NAME running (pid $pid)"; else echo "$NAME not running"; exit 1; fi ;;
  log) if [[ ${1:-} == -f ]]; then tail -f "$LOG"; else cat "$LOG"; fi ;;
  path) echo "$PROFILE" ;;
  work) echo "$WORK" ;;
  updates) updates ;;
  reset)
    stop
    rm -rf "$PROFILE"
    # zenius's records of that profile's workspaces and tasks go with it:
    # kept, an ended task's name stays taken in the next run (the UI's
    # clipboard suite). Never in the account's own zenius home (ZHOME).
    account_zhome || rm -rf "$ZHOME/state/$NAME"
    remove_default_work
    echo "$NAME profile removed"
    ;;
  fresh)
    stop >/dev/null
    if [[ ${ZENIUS_FRESH:-} == 1 || $(uname) != Darwin ]]; then
      rm -rf "$PROFILE"
      # zenius's records of that profile's workspaces and tasks go with it,
      # but never from the account's own zenius home (ZHOME).
      account_zhome || rm -rf "$ZHOME/state/$NAME"
      remove_default_work
      echo "$NAME profile removed"
    else
      echo "$NAME profile kept (Mac; ZENIUS_FRESH=1 removes it)"
    fi
    ;;
  --app) dev_app_command "$@" ;;
  *) echo "unknown command: $CMD" >&2; exit 2 ;;
esac
