#!/usr/bin/env bash
# Tests that need no browser, run by scripts/test-all.sh: the golden snapshot
# format, the e2e manifest and runner, bench statistics, and the runtime's
# pure modules, such as zenius feedback's text. No browser needed.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
[[ -d $HOME/opt/node-v24.22.2-linux-x64/bin ]] && export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH
exec node --test tests/unit/*.test.mjs
