#!/usr/bin/env bash
# Dev Zen instances for zenius: one profile per name, with this checkout's
# runtime copied in on every start, so editing runtime/ and restarting picks
# up the change.
#
#   scripts/zen-dev.sh <name> start [--headed]   create the profile if needed, launch, wait for the runtime
#                                     (--headed: a visible window that closes itself after
#                                     ZENIUS_HEADED_MAX_S seconds, default 1200; 0 = never)
#   scripts/zen-dev.sh <name> stop | restart [--headed] | status | log [-f] | path | reset
#   scripts/zen-dev.sh <name> quit    exit through the app, so Zen saves its session (stop kills)
#   scripts/zen-dev.sh <name> fresh   before a test run: reset on Linux; on the Mac keep the
#                                     profile (a first start there relaunches Zen and takes ~13 s)
#                                     unless ZENIUS_FRESH=1
#   scripts/zen-dev.sh <name> updates where Gecko keeps updates for this Zen's install, and
#                                     whether one is waiting there (then exit 3); starts nothing
#
# start refuses (exit 3) while an update is waiting in the install's update
# folder: every Zen started from the install applies it first, before it reads
# a profile or a pref, and on the Mac that install is the user's own Zen.app.
# See refuse_waiting_update. Behind that guard, every dev Zen starts with
# MOZ_DISABLE_UPDATE_PROCESSING=1, which leaves a waiting update alone
# (docs/research/update-processing.md): an update that arrives after the
# check still isn't applied by a dev Zen.
# ZENIUS_START_WAIT_S=<s> start: how long to wait for the runtime before
#   stopping Zen (default 90 s, 40 s headed).
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
# user.js stays a user value even when it equals the default (zen-eval's Mac
# restart check: browser.startup.page, whose default in Zen 1.24.2b is 3).
#
# Never point this at the user's daily profile: it always uses ~/.zenius-dev/profiles/<name>.
set -euo pipefail

NAME=${1:?usage: zen-dev.sh <name> start|stop|quit|restart|status|log|path|reset|fresh|updates}
CMD=${2:-start}
shift 2 || shift $#
[[ $NAME =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo "name must match [a-z0-9][a-z0-9_-]*" >&2; exit 2; }
[[ $NAME == default ]] && { echo "'default' is reserved for the user's daily browser" >&2; exit 2; }

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DEV=${ZENIUS_DEV_HOME:-$HOME/.zenius-dev}
PROFILE=$DEV/profiles/$NAME
PIDFILE=$DEV/run/$NAME.pid
WATCHDOG=$DEV/run/$NAME.watchdog
LOG=$DEV/logs/$NAME.log
CRASH_LOG=$DEV/logs/startup-crashes.log
CRASH_SIGNAL=
if [[ $(uname) == Darwin ]]; then
  ZEN=${ZEN_BIN:-/Applications/Zen.app/Contents/MacOS/zen}
else
  ZEN=${ZEN_BIN:-$HOME/opt/zen-1.24.2b/zen}
fi
READY_MARK="[zenius] window loaded, instance=$NAME"
mkdir -p "$DEV/profiles" "$DEV/run" "$DEV/logs"

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
# profile's real path as well as the path as given (zen-eval's fix).
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
  # fx-autoconfig needs two files next to the Zen binary. The Mac app already has
  # them (and we must not modify it); a Linux tarball install gets them here.
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

# Never start a Zen whose install has an update waiting (the manager's order,
# 2026-11-20). At 12:12 CST that day the user's own Zen staged 1.24.3b; a dev
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
      echo "That would change the install under every dev Zen that uses it: ask the manager whether to apply it or remove it."
    fi
    echo "zen-dev.sh leaves that folder as it is."
  } >&2
  exit 3
}

