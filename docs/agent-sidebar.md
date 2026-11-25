# The agent sidebar

zenius's in-browser agent: its agent sidebar (Codex or Claude Code over
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
  - The header's ⋯ menu is short, so it reads at a glance: New,
    Rename, Archive, and Close with its key, ⌘⇧A, each with a tooltip that
    says what it does. New is the mode's: a new chat for this tab in Chat,
    a new task in Work. Rename and Archive are Work's. Close stays: the
    sidebar hides the browser's own header, and its close button with it.
  - The user can rename a task: the header's
    ⋯ menu has Rename, and a double-click on the task's name does the
    same. The name turns into a field in place. Enter, or a click outside,
    keeps what it says, and an empty one gives the task its own title back;
    Esc leaves the name as it was. The user's name (`userTitle`, saved with
    the task) shows in the header, the directory and its search, and on the
    task's zenius task, for zenius's strip, Watch and the task's tabs'
    tags. Nothing later changes it: not the first question, nor the agent's
    name for a zenius task its open starts, nor a name the agent gives that
    task later (a claim's), which the sidebar renames back
    (`AgentService.renameTask`, `nameZen`). While another live task has the
    name, the zenius task takes it with a number, as a new task's name gets
    one ("<name> 2"), and keeps that number: zenius keeps live names
    unique, and a script's `taskSpace(name)` must still find its own task.
    The sidebar shows the name as typed. A task
    another program drives keeps its program's name, with no Rename: a
    script finds its task by that name (`taskSpace(name)`), and zenius
    shows it.
  - The ⋯ menu's Archive (in place of Remove task) moves the task out of the
    list to Archived, the directory's last group, and the panel to the
    newest task, else a new one. Its tooltip says what else happens. A turn
    that's running stops, as with Stop, and the session is parked for a
    later question. The task's zenius tasks, which nothing drives now, end
    as the strip's Stop ends one, and their tabs stay open, the user's: the
    one the chat follows, and any its agent started that the chat hasn't
    linked yet, by their `source.sidebar`, such as the first open's while
    its page still loads, or one zenius creates after the click from a call
    the Stop cut (`liveZenTasks`, ended again at the turn's end and on
    zenius's `spaceCreated`). That late pass ends only the tasks whose
    `source.sidebar` names the chat: the one it follows ended at the click,
    so if it runs again, a program claimed it on the user's yes, with a
    source of its own. Opened from Archived, a task reads as it was, without
    a box or an open question editor: `#archived-bar` says since when, with
    Unarchive, which brings it back to the list, as the menu's Unarchive
    does. A new turn would bring it back too: nothing runs in Archived, and
    an archived task never counts as needing the user, so past MAX_TASKS
    (60) it goes as if finished, whatever state it was left in
    (`AgentService.archiveTask`, `unarchiveTask`, `archivedAt`, saved with
    the task). A task another
    program drives can be archived only once it ended. It stays in Archived
    while zenius's feed keeps it as it ended, a day, past a restart
    (`archivedSpaces`, `archivedAtOf`); one that another program claims
    again, with the user's OK, or a new task zenius gives its id, is listed
    as any other, running or ended.
  - `AgentService.removeTask`, the menu's Remove task until Archive, stays
    for programs and tests: it forgets the task and ends its zenius tasks,
    linked or not, as Archive does, and they stay out of the directory for
    a day, as they ended (`wasRemoved`).
- **Directory**: the tasks, over the page beside the sidebar, in three
  groups. Needs you: a permission, a hand-off or a wait for the user, the
  user's own Take over ("You have control"), a Take over zenius couldn't
  begin ("Can't take over this page", from zenius's taskBadge), a question
  the answer ends with, an error, or Zen quitting mid-task. A question
  right before the answer's closing list of choices counts too, whatever up
  to three lines follow the list, and so does a last sentence that waits on
  the user, with or without a question mark: the agent's next step
  once the user picks ("Once you
  pick, I'll …", "I'll book it once you pick"), or "Let me know which …",
  in Chinese too ("你选好后我再…", "请告诉我…哪…"). The sign-offs that end
  many finished tasks don't count ("Let me know what you think", "… how it
  goes", "… if you need anything else"), but a question followed only by a
  bare closing does ("Which works for you? Let me know.", on its line or
  the next). The rule leans to Needs you: a
  missed one leaves a task waiting unseen, and a false one costs the user a
  glance. A list with no question right before it reads as a result.
  Working: a prompt runs. Done: finished, or stopped by the user. Then
  Archived, the tasks the user archived, last archived first: collapsed,
  with a count, and open on its own when the panel shows one of them. A
  search shows its matches there too.
- **Pinned, and each row's menu**, so a right-click on any task offers at
  least Pin and Rename: a right-click on a row, or
  the context-menu key or Shift+F10 on the row the arrow keys are on,
  opens its menu, a XUL menu under that row for the keys: Pin or Unpin,
  Rename, then Archive or Unarchive, in the ⋯ menu's words and tooltips
  (`taskmenu.sys.mjs`, which
  the ⋯ menu shares). Pin puts the task in Pinned, the first group, the
  last pinned first; a pinned task keeps its state, so one that needs the
  user keeps the Needs you tint. At most 20 are pinned (`PIN_CAP`): then
  Pin shows disabled, its tooltip saying to unpin one first. A pinned task
  never goes past MAX_TASKS, which counts only the unpinned. Archive
  unpins, and Unarchive doesn't pin again; an archived task has no Pin.
  Rename makes the row's name a field, as the header's Rename does: Enter
  or a click outside keeps it, Esc leaves it, an empty one gives the task
  its own title back, and an IME composition's keys only compose; the list
  waits while it's out (`AgentService.renameTask`). A name left as it was
  renames nothing. A task another program drives has Pin, Rename and, once
  it ended, Archive. Its Rename names it in the sidebar only, and its zenius
  task keeps its program's name, which a script finds it by and zenius's
  strip and tags show; a search finds either. An empty name, or the
  program's own, shows the program's names again, its later ones too. Its
  pin and name are kept by its id and start, so they hold while
  zenius's feed keeps the task, through a restart, and a new task given its
  id later takes neither (`pins.sys.mjs`, `AgentService.pinTask`,
  `unpinTask`, `labelTask`, `marks`).
- **The agent's own ask**: Work's agent asks with its own tool, Claude
  Code's AskUserQuestion or Codex's request_user_input, which its adapter
  turns into ACP's `elicitation/create`. The sidebar declares
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
  doesn't count) masks every field of words, keeps all of its
  answer out the same way, and the card says in a fixed line that passwords
  and codes go into the site through Take over. A masked field comes right
  under its question, with the question's options after it as a row of
  quiet pills, each one's description its tooltip:
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
  Take over itself. zenius's way to a task (its tasks panel's Open and tab
  names, a notification's click, the strip's click while it names one
  waiting task) opens the sidebar on the Work chat that drives the task,
  if one does (`openChatOfSpace`). A chat that needs the user before any
  zenius task says so goes to zenius with why it waits
  (`AgentService.noteWaiting`): the strip names it when it waits alone, and
  the tasks panel has a row for it with Open.
- **Queue and steer**: while the agent works, Enter queues a message
  (`AgentService.enqueue`), which goes out when the turn ends, in order, in
  the same session; a queued Chat question reads its tab's page as it is
  then. Cmd+Enter or Steer (`steer`) sends one into the running turn at
  once: it shows in the chat where it was sent (`steered: true`), the answer
  it cut closes, and the agent's next message starts a new one. The cut
  answer's words still on their way when the steer went (its `messageId`,
  which both adapters stamp on each chunk) go on in its bubble, above the
  steer, where they can't read as the answer to it (`conv.cutReply`). Both
  adapters take `_session/steering` (claude-agent-acp 0.107.0, codex-acp
  2.6.0), with `idleBehavior: "promptRequired"`, so a steer
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
- **Sending follows the answer**: a message
  the user sends takes the chat to its end, even from an earlier answer
  they scrolled up to read, since they want the answer: Enter, Send,
  Cmd+Enter and Steer, a queued one (the list doesn't change, so at once,
  with the queue's row in), a queued row's Steer, an answer to the agent's
  ask, and an edited question. The view then follows the answer as from
  the end, through what moves the end meanwhile (the queue's row, a box
  the next message grows), until the user scrolls up: from there it stays
  where they put it, as before (panel.js's `followUp`, `following`). The
  move is instant.
- **Editing a message**: Edit on any of the user's messages, a steer's too,
  asks again from there. The message and everything after it leave the
  chat. The agent's session goes back with `session/fork` to a point before
  it (`AgentService.editPlan`), in a new process for a Work chat, and the
  old session is closed.
  - The fork copies the session up to the whole API message its point
    names. claude-agent-acp keys that message by the id its text chunks
    carry, and its thinking chunks too, but never a tool call.
  - So a point is an answer, or with Claude Code a thought (saved with its
    `messageId`), of a session the chat's descends from, in a turn that
    ended. Until the user's next message, nothing may follow it but
    thoughts, notes and steps that never finished: cut short (by a Stop,
    a message or the session's end) or moved to the background.
  - Why: a finished step's result would be lost. A step in the point's own
    API message would come back as cut short by the session's end, so the
    agent might do it again.
  - The newest point keeps everything the agent did before the edited
    message when nothing else lies between them: a question after an
    ended turn, or a steer that cut the step it came during.
  - Otherwise, as for a steer sent after the agent's own steps (issue #3),
    the edit box says under the box what the agent forgets: "Sending this
    edit takes the agent back before the last 3 steps and 2 messages above,
    and it forgets them. The pages stay as they are. To keep them, send a
    new message instead." The edit goes back to the newest point, or, with
    none, starts a new session. A note where the edit goes says the same,
    since those steps and messages stay on screen.
- **What AgentService keeps holds no panel**, or the panel would leak. An
  object a panel made keeps that panel's whole window, about
  0.9 MB, for as long as anything holds it. So AgentService keeps its own
  copies of what a panel hands it: a question's files and an ask's answers
  (`own`), and the box's draft with its files (`setDraft`). A file the user
  attaches is AgentService's from the start (`newDraftFile`), and the
  panel's read fills it in (`fileRead`, `fileFailed`). A send waits on
  AgentService's word that each read ended (`fileSettled`). A panel that
  closes fails the reads it hasn't finished, so a send from the next panel
  doesn't wait on a dead read: the file says it wasn't read and stays out.
  When a read ends, every sidebar showing that draft draws its files again
  (`{type: "files"}`), another window's on the same task too. Only the
  files are drawn again, so the box there keeps what's typed and its caret.
- **Thinking**: from the moment a question goes out until the agent's
  first words, a step the user sees, or a question for the user, the chat
  shows a row "Thinking for 12 s, <what it's on>". So does every later
  stretch of thinking that has words: Claude Code thinks between parts of
  its answer, and both agents think after their steps.
  - The part after the comma is the latest title of Codex's reasoning summary
    (`agent_thought_chunk`). For Claude Code's prose summaries, it's the
    first sentence of their latest paragraph that has a whole one.
  - It wraps to two lines at most, the seconds right after "Thinking", and
    the row's tooltip has all of it.
  - Claude Code's thinking has words only with
    `CLAUDE_CODE_THINKING_DISPLAY=summarized`. The sidebar sets it in its
    own Claude Code process's env (`claudeEnvironment`).
  - Once a stretch ends, its row turns into "Thought for 23 s", which opens
    to what the agent thought. A stretch with no words, or one under a
    second, leaves nothing behind (AgentService's
    `startThought`/`endThought`, a message of role `thought`, saved with its
    words and time). A hidden step (ToolSearch) doesn't end it.
  - After a step, the row is a line of the steps' box, and the steps after
    it go on in the same box.
  - **Why:** Codex at xhigh thought for 23 s before its first word, with
    only the box's "Thinking…" on screen, and then its first sentences came
    in one piece, which looked like a stall.
- **Copy and save**: a turn's answer gets one copy and save row, on its
  last part, once the turn has ended.
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
  - Claude Code's own words for a call it ended or moved are never a step's
    text (`harnessWords`; Claude Code 2.1.332's texts, and
    claude-agent-acp's `nonExecutionKind` `interrupted` or `cancelled`). The
    step keeps the call's own text, with those words folded under it.
  - A call ended short of its result shows as stopped, whoever ended it:
    the user's message ("The tool call was interrupted before a result was
    received..."), a message delivered at the turn's end, or the end of the
    session that ran it.
  - A call Claude Code moved to the background ("MCP tool ... was moved to
    the background as task ...") goes on in the server. Its step shows as
    done, except a wait for the user, which shows as waiting while the task
    is the user's. Its result comes back later as the agent's own work
    (below), and its session stays in use meanwhile (Sessions, under State).
- **The agent's own work**: updates that come while no turn of the
  sidebar's is open show in the chat as they come, as a turn's do. Claude
  Code sends them when a call it moved to the background ends: its
  notification starts a cycle of Claude Code's own, which claude-agent-acp
  streams with no prompt open. Meanwhile the chat counts as working
  (`conv.ownWork`: running steps, the directory, zenius's strip), until the
  `usage_update` claude-agent-acp sends with Claude Code's result ends the
  cycle. Without one, it ends after 2 minutes with no update and no call of
  it running, at most 11. The user's next message takes it over as its
  turn. Not while a session opens (a load replays its history as updates),
  nor after the user's Stop.
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
  zenius's strip reads "Watching <task> [⌃Tab]", or, where the strip can't
  be read (a collapsed sidebar, compact mode), a small chip in the page
  area's top left corner says the same, never over the page's top middle
  and cut past 280 px or 40 % of the page area. Every click on it reaches
  the page under it. ⌃Tab returns to the Space and tab the user watched
  from: while watching, the card shows "⌃Tab back to your tabs" where Watch was,
  since ⌃Tab is the way back, and keeps Take over.
  ⌃Tab does that only while watching; elsewhere it stays Zen's. Picking a
  tab outside the task, or another Space, ends the watch where the user
  went. Take over is zenius's (as its tasks panel does it), then a watch:
  the agent waits until the user presses zenius's Resume agent.
  - **A send can be that press.** While the user holds the task by Take
    over and this window shows one of its pages, on a site the task had at
    the Take over (`ZeniusUI.sendHandBack`), a line over the box says
    "Sending gives <site> back to <agent>. Password, card and code fields
    there are cleared, so submit what you type first." It offers Keep
    control, which lasts for this hold (`AgentService.setKeepControl`).
  - The user's own Enter, Send or Steer on a message that goes now then
    runs Resume agent's path (`handBackBySend`). The message goes once that
    is done, with a note that tells the agent which page the user watches
    (`handBackNote`), and the chat says what was given back. While the
    agent's turn runs, Enter queues the message, so the line says that
    Steer gives the task back now and Enter gives nothing back. A press
    during a hand back waits for it, so the first message goes first, with
    the note.
  - Elsewhere the line says that only Resume agent on the page's card
    gives the task back. A queued message, the glue's `submit`, a remote
    task's send, an agent's hand-off and a permission hold give nothing
    back.
  - **The agent's hand-off** is a card in the ask card's look, before the
    live card (`#handoff`, `renderHandOff`, `AgentService.handOff`), while
    the task is the user's by the agent's hand_off. It shows:
    - what the task waits for, in zenius's strip's words ("Trip planner
      needs a sign-in", `waitText`);
    - the agent's whole message, as its words: the task's own
      (`stateText`, which a hand-off made in a script sets too), else the
      hand_off call's;
    - what Resume agent clears first, in zenius's tasks panel's words;
    - Show tab (zenius's `goToTask`, the task's page) and Resume agent
      (zenius's own path, `ZeniusUI.handBackByUser`).

    It follows the task's state, not the agent's wait call, so it stays
    until Resume agent or the task's end, whatever becomes of that call: a
    harness may end it early for the user's message, or move it to the
    background. A page's permission prompt holds the task too, but shows
    no card: answering the prompt ends that hold.

  While zenius reports a Take over refused ("Can't take over this page"),
  the card hides Take over: zenius's card on the page holds the choices,
  with Try again only where it can work. A task's tab in the directory
  starts a watch on that tab.

## Files

| Path (`runtime/JS/`) | What |
|---|---|
| `agent-sidebar.uc.js` | Each window: the panel, ⌘⇧A, which chat the panel shows (Chat or Work), the directory, reading the tab |
| `agent-sidebar/AgentService.sys.mjs` | Shared: the agents (ACP), conversations, tasks and their state, the tasks file, the zenius link, steps |
| `agent-sidebar/AgentSidebar.sys.mjs` | The entry points other scripts import |
| `agent-sidebar/builtin.sys.mjs` | The built-in agents, when there's no config.json (zen-ux's) |
| `agent-sidebar/panel.{html,js,css}` | The panel, in the sidebar's own document |
| `agent-sidebar/directory.{sys.mjs,css}` | The directory drawer, in browser.xhtml |
| `agent-sidebar/taskmenu.sys.mjs` | What a task's menus offer and say: the ⋯ menu's and All tasks' row menu's (zen-ux's) |
| `agent-sidebar/pins.sys.mjs` | Pinned's cap, and the pins and sidebar names of the tasks other programs drive (zen-ux's) |
| `agent-sidebar/selfcheck.sys.mjs` | The post-install self-check's scenarios, in zen-core's window: `prepare`, `run`, `cleanup` (below) |
| `agent-sidebar/sidebarview.sys.mjs` | The panel and All tasks as a script reads and drives them, for the self-check's scenarios and `tests/ux` (zen-ux's) |
| `agent-sidebar/AgentSidebarPicture{Parent,Child}.sys.mjs` | The live card's pictures, painted in the agent page's own process |
| `agent-sidebar/AgentSidebar{Parent,Child}.sys.mjs` | The JSWindowActor that reads a tab's selection and text |
| `agent-sidebar/attachments.mjs`, `saving.mjs` | Attached files; copying and saving answers |
| `agent-sidebar/feedback.mjs` | The problem report card: a report from `zenius feedback` or a Work task's `report_problem`, sent, copied, left for the agent or discarded only on the user's click (below) |
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

`window.ucAgentSidebar`, in each browser window but a popup (a window whose
toolbar isn't visible, such as a site's sign-in window, has no sidebar):

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
| `openChatOfSpace(space, source)` | The sidebar open on the Work chat that drives zenius task `space` (`AgentService.chatOfSpace`), as zenius's tasks panel's Open, its tab names and a notification's click do; resolves to whether it shows one. A task no Work chat drives opens nothing |
| `watching` | The uid of the task this window watches, else null, whoever began the watch: the card, the directory, zenius's tasks panel or a notification |
| `currentTask` | The task Work mode shows |
| `conversationFor(tab)`, `submit(conv, { question, selection, attachments })` | A tab's chat, and asking in it (zen-eval's dispatch tests) |
| `keepsChats`, `earlierChat()`, `earlierChats(query)`, `openEarlierChat(uid)` | Whether the window keeps chats (not a private window); the earlier chat the selected tab's empty chat offers back, `{uid, at, question, page}` or null; All tasks' matches for a search; bring one back, returning whether a tab shows it now |
| `panel.show(conv)`, `panel.compose(conv, { selection })` | The open panel |
| `AgentService` | `tasks` (uid → conversation), `taskList()`, `needsCount()`, `preferredHarness()` (the user's last pick in the sidebar, then config.json's default when it may run, then Claude Code), `setHarness(conv, id, { pick })` (`pick: false` for a switch zenius makes, which isn't kept as the user's pick) |

`AgentService.isHeld(conv)` says `"takeover"`, `"handoff"` or false: who
started a hold is the `source` of zenius's spaceChanged, kept in the task's
`zen.heldBy`, since zenius gives a hand-off without a reason Ego's default,
`manual_takeover`.

## The self-check's scenarios

`selfcheck.sys.mjs` is zen-sidebar's half of the post-install self-check.
zen-core's runner (`runtime/JS/zenius/modules/selfcheck.sys.mjs`) has the
rest: the socket that `zenius selfcheck` calls, and the run's window. The
runner opens a window that isn't a browser window, so none of the three
`.uc.js` scripts load there, and hands it over:

- `prepare(win)` fills its `#zenius-selfcheck-host` with the panel (a
  chrome `<browser>` on `panel.html`, in a `#sidebar-box` 420 px wide, or
  narrower down to 300 px in a narrow window) and room beside it for All
  tasks' drawer, and gives the window a glue of its own
  (`win.ucAgentSidebar`, with `scope`). It adds one earlier task, done, so
  Archive has a task to move on to, and resolves with the run's scope once
  the panel shows. The panel takes the window's width less 280 px for the
  drawer, between 300 and 420 px: in zen-core's 720 x 760 window it has
  its full 420, and a 480 px window still works, with a 300 px panel.
- `run(win, {shot, checked, signal})` goes through the post-install checks in
  order, `menu` ("The ⋯ menu"), `archive` ("Archive, Archived and
  Unarchive") and `follow` ("Sending follows the answer"), and resolves to
  `{checks: [{id, title, ok, failedStep, error}]}`. Each step checks
  `signal` before it acts and ends with `shot("<check>/<step>", rect)`, the
  rect in the window's CSS pixels. A failing step fails its check (its
  `failedStep` is the step's name), and the next check still runs from a
  clean start. `checked()` hears each check as it ends.
  - `menu`: `new-task` (All tasks' `+ New task`, a question, its answer),
    `work`, `chat`.
  - `archive`: `tooltip`, `archived`, `group`, `row`, `opened`,
    `unarchived`.
  - `follow`: `answered` (More's New, 50 numbered lines), `sent` (from the
    first lines, the next message takes the chat to its end), `following`,
    `scrolled-up` (the view stays while the answer goes on), `ended`.
- `cleanup()` ends the run's tasks and agent and the window's glue, through
  `AgentService.closeScope`, never `removeTask`. It's safe to call again.

A check reads and drives the panel and All tasks through
`sidebarview.sys.mjs`'s `sidebarView(win)`, which `tests/ux` reads them by
too, so both go by one set of the sidebar's ids and classes.

What keeps the user's sidebar out of it is the scope
(`AgentService.openScope`). A scope's tasks are in `scope.tasks`, never in
`AgentService.tasks`, so they're never saved, never in `sidebar.status` or
`list`, never in zenius's waiting rows, and never listed in another window:
`taskList`, `directoryList`, `archivedTasks`, `taskByUid`, `needsCount`,
`subscribeTasks` and `harnessList` take the scope of the window they list
for (`glue.scope`, null in a browser window). Its conversations
(`conv.scope`) run the scope's agent, `SELF_CHECK_HARNESS`, an ACP
connection in this process with no tools, no permission requests and no
network, which is in no picker. `setHarness`, `pickModel`, `setOption` and
the options cache skip them, so a run writes no pref, file or draft of the
user's. Its answers are fixed by the question, and `holdAt(n)` pauses a
numbered answer after line n, so a check can scroll while it writes. No
synthetic chat is kept (`agent-sidebar-chats.json`), and none gets a zenius
task or a remote record.

Once a scope has ended, it fails closed. `createConversation` (and so
`createTask`) throws "the self-check has ended" for it, so a late show or
new task from its window's glue makes nothing. A panel whose window has no
glue, as after cleanup, stops as it loads, before it lists or subscribes
to anything: without `glue.scope` it would show the user's own tasks. A
scoped task's error never carries the user's agent's last exit.

## The problem report card

`feedback.mjs`, in every browser window's panel, never in the self-check's.
An agent's `zenius feedback "<one line>"`, or a Work task's call to
zenius's MCP tool `report_problem`, has the runtime compose a problem
report for zenius's GitHub issues and propose it (`feedback.compose` and
`feedback.propose`, PROTOCOL.md). The card shows it above the chat, in
either mode:

- **Who wrote it.** The card's first line names the task whose agent wrote
  the report, by the agent's name and the task's name as the sidebar shows
  them, when the report's source names one of the sidebar's Work chats
  (`AgentService.feedbackAuthor`). That source is `feedback.compose`'s
  `source.sidebar`, the task's uid, which the task's zenius server sends.
  Any other report, from `zenius feedback` or with an unknown uid, says "An
  agent wrote this." The source is the caller's claim: any local caller
  that knows such a task's uid could send it.

- **The text, as it would be posted.** The title and the body are both
  editable. The title is one line, wrapped to the card's width so all of
  it shows (Enter adds no line, and a pasted line break becomes a space).
  The body is the report's Markdown, as text.
- **With gh found: Send, Not yet and Discard.** Send first looks for an
  open issue with the same title. If there is one, the card asks once more:
  Add a comment to #N (the body only: the issue keeps its title), or Post a
  new issue. Then it says "Posted as #N", with Open #N.
- **Without gh, with gh not signed in, or after gh failed: Copy and open
  GitHub.** The runtime puts the body on the clipboard and opens GitHub's
  new issue form with only the title in its address, and the user pastes
  the body there.
- **Not yet** leaves the report for the agent to revise: nothing is sent,
  and the card goes. Its tooltip says so: "Not yet: nothing is sent. Keep
  refining it: tell the agent what to change, and its new version shows
  here." The agent hears `deferred`, and its new version is a new report,
  which shows as a new card at once.
- **Discard** drops the report and holds new ones off for a while, 10
  minutes (the runtime's cooldown), which its tooltip says: "Discard. No
  new reports for 10 min." The card then shrinks to one line, "Discarded.
  No new reports for 10 min.", with Undo, until the cooldown ends. Its
  minutes count down, and a screen reader hears the line once, not each
  minute. A report the cooldown keeps out changes the line to "Discarded.
  A new report couldn't show; reports open again in 7 min." Undo brings the
  discarded report back, with what the user had typed into it in that
  window, and ends the cooldown.

The agent hears only the outcome, and for a post or a comment the issue's
number and address: never the text the user sent, nor gh's messages.

Nothing goes out before the user's own click, and only the user can click:

- The card is chrome, in the panel's own document. zenius's methods act
  only in web pages (SPEC I5), and pages can't reach chrome.
- Its buttons act only on a trusted click inside the card. They arm 400 ms
  after they appear, and again when the window comes to the front or the
  panel shows again, so a click meant for something else doesn't land on
  Send, and a double click on Discard doesn't land on Undo. A new version
  of a report after Not yet is a new card, armed the same way.
- Undo is the line's own button: no method reaches it, so an agent can't
  bring a report back or end a cooldown. A refusal noticed while the line
  shows changes its words, not its Undo, so an agent that keeps proposing
  can't keep Undo from arming.
- The card takes no focus, and nothing opens the sidebar for it: the agent
  tells the user where the report waits.
- A report the card couldn't show exactly as it would be posted never
  shows: one with a control, format (bidi, zero-width) or line-separator
  character, a title of more than one line, or text past GitHub's limits
  (256 characters for a title, 65,536 for a body).
- One report waits at a time, and its text never changes under its id.

How the card and the runtime meet:

- The runtime notifies the observer topic `zenius-feedback` with `asked`
  once a report waits (proposed, or brought back by Undo), `settled` once
  it's posted, copied, left for the agent or discarded, `declined` when the
  cooldown keeps a report out, and `reopened` when the cooldown ends.
  `AgentService.init` observes it, which loads nothing of zenius's at the
  sidebar's start. With no observer, `feedback.propose`
  fails at once (`ZEN_UNSUPPORTED`, `data.reason: "no_sidebar"`), and the
  CLI writes the report to a draft file instead.
- On each notice, and as a panel opens, `AgentService.feedbackSync()` reads
  `service.feedback.pending()`, `{id, title, body, canPost, repo,
  cooldownMs, source?}` or null, through `feedbackOf`, which keeps of the
  source only a well-formed `sidebar` uid, and `service.feedback.cooldown()`,
  `{until, discarded, refused}` or null, through `feedbackCooldownOf`. It
  tells the panels when either changed (`subscribeFeedback`). The line comes
  from the cooldown, so every window's sidebar shows it, one opened later
  too, and it goes when the cooldown's time is up.
- The card's clicks go through `AgentService.feedbackAction(action, id,
  ...)` to `service.feedback`'s `send`, `postNew`, `comment`, `copyAndOpen`,
  `defer` (Not yet), `discard` and `undo` (with the cooldown's `discarded`
  id). A second action while one runs answers `{busy: true}`: in
  two windows, the first click wins, and the other card says the report is
  being sent from another window. Each window's card keeps its own edits,
  and every card goes once the report settles, but for the one whose click
  settled it, which shows the result until Close. A newer report waits
  behind that result and shows at Close: shown at once, it would put Send
  where the user just clicked.

## Stable hooks

The panel (`panel.html`, its own document, so bare ids):

| Hook | What |
|---|---|
| `html[data-mode="chat"\|"work"]` | The mode |
| `#header`: `#dir`, `#favicon`, `#title`, `#more`, `#menu` | `#dir` (Work only; `aria-expanded` while the directory is open) or `#favicon` (Chat only), the title, the ⋯ menu. `#menu`: `#new-chat` (Chat) or `#new-task` (Work), "New"; `#rename-task`, "Rename"; `#archive-task`, "Archive", or "Unarchive" on an archived task; `#close`, "Close" with `.kbd[data-shortcut]`, the sidebar's key as the window bound it (`uc.agent-sidebar.shortcut`; ⌘⇧A on the Mac, Ctrl+Shift+A on Linux and Windows by default), as the empty chat's `kbd[data-shortcut]` says it. In Work, `#rename-task`, or a double-click on `#title`, puts an `input` (`aria-label` "Task name", the task's own title as its placeholder) in `#title` until Enter, Esc or a click outside |
| `#handback`: `#handback-text`, `#handback-keep` | Over the box while the user holds the task by Take over: whether a send gives it back, and Keep control (`aria-pressed`); `#input` is described by the text |
| `#box`: `#input`, `#bar` | The question box: the text, and its bottom row |
| `#bar` > `#bar-start`, `#bar-end` | The row's two groups: `#attach` and `#switch`; then `#pickers`, `#stop` and `#send`. One row when both fit at their natural widths; otherwise `#bar-end` wraps whole to a second row, at the right, under `#bar-start`, and shrinks the pickers (an ellipsis) rather than run past `#box`. Nothing is hidden. In a box under 170 px the first group tightens, so it keeps one row with the count |
| `#attach`, `#switch` > `#to-chat`, `#to-work` | '+' and the switch; the shown mode's button has `aria-pressed="true"` |
| `#needs` | Inside `#to-work`: the tasks that need the user, hidden at 0; its orange is `var(--needs-color)` |
| `#pickers` > `#pick` > `#pick-model`, `#pick-effort` | The chat's model and its effort ("Opus 5.5 Low", the effort in gray), one button (`aria-expanded` while the picker is open). It opens `#picker`, while the agent answers too: a pick then, of a model or an effort, shows here and is saved at once, with no note, and the running turn keeps its model, as a steer into it does. The session gets the pick when the turn ends, however it ends, before anything queued goes out, so the next answer runs with it (`AgentService.pickModel`, `modelToSession`; claude-agent-acp 0.107.0 would switch the running turn's model, codex-acp 2.6.0 keeps it for its next turn). One the agent refuses then says "Could not change the model", and the label goes back to the session's. There is no `#harness` |
| `#picker` > `#pick-search`, `#pick-fam`, `#pick-list` | The model picker, an opaque card over the chat that opens upward from the composer. `#pick-search` (role `combobox`) keeps the focus and filters the open family; its `aria-activedescendant` is the active row or effort. `#pick-fam` (role `tablist`) has a `button[role=tab][data-harness]` per family: Claude (Claude Code's models), then GPT (Codex's), then other agents by name. It holds every agent that may run here (`AgentService.harnessAvailable(id)`) and the chat's own. It's hidden while only one family is left, as when the user sets `zenius.agentSidebar.allowCodex` to false. A task keeps its agent, so there the other families are disabled. So they are while the agent answers: another family's model starts a new chat, which would take the answer with it, so its tab says it waits for the answer to end |
| `#pick-list` > `.pick-row[data-value][data-effort]` | The open family's models, role `option`, of the newest generation only: the major version in each name, read from the agent's own list, so a new generation replaces the old by itself. Claude Code's "Default (recommended)" isn't one, since it names no model. A chat on it shows, and checks, the model the agent names for it (the entry's description, "Opus 5.5"), and where the agent names none it runs on the newest generation's first model, the one shown in its place (`concreteModel`, `applyPreferredOptions`). Models without a version come first, then a `.pick-rule`. Each row shows the effort its model runs with: `AgentService.effortFor`, each model's own, in `uc.agent-sidebar.<harness>.efforts`. `aria-selected="true"` and a ✓ mark the chat's model; `.active` is the row the keys or the pointer are on. A click picks the model with its own effort |
| `#pick-fly` > `.pick-eff[data-value]` | The efforts the agent offers, in a flyout beside the active row, role `listbox`. It opens when the pointer rests on a row or on → (← closes it). A click, or Enter, picks the row's model with that effort, which becomes the model's own. Esc closes the flyout, then the picker, with the focus back in `#input` |
| `#stop`, `#send` | One shows at a time |
| `#earlier` > `#earlier-text`, `#earlier-open` | In the empty Chat view, first: an earlier chat about this page, "Earlier chat about this page, 2 days ago", and Open; `title` is the chat's first question. Hidden when there's none |
| `.steps > .step[data-status] > .label` | Steps; `data-status` is `done`, `running`, `failed`, `waiting` (for the user) or `stopped` |
| `.msg.user.editing` > `.editor` > `textarea`, `#edit-loss.edit-loss`, `.buttons` > `.cancel`, `.send` | A message being edited (Editing a message): its box, the line saying what else the agent forgets (only when it does; the box's `aria-describedby`), Cancel and Send |
| `#handoff[role=group]` > `#handoff-title`, `#handoff-words`, `#handoff-clears`, `#handoff-show`, `#handoff-resume` | The agent's hand-off while the task is the user's, before the live card, in the ask card's look (`.msg.ask`): what the task waits for ("<task> needs a sign-in"), the agent's whole message, what Resume agent clears (hidden when nothing), Show tab and Resume agent |
| `.msg.thought` (`.live`) > `summary` or `.line` > `.head`, `.time`; `details > .body` | A stretch of the agent's thinking: "Thinking for 12 s, <title>" while `.live`, then "Thought for 23 s". `.head` clamps to two lines, and the line's `title` is the whole title. With words, a `details` whose `.body` is what it thought. After a step, it's inside `.steps` |
| `.msg.assistant > .actions` | Copy and save: one row per turn, on its last part, once the turn has ended |
| `html[data-external="true"]`, `.ext-view[data-state]` | A task the sidebar doesn't drive (`external.sys.mjs`: every zenius task shows in the sidebar), opened: read-only, so the question box shows only `#ext-bar`. `data-state` is the task's `working`, `needs` or `done` |
| `#ext-src` (`.addr`) | Where it's driven from: `Read-only, driven from <agent> on <terminal>`, the terminal a chip, or `Read-only, driven from <agent> in <folder>` without one |
| `#ext-steps > .ext-step[data-step][data-outcome]` > `.ext-text` (`.ext-name`), `.ext-page`, `.ext-outcome`, `.ext-time` | Its steps from the runtime's record, in the box and with the marks of the sidebar's own `.steps`. `data-outcome` is `ok`, `running` or `failed`. A running step shows the needs dot while the task needs the user, and `–` once it ended. Each quoted name is an isolate (`.ext-name`, `dir="auto"`). `.ext-page` names the step's page once the task has more than one; `data-same-page="true"` hides it where it repeats the step before. A failed step's code (`.ext-outcome`) sits under its words. With no steps, `.ext-empty` says "No steps yet" |
| `.ext-needs` > `.ext-needs-title`, `.ext-needs-text`, Watch | The agent's hand-off while the task needs the user, in the directory's Needs you tint (`--needs-bg`): "Needs you", its words, and Watch |
| `html[data-archived="true"]`, `#archived-bar` > `#archived-text`, `#unarchive` | An archived task, opened (`AgentService.archiveTask`): read-only, with no box, `#queue` or Edit. The bar says "Archived" (its tooltip "Archived <age> ago"), with Unarchive, in the question's place, for own and external tasks alike (`#ext-bar` gives way to it) |
| `#ext-bar[data-ended]` > `#ext-bar-text`, `#ext-stop` | In the question's place: "The sidebar can't chat with this agent" and Stop task while it runs; once it ended, how (`Finished`, `Stopped by you` or `Closed`, then its age), with `data-ended` `finished` (a ✓) or `stopped`/`closed` (a –) |
| `#live[data-live="true"\|"false"][data-watching="true"\|"false"][data-drawn][data-every]` | The live card, the thread's last child, hidden until the task has a tab. `data-live` is true while the agent works on the page (the red dot); `data-watching` is true while this window watches the card's task; `data-drawn` counts the pictures drawn, and stays put while the card can't be seen; `data-every` is the wait for the next picture in ms, or `kept` after a very slow one. A test counts pictures by `data-drawn`: the card doesn't call drawSnapshot |
| `#live-shot`, `#live-text` | Its picture (a canvas) and its line: `Live on <host>`, `Waiting for you on <host>` (a hand-off), `You have control on <host>` (a Take over), or the host |
| `#live-src` | A remote task's source over the card's line: `From <label> on <address>` (`From <address>` without a label) (`AgentService.remoteSource(conv)`, from `conv.remote`, each part a first-strong isolate); hidden for any other task. A remote question (`message.source === "remote"`) has the same line as its `.src`, where a '>' question says "from the address bar". On the card the line heads the card's foot, and in each place the address is a chip (`.addr`, panel.js's `fillSource`; the text is unchanged) |
| `#remote-end` | Under a remote task's last answer, once it stopped, why (`AgentService.remoteEnd(conv)`, from zen-observe's `conv.remote.final.stopReason`): "Stopped by <address>" (its caller's `sidebar.stop`, the address isolated), "Stopped at its time limit", "Stopped when remote tasks were turned off", "Stopped when Zen quit", or "Stopped" (the user's Stop). The task's state text says the same, on its directory row and in the title's tooltip. Hidden while it runs, when it failed (its error says why), and once the user takes a turn there themselves: an edit of the caller's question is the user's own (no `.src` line), and makes the chat theirs |
| `#arrival[role=group]`, `#arrival-text`, `#arrival-watch`, `#arrival-stop`, `#arrival-close` | A remote task's arrival, over the composer, when one starts while the panel is open in the front window: "Task from <label> on <address>" (also the group's `aria-label`), with Watch (the task's page if it has one yet, else the task here), Stop (`AgentService.cancel`, as the panel's Stop) and ✕. It takes no focus and moves nothing (I1), and goes after 10 s (`uc.agent-sidebar.arrival-ms`, for tests), though not from under the pointer or the focus. With the sidebar closed, zenius shows the same card over its strip (`#zenius-arrival`, `ZeniusUI.remoteArrival`). Its look: lined up with the question box, Working's purple dot, the text (two lines at most, the address a chip) and ✕ on top, Watch and Stop under them on the right, as the live card's buttons; it slides up as it comes (none with reduced motion) |
| `#watch`, `#watch-hint`, `#take-over` | Watch, hidden while this window watches the task; in its place then, the hint "⌃Tab back to your tabs" ("Ctrl+Tab" off the Mac), not a button; Take over, shown while the agent has the page, except while zenius reports a Take over refused |
| `#feedback` (`aria-label` "Problem report") | The problem report card, between `#header` and `#messages`; hidden while no report waits. While it shows, the empty chat's `#empty` gives way |
| `#feedback` > `#fb-lead`, `#fb-issue-title`, `#fb-issue-body`, `#fb-status`, `#fb-actions` | Where the report would go and what Send or Copy does; the title (a `textarea` kept to one line) and the body, both editable while the report waits for the user and hidden once it's posted or copied; the state's line, `.error` after a failure; the buttons |
| `#feedback.fb-one-line` > `#fb-line`, `#fb-actions` | After a Discard, until its cooldown ends: the one line, its minutes counting down, and Undo. `#fb-status` is then only for a screen reader, which it tells the line once |
| `#fb-actions > button[data-action]` | `send` ("Send"), `copy` ("Copy and open GitHub"), `discard`, `comment` ("Add a comment to #N"), `postNew` ("Post a new issue"), `retry` ("Try again"), `open` ("Open #N") and `close`; `.primary` on the one in the accent color. Each is `disabled` until it arms |

The directory (in browser.xhtml, so prefixed):

| Hook | What |
|---|---|
| `#zenius-sidebar-directory` | Its layer; hidden while closed |
| `.asb-dir`, `.open`, `data-side="left"\|"right"` | The drawer; the side it comes out on |
| `.asb-dir-group[data-group="pinned"\|"needs"\|"working"\|"done"]` | Group headings; Pinned's rows have `data-pinned="true"` |
| `button.asb-dir-group.asb-dir-archived[data-group="archived"][aria-expanded]` > `.asb-dir-chevron`, `.asb-dir-label`, `.asb-dir-count` | Archived's heading, last: it opens and closes the group, collapsed by default, with its count; disabled while a search shows its matches. Its rows have `data-archived="true"` |
| `.asb-dir-row[data-task="<uid>"][data-state]` | A task; `data-current="true"` on the one the panel shows, whose tabs are `.asb-dir-tab` |
| `.asb-dir-group[data-group="chats"]`, `.asb-dir-row[data-chat="<uid>"][data-state="chat"]` | "Earlier chats", only while the search has a query, before Archived: an earlier chat's row, with no menu |
| `.asb-dir-src` | In a remote task's row, under its name: the same `From <label> on <address>`, its address a chip (`.asb-dir-addr`), also the second line of the row's tooltip. The search matches the address and the label |
| `.asb-dir-tab` | One of the current task's tabs; a click watches the task on it |
| `#zenius-sidebar-directory-menu` > `#zenius-sidebar-directory-pin`, `-rename`, `menuseparator`, `-archive` | A row's menu: `label` Pin or Unpin, Rename, Archive or Unarchive, each with its `tooltiptext`; Pin `disabled="true"` once Pinned is full |
| `input.asb-dir-rename` | The row's name while Rename edits it (`aria-label` "Task name", the task's own title as its placeholder) |
| `var(--asb-needs-color)` | Its orange |

The window while watching (browser.xhtml):

| Hook | What |
|---|---|
| `#main-window[data-zenius-watching="<uid>"]` | The task the window watches, when a chat follows it |
| `#zenius-agents-strip[watching]` | zenius's strip while the window watches: "Watching <task> [⌃Tab]", the key a keycap (`<kbd>`), the name in `.zenius-strip-name`. Once the watched task ended there, `[watching="done"]`: "Task done, [⌃Tab] back to your tabs", with "back to your tabs" in `.zenius-strip-rest`, until the user presses ⌃Tab or picks another tab or Space. A hint: a click opens the tasks panel |
| `#zenius-agents-strip[named]` | zenius's strip while one task waits: "<task> needs a sign-in", the name in `.zenius-strip-who`, then what it waits for in `.zenius-strip-what`, whole or `hidden`: where the line doesn't fit, "needs you", then the name alone |
| `#zenius-strip-all` | All agent tasks, at the strip's end in `#zenius-strip-row`, shown while the strip's click goes to the one waiting task |
| `#zenius-watch-pill` | zenius's chip, in the page area's top left corner, only while the window watches and the strip can't be read (a collapsed sidebar, compact mode): "Watching <task> [⌃Tab]", or once the task ended there, `[done]`: "Task done, [⌃Tab] back to your tabs", with "back to your tabs" in `.zenius-watch-rest`. Every click passes through it to the page |
| ⌃Tab | Goes back while watching (stopped before Zen's tab box and ctrlTab see it); Zen's otherwise. Only trusted key events count. Tests send it through nsITextInputProcessor |

The address bar: both rows are `.urlbarView-row[dynamicType="zeniusAskAgent"]`,
from providers `ZeniusAskAgent` (the '>' first row) and
`ZeniusAskAgentSuggest` (second, on other input). Find them by these, never
by the icon, which may change. A test types '>' (the input field's
value, then an `input` event): `gURLBar.search("> …")` reads '>' as
Firefox's Actions restrict token and shows no row.

## Doctor

- `agent-sidebar.uc.js` carries the line `// zenius: agent-sidebar` in its
  `==UserScript==` header, within its first 20 lines.
- Each window's start ends by setting
  `window.zeniusSidebarStart = Object.freeze({ error })`, where `error` is
  the start's exception message, or null. zen-ux's `ui.sidebarStatus` reads
  it in each open window, for zen-sdk's doctor. A property, so the sidebar's
  start loads no zenius module (I4). A start that throws undoes what it did
  before the throw. A popup has no start, so no `zeniusSidebarStart`, and
  the status lists it as skipped.
- The sidebar panel's title is "Agent".

## State

- `agent-sidebar-tasks.json` in the profile: the tasks, read once at startup
  and written 1 s after a listed task changes and at a clean quit.
  `{ version: 1, tasks: [...], removed: [...], archived: [...], pinned:
  [...], labels: [...] }`, oldest first; a task the user archived has
  `archivedAt`, and one they pinned `pinnedAt`. `removed` holds the
  last day's removed tasks (`{uid, space, at}`), whose zenius tasks the
  directory leaves out, and `archived` the last day's archived tasks of
  other programs (`{space, at}`). `pinned` and `labels` hold the pins and
  the sidebar's names of other programs' tasks, by id and start
  (`{space, createdAt, at}`, `{space, createdAt, label}`), the newest 100.
  They are new at version 1: a file from before them loads as it was, and
  an older runtime reads the rest. A task saved while busy
  comes back as Needs you. It keeps no attached file's contents and no tool
  input or result, only what each step shows.
- `agent-sidebar-chats.json` in the profile: each tab's Chat conversation,
  kept so that a restart, an update's included, loses none.
  `{ version: 1, chats: [...] }`, the
  newest first, each with its `uid`, agent, `createdAt`, `activeAt` (its
  last message), the page it was last asked about, its agent's session and
  its messages. Read once at startup, written 1 s after a chat's message
  comes or its turn ends, and at a clean quit.
  - It keeps what the panel shows, as the tasks file does, with attached
    files by their names alone: no thumbnail, no file's contents, no tool
    input or result, an ask's answer only as its card shows it (a code
    masked), and never the page text the agent was sent.
  - The tab keeps the chat's `uid`, an opaque random id and nothing else,
    as the SessionStore value `zenius-chat`, set once the chat has a
    message. So the chat comes back with its tab after a restart or an
    update, and after Undo Close Tab. A duplicated tab, whose value names
    a chat another tab shows, gets a copy of the thread under an id of its
    own, so the two never write over each other.
  - A chat back from the file goes on in its agent's own session, resumed
    by its id. Where the agent can't resume it, and in a copy, the next
    question starts a new session with the thread as the panel shows it as
    its context (`<earlier_chat>`), each line of an earlier answer or
    selection quoted (`> `, after any other line break, `\r`, NEL or U+2028
    for example, becomes `\n`) and any `</earlier_chat` in the thread
    broken, so that a page an
    answer repeated can't plant a user's turn or the block's end. Chat's
    list of URLs a session may fetch then holds only the new question's
    sources, never one only in the old thread: an earlier answer may carry
    a link a page planted.
  - Closing a tab ends its chat's session, as before, and its thread stays
    saved. New chat, or another agent, starts a new chat, and the old
    thread stays saved too.
  - A private window's chats are never saved, its tabs get no value, and
    no saved chat comes into a private window.
  - The prune (`keptChats`): a chat unused for 30 days goes, unless a tab
    shows it now; then, those that tabs show first and the rest newest
    first, at most 100 chats, each kept while it fits in 2 MB with those
    before it. One that doesn't fit is left out and older ones still count,
    so a chat over 2 MB on its own never empties the file. A chat a tab
    shows keeps its list of URLs, in the file or not. At the start too.
  - Clearing history clears them, with their lists of URLs: Clear Recent
    History of everything takes every chat, a time range the chats with a
    message in it, and Forget About This Site the chats with a question
    about a page on that site or under it; a tab showing one is left with
    an empty chat. That holds as Zen quits too, and while Zen clears
    history as it closes, a file found at the start is dropped, as one a
    crash left. It leaves the agents' own transcripts, under `~/.claude`
    and `~/.codex`: they're Claude Code's and Codex's, which resuming a
    session needs.
  - A file of another version is left unread, and the next save writes
    over it, as with the tasks file.
  - An earlier chat is a saved one no tab shows, offered back in two places.
    A page matches it by its origin and path, a web page only: the query and
    the fragment don't count.
    - The way back: the empty Chat view's first line offers the newest
      earlier chat about the tab's page, "Earlier chat about this page, 2
      days ago" (`ago`), then Open, with the chat's first question as its
      tooltip. Open brings it back on the tab, as a restored tab's chat
      comes back, and the tab keeps its id. Only in Chat mode, on an empty
      chat, and the panel never opens for it.
    - All tasks' search: while it has a query, a group "Earlier chats"
      after the tasks' groups and before Archived, newest first, by the
      chats' questions, answers, and their pages' titles and addresses. A
      page's address is its origin and path, with no query or fragment
      (which may hold a token), and a file: page's file name alone
      (`pageAddress`): the search reads that, and the row and its tooltip
      show it. A row shows the first question, its newest question's page
      title (else its address), the age, and a gray dot where a task shows
      its state. A click or Enter brings the chat back in place when the
      selected tab is on a page it asked about and its chat is empty, else
      on a new tab on its newest question's web page. A tab that keeps
      another chat by its value isn't empty.
    - Neither shows in a private window or in the self-check window, nor
      offers a chat a tab shows or keeps: a tab restored at the start and
      not shown since keeps its chat by its value.
    - Clearing history takes both off the screen at once: AgentService
      tells each window (`subscribeChats`), which renders the line and the
      search again.
- Prefs: `uc.agent-sidebar.config` (the config's path; tests point it at
  their own; `"none"` for no agents, as in every dev profile; `"builtin"`
  for the built-in agents alone, the tests'), `uc.agent-sidebar.harness`
  (the agent the user picked),
  `uc.agent-sidebar.shortcut`, `uc.agent-sidebar.max-page-chars`,
  `uc.agent-sidebar.default-question` (what a selection or files sent with
  nothing typed ask; unset or empty, "Explain this.", or the same question
  in Chinese when Zen's UI is in Chinese),
  `uc.agent-sidebar.debug`, `uc.agent-sidebar.width` (the panel's width as
  the user last dragged it, in px; 420 until then; the box takes it as the
  browser shows the panel, before its first paint, with the panel's look),
  `uc.agent-sidebar.idle-minutes` and `uc.agent-sidebar.open-sessions`
  (Sessions, below).
- **Sessions**: an agent's process stops once no session in it has been
  used for `uc.agent-sidebar.idle-minutes` (10; 0 never), and at most
  `uc.agent-sidebar.open-sessions` (2) sessions per agent stay open: the
  least recently used close (`park`). A closed session resumes with its
  next question.
  - Neither ever closes a session in use (`inUse`): while its turn runs or
    it opens, while its agent works on its own (above), and for up to 11
    minutes after Claude Code moved one of its calls to the background,
    until that call's result comes. Closing it then would cut what the
    agent does, and Claude Code reports the cut call as the session's end.
  - So a chat that opens while the others are in use opens over the limit,
    never closing a busy one. The sweep (every 30 s) closes the extra
    sessions as soon as they're not in use, least recently used first,
    and no more: the limit keeps no session open for any other reason.
- The agents come from `config.json`, by default
  `~/Library/Application Support/zenius-agent-sidebar/config.json`, in the
  sidebar's own folder, which it only reads.
- Without that file (no other way of failing counts), and only while
  `uc.agent-sidebar.config` is unset, the sidebar offers its built-in
  agents (`builtin.sys.mjs`), built in memory at each `loadConfig`: the
  user's own Claude Code and Codex, through the ACP adapters that zenius's
  installer puts in `~/.zenius/agents`. A path the pref names never falls
  back to them, so a test's or a dev Zen's scratch path can't run the
  user's own Claude Code with their sign-in: a missing one fails as before.
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

Decided in SPEC §8, and built on the process side by zen-observe. Nothing
goes into `~/.claude` or `~/.codex`, and the user's config.json is only
read.

- The workspace is `<profile>/agent-sidebar-workspace/`, with one folder for
  each adapter, `claude/` and `codex/`, so Codex's sandboxed writes can't
  reach Claude Code's settings. Each session runs in its adapter's folder,
  whatever cwd config.json names.
- The limit files (`CLAUDE.md`, `AGENTS.md`, and Claude Code's
  `.claude/settings.json`) are written afresh right before each session
  starts, not only at startup, and read back afterwards. If that fails, no
  agent starts.
- Work's `CLAUDE.md` and `AGENTS.md` name the working folder, where a file
  the agent's task downloads lands, so the agent, which can't open files,
  tells the user where to look. zenius's results name each file, and the
  agent waits for a download still running before it finishes (mcp.md,
  Downloads). Without a working folder, they give the reason every
  download is refused. The sidebar takes the folder from the runtime's
  `loadWorkingFolder()`, which reads it once per run of Zen, so a change of
  folder reaches the agents at the next start, as it does the downloads.
- The zenius-only hook stays in zenius's installed code
  (`chrome/JS/agent-sidebar/…/zenius-only.mjs`) and is never copied into a
  workspace. settings.json names it by its absolute path, quoted, and the
  command ends in `|| exit 2`.
- Claude Code's Work session gets the zenius MCP server through ACP's
  `mcpServers`, as its only server. The server brings zenius's browser
  tools, `report_problem`, which shows a problem report in the card (The
  problem report card), and `docs`, and the zenius-only hook lets Work call
  any of them (`mcp__zenius__*`).
- Its Chat session gets the server started with `--docs-only`, which serves
  `docs` alone: zenius's own text about its error codes, URLs, files and
  limits, read from the installed version and never from the browser
  (docs/mcp.md). Users ask Chat what an error means. Chat allows
  `mcp__zenius__docs` and no other zenius tool, and the hook refuses the
  rest. Each session's `_meta`
  sets `settingSources: ["project"]`, `strictMcpConfig: true`, and
  disallows Bash, Edit, MultiEdit, Write, NotebookEdit, Read, Glob, Grep
  and Task.
- Claude Code's process keeps its MCP calls in the foreground
  (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` in its env, `claudeEnvironment`,
  unless config.json's agent env sets it). Otherwise, from Claude Code
  2.1.286, a message the user sends while a zenius call runs moves the call
  to the background: the call ends at once in Claude Code's words while it
  goes on in the server, the turn ends, and the call's result comes later,
  outside every turn. A wait for the user then hid its hand-off. With 0,
  Claude Code 2.1.332 interrupts the call, sends the server
  `notifications/cancelled`, and the agent answers the message in the same
  turn (both checked with a real run). The variable is Claude Code's own and
  may change, so the chat copes with a moved call too (Steps, The agent's
  own work).
- Web search and fetch are on in Chat and Work, since they only read and an
  answer often needs more than the page: Claude Code's WebSearch and
  WebFetch, allowed without asking, are Chat's only tools besides zenius's
  docs. The user's own
  denial of one in config.json stays. WebFetch runs in the CLI, which Zen
  started, so macOS counts its requests as Zen.app's: the zenius-only hook
  keeps it off the local network as task pages are kept (private and
  link-local addresses in any spelling, `.local` names; loopback stays
  open). Unlike the tabs, a name also counts by the addresses it resolves
  to, and a lookup that fails or takes over 3 s refuses; a name whose answer
  changes before the CLI connects still gets through. A Work agent can open
  such a page in a tab instead, where the user's own list applies.
- Chat fetches only URLs from its sources, so an injected line can't send
  the chat's content out in a URL: the user's
  words, the page as read (its address, text and links) and its search
  results' hits, plus a redirect's target. Each Claude Code Chat session
  has a list, `<profile>/agent-sidebar-allow/<session id>.txt`:
  - AgentService writes each question's URLs to it before the question goes
    out;
  - chat-sources.mjs, a PostToolUse hook, adds search hits and redirect
    targets;
  - the zenius-only hook refuses any other URL, before it looks a host up,
    and refuses every fetch when it can't read the list.

  Work fetches any URL.
- Codex runs with its limits in memory: a read-only sandbox with no network,
  no shell tools or sub-agents, and cwd `codex/`. Each Work chat has a
  process of its own with zenius's server (at most
  `uc.agent-sidebar.open-sessions` of them; the least recently used one
  stops, and a chat's stops when it's removed or closed, or as its last
  turn ends). The process Chat's conversations share has the server with
  `--docs-only`, its docs alone. Its hosted web search,
  which runs at OpenAI, is on: live in Work, and in Chat kept to the
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
  before `sdk/src/mcp.ts` has no `mcp`, so
  install-cli.sh has to install a current main with the sidebar.

## Tests and fixtures

`tests/fixtures/agent-sidebar/` (its README): a mock ACP agent whose
scenarios drive this checkout's `zenius mcp`, a mock-only config, pages on
loopback, a tasks file in every state but Working, and a live scene with all
of them.

`tests/ux/feedback.test.mjs` drives the problem report card through a
stand-in for the runtime's side of it, so every state can be reached on
purpose. Its last tests run the runtime's own module, with a fake gh that a
dev pref names, so nothing reaches GitHub: they check that Send and Add a
comment post exactly the text the card shows. Copy runs only headless, where
Zen's clipboard is its own. `tests/ux/mac/look.test.mjs` draws the card in
Light and Dark, and at the sidebar's narrowest width, with a report from the
runtime's own text builder, without pressing anything.

Once these files are in `runtime/JS/`, `scripts/zen-dev.sh` copies them into
every dev profile, so every dev Zen loads the sidebar. With no agents (the
config `"none"`, or none to read), it adds no row to the address bar.
⌘⇧A opens the sidebar there; Zen's own key for it is switched off while the
script runs.
