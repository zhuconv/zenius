#!/usr/bin/env bash
# Install the zenius CLI from this checkout for agents to call, and optionally
# its entry Skill where Claude Code and Codex look for skills.
#
#   scripts/install-cli.sh               build the bundle, copy the CLI to ~/.zenius/cli,
#                                        and link ~/.local/bin/zenius to the copy
#   scripts/install-cli.sh --skill       also link ~/.claude/skills/zenius and
#                                        ~/.agents/skills/zenius to the copy's Skill,
#                                        where Claude Code and Codex find user skills
#   scripts/install-cli.sh --sandbox     make ~/.local/bin/zenius itself a launcher that runs
#                                        the CLI in a sandbox (bubblewrap on Linux, sandbox-exec
#                                        on macOS), so every zenius command gets it; see
#                                        sdk/sandbox/launcher.sh. It needs Node 24 first on
#                                        PATH, and agents then run that node, not the PATH's.
#                                        A later install keeps it, with or without --sandbox.
#                                        A script reads and writes the working folder, reads
#                                        the folder it started in, and writes nothing else
#   ... --sandbox --read-dir DIR         also let scripts read DIR (absolute), such as
#                                        ~/Downloads, for uploads, and never write it;
#                                        later installs keep it, and --read-dir none drops it
#   scripts/install-cli.sh --working-dir DIR
#                                        the working folder (absolute): downloads land there,
#                                        and scripts read, write and delete files there.
#                                        ~/zenius-files by default (none with a ZENIUS_HOME
#                                        other than ~/.zenius); later installs keep it.
#                                        It's written to ~/.zenius/config.json, which Zen's
#                                        runtime reads too, and made if missing. Changing it
#                                        moves no files. It can't be a project's folder
#                                        (see scripts/working-folder.sh)
#   scripts/install-cli.sh --no-sandbox  make ~/.local/bin/zenius a link to the copy again
#   scripts/install-cli.sh --uninstall   remove the copy, the links to it and the launcher
#   scripts/install-cli.sh --dry-run ... print what would change, and with --sandbox the
#                                        launcher it would write; change nothing
#
# The copy has the bundle and no TypeScript sources, so it always runs the
# bundle: it needs only Node 22.3 or later, and it doesn't change when this
# checkout does (a daily setup never links into a checkout). Rerun after
# pulling to install the new version. Building needs sdk/node_modules (npm ci
# in sdk/) and works on Node 22.3 or later; without node_modules, a bundle
# that is current with the sources is used. A failed build stops the install.
#
# It replaces only its own copy, and links that point to a zenius CLI or Skill;
# never another file, directory or link. It never touches Zen: installing the
# runtime into Zen is scripts/install.sh. ZENIUS_CLI_DIR, ZENIUS_BIN_DIR and
# ZENIUS_SKILL_DIRS (space-separated) override the target directories.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DEST=${ZENIUS_CLI_DIR:-${ZENIUS_HOME:-$HOME/.zenius}/cli}
BIN_DIR=${ZENIUS_BIN_DIR:-$HOME/.local/bin}
read -r -a SKILL_DIRS <<<"${ZENIUS_SKILL_DIRS:-$HOME/.claude/skills $HOME/.agents/skills}"
BUNDLE=$ROOT/sdk/dist/zenius.mjs
# The Node major the sandbox's canary passes on (24.22.2, on the Linux server and the Mac).
# Under 23.5 the permission model doesn't check lstat or realpath, and some
# fs.promises calls outside the grants throw uncaught.
SANDBOX_NODE_MAJOR=24

# The working folder's rules and its config file.
# shellcheck source=working-folder.sh
. "$ROOT/scripts/working-folder.sh"

