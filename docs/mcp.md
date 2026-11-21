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
| `click` | `Click "<element>"` | Clicks an element, by its ref (`ref=12`) or a selector. |
| `fill` | `Type "<text>" into "<element>"`, `Type a password into "<element>"`, `Clear "<element>"` | Replaces a field's text. |
| `press` | `Press Enter`, `Press Cmd+A on "<element>"` | Presses a key or a chord. |
| `scroll` | `Scroll down`, `Scroll to "<element>"` | Scrolls by screens, or until an element is in view. |
| `select` | `Select "<option>" in "<element>"` | Chooses options of a select element. |
| `wait` | `Wait for "<text>"`, `Wait for the tab to reach example.com/done`, `Wait for the page to load`, `Wait 1 second`, `Wait for the user to resume the agent` | Waits for text, an element, a URL, a load state, a time, or the user. |
| `hand_off` | `Ask the user: "<message>"` | Hands the task to the user, for signing in, paying or a captcha. Zen's card in the tab shows the message. |
| `finish` | `Finish, keeping 1 tab`, then each kept tab's title and host; `Finish, closing the task's tabs` | Ends the task, keeping the tabs the user should see. |
| `evaluate` | `Run code in the page` | Runs JavaScript in the agent's isolated world, which sees the page's DOM but not its scripts. From the first update, the user's page-code setting decides whether it's offered. |

`element` is required wherever a tool takes a target. It's the element's
visible text, or a short description, and it is what the step shows. Each
result starts with its step. A failure reads `<step> failed.`, then the
error's code (such as `ZEN_SELECTOR_NOT_FOUND: …`) with the error guide's
explanation and next step. The code is for the agent; the step stays the
user's line.

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
  - Codex's server comes from `CODEX_CONFIG`, which every session of a
    codex-acp process shares, so Codex gets no `ZENIUS_TASK_SPACE`.

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
is safe and plain to read (zen-ux's review):

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

## What it never offers

- No `dev.*` method, no zenius or Zen settings, no shell, no file system.
- No file upload. It would let the agent send any local file to a site.
  Uploads come later, limited to files the user attached.
- No screenshots (they're written to disk) and no `page.fetch`.
- Only `http` and `https` pages. `file:`, `data:` and browser URLs are
  refused before anything reaches Zen.

## Which Zen it drives

The daily Zen, instance `default`, unless `ZENIUS_INSTANCE` or
`zenius mcp --instance <name>` names another (a dev Zen's name). The try Zen
is retired (the user, 2026-11-21): a registration from its days with
`ZENIUS_INSTANCE=try` reaches nothing, so drop that setting.

## Registering it

Agents in zenius's sidebar need no registration: the sidebar passes this
server to each session it starts (zen-ux's). For the user's own Claude Code
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

## Tests

`sdk/test/integration/mcp.it.ts`, in the SDK's integration suite (`sdk-it`
in `scripts/test-all.sh`), spawns `zenius mcp` and drives every tool over
stdio against a headless dev Zen. It checks the steps, the results, the
error paths, and that nothing beyond these tools is offered.
