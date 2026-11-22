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
  zenius server (`ZENIUS_TASK_SPACE`), which works on in that task. Codex's
  server gets it from `CODEX_CONFIG`, so each Codex Work chat has a codex-acp
  process of its own, and one from before the chat's task is replaced
  before the chat's next session.
- **Directory**: the tasks, over the page beside the sidebar, in three
  groups. Needs you: a permission, a hand-off or a wait for the user, the
  user's own Take over ("You have control"), a Take over zenius couldn't
  begin ("Can't take over this page", from zenius's taskBadge), a question
  the answer ends with, an error, or Zen quitting mid-task. A question
  right before the answer's closing list of choices counts too, whatever up
  to three lines follow the list, and so does a last sentence that waits on
  the user, with or without a question mark (zen-eval's demo and its
  retake, 2026-11-22): the agent's next step once the user picks ("Once you
  pick, I'll …", "I'll book it once you pick"), or "Let me know which …",
  in Chinese too ("你选好后我再…", "请告诉我…哪…"). The sign-offs that end
  many finished tasks don't count ("Let me know what you think", "… how it
  goes", "… if you need anything else"), but a question followed only by a
  bare closing does ("Which works for you? Let me know.", on its line or
  the next). The rule leans to Needs you: a
  missed one leaves a task waiting unseen, and a false one costs the user a
  glance. A list with no question right before it reads as a result.
  Working: a prompt runs. Done: finished, or stopped by the user.
- **The agent's own ask** (step 2 of Needs you; zen-ux's card): Work's
  agent asks with its own tool, Claude Code's AskUserQuestion or Codex's
  request_user_input, which its adapter turns into ACP's
  `elicitation/create` (docs/research/ask-user.md). The sidebar declares
  form elicitation in `initialize`, never url mode, so no agent can have it
  open a link. An ask holds the turn as a message of role `ask` (the
  agent's tool step gives way to it) and the task needs the user, with its
  first question's words; `AgentService.answerAsk` sends the picks and
  words back in the request's own shape, Skip declines, and Stop, the
  turn's end, a closed chat or the agent's own `$/cancel_request` settle it
  as not answered. A secret's words reach the agent but stay out of the
  message and the saved tasks, and the card shows "••••". An ask for a
  password or a code (`isCredentialAsk`: a secret, a field labelled just
  "Code", or such words in its title, a question or a field's label, in
  English or Chinese, a one-time code among them as agents ask for one: by
  its digits, from an email, a text or an authenticator app, a sign-in or
  confirmation code, MFA; a bare "code", as in a code style or a zip code,
  doesn't count; docs/safety-rubric.md) masks every field of words, keeps all of its
  answer out the same way, and the card says in a fixed line that passwords
  and codes go into the site through Take over. A masked field comes right
  under its question, with the question's options after it as a row of
  quiet pills, each one's description its tooltip (zen-ux's code card):
  Claude Code's AskUserQuestion brings 2 to 4 options even for a code, and
  Work's rule offers options only for real choices. An MCP server's
  own form shows the same way, as that server's; url mode, a field the
  card can't show, and an ask outside a turn are declined unseen. Codex
  0.169.0 offers request_user_input in its Default mode only with its
  feature `default_mode_request_user_input`, which Work's process turns on.
  The text rule above stays as the fallback.
- **zenius's strip agrees**: the sidebar tells zenius each task's word
  (`ZeniusUI.noteSidebarTask`): working while its turn runs, and needing
  the user for the reasons only the sidebar knows (a permission, a
  question, an error, Zen quitting mid-task). zenius knows hand-offs and
  Take over itself.
- **Queue and steer** (the user's ask, 2026-11-22; zen-ux's panel): while
  the agent works, Enter queues a message (`AgentService.enqueue`), which
  goes out when the turn ends, in order, in the same session; a queued
  Chat question reads its tab's page as it is then. Cmd+Enter or Steer
  (`steer`) sends one into the running turn at once: it shows in the chat
  where it was sent (`steered: true`), the answer it cut closes, and the
  agent's next message starts a new one. The cut answer's words still on
  their way when the steer went (its `messageId`, which both adapters
  stamp on each chunk) go on in its bubble, above the steer, where they
  can't read as the answer to it (`conv.cutReply`). Both adapters take
  `_session/steering` (claude-agent-acp 0.107.0, codex-acp 2.6.0;
  docs/research/steer.md), with `idleBehavior: "promptRequired"`, so a steer
  that meets the turn's end goes as the next question. For an agent that
  doesn't steer, the turn stops for it (session/cancel, with no
  "Stopped."), and it goes next. A steer during a permission declines it
  first (its reject option; the card reads as replied). After the user's
  Stop, or a turn that failed, nothing that waits goes out: the queue goes
  back into the box (`conv.draft`, `{type: "draft"}`), in order, before
  what it holds, with its files; the box's selection stays, else the
  first queued one's, and others become "> " quotes. The panel hears
  `{type: "queue"}` on each change of `conv.queue`, its queued rows; a
  steer on its way waits in `conv.steers`, and one that never reached the
  agent leaves the chat when it goes back into the box.
