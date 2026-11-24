# Zenius: Agentic Zen

Zenius brings agent browsing on Ego Lite's level to the user's existing Zen
Browser (Zen 1.24.2b, Gecko 160), without forking Zen. Agents such as Claude
Code and Codex drive it with zenius's JavaScript API, each task in its own Zen
Space, while the user keeps browsing in theirs.

## 1. Goals

1. **Coverage.** Everything an agent can do with Ego Lite (0.6.3.17, skill
   guide v2.2.1) works on Zen: task spaces, pages, snapshots with refs,
   selectors, pointer and keyboard input, waits, dialogs, popups, downloads,
   file choosers, evaluate and fetch, handoff and takeover. Ego Lite's skill
   guide is the agent-facing contract.
2. **Speed.** Per-action latency and API round trips are at least as fast as
   Ego Lite on the same Mac. We measure first, then optimize in passes.
3. **Spaces without preemption.** Each agent task runs in its own Zen Space
   (workspace) inside the user's browser. The agent never changes the user's
   selected tab, active Space, window focus, keyboard focus or OS cursor.
4. **Watch and take over.** When the user switches to an agent's Space, they
   see the agent's cursor and action labels moving on the real page. Any manual
   input there pops a "Take over?" prompt. Handoff and takeover state flows
   back to the agent API.

## 2. Non-goals

- No Zen fork or rebuild. No WebExtension: extensions can't reach Zen's
  workspaces or synthesize trusted input.
- No Marionette, WebDriver BiDi or `--remote-debugging-port` in the user's
  browser. They put Firefox in remote-control mode, set `navigator.webdriver`
  (bot detection) and show the robot UI. Dev-only test harnesses may use them
  on dev profiles, never the product.
- No CDP emulation. `page.cdp()` and `task.cdp()` fail with `ZEN_UNSUPPORTED`
  and point at the documented methods.
- No signing in for programs. zenius doesn't complete a program's sign-in
  (OAuth consent pages, device codes) on the user's behalf: those stay with
  the user.

## 3. Architecture

```text
Claude Code / Codex
  └─ zenius nodejs <<'EOF' … EOF        Node SDK: zenius's globals and classes
       └─ Unix socket, NDJSON            ~/.zenius/run/<instance>.sock (0600)
            └─ Zen parent process
                 ZeniusService (.sys.mjs singleton, started by zenius.uc.js)
                 ├─ Spaces     Zen workspaces (gZenWorkspaces), ownership state machine
                 ├─ Pages      tab registry: labels p1…, openedBy, popups, budget
                 ├─ Observers  downloads, dialogs, file picker, network, permission prompts
                 ├─ UI         agent cursor, takeover prompt, status panel, Space badges
                 └─ JSWindowActor "Zenius" (every frame, incl. out-of-process iframes)
                      └─ content modules: snapshot, resolve, actionability, input, nav, evaluate
```

### 3.1 Why fx-autoconfig

The user's Zen already runs fx-autoconfig 0.10.16: `config.js` and
`defaults/pref/config-prefs.js` sit in the app bundle, and each profile's
`chrome/utils/` holds the loader. Scripts in a profile's `chrome/JS/` run with
chrome privileges, which gives us `gZenWorkspaces`, `gBrowser`,
JSWindowActors, `nsIServerSocket`, `nsITextInputProcessor`,
`nsIDOMWindowUtils`, `drawSnapshot`, `Downloads`, the prompt service and the
file picker. None of it needs signing, experiment APIs or remote-control mode.
The user's own `agent-sidebar.uc.js` uses the same mechanism.

fx-autoconfig's chrome registrations: `chrome://userscripts/content/` is the
profile's `chrome/JS/`, `chrome://userchrome/content/` is `chrome/resources/`.

Caveat: a Zen update replaces the app bundle and deletes `config.js`.
`zenius doctor` must detect that and offer to reinstall it, with the user's OK.

### 3.2 Repository layout

