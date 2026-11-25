# The working folder, for scripts/install.sh and scripts/install-cli.sh,
# which source this file (bash 3.2 or later). See docs/SPI.md, "The working
# folder".
#
# One folder where the agent's downloads land and its scripts read, write
# and delete files. The installers' --working-dir sets it, ~/zenius-files by
# default, and a later install without the option keeps it. It is kept in
# ~/.zenius/config.json (ZENIUS_HOME moves ~/.zenius), which the sandboxed
# launcher, the runtime and the sidebar read at each start. Changing it moves
# no files. It's stored resolved (wf_tidy), as the SDK spells the paths it
# returns, so every reader sees one string. One with a ".." part is refused
# (wf_dotdot): readers disagree on where it leads.
#
# The file holds one key, on a line of its own, in the form wf_write writes,
# so the launcher's shell reads it without a JSON parser:
#
#   {
#     "workingFolder": "/Users/me/zenius-files"
#   }
#
# So a path that JSON would escape there (a double quote, a backslash or a
# control character) is refused.
#
# ~/zenius-files is the default only while zenius's home is ~/.zenius. A
# ZENIUS_HOME that, links resolved, is another folder has no default: without
# a config file there, an install needs --working-dir, and the launcher, the
# SDK and the runtime stop with the reason, making nothing. So a test, a
# runner or a dev setup that moves zenius's home alone can't reach the real
# ~/zenius-files.

# The config file's path.
wf_config() { printf '%s\n' "${ZENIUS_HOME:-$HOME/.zenius}/config.json"; }

# The folder an install sets when none is given or kept.
wf_default() { printf '%s\n' "$HOME/zenius-files"; }

# Whether $1 needs no escaping in the config file: no double quote,
# backslash or control character.
wf_plain() {
  case $1 in *'"'* | *'\'*) return 1 ;; esac
  [[ "$(printf '%s' "$1" | LC_ALL=C tr -d '[:cntrl:]')" == "$1" ]]
}

# The folder the config file names. Nothing, and status 0, when there is no
# file; status 1, with the reason instead, when the file has no single
# workingFolder line in the installer's form, or names the folder with a
# ".." part. An earlier installer stored a ".." as it was given, and the
# launcher and the runtime read it the kernel's way, so tidying it would
# quietly move the folder; every reader refuses it now.
wf_saved() {
  local file value count
  file=$(wf_config)
  [[ -e $file ]] || return 0
  value=$(sed -n 's/^[[:space:]]*"workingFolder"[[:space:]]*:[[:space:]]*"\([^"\\]*\)"[[:space:]]*,\{0,1\}[[:space:]]*$/\1/p' "$file" 2>/dev/null) || value=
  count=$(printf '%s' "$value" | grep -c '' || true)
  if [[ $count != 1 ]] || ! wf_plain "$value" || [[ $value != /* ]]; then
    echo "$file doesn't name the working folder on a line of its own, as the installer writes it: pass --working-dir <folder> to write it again"
    return 1
  fi
  if wf_dotdot "$value"; then
    echo "$file names the working folder with a \"..\" part, which can lead elsewhere through a link: pass --working-dir <folder>, named without one, to write it again"
    return 1
  fi
  printf '%s\n' "$value"
}

# $1 with its existing part's links resolved, as the sandbox rules compare
# paths.
wf_resolve() {
  local path=$1 rest=
  while [[ ! -e $path ]]; do rest=/$(basename "$path")$rest path=$(dirname "$path"); done
  echo "$(cd "$path" && pwd -P)$rest"
}

# Whether ZENIUS_HOME names a folder other than ~/.zenius, links resolved:
# then there's no default working folder.
wf_moved_home() {
  [[ -n ${ZENIUS_HOME:-} && "$(wf_resolve "$ZENIUS_HOME")" != "$(wf_resolve "$HOME/.zenius")" ]]
}

# Whether the .git at $1 makes its folder a project's, as git takes it. An
# empty folder (a real one, not a link, that can be listed) is no repository
# to git, which looks on above it, nor here: Codex's sandbox on Linux makes
# one in each folder its commands may write, while each runs. Anything else
# there counts: a link (dangling or not), a file, a folder with anything in
# it, or one that can't be listed.
wf_git_found() {
  [[ -e $1 || -L $1 ]] || return 1
  [[ -d $1 && ! -L $1 ]] || return 0
  local inside
  # ls fails on a folder it can't read to the end, where a glob finds nothing.
  inside=$(command ls -A -- "$1" 2>/dev/null) || return 0
  [[ -n $inside ]]
}

# Why the folder at the real path $1 can't be the working folder, or
# nothing. Further arguments are folders it may neither hold nor be inside:
# the CLI copy, the folder of the zenius command and its node, or Zen's
# profile.
#
# The agent's scripts write the working folder, so it holds a task's files
# and nothing more: not the home folder or a temporary folder, or one above
# them; nothing of zenius's, Zen's profiles, settings or credentials; and no
# project. Tools that run what a project holds (git, direnv, npm, make,
# pytest) would run what a script wrote. A git repository at the home folder
# or a temporary folder itself (dotfiles, or a stray one on a shared machine)
# doesn't count as a project here: every folder below sits in its work tree,
# and its .git is out of the scripts' reach. Nor does an empty .git folder
# (wf_git_found).
wf_why_not() {
  local real=${1%/} home_real shared shared_list kept dir
  [[ -n $real ]] || { echo "it's the root folder"; return 0; }
  home_real=$(cd "$HOME" && pwd -P)
  shared_list=("$home_real" /tmp /var/tmp /private/tmp /private/var/tmp /dev/shm "$(wf_resolve "${TMPDIR:-/tmp}")")
  for shared in "${shared_list[@]}"; do
    case ${shared%/}/ in "$real"/*)
      echo "it's your home folder, a temporary folder, or a folder above one"
      return 0
      ;;
    esac
  done
  shift
  for kept in "$(wf_resolve "${ZENIUS_HOME:-$HOME/.zenius}")" "/run/user/$(id -u)" "$home_real/.zenius-dev" "$home_real/.zen" \
    "$home_real/.config" "$home_real/.local" "$home_real/.ssh" "$home_real/.gnupg" "$home_real/.aws" "$home_real/.docker" \
    "$home_real/.kube" "$home_real/Library" "$@"; do
    [[ -n $kept ]] || continue
    kept=${kept%/}
    case $kept/ in "$real"/*) echo "it holds $kept, which the agent's scripts must not reach" && return 0 ;; esac
    case $real/ in "$kept"/*) echo "it's inside $kept, which the agent's scripts must not reach" && return 0 ;; esac
  done
  if wf_git_found "$real/.git"; then echo "it holds .git, so it's a project's folder"; return 0; fi
  if [[ -e $real/.envrc || -L $real/.envrc ]]; then echo "it holds .envrc, which direnv runs"; return 0; fi
  dir=$(dirname "$real")
  while [[ $dir != / ]]; do
    for shared in "${shared_list[@]}"; do
      [[ $dir == "${shared%/}" ]] && return 0
    done
    if wf_git_found "$dir/.git"; then echo "it's inside a git work tree, $dir"; return 0; fi
    dir=$(dirname "$dir")
  done
  return 0
}

# Whether the absolute path $1 has a ".." part. After a link, ".." leads to
# the parent of the link's target for the kernel, and so for the launcher
# and the runtime. Node's path.resolve and bash's plain cd instead drop the
# part before it, the link's own name, so the readers would name two
# folders.
wf_dotdot() {
  case $1 in */../* | */..) return 0 ;; esac
  return 1
}

# $1, an absolute path with no ".." part (wf_saved and wf_pick refuse one), in
# WF_TIDY as Node's path.resolve spells it, which the SDK uses for the paths
# it returns: one slash between parts, no "." part, and no slash at the end.
# None of these changes which folder it names. Set in a variable rather than
# printed, as $(...) would drop a newline at the end.
wf_tidy() {
  local rest=$1 part out=
  while [[ -n $rest ]]; do
    part=${rest%%/*}
    if [[ $part == "$rest" ]]; then rest=; else rest=${rest#*/}; fi
    case $part in
      '' | .) ;;
      *) out=$out/$part ;;
    esac
  done
  WF_TIDY=${out:-/}
}

