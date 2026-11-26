# zenius as an MCP server

`zenius mcp` serves browser tools to Claude Code and Codex over the Model
Context Protocol (stdio). The agent works in Zen through steps the user can
read, such as `Open shop.example.com/checkout` or `Click "Settings"`, instead of
`zenius nodejs` shell commands. It needs no shell, so it also works where the
user has turned the agent's Bash tool off.

The server is part of the CLI (`sdk/src/mcp.ts`, zen-core's). It goes
through the SDK's task spaces and Pages on the instance socket, so the
runtime applies the same rules as it does for a script, and its errors use
the same words (zen-sdk's error guide).

## Tools

| Tool | The step, as the user reads it | What it does |
|---|---|---|
| `open` | `Open shop.example.com/checkout` | Opens a page in a new tab of the agent's task. The first open starts a task of its own, named by `task`; a name another task has gets a number (`Tokyo flights 2`). |
| `goto` | `Go to shop.example.com/checkout` | Loads a page in one of the task's tabs. |
| `read_page` | `Read the page`, `Read the whole page`, `Read part of the page` | Returns what's in view of the tab as text, each element with a ref (`[ref=12]`); `full: true` reads the whole page, `root` one part. When there's more out of view, the text ends by saying so. |
| `click` | `Click "<element>"` | Clicks an element, by its ref (`ref=12`) or a selector: at its middle, or at `position` (`{x, y}`, CSS pixels from its top left), such as one square of a board. When another element covers that point, the error names it and the point; `force: true` clicks there anyway, and that element takes the click, as it would a user's. |
| `hover` | `Hover over "<element>"` | Moves the pointer over an element, as for a menu that opens on hover; `position` and `force` as for `click`. |
| `drag` | `Drag "<element>" to "<to_element>"` | Presses on an element (`target`), moves to another (`to_target`) and releases there, as for a board's piece or a slider; `position` and `to_position` pick the points, and `force` as for `click`. |
| `fill` | `Type "<text>" into "<element>"`, `Type a password into "<element>"`, `Clear "<element>"` | Replaces a field's text. |
| `press` | `Press Enter`, `Press Cmd+A on "<element>"` | Presses a key or a chord. |
| `scroll` | `Scroll down`, `Scroll to "<element>"` | Scrolls by screens, or until an element is in view. |
| `select` | `Select "<option>" in "<element>"` | Chooses options of a select element. |
| `wait` | `Wait for "<text>"`, `Wait for the tab to reach example.com/done`, `Wait for the page to load`, `Wait 1 second`, `Wait for the downloads to finish`, `Wait for the user to resume the agent` | Waits for text, an element, a URL, a load state, a time, the task's downloads, or the user. |
| `hand_off` | `Ask the user: "<message>"` | Hands the task to the user, for signing in, paying or a captcha. Zen's card in the tab shows the message, and Zen names the reason (`sign_in`, `irreversible`, `human_check` or `other`) where the task waits for the user. |
| `finish` | `Finish, keeping 1 tab`, then each kept tab's title and host; `Finish, closing the task's tabs` | Ends the task, keeping the tabs the user should see. While a download still runs, it refuses, naming it, unless `cancel_downloads` is true (Downloads, below). |
| `evaluate` | `Run code in the page` | Runs JavaScript in the agent's isolated world, which sees the page's DOM but not its scripts. From the first update, the user's page-code setting decides whether it's offered. When the code leaves something in the page that zenius counts as a hook, such as a style sheet or a form, the result says so after the value: zenius loads that page afresh when it's handed to the user, before the user clicks or types there, and at the task's end, so what the page keeps only in its memory is lost (the limits topic, "Pages that load afresh"). |
| `report_problem` | `Report a problem with zenius: "<line>"` | Shows the user a problem report about zenius itself in Zen's agent sidebar, for them to send, copy, keep working on with the agent, or discard (below). |
| `script` | `Run a script: "<purpose>"`, with its steps under it in the sidebar | Runs a `zenius nodejs` script in the task, for work of many steps, within a time limit. Only under the sandboxed launcher (Scripts, below). |
| `docs` | `Read zenius's docs`, `Read zenius's docs: "<topic>"` | Returns zenius's own docs for the version installed: what an error code means, which URLs agents may load, where a script's files go, and the limits (below). It needs no Zen. |

`element` is required wherever a tool takes a target. It's the element's
visible text, or a short description, and it is what the step shows. Each
result starts with its step. A failure reads `<step> failed.`, then the
error's code (such as `ZEN_SELECTOR_NOT_FOUND: …`) with the error guide's
explanation and next step. The code is for the agent; the step stays the
user's line.

The server runs one call at a time, in order: a task's steps depend on the
ones before. A call its client cancels (MCP's `notifications/cancelled`, as
Claude Code sends when the user interrupts it) ends at once, wherever it is
in that queue: the server answers it nothing, as MCP has it, and the next
call starts. The runtime stops what the call was running too: a `wait`
for the user or for a page ends in Zen as well, and its step reads
stopped. An action still looking for its element ends without acting; one
already under way finishes.

## A task of its own

Each server's task is its own. `open` never joins a task the server didn't
start, even one with the same name, so two chats whose agents name their
tasks alike get a task each (`Tokyo flights`, `Tokyo flights 2`). Scripts
keep Ego's `taskSpace()`, which finds a task again by its name.

- **Names.** A name is at most 80 characters. A longer one is cut before
  its number, so `open`'s result (`Started the task "…".`) shows each task's
  whole name. The agent sidebar learns from it which task its chat started.
- **A resumed chat.** The sidebar parks idle sessions. When one comes back
  (resume, load or fork), its agent starts a new server. The sidebar passes
  that server the chat's task as `ZENIUS_TASK_SPACE=<id>`.
  - At its first call, the server goes on in that task while it is still
    the agent's: its own, or handed to the user for now. If the agent has
    the task and it has one tab, that tab is the current one; otherwise the
    agent names one (`page`).
  - Any other value gets one line on stderr and no error: not an id, no
    such task in this instance, the user's, or ended. The agent's `open`
    then starts a new task.
  - The server reads the variable once.
  - Codex's server comes from `CODEX_CONFIG`, which codex-acp reads once per
    process, so each Codex Work chat has a process of its own, and one from
    before the chat's task is replaced before the chat's next session (a
    session's own ACP server would replace `CODEX_CONFIG`'s whole
    `mcp_servers` table in codex-acp 2.6.0).

## When the task isn't the agent's

The SDK's guidance at a hard stop tells a script to take the task back
(`takeOverTaskSpace()`, `claimTaskSpace()`). No tool does that: here only
the user gives a task back. So the server answers these in its own words:

| Code | When | What the agent reads |
|---|---|---|
| `ZEN_TASK_SPACE_USER_IN_CONTROL` | After `hand_off`, or the user's Take over | The user has the task; don't retry or get around it; if they say to go on, ask them to press Resume agent, then `wait` with `user: true`. |
| `ZEN_TASK_SPACE_USER_IN_CONTROL` (a prompt) | Zen shows a prompt for storage access, the local network or a passkey | Which prompt it is; answering it gives the task back; tell the user what it's for, then `wait` with `user: true`. |
| `ZEN_TASK_SPACE_INACTIVE`, `ZEN_TASK_SPACE_NOT_FOUND` | The task was finished, or the user stopped it | The task ended and its tabs are the user's; don't retry; `open` starts a new task only if the user asks for more. |

The user saying "continue" in the chat doesn't give the task back, and the
server's instructions say so: the agent asks them to press Resume agent in
Zen.

## How a step reads

The user reads the steps, maybe on a shared screen, so they show only what
is safe and plain to read:

- **Secrets.** A step never shows text typed into a password, card or
  one-time-code field, the kinds Resume agent clears
  (`content/secrets.sys.mjs`). It names the kind instead: `Type a password
  into "Password"`, `Type a card number into …`, `Type a security code into
  …`, `Type a card's expiry date into …`, `Type a code into …`,
  `Type a PIN into …`.
  - The server tells by the field's names: `element`, the target (such as
    `#login_pw` or `input[name="cc_number"]`), and, for a ref, the line the
    tab's last `read_page` gave it.
  - After a fill on a ref, a snapshot of that one element shows whether the
    field keeps its text out, as a password field does (`isSecretField`). The
    check costs about 7 to 10 ms, and it leaves the agent's refs as they
    are. If it can't be made, the step leaves the text out.
  - The runtime's fill receipt doesn't say what kind of field it filled. If
    it carried the field's `secretKind` (a first-update change), card and
    code fields would be caught by any target, whatever they're named.
  - Claude Code and Codex still show a call's arguments above its result.
    So the server's instructions tell the agent to hand off for passwords,
    card numbers and one-time codes, which is the user's rule anyway.
- **Invisible characters.** Bidi controls, zero-width and other format
  characters are dropped from every quoted text and URL, so text copied from
  a page can't make a step read as something else.
- **URLs.** A step shows the host, in punycode (a Cyrillic а in apple.com
  shows as `xn--pple-43d.com`), and the path, cut to 80 characters. It never
  shows the query or the fragment, where sign-in and magic links carry their
  tokens, or a user name and password. Results give the agent the whole URL.
- **Tabs.** The user never sees a label: `finish` counts the kept tabs and
  lists each by its title and host.
- **Keys.** `Meta` reads `Cmd` and `Alt` reads `Option` on a Mac.

Tabs are `p1`, `p2` and so on, as in a script. A click that opens a tab makes
that tab the current one. `wait` gives a page condition 10 s, at most 50.
With `user: true` it waits 50 s unless given `seconds` (at most 600). If the
user hasn't pressed Resume agent by then, it says so, not as a failure, and
the agent calls it again.

## Downloads

A file a page downloads in the agent's task lands in the working folder
(install-daily.md, "The working folder"), as a script's download does. The
server never reads it: it tells the agent where it is, so the agent can
tell the user. It hears the runtime's `download` events for its task
(PROTOCOL.md) and adds what they say to the next result, a line each, once:

- `p1 started downloading "report.pdf": …`
- `p1 downloaded "report.pdf": it's in the working folder, ~/zenius-files, as "report(1).pdf".`
- `p1's download of "report.pdf" failed: …`, with the reason, such as
  zenius's refusal. A refusal that the action's own result already gives
  isn't repeated.

Nothing waits for a download. A click returns before the download it starts
begins, so its line usually comes with the next call.

`wait` with `downloads: true` waits until the task's downloads that are
still running end, up to its `seconds`. A task's end cancels a download
still running, so `finish` refuses while one runs, naming it: the agent
waits for it, or passes `cancel_downloads: true` when the user doesn't need
the file.

## Scripts

`script` runs a `zenius nodejs` script in the server's task, for work of
many steps: a loop over pages, or over files in the working folder. The
server offers it only when it runs under the sandboxed launcher
(`install-cli.sh --sandbox`), with Node's permission model on and the
launcher's grants (below). A plain install's server leaves it out.

- **Arguments:** `code`, the body of an async function as `zenius nodejs`
  runs it (top-level `await` and `return` work); `purpose`, one line the
  user reads as the step; `seconds`, its time limit; `page`, the tab the
  `page` global starts as, the current one if left out.
- **What it sees:** the CLI's globals and API, plus `task`, the server's
  task (null before it has one), and `page`. The task functions keep to
  the server's own task:
  - `taskSpace(name)` starts it, as `open` does, when there's none yet,
    and returns it after; any other task is refused, by name or id;
  - `listTaskSpaces()` lists it alone;
  - `claimTaskSpace` and `takeOverTaskSpace` are refused: here only the
    user gives a task back.

  These guard against mistakes, not abuse: a script can reach Zen on a
  connection of its own, and the runtime's rules bind it as they bind any
  client. Page code follows the user's setting, as for every client.
- **How it runs:** in the server's own process, one call at a time, on a
  connection of its own to Zen that closes when its call ends. What the
  script leaves running then, a timer or a promise it didn't await, gets
  no more calls: a later one fails at once with `ZEN_CANCELED`, and one
  still waiting stops in Zen, as for a canceled call. Its console output
  is its own, and `process.exit()` ends the script, not the server.
  After each script the server puts back its folder, its environment and
  the globals the script added; `page`, `task` and the API's functions
  stay until the next script sets them, so what the script left running
  meets a refused call there rather than a missing name.
- **The result:** the step line, the script's output, then what it
  returned, as JSON. Past 20,000 characters the output and the value are
  cut, never the step line. A second block holds the server's own lines,
  which the script can't write: `Started the task "...".` when the script
  started it, the files it touched, download lines, and the CLI's
  end-of-run notices, among them a line for each page its page code left
  something in that costs the page a reload, as the evaluate tool says.
  A failure reads `<step> failed.`, then the error's code with the
  guide's words, and the script's line.
- **The files it touched,** as far as the server saw:
  `Read "invoice-1.pdf", "invoice-2.pdf" and 3 more`, `Wrote "summary.csv"`,
  `Deleted "report(1).pdf"` and `Uploaded "passport.jpg" to https://visa.example`.
  Writes and deletes come from a listing of the working folder before and
  after the script, reads from node:fs's calls. A script in the server's
  process could hide what it did from both, so these lines are a record
  for the user, not a guard.
- **Its time limit:** `seconds`, else 50 s, at most 600 s, and never past
  the client's tool timeout less 10 s (`ZENIUS_TOOL_TIMEOUT`, in
  Registering it). At the limit its call answers with the output so far,
  its connection closes, and its later calls fail. Longer work goes in
  several calls: the task, its tabs and the working folder carry over, a
  script's variables don't. To wait for the user, hand off, end the
  script, then call `wait` with `user: true`.
