# The agent sidebar

zenius's in-browser agent: the user's agent sidebar (Codex or Claude Code over
ACP, in Zen's sidebar, ⌘⇧A), with two modes. Owners: zen-ux, with zen-sidebar
(SPEC §8). This page is the contract tests go by: the names below stay
stable, and a change to one is announced to zen-eval first.

- **Chat**: one conversation per tab, about its page (the sidebar as it was).
- **Work**: a chat bound to a task instead of a tab, so it stays while the
  user switches tabs. The address bar's '>' row and '+ New task' start one.
  The agent works in a zenius task of its own, in the Agents space; the chat
  follows that task's name, tabs and hand-offs. It links to a task only by
  the id of the one its own zenius open started: a task zenius created
  while that call ran, with the name open's result gives it. A name in a
  shell command or its output, the name the agent asked for, or any task
  from before the call never links it. On resume the id goes to the agent's
  zenius server (`ZENIUS_TASK_SPACE`), which works on in that task.
- **Directory**: the tasks, over the page beside the sidebar, in three
  groups. Needs you: a permission, a hand-off or a wait for the user, the
  user's own Take over ("You have control"), a Take over zenius couldn't
  begin ("Can't take over this page", from zenius's taskBadge), a question
  the answer ends with, an error, or Zen quitting mid-task. Working: a
  prompt runs. Done: finished, or stopped by the user.
- **zenius's strip agrees**: the sidebar tells zenius each task's word
  (`ZeniusUI.noteSidebarTask`): working while its turn runs, and needing
  the user for the reasons only the sidebar knows (a permission, a
  question, an error, Zen quitting mid-task). zenius knows hand-offs and
  Take over itself.
- **Steps**: each tool call is one line the user can read. A zenius MCP
  tool's line is the first line of its result ("Open example.com", "Click
  "Search""), from claude-agent-acp's content or codex-acp's
  `rawOutput.result`; until the result comes, the call's own arguments say it.
- **Live card, Watch and Take over**: at the end of a work chat, once its
  task has a tab, a picture of the page the agent is on (zenius's front tab
  of the task): one when the card appears (or the task moves to another
  tab), then one every 2 s while the agent works there. It is drawn only
  while the user can see it: never while it's scrolled out of the thread,
  in Chat, with the panel's document hidden, or with the sidebar closed
  (which unloads the panel). Each picture is painted in the page's own
  process (the AgentSidebarPicture actor: drawWindow, only the rows the
  card shows, at the card's scale) and comes back as raw pixels of exactly
  the size asked, which the panel copies in, so a page that is costly to
  paint can't stall the user's browser through the card, and nothing that
  process made goes through an image decoder in the parent. After a picture
  that took over 50 ms to come (timed by the panel, the whole ask), the
  next waits 40 times as long (at most 30 s); after one over 1 s, or one
  the page's process doesn't answer within 5 s, the card keeps it until it
  appears again. It paints only an agent's page of the chat's own zenius
  task while the agent has it, checked before the actor is made: never a
  user's tab, a tab the user opened in the task, another task's page, or
  the task's pages while the user holds them (a hand-off or Take over),
  when the card keeps its last picture. An iframe from another site is blank in the card. Watch is
  zenius's watch (`ZeniusUI.watch`, as its tasks panel's Open is): the
  window shows the task's Space and tab and keeps the panel on the task.
  zenius's strip reads "Watching <task> · ⌃Tab", or, where the strip can't
  be read (a collapsed sidebar, compact mode), a small chip in the page
  area's top left corner says the same, never over the page's top middle
  and cut past 280 px or 40 % of the page area. Every click on it reaches
  the page under it. ⌃Tab returns to the Space and tab the user watched
  from: while watching, the card shows "⌃Tab back to your tabs" where Watch was,
  since ⌃Tab is the way back (the user's design), and keeps Take over.
  ⌃Tab does that only while watching; elsewhere it stays Zen's. Picking a
  tab outside the task, or another Space, ends the watch where the user
  went. Take over is zenius's (as its tasks panel does it), then a watch:
  the agent waits until the user presses zenius's Resume agent. While
  zenius reports a Take over refused ("Can't take over this page"), the
  card hides Take over: zenius's card on the page holds the choices, with
  Try again only where it can work. A task's tab in the directory starts a
  watch on that tab.

## Files

| Path (`runtime/JS/`) | What |
|---|---|
| `agent-sidebar.uc.js` | Each window: the panel, ⌘⇧A, which chat the panel shows (Chat or Work), the directory, reading the tab |
| `agent-sidebar/AgentService.sys.mjs` | Shared: the agents (ACP), conversations, tasks and their state, the tasks file, the zenius link, steps |
| `agent-sidebar/AgentSidebar.sys.mjs` | The entry points other scripts import |
| `agent-sidebar/panel.{html,js,css}` | The panel, in the sidebar's own document |
| `agent-sidebar/directory.{sys.mjs,css}` | The directory drawer, in browser.xhtml |
| `agent-sidebar/AgentSidebarPicture{Parent,Child}.sys.mjs` | The live card's pictures, painted in the agent page's own process |
| `agent-sidebar/AgentSidebar{Parent,Child}.sys.mjs` | The JSWindowActor that reads a tab's selection and text |
| `agent-sidebar/attachments.mjs`, `saving.mjs` | Attached files; copying and saving answers |
| `agent-sidebar/pencil.svg` | The question's Edit icon, zenius's own drawing (outline strokes, painted as a mask in the text's color) |
| `agent-sidebar/vendor/marked.esm.js` | marked, MIT (THIRD_PARTY.md) |
| `agent-urlbar.uc.js`, `agent-urlbar/AgentUrlbar.sys.mjs` | The address bar's '>' row |

## Entry points

`chrome://userscripts/content/agent-sidebar/AgentSidebar.sys.mjs`:

- `startWorkChat(win, { text, source = "urlbar" })` starts a work chat in
  `win`'s sidebar: a new task with `text` as its first request, shown in
  Work mode while the user stays on their page. It resolves, once the
  sidebar shows the task and before the agent answers, to the task's id
  (its uid). With no text, the new task waits to be typed. `source:
  "urlbar"` puts "from the address bar" over the request.

`window.ucAgentSidebar`, in each browser window:

| Name | What |
|---|---|
| `startWorkChat(text, { source })` | The same as the module's, for this window; resolves to the uid |
| `mode`, `setMode("chat"\|"work")` | Which chat the panel shows |
| `showTask(uid)` | Work mode on a task (a conversation works too) |
| `newTask()` | Work mode on a new task, ready to type |
| `toggleDirectory()`, `closeDirectory()`, `directoryOpen` | The directory |
| `watch(uid, { tab })` | Watch a task (on `tab`, one of its tabs, if given) with zenius's `ZeniusUI.watch`; resolves to whether the window shows it. Watching another task keeps the way back |
| `stopWatching({ back = true })` | End the watch; with `back`, return to the user's Space and tab. Resolves to whether a watch ended |
| `takeOver(uid)` | zenius's Take over, then a watch; resolves to whether the user has the task |
| `watching` | The uid of the task this window watches, else null, whoever began the watch: the card, the directory, zenius's tasks panel or a notification |
| `currentTask` | The task Work mode shows |
| `conversationFor(tab)`, `submit(conv, { question, selection, attachments })` | A tab's chat, and asking in it (zen-eval's dispatch tests) |
| `panel.show(conv)`, `panel.compose(conv, { selection })` | The open panel |
| `AgentService` | `tasks` (uid → conversation), `taskList()`, `needsCount()`, `preferredHarness()` (the user's last pick in the sidebar, then config.json's default when it may run, then Claude Code), `setHarness(conv, id, { pick })` (`pick: false` for a switch zenius makes, which isn't kept as the user's pick) |

`AgentService.isHeld(conv)` says `"takeover"`, `"handoff"` or false: who
started a hold is the `source` of zenius's spaceChanged, kept in the task's
`zen.heldBy`, since zenius gives a hand-off without a reason Ego's default,
`manual_takeover`.

## Stable hooks

The panel (`panel.html`, its own document, so bare ids):

| Hook | What |
|---|---|
| `html[data-mode="chat"\|"work"]` | The mode |
| `#header`: `#dir`, `#favicon`, `#title`, `#more`, `#menu` | `#dir` (Work only; `aria-expanded` while the directory is open) or `#favicon` (Chat only), the title, the ⋯ menu |
| `#box`: `#input`, `#bar` | The question box: the text, and its bottom row |
| `#bar` > `#bar-start`, `#bar-end` | The row's two groups: `#attach` and `#switch`; then `#pickers`, `#stop` and `#send`. One row when both fit at their natural widths; otherwise `#bar-end` wraps whole to a second row, at the right, under `#bar-start`, and shrinks the pickers (an ellipsis) rather than run past `#box`. Nothing is hidden. In a box under 170 px the first group tightens, so it keeps one row with the count |
| `#attach`, `#switch` > `#to-chat`, `#to-work` | '+' and the switch; the shown mode's button has `aria-pressed="true"` |
| `#needs` | Inside `#to-work`: the tasks that need the user, hidden at 0; its orange is `var(--needs-color)` |
| `#pickers` > `#model`, `#effort` | The agent and model, one menu: an `optgroup[data-harness]` per agent, each `option[data-harness]` valued `<harness>/<model>`; then the effort. There is no `#harness` |
| `optgroup[data-harness][data-unavailable="true"]` | An agent that can't run here (`AgentService.harnessAvailable(id)` says `{ ok: false, reason }`, Codex when the user sets `zenius.agentSidebar.allowCodex` to false): disabled, labeled `<name>: <reason>`. A chat already on it shows the reason as its placeholder |
| `#stop`, `#send` | One shows at a time |
| `.steps > .step[data-status] > .label` | Steps; `data-status` is `done`, `running`, `failed`, `waiting` (for the user) or `stopped` |
| `#live[data-live="true"\|"false"][data-watching="true"\|"false"][data-drawn][data-every]` | The live card, the thread's last child, hidden until the task has a tab. `data-live` is true while the agent works on the page (the red dot); `data-watching` is true while this window watches the card's task; `data-drawn` counts the pictures drawn, and stays put while the card can't be seen; `data-every` is the wait for the next picture in ms, or `kept` after a very slow one. A test counts pictures by `data-drawn`: the card doesn't call drawSnapshot |
| `#live-shot`, `#live-text` | Its picture (a canvas) and its line: `Live · <host>`, `Waiting for you · <host>` (a hand-off), `You have control · <host>` (a Take over), or the host |
| `#watch`, `#watch-hint`, `#take-over` | Watch, hidden while this window watches the task; in its place then, the hint "⌃Tab back to your tabs" ("Ctrl+Tab" off the Mac), not a button; Take over, shown while the agent has the page, except while zenius reports a Take over refused |

The directory (in browser.xhtml, so prefixed):

| Hook | What |
|---|---|
| `#zenius-sidebar-directory` | Its layer; hidden while closed |
| `.asb-dir`, `.open`, `data-side="left"\|"right"` | The drawer; the side it comes out on |
| `.asb-dir-group[data-group="needs"\|"working"\|"done"]` | Group headings |
| `.asb-dir-row[data-task="<uid>"][data-state]` | A task; `data-current="true"` on the one the panel shows, whose tabs are `.asb-dir-tab` |
| `.asb-dir-tab` | One of the current task's tabs; a click watches the task on it |
| `var(--asb-needs-color)` | Its orange |

The window while watching (browser.xhtml):

| Hook | What |
|---|---|
| `#main-window[data-zenius-watching="<uid>"]` | The task the window watches, when a chat follows it |
| `#zenius-agents-strip[watching]` | zenius's strip while the window watches: "Watching <task> · ⌃Tab", the name in `.zenius-strip-name`. Once the watched task ended there, `[watching="done"]`: "Task done · ⌃Tab back to your tabs", with "back to your tabs" in `.zenius-strip-rest`, until the user presses ⌃Tab or picks another tab or Space. A hint: a click opens the tasks panel |
| `#zenius-watch-pill` | zenius's chip, in the page area's top left corner, only while the window watches and the strip can't be read (a collapsed sidebar, compact mode): "Watching <task> · ⌃Tab", or once the task ended there, `[done]`: "Task done · ⌃Tab back to your tabs", with "back to your tabs" in `.zenius-watch-rest`. Every click passes through it to the page |
| ⌃Tab | Goes back while watching (stopped before Zen's tab box and ctrlTab see it); Zen's otherwise. Only trusted key events count. Tests send it through nsITextInputProcessor |

The address bar: both rows are `.urlbarView-row[dynamicType="zeniusAskAgent"]`,
from providers `ZeniusAskAgent` (the '>' first row) and
`ZeniusAskAgentSuggest` (second, on other input). Find them by these, never
by the icon, which zen-ux will change. A test types '>' (the input field's
value, then an `input` event): `gURLBar.search("> …")` reads '>' as
Firefox's Actions restrict token and shows no row.

## Doctor

- `agent-sidebar.uc.js` carries the line `// zenius: agent-sidebar` in its
  `==UserScript==` header, within its first 20 lines.
- Each window's start ends by setting
  `window.zeniusSidebarStart = Object.freeze({ error })`, where `error` is
  the start's exception message, or null. zen-ux's `ui.sidebarStatus` reads
  it (agreed with zen-sdk). A property, so the sidebar's start loads no
  zenius module (I4).
- The sidebar panel's title is "Agent".

## State

- `agent-sidebar-tasks.json` in the profile: the tasks, read once at startup
  and written 1 s after a listed task changes and at a clean quit.
  `{ version: 1, tasks: [...] }`, oldest first. A task saved while busy
  comes back as Needs you. It keeps no attached file's contents and no tool
  input or result, only what each step shows.
- Prefs: `uc.agent-sidebar.config` (the config's path; tests point it at
  their own), `uc.agent-sidebar.harness` (the agent the user picked),
  `uc.agent-sidebar.shortcut`, `uc.agent-sidebar.max-page-chars`,
  `uc.agent-sidebar.debug`.
- The agents come from `config.json`, by default the user's
  `~/Library/Application Support/zenius-agent-sidebar/config.json`.

## The agents' limits

Decided (SPEC §8, zen-ux's review, zen-manager), built on the process side by
zen-observe (`zen-observe/sidebar-limits`; zen-sidebar's start of it is
`zen-sidebar/limits-wip`). Nothing goes into `~/.claude` or `~/.codex`, and
the user's config.json is only read.

- The workspace is `<profile>/agent-sidebar-workspace/`, with one folder for
  each adapter, `claude/` and `codex/`, so Codex's sandboxed writes can't
  reach Claude Code's settings. Each session runs in its adapter's folder,
  whatever cwd config.json names.
- The limit files (`CLAUDE.md`, `AGENTS.md`, and Claude Code's
  `.claude/settings.json`) are written afresh right before each session
  starts, not only at startup, and read back afterwards. If that fails, no
  agent starts.
- The zenius-only hook stays in zenius's installed code
  (`chrome/JS/agent-sidebar/…/zenius-only.mjs`) and is never copied into a
  workspace. settings.json names it by its absolute path, quoted, and the
  command ends in `|| exit 2`.
- Claude Code gets the zenius MCP server through ACP's `mcpServers`, always,
  as its only server. Its session `_meta` sets `settingSources: ["project"]`,
  `strictMcpConfig: true`, and disallows Bash, Edit, MultiEdit, Write,
  NotebookEdit, Read, Glob, Grep, WebFetch, WebSearch and Task.
- Codex runs with its limits in memory: a read-only sandbox with no network,
  no shell tools, sub-agents or web search, zenius's server in Work's process
  only, cwd `codex/`. The sidebar refuses its permission requests as it does
  Claude Code's. One read path stays: apply_patch's check can tell Codex
  whether a file exists, or holds a given line, though not what it says.
  It's on by default (`zenius.agentSidebar.allowCodex`, set on Zen's default
  branch so that about:config lists it). The user's false greys it out at
  once, with no restart: a running Codex process gets no new session or
  question.
- A new chat's agent is the user's last pick in the sidebar, then
  config.json's default when it may run, then Claude Code. A fallback while
  an agent is off isn't kept as a pick.
- The options cache moves into the profile. `uc.agent-sidebar.config =
  "none"` means no agents: zen-dev.sh sets it in every dev profile, and
  tests point it at their own config.
- install.sh writes none of the workspace. Undo removes it, and doctor
  reports it (zen-core and zen-sdk).
- The MCP server runs the installed CLI's `zenius mcp`. A CLI installed
  before `sdk/src/mcp.ts` (the daily's at cbac1ef) has no `mcp`, so
  install-cli.sh has to install a current main with the sidebar.

## Tests and fixtures

`tests/fixtures/agent-sidebar/` (its README): a mock ACP agent whose
scenarios drive this checkout's `zenius mcp`, a mock-only config, pages on
loopback, a tasks file in every state but Working, and a live scene with all
of them.

Once these files are in `runtime/JS/`, `scripts/zen-dev.sh` copies them into
every dev profile, so every dev Zen loads the sidebar. With no agents (the
config `"none"`, or none to read), it adds no row to the address bar.
⌘⇧A opens the sidebar there; Zen's own key for it is switched off while the
script runs.
