#!/usr/bin/env bash
# zen(ius)'s one-command installer, for one release. scripts/release.sh fills
# in the version, the package's URL and its SHA-256, and the release
# publishes the result as install.sh:
#
#   curl -fsSL https://github.com/zhuconv/zenius/releases/latest/download/install.sh | bash
#   ... | bash -s -- [<choices>]        the same, with choices
#   bash install.sh [--profile <dir>] [<choices>]
#                                       install zen(ius), or update it to this release
#   bash install.sh --uninstall [--profile <dir>]
#                                       take zen(ius) out again
#
# The choices, made once at the first install: an update keeps them, with no
# flag again.
#   --sandbox            the zenius command runs in a sandbox, the launcher's
#                        (install-cli.sh --sandbox); it needs Node 24 first on PATH
#   --read-dir <dir>     with --sandbox: scripts may also read <dir>, such as
#                        ~/Downloads, for uploads, and never write it
#   --working-dir <dir>  the working folder, ~/zenius-files unless this says:
#                        the agent's downloads land there, and its scripts read,
#                        write and delete files there. It goes in
#                        ~/.zenius/config.json, and changing it moves no files.
#                        Needed with a ZENIUS_HOME other than ~/.zenius that
#                        holds no config.json yet
#   --disable-ipv6       Zen makes no IPv6 lookups (scripts/install.sh
#                        --disable-ipv6, a line in the profile's user.js), for a
#                        network that has only IPv4
#
# It downloads the package, checks its SHA-256, unpacks it into
# ~/.zenius/release, and runs the package's own installers:
# - scripts/install.sh puts zen(ius) into Zen's profile (the one Zen opens,
#   or --profile), adding fx-autoconfig's loader when the profile has none.
#   It backs up each file it replaces under ~/.zenius/backups/.
# - scripts/install-cli.sh installs the zenius command in ~/.local/bin, and
#   links the zen(ius) skill where Claude Code and Codex look for skills
#   (leaving a copy that `npx skills` put there). A sandboxed launcher there
#   (install-cli.sh --sandbox, with its folders) stays as it is, and needs
#   its Node first on PATH: without it, this stops before it changes
#   anything.
# - Zen's sidebar gets its agents: the ACP adapters for Claude Code and Codex,
#   at the versions in runtime/agents/package-lock.json, go in
#   ~/.zenius/agents (npm ci, with no install scripts and none of the
#   adapters' optional CLI binaries: the sidebar runs the user's own CLIs),
#   and ~/.zenius/agents/node links to the node found here, which the sidebar
#   runs them with. The user's own config.json for the sidebar
#   (~/Library/Application Support/zenius-agent-sidebar/config.json) names the
#   agents it runs instead, so then no adapters are added; ones an earlier
#   install put there are kept up to date.
# It never quits, starts or restarts Zen, and never changes Zen's app: when
# the app lacks fx-autoconfig's two files, it ends by printing the commands
# that copy them (exit status 3).
#
# Exit status: 0 done, 1 an error (the message says what's left; running it
# again is safe), 2 a wrong argument, 3 installed, with fx-autoconfig's two
# app files left to copy.
#
# ZENIUS_RELEASE_URL downloads the package from elsewhere, such as a file://
# URL in tests; its SHA-256 must still match. ZENIUS_HOME (default ~/.zenius),
# ZEN_BIN (Linux) and ZEN_APP (macOS, default /Applications/Zen.app) are
# read as the installers read them.

set -euo pipefail

