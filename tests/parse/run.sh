#!/usr/bin/env bash
# The parse check, run by scripts/test-all.sh: every script in runtime/JS
# parses as Gecko loads it (check.mjs says how). No browser needed, and it
# takes about a second.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
[[ -d $HOME/opt/node-v24.22.2-linux-x64/bin ]] && export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH
# vm.SourceTextModule compiles a module without running it; Node 24 keeps it
# behind this flag.
exec node --experimental-vm-modules --disable-warning=ExperimentalWarning tests/parse/check.mjs