```text
runtime/                     browser side, linked into a profile's chrome/ folder
  JS/zenius.uc.js            per-window bootstrap (@include main)
  JS/zenius/                 everything else (fx-autoconfig doesn't auto-load subfolders; verify)
    modules/                 parent-process singletons (.sys.mjs)
    methods/                 RPC method handlers, one module per area (see §4)
    actors/                  ZeniusParent.sys.mjs, ZeniusChild.sys.mjs
    content/                 content-process modules called through the actor
    ui/                      cursor overlay, takeover prompt, panel, styles
  vendor/fx-autoconfig/      loader files (MPL-2.0), copied into dev profiles
sdk/                         Node SDK and the `zenius` CLI
skill/zenius/                agent skill: SKILL.md, references, learnings
tests/fixtures/              fixture web server and pages
tests/e2e/                   Ego's real-browser e2e suite, ported, runnable against ego or zenius
tests/bench/                 latency and non-preemption benchmarks
scripts/                     zen-dev.sh (dev profiles), install, doctor
docs/                        SPEC, PROTOCOL, SPI, PARITY, the install and sidebar guides, eval/
```

### 3.3 Transport

- Unix domain socket at `~/.zenius/run/<instance>.sock`, directory 0700,
  socket 0600. Keep paths short: macOS limits socket paths to 104 bytes, which
  rules out the profile directory.
- Instance name: pref `zenius.instance`, default `default`. Dev profiles use
  the worker's name.
- Registry file `~/.zenius/instances/<instance>.json`:
  `{instance, pid, socket, profileDir, zenVersion, runtimeVersion, startedAt}`.
  The CLI picks the instance with `--instance <name>` or `ZENIUS_INSTANCE`.
- Frames are newline-delimited JSON. `docs/PROTOCOL.md` has the frames,
  methods and error codes.
- Fall back to TCP on 127.0.0.1 with a token file only if Unix sockets turn
  out not to work in Gecko 160.

### 3.4 Tasks share the Agents Space

- **One Space for every task.** The tabs of every task an agent creates live
  in one Zen workspace, the Agents Space.
  - zenius creates it with the first task, without switching any window.
  - It removes the Space once it holds no tab and no window shows it.
  - `~/.zenius/state/<instance>/spaces.json` keeps its uuid, name and icon.
    zenius reapplies the name and icon when it creates the Space again, so a
    rename by the user sticks across removals.
  - If the user deletes it, its tasks end, as after the panel's Stop. The
    next task creates it again.
- **A task is a set of tabs.** `taskSpace(name)` creates a task and its page
  `p1` (`about:blank`) in the Agents Space.
  - In the protocol, `space` names the task. Its numeric id stays the same
    across restarts.
  - Names are unique among tasks and the user's Spaces
    (`ZEN_TASK_SPACE_NAME_IN_USE`).
- **Lists.** `listTaskSpaces()` lists the tasks, and the user's own
  workspaces with `ownership: "user"`, as Ego lists the user's spaces. The
  Agents Space itself isn't listed.
- **Ownership is per task.** It's `agent`, `agentDelegatedToUser` or
  `user`, plus a transient `paused` flag while a takeover prompt is open.
  `takeOver`, `handOff`, `claim`, the takeover prompt and the panel each act
  on one task: taking over one task's tab doesn't pause another task.