skill=0 uninstall=0 dry=0 sandbox=0 no_sandbox=0 working_dir= take_working=0 read_dir= read_set=0 take_read=0
# ${1+"$@"}: with no arguments, macOS's bash 3.2 under set -u calls "$@" unbound.
for arg in ${1+"$@"}; do
  if ((take_working)); then working_dir=$arg take_working=0; continue; fi
  if ((take_read)); then read_dir=$arg read_set=1 take_read=0; continue; fi
  case $arg in
    --skill) skill=1 ;;
    --working-dir) take_working=1 ;;
    --working-dir=*) working_dir=${arg#--working-dir=} ;;
    --output-dir | --output-dir=*)
      echo "install-cli.sh: --output-dir is gone: scripts write their files in the working folder, which --working-dir sets (~/zenius-files by default)" >&2
      exit 2
      ;;
    --read-dir) take_read=1 ;;
    --read-dir=*) read_dir=${arg#--read-dir=} read_set=1 ;;
    --sandbox) sandbox=1 ;;
    --no-sandbox) no_sandbox=1 ;;
    --uninstall) uninstall=1 ;;
    --dry-run) dry=1 ;;
    -h | --help) sed -n '2,/^[^#]/{/^#/p;}' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install-cli.sh: unknown argument: $arg (see --help)" >&2; exit 2 ;;
  esac
done
if ((take_working)) || [[ -n $working_dir && $working_dir != /* ]]; then
  echo "install-cli.sh: --working-dir takes an absolute path" >&2
  exit 2
fi
if ((take_read)) || { ((read_set)) && [[ $read_dir != none && $read_dir != /* ]]; }; then
  echo "install-cli.sh: --read-dir takes an absolute path, or none" >&2
  exit 2
fi
if ((sandbox && no_sandbox)); then
  echo "install-cli.sh: --sandbox and --no-sandbox can't go together" >&2
  exit 2
fi

# Make a change, unless this is a dry run.
act() { if ((!dry)); then "$@"; fi; }

# One line per change: what it did, or in a dry run what it would do.
#   report <done> <would> <what>, as in: report linked link "$path -> $target"
report() { if ((dry)); then echo "would $2 $3"; else printf '%-8s %s\n' "$1" "$3"; fi; }

# A link this script may replace points to a zenius CLI or Skill, in a copy
# or in a checkout (where earlier versions of this script linked).
ours() { [[ $1 == */sdk/bin/zenius || $1 == */skill/zenius ]]; }

# A directory this script may replace or remove: a copy it made.
is_copy() { [[ -f $1/install.json && -f $1/sdk/bin/zenius ]]; }

# The sandboxed launcher this script writes: a file, not a link, marked on
# its second line.
is_launcher() { [[ -f $1 && ! -L $1 ]] && sed -n 2p "$1" | grep -q '(zenius-sandbox-launcher '; }

link() {
  local target=$1 path=$2 current
  if is_launcher "$path"; then
    act rm "$path"
    act ln -s "$target" "$path"
    report updated update "$path -> $target (was the sandboxed launcher)"
  elif [[ -L $path ]]; then
    current=$(readlink "$path")
    if [[ $current == "$target" ]]; then
      echo "ok       $path -> $target"
      return 0
    fi
    if ! ours "$current"; then
      echo "skip     $path links to $current, which isn't a zenius CLI or Skill; left alone" >&2
      return 1
    fi
    act ln -sfn "$target" "$path"
    report updated update "$path -> $target (was $current)"
  elif [[ -e $path ]]; then
    echo "skip     $path exists and isn't a symlink; left alone" >&2
    return 1
  else
    act mkdir -p "$(dirname "$path")"
    act ln -s "$target" "$path"
    report linked link "$path -> $target"
  fi
}

