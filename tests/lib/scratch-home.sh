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
