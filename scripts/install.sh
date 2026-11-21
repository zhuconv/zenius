#!/usr/bin/env bash
# Install the zenius runtime into a Zen profile, or remove it.
#
#   scripts/install.sh [--profile <dir>] [--dry-run] [--while-running] [--disable-ipv6]
#   scripts/install.sh --uninstall [--profile <dir>] [--dry-run] [--while-running]
#
# Install copies (never links) runtime/JS/zenius.uc.js and runtime/JS/zenius/
# into <profile>/chrome/JS/, with the agent's scripts the checkout has beside
# them (COMPONENTS), writes chrome/JS/zenius/install.json, and records the
# install in ~/.zenius/install.json. Uninstall removes those files and the
# record, and puts back the user's own copy of each script it replaced.
# Before either replaces or removes a file, it copies it to
# ~/.zenius/backups/<UTC time>/, under its path in the profile; backups are
# never deleted. With --disable-ipv6, install also sets one pref: see
# DNS_PREF. Nothing else in the profile changes: the user's other scripts in
# chrome/JS/ and fx-autoconfig stay as they are. See docs/SPI.md "Install
# layout".
#
# It never touches the Zen app and never quits or restarts Zen; quit Zen and
# reopen it afterwards. While Zen has the profile open and zenius is installed
# there, it refuses to change zenius's files (the running runtime could load a
# mix of versions) unless --while-running.
#
# Profile: --profile, else Zen's profiles.ini: its [Install…] Default= entry,
# then the [Profile…] with Default=1. ZENIUS_HOME (default ~/.zenius) moves the
# record and the backups, for tests.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ZHOME=${ZENIUS_HOME:-$HOME/.zenius}
RECORD=$ZHOME/install.json
# The agent's scripts installed beside the runtime (SPEC 8, zen-ux's): each
# runtime/JS/<name>.uc.js, with its runtime/JS/<name>/ if it has one, when
# the checkout has it. The profile may hold the user's own copy (their
# agent-sidebar): the install that first replaces it keeps it in that run's
# backup and notes the folder in COMP_PRIOR, and uninstall puts it back. A
# script the profile didn't have is noted with no folder, and uninstall
# removes it. A copy the user (or their own installer) put there after
# zenius's is theirs too: a reinstall keeps it the same way, and uninstall
# leaves it. Nothing else of the user's changes: their other scripts
# (my-script.uc.js) and the sidebar's own data
# (~/Library/Application Support/zenius-agent-sidebar/) stay as they are.
COMPONENTS=(agent-sidebar agent-urlbar)
# One line per profile and script that an install put there: "<profile>\t
# <name>\t<backup folder holding the user's own copy, or empty>\t<fingerprint
# of zenius's copy as installed>". It sits beside the backups, outside the
# profile, so it outlasts going back to a version from before these
# scripts: that version's install.sh rewrites chrome/JS/zenius/ but leaves
# the scripts and this file, and the next uninstall by this one still puts
# the user's copy back.
COMP_PRIOR=$ZHOME/components.prior
MODE=install
PROFILE=
DRY=0
WHILE_RUNNING=0
DISABLE_IPV6=0
while (($#)); do
  case $1 in
    --profile)
      [[ $# -ge 2 ]] || { echo "install.sh: --profile needs a folder" >&2; exit 2; }
      PROFILE=$2
      shift 2
      ;;
    --uninstall) MODE=uninstall; shift ;;
    --dry-run) DRY=1; shift ;;
    --while-running) WHILE_RUNNING=1; shift ;;
    --disable-ipv6) DISABLE_IPV6=1; shift ;;
    -h | --help)
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
      exit 0
      ;;
    *) echo "install.sh: unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
# "1 preference", "2 preferences".
plural() { if (($1 == 1)); then printf '%s %s' "$1" "$2"; else printf '%s %ss' "$1" "$2"; fi; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
# Make a change, or with --dry-run only show it.
run() { if ((DRY)); then say "  would run: $*"; else "$@"; fi; }
json_str() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }
# A top-level string value from a JSON file this script wrote.
json_get() {
  sed -n "s/^  \"$1\": \"\\(.*\\)\",\\{0,1\\}\$/\\1/p" "$2" | head -1 | sed 's/\\"/"/g; s/\\\\/\\/g'
}
exists() { [[ -e $1 || -L $1 ]]; }

profiles_ini() {
  if [[ $(uname) == Darwin ]]; then
    printf '%s\n' "$HOME/Library/Application Support/zen/profiles.ini"
  else
    printf '%s\n' "$HOME/.zen/profiles.ini"
  fi
}