- **Stopping it:** a cancel from the client ends the call at once, as for
  any tool. The user's Stop in Zen's sidebar stops the script too, whatever
  the client does with the call: the runtime closes the script's
  connection, and the call answers that the user stopped it. Either way
  the script's waits and page code stop in Zen, and the next call starts.
  A script that never yields, a loop with no `await`, holds the server
  until its client gives up: wait with `page.waitFor*` or `wait`, never
  with a busy loop.
- **In the sidebar,** the task shows the script as one step,
  `Run a script: "<purpose>"` in the agent's own quoted words, with the
  steps of its calls under it as they happen (SPI, "Each task's steps").

**The grants.** The sidebar's Work runs `zenius mcp --sidebar`. Seeing the
flag, the launcher grants the working folder (read, write and delete) and
the server's run folder, where each script gets a temporary folder of its
own as `TMPDIR`, removed when its call ends. There's no read folder and no
current folder: a script starts in the working folder. A terminal's
`zenius mcp` gets what its `zenius nodejs` gets from the same folder: the
current folder to read, the read folder and the working folder, which an
agent with a shell reaches anyway. Neither gets programs, workers, the
network beyond Zen's socket, `dev.*` or settings.

## Reporting a problem with zenius

`report_problem` is `zenius feedback` for an agent without a shell, such
as a Work chat in Zen's agent sidebar. It takes one `line`, what the agent
was doing when zenius failed, and an optional `wait` in seconds, at most
600. Without it, the call answers within 50 s, inside the 60 s Codex gives
a call: zenius's own checks get 15 s at most, and the user the rest, at
least 10 s. Zen composes the same report as for the CLI
(PROTOCOL.md, "Problem reports") and shows it in the sidebar's card. There
the user sends it to zenius's GitHub issues with their own gh, copies it,
keeps working on it with the agent, or discards it. Nothing goes out
before their click, and the agent hears only their choice: the issue's
number and address, copied, deferred, discarded, or still waiting.
- Deferred: the user wants to change the report with the agent first.
  Nothing was sent, and the answer says to ask the user what to change,
  then call `report_problem` again with the revised line. The revision
  shows at once, as a new report.
