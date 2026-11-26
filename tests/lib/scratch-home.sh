# tests/lib/scratch-home.mjs for shell runners (bash 3.2 or later). Source
# it, then:
#
#   scratch_home security "$WORK"      # sets SCRATCH_ROOT, SCRATCH_HOME,
#                                      # SCRATCH_ZHOME and SCRATCH_FILES, and
#                                      # writes $SCRATCH_ZHOME/config.json
#   guard_home "$SCRATCH_HOME" "$SCRATCH_ZHOME" run.sh || exit 1
#   HOME=$SCRATCH_HOME ZENIUS_HOME=$SCRATCH_ZHOME scripts/install-cli.sh ...
#
# guard_home asks scratch-home.mjs's guardHome, so the rule lives in one
# place: neither folder may be, links resolved, the account's own home or
# its .zenius, or a folder inside that.

SCRATCH_LIB=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# guard_home <home> <zenius home> [who asks]
guard_home() {
  HOME=$1 ZENIUS_HOME=$2 node "$SCRATCH_LIB/scratch-home.mjs" --check "${3:-this runner}"
}

# scratch_home <label> [parent folder]: a private folder (0700) in the parent
# (TMPDIR by default) holding home/, zhome/ with config.json naming files/
# (not made: readers make it), as scratchHome() makes it.
scratch_home() {
  SCRATCH_ROOT=$(mktemp -d "${2:-${TMPDIR:-/tmp}}/zt-$1-XXXXXX") || return 1
  chmod 700 "$SCRATCH_ROOT"
  SCRATCH_HOME=$SCRATCH_ROOT/home SCRATCH_ZHOME=$SCRATCH_ROOT/zhome SCRATCH_FILES=$SCRATCH_ROOT/files
  (umask 077 && mkdir "$SCRATCH_HOME" "$SCRATCH_ZHOME" &&
    printf '{\n  "workingFolder": "%s"\n}\n' "$SCRATCH_FILES" >"$SCRATCH_ZHOME/config.json") || return 1
  guard_home "$SCRATCH_HOME" "$SCRATCH_ZHOME" "scratch_home"
}

# own_zenius_home <label>: for a runner that starts a dev Zen, what
# scripts/test-all.sh gives each lane (its lane_home), so the runner run
# alone sees the same. A caller's ZENIUS_WORKING_DIR,
# ZENIUS_DEV_WORKING_DIR, ZENIUS_SOCKET and ZENIUS_INSTANCE go: they could
# name the user's working folder or Zen, and the SDK takes ZENIUS_SOCKET over
# the instance the runner names for its tests. A runner that wants a working
# folder for its dev Zen names one itself; zen-dev.sh otherwise gives each
# its own. Unless the caller named a ZENIUS_HOME (test-all does), a scratch
# home is made as scratch_home makes it, whose config.json names a working
# folder inside it, and its zenius home is exported as ZENIUS_HOME:
# zen-dev.sh refuses the account's own ~/.zenius. OWN_ZROOT names it, for
# drop_own_zenius_home once the runner's Zen has stopped. It's in /tmp: the
# dev Zen's sockets are in it, and a Unix socket's path must fit in 104
# bytes on macOS, where TMPDIR alone takes about 49.
own_zenius_home() {
  OWN_ZROOT=
  unset ZENIUS_WORKING_DIR ZENIUS_DEV_WORKING_DIR ZENIUS_SOCKET ZENIUS_INSTANCE
  [[ -z ${ZENIUS_HOME:-} ]] || return 0
  if ! scratch_home "$1-home" /tmp; then
    [[ -z ${SCRATCH_ROOT:-} ]] || rm -rf -- "$SCRATCH_ROOT"
    return 1
  fi
  OWN_ZROOT=$SCRATCH_ROOT
  export ZENIUS_HOME=$SCRATCH_ZHOME
  # A scratch home the runner makes for its own cases is another one.
  SCRATCH_ROOT= SCRATCH_HOME= SCRATCH_ZHOME= SCRATCH_FILES=
}

# drop_own_zenius_home: remove what own_zenius_home made, if it made one.
drop_own_zenius_home() {
  [[ -z ${OWN_ZROOT:-} ]] || rm -rf -- "$OWN_ZROOT"
  OWN_ZROOT=
}
