#!/usr/bin/env bash
# zen-observe's boundary tests: what a page in an agent tab can reach past
# it (surfaces.test.mjs, the I1/I4 vectors; i5.test.mjs, web content only;
# caps.test.mjs, memory and disk), and what agent JavaScript can do once the
# user has the Space (control.test.mjs, I3). They were half of tests/observe, which set
# the pace of test-all's parallel lanes; split off, each suite runs in about
# a minute. Same runner as tests/observe, on an instance of its own.
#
#   tests/observe-vectors/run.sh                                 instance "obsvec-<checkout suffix>"
#   tests/observe-vectors/run.sh tests/observe-vectors/i5.test.mjs
#   ZENIUS_OBSERVE_VECTORS_INSTANCE=<name>                       another instance
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
suffix=$(basename "$ROOT" | sed 's/^zenius-\{0,1\}//' | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')
# Never tests/observe's instance, even when ZENIUS_OBSERVE_INSTANCE is set:
# test-all runs both suites at once.
export ZENIUS_OBSERVE_INSTANCE=${ZENIUS_OBSERVE_VECTORS_INSTANCE:-obsvec-${suffix:-main}}
if (($#)); then files=("$@"); else files=("$ROOT"/tests/observe-vectors/*.test.mjs); fi
exec "$ROOT/tests/observe/run.sh" "${files[@]}"
