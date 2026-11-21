# Agent sidebar fixtures

Steady runs of the agent sidebar (docs/agent-sidebar.md) on a dev Zen: a
mock agent, the pages it browses, the directory's tasks in each state, and
a live scene. No network: the pages are on loopback, and the mock's browser
steps go through this checkout's own `zenius mcp` to the test's instance.

| File | What |
|---|---|
| `config.mjs` | Writes a sidebar config with only the mock: `mock` (looks like codex-acp) and `mockclaude` (like claude-agent-acp) |
| `mock_agent.py` | The mock ACP agent; its docstring lists the prompt keywords |
| `serve.mjs`, `www/` | The pages, on 127.0.0.1:47231 |
| `fixture-tasks.mjs` | Writes `agent-sidebar-tasks.json` into a profile before its Zen starts: Needs you ×2, Done ×3, fixed ages |
| `chrome.mjs` | Runs chrome JS in a dev Zen (dev.evalChrome) with `scene.js`'s helpers first |
| `scene.js` | The helpers, `S`: `until`, `openTab`, `openPanel`, `ask`, `state` |
| `scene-build.js`, `scene-ready.js` | A live scene with every state, Working included |
| `shots.mjs` | Window shots drawn by Zen (drawSnapshot), Chat, Work and the directory in light and dark |

The mock's keywords that matter here:

- `SCENARIO:flights` opens, fills and leaves its last click running, so
  the task stays Working until it's stopped.
- `SCENARIO:prices` leaves its second open running, so Working.
- `SCENARIO:trip` calls hand_off, then a wait for the user, so Needs you
  until the zenius task is handed back.
- `SCENARIO:weather` opens, reads and finishes, so Done.
- `QUESTION` ends its answer with a question, so Needs you.
- `SUMMARY` is a three-point answer, so Done.
- `ECHOTASK:<name>` only echoes `taskSpace("<name>")` and open's first
  sentence in a shell call: the chat must stay unlinked.
- `OPENCUT:<name>` opens with `<name>` as the task's name and cuts that
  name in open's result at 60 characters, as an older `zenius mcp` did.
- `OPENASK:<name>` opens with `<name>` as the task's name, then ends its
  answer with a question, so Needs you with its zenius task linked.

## A run

```sh
I=zen-test                                    # your dev instance
X=tests/fixtures/agent-sidebar
node $X/serve.mjs &                           # the pages
node $X/config.mjs --instance $I --out /tmp/$I-sidebar/config.json
printf 'user_pref("uc.agent-sidebar.config", "/tmp/%s-sidebar/config.json");\n' $I > /tmp/$I-sidebar/prefs.js
printf 'user_pref("zenius.agentSidebar.allowUnknownAgents", true);\n' >> /tmp/$I-sidebar/prefs.js
node $X/fixture-tasks.mjs ~/.zenius-dev/profiles/$I   # optional, before the start
ZENIUS_DEV_PREFS=/tmp/$I-sidebar/prefs.js scripts/zen-dev.sh $I start
node $X/chrome.mjs --instance $I scene-build.js
until node $X/chrome.mjs --instance $I scene-ready.js | grep -q '"ready": true'; do sleep 3; done
node $X/shots.mjs --instance $I /tmp/$I-shots 2
```

The second pref lets the mock run: the sidebar starts only agents zenius can
hold to the browser (Claude Code, for now), and greys out any other agent
unless `zenius.agentSidebar.allowUnknownAgents` is true (zen-observe's
limits, `agent-sidebar/workspace.sys.mjs`). A run without it shows both mocks
greyed out, and no agent starts.

Each `SCENARIO:flights` run names its zenius task "Tokyo flights". Until
zen-sdk's fix (a taken name gets a number), a second run while the first is
open or held joins the first, so stop or close it first.

The scene takes about 20 s on the mock. With a real `claude` agent in the
config, the tab's chat and the shown task run on it instead, which is how
zen-sidebar's shots for the user are made, and which takes the network.