- **Thinking**: from the moment a question goes out until the agent's
  first words, a step the user sees, or a question for the user, the chat
  shows a row "Thinking · <what it's on> · 12 s". So does every later
  stretch of thinking that has words: Claude Code thinks between parts of
  its answer, and both agents think after their steps.
  - The middle part is the latest title of Codex's reasoning summary
    (`agent_thought_chunk`). For Claude Code's prose summaries, it's the
    first sentence of their latest paragraph that has a whole one.
  - It wraps to two lines at most, with the seconds beside its first line,
    and the row's tooltip has all of it.
  - Claude Code's thinking has words only with
    `CLAUDE_CODE_THINKING_DISPLAY=summarized`. The sidebar sets it in its
    own Claude Code process's env (`claudeEnvironment`,
    docs/research/claude-thinking-display.md).
  - Once a stretch ends, its row turns into "Thought for 23 s", which opens
    to what the agent thought. A stretch with no words, or one under a
    second, leaves nothing behind (AgentService's
    `startThought`/`endThought`, a message of role `thought`, saved with its
    words and time). A hidden step (ToolSearch) doesn't end it.
  - After a step, the row is a line of the steps' box, and the steps after
    it go on in the same box.
  - **Why:** Codex at xhigh thought for 23 s before its first word, with
    only the box's "Thinking…" on screen, and then its first sentences came
    in one piece. The user read this as a stall (zen-sidebar's diagnosis,
    2026-11-22).