- After a Discard, no report shows for 10 minutes, unless the user undoes
  the Discard in the card. A call meanwhile says until when.

- The report's last calls and last failed call are the Zen instance's, not
  the session's: every client's calls count, so another chat's or a
  script's calls can sit among this session's.
- Every answer from the card is a plain result, a refusal included
  (another report waits, or the user discarded one less than 10 minutes
  ago): asking again would only ask the user again. Only Zen not
  answering, an empty line, or a `wait` that isn't a positive number
  fails as a call does.
- When the wait ends before the user answers, the card stays up, and the
  agent hears that the report still waits.
- With no sidebar to show the card, it says so and saves nothing. Unlike
  the CLI, it writes no draft, since its agent has no folder to point the
  user to.
- The report carries the server's source, as a task does, and the card
  names the Work chat that wrote it from it. Like a task's, the source is
  the server's own claim.

## zenius's docs

`docs` answers questions about zenius itself, such as what a
`ZEN_URL_NOT_ALLOWED` from `goto` means. Its topics are built from the
installed version's own code (`sdk/src/docs.ts`):

- `errors`: every error code and refused kind, what it means and what to do
  next. A code or a kind's name as the topic gives that one alone.
- `urls`: which URLs agents may load, and the pages where they can't act.
- `files`: where a script's files go, and which files it may upload.
- `limits`: the default timeouts and limits.
- `script`: how the script tool runs a script, what to do when the user
  takes the task or stops the script, and the API without the CLI's task
  functions. The script tool's description points to it. It's zenius
  mcp's alone, so the skill has no reference of it.