# The working folder an install sets, as given: $1 (--working-dir) if given,
# else the one the config file names, else wf_default. Status 1, with the
# reason instead, when that folder can't be the working folder; status 2
# when there's none to pick, since ZENIUS_HOME moved zenius's home and holds
# no config file (the installers exit 2, as for a wrong argument). Further
# arguments go to wf_why_not.
wf_pick() {
  local given=$1 folder why
  shift
  if [[ -n $given ]]; then
    folder=$given
  else
    folder=$(wf_saved) || { printf '%s\n' "$folder"; return 1; }
    if [[ -z $folder ]]; then
      if wf_moved_home; then
        echo "there's no default working folder: ZENIUS_HOME is $ZENIUS_HOME, not ~/.zenius, and it holds no config.json: pass --working-dir <folder>"
        return 2
      fi
      folder=$(wf_default)
    fi
  fi
  if [[ $folder != /* ]] || ! wf_plain "$folder"; then
    echo "the working folder must be an absolute path with no double quote, backslash or control character: $folder"
    return 1
  fi
  # A given one; wf_saved has refused a saved one.
  if wf_dotdot "$folder"; then
    echo "the working folder must be named without a \"..\" part, which can lead elsewhere through a link: $folder"
    return 1
  fi
  # A saved folder too: an install rewrites one an earlier installer stored
  # another way. It's the same folder.
  wf_tidy "$folder"
  folder=$WF_TIDY
  if [[ -e $folder || -L $folder ]] && { [[ ! -d $folder ]] || [[ ! -O $folder ]]; }; then
    echo "the working folder must be a folder of yours: $folder"
    return 1
  fi
  if [[ ! -e $folder && ! -d $(dirname "$folder") ]]; then
    echo "the working folder's parent folder must exist: $folder"
    return 1
  fi
  why=$(wf_why_not "$(wf_resolve "$folder")" "$@")
  if [[ -n $why ]]; then
    echo "the working folder can't be $folder: $why"
    return 1
  fi
  printf '%s\n' "$folder"
}

# Whether the config file already names $1 in the installer's form.
wf_current() { [[ -f $(wf_config) && "$(cat "$(wf_config)")" == "$(printf '{\n  "workingFolder": "%s"\n}' "$1")" ]]; }

# Write the config file naming $1, whole, readable only by you, as is a
# ~/.zenius it makes.
wf_write() {
  local file tmp
  file=$(wf_config)
  tmp=$file.new.$$
  (umask 077 && mkdir -p "$(dirname "$file")" && printf '{\n  "workingFolder": "%s"\n}\n' "$1" >"$tmp") && mv -f "$tmp" "$file"
}

# Make the folder $1, readable only by you, unless it's there.
wf_make() { [[ -d $1 ]] || mkdir -m 700 "$1"; }
