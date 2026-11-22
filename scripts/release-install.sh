#!/usr/bin/env bash
# zen(ius)'s one-command installer, for one release. scripts/release.sh fills
# in the version, the package's URL and its SHA-256, and the release
# publishes the result as install.sh:
#
#   curl -fsSL https://github.com/zhuconv/zenius/releases/latest/download/install.sh | bash
#   bash install.sh [--profile <dir>]   install zen(ius), or update it to this release
#   bash install.sh --uninstall [--profile <dir>]
#                                       take zen(ius) out again
#
# It downloads the package, checks its SHA-256, unpacks it into
# ~/.zenius/release, and runs the package's own installers:
# - scripts/install.sh puts zen(ius) into Zen's profile (the one Zen opens,
#   or --profile), adding fx-autoconfig's loader when the profile has none.
#   It backs up each file it replaces under ~/.zenius/backups/.
# - scripts/install-cli.sh installs the zenius command in ~/.local/bin, and
#   links the zen(ius) skill where Claude Code and Codex look for skills
#   (leaving a copy that `npx skills` put there).
# - Zen's sidebar gets its agents: the ACP adapters for Claude Code and Codex,
#   at the versions in runtime/agents/package-lock.json, go in
#   ~/.zenius/agents (npm ci, with no install scripts and none of the
#   adapters' optional CLI binaries: the sidebar runs the user's own CLIs),
#   and ~/.zenius/agents/node links to the node found here, which the sidebar
#   runs them with.
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

VERSION='@VERSION@'
URL=${ZENIUS_RELEASE_URL:-'@URL@'}
SHA256='@SHA256@'

ZHOME=${ZENIUS_HOME:-$HOME/.zenius}
RELEASE=$ZHOME/release
AGENTS=$ZHOME/agents

say() { printf 'zen(ius): %s\n' "$*"; }
die() { printf 'zen(ius): %s\n' "$*" >&2; exit 1; }

mode=install profile=''
while (($#)); do
  case $1 in
    --uninstall) mode=uninstall; shift ;;
    --profile)
      [[ $# -ge 2 && -n $2 ]] || { echo "zen(ius): --profile takes a folder" >&2; exit 2; }
      profile=$2; shift 2 ;;
    -h | --help) sed -n '2,/^$/{s/^# \{0,1\}//;p;}' "$0" 2>/dev/null || echo "See https://github.com/zhuconv/zenius"; exit 0 ;;
    *) echo "zen(ius): unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done

case $(uname) in
  Darwin | Linux) ;;
  *) die "zen(ius) runs on macOS and Linux only" ;;
esac

# The installers' own arguments for the profile, without an empty array (bash
# 3.2, macOS's, treats "${a[@]}" of an empty array as unset under set -u).
run_install() {
  if [[ -n $profile ]]; then "$RELEASE/scripts/install.sh" "$@" --profile "$profile"; else "$RELEASE/scripts/install.sh" "$@"; fi
}

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
run_install --loader || { app_note; die "scripts/install.sh failed (above)"; }

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
if [[ -n $skill_dirs ]]; then
  ZENIUS_SKILL_DIRS=${skill_dirs# } "$RELEASE/scripts/install-cli.sh" --skill || die "scripts/install-cli.sh failed (above)"
else
  "$RELEASE/scripts/install-cli.sh" || die "scripts/install-cli.sh failed (above)"
fi

# The sidebar's agents, when the release has them (zen-ux's runtime/agents):
# npm checks each package against the lock's integrity hashes.
if [[ -f $RELEASE/runtime/agents/package.json && -f $RELEASE/runtime/agents/package-lock.json ]]; then
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