# The whole installer is main(), run from the last line: `curl … | bash`
# runs a script while bash still reads it from the pipe, so bash must have
# read all of it before any of it runs. A download cut short then runs
# nothing, and a stop before the end leaves curl no closed pipe to write
# into. The body keeps its indentation, as it was before main() held it.
main() {

VERSION='@VERSION@'
URL=${ZENIUS_RELEASE_URL:-'@URL@'}
SHA256='@SHA256@'

ZHOME=${ZENIUS_HOME:-$HOME/.zenius}
RELEASE=$ZHOME/release
AGENTS=$ZHOME/agents

say() { printf 'zen(ius): %s\n' "$*"; }
die() { printf 'zen(ius): %s\n' "$*" >&2; exit 1; }

# The choices go to the installers as given, and those check them. Under
# set -u, bash 3.2 (macOS's /bin/bash) treats an empty array, and an empty
# "$@", as unset, so they expand as ${a[@]+"${a[@]}"} and ${1+"$@"}.
mode=install profile='' choices=0 cli_args=() install_args=() working=''
while (($#)); do
  case $1 in
    --uninstall) mode=uninstall; shift ;;
    --profile)
      [[ $# -ge 2 && -n $2 ]] || { echo "zen(ius): --profile takes a folder" >&2; exit 2; }
      profile=$2; shift 2 ;;
    --sandbox) cli_args+=(--sandbox); choices=1; shift ;;
    --read-dir)
      [[ $# -ge 2 && -n $2 ]] || { echo "zen(ius): $1 takes a folder" >&2; exit 2; }
      cli_args+=("$1" "$2"); choices=1; shift 2 ;;
    --working-dir)
      [[ $# -ge 2 && -n $2 ]] || { echo "zen(ius): $1 takes a folder" >&2; exit 2; }
      cli_args+=("$1" "$2"); install_args+=("$1" "$2"); working=$2; choices=1; shift 2 ;;
    --output-dir)
      echo "zen(ius): --output-dir is gone: scripts write their files in the working folder, which --working-dir sets (~/zenius-files by default)" >&2
      exit 2 ;;
    --disable-ipv6) install_args+=(--disable-ipv6); choices=1; shift ;;
    -h | --help) sed -n '2,/^$/{s/^# \{0,1\}//;p;}' "$0" 2>/dev/null || echo "See https://github.com/zhuconv/zenius"; exit 0 ;;
    *) echo "zen(ius): unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done

if [[ $mode == uninstall ]] && ((choices)); then
  echo "zen(ius): --sandbox, --read-dir, --working-dir and --disable-ipv6 go with an install, not --uninstall" >&2
  exit 2
fi

# $1 with its existing part's links resolved, as scripts/working-folder.sh
# compares paths.
real_path() {
  local path=$1 rest=
  while [[ ! -e $path ]]; do rest=/$(basename "$path")$rest path=$(dirname "$path"); done
  echo "$(cd "$path" && pwd -P)$rest"
}

# ~/zenius-files is the default working folder only while zenius's home is
# ~/.zenius. A ZENIUS_HOME elsewhere without a config file naming one needs
# --working-dir, as both installers check; this says so before the download.
if [[ $mode == install && -z $working && -n ${ZENIUS_HOME:-} && ! -e $ZHOME/config.json ]] &&
  [[ "$(real_path "$ZENIUS_HOME")" != "$(real_path "$HOME/.zenius")" ]]; then
  echo "zen(ius): there's no default working folder: ZENIUS_HOME is $ZENIUS_HOME, not ~/.zenius, and it holds no config.json: pass --working-dir <folder>" >&2
  exit 2
fi

case $(uname) in
  Darwin | Linux) ;;
  *) die "zen(ius) runs on macOS and Linux only" ;;
esac

# The installers' own arguments for the profile, without an empty array (bash
# 3.2, macOS's, treats "${a[@]}" of an empty array as unset under set -u).
run_install_from() {
  local root=$1
  shift
  if [[ -n $profile ]]; then "$root/scripts/install.sh" "$@" --profile "$profile"; else "$root/scripts/install.sh" "$@"; fi
}
run_install() { run_install_from "$RELEASE" "$@"; }

if [[ $mode == uninstall ]]; then
  [[ -x $RELEASE/scripts/install.sh && -x $RELEASE/scripts/install-cli.sh ]] ||
    die "there's no zen(ius) release in $RELEASE to uninstall with"
  say "taking zen(ius) out of Zen's profile"
  run_install --uninstall || die "scripts/install.sh --uninstall failed (above); nothing more was changed"
  say "removing the zenius command and its skill links"
  "$RELEASE/scripts/install-cli.sh" --uninstall || die "scripts/install-cli.sh --uninstall failed (above)"
  rm -rf "$AGENTS" "$RELEASE"
  say "zen(ius) is uninstalled. Backups of what it replaced stay in $ZHOME/backups/. Quit and reopen Zen if it's running."
  exit 0
fi

# What the zenius command needs.
command -v curl >/dev/null || die "curl is missing: install it, then run this again"
command -v tar >/dev/null || die "tar is missing: install it, then run this again"
command -v node >/dev/null || die "the zenius command needs Node.js 22.3 or later, and there's no node on PATH: get it from https://nodejs.org or your package manager, then run this again"
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 3) ? 0 : 1)' ||
  die "the zenius command needs Node.js 22.3 or later, and node is $(node --version): update it, then run this again"

# Zen's app folder, where fx-autoconfig's other two files live.
if [[ $(uname) == Darwin ]]; then
  app=${ZEN_APP:-/Applications/Zen.app}
  [[ -d $app ]] || die "Zen isn't at $app: install it from https://zen-browser.app, or set ZEN_APP to its .app"
  appdir=$app/Contents/Resources
