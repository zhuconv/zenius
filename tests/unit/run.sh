#!/usr/bin/env bash
# zen-eval's tooling tests, run by scripts/test-all.sh: golden snapshot format,
# the e2e manifest and runner, bench statistics. No browser needed.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
[[ -d $HOME/opt/node-v24.22.2-linux-x64/bin ]] && export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH
exec node --test tests/unit/*.test.mjs
