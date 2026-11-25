# The bundle's Mac tests (zen-eval)

The daily Zen's next update brings the two-mode agent sidebar, the address
bar's '>' and the zenius MCP tools. These tests cover the Mac-only behavior
that belongs to them: the look, Cmd shortcuts and ⌃Tab.
They run on a dev profile, never on the daily Zen or the user's try Zen.

| File | How | What it checks |
|---|---|---|
| `look.test.mjs` | headed on the Mac | In Zen's Light and Dark: the header shows only the title. Chat \| Work sits in the composer's row with '+' on the left and the pickers and send on the right, and Work carries an orange count of the tasks that need the user. At the sidebar's narrowest width the row may wrap, but only as zen-sidebar's bar does: '+' and the switch, then the pickers and send at the right, with nothing hidden or past the box. The drawer slides over the page, without moving it, with Needs you, Working and Done, and the current task open to its tabs. It also checks which parts let Zen's window material through. Shots go to `$ZENIUS_MAC_SHOTS`. |
| `urlbar.test.mjs` | headless | Cmd+T then '>': 'Ask agent' is the first row, and Enter starts a work chat. Without '>', the search stays Zen's, with no 'Ask agent' row. |
| `watch.test.mjs` | headless | ⌃Tab stays Zen's own while the user isn't watching. A working task's live card shows its page, with Watch and Take over, and draws only while it can be seen. Watch shows the task's Space and tab, and so does a click on one of the task's tabs in the directory. While the window watches, by Watch, the directory or Take over, the card hides Watch and shows its hint in its place, "⌃Tab back to your tabs", which isn't a button, and zenius's strip says "Watching <task> [⌃Tab]". With the sidebar collapsed or in compact mode, a chip in the page area's top left corner says it instead: at most 280 px or 40% of the page wide, with no buttons, and every click goes through it. With a 200-character name, in Light and Dark, the strip and the chip cut the name, never the key. ⌃Tab, the only way back, returns to the user's Space and tab while the task works on. When a watched task ends (the agent finishes it, keeping nothing), the window stays on its page, which waits for the user to leave it, and the strip, or the chip with the sidebar collapsed, says "Task done, [⌃Tab] back to your tabs". In Light and Dark, "Task done" and the key stay whole, and where the hint is narrow only "back to your tabs" is cut. ⌃Tab then goes back, and the page closes. Take over hands the page to the user. It skips Watch where Watch isn't built. Keys are trusted, through nsITextInputProcessor. |

```bash
tests/mac/run.sh                                   # every suite, headless
ZENIUS_MAC_HEADED=1 tests/mac/run.sh tests/mac/look.test.mjs
```

`run.sh` starts a dev Zen whose sidebar talks to zen-sidebar's mock agents.
Its fixtures are in `tests/fixtures/agent-sidebar/`: the mock agent, the test
pages, the config (`config.mjs`) and the fixture tasks. The mock drives the
real `zenius mcp` on the test's instance, and nothing goes past 127.0.0.1.
`run.sh` lists its settings. It sets what the sidebar needs in a dev profile:
`ZENIUS_AGENT_SCRIPTS=1` (zen-dev.sh leaves the agent's scripts out
otherwise), the config's path, and `zenius.agentSidebar.allowUnknownAgents`
(the agents' limits grey out every agent but Claude Code and Codex, the
mocks included).

`ZENIUS_MAC_REPO` picks the checkout whose runtime and SDK the dev Zen runs,
such as a worktree at a candidate's commit. On a checkout without the
sidebar, the suites fail or skip.

## The hooks

`hooks.mjs` holds every id, attribute and entry point the tests use, as
zen-sidebar's `docs/agent-sidebar.md` names them. zen-ux keeps those names as
a contract. A renamed hook is a one-line change there.

The URL bar's row is found by `dynamicType` and `providerName`, never by its
icon's file name.

## The window material

On the Mac, Zen's window is transparent over the system's material (the
vibrancy). A snapshot can't draw that material, and no test captures the
screen: the terminal has no Screen Recording permission, and won't get one
for a test.

So `look.test.mjs` takes a snapshot over a transparent backdrop. Its alpha
shows which parts let the material through, which it compares with Zen's own
sidebar and with `MATERIAL` in `hooks.mjs`. The panel and the drawer are
solid: a see-through panel was tried and dropped, so the look has no switch.

## Rules on the user's Mac

- Headed runs go only through zen-eval's nets: the user idle, no call or
  screen share, and a window that closes on every way out.
- No screen capture, and no pasteboard reads or writes.
- `scripts/test-all.sh` doesn't run these suites.