# The profile Zen opens when started normally: two lines, how it was found,
# then its path.
default_profile() {
  local ini base path count
  ini=$(profiles_ini)
  [[ -f $ini ]] || die "no --profile given, and there's no $ini"
  base=$(dirname "$ini")
  # Each Zen installation has an [Install<hash>] section naming the profile it
  # opens. If they disagree, we can't tell which Zen is the user's.
  local why="$ini, the Default= of its [Install…] section (the profile Zen opens)"
  path=$(awk '{ sub(/\r$/, "") } /^\[/ { inst = ($0 ~ /^\[Install/); next } inst && /^Default=/ { print substr($0, 9) }' "$ini" | LC_ALL=C sort -u)
  count=$(printf '%s' "$path" | grep -c . || true)
  if ((count > 1)); then
    die "$ini names a different default profile for each Zen installation:
$(printf '%s\n' "$path" | sed 's/^/  /')
Pass --profile."
  fi
  if [[ -z $path ]]; then
    why="$ini, its [Profile…] section with Default=1"
    path=$(awk '
      { sub(/\r$/, "") }
      /^\[/ { if (def && p != "") { print p; done = 1; exit } prof = ($0 ~ /^\[Profile/); p = ""; def = 0; next }
      prof && /^Path=/ { p = substr($0, 6) }
      prof && $0 == "Default=1" { def = 1 }
      END { if (!done && def && p != "") print p }' "$ini")
  fi
  [[ -n $path ]] || die "$ini has no default profile; pass --profile"
  [[ $path == /* ]] || path=$base/$path
  printf '%s\n%s\n' "$why" "$path"
}

# The pid of a running Zen that has the profile open, if any. Zen on Linux
# keeps a "lock -> <ip>:+<pid>" link while it runs. The Mac's only holds
# .parentlock open, so ask lsof there (on a busy Linux server lsof takes
# seconds, and the link already answers).
profile_owner() {
  local pid=
  if [[ -L $1/lock ]]; then
    pid=$(readlink "$1/lock" | sed -n 's/.*:+\{0,1\}\([0-9][0-9]*\)$/\1/p')
    if [[ -n $pid ]] && ! kill -0 "$pid" 2>/dev/null; then pid=; fi
  fi
  if [[ -z $pid && $(uname) == Darwin && -e $1/.parentlock ]] && command -v lsof >/dev/null 2>&1; then
    pid=$(lsof -t -- "$1/.parentlock" 2>/dev/null | head -1 || true)
  fi
  printf '%s\n' "$pid"
}

PROFILE_FROM=--profile
if [[ -z $PROFILE ]]; then
  found=$(default_profile)
  PROFILE_FROM=${found%%$'\n'*}
  PROFILE=${found#*$'\n'}
fi
[[ -d $PROFILE ]] || die "no profile folder at $PROFILE"
PROFILE=$(cd "$PROFILE" && pwd -P)
case $PROFILE in
  *$'\t'* | *$'\n'*) die "the profile's path holds a tab or a line break, which install.sh can't record: $PROFILE" ;;
esac
JSDIR=$PROFILE/chrome/JS
OWNER=$(profile_owner "$PROFILE")
# The one pref zenius can set, only with --disable-ipv6: the user's choice for
# their own install (2026-11-20, their answer (b) on DoH), opt-in since
# 2026-11-21 so that nobody else's Zen loses IPv6 (the manager's call). Zen
# then makes no IPv6 lookups, so github.com no longer stalls on
# their IPv4-only network. Its cost: a site reachable only over IPv6 doesn't load
# in Zen. It goes in user.js, which Zen reads at every start; Zen then keeps
# the value in prefs.js too. So the first install records the pref's line in
# prefs.js, or that it had none, in DNS_PRIOR, and uninstall puts that back
# once Zen has quit, and takes zenius's lines out of user.js.
# An install without --disable-ipv6 leaves user.js as it is: the user's own
# line, or zenius's from an earlier install, which uninstall still takes out.
DNS_PREF=network.dns.disableIPv6
DNS_LINE="user_pref(\"$DNS_PREF\", true);"
DNS_NOTE="// zenius: no IPv6 lookups in Zen, the user's choice for their IPv4-only network. scripts/install.sh --uninstall restores the previous value."
DNS_PRIOR=$ZHOME/dns-pref.prior
BACKUP=$ZHOME/backups/$(date -u +%Y%m%dT%H%M%SZ)
exists "$BACKUP" && BACKUP=$BACKUP-$$
BACKED_UP=0
STAGE=
trap '[[ -z $STAGE ]] || rm -rf "$STAGE"' EXIT

ensure_home() {
  mkdir -p "$ZHOME"
  chmod 700 "$ZHOME"
}

# Copy a file or folder that is about to be replaced or removed into this
# run's backup folder, under its path relative to the profile.
backup() {
  local rel=${1#"$PROFILE"/}
  if ((!DRY)); then ensure_home; fi
  run mkdir -p "$BACKUP/$(dirname "$rel")"
  run cp -Rp "$1" "$BACKUP/$rel"
  BACKED_UP=1
}

# The last line of file $1 that sets DNS_PREF, or nothing.
pref_line() {
  [[ -f $1 ]] || return 0
  grep -F "user_pref(\"$DNS_PREF\"," "$1" | tail -1 || true
}

# DNS_PRIOR's field $1 (profile, user.js or prefs.js), or nothing.
prior() {
  [[ -f $DNS_PRIOR ]] || return 0
  sed -n "s/^$1=//p" "$DNS_PRIOR" | head -1
}

# Does user.js already have zenius's line? Then set_dns_pref changes nothing.
dns_line_present() {
  [[ -f $PROFILE/user.js ]] && grep -qxF "$DNS_LINE" "$PROFILE/user.js"
}

# user.js, which set_dns_pref is about to add its line to, goes into this
# run's backup folder with the zenius files, so the output and install.json's
# backup say everything the run backed up (zen-sdk's install rehearsal).
backup_user_js() {
  if [[ -e $PROFILE/user.js ]] && ! dns_line_present; then
    backup "$PROFILE/user.js"
    if ((DRY)); then say "  would back up user.js to $BACKUP"; else say "  backed up user.js to $BACKUP"; fi
  fi
}

set_dns_pref() {
  local user=$PROFILE/user.js prefs=$PROFILE/prefs.js pending
  pending=$(prior profile)
  if [[ -n $pending && $pending != "$PROFILE" ]]; then
    die "$DNS_PREF still has to be restored in $pending ($DNS_PRIOR). Quit Zen, then run: install.sh --uninstall --profile '$pending'"
  fi
  if dns_line_present; then
    say "  $DNS_PREF is already true in user.js"
    return
  fi
  if ((DRY)); then
    say "  would set $DNS_PREF to true in user.js (no IPv6 lookups in Zen, the user's choice); uninstall restores its current value"
    return
  fi
  ensure_home
  if [[ -z $pending ]]; then
    {
      printf 'profile=%s\n' "$PROFILE"
      printf 'user.js=%s\n' "$(if [[ ! -e $user ]]; then echo absent; elif [[ -s $user && -n $(tail -c 1 "$user") ]]; then echo present-no-newline; else echo present; fi)"
      printf 'prefs.js=%s\n' "$(pref_line "$prefs")"
    } >"$DNS_PRIOR.tmp-$$"
    mv "$DNS_PRIOR.tmp-$$" "$DNS_PRIOR"
  fi
  # install() backed up user.js first (backup_user_js).
  # Our lines start on a line of their own.
  if [[ -s $user && -n $(tail -c 1 "$user") ]]; then printf '\n' >>"$user"; fi
  printf '%s\n%s\n' "$DNS_NOTE" "$DNS_LINE" >>"$user"
  say "  set $DNS_PREF to true in user.js (no IPv6 lookups in Zen); uninstall restores its previous value"
}

# Without --disable-ipv6, user.js stays as it is, whatever it says.
keep_dns_pref() {
  if dns_line_present; then
    say "  $DNS_PREF stays true in user.js, from an earlier install with --disable-ipv6; uninstall restores its previous value"
  fi
}

# Uninstall's half: zenius's lines out of user.js, and prefs.js's line for the
# pref as it was before the first install. Zen writes prefs.js from memory when
# it quits, so while Zen has the profile open that part waits, and DNS_PRIOR
# stays for the next uninstall run.
restore_dns_pref() {
  local user=$PROFILE/user.js prefs=$PROFILE/prefs.js had line body none="no value of its own (Zen's default)"
  if [[ -f $user ]] && grep -qxF -e "$DNS_LINE" -e "$DNS_NOTE" "$user"; then
    backup_once "$user"
    if ((DRY)); then
      say "  would take zenius's $DNS_PREF lines out of user.js"
    else
      grep -vxF -e "$DNS_LINE" -e "$DNS_NOTE" "$user" >"$user.tmp-$$" || (($? == 1))
      if [[ $(prior user.js) == absent && ! -s $user.tmp-$$ ]]; then
        rm -f "$user.tmp-$$" "$user"
        say "  removed user.js, which held only zenius's $DNS_PREF lines"
      else
        # The newline install added before its lines, if the file had no last one.
        if [[ $(prior user.js) == present-no-newline && -s $user.tmp-$$ ]]; then
          body=$(cat "$user.tmp-$$")
          printf '%s' "$body" >"$user.tmp-$$"
        fi
        mv "$user.tmp-$$" "$user"
        say "  took zenius's $DNS_PREF lines out of user.js"
      fi
    fi
  fi
  [[ $(prior profile) == "$PROFILE" ]] || return 0
  if [[ -n $OWNER ]]; then
    say "  Zen (pid $OWNER) is running, and it writes $DNS_PREF back into prefs.js when it quits. Once it has quit, run install.sh --uninstall again to restore that too."
    return
  fi
  line=$(prior prefs.js)
  if ((DRY)); then
    say "  would restore $DNS_PREF in prefs.js to ${line:-$none}"
    return
  fi
  if [[ -f $prefs ]]; then
    had=$(pref_line "$prefs")
    if [[ $had != "$line" ]]; then
      backup_once "$prefs"
      { grep -vF "user_pref(\"$DNS_PREF\"," "$prefs" || (($? == 1)); if [[ -n $line ]]; then printf '%s\n' "$line"; fi; } >"$prefs.tmp-$$"
      mv "$prefs.tmp-$$" "$prefs"
    fi
  fi
  rm -f "$DNS_PRIOR"
  say "  restored $DNS_PREF in prefs.js to ${line:-$none}"
}

# A backup of a file this run backed up already would overwrite the copy of
# it as it was.
backup_once() {
  local rel=${1#"$PROFILE"/}
  exists "$BACKUP/$rel" || backup "$1"
}

# zenius's own preferences, which uninstall takes out of prefs.js and user.js:
# the runtime writes one, the user's allow list for private networks
# (zenius.agentTabs.allowPrivateNetworks), and a test's leftover would be
# another. They go into this run's backup folder as zenius-prefs.js, so the
# user can put the allow list back by hand after a reinstall. Zen writes
# prefs.js from memory, so that file waits until Zen has quit, as the DNS
# pref does.
ZENIUS_PREF_RE='^[[:space:]]*user_pref\("zenius\.'
zenius_prefs_in() {
  [[ -f $1 ]] && grep -qE "$ZENIUS_PREF_RE" "$1"
}
drop_zenius_prefs() {
  local name file n
  for name in prefs.js user.js; do
    file=$PROFILE/$name
    zenius_prefs_in "$file" || continue
    n=$(grep -cE "$ZENIUS_PREF_RE" "$file")
    if [[ $name == prefs.js && -n $OWNER ]]; then
      say "  Zen (pid $OWNER) is running, and it writes zenius's $(plural "$n" preference) back into prefs.js. Once it has quit, run install.sh --uninstall again to remove them."
      continue
    fi
    if ((DRY)); then
      say "  would remove zenius's $(plural "$n" preference) from $name, keeping them in the backup as zenius-prefs.js"
      continue
    fi
    backup_once "$file"
    grep -E "$ZENIUS_PREF_RE" "$file" >>"$BACKUP/zenius-prefs.js"
    { grep -vE "$ZENIUS_PREF_RE" "$file" || (($? == 1)); } >"$file.tmp-$$"
    mv "$file.tmp-$$" "$file"
    say "  removed zenius's $(plural "$n" preference) from $name (kept in $BACKUP/zenius-prefs.js)"
  done
}

# zenius's staging folders: zenius-uploads in the profile holds copies of
# the files the agent attached, zenius-downloads the agent's downloads, each
# 0700 (input/filechooser.sys.mjs, observe/downloads.sys.mjs). Until
# 2026-11-21 they lived in the temp folder, one set per run named for the
# profile's path: zenius-upload-<hash> and zenius-downloads-<hash>. Since
# 883ab36 (uploads) and e794b28 (downloads) zenius leaves those old ones
# alone, so only drop_staging and the system's temp cleanup remove them. The
# hash is theirs: FNV-1a over the path's characters, which matches for an
# ASCII path.
profile_hash() {
  local LC_ALL=C
  local s=$PROFILE h=$((0x811c9dc5)) i c
  for ((i = 0; i < ${#s}; i++)); do
    printf -v c '%d' "'${s:i:1}"
    h=$((((h ^ (c & 0xff)) * 0x01000193) & 0xffffffff))
  done
  printf '%08x' "$h"
}
drop_staging() {
  local tmp=${TMPDIR:-/tmp} hash short d n=0
  tmp=${tmp%/}
  # Zen uses them while it runs; an uninstall run after it quits clears them.
  [[ -z $OWNER ]] || return 0
  local had=$(shopt -p nullglob)
  shopt -s nullglob
  local dirs=("$PROFILE"/zenius-uploads "$PROFILE"/zenius-downloads)
  hash=$(profile_hash)
  if [[ -d $tmp && $hash =~ ^[0-9a-f]{8}$ ]]; then
    short=$(printf '%x' $((16#$hash)))
    dirs+=("$tmp"/zenius-upload-"$hash" "$tmp"/zenius-upload-"$hash"-* "$tmp"/zenius-downloads-"$hash" "$tmp"/zenius-downloads-"$hash"-*)
    # downloads.sys.mjs's fixed folder drops the hash's leading zeros. With
    # none to drop it's the folder above, which a dry run would list twice.
    if [[ $short != "$hash" ]]; then dirs+=("$tmp"/zenius-downloads-"$short"); fi
  fi
  for d in "${dirs[@]}"; do
    [[ -d $d && ! -L $d && -O $d ]] || continue
    if ((DRY)); then
      say "  would remove $d"
    else
      rm -rf -- "$d"
      n=$((n + 1))
    fi
  done
  eval "$had"
  if ((n)); then say "  removed $(plural "$n" "zenius upload or download folder")"; fi
}

# The sidebar's agent workspace: zenius's sidebar makes it in the profile,
# and rewrites its limit files before each agent session (the manager's
# ruling, 2026-11-21). install.sh never writes it. Nothing else uses it, so
# uninstall takes it out, with what the agents left there, after a backup.
WORKSPACE=$PROFILE/agent-sidebar-workspace
drop_workspace() {
  exists "$WORKSPACE" || return 0
  backup_once "$WORKSPACE"
  run rm -rf "$WORKSPACE"
  if ((DRY)); then
    say "  would remove the sidebar's agent workspace, $WORKSPACE, keeping it in the backup"
  else
    say "  removed the sidebar's agent workspace, $WORKSPACE (kept in $BACKUP)"
  fi
}

# What uninstall removes besides the runtime and the DNS pref, before the DNS
# pref's restore, which then finds user.js as it ends up.
drop_leftovers() {
  drop_zenius_prefs
  drop_staging
  drop_workspace
}

# What to check before anything changes: which profile, why that one, and
# whether a Zen has it open.
describe_target() {
  say "  profile chosen by: $PROFILE_FROM"
  if [[ -n $OWNER ]]; then
    say "  Zen (pid $OWNER) has this profile open: the change takes effect when the user quits and reopens it"
  else
    say "  no running Zen has this profile open"
  fi
}

# $@: the agent's scripts this run replaces or removes. A running Zen has
# loaded the user's own copy too, and loads its folder's files as it goes.
guard_running() {
  if [[ -z $OWNER ]] || ((WHILE_RUNNING)); then return 0; fi
  if exists "$JSDIR/zenius.uc.js" || exists "$JSDIR/zenius"; then
    die "Zen (pid $OWNER) has this profile open, and zenius is installed in it. Quit Zen first, or pass --while-running (that Zen then runs a mix of versions until it's reopened)."
  fi
  local c
  for c in "$@"; do
    if exists "$JSDIR/$c.uc.js" || exists "$JSDIR/$c"; then
      die "Zen (pid $OWNER) has this profile open, and runs its $c, which this would change. Quit Zen first, or pass --while-running (that Zen then runs a mix of versions until it's reopened)."
    fi
  done
}

# The agent's scripts an install put in this profile, one name per line. A
# name is a file name of ours; anything else in the file is skipped.
noted_components() {
  [[ -f $COMP_PRIOR ]] || return 0
  P=$PROFILE awk -F '\t' '$1 == ENVIRON["P"] && $2 ~ /^[A-Za-z0-9][A-Za-z0-9._-]*$/ { print $2 }' "$COMP_PRIOR"
}
is_noted() {
  [[ -f $COMP_PRIOR ]] || return 1
  P=$PROFILE C=$1 awk -F '\t' '$1 == ENVIRON["P"] && $2 == ENVIRON["C"] { found = 1; exit } END { exit !found }' "$COMP_PRIOR"
}
# The backup folder holding the user's own copy of script $1, or nothing.
noted_backup() {
  [[ -f $COMP_PRIOR ]] || return 0
  P=$PROFILE C=$1 awk -F '\t' '$1 == ENVIRON["P"] && $2 == ENVIRON["C"] { print $3; exit }' "$COMP_PRIOR"
}
# The fingerprint of zenius's copy of script $1 as an install left it, or
# nothing (an install that stopped before its copy was in place).
noted_print() {
  [[ -f $COMP_PRIOR ]] || return 0
  P=$PROFILE C=$1 awk -F '\t' '$1 == ENVIRON["P"] && $2 == ENVIRON["C"] { print $4; exit }' "$COMP_PRIOR"
}
# Note script $1: the folder that keeps the user's own copy ($2, empty when
# the profile had none) and the fingerprint of zenius's copy ($3, once it's
# in place).
note_component() {
  if ((DRY)); then return 0; fi
  ensure_home
  forget_component "$1"
  printf '%s\t%s\t%s\t%s\n' "$PROFILE" "$1" "$2" "${3:-}" >>"$COMP_PRIOR"
  chmod 600 "$COMP_PRIOR"
}
# What the profile holds of script $1, its .uc.js and its folder, as one
# value: their names, link targets and contents. "none" when it has neither.
fingerprint() {
  if ! exists "$JSDIR/$1.uc.js" && ! exists "$JSDIR/$1"; then
    echo none
    return
  fi
  (
    cd "$JSDIR"
    for f in "$1.uc.js" "$1"; do
      if exists "$f"; then
        find "$f" \( -type l -exec sh -c 'printf "%s -> %s\n" "$1" "$(readlink "$1")"' sh {} \; \) \
          -o \( -type f -exec cksum {} \; \) -o \( -type d -print \)
      fi
    done
  ) | LC_ALL=C sort | cksum | awk '{ print $1 "-" $2 }'
}
# Whether the profile's copy of script $1 is another than the one zenius
# installed: the user, or their own installer, put it there since.
changed_since() {
  local was now
  was=$(noted_print "$1")
  [[ -n $was ]] || return 1
  now=$(fingerprint "$1")
  [[ $now != none && $now != "$was" ]]
}
forget_component() {
  if ((DRY)) || [[ ! -f $COMP_PRIOR ]]; then return 0; fi
  P=$PROFILE C=$1 awk -F '\t' '!($1 == ENVIRON["P"] && $2 == ENVIRON["C"])' "$COMP_PRIOR" >"$COMP_PRIOR.tmp-$$"
  if [[ -s $COMP_PRIOR.tmp-$$ ]]; then
    chmod 600 "$COMP_PRIOR.tmp-$$"
    mv "$COMP_PRIOR.tmp-$$" "$COMP_PRIOR"
  else
    rm -f "$COMP_PRIOR.tmp-$$" "$COMP_PRIOR"
  fi
}
backup_component() {
  if exists "$JSDIR/$1.uc.js"; then backup "$JSDIR/$1.uc.js"; fi
  if exists "$JSDIR/$1"; then backup "$JSDIR/$1"; fi
}
# Uninstall's half for every script an install put here.
restore_components() {
  local c
  # Names are [A-Za-z0-9._-] (noted_components), so splitting is safe.
  for c in $(noted_components); do
    uninstall_component "$c" "$(noted_backup "$c")"
    forget_component "$c"
  done
}

finish_message() {
  if ((DRY)); then
    say "(dry run: nothing changed)"
  elif [[ -n $OWNER ]]; then
    say "Done. Zen is running: quit it and reopen it to $1."
  else
    say "Done. The next time Zen starts, it will $1."
  fi
  warn_other_zens
}

# Other Zens running from the same app, besides the one with this profile
# open: on a Mac, opening Zen from the Dock or Spotlight while one runs only
# brings that one forward, so the user's reopen after this script opens
# nothing (a headless dev Zen did that at the first install, 2026-11-21).
# The app's main binary only: content processes run plugin-container, or
# the binary with -contentproc. ZENIUS_APP_BIN names the binary on other
# systems (the tests); without it, the check runs on the Mac only, since a
# Linux Zen opens beside another profile's.
other_zens() {
  local bin=${ZENIUS_APP_BIN:-} pid cmd
  if [[ -z $bin && $(uname) == Darwin ]]; then bin=/Applications/Zen.app/Contents/MacOS/zen; fi
  [[ -n $bin ]] || return 0
  ps axo pid=,command= 2>/dev/null | while read -r pid cmd; do
    [[ $pid == "$OWNER" || $pid == "$$" ]] && continue
    [[ $cmd == "$bin" || $cmd == "$bin "* ]] || continue
    [[ $cmd == *" -contentproc"* ]] && continue
    printf '%s\t%s\n' "$pid" "$cmd"
  done
}

# Warns, never blocks: the install itself is done either way.
warn_other_zens() {
  local others pid cmd profile
  others=$(other_zens)
  [[ -n $others ]] || return 0
  say "Warning: another Zen from the same app is running. While it runs, opening Zen only brings it forward, so the reopen won't open this profile. Stop it before Zen is reopened (a dev Zen: scripts/zen-dev.sh <name> stop):"
  while IFS=$'\t' read -r pid cmd; do
    profile=$(printf '%s\n' "$cmd" | sed -n 's/.* -\{1,2\}profile \([^ ]*\).*/\1/p')
    say "  pid $pid${profile:+, profile $profile}"
  done <<<"$others"
}

install() {
  local src=$ROOT/runtime/JS
  [[ -f $PROFILE/chrome/utils/boot.sys.mjs ]] ||
    die "$PROFILE has no fx-autoconfig (chrome/utils/boot.sys.mjs), which zenius runs on"
  [[ -f $src/zenius.uc.js && -d $src/zenius ]] || die "no runtime in $src"
  local comps=() gone=() c
  for c in "${COMPONENTS[@]}"; do
    if [[ -f $src/$c.uc.js ]]; then comps+=("$c"); fi
  done
  # Scripts an earlier install put here that this checkout doesn't have: the
  # user's own copy goes back, as at uninstall.
  for c in $(noted_components); do
    if [[ ! -f $src/$c.uc.js ]]; then gone+=("$c"); fi
  done
  local sources=("$src/zenius.uc.js" "$src/zenius")
  for c in ${comps[@]+"${comps[@]}"}; do
    sources+=("$src/$c.uc.js")
    if [[ -d $src/$c ]]; then sources+=("$src/$c"); fi
  done
  [[ -z $(find "${sources[@]}" -type l -print -quit) ]] ||
    die "the runtime in $src contains links; install.sh only installs copies"
  guard_running ${comps[@]+"${comps[@]}"} ${gone[@]+"${gone[@]}"}
  if [[ -f $RECORD ]]; then
    local recorded
    recorded=$(json_get profile "$RECORD")
    if [[ -n $recorded && $recorded != "$PROFILE" && -f $recorded/chrome/JS/zenius/install.json ]]; then
      die "zenius is installed in another profile, $recorded (see $RECORD). Uninstall it there first: install.sh --uninstall --profile '$recorded'"
    fi
  fi
  local util=$src/zenius/modules/util.sys.mjs version protocol commit now
  version=$(sed -n 's/^export const RUNTIME_VERSION = "\(.*\)";$/\1/p' "$util")
  protocol=$(sed -n 's/^export const PROTOCOL_VERSION = \([0-9][0-9]*\);$/\1/p' "$util")
  [[ -n $version && -n $protocol ]] || die "can't read RUNTIME_VERSION and PROTOCOL_VERSION in $util"
  commit=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)
  if [[ $commit != unknown && -n $(git -C "$ROOT" status --porcelain -- runtime/JS 2>/dev/null) ]]; then
    commit=$commit-dirty
  fi
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  say "Installing zenius $version (protocol $protocol, commit $commit) into $PROFILE"
  describe_target
  local count
  count=$(($(find "${sources[@]}" -type f | wc -l) + 1))
  if ((DRY)); then
    if ((DISABLE_IPV6)); then
      say "  would write these $count files in the profile, and change nothing else there but one pref (below):"
    else
      say "  would write these $count files in the profile, and change nothing else there:"
    fi
    {
      printf '%s\n' chrome/JS/zenius/install.json
      (cd "$src" && find "${sources[@]#"$src"/}" -type f) | sed 's#^#chrome/JS/#'
    } | LC_ALL=C sort | sed 's/^/    /'
    say "  would record the install in $RECORD"
  fi
  if exists "$JSDIR/zenius.uc.js"; then backup "$JSDIR/zenius.uc.js"; fi
  if exists "$JSDIR/zenius"; then backup "$JSDIR/zenius"; fi
  # A script an earlier install put here is zenius's file too, unless the
  # user has put their own copy there since.
  local changed=" "
  for c in ${comps[@]+"${comps[@]}"}; do
    if ! is_noted "$c"; then continue; fi
    if changed_since "$c"; then changed+="$c "; else backup_component "$c"; fi
  done
  if ((BACKED_UP)); then
    if ((DRY)); then say "  would back up the zenius files it replaces to $BACKUP"; else say "  backed up the zenius files it replaces to $BACKUP"; fi
  else
    say "  no zenius files to back up: the profile has none yet"
  fi
  if ((DISABLE_IPV6)); then backup_user_js; fi
  # The first install of each script notes it in COMP_PRIOR before the swap,
  # so a run that stops halfway still leaves the way back: with the folder
  # that keeps the profile's own copy, or none when it had none.
  local own
  for c in ${comps[@]+"${comps[@]}"}; do
    own="the profile's own $c"
    if [[ $changed == *" $c "* ]]; then
      own="$own (changed since zenius installed it)"
    elif is_noted "$c"; then
      continue
    fi
    if exists "$JSDIR/$c.uc.js" || exists "$JSDIR/$c"; then
      backup_component "$c"
      note_component "$c" "$BACKUP"
      if ((DRY)); then
        say "  would back up $own to $BACKUP and put zenius's in its place; uninstall puts it back"
      else
        say "  backed up $own to $BACKUP; zenius's takes its place, and uninstall puts it back"
      fi
    else
      note_component "$c" ""
    fi
  done

  # Copy into a staging folder and swap it in, so a failed copy leaves the
  # previous install whole.
  STAGE=$JSDIR/.zenius-new-$$
  local old=$JSDIR/.zenius-old-$$
  run mkdir -p "$JSDIR"
  run cp -R "$src/zenius" "$STAGE"
  if ((!DRY)); then
    {
      printf '{\n'
      printf '  "runtimeVersion": %s,\n' "$(json_str "$version")"
      printf '  "protocol": %s,\n' "$protocol"
      printf '  "commit": %s,\n' "$(json_str "$commit")"
      printf '  "installedAt": %s,\n' "$(json_str "$now")"
      printf '  "profile": %s\n' "$(json_str "$PROFILE")"
      printf '}\n'
    } >"$STAGE/install.json"
  fi
  if exists "$JSDIR/zenius"; then run mv "$JSDIR/zenius" "$old"; fi
  run mv "$STAGE" "$JSDIR/zenius"
  STAGE=
  # Remove first: copying onto a link would write wherever it points.
  run rm -f "$JSDIR/zenius.uc.js"
  run cp "$src/zenius.uc.js" "$JSDIR/zenius.uc.js"
  run rm -rf "$old"
  for c in ${comps[@]+"${comps[@]}"}; do
    install_component "$c"
    if ((!DRY)); then note_component "$c" "$(noted_backup "$c")" "$(fingerprint "$c")"; fi
  done
  for c in ${gone[@]+"${gone[@]}"}; do
    uninstall_component "$c" "$(noted_backup "$c")"
    forget_component "$c"
  done

  if ((!DRY)); then
    ensure_home
    local files f
    files=$({
      printf '%s\n' "$JSDIR/zenius.uc.js"
      find "$JSDIR/zenius" -type f | LC_ALL=C sort
      for c in ${comps[@]+"${comps[@]}"}; do
        printf '%s\n' "$JSDIR/$c.uc.js"
        if [[ -d $JSDIR/$c ]]; then find "$JSDIR/$c" -type f | LC_ALL=C sort; fi
      done
    } | while IFS= read -r f; do printf '    %s,\n' "$(json_str "$f")"; done | sed '$ s/,$//')
    {
      printf '{\n'
      printf '  "profile": %s,\n' "$(json_str "$PROFILE")"
      printf '  "files": [\n%s\n  ],\n' "$files"
      if ((BACKED_UP)); then printf '  "backup": %s,\n' "$(json_str "$BACKUP")"; else printf '  "backup": null,\n'; fi
      printf '  "runtimeVersion": %s,\n' "$(json_str "$version")"
      printf '  "protocol": %s,\n' "$protocol"
      printf '  "commit": %s,\n' "$(json_str "$commit")"
      printf '  "installedAt": %s\n' "$(json_str "$now")"
      printf '}\n'
    } >"$RECORD.tmp-$$"
    chmod 600 "$RECORD.tmp-$$"
    mv "$RECORD.tmp-$$" "$RECORD"
    say "  wrote $count files in the profile (listed in $RECORD)"
  fi
  if ((DISABLE_IPV6)); then set_dns_pref; else keep_dns_pref; fi
  check_program
  finish_message "load zenius $version"
}

# fx-autoconfig's program part lives in the Zen app, which only the user
# changes, and a Zen update deletes its config.js.
check_program() {
  local appdir=
  if [[ $(uname) == Darwin ]]; then
    [[ -d /Applications/Zen.app ]] && appdir=/Applications/Zen.app/Contents/Resources
  elif [[ -n ${ZEN_BIN:-} ]]; then
    appdir=$(dirname "$ZEN_BIN")
  fi
  if [[ -n $appdir && ! -f $appdir/config.js ]]; then
    say "Warning: $appdir/config.js is missing (a Zen update removes it), so Zen won't load zenius."
    say "  zenius doctor shows how to put it back. That changes the Zen app, so it's the user's call."
  fi
}

# Put a component of this checkout in the profile, staged as the runtime is.
install_component() {
  local c=$1 src=$ROOT/runtime/JS old=$JSDIR/.$1-old-$$
  if [[ -d $src/$c ]]; then
    STAGE=$JSDIR/.$c-new-$$
    run cp -R "$src/$c" "$STAGE"
    if exists "$JSDIR/$c"; then run mv "$JSDIR/$c" "$old"; fi
    run mv "$STAGE" "$JSDIR/$c"
    STAGE=
    run rm -rf "$old"
  elif exists "$JSDIR/$c"; then
    # This version has no folder; the one there is in the backup.
    run rm -rf "$JSDIR/$c"
  fi
  run rm -f "$JSDIR/$c.uc.js"
  run cp "$src/$c.uc.js" "$JSDIR/$c.uc.js"
}

# Take zenius's copy of a script out, and put back the user's own copy from
# the backup its first install made (`orig`, empty when the profile had
# none). If that backup is gone, zenius's copy stays: the user keeps a
# working script.
uninstall_component() {
  local c=$1 orig=$2
  if changed_since "$c"; then
    if ((DRY)); then say "  would leave $c in place: it changed since zenius installed it, so it's the user's own"; else say "  left $c in place: it changed since zenius installed it, so it's the user's own"; fi
    return
  fi
  if [[ -n $orig ]] && ! exists "$orig/chrome/JS/$c.uc.js" && ! exists "$orig/chrome/JS/$c"; then
    if ((DRY)); then say "  would leave zenius's $c in place: the profile's own copy was kept in $orig, which is gone"; else say "  left zenius's $c in place: the profile's own copy was kept in $orig, which is gone"; fi
    return
  fi
  if exists "$JSDIR/$c.uc.js"; then
    backup "$JSDIR/$c.uc.js"
    run rm -f "$JSDIR/$c.uc.js"
  fi
  if exists "$JSDIR/$c"; then
    backup "$JSDIR/$c"
    run rm -rf "$JSDIR/$c"
  fi
  if [[ -z $orig ]]; then
    if ((DRY)); then say "  would remove $c (the profile had none before zenius)"; else say "  removed $c (the profile had none before zenius)"; fi
    return
  fi
  if exists "$orig/chrome/JS/$c.uc.js"; then run cp -Rp "$orig/chrome/JS/$c.uc.js" "$JSDIR/$c.uc.js"; fi
  if exists "$orig/chrome/JS/$c"; then run cp -Rp "$orig/chrome/JS/$c" "$JSDIR/$c"; fi
  if ((DRY)); then say "  would put back the profile's own $c from $orig"; else say "  put back the profile's own $c from $orig"; fi
}

uninstall() {
  local recorded= mine=0 noted
  [[ -f $RECORD ]] && recorded=$(json_get profile "$RECORD")
  [[ $recorded == "$PROFILE" ]] && mine=1
  # Plain names (noted_components), so they split safely below.
  noted=$(noted_components)
  if ! exists "$JSDIR/zenius.uc.js" && ! exists "$JSDIR/zenius"; then
    if ((mine)); then
      guard_running $noted
      run rm -f "$RECORD"
      say "zenius isn't in $PROFILE any more; removed its record, $RECORD."
      restore_components
      drop_leftovers
      restore_dns_pref
      return
    fi
    # A version from before the agent's scripts took zenius out, and left
    # the scripts and their notes.
    if [[ -n $noted ]]; then
      guard_running $noted
      say "zenius isn't in $PROFILE any more, but the agent's scripts it put there are"
      restore_components
      drop_leftovers
      restore_dns_pref
      return
    fi
    # A restore an earlier uninstall left while Zen ran.
    if [[ $(prior profile) == "$PROFILE" ]]; then
      say "zenius isn't in $PROFILE any more; restoring $DNS_PREF"
      drop_leftovers
      restore_dns_pref
      return
    fi
    if [[ -z $OWNER ]] && { zenius_prefs_in "$PROFILE/prefs.js" || zenius_prefs_in "$PROFILE/user.js"; }; then
      say "zenius isn't in $PROFILE any more; removing the preferences it left"
      drop_leftovers
      return
    fi
    if exists "$WORKSPACE"; then
      say "zenius isn't in $PROFILE any more; removing the sidebar's agent workspace it left"
      drop_leftovers
      return
    fi
    die "zenius isn't installed in $PROFILE"
  fi
  if ((!mine)) && [[ ! -f $JSDIR/zenius/install.json ]]; then
    die "the zenius files in $PROFILE weren't put there by install.sh (no chrome/JS/zenius/install.json, and $RECORD doesn't name this profile). Remove them by hand."
  fi
  guard_running $noted
  say "Removing zenius from $PROFILE"
  describe_target
  restore_components
  if exists "$JSDIR/zenius.uc.js"; then
    backup "$JSDIR/zenius.uc.js"
    run rm -f "$JSDIR/zenius.uc.js"
  fi
  if exists "$JSDIR/zenius"; then
    backup "$JSDIR/zenius"
    run rm -rf "$JSDIR/zenius"
  fi
  drop_leftovers
  restore_dns_pref
  if ((DRY)); then say "  would back up what it removes to $BACKUP"; else say "  backed up what it removed to $BACKUP"; fi
  if ((mine)); then run rm -f "$RECORD"; fi
  local kept="$ZHOME (backups, zenius's task records, the CLI if installed)"
  # The user's chats with zenius's sidebar: theirs, so Undo neither removes
  # nor copies them (zen-sdk's runbook lists them as staying).
  if exists "$PROFILE/agent-sidebar-tasks.json"; then
    kept+=", the sidebar's chats ($PROFILE/agent-sidebar-tasks.json)"
  fi
  say "  left in place: $kept, and the Agents Space in Zen if there is one, which stays as an ordinary Space with its tabs"
  finish_message "run without zenius"
}

"$MODE"