- **Claim.**
  - An ended task can be claimed. Its tabs that aren't pages stay unmanaged
    until adopted.
  - Claiming one of the user's own workspaces makes a task whose home is
    that workspace: its new pages and popups open there, in the background.
    `finish()` never removes the user's workspace. This is Ego's claim of a
    user space (after the user approved), and the one case where agent tabs
    open outside the Agents Space.
  - The user approves in the browser. A claim of one of the user's
    workspaces, or of an ended task, shows a prompt in the user's window:
    "An agent asks to work in your Space "<name>"", with the name the
    client gives itself after it as a quoted label ("It calls itself
    "…""), and Allow and Deny. Only real clicks count, and nothing takes
    focus. The claim waits for the answer, up to 10 minutes: Deny or no
    answer fails it with `ZEN_TASK_SPACE_CLAIM_DENIED`.
- **Not while the user types.** `takeOver` of a task handed to the user,
  and `claim` of one, fail with `ZEN_TASK_SPACE_USER_IN_CONTROL` until 10 s
  after the user's last real input in the task's tabs, so an agent can't
  take a task back mid-typing.
- **`finish({ keep })`** closes the task's pages not kept and ends the task.
  - Kept pages, and the task's tabs of user or unknown origin, stay where
    they are, as the user's tabs, without the agent's tag.
  - The task stays listed, with `ownership: "user"`, until the last of
    those tabs closes, so a later claim finds them.
  - A tab a window shows closes only once the user leaves it (§3.5).
- **The user closes a task's last tab.** That ends the task, as the panel's
  Stop does. The agent's next call fails with `ZEN_TASK_SPACE_INACTIVE`, so
  it asks the user before claiming the task again.
- **Auto-close.** A task that's never finished is closed automatically only
  when all of these hold:
  - the agent still owns it: never handed to the user, no kept pages;
  - every tab in it was opened by the agent;
  - no client has named it for 3 days (72 hours).

  This is checked at Zen start and when a client connects, with no
  background timer. A pref changes the 72 hours or turns this off. The tasks
  panel marks idle tasks and offers a one-click close. The closing follows
  §3.5. This deviates from Ego, which keeps task spaces until finished,
  because zenius lives in the user's daily browser.
- **Restarts.**
  - Each task tab carries its task, label, origin and opener in a session
    value, which Zen saves with the tab.
  - When Zen restores the tabs, the runtime rebuilds every task's pages
    under their labels before it answers a client.
  - Restored pages stay unloaded until the agent uses one.
  - Before a restored page loads, its URL passes the I5 check (§3.9). A
    task tab the user took to `about:preferences` or a `file:` page stays
    unloaded, and the call fails as any call on such a page does.
  - Zen restores unpinned tabs only when it restores the previous session:
    `browser.startup.page` 3, Zen's default, which the user's daily profile
    keeps. Checked on the Linux server with a clean quit: with 3, a task Space's two tabs
    came back unloaded, with their session values; with 0, the Space came
    back empty, although Zen's session file still held both tabs. The Mac
    check passes too (`tests/e2e/restart-check.mjs`): restarts,
    crashes, and a window on the
    Agents Space with `zen.workspaces.continue-where-left-off`.
  - After a crash, Zen restores the session as well
    (`browser.sessionstore.resume_from_crash`, on by default), and the tasks
    come back the same way.
  - **Limit:** a crash restores what Zen's last periodic save wrote, and
    Zen 1.24.2b saves every 40 s (`browser.sessionstore.interval` 40000).
    So a crash can lose a task up to about 40 s old: it fails as
    `not_restored`, at once, and the agent starts over. zenius doesn't force
    saves.
  - A task none of whose tabs came back is removed, freeing its name. The
    agent's next call on it fails at once with `ZEN_TASK_SPACE_NOT_FOUND`,
    Ego's code for a task space that's gone, with `data.reason:
    "not_restored"`. It never waits.
- **Profiles.** Ego's profiles map to Firefox containers. `listProfiles()`
  returns the default (no container) plus each contextual identity.
  `taskSpace(name, { profileId })` opens the task's tabs in that container.
  By default, agents share the user's cookies and logins, as in Ego.

### 3.5 Tabs and pages

zen-ux measured each rule below in a window showing the Space.

- **Background only.**
  - Agent tabs and popups open in the background, without Firefox's
    background-tab notification. That notification scrolls the strip to the
    new tab: the user's tab moved 401 px in a probe.
  - No agent call changes a window's selected tab or active Space.
  - `bringToFront` records the task's front tab instead, which the panel's
    Open selects.
- **A task's tabs stay together.**
  - A new task's first tab goes at the bottom of the Agents Space, so
    starting a task never moves a tab the user sees. A tab added or moved
    above the user's moves it down a row (40 px in a probe); one
    added below moves nothing.
  - Each later page or popup goes right after the task's last tab.
  - While a window shows the Agents Space in a strip too short to scroll,
    a page placed there would still move the user's tab down a row. It
    goes to the bottom instead, and moves next to its task once that
    window shows another Space.
  - The runtime never pins, folds or groups agent tabs.
- **What a window shows.**
  - A window *shows* a tab when the tab is the selected tab of the
    window's active Space, or in the split view there. This holds whether
    or not the window is minimized or covered: closing the tab would change
    the window's selection, and the user would come back to another tab.
    Closes go by this.
  - A tab is *on screen* when a window shows it and that window is neither
    minimized nor covered. What depends on being seen goes by this: the
    mute, the checks that a page is watched, the cursor's animation.
- **Never close a tab a window shows.**
  - An agent call may close a tab a window shows: `pages.close`, `finish`,
    the auto-close. The page then ends at once: its label closes.
  - The tab stays, without the agent's cursor, marked "Task finished" with a
    Close button.
  - It closes when the user leaves it (another tab or Space) or clicks
    Close.
  - So no agent call moves the user's selection. And none empties a Space a
    window shows, where Zen would open a New Tab and focus the URL bar.
- **A still view.** After an agent change to a strip a window shows, the
  shown tab stays at the same height on screen. zen-ux's view keeper does
  this for every agent change, while the strip can scroll; Zen's strip has
  no scroll anchoring. A strip too short to scroll has no room to make up
  for a new row, so the placement rules above add none above the user's
  tab there.
- **The user picks the landing tab.** zenius never sets the tab a Space
  shows when the user switches to it. Zen reselects the Space's last
  selected tab, which in the Agents Space is the user's own last pick.
- **Labels.**
  - Labels `p1`, `p2`, … are permanent within a task.
  - Each page records `openedBy` (`agent`, `user` or `unknown`).
  - Pages support adopt and release.
  - The page budget is configurable.
- **Popups.**
  - Popups (`window.open`, `target=_blank`) from an agent tab join the
    opener's task, take the next label and appear in the action receipt.
  - A tab the user opens from a task's page, such as a middle-click or a
    link while they hold the task, belongs to the task as a tab of user
    origin.
- **Hidden tabs keep running.** Hidden agent tabs must behave like visible
  ones: rAF, timers, rendering and media keep running. Keep them active, and
  exclude them from Zen's tab unloader and Firefox's tab unloading.

  One exception: while the user can't see an agent tab, video that would
  keep the display awake pauses. That's any playing video with an audio
  track, muted or not, and any MediaStream video. The Gecko reason: the
  flag that keeps timers and rAF at full speed (`BrowsingContext.isActive`)
  also makes such a video's wake lock a foreground one. The tab is muted for
  the user then anyway. zenius resumes only what it paused, when the user
  looks or the tab stops being the agent's, and tells the agent
  (`Zenius.mediaPaused`, `Zenius.mediaResumed`). `<audio>`, Web Audio and
  other videos play on silently: in a muted tab they hold no lock. As in any
  Firefox tab, the audio wake lock outlasts a player's sound by 10 s.
- **State lives in the runtime.** Labels, refs and ledgers live in the
  runtime, not the SDK, so each new Node process sees the same state.

### 3.6 One round trip per page action

Each page action is a single RPC. The content actor resolves the target,
checks actionability, scrolls with wheel input (falling back to a programmatic
scroll), verifies the hit target, synthesizes trusted input, watches briefly
for popups and dialogs, and returns the receipt. Input candidates to evaluate:
`nsIDOMWindowUtils.sendMouseEvent` and `sendWheelEvent`,
`nsITextInputProcessor` for keys and IME, `nsIEditor` or
`execCommand("insertText")` for fill. All of them must work in a hidden tab
without taking focus from the user.

### 3.7 Snapshot

- The text format is Ego's (its captures are in `tests/golden/ego/`): a
  header line, an indented role tree, `[ref=N, loc=…, url=…]`, and the "more
  content below the viewport" footer.
- Computed in content JavaScript without the accessibility service, which
  slows every content process.
- Refs are bound to (browsing context, document, node) in a per-tab registry.
  Stale refs raise errors instead of silently re-matching.
- Also: `loc=` stable locators; `viewport`, `full_page` and `subtree` scopes;
  frames, including out-of-process iframes; open and closed shadow roots.

### 3.8 UX

- **Agent cursor.** A chrome-layer overlay above the tab's `<browser>`, moving
  with the action label. It animates only while visible, never appears in
  screenshots and never moves the OS cursor.
- **Takeover.** Real user input in an agent-controlled tab pauses its task's
  next action and shows a non-blocking prompt: Take over, or Let it continue.
  Take over sets that task's ownership to `agentDelegatedToUser` (reason
  `manual_takeover`). Agent calls on the task then fail with
  `ZEN_TASK_SPACE_USER_IN_CONTROL` until control returns. Other tasks in the
  Agents Space go on. Tell our synthesized input from the user's either at
  the parent level (real OS input passes through the parent's chrome
  listeners; ours is dispatched in the content process) or with a synthesis
  flag in the actor. The spike decides.