With no topic it lists them. It reads no page and never connects to Zen,
so it answers while Zen is closed.

The same text is there in three other forms:

- MCP resources, `zenius://docs/<topic>` as `text/markdown`, for clients
  that read resources. A code's URI works too, such as
  `zenius://docs/ZEN_URL_NOT_ALLOWED`.
- `zenius docs [topic]`, for an agent with a shell.
- The skill's `references/<topic>.md`, but for `script`, which
  `sdk/scripts/write-references.ts` writes. `sdk/test/docs.test.ts` fails
  while they differ.

`zenius mcp --docs-only` serves the `docs` tool alone, and never reaches
Zen. The agent sidebar's Chat runs it that way: Chat can say what an error
means, and has none of the browser tools. A CLI older than the flag refuses
it and doesn't start.

## What it never offers

The one-step tools offer none of these. A script works within the
launcher's grants instead (Scripts, above): it reads and writes the
working folder, uploads what it can read, saves screenshots into its own
folders, and may use `page.fetch`; the runtime's URL rules hold for it.
`dev.*`, settings and a shell stay out for both.

- No `dev.*` method, no zenius or Zen settings, no shell, no file system.
- No file upload. It would let the agent send any local file to a site.
  Uploads come later, limited to files the user attached.
- No screenshots (they're written to disk) and no `page.fetch`.
- Only `http` and `https` pages. `file:`, `data:` and browser URLs are
  refused before anything reaches Zen.

## Which Zen it drives

The daily Zen, instance `default`, unless `ZENIUS_INSTANCE` or
`zenius mcp --instance <name>` names another (a dev Zen's name). The try Zen
is retired: a registration from its days with
`ZENIUS_INSTANCE=try` reaches nothing, so drop that setting.

## Registering it

Agents in zenius's sidebar need no registration: the sidebar passes this
server to each session it starts (zen-ux's), with its Zen's instance in
`ZENIUS_INSTANCE`, and its zenius home and working folder in `ZENIUS_HOME`
and `ZENIUS_WORKING_DIR` when that Zen has them, as a dev Zen does. The
agent's own process gets the same three, so a `zenius` command it runs
reaches the same Zen. For the user's own Claude Code
or Codex in a terminal, the user registers it, or someone at the user's
request; zenius never writes `~/.claude` or `~/.codex`. `zenius` below is
`~/.local/bin/zenius` from `scripts/install-cli.sh`. Without the CLI
installed, use `node <checkout>/sdk/bin/zenius` instead.

### Claude Code

```bash
claude mcp add zenius --scope user -- zenius mcp
```

Or, for one project, in its `.mcp.json`:

```json
{
  "mcpServers": {
    "zenius": { "command": "zenius", "args": ["mcp"] }
  }
}
```

Claude Code asks before a tool's first use. The user can allow all of
zenius's tools at once by adding `mcp__zenius` to the allowed tools in
`/permissions`.

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.zenius]
command = "zenius"
args = ["mcp"]
tool_timeout_sec = 120
```

Codex gives a tool call 60 s by default. That's why no `wait` goes past
50 s unless the agent asks; `tool_timeout_sec` raises the limit.

### The tool timeout

`ZENIUS_TOOL_TIMEOUT`, in the server's environment, is the client's tool
timeout in seconds. The server keeps every call 10 s inside it: a script's
limit, `wait` and `report_problem`. Without it, the server goes by the
client `initialize` names: 60 s for Codex and any other client, and none
for Claude Code, whose default is about 27.8 h, so the server's own caps
hold. The sidebar passes 120 for both of its agents. A client given a
longer timeout passes the same number, as Codex's `env` does:

```toml
[mcp_servers.zenius]
command = "zenius"
args = ["mcp"]
tool_timeout_sec = 120
env = { ZENIUS_TOOL_TIMEOUT = "120" }
```

## Tests

`sdk/test/integration/mcp.it.ts`, in the SDK's integration suite (`sdk-it`
in `scripts/test-all.sh`), spawns `zenius mcp` and drives every tool over
stdio against a headless dev Zen. It checks the steps, the results, the
error paths, the downloads that later results tell of, and that nothing
beyond these tools is offered. `sdk/test/mcp.test.ts` checks the download
lines, `wait`'s and `finish`'s rules on a mock runtime.
`sdk/test/docs.test.ts` checks the docs, their resources and `--docs-only`
without a Zen, and `tests/ux/chatdocs.test.mjs` checks Chat's server as the
sidebar starts it.
