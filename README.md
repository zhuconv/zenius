# zenius

Agentic Zen: Ego Lite-style agent browsing inside your own Zen Browser. Each
agent task runs in its own Zen Space while you keep browsing in yours. You can
switch to an agent's Space to watch it work, and take over at any time.

Status: early development, used daily on macOS and tested headless on Linux,
with Zen 1.24 (Gecko 160). Start with `docs/SPEC.md`.

## What's here

- **The browser runtime** (`runtime/`): chrome scripts that Zen loads through
  [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig). They give
  each task its own Space and tabs, and serve page actions over a Unix
  socket, one request per action (`docs/PROTOCOL.md`). No WebExtension, no
  Marionette or WebDriver.
- **The `zenius` CLI and Node SDK** (`sdk/`), with Ego Lite's API: an agent
  pipes a script to `zenius nodejs`, and `zenius mcp` serves the same steps
  to Claude Code and Codex over MCP.
- **The Skill** (`skill/`) that teaches agents to use it, with site
  learnings.
- **The agent sidebar** in Zen (⌘⇧A): Codex or Claude Code over ACP.
  Codex is on by default, within limits: no shell, no file writes and no
  network outside zenius; its sub-agents and web search are off, and its
  approval requests are refused. One known gap remains: Codex's
  `apply_patch` check can answer yes or no about a local file (whether it
  exists, whether it holds a given line). To turn Codex off, set
  `zenius.agentSidebar.allowCodex` to false in about:config.
- **Tests** (`tests/`): every component's suite runs headless on Linux, and
  `docs/eval/` has the end-to-end and benchmark results against Ego Lite.

## Install

You need Zen with fx-autoconfig already set up in your profile, and Node 24
for the CLI.

```bash
scripts/install.sh --dry-run   # what it would change in your Zen profile
scripts/install.sh             # quit Zen first, then reopen it
scripts/install-cli.sh --skill # the zenius CLI, and its Skill for Claude Code and Codex
```

`install.sh` backs up every file it replaces or removes, under
`~/.zenius/backups/`, and `scripts/install.sh --uninstall` takes zenius out
again. It never changes the Zen app, and never quits or restarts Zen.
`docs/install-daily.md` is the full walk-through, and `docs/SPI.md`
("Install layout") says what goes where.

## Develop

```bash
export ZEN_BIN=/path/to/zen          # Linux; on macOS the default is /Applications/Zen.app
scripts/zen-dev.sh mine start        # a dev Zen on its own profile, ~/.zenius-dev/profiles/mine
(cd sdk && npm ci)                   # once: the SDK's build and test tools
scripts/test-all.sh                  # the smoke test and every component's suite, headless
```

`docs/SPEC.md` is the design, `docs/PROTOCOL.md` the contract between the
SDK and the runtime, and `docs/SPI.md` the runtime's internals.

## License

MIT (`LICENSE`) for zenius's own code. Third-party parts keep their own
licenses: see `THIRD_PARTY.md`. zenius isn't affiliated with Zen Browser,
Mozilla or CitroLabs.