- **Status.** The tasks strip and panel are the grouped view of the agents'
  work.
  - **The panel.** It shows each task with its state, state text and tabs,
    and Stop, Pause, Resume, Take over and Hand back.
  - **Open.** Open switches the user's window to the task's Space and
    selects its front tab. The user asked, so it may change their selection.
  - **The tag.** Each agent tab shows a small task tag with the task's state
    (zen-ux's CSS).
  - **No sidebar grouping.** Zen's sidebar shows the tabs ungrouped:
    - Zen folders pin their tabs;
    - Firefox's tab groups are off in Zen. Headings may come later, behind
      a pref.
  - **The badge.** The Agents Space gets a badge in Zen's Space switcher
    while a task needs the user. `handOff()` (for a CAPTCHA, login or 2FA)
    raises a notification and that badge.
- **Permission prompts.** Only three prompts in an agent tab put its task
  under user control: `storage_access`, `local_network_access`, and
  `permission_prompt` (passkeys). Every other prompt from a task's pages is
  cancelled, during a hold too, and the agent gets `promptDenied`. That
  covers notifications, location, camera, microphone, MIDI, persistent
  storage and any type not listed. A device stream or a location watch the
  user allowed would carry on under the agent after Resume (the user's rule
  for sensitive input).

### 3.9 Invariants (each has an automated test)

- **I1 No preemption.** Agent activity never changes any window's selected tab
  or active workspace. It never focuses or raises a window, never moves
  keyboard focus away from the user's focused element, never moves the OS
  cursor, and never opens panels or popups over the user's view (download
  panel, notifications).