else
  bin=${ZEN_BIN:-}
  if [[ -z $bin ]]; then bin=$(command -v zen || true); fi
  [[ -n $bin ]] || die "there's no zen on PATH: install Zen from https://zen-browser.app, or set ZEN_BIN to its zen binary"
  appdir=$(cd "$(dirname "$(readlink -f "$bin")")" && pwd)
  [[ -f $appdir/application.ini || -f $appdir/omni.ja ]] ||
    die "$appdir doesn't look like Zen's app folder (no application.ini): set ZEN_BIN to the zen binary inside it"
fi

missing=''
[[ -f $appdir/config.js ]] || missing=1
[[ -f $appdir/defaults/pref/config-prefs.js ]] || missing=1

# The two commands for fx-autoconfig's app files, printed and never run: on
# success, and also when an installer stops (after a Zen update, Zen is
# usually running, and install.sh won't change a loaded zen(ius)).
app_note() {
  [[ -n $missing && -d $RELEASE/runtime/vendor/fx-autoconfig/program ]] || return 0
  local vendor=$RELEASE/runtime/vendor/fx-autoconfig/program
  echo
  echo "Zen loads zen(ius) through fx-autoconfig, and two of its files go in Zen's app"
  echo "folder, $appdir, where they're missing now. zen(ius) leaves Zen's app to you:"
  echo "it changes only your profile, where it backs up what it replaces and can take"
  echo "it all out again. Copy the two files with:"
  echo
  printf '  cp %q %q\n' "$vendor/config.js" "$appdir/"
  printf '  mkdir -p %q\n' "$appdir/defaults/pref"
  printf '  cp %q %q\n' "$vendor/defaults/pref/config-prefs.js" "$appdir/defaults/pref/"
  echo
  if [[ $(uname) == Darwin ]]; then
    echo "If macOS says the terminal was prevented from modifying apps, allow it under"
    echo "System Settings > Privacy & Security > App Management, or copy the files in"
    echo "Finder (Show Package Contents on Zen.app)."
  fi
  echo "A Zen update replaces its app folder and drops these two files: run this"
  echo "installer again, or zenius doctor, to see these commands again."
}

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/zenius-install.XXXXXX")
trap 'rm -rf "$work"' EXIT

say "downloading zen(ius) $VERSION"
curl -fsSL "$URL" -o "$work/package.tar.gz" || die "couldn't download $URL"
got=$(sha256 "$work/package.tar.gz")
[[ $got == "$SHA256" ]] || die "the download's SHA-256 is $got, not the release's $SHA256: not installing it"
say "SHA-256 matches: $SHA256"
mkdir "$work/unpacked"
tar -xzf "$work/package.tar.gz" -C "$work/unpacked" || die "couldn't unpack the package"
src=$work/unpacked/zenius-$VERSION
[[ -f $src/RELEASE && -x $src/scripts/install.sh && -x $src/scripts/install-cli.sh ]] ||
  die "the package doesn't hold zen(ius) $VERSION"

# install-cli.sh keeps a sandboxed launcher on an update, and the sandbox runs
# only on its own Node major. Check that before anything changes: otherwise
# the runtime would be updated and the CLI not.
bin_dir=${ZENIUS_BIN_DIR:-$HOME/.local/bin}
if [[ -f $bin_dir/zenius && ! -L $bin_dir/zenius ]] && sed -n 2p "$bin_dir/zenius" | grep -q '(zenius-sandbox-launcher '; then
  want=$(sed -n 's/^SANDBOX_NODE_MAJOR=\([0-9][0-9]*\)$/\1/p' "$src/scripts/install-cli.sh")
  have=$(node -p process.versions.node)
  if [[ -n $want && ${have%%.*} != "$want" ]]; then
    die "$bin_dir/zenius is the sandboxed launcher, which this release keeps, and it needs Node $want first on PATH; node is $have ($(command -v node)). Put Node $want first (on a Mac, Homebrew's is in /opt/homebrew/opt/node@$want/bin), then run this again: nothing has changed"
  fi
fi

# The skill goes where Claude Code and Codex look, except where a copy that
# isn't install-cli.sh's link already is (npx skills puts one there).
skill_dirs=''
for dir in ${ZENIUS_SKILL_DIRS:-$HOME/.claude/skills $HOME/.agents/skills}; do
  if [[ -e $dir/zenius && ! -L $dir/zenius ]]; then
    say "keeping $dir/zenius, a copy of the skill installed another way"
  else
    skill_dirs="$skill_dirs $dir"
  fi
done

