# Flags for `node --test` from a suite runner's own arguments. Sourced by the
# runners; use it unquoted, as `node --test $(node_test_flags "$@") ...`: it
# prints nothing or one word.
#
# A run that filters tests (--test-name-pattern, --test-skip-pattern,
# --test-only) gets --test-force-exit. When a filter selects none of a file's
# tests, Node (24.22.2) still starts the file's before hooks, but runs its
# after hooks without waiting for them. A before that connects to Zen or
# starts a server then finishes after every after hook, nothing closes what
# it opened, and the file never ends. --test-force-exit ends each file once
# its tests and hooks are done. A full run, test-all's included, gets
# nothing, so a file that leaves something open still hangs there, where a
# leak gets noticed.
node_test_flags() {
  local a
  for a in "$@"; do
    case $a in
      --test-name-pattern* | --test-skip-pattern* | --test-only)
        printf '%s\n' --test-force-exit
        return 0
        ;;
    esac
  done
  return 0
}