- **I2 Isolation.** The agent never operates user or unknown tabs unless it
  adopted or claimed them.
- **I3 Control.** No browser-mutating agent call succeeds while its Space is
  under user control.
- **I4 Daily-driver safe.** No `navigator.webdriver`, no remote-control
  indicator, and no global pref changes beyond documented ones.
- **I5 No way out through the browser.** The browser runs with the user's
  full rights, outside any sandbox the agent's CLI has. So it must not widen
  what an agent can reach:
  - Agent-started loads (goto, reload, back and forward, new pages) open only
    `http:`, `https:`, `data:`, `blob:` and `about:blank`, with a web-content
    triggering principal, so Firefox's own load checks apply too.
  - Agent methods act only in web-content documents. Never in one with the
    system principal or an add-on's, or with a `file:`, `about:` (other than
    `about:blank`), `chrome:`, `resource:`, `jar:` or `view-source:` URL,
    whoever loaded it.
  - The runtime never reads or writes a file path that an agent names.
    Uploads arrive as bytes; downloads, fetch bodies and screenshots leave as
    bytes. The CLI does all file I/O an agent asks for.
    - In the sandboxed CLI, an upload's real path must lie in the script's
      read grants, as well as the path it names. Node's permission model
      checks only the path named, and follows a link in it anywhere. This
      is defense in depth: an agent that can plant such a link can usually
      read its target in its own shell.
    - Known limit: a hard link inside the grants to a file outside them is
      a regular file there, and neither check can tell it apart. An agent
      whose own sandbox lets it make that link can read the file through
      it itself, so an upload adds no reach.
    - An upload may carry a path relative to the folder it came from
      (`relativePath`). The runtime writes it only inside its private
      upload folder under the profile. It refuses a `relativePath` that is
      absolute, has an empty, `.` or `..` segment, or holds a NUL, a
      backslash or another control character. Every resolved path must stay
      under that folder.
  - `dev.*` methods exist only on dev profiles.

## 4. Runtime internals (SPI)

The service loads method modules listed in `runtime/JS/zenius/methods/index.sys.mjs`:

```js
// runtime/JS/zenius/methods/<area>.sys.mjs
export const methods = {
  "page.click": async (ctx, params) => { /* … */ return receipt; },
};
```

`ctx` gives each handler:

- `ctx.resolvePage(params)` → `{ space, page, tab, browser, browsingContext }`
- `ctx.content(browsingContext, "module#fn", args, opts)`, which calls
  `export async function fn(actor, args)` in
  `runtime/JS/zenius/content/<module>.sys.mjs` inside the content process
- `ctx.emit(event, params)`
- `ctx.spaces` and `ctx.pages`
- `ZenError(code, message, data)`

