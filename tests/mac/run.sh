#!/usr/bin/env bash
# zen-eval's Mac tests of the bundle (tests/mac/README.md): start a dev Zen
# whose agent sidebar talks to zen-sidebar's mock agents, run
# tests/mac/*.test.mjs against it, stop it.
#
#   tests/mac/run.sh                              every suite, headless
#   tests/mac/run.sh tests/mac/urlbar.test.mjs
#   ZENIUS_MAC_HEADED=1 tests/mac/run.sh tests/mac/look.test.mjs
#       the look, in a visible window that closes on every way out. On the
#       user's Mac, only through zen-eval's nets (AGENTS.md): the user idle,
#       and no call or screen share.
#
#   ZENIUS_MAC_REPO=<checkout>   whose runtime and SDK the dev Zen runs
#                                (default: this checkout)
#   ZENIUS_MAC_FIXTURES=<dir>    the sidebar's test fixtures: mock_agent.py,
#                                serve.mjs with www/, fixture-tasks.mjs
#                                (default: tests/fixtures/agent-sidebar there)
#   ZENIUS_MAC_MCP="<command>"   the zenius MCP server the mock drives
#                                (default: node <checkout>/sdk/bin/zenius mcp)
#   ZENIUS_MAC_INSTANCE=<name>   (default: mactest-<checkout suffix>)
#   ZENIUS_MAC_TIMEOUT=600       stop a run that hangs, after that many seconds
#   ZENIUS_MAC_SHOTS=<dir>       where look.test.mjs writes its shots
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
REPO=$(cd "${ZENIUS_MAC_REPO:-$ROOT}" && pwd)
FIX=${ZENIUS_MAC_FIXTURES:-$REPO/tests/fixtures/agent-sidebar}
if [[ ! -f $FIX/mock_agent.py ]]; then
  echo "tests/mac: no mock agent at $FIX/mock_agent.py (ZENIUS_MAC_FIXTURES)" >&2
  exit 2
fi
FIX=$(cd "$FIX" && pwd)
for p in /opt/homebrew/opt/node@24/bin "$HOME/opt/node-v24.22.2-linux-x64/bin"; do
  if [[ -d $p ]]; then PATH=$p:$PATH; fi
done
export PATH
PY=$(command -v python3) || { echo "tests/mac: the mock agent needs python3" >&2; exit 2; }
suffix=$(basename "$ROOT" | sed 's/^zenius-\{0,1\}//' | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')
NAME=${ZENIUS_MAC_INSTANCE:-mactest-${suffix:-main}}
DEV="$REPO/scripts/zen-dev.sh"
# zen-dev.sh leaves the sidebar and the '>' dispatch out of dev profiles
# unless asked.
export ZENIUS_AGENT_SCRIPTS=1
STATE=${TMPDIR:-/tmp}
STATE=${STATE%/}/zenius-mac-$NAME
mkdir -p "$STATE"
MCP=${ZENIUS_MAC_MCP:-"node '$REPO/sdk/bin/zenius' mcp"}
# An agent's session variables (a test started from Claude Code or Codex)
# would reach the agents the sidebar spawns.
for v in $(env | grep -o -E '^(CLAUDE|CODEX_|HC_)[A-Za-z0-9_]*' || true); do unset "$v"; done

WWW_PID=
cleanup() {
  "$DEV" "$NAME" stop >/dev/null 2>&1 || true
  if [[ -n $WWW_PID ]]; then kill "$WWW_PID" 2>/dev/null || true; fi
}
# Every way out stops Zen, which closes its window in a headed run. Signals
# exit through the EXIT trap too.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# zen-sidebar's test pages, on 127.0.0.1 only.
if [[ -f $FIX/serve.mjs && -d $FIX/www ]]; then
  port=${ZENIUS_MAC_WWW_PORT:-47232}
  node "$FIX/serve.mjs" "$port" > "$STATE/serve.log" 2>&1 &
  WWW_PID=$!
  export ZENIUS_MAC_WWW=http://127.0.0.1:$port
fi

# The sidebar's config: the mock agents only, on this instance. The
# fixtures' own config.mjs writes it, unless the MCP command is another.
if [[ -f $FIX/config.mjs && -z ${ZENIUS_MAC_MCP:-} ]]; then
  node "$FIX/config.mjs" --instance "$NAME" --out "$STATE/config.json" --logs "$STATE/logs" \
    ${ZENIUS_MAC_WWW:+--www "$ZENIUS_MAC_WWW"} > /dev/null
else
node - "$STATE/config.json" "$PY" "$FIX/mock_agent.py" "$STATE" "$NAME" "${ZENIUS_MAC_WWW:-}" "$MCP" <<'JS'
const [out, py, mock, state, instance, www, mcp] = process.argv.slice(2);
const env = { ZENIUS_INSTANCE: instance, MOCK_ZENIUS_MCP: mcp, ...(www ? { MOCK_WWW: www } : {}) };
const config = {
  default: "mock",
  agents: {
    mock: { name: "Mock", command: py, args: [mock, `${state}/mock.log`], env },
    mockclaude: { name: "Mock Claude", command: py, args: [mock, `${state}/mockclaude.log`, "--claude"], env },
  },
};
require("node:fs").writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
JS
fi
# The agents' limits grey out every agent but Claude Code and Codex, the
# mocks included, unless the profile allows unknown agents.
{
  printf 'user_pref("uc.agent-sidebar.config", "%s");\n' "$STATE/config.json"
  printf 'user_pref("zenius.agentSidebar.allowUnknownAgents", true);\n'
} > "$STATE/prefs.js"
export ZENIUS_DEV_PREFS=$STATE/prefs.js

"$DEV" "$NAME" stop >/dev/null 2>&1 || true
# zen-sidebar's fixture tasks (every state but Working), read once at startup.
if [[ -f $FIX/fixture-tasks.mjs ]]; then
  PROFILE=$("$DEV" "$NAME" path)
  if [[ ! -f $PROFILE/prefs.js ]]; then
    # A new profile: Zen makes it on a first start.
    "$DEV" "$NAME" start >/dev/null
    "$DEV" "$NAME" stop >/dev/null
  fi
  node "$FIX/fixture-tasks.mjs" "$PROFILE"
fi
if [[ ${ZENIUS_MAC_HEADED:-} == 1 ]]; then
  ZENIUS_HEADED_MAX_S=${ZENIUS_HEADED_MAX_S:-900} "$DEV" "$NAME" start --headed
else
  "$DEV" "$NAME" start
fi

if (($#)); then files=("$@"); else files=("$ROOT"/tests/mac/*.test.mjs); fi
limit=${ZENIUS_MAC_TIMEOUT:-600}
ZENIUS_INSTANCE=$NAME node --test --test-concurrency=1 "${files[@]}" &
pid=$!
(
  waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if ((waited >= limit)); then
      echo "tests/mac: no result after $limit s; stopping the run" >&2
      kill -TERM "$pid" 2>/dev/null
      exit 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
) &
watchdog=$!
status=0
wait "$pid" || status=$?
kill "$watchdog" 2>/dev/null || true
exit "$status"