updates() {
  local root what
  root=$(update_root "$(uname)" "$ZEN") || { echo "can't find the folder of $ZEN" >&2; return 3; }
  echo "Zen: $ZEN"
  echo "update folder: $root/updates/0"
  if what=$(waiting_update "$root"); then
    echo "waiting: $what (start refuses)"
    return 3
  fi
  echo "nothing waiting (start goes ahead)"
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
// failures). Only an enterprise policy turns the check off (the Linux server has one, see
// ensure_program_files; the Mac app is the user's), and app.update.enabled
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
// Nothing downloads into the install's update folder, which on the Mac is the
// user's own Zen's (the manager's order, 2026-11-20): app.update.auto false
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
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("browser.newtabpage.enabled", false);
user_pref("extensions.autoDisableScopes", 15);
EOF
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

# One launch. Returns 0 once the runtime is ready, 2 if Zen died of a signal
# before that (CRASH_SIGNAL holds it), 1 otherwise.
launch() {
  # Again before each try: an update can arrive while a retry waits.
  refuse_waiting_update
  local args=(--profile "$PROFILE" --no-remote)
  [[ -n ${ZENIUS_INSTALLED:-} ]] || args+=(-purgecaches)
  [[ ${1:-} == --headed ]] || args+=(--headless)
  : > "$LOG"
  # MOZ_DISABLE_UPDATE_PROCESSING: the second layer behind refuse_waiting_update.
  if [[ ${1:-} == --headed ]]; then
    MOZ_DISABLE_UPDATE_PROCESSING=1 MOZ_CRASHREPORTER_DISABLE=1 nohup "$ZEN" "${args[@]}" >>"$LOG" 2>&1 &
  else
    # MOZ_HEADLESS too: a relaunched Zen drops --headless but keeps the
    # environment.
    MOZ_HEADLESS=1 MOZ_DISABLE_UPDATE_PROCESSING=1 MOZ_CRASHREPORTER_DISABLE=1 nohup "$ZEN" "${args[@]}" >>"$LOG" 2>&1 &
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
  stop >/dev/null
  return 1
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
# and work on retry. Count them here (the manager's request) and retry once.
record_crash() {
  {
    printf '%s %s profile=%s signal=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$NAME" "$1" "$CRASH_SIGNAL"
    tail -5 "$LOG" | sed 's/^/    /'
  } >>"$CRASH_LOG"
}

start() {
  local pid
  pid=$(our_pid)
  if [[ -n $pid ]]; then echo "$NAME already running (pid $pid)"; return; fi
  [[ -x $ZEN ]] || { echo "Zen not found at $ZEN (set ZEN_BIN)" >&2; exit 1; }
  refuse_waiting_update
  local profile_state=kept
  [[ -d $PROFILE ]] || profile_state=fresh
  ensure_program_files
  ensure_profile
  # A crash comes in bursts under load: twice on 2026-11-20 (the Linux server, load 30+)
  # the retry died in the same second as the first try. So retry up to
  # ZENIUS_START_RETRIES times, waiting 2 s, then 4, then 6 before each.
  local status=0 try=1 retries=${ZENIUS_START_RETRIES:-3}
  launch "$@" || status=$?
  while ((status == 2)); do
    if ((try == 1)); then record_crash "$profile_state"; else record_crash "$profile_state, retry $((try - 1))"; fi
    if ((try > retries)); then
      echo "$NAME: died of signal $CRASH_SIGNAL on each of $try tries; tail of $LOG:" >&2
      tail -30 "$LOG" >&2
      break
    fi
    echo "$NAME: Zen died of signal $CRASH_SIGNAL before the runtime was ready (logged in $CRASH_LOG); retrying in $((2 * try)) s" >&2
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
  local zhome=${ZENIUS_HOME:-$HOME/.zenius}
  local reg=$zhome/instances/$NAME.json sock=$zhome/run/$NAME.sock owner
  [[ -e $reg || -e $sock ]] || return 0
  [[ -z $(our_pid 2>/dev/null) ]] || return 0
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

case $CMD in
  start) start "$@" ;;
  stop) stop ;;
  expire) expire "$@" ;;
  quit) quit ;;
  # Checked before the stop too, so a waiting update doesn't leave it stopped.
  restart) refuse_waiting_update; stop; start "$@" ;;
  status) pid=$(our_pid); if [[ -n $pid ]]; then echo "$NAME running (pid $pid)"; else echo "$NAME not running"; exit 1; fi ;;
  log) if [[ ${1:-} == -f ]]; then tail -f "$LOG"; else cat "$LOG"; fi ;;
  path) echo "$PROFILE" ;;
  updates) updates ;;
  reset)
    stop
    rm -rf "$PROFILE"
    # zenius's records of that profile's workspaces and tasks go with it:
    # kept, an ended task's name stays taken in the next run (zen-ux's
    # clipboard suite).
    rm -rf "${ZENIUS_HOME:-$HOME/.zenius}/state/$NAME"
    echo "$NAME profile removed"
    ;;
  fresh)
    stop >/dev/null
    if [[ ${ZENIUS_FRESH:-} == 1 || $(uname) != Darwin ]]; then
      rm -rf "$PROFILE"
      # zenius's records of that profile's workspaces and tasks go with it.
      rm -rf "${ZENIUS_HOME:-$HOME/.zenius}/state/$NAME"
      echo "$NAME profile removed"
    else
      echo "$NAME profile kept (Mac; ZENIUS_FRESH=1 removes it)"
    fi
    ;;
  *) echo "unknown command: $CMD" >&2; exit 2 ;;
esac