# install-cli.sh from the release at $1, with the skill and the choices, plus
# any more arguments (--dry-run).
cli() {
  local root=$1
  shift
  if [[ -n $skill_dirs ]]; then
    ZENIUS_SKILL_DIRS=${skill_dirs# } "$root/scripts/install-cli.sh" --skill ${1+"$@"} ${cli_args[@]+"${cli_args[@]}"}
  else
    "$root/scripts/install-cli.sh" ${1+"$@"} ${cli_args[@]+"${cli_args[@]}"}
  fi
}

# install-cli.sh's own checks, before anything changes: its dry run with the
# same arguments fails where the install would (a sandbox without its Node or
# bubblewrap, a folder it won't take, a file in its way), and changes nothing.
rc=0
checked=$(cli "$src" --dry-run 2>&1) || rc=$?
if ((rc)); then
  reasons=$(printf '%s\n' "$checked" | grep -E '^(error|skip|install-cli\.sh:) ' || true)
  printf '%s\n' "${reasons:-$checked}" >&2
  ((rc != 2)) || { echo "zen(ius): a wrong argument (above): nothing has changed" >&2; exit 2; }
  die "the zenius command can't be installed with these choices (above): nothing has changed"
fi
# And install.sh's (the profile, the working folder against Zen's profile
# and app), so a refusal there also comes before the release is swapped in.
rc=0
checked=$(run_install_from "$src" --dry-run --loader ${install_args[@]+"${install_args[@]}"} 2>&1) || rc=$?
if ((rc)); then
  reasons=$(printf '%s\n' "$checked" | grep -E '^install\.sh: ' || true)
  printf '%s\n' "${reasons:-$checked}" >&2
  ((rc != 2)) || { echo "zen(ius): a wrong argument (above): nothing has changed" >&2; exit 2; }
  die "zen(ius) can't be installed in Zen with these choices (above): nothing has changed"
fi

# The release stays in ~/.zenius/release: it's what --uninstall and doctor's
# fixes run, and swapped in whole, so no file of an earlier one lingers.
mkdir -p "$ZHOME"
rm -rf "$RELEASE.new" "$RELEASE.old"
mv "$src" "$RELEASE.new"
if [[ -e $RELEASE ]]; then mv "$RELEASE" "$RELEASE.old"; fi
mv "$RELEASE.new" "$RELEASE"
rm -rf "$RELEASE.old"
say "unpacked into $RELEASE"

# --loader puts fx-autoconfig's loader into a profile that has none, and
# leaves one that's there as it is.
run_install --loader ${install_args[@]+"${install_args[@]}"} || { app_note; die "scripts/install.sh failed (above)"; }

cli "$RELEASE" || die "scripts/install-cli.sh failed (above)"

# The sidebar's agents, when the release has them (zen-ux's runtime/agents):
# npm checks each package against the lock's integrity hashes. The sidebar
# reads the user's own config.json first, and its agents win over the
# built-in ones, whose adapters would then never run: an install that has
# none adds none. Adapters already there are kept up to date.
sidebar_config="$HOME/Library/Application Support/zenius-agent-sidebar/config.json"
if [[ -f $RELEASE/runtime/agents/package.json && -f $sidebar_config && ! -d $AGENTS ]]; then
  say "not installing the sidebar's built-in agents: $sidebar_config names its agents, and they win over the built-in ones (without that file, run this again to get them)"
elif [[ -f $RELEASE/runtime/agents/package.json && -f $RELEASE/runtime/agents/package-lock.json ]]; then
  command -v npm >/dev/null ||
    die "zen(ius) is installed, but not the sidebar's agents: npm is missing (it comes with Node.js). Install it, then run this again"
  say "installing the sidebar's agents (the ACP adapters for Claude Code and Codex) into $AGENTS"
  mkdir -p "$AGENTS"
  cp "$RELEASE/runtime/agents/package.json" "$RELEASE/runtime/agents/package-lock.json" "$AGENTS/"
  (cd "$AGENTS" && npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=error) ||
    die "zen(ius) is installed, but not the sidebar's agents: npm ci failed in $AGENTS (above). Run this again to retry"
  ln -sfn "$(command -v node)" "$AGENTS/node"
fi
# install-cli.sh has said whether the zenius command's folder is on PATH.

if [[ -n $missing ]]; then
  echo
  say "zen(ius) $VERSION is installed, with one step left for you."
  app_note
  echo "Then open Zen (quit and reopen it if it's running), and run: zenius doctor"
  exit 3
fi

echo
say "zen(ius) $VERSION is installed. Open Zen (quit and reopen it if it's running), then run: zenius doctor"
}

# ${1+"$@"}: with no arguments, macOS's bash 3.2 under set -u calls "$@" unbound.
main ${1+"$@"}