W1 writes the exact interface in `docs/SPI.md` early and keeps it current.
Other workers add method and content modules without editing W1's files,
except to add one line to `methods/index.sys.mjs`.

## 5. Speed

Measured on the Mac against Ego Lite 0.6.3.17, with the same scripts on both
(`tests/bench/bench.mjs --target ego|zenius`). Ego's baseline, 20 iterations
after warm-up (`docs/eval/bench-ego-0.6.3.17.md`, 2026-11-20); its p50 is the
number to beat:

| Operation | Ego p50 | Ego p95 | zenius target (p50) |
|---|---|---|---|
| spawn to first RPC | 166 ms | 192 ms | ≤ 80 ms |
| `taskSpace(name)`, new space | 246 ms | 292 ms | ≤ 246 ms |
| `finish({ keep: [] })` | 54 ms | 130 ms | ≤ 54 ms |
| `goto` local fixture | 258 ms | 308 ms | ≤ 258 ms |
| `goto` example.com | 527 ms | 632 ms | ≤ 527 ms |
| snapshot, GitHub replay, viewport | 103 ms | 261 ms | ≤ 60 ms |
| snapshot, GitHub replay, `full_page` | 134 ms | 183 ms | ≤ 134 ms |
| `click(selector)` | 1008 ms | 1124 ms | as low as possible (Ego waits in native mouse input for a covered window) |
| `fill(selector, text)` | 21 ms | 69 ms | ≤ 21 ms |
| `press(selector, "Enter")` | 8.2 ms | 15 ms | ≤ 8.2 ms |
| `keyboard.type`, 50 characters | 68 ms | 166 ms | ≤ 68 ms |
| `evaluate(() => document.title)` | 5.2 ms | 14 ms | ≤ 5.2 ms |
| screenshot, viewport | 84 ms | 100 ms | ≤ 84 ms |
| screenshot, full page (2.8k px) | 115 ms | 132 ms | ≤ 115 ms |
| `waitForSelector`, element present | 5.8 ms | 10 ms | ≤ 5.8 ms |
| `page.url()` round trip | 1.5 ms | 16 ms | ≤ 1.5 ms |

Rules:

- Per-action p50 ≤ Ego Lite's, on the same Mac with the same bench. Linux
  numbers are only indicative.
- The cursor animation is skipped when nobody can see it. Ego's costs nothing
  (one `pointermove` per click), so ours mustn't either.
- If Node's cold start dominates, consider a warm daemon.

An earlier one-run sample (2026-11-19: `goto` 1078 ms, screenshot 2167 ms)
came from a cold run and is superseded by the table above.

## 6. Acceptance rubric

| Part | What | Target |
|---|---|---|
| A. API coverage | Ego's real-browser e2e suite (`package/ego-browser/scripts/real-browser-e2e`, about 45 case files) ported to `tests/e2e`, with `--target ego\|zenius`. Pass/fail per case on both targets; CDP-only cases marked N/A with a reason. | ≥ 90% of non-CDP cases pass on zenius |
| B. Speed | `tests/bench` on both targets, p50/p95 per operation. | §5 |
| C. Real-world tasks | Live-site tasks with per-task rubrics, like Ego's Real-World Bench, run by the same agent and model with each skill. Scored on success, rubric average, turns, wall time and tokens. | ≥ Ego Lite |
| D. UX | Checklist, scripted where possible: Spaces, cursor, takeover, handoff, I1–I4. | all pass |

## 7. Milestones

- **M0.** Walking skeleton (CLI → socket → service → actor → page),
  dev-profile tooling, spikes, Ego baseline numbers.
- **M1.** Core API end to end: `taskSpace`, `goto`, `snapshot`, `click`,
  `fill`, `press`, `evaluate`, `screenshot`, `finish`. I1 holds.
- **M2.** API parity with Ego; ≥ 90% of rubric A.
- **M3.** UX complete, speed passes, comparison report against Ego Lite.
- **M4.** Installed into the user's daily Zen (only with the user's OK), and
  the skill installed for Claude Code and Codex.

## 8. Workstreams