- **Copy and save**: a turn's answer gets one copy and save row, on its
  last part, once the turn has ended (zen-ux's call, 2026-11-22).
  - It copies or saves the Markdown of all the turn's parts, joined by a
    blank line, without thoughts, steps, asks or notes. Save names the file
    after the answer's first heading.
  - A steer starts a turn of its own.
  - Each code block keeps its own buttons.
- **Steps**: each tool call is one line the user can read. A zenius MCP
  tool's line is the first line of its result ("Open example.com", "Click
  "Search""), from claude-agent-acp's content or codex-acp's
  `rawOutput.result`; until the result comes, the call's own arguments say it.
  A step the user's Stop cut short shows as stopped, not failed: one whose
  failure isn't the server's own words (claude-agent-acp's "The turn was
  cancelled before this tool call returned a result."), or that failed with
  no result at all (codex-acp's, when Codex gives an interrupted call none).
  The mock's held steps end on Stop as claude-agent-acp's do.
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
| `agent-sidebar/builtin.sys.mjs` | The built-in agents, when there's no config.json (zen-ux's) |
| `agent-sidebar/panel.{html,js,css}` | The panel, in the sidebar's own document |
| `agent-sidebar/directory.{sys.mjs,css}` | The directory drawer, in browser.xhtml |
| `agent-sidebar/AgentSidebarPicture{Parent,Child}.sys.mjs` | The live card's pictures, painted in the agent page's own process |
| `agent-sidebar/AgentSidebar{Parent,Child}.sys.mjs` | The JSWindowActor that reads a tab's selection and text |
| `agent-sidebar/attachments.mjs`, `saving.mjs` | Attached files; copying and saving answers |
| `agent-sidebar/pencil.svg` | The question's Edit icon, zenius's own drawing (outline strokes, painted as a mask in the text's color) |
| `agent-sidebar/send.svg` | Send's small up arrow, in the question box and the edit box: zenius's own drawing (a stem and a chevron, round strokes, painted as a mask in the button's text color) |
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
| `#pickers` > `#pick` > `#pick-model`, `#pick-dot`, `#pick-effort` | The chat's model and its effort ("Opus 5.5 · Low"), one button (`aria-expanded` while the picker is open). It opens `#picker`, while the agent answers too (the user's ask, 2026-11-22): a pick then, of a model or an effort, shows here and is saved at once, with no note, and the running turn keeps its model, as a steer into it does. The session gets the pick when the turn ends, however it ends, before anything queued goes out, so the next answer runs with it (`AgentService.pickModel`, `modelToSession`; claude-agent-acp 0.107.0 would switch the running turn's model, codex-acp 2.6.0 keeps it for its next turn). One the agent refuses then says "Could not change the model", and the label goes back to the session's. There is no `#harness` |
| `#picker` > `#pick-search`, `#pick-fam`, `#pick-list` | The model picker (the user's pick, 2026-11-21), an opaque card over the chat that opens upward from the composer. `#pick-search` (role `combobox`) keeps the focus and filters the open family; its `aria-activedescendant` is the active row or effort. `#pick-fam` (role `tablist`) has a `button[role=tab][data-harness]` per family: Claude (Claude Code's models), then GPT (Codex's), then other agents by name. It holds every agent that may run here (`AgentService.harnessAvailable(id)`) and the chat's own. It's hidden while only one family is left, as when the user sets `zenius.agentSidebar.allowCodex` to false. A task keeps its agent, so there the other families are disabled. So they are while the agent answers: another family's model starts a new chat, which would take the answer with it, so its tab says it waits for the answer to end |
| `#pick-list` > `.pick-row[data-value][data-effort]` | The open family's models, role `option`, of the newest generation only: the major version in each name, read from the agent's own list, so a new generation replaces the old by itself. Claude Code's "Default (recommended)" isn't one (the user's call, 2026-11-21). A chat on it shows, and checks, the model the agent names for it (the entry's description, "Opus 5.5"), and where the agent names none it runs on the newest generation's first model, the one shown in its place (`concreteModel`, `applyPreferredOptions`). Models without a version come first, then a `.pick-rule`. Each row shows the effort its model runs with: `AgentService.effortFor`, each model's own, in `uc.agent-sidebar.<harness>.efforts`. `aria-selected="true"` and a ✓ mark the chat's model; `.active` is the row the keys or the pointer are on. A click picks the model with its own effort |
| `#pick-fly` > `.pick-eff[data-value]` | The efforts the agent offers, in a flyout beside the active row, role `listbox`. It opens when the pointer rests on a row or on → (← closes it). A click, or Enter, picks the row's model with that effort, which becomes the model's own. Esc closes the flyout, then the picker, with the focus back in `#input` |
| `#stop`, `#send` | One shows at a time |
| `.steps > .step[data-status] > .label` | Steps; `data-status` is `done`, `running`, `failed`, `waiting` (for the user) or `stopped` |
| `.msg.thought` (`.live`) > `summary` or `.line` > `.head`, `.time`; `details > .body` | A stretch of the agent's thinking: "Thinking · <title> · 12 s" while `.live`, then "Thought for 23 s". `.head` clamps to two lines, and the line's `title` is the whole title. With words, a `details` whose `.body` is what it thought. After a step, it's inside `.steps` |
| `.msg.assistant > .actions` | Copy and save: one row per turn, on its last part, once the turn has ended |
| `html[data-external="true"]`, `.ext-view[data-state]` | A task the sidebar doesn't drive (`external.sys.mjs`, the user's ask: every zenius task in the sidebar), opened: read-only, so the question box shows only `#ext-bar`. `data-state` is the task's `working`, `needs` or `done` |
| `#ext-src` (`.addr`) | Where it's driven from: `Driven from <terminal> · <agent> · read-only`, the terminal a chip, or `Driven from <agent> · <folder> · read-only` without one |
| `#ext-steps > .ext-step[data-step][data-outcome]` > `.ext-text` (`.ext-name`), `.ext-page`, `.ext-outcome`, `.ext-time` | Its steps from the runtime's record, in the box and with the marks of the sidebar's own `.steps`. `data-outcome` is `ok`, `running` or `failed`. A running step shows the needs dot while the task needs the user, and `–` once it ended. Each quoted name is an isolate (`.ext-name`, `dir="auto"`). `.ext-page` names the step's page once the task has more than one; `data-same-page="true"` hides it where it repeats the step before. A failed step's code (`.ext-outcome`) sits under its words. With no steps, `.ext-empty` says "No steps yet" |
| `.ext-needs` > `.ext-needs-title`, `.ext-needs-text`, Watch | The agent's hand-off while the task needs the user, in the directory's Needs you tint (`--needs-bg`): "Needs you", its words, and Watch |
| `#ext-bar[data-ended]` > `#ext-bar-text`, `#ext-stop` | In the question's place: "The sidebar can't chat with this agent" and Stop task while it runs; once it ended, how (`Finished`, `Stopped by you` or `Closed`, then its age), with `data-ended` `finished` (a ✓) or `stopped`/`closed` (a –) |
| `#live[data-live="true"\|"false"][data-watching="true"\|"false"][data-drawn][data-every]` | The live card, the thread's last child, hidden until the task has a tab. `data-live` is true while the agent works on the page (the red dot); `data-watching` is true while this window watches the card's task; `data-drawn` counts the pictures drawn, and stays put while the card can't be seen; `data-every` is the wait for the next picture in ms, or `kept` after a very slow one. A test counts pictures by `data-drawn`: the card doesn't call drawSnapshot |
| `#live-shot`, `#live-text` | Its picture (a canvas) and its line: `Live · <host>`, `Waiting for you · <host>` (a hand-off), `You have control · <host>` (a Take over), or the host |
| `#live-src` | A remote task's source over the card's line: `From <address> · <label>` (`AgentService.remoteSource(conv)`, from `conv.remote`, each part a first-strong isolate); hidden for any other task. A remote question (`message.source === "remote"`) has the same line as its `.src`, where a '>' question says "from the address bar". On the card the line heads the card's foot, and in each place the address is a chip (`.addr`, panel.js's `fillSource`; the text is unchanged) |
| `#remote-end` | Under a remote task's last answer, once it stopped, why (`AgentService.remoteEnd(conv)`, from zen-observe's `conv.remote.final.stopReason`): "Stopped by <address>" (its caller's `sidebar.stop`, the address isolated), "Stopped at its time limit", "Stopped when remote tasks were turned off", "Stopped when Zen quit", or "Stopped" (the user's Stop). The task's state text says the same, on its directory row and in the title's tooltip. Hidden while it runs, when it failed (its error says why), and once the user takes a turn there themselves: an edit of the caller's question is the user's own (no `.src` line), and makes the chat theirs |
| `#arrival[role=group]`, `#arrival-text`, `#arrival-watch`, `#arrival-stop`, `#arrival-close` | A remote task's arrival, over the composer, when one starts while the panel is open in the front window: "Task from <address> · <label>" (also the group's `aria-label`), with Watch (the task's page if it has one yet, else the task here), Stop (`AgentService.cancel`, as the panel's Stop) and ✕. It takes no focus and moves nothing (I1), and goes after 10 s (`uc.agent-sidebar.arrival-ms`, for tests), though not from under the pointer or the focus. With the sidebar closed, zenius shows the same card over its strip (`#zenius-arrival`, `ZeniusUI.remoteArrival`). Its look: lined up with the question box, Working's purple dot, the text (two lines at most, the address a chip) and ✕ on top, Watch and Stop under them on the right, as the live card's buttons; it slides up as it comes (none with reduced motion) |
| `#watch`, `#watch-hint`, `#take-over` | Watch, hidden while this window watches the task; in its place then, the hint "⌃Tab back to your tabs" ("Ctrl+Tab" off the Mac), not a button; Take over, shown while the agent has the page, except while zenius reports a Take over refused |

The directory (in browser.xhtml, so prefixed):

| Hook | What |
|---|---|
| `#zenius-sidebar-directory` | Its layer; hidden while closed |
| `.asb-dir`, `.open`, `data-side="left"\|"right"` | The drawer; the side it comes out on |
| `.asb-dir-group[data-group="needs"\|"working"\|"done"]` | Group headings |
| `.asb-dir-row[data-task="<uid>"][data-state]` | A task; `data-current="true"` on the one the panel shows, whose tabs are `.asb-dir-tab` |
| `.asb-dir-src` | In a remote task's row, under its name: the same `From <address> · <label>`, its address a chip (`.asb-dir-addr`), also the second line of the row's tooltip. The search matches the address and the label |
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
  their own; `"none"` for no agents, as in every dev profile; `"builtin"`
  for the built-in agents alone, the tests'), `uc.agent-sidebar.harness`
  (the agent the user picked),
  `uc.agent-sidebar.shortcut`, `uc.agent-sidebar.max-page-chars`,
  `uc.agent-sidebar.debug`, `uc.agent-sidebar.width` (the panel's width as
  the user last dragged it, in px; 420 until then; the box takes it as the
  browser shows the panel, before its first paint, with the panel's look).
- The agents come from `config.json`, by default the user's
  `~/Library/Application Support/zenius-agent-sidebar/config.json`.
- Without that file (no other way of failing counts), and only while
  `uc.agent-sidebar.config` is unset, the sidebar offers its built-in
  agents (`builtin.sys.mjs`), built in memory at each `loadConfig`: the
  user's own Claude Code and Codex, through the ACP adapters that zenius's
  installer puts in `~/.zenius/agents`. A path the pref names never falls
  back to them, so a test's or a dev Zen's scratch path can't run the
  user's own Claude Code with their sign-in: a missing one fails as before
  (the manager's rule, 2026-11-22).
  - The installer copies `runtime/agents/package.json` and its lock there,
    then runs `npm ci --omit=dev --omit=optional --ignore-scripts --no-audit
    --no-fund --loglevel=error` (zen-sdk's). The lock
    pins claude-agent-acp 0.107.0 and codex-acp 2.6.0, and leaves out the
    SDKs' bundled CLIs. `node` there is a link to the user's Node 22.3 or
    later.
  - Each agent runs `~/.zenius/agents/node <adapter>/dist/index.js` with its
    CLI in `CLAUDE_CODE_EXECUTABLE` or `CODEX_PATH`, and with the Node
    and CLI folders first in its PATH. The CLI comes from Claude Code's or
    Codex's usual install folders: `~/.local/bin`, `~/.claude/local`,
    Homebrew, `/usr/local/bin`, npm's global folders (`~/.npm-global`,
    Volta, Bun, nvm), then Zen's PATH.
  - An agent is offered only when its CLI is there, and Claude Code comes
    first. When none can run, the sidebar says in one line what's missing.
  - Nothing is written: a config.json of the user's own always wins.
  - The test-only prefs `uc.agent-sidebar.builtin-root` and
    `uc.agent-sidebar.builtin-search` stand in for the adapters' folder
    and the CLIs' folders.

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
  NotebookEdit, Read, Glob, Grep and Task.
- Web search and fetch are on in Chat and Work (the user's pass on
  defenses, D1, 2026-11-21): Claude Code's WebSearch and WebFetch, allowed
  without asking, are Chat's only tools. The user's own denial of one in
  config.json stays. WebFetch runs in the CLI, which Zen started, so macOS
  counts its requests as Zen.app's: the zenius-only hook keeps it off the
  local network as task pages are kept (private and link-local addresses in
  any spelling, `.local` names; loopback stays open). Unlike the tabs, a
  name also counts by the addresses it resolves to, and a lookup that fails
  or takes over 3 s refuses; a name whose answer changes before the CLI
  connects still gets through. A Work agent can open such a page in a tab
  instead, where the user's own list applies.
- Chat fetches only URLs from its sources (the user's call): the user's
  words, the page as read (its address, text and links) and its search
  results' hits, plus a redirect's target. Each Claude Code Chat session
  has a list, `<profile>/agent-sidebar-allow/<session id>.txt`:
  - AgentService writes each question's URLs to it before the question goes
    out;
  - chat-sources.mjs, a PostToolUse hook, adds search hits and redirect
    targets;
  - the zenius-only hook refuses any other URL, before it looks a host up,
    and refuses every fetch when it can't read the list.

  Work fetches any URL. docs/research/chat-fetch.md has the design.
- Codex runs with its limits in memory: a read-only sandbox with no network,
  no shell tools or sub-agents, zenius's server in Work's processes only,
  one per Work chat (at most `uc.agent-sidebar.open-sessions` of them; the
  least recently used one stops, and a chat's stops when it's removed or
  closed, or as its last turn ends), cwd `codex/`. Its hosted web search,
  which runs at OpenAI, is on (D1): live in Work, and in Chat kept to the
  cached index, where no hook could hold it to Chat's sources. The user's own `CODEX_CONFIG` `"disabled"` or
  `"cached"` stays in both. The sidebar refuses its permission requests as
  it does Claude Code's. One read path stays: apply_patch's check can tell Codex
  whether a file exists, or holds a given line, though not what it says.
  It's on by default (`zenius.agentSidebar.allowCodex`, set on Zen's default
  branch so that about:config lists it). The user's false greys it out at
  once, with no restart: a running Codex process gets no new session or
  question. The sidebar declares ACP's `session.notices`, so codex-acp sends
  Codex's own warnings (such as one about a key in the user's
  `config.toml`) as notices, which the sidebar logs, and not as the start
  of an answer. An agent's error notice shows in the chat as a note.
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