unlink_ours() {
  local path=$1
  if is_launcher "$path"; then
    act rm "$path"
    report removed remove "$path (the sandboxed launcher)"
  elif [[ -L $path ]] && [[ $(readlink "$path") == "$DEST"/* || $(readlink "$path") == "$ROOT"/* ]]; then
    act rm "$path"
    report removed remove "$path"
  elif [[ -e $path || -L $path ]]; then
    echo "skip     $path isn't a link to $DEST; left alone" >&2
  fi
}

skill_links() { local dir; for dir in "${SKILL_DIRS[@]}"; do echo "$dir/zenius"; done; }

if ((uninstall)); then
  unlink_ours "$BIN_DIR/zenius"
  while read -r path; do unlink_ours "$path"; done < <(skill_links)
  if is_copy "$DEST"; then
    act rm -rf "$DEST"
    report removed remove "$DEST"
  elif [[ -e $DEST ]]; then
    echo "skip     $DEST isn't a zenius CLI copy; left alone" >&2
  fi
  exit 0
fi

if [[ -e $DEST ]] && ! is_copy "$DEST"; then
  echo "skip     $DEST exists and isn't a zenius CLI copy; left alone" >&2
  exit 1
fi
if ! command -v node >/dev/null || ! node -e 'process.exit(typeof process.getBuiltinModule === "function" ? 0 : 1)'; then
  echo "warning  zenius needs Node 22.3 or later on PATH; found: $(command -v node >/dev/null && node --version || echo none)" >&2
fi

# A path with its existing part's links resolved, as sandbox rules need it.
resolve() {
  local path=$1 rest=
  while [[ ! -e $path ]]; do rest=/$(basename "$path")$rest path=$(dirname "$path"); done
  echo "$(cd "$path" && pwd -P)$rest"
}

# A value the launcher at $BIN_DIR/zenius was written with, such as READ_DIR.
launcher_value() {
  node - "$BIN_DIR/zenius" "$1" <<'EOF'
const [file, name] = process.argv.slice(2);
const line = require("node:fs").readFileSync(file, "utf8").split("\n").find((text) => text.startsWith(`${name}=`));
if (line) process.stdout.write(line.slice(name.length + 1).replace(/^'([^]*)'$/, "$1").replaceAll("'\\''", "'"));
EOF
}

# A sandbox, once chosen, stays: an install without --sandbox, such as an
# update, keeps the launcher, so agents never quietly lose it.
if ((!sandbox && !no_sandbox)) && is_launcher "$BIN_DIR/zenius"; then
  sandbox=1
  echo "note     $BIN_DIR/zenius is the sandboxed launcher, and this install keeps it (--no-sandbox makes it a link again)"
fi

# The working folder: --working-dir, else the one ~/.zenius/config.json
# names, else ~/zenius-files. It may neither hold nor be inside the CLI copy,
# the zenius command's folder or its node.
kept=("$(resolve "$DEST")" "$(resolve "$BIN_DIR")")
if command -v node >/dev/null; then
  node_real=$(node -p 'require("node:fs").realpathSync(process.execPath)')
  kept+=("$(dirname "$(dirname "$node_real")")" "$(resolve "$(dirname "$(command -v node)")")")
fi
picked=0
working=$(wf_pick "$working_dir" "${kept[@]}") || picked=$?
if ((picked)); then
  echo "error    $working" >&2
  # 2 when there's no folder to pick without --working-dir, as for a wrong
  # argument.
  exit $((picked == 2 ? 2 : 1))
fi
working_real=$(wf_resolve "$working")
# An earlier sandboxed launcher kept runs' output folders (--output-dir); the
# working folder takes their place.
if ((sandbox)) && is_launcher "$BIN_DIR/zenius" && old_out=$(launcher_value OUT_ROOT) && [[ -n $old_out ]]; then
  echo "note     scripts now write in the working folder, $working, not in runs' output folders: $old_out keeps earlier runs' files, which zenius no longer uses"
fi

# --sandbox needs the OS sandbox and Node's permission model, or it installs nothing.
if ((sandbox)); then
  sandbox_error() { echo "error    --sandbox: $1" >&2; exit 1; }
  case $(uname) in
    Linux)
      platform=linux bwrap=$(command -v bwrap || true)
      [[ -n $bwrap ]] || sandbox_error "it needs bubblewrap (bwrap) on PATH: install it, or install with --no-sandbox"
      "$bwrap" --ro-bind / / --unshare-all --die-with-parent true 2>/dev/null ||
        sandbox_error "$bwrap can't make a sandbox here (are unprivileged user namespaces off?)"
      ;;
    Darwin)
      platform=macos bwrap=
      [[ -x /usr/bin/sandbox-exec ]] || sandbox_error "it needs /usr/bin/sandbox-exec"
      ;;
    *) sandbox_error "it supports Linux and macOS, not $(uname)" ;;
  esac
  # The launcher's shell starts with -p, and finds its commands in /usr/bin
  # and /bin only.
  /bin/sh -p -c : 2>/dev/null || sandbox_error "the launcher needs a /bin/sh that takes -p"
  for tool in mkdir chmod find mktemp readlink; do
    [[ -x /usr/bin/$tool || -x /bin/$tool ]] || sandbox_error "the launcher needs $tool in /usr/bin or /bin"
  done
  node_version=$(node -p process.versions.node 2>/dev/null || echo none)
  [[ ${node_version%%.*} == "$SANDBOX_NODE_MAJOR" ]] ||
    sandbox_error "it needs Node $SANDBOX_NODE_MAJOR first on PATH, and found $node_version ($(command -v node || echo "no node")); Homebrew's Node 24 is in /opt/homebrew/opt/node@24/bin"
  home_real=$(cd "$HOME" && pwd -P)
  # The folder scripts may also read (--read-dir), such as ~/Downloads: as
  # given, else what the launcher there has, else none. It's held to the
  # rules the launcher puts the current folder to, can't be the working folder
  # or inside it, and the launcher checks it again at each start. A kept
  # folder that has since gone stays: the launcher doesn't grant it while
  # it's missing.
  if ((!read_set)) && is_launcher "$BIN_DIR/zenius"; then read_dir=$(launcher_value READ_DIR); fi
  [[ $read_dir == none ]] && read_dir=
  if [[ -n $read_dir && -d $read_dir ]]; then
    read_real=$(cd "$read_dir" && pwd -P)
    for shared in "$home_real" /tmp /var/tmp /private/tmp /private/var/tmp /dev/shm "$(resolve "${TMPDIR:-/tmp}")"; do
      case $shared/ in "${read_real%/}"/*) sandbox_error "--read-dir can't be your home folder, a temporary folder or above one: $read_real" ;; esac
    done
    for kept in "$(resolve "${ZENIUS_HOME:-$HOME/.zenius}")" "$(resolve "$DEST")" "$(resolve "$BIN_DIR")" \
      "$(dirname "$(dirname "$node_real")")" "$(resolve "$(dirname "$(command -v node)")")" "/run/user/$(id -u)" "$home_real/.zenius-dev" "$home_real/.zen" \
      "$home_real/.config" "$home_real/.local" "$home_real/.ssh" "$home_real/.gnupg" "$home_real/.aws" "$home_real/.docker" "$home_real/.kube" "$home_real/Library"; do
      case $kept/ in "$read_real"/*) sandbox_error "--read-dir can't hold or be inside zenius, its node, Zen's profiles, or a folder of settings or credentials: $read_real" ;; esac
      case $read_real/ in "$kept"/*) sandbox_error "--read-dir can't hold or be inside zenius, its node, Zen's profiles, or a folder of settings or credentials: $read_real" ;; esac
    done
    case $read_real/ in "${working_real%/}"/*) sandbox_error "--read-dir can't be the working folder or inside it, where scripts read and write already: $read_real" ;; esac
  elif [[ -n $read_dir ]] && ((read_set)); then
    sandbox_error "--read-dir must be a folder that exists: $read_dir"
  fi
  read_dir=${read_dir%/}
elif ((read_set)); then
  echo "install-cli.sh: --read-dir goes with --sandbox" >&2
  exit 2
fi

# The launcher for this machine: sdk/sandbox/launcher.sh with its paths filled in.
launcher_text() {
  local node_path sysbinds="" dir
  # The PATH's node by the path found, links kept, so an upgrade that moves
  # the link (Homebrew's opt/node@24) keeps the launcher working. A shim that
  # isn't node itself (asdf, volta) can't run in the sandbox: then the node
  # it runs is pinned.
  node_path=$(node -e '
    const fs = require("node:fs");
    const [found] = process.argv.slice(1);
    const real = fs.realpathSync(process.execPath);
    let same = false;
    try { same = found.startsWith("/") && fs.realpathSync(found) === real; } catch {}
    process.stdout.write(same ? found : real);
  ' "$(command -v node)")
  if [[ $platform == linux ]]; then
    for dir in /bin /sbin /lib /lib32 /lib64 /libx32; do
      if [[ -L $dir ]]; then sysbinds+=" --symlink $(readlink "$dir") $dir"; elif [[ -d $dir ]]; then sysbinds+=" --ro-bind $dir $dir"; fi
    done
  fi
  node - "$ROOT/sdk/sandbox/launcher.sh" "$(resolve "$DEST")" "$(resolve "${ZENIUS_HOME:-$HOME/.zenius}")" \
    "$node_path" "$SANDBOX_NODE_MAJOR" "$platform" "$(id -u)" "${sysbinds# }" "$bwrap" "$(resolve "$BIN_DIR")" "$read_dir" <<'EOF'
const [template, cli, zhome, node, nodeMajor, platform, uid, sysbinds, bwrap, binDir, readDir] = process.argv.slice(2);
const quote = (text) => `'${text.replace(/'/g, "'\\''")}'`;
const values = { CLI: quote(cli), ZHOME: quote(zhome), NODE: quote(node), NODE_MAJOR: nodeMajor, BIN_DIR: quote(binDir), READ_DIR: quote(readDir), PLATFORM: platform, UID: uid, SYSBINDS: sysbinds, BWRAP: quote(bwrap) };
const text = require("node:fs").readFileSync(template, "utf8").replace(/@([A-Z_]+)@/g, (match, key) => {
  if (!(key in values)) throw new Error(`unknown placeholder ${match}`);
  return values[key];
});
process.stdout.write(text);
EOF
}

# With --sandbox, ~/.local/bin/zenius is the launcher itself, so a command
# that starts with zenius can only reach the sandboxed CLI.
install_launcher() {
  local path=$BIN_DIR/zenius text current
  text=$(launcher_text)
  if is_launcher "$path" && [[ $(cat "$path") == "$text" ]]; then
    echo "ok       $path: the sandboxed launcher"
    return 0
  fi
  if is_launcher "$path"; then
    report updated update "$path: the sandboxed launcher"
  elif [[ -L $path ]]; then
    current=$(readlink "$path")
    if ! ours "$current"; then
      echo "skip     $path links to $current, which isn't a zenius CLI; left alone" >&2
      return 1
    fi
    report updated write "$path: the sandboxed launcher (was a link to $current)"
  elif [[ -e $path ]]; then
    echo "skip     $path exists and isn't a zenius link or launcher; left alone" >&2
    return 1
  else
    report wrote write "$path: the sandboxed launcher"
  fi
  if ((dry)); then
    sed 's/^/    /' <<<"$text"
    if [[ $platform == macos ]]; then
      echo "would install $DEST/sdk/sandbox/zenius.sb, the launcher's sandbox-exec profile:"
      sed 's/^/    /' "$ROOT/sdk/sandbox/zenius.sb"
    fi
    return 0
  fi
  mkdir -p "$BIN_DIR"
  printf '%s\n' "$text" >"$path.new.$$"
  chmod 755 "$path.new.$$"
  mv -f "$path.new.$$" "$path"
}

# The bundle must be at least as new as every source file, or the copy would
# run older code than this checkout has.
bundle_current() {
  [[ -f $BUNDLE && -f $ROOT/sdk/dist/guide.md ]] || return 1
  [[ -z $(find "$ROOT/sdk/src" "$ROOT/skill/guide.md" -newer "$BUNDLE" -print -quit) ]]
}
node_name() { if command -v node >/dev/null; then echo "Node $(node --version) ($(command -v node))"; else echo "no node on PATH"; fi; }
unbuilt="building didn't make it newer" fix="check for files in sdk/src or skill/guide.md dated in the future"
if [[ -n ${ZENIUS_INSTALL_NO_BUILD:-} ]]; then
  unbuilt="ZENIUS_INSTALL_NO_BUILD is set" fix="unset it, or run npm run build in $ROOT/sdk first"
elif [[ ! -d $ROOT/sdk/node_modules/esbuild ]]; then
  unbuilt="there is no sdk/node_modules to build it" fix="run npm ci in $ROOT/sdk (build tools, about 36 MB), then run this again"
elif ((dry)); then
  report built build sdk/dist/zenius.mjs
elif output=$(cd "$ROOT/sdk" && node build.mjs 2>&1); then
  report built build sdk/dist/zenius.mjs
else
  # Stop even if an earlier bundle is current: the build also checks the
  # guide, and a copy must not ship what it rejected.
  echo "error    building sdk/dist/zenius.mjs failed under $(node_name):" >&2
  sed 's/^/         /' <<<"$output" >&2
  exit 1
fi
if ((!dry)) && ! bundle_current; then
  echo "error    sdk/dist/zenius.mjs is missing or older than the sources, and $unbuilt:" >&2
  echo "         $fix" >&2
  exit 1
fi

# The commit as scripts/install.sh writes it: a short hash, "-dirty" when
# what the copy is made of has changes, or "unknown" outside git. A release's
# package has no git, and may sit inside another repo: its RELEASE file names
# the commit (scripts/release.sh).
version=$(node -p 'require(process.argv[1]).version' "$ROOT/sdk/package.json" 2>/dev/null || echo unknown)
if [[ -f $ROOT/RELEASE ]]; then
  commit=$(sed -n 's/^commit=\([0-9a-f]\{7,40\}\)$/\1/p' "$ROOT/RELEASE")
  commit=${commit:-unknown}
else
  commit=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)
  if [[ $commit != unknown && -n $(git -C "$ROOT" status --porcelain -- sdk/src sdk/bin skill runtime/vendor 2>/dev/null) ]]; then commit+=-dirty; fi
fi
describe=$version
if [[ $commit != unknown ]]; then describe+=", commit $commit"; fi

if ((!dry)); then
  stage=$DEST.new.$$
  trap 'rm -rf "$stage"' EXIT
  rm -rf "$stage"
  mkdir -p "$stage/sdk/bin" "$stage/sdk/dist" "$stage/skill" "$stage/runtime/vendor"
  cp "$ROOT/sdk/bin/zenius" "$stage/sdk/bin/zenius"
  chmod 755 "$stage/sdk/bin/zenius"
  cp -R "$ROOT/sdk/sandbox" "$stage/sdk/sandbox"
  cp "$BUNDLE" "$ROOT/sdk/dist/guide.md" "$stage/sdk/dist/"
  # bin/zenius is an ES module without an extension; Node reads its type here.
  printf '{ "private": true, "type": "module" }\n' >"$stage/sdk/package.json"
  # The bundle finds the Skill (site learnings) and fx-autoconfig (zenius
  # doctor's restore steps) where they sit in a checkout.
  cp -R "$ROOT/skill/zenius" "$stage/skill/zenius"
  cp -R "$ROOT/runtime/vendor/fx-autoconfig" "$stage/runtime/vendor/fx-autoconfig"
  if [[ -d $DEST/skill/zenius/learnings ]]; then
    for old in "$DEST"/skill/zenius/learnings/*/; do
      [[ -d $old ]] || continue
      id=$(basename "$old")
      [[ -e $stage/skill/zenius/learnings/$id ]] && continue
      cp -R "$old" "$stage/skill/zenius/learnings/$id"
      echo "kept     learnings/$id, added to the previous copy"
    done
  fi
  node -e '
    const [file, version, commit, from] = process.argv.slice(1);
    const installedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    require("node:fs").writeFileSync(file, JSON.stringify({ version, commit, installedAt, from }, null, 2) + "\n");
  ' "$stage/install.json" "$version" "$commit" "$ROOT"
  mkdir -p "$(dirname "$DEST")"
  if [[ -e $DEST ]]; then
    mv "$DEST" "$DEST.old.$$"
    mv "$stage" "$DEST"
    rm -rf "$DEST.old.$$"
  else
    mv "$stage" "$DEST"
  fi
fi
report installed install "$DEST: zenius $describe"

# The working folder, in the config file the launcher reads at each start,
# and made if missing.
before=
if ! wf_current "$working"; then
  before=$(wf_saved 2>/dev/null) || before=
  act wf_write "$working"
  report set set "the working folder: $working ($(wf_config))"
elif [[ -d $working ]]; then
  echo "ok       the working folder: $working"
fi
if [[ ! -d $working ]]; then
  act wf_make "$working"
  report made make "$working, the working folder, readable only by you"
fi
# The runtime reads the config once, at Zen's start, while the launcher reads
# it at each command: a Zen that's running goes on with the folder it read.
if [[ -n $before && "$(wf_resolve "$before")" != "$working_real" ]]; then
  echo "note     a running Zen keeps the working folder it started with, $before, until its next start, so its downloads land there until then"
fi

status=0
if ((sandbox)); then
  install_launcher || status=1
else
  link "$DEST/sdk/bin/zenius" "$BIN_DIR/zenius" || status=1
fi
if ((skill)); then
  while read -r path; do link "$DEST/skill/zenius" "$path" || status=1; done < <(skill_links)
fi
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note     $BIN_DIR is not on PATH: add it, so your shell and agents find the zenius command" ;;
esac
if ((!dry)) && [[ -x $BIN_DIR/zenius ]] && command -v node >/dev/null; then
  if version_line=$("$BIN_DIR/zenius" --version 2>&1); then
    echo "check    $version_line"
  else
    echo "error    $BIN_DIR/zenius --version failed:" >&2
    sed 's/^/         /' <<<"$version_line" >&2
    status=1
  fi
fi
exit $status