| Worker | Machine | Owns |
|---|---|---|
| `zen-core` | Linux | `runtime/JS/zenius.uc.js`; `modules/` (service, server, spaces, pages registry, persistence, keep-alive); `methods/{browser,spaces,pages}.sys.mjs`; the actor pair; `scripts/`; `docs/SPI.md`; `docs/PROTOCOL.md` (shared, append-only for others) |
| `zen-input` | Linux | `content/{resolve,actionability,input}.sys.mjs`; `methods/actions.sys.mjs` (click, dblclick, hover, dragAndDrop, fill, selectOption, focus, press, setInputFiles, mouse.*, keyboard.*); file-chooser interception; action receipts |
| `zen-observe` | Linux | `content/{nav,evaluate}.sys.mjs`; `methods/{navigation,observe,io}.sys.mjs` (goto, reload, waits, network idle, evaluate, fetch, screenshot, info, dialogs, downloads, events) |
| `zen-snapshot` | Linux | `content/snapshot/`; `methods/snapshot.sys.mjs`; the ref registry |
| `zen-sdk` | Linux | `sdk/`, `skill/`; `tests/security/` (the escape suite for I5, in `scripts/test-all.sh`) |
| `zen-ux` | Linux, then Mac | `ui/`; `methods/ui.sys.mjs` (cursor, takeover, panel, badges, notifications); `clipboard/`, the per-Space agent clipboard's parent side and store (zen-input builds the synthesized chords and `keyboard.paste` on it) |
| `zen-eval` | Mac | `tests/`, `docs/eval/`; Ego Lite baseline and golden snapshots; comparison reports |
| `zen-ux`, with `zen-sidebar` | Linux; zen-sidebar on the Mac | The in-browser agent: `runtime/JS/agent-sidebar.uc.js` and `runtime/JS/agent-sidebar/` (its `vendor/` listed in `THIRD_PARTY.md`), and the '>' dispatch, `runtime/JS/agent-urlbar.uc.js` and `runtime/JS/agent-urlbar/`. zen-sidebar builds on `zen-sidebar/` branches and pushes branches only; zen-ux reviews, adds the headless tests, and merges after test-all |
| `zen-core` | Linux | The MCP server's own files under `sdk/` (`zenius mcp`); `cli.ts` stays zen-sdk's |

Each worker also owns `tests/<area>/` for its own runtime-level tests
(`tests/core/`, `tests/input/`, `tests/observe/` and
`tests/observe-vectors/`, `tests/snapshot/`, `tests/ux/`; zen-sdk owns
`tests/security/`, and zen-ux also owns `tests/parse/`). Give each a
`run.sh` that starts a fresh headless dev Zen. `tests/parse/` needs none:
it compiles every runtime script, and runs none of them.
`zen-eval` owns the rest of `tests/`: fixtures, goldens, e2e and bench. The
SDK's tests stay in `sdk/test/`.

## 9. References

- Ego Lite source (MIT): `git clone --depth 1 https://github.com/citrolabs/ego-lite refs/ego-lite`
  (`refs/` is gitignored). Key files:
  - `package/ego-browser/src/public-api-schema.ts`: options and semantics of
    every public method; our source of truth for parameters.
  - `src/page-model.ts`, `src/element-resolver.ts`, `src/driver/*`: behavior to
    match.
  - `docs/native-bindings-api.md`: Ego's browser-side contract. Ours is
    `PROTOCOL.md`.
  - `docs/native-*-requirement.md`.
  - `package/ego-browser/scripts/real-browser-e2e/`: rubric A.
- Zen internals: unzip the installed 1.24.2b `omni.ja` (Mac:
  `/Applications/Zen.app/Contents/Resources/omni.ja`; Linux:
  `~/opt/zen-1.24.2b/omni.ja` and `browser/omni.ja`) for the exact
  `gZenWorkspaces` code, or read zen-browser/desktop at tag `1.24.2b`.
- Prior art:
  - spaxe-dev/zen-mcp (MIT): Marionette chrome-scope injection, Space API
    calls, background tabs.
  - mikesmullin/mcp-zen (MIT).
  - ErgoZen: experiment API access to `gZenWorkspaces`.
  - DoubleBobCat/zen-mcp: GPL or unclear license. Read only, never copy.
- The user's `agent-sidebar.uc.js` (JSWindowActor plus ACP adapters, in their
  daily profile's `chrome/JS/`): it joins this repo as zenius's sidebar (the
  user's decision, 2026-11-21). install.sh replaces the daily profile's copy,
  with a backup that Undo restores, and never touches the user's other
  scripts (`my-script.uc.js`).
