# Zenius runtime internals (SPI)

How the browser side is put together, and how to add methods and content
code to it. zen-core owns this file; tell zen-core (through the manager) when
something here is wrong or missing.

## Layout

```text
runtime/JS/zenius.uc.js            per-window bootstrap (fx-autoconfig loads it into every browser window)
runtime/JS/zenius/
  modules/                         parent-process modules (zen-core)
    service.sys.mjs                ZeniusService singleton: server, method registry, ctx, actor registration
    server.sys.mjs                 NDJSON over the Unix socket
    spaces.sys.mjs, pages.sys.mjs  task spaces on Zen workspaces; managed pages p1, p2, …
    windows.sys.mjs                host window, tab enumeration, background tab creation, viewState()
    errors.sys.mjs                 ZenError and codes (safe to import in content processes)
    serialize.sys.mjs              toJSONSafe() for results (both processes)
    sandbox.sys.mjs                evalAsync()/evalFunction() in sandboxes (both processes)
    util.sys.mjs                   log(), paths, timing helpers
  actors/ZeniusParent.sys.mjs, ZeniusChild.sys.mjs   the "Zenius" JSWindowActor
  methods/index.sys.mjs            which method modules load, in order
  methods/<area>.sys.mjs           RPC handlers, one module per area
  content/<module>.sys.mjs         code that runs in the page's process, called through the actor
```

fx-autoconfig scans only the top level of the profile's `chrome/JS/`: it runs
`*.uc.js` in windows and imports any top-level `*.sys.mjs` as a background
module. It never looks into subfolders, so everything except the bootstrap
lives under `JS/zenius/`. Don't put a `.sys.mjs` file at the top level.

Window actors (JSWindowActors), each in every frame of tab browsers
(`messageManagerGroups: ["browsers"]`):
- `Zenius` (zen-core, `actors/`): content modules, the page guards at
  DOMWindowCreated, `installGuards`, and zen-ux's guard actors in a task's
  documents. A user's document loads only its module and the leaf
  `content/taskset.sys.mjs`.
- `ZeniusClipboard` (zen-ux, `clipboard/`): made by the Zenius actor in a
  task's documents only (`installGuards()`), it guards a page's own
  clipboard calls there (the Space's clipboard).
- `ZeniusSystemUi` (zen-ux, `ui/systemui/`): made the same way, it guards
  passkey requests and notifications from a task's pages, which would open
  the system's UI over the user's view.
- `ZeniusInput` (zen-input, `input/capture.sys.mjs`, child
  `content/capture.sys.mjs`): web processes only, armed where a task page
  or a page the agent's code hooked lives. Capture listeners for
  mouse, pointer, wheel and dragstart events, which do nothing until zenius
  holds a press or dispatches. On those pages' roots only
  (`content/typing.sys.mjs`), the user's keys, presses, pastes, drops,
  compositions and input events: the Take over's discard of the agent's
  worlds, the typing guard of hooked pages (`input/typing.sys.mjs`), and
  `onSecretTyped` (`input/handback.sys.mjs`).

Every module URL starts with `chrome://userscripts/content/zenius/`. Import
other modules by that full URL; relative imports aren't used.

## Adding methods

Write `runtime/JS/zenius/methods/<area>.sys.mjs`:

```js
import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";

export const methods = {
  "page.title": async (ctx, params) => {
    const { browser } = ctx.resolvePage(params);   // throws ZEN_TASK_SPACE_NOT_FOUND / ZEN_PAGE_NOT_FOUND
    return browser.contentTitle;
  },
};
```

- `methods/index.sys.mjs` already lists every planned area (`navigation`,
  `observe`, `io`, `snapshot`, `actions`, `ui`, …). A listed file that
  doesn't exist yet is skipped, so you normally don't edit the index at all.
  For a new area, add one line.
- Modules load in index order. A later module that defines the same method
  replaces the earlier one, and the log says so.
- They load at the first client connection (the server's `onOpen`, before
  any frame is read), or at any call (`dispatch`) or registry read before
  that. When `spaces.json` lists agent work (a task in any state, or a
  Space whose ownership isn't `user`), they load at the start instead,
  before the socket listens, so a restored agent tab never loads before
  its guards. They also load when the restart rebuild finds a close that
  waits again (a tab marked closing that a window shows): zen-ux's pill
  for it comes with them, and its task is usually gone. That's I4's idle
  cost: on the Linux server most of zenius's +4.7 MiB in
  the main process came from these modules. So a module's import-time
  setup must cover the windows and documents that already exist, as
  zen-ux's, zen-observe's and zen-input's do (enumerate the open windows,
  patch prototypes, register actors and `addGuardActor`). It must also be
  synchronous: the first call runs right after the import returns. The
  start log says `methods at the first connection` until then, and
  `loaded N methods in T ms (why)` when they load, `why` being `agent work
  at the start`, `a connection`, `a call` or `a close waits`.
- A handler gets `(ctx, params)`; `params` is always an object. Return any
  JSON-serializable value (`undefined` is sent as `null`). Throw `ZenError`
  for expected failures; anything else becomes `ZEN_INTERNAL` with a stack in
  `error.data` and a log line.
- A result JSON can't carry: return `new Unserializable("NaN")` (from
  `modules/serialize.sys.mjs`; texts `NaN`, `Infinity`, `-Infinity`, `-0`,
  `123n`, `undefined`). The frame becomes `{id, result: null,
  unserializable: "NaN"}`. A raw top-level NaN, ±Infinity, -0 or BigInt
  result is converted by itself; `undefined` only through the marker.
- A module may also export `access` (how the control gate treats its
  methods) and `pageGates` (readiness checks); see "Dispatch".
- Methods named `dev.*` register only when pref `zenius.dev` is true.
- Every call is timed and logged as `[zenius] rpc <method> <ms>ms <ok|code>`,
  plus `(held <ms>ms)` when the control gate held it.
  `dev.stats` returns count, p50, p95 and max per method, without held time.

## Dispatch

`ZeniusService.dispatch()` runs a chain before each handler:

1. **Control (I3).** For a call that names a `space`, `spaces.gate(rec,
   access)`, by the method's access level:

   | Access | Meaning | Methods |
   |---|---|---|
   | `mutate` | The agent must control the space; waits while a takeover prompt is open. | every method not listed below |
   | `read` | The agent must control the space; never waits. | `pages.list`, `tabs.list`, `pages.userPage`, `spaces.open`, `page.info`, `page.url`, `page.title`, `page.snapshot`, `page.screenshot`, `page.events`, `page.waitFor*`, `download.path`, `download.failure` |
   | `task` | An agent task must be in progress, even one handed to the user. | `spaces.handOff`, `spaces.setState` |
   | `none` | No gate (the method checks ownership itself, or is a tool). | `spaces.list`, `spaces.create`, `spaces.claim`, `spaces.takeOver`, `spaces.waitForControl`, `events.subscribe`, `ui.state`, `browser.*`, `profiles.list`, `dev.*` |

   Each method module declares every method's level, `export const access
   = { "page.foo": "read" };`. `tests/core/registry.test.mjs` fails on a
   method without one, which would get `mutate` (`none` for `dev.*`).
   `dev.registry` lists every method's level.

   Each module also declares each method's I5 class (zen-input's audit,
   `docs/research/method-boundary.md`): `export const i5 = { "page.foo":
   "document" };`, one of `document` (acts in or reads the page's
   documents), `outside` (what the parent knows, or a load whose URL is
   checked), `frames` (content calls checked, no page gate), `none` (no
   content call) and `dev`. `registerMethod` records each method's module,
   access and class, and whether its module declared them. `dev.registry`
   lists them. The registry test fails on a missing or unknown class, and
   on a declared class the gates don't apply.

   The class, not the method's name, decides I5, and fails closed:
   - A method whose module declares no class (or an unknown one) doesn't
     run: `ZEN_INTERNAL`.
   - `document` and `outside` get the page gates (step 2). zen-observe's
     web-content gate checks `document` and lets `outside` by.
   - `ctx.content` refuses every content call of a `none` method
     (`ZEN_INTERNAL`). For `document` and `frames` it checks the frame's
     document (zen-observe's `checkContentCall`); `outside` and `dev` go
     unchecked.
   - A method declared `dev` exists only in dev profiles, as `dev.*` ones
     do.
   - `ctx.i5` is the method's class, for gates and handlers.
2. **Page gates**, for methods declared `document` or `outside`. The
   dispatcher's own comes first: it loads an unloaded tab ("Unloaded
   pages", above). Then each function in a module's
   `export const pageGates = [fn]`, in index order. `fn(ctx, params,
   method)` decides itself which methods it applies to. It returns nothing
   when the page is ready, throws to fail the call, or returns a promise
   only when it must wait. zen-observe's gate (pending navigation, open
   dialog) is the first; its rules are below.
3. **The handler.**

Rules:
- **Frame order.** The chain stays synchronous until a step waits, so a
  handler starts before the server reads the next frame on the connection.
  Register any waiter before your handler's first `await`: the SDK sends
  `waitForEvent` before the action that triggers the event.
- **After any wait, control is checked again**: the user may have taken
  over meanwhile.
- **Held calls.** While control waits for a takeover prompt the call is
  held. It hasn't started: the handler, and every timeout it applies, start
  at release. A request with `progress: true` gets `{id, held: true,
  reason: "paused"}`, then `{id, held: false}` at release, or just its
  error. If its connection closes while held, the call is dropped without
  running. Take over (or Stop) during the hold fails it with
  `ZEN_TASK_SPACE_USER_IN_CONTROL` (or `ZEN_TASK_SPACE_INACTIVE`).
- **`ctx.gate()`** re-runs the control check from inside a handler, as a
  mutating call whatever the method's level, with the same held frames, and
  resolves to the ms held (leave them out of your own timeouts). Call it
  right before acting after a long step: pointer actions call it after
  `moveCursor()`.
- **After a call that activates its Page** succeeds, the dispatcher makes
  it the task's front tab (`pages.noteFront`) and calls zen-ux's
  `notePage(tab)`, so a user who opens the space lands on that page.
  These are Ego's: `pages.new` and the `page.*` methods in
  `ACTIVATING_PAGE_METHODS` (`service.sys.mjs`): navigation, `evaluate`,
  `snapshot`, `screenshot`, page-side waits and every action. Metadata reads
  (`url`, `title`, `info`), `waitForURL`, `waitForEvent`, `events`, the
  dialog methods and `pages.adopt` leave the current Page alone. Add a new
  action method to that set.

## ctx

| Member | What |
|---|---|
| `ctx.resolveSpace(params)` | The space record for `params.space`. Throws `ZEN_TASK_SPACE_NOT_SELECTED` if missing, `ZEN_TASK_SPACE_NOT_FOUND` if unknown. |
| `ctx.resolvePage(params)` | `{space, page, tab, browser, browsingContext}` for `params.space` + `params.page`. `browsingContext` is the tab's top-level `CanonicalBrowsingContext`. |
| `ctx.content(bc, "module#fn", args, opts?)` | Calls `fn(actor, args)` exported by `content/<module>.sys.mjs` in `bc`'s process and returns its result. `bc` may be any frame, including an out-of-process iframe (`browsingContext.children`, or `getAllBrowsingContextsInSubtree()`). `opts.timeout` (ms) turns a hang into `ZEN_PAGE_UNRESPONSIVE`. |
| `ctx.call(method, params)` | Runs another method in-process (gated, timed and logged as internal). `pages.new {url}` uses it to call whichever `page.goto` is registered. |
| `ctx.gate()` | The control check again for this call's space, with held frames; resolves to the ms held. See "Dispatch". |
| `ctx.pageBudget` | The page budget for this request: its top-level `pageBudget` (PROTOCOL "Frames"), else pref `zenius.pageBudget`, else 8. `pages.new` and `pages.adopt` enforce it; snapshot headers show it. `ctx.call` passes it on. |
| `ctx.watchPopups(spaceId, label)` | Collects the popups that page `label` opens: `w.stop()` returns `[{label, targetId}]` for the action receipt. |
| `ctx.emit(event, params)` | Emits an event to in-process listeners and to clients that called `events.subscribe`. |
| `ctx.spaces`, `ctx.pages` | The registries (`modules/spaces.sys.mjs`, `modules/pages.sys.mjs`). |
| `ctx.service` | The `ZeniusService` singleton. |
| `ctx.ZenError`, `ctx.log(...)` | Error class and logger. |
| `ctx.method`, `ctx.conn` | The method name and the client connection (`null` for internal calls). `ctx.conn.state` is a per-connection object you may keep state in. |

Space records have `{id, uuid, name, createdBy, ownership, reason, ended,
paused, stateText, profileId, userContextId, ledger, window}`; `uuid` is
the Zen workspace id. Read them, and change them only through the ownership
API below. Page records have `{label, spaceId, openedBy, key, createdAt,
opener}`; `ctx.pages.tabFor(page)` returns the live `<tab>`, and
`ctx.pages.tabId(tab)` the tab id (`"t12"`) that results carry as `tab`.
Close a tab with `ctx.pages.closeTab(tab)`: it skips beforeunload prompts,
which would wait in a tab nobody sees.

## Ownership (zen-core)

`modules/spaces.sys.mjs` is the only writer of `ownership`, `reason`,
`paused` and `stateText`. zen-ux's prompt and panel call it, and so do the
`spaces.*` methods.

| Call | Effect and event |
|---|---|
| `spaces.setPaused(rec, paused)` | A takeover prompt opened or closed. `spaceChanged {space, paused}` |
| `spaces.setOwnership(rec, ownership, {reason, source})` | `ownership`: `agent`, `agentDelegatedToUser` or `user`. `reason` (Ego's key) is kept only for `agentDelegatedToUser`, default `manual_takeover`. `source`: `agent` (a method), `user` (prompt or panel), `permission` (a permission prompt). An agent task that goes to `user` has ended (`rec.ended`): calls fail with `ZEN_TASK_SPACE_INACTIVE` until a claim. `finish()` also ends its labels, as Ego discards its ledger; after the user's Stop they stay for a later claim. It never changes `paused`. `spaceChanged {space, ownership, reason, source}` |
| `spaces.setStateText(rec, text)` | Ego's setAgentTaskState. `spaceChanged {space, stateText}` |
| `spaces.gate(rec, access = "mutate")` | The I3 check: `null` when the call may go on now, a promise while a takeover prompt holds it (no timeout of its own; it rejects if ownership changes), or a throw: `ZEN_TASK_SPACE_USER_IN_CONTROL` with `data.reason`, `ZEN_TASK_SPACE_INACTIVE`, `ZEN_TASK_SPACE_NOT_FOUND`. |
| `spaces.waitForControl(rec, {timeout})` | Resolves when ownership is `agent` and no prompt is open. |
| `ZeniusService.lookup(tab)` | `{rec, page}` for a managed tab, or null, without refreshing anything (cheap enough for every click). |

Events, from `ZeniusService.addEventListener((event, params) => …)` in
process or `events.subscribe` over the wire: `spaceCreated {space, name,
createdBy, ownership, profileId}`, `spaceChanged` as above (only the keys
that changed, plus `space`), `spaceFinished {space, closedSpace}` (sent
before a closed space's record goes), `pageClosed {space, page, tab}`,
`popup {space, page, tab, opener}`.

Ego's behaviors the methods keep:
- Under user control, reads fail too, as in Ego; they just never wait for
  a prompt.
- `claim` and `takeOver` return `userPage`, the tab the user sees in the
  space, captured in the same synchronous step as the ownership change.
  After a claim, the tabs already in the space stay unmanaged (`unknown`)
  until adopted.
- Labels are never reused within a task. `pages.close` of the last tab
  leaves a blank tab, recorded as the agent's, so `finish()` closes it and
  it never keeps a space open. Tabs of user or unknown origin keep
  `finish({keep: []})` from closing the space; the receipt counts them in
  `protectedTabCount`.
- Records persist in `~/.zenius/state/<instance>/spaces.json` (ownership,
  reason, ended, state text, labels used). Tab ids don't survive a
  restart, so after one a space's tabs are unmanaged, as in Ego.

**The user's say over claims and takeovers** (built; the manager's
decisions on the method audit, item 6; SPEC §3.4). `spaces.claim` of a
workspace of the user's, or of an ended task, waits in `askClaim` below.
- `spaces.noteUserInput(rec)`: zen-ux's takeover detector calls it for the
  user's real input in a task's tabs, whoever controls the task. It sets
  `rec.lastUserInputAt`, in memory only.
- `spaces.checkUserQuiet(rec)`: `takeOver` of a task handed to the user,
  and `claim` of one, fail with `ZEN_TASK_SPACE_USER_IN_CONTROL` until
  `USER_INPUT_QUIET_MS` (10 s) after that input. `data.retryAfterMs` says
  when to try again, and `data.reason` keeps Ego's key. Nothing changes on
  a refusal, so zen-input's clear still runs on the return that follows.
- `spaces.askClaim(rec, {client, timeout, conn})` waits for the user's
  answer to a claim:
  - It emits `claimAsked {id, space, name, client, until}` to in-process
    listeners (`emitLocal`). zen-ux shows the prompt and calls
    `spaces.answerClaim(id, allow)` on a real click.
  - It ends with `claimSettled {id, verdict}`: `allow`, `deny`, `timeout`
    (at `until`) or `gone` (the space went, or the claim's connection
    closed with nobody else waiting).
  - One ask per space: a later claim joins it and its deadline.
  - `spaces.pendingClaims()` lists the open asks, for a window that opens
    meanwhile.
  - Deny and timeout fail the claim with `ZEN_TASK_SPACE_CLAIM_DENIED`
    (`data.verdict`); a space that went fails it with
    `ZEN_TASK_SPACE_NOT_FOUND`.
  - `client` is the name the client gives itself, cleaned by
    `clientLabel()`: no Unicode Cf characters (bidi, zero-width), control
    characters and separators as spaces, at most 40 code points, else
    null. The prompt shows it only after zenius's own words.
- Tests answer as the user would with `dev.answerClaim {space?, allow?,
  timeout?}`, sent alongside the claim on any connection. It answers
  `{verdict: null}` when the claim needed no ask.

### The task feed (zen-core, for zen-ux's sidebar)

Every task's life for the sidebar's directory, whoever drives it
(docs/briefs/external-tasks.md).
- `spaces.feed()` lists the entries now: live tasks (and claimed Spaces
  while a task runs there), then the ended tasks the registry no longer
  holds, from the last day and at most 50. `spaces.json` keeps them across
  a restart (`keptEndedFeed`).
- The `taskFeed` local event (`ZeniusService.addEventListener`) carries an
  entry each time one changes: creation, ownership, the agent's words, a
  rename, the end, and the removal of an ended task.
- An entry is `{space, name, kind, source, state, reason, message, ended,
  createdAt, updatedAt, endedAt}`:
  - `state`: `working` (the agent drives it), `needs_you` (the agent's
    hand-off, or a permission prompt, waits for the user), `held` (the
    user took over) or `done`.
  - `reason`: the hold's key while `needs_you` or `held` (`sign_in`,
    `manual_takeover`, a permission's), else null.
  - `message`: the agent's words (`setState`, which a hand-off's card
    shows), or null.
  - `ended`: `stopped` (the user's Stop), `finished` (the agent's
    `finish()`) or `closed` (its tabs went), only when `done`.
  - `source`: `{terminal?, agent?, folder?, sidebar?}` from
    `spaces.create` or `spaces.claim` (`cleanSource`): each of the first
    three is kept only in the remote label's set (ASCII letters, digits,
    spaces and `- _ . / : @ #`, 1 to 80 once trimmed), and `sidebar`, the
    agent sidebar's conversation (`ZENIUS_SIDEBAR_TASK`), only exactly as
    given, 1 to 64 ASCII letters, digits and `-`. The rest is left out, so
    a task always starts. Show it as text.
- `setOwnership`'s `endedHow` names the end when it isn't the default
  (`finished` when the agent decides, `stopped` when the user does):
  `closed` from the last tab's close and from the Agents Space's removal.
  The agent's next call gets it as `ZEN_TASK_SPACE_INACTIVE`'s
  `data.reason`.
- The steps a task's calls made are zen-input's (`input/steps.sys.mjs`:
  `stepsOf(spaceId)`, `onStep(fn)`), next to the feed, not in it.

### Flagged and listed (zen-core's evidence)

Two of the evidence flag's reasons are zen-core's (zen-observe's
`markEvident`). Both get zen-ux's warning on the page, not a hold or a clean
copy: the danger is the page itself (the manager's call, 2026-11-21).
- `flagged`: `page.flag {space, page, reason}` (`methods/pages.sys.mjs`)
  marks the page's top document with the agent's one-line reason.
- `listed`: from the first task page to the last (I4), the service observes
  `window-global-created`. Each new http or https document of a task tab is
  classified (`nsIURIClassifier.classify`), and one on a phishing, malware,
  unwanted or harmful list is marked with `"<kind>: <list>"`, for example
  `phishing: goog-phish-proto`. Gecko blocks such a page as it loads, so
  this finds the one someone clicked through its warning to.
  `docs/research/safe-browsing.md` has what Zen 1.24's lists do. Tests use
  Mozilla's `moztest-*` entries offline, through `network.dns.localDomains`.

## Content modules

A content module is `runtime/JS/zenius/content/<module>.sys.mjs`; `<module>`
may contain `/` (for example `snapshot/index`). Each exported function you
call through `ctx.content` has the shape:

```js
// content/example.sys.mjs
export async function countLinks(actor, args) {
  // actor is the ZeniusChild (a JSWindowActorChild) for this frame:
  // actor.contentWindow, actor.document, actor.browsingContext.
  return actor.document.querySelectorAll(args.selector).length;
}
```

- It runs in the frame's own process with chrome privileges. Page objects are
  behind Xrays; `Cu.waiveXrays(obj)` sees page-defined properties.
- Only web content processes have the actor (`remoteTypes: web,
  webIsolated, webCOOP+COEP`): never the parent's own tab documents
  (`about:preferences`), nor file, privilegedabout or extension processes.
  A content call there fails with `ZEN_UNSUPPORTED`. A method exempt from
  the I5 check answers such a document from the parent.
- Arguments and return values are structured-cloned across processes: plain
  data only. Return JSON-safe values (`toJSONSafe` from
  `modules/serialize.sys.mjs` helps).
- Throw `ZenError` (from `modules/errors.sys.mjs`) for expected failures; the
  code, message and data reach the client unchanged. Other errors become
  `ZEN_INTERNAL`.
- If the document goes away mid-call (navigation, tab closed, crash), the
  call fails with `ZEN_PAGE_UNRESPONSIVE`, `data.reason: "context_destroyed"`.
- Modules are imported once per content process and cached. Restart the dev
  instance after editing them (`zen-dev.sh <name> restart`).
- To push something to the parent unprompted, call `actor.emit(name, params)`;
  the service re-emits it with `space` and `page` filled in. A content
  process is the untrusted side, so the service takes only the names in
  `CONTENT_EVENTS` (`modules/service.sys.mjs`: `observe.console`,
  `observe.refused`, `observe.sound`), only from a page of an agent task,
  and drops the rest. A new content event needs its name added there.
- Running code in the page's own world: `pageWorldSandbox(win)` and
  `evalFunction()` / `evalAsync()` in `modules/sandbox.sys.mjs`. Results come
  back through an exported callback, so awaiting page promises is safe.

The actor is registered for all frames in tab browsers only
(`messageManagerGroups: ["browsers"]`), with `safeForUntrustedWebProcess:
true`, which Gecko 160 requires for web content processes.

**Page guards.** The actor listens for `DOMWindowCreated`, so its child
exists in every document of every tab.
- Its child imports only `content/taskset.sys.mjs`, a leaf with the checks
  (`isAgentTaskPage`, `isAgentDriven`, `needsRefusals`, …) and the
  sharedData keys. So a user's document loads nothing else of zenius (I4).
  `content/guards.sys.mjs`, `content/refusals.sys.mjs` and the modules a
  call needs load with a task's first document. Both re-export the leaf's
  names. The parent's modules take the keys from the leaf too.
- In a page of an agent task (`isAgentTaskPage`, under any ownership), the
  child installs the page guards before the page's scripts run. That costs
  one Set lookup per document elsewhere.
- In the same documents, top and frames, it makes each guard actor that
  `service.addGuardActor(name)` published (`zenius:guardActors`):
  `this.manager.getActor(name).installGuards()`. zen-ux's guard actors have
  no DOMWindowCreated of their own, so a user's document never makes them.
- Each guard checks `isAgentDriven` per call. So a tab the user holds
  behaves natively, and a page they loaded meanwhile is guarded once they
  hand it back.
- A tab that joins the task-page set already has documents: an adopted tab,
  a task claimed again after the user's Stop, a new page's first document.
  `publishAgentBrowsers()` calls `ZeniusService.installGuards(tab)` for it,
  and `pages.adopt` awaits that.
- `installGuards` sends `"installGuards"` to every guard actor in every
  current document of the tab, the top one and its frames, and waits at
  most 2 s. Each actor's child installs once per document, so a repeated
  request changes nothing.
- Another actor whose child guards documents does the same: its child has
  `installGuards()` and answers `"installGuards"`, and it registers with
  `service.addGuardActor(name)`, which publishes the name. zen-ux's
  `ZeniusClipboard` and `ZeniusSystemUi` do.
- `guards#installed` tells a test whether a document has the page guards
  (`tests/core/guards.test.mjs`).

## Tasks in the Agents Space (zen-core)

The design for SPEC §3.4 and §3.5, approved by the manager on 2026-11-20,
and what runs. The one-workspace-per-task model it replaced, and its pref
`zenius.agentsSpace`, are gone.

**Built** (`tests/core/agents-space.test.mjs`): records, the Agents
Space's lifecycle, placement, each task's own tabs in `tabs.list`,
`pages.list`, `userPage` and `finish`, the session value, zen-ux's tag
attribute, waiting closes with the pill's Close and Keep, the auto-close and
the front tab; the restart rebuild (`tests/core/restart.test.mjs`).

**Records.**
- `modules/spaces.sys.mjs` keeps a record per task and per Zen workspace:
  the `space` ids and `rec` objects the methods use.
- `rec.kind` is `workspace` (the user's, or one an agent claimed) or
  `task` (in the Agents Space).
- `rec.uuid` is the workspace a record's new tabs open in: for a task, the
  Agents Space. There is no separate `home`.
- `spaces.json` version 2 keeps a list of records (version 1 kept them by
  uuid, which tasks share), `agentsSpace {uuid, name, icon}`, and per task
  `lastNamedAt`, for the auto-close. A version 1 file loads as workspace
  records.
- No migration beyond that: the daily install comes after this.

**Which tabs are a task's (built).** A tab belongs to a task while it
carries the session value `zenius` (`TAB_VALUE_KEY`), written with
`SessionStore.setCustomTabValue(tab, "zenius", …)`. `readTabValue(tab)`
in `modules/pages.sys.mjs` reads it:

```json
{"v": 1, "task": 7, "label": "p2", "openedBy": "agent", "opener": "p1"}
```

- Only tasks (`kind: "task"`) write it: a workspace's tabs are its by
  where they are.
- `pages.register` writes it, for pages, popups (`adoptPopup`) and
  adopted tabs.
- `pages.addUnmanaged(rec, tab, openedBy)` writes it without `label`: a
  released page, `finish()`'s kept pages and the task's other tabs, the
  blank tab the last `pages.close` leaves, a tab the user opens from a
  page. The tab stays the task's, unmanaged.
- A tab the user opens from a page of a task that hasn't ended gets
  `{v, task, openedBy: "user"}`: `service.noteOpenedTab(tab, options)`,
  from the `addTab` wrapper. That's decision (b): it never becomes a page
  by its opener alone.
- **The user's own tab.** zen-ux's "Use your own tab" opens a tab for a
  page the user logs in to themselves, then calls
  `pages.markUserOwn(tab)`. That writes a session value of its own,
  `zenius-own` (`OWN_TAB_KEY`), kept across restarts and window moves, and
  drops the tab from any task. No task ever holds such a tab (I2):
  - `tabsOf` leaves it out, so `tabs.list`, `pages.adopt` and a claim of
    its workspace do;
  - `userTab` leaves it out too;
  - `addUnmanaged` refuses it;
  - `spaces.list`'s `recentTabTitles` never shows it.
- **zen-ux's tag.** A task's pages not of user origin carry the attribute
  `zenius-task="<id>"` (`TASK_ATTR`). It's set with the label and removed
  with it (release, `finish`'s keep, `dropSpace`). zen-ux writes
  `zenius-task-state` beside it.
- A tab moving to another window is a new element there: `TabClose` with
  `adoptedBy` copies the value and the tag (`pages.carryOver`).
- The value moves with the tab: a tab the user drags to another Space stays
  the task's.
- Tab ids (`t12`) still don't survive a restart; the value does.
- Lookups stay in memory, in `Pages` (`lookup(tab)`, `findTab`). The value
  is written on each change and read only at start.

**Windows: a page is its sync id** (built; the manager's decision of
2026-11-20, from `docs/research/two-windows.md`; suite
`tests/core/windows.test.mjs`). Zen 1.24 makes every window a view of the
same tabs (`zen.window-sync.*`, on by default):
- Each tab has a copy in every synced window. The copies share Zen's sync
  id, `tab.id`.
- One copy holds the page's docShell, and with it the page's `browserId`.
  Zen moves the docShell to the copy the user selects in the focused
  window, and off a window before the window closes.
- Each copy keeps its own `permanentKey`.

zenius treats a tab's copies as one tab:
- **The live copy.** `pages.tabFor(page)` returns the copy that holds the
  page's docShell, in whichever window. So `resolvePage`, content calls and
  the content guards' browser-id sets follow it. In
  `modules/windows.sys.mjs`, `copiesOf(tab)` lists a tab's open copies
  (most recently used window first), `liveCopy(tab)` gives the one with
  the docShell, and `copyIn(tab, win)` gives one window's copy.
- **Any copy maps to its page.** `pages.lookup(tab)`,
  `pages.forBrowser(browser)`, `service.lookup(tab)` and
  `service.controlOf(browser)` take any copy, live or not.
- **Shown, and counted once.** `isShown(tab)` is true when any copy is
  shown in its window. Tab lists keep one element per tab, the live copy:
  `tabsInWorkspace`, `pages.tabsOf`, `tabs.list`, `spaces.list`.
- **Marks on every copy.** The session values `zenius` and `zenius-own` and
  the tag `zenius-task` go on every copy: copies in windows opened later
  and copies Zen remakes (pin, unpin, Essentials, split view) get them on
  their `TabOpen`. `isUserOwn(tab)` is true when any copy has the mark, and
  a tab the user's own tab opens is their own too (`noteOpenedTab`).
  Keep-alive is on the live copy. A tab's id (`t12`) is the same for every
  copy.
- **Restart.** Zen restores every window with its copies, one state per
  tab (measured with two windows). The rebuild finds one page per tab and
  gives every copy the marks any copy has.
- **Compare with `sameTab(a, b)`** (`modules/windows.sys.mjs`), not `===`:
  two copies of a tab are the same tab.
- **`pageMoved`.** When a page's live copy changes, the service emits
  `pageMoved {space, page, from, to}` with `service.emitLocal`, in process
  only, since it carries the elements.
  - zen-ux moves the pill and the cursor to `to`.
  - State of your own keyed by a `<tab>`, a `<browser>` or a
    `permanentKey` starts fresh on the new copy. Key it by the page's
    `browserId`, which moves with the docShell, or move it on `pageMoved`.
- Without a sync id (window sync off), a tab is its own only copy.

**The Agents Space.**
- `spaces.create` calls `#ensureAgentsSpace(win)`. That creates it once:
  `createAndSaveWorkspace(name, icon, dontChange = true, 0)`, which
  propagates it to every window without switching any of them, with the
  name and icon it last had (default "Agents").
- It has no record: `spaces.list` lists its tasks, not the Space.
- `spaces.agentsSpace` is `{uuid, name, icon}`, `uuid` null while it
  doesn't exist; `spaces.isAgentsSpace(uuid)` tests a tab's workspace.
- After each task tab's close and each task's removal,
  `spaces.maybeRemoveAgentsSpace()` removes it if no tab is in it and no
  window shows it. A rename or new icon from the user is noted at each
  `refresh()` and kept.
- A user who deletes it sends no event. `refresh()` notices, and so does
  the tab-close path, since every task's pages close. Both end those tasks
  with `source: "user"`.

**Opening tabs.**
- `addBackgroundTab(win, uuid, {userContextId, place})` in
  `modules/windows.sys.mjs` adds an `about:blank` tab with `inBackground`,
  `skipAnimation` and `skipBackgroundNotify`, then moves it into the
  Space: with `place`, else with Zen's `moveTabToWorkspace`.
- `pages.addTab(rec, win)` adds it and places it: a page, or the blank tab
  `pages.close` leaves. A popup comes through the `addTab` wrapper (with
  the same three options), and `adoptPopup` calls `pages.moveIn(rec, tab)`.
  - Placement is `placeTab(tab, uuid, after)`: right after `after`, the
    task's last tab (or the folder or split view holding it), else at the
    bottom. A tab from another Space enters in that one move.
  - While any window shows the Agents Space and its strip can't scroll
    (`pages.stripCanScroll(win)`; zen-ux's), the tab goes to the bottom.
    `pages.settle()` moves it next to its task once no window shows the
    Space, on a window's next `TabSelect`.
  - It moves no other tab.
- **Window sync and placement** (measured on Zen 1.24.2b,
  `docs/research/two-windows.md`):
  - Zen copies a new tab into the other windows from its `TabOpen`
    handler, and moves the copies on `TabMove`, to where the tab is at
    that moment. In an RPC call the handler runs inside `addTab`; in a
    promise job, right after.
  - `moveTabToWorkspace` puts a tab at the top of the Space
    (`zen.view.show-newtab-button-top` is true by default). So
    `placeTab` moves a tab into the Space at its place in one move, and
    the copies land there too.
  - Tabbrowser fires `TabMove` only when a tab's index changes, and
    `gBrowser.tabs` lists only the Space the window shows. A move inside
    a Space the window doesn't show fires none, so `placeTab` then calls
    window sync's own move handler for the copies.
  - Copies of an agent tab open as the tab does: the `addTab` wrapper
    adds `skipAnimation` and `skipBackgroundNotify` while
    `copyingAgentTab()` says window sync is copying one. Zen's open
    animation would slide a window's tabs down over 120 ms, and Firefox's
    background-tab notification scrolls a strip to the new tab.
  - Window sync animates its move of a copy in a window that shows the
    copy's Space (`handle_drop_transition`), as a drag from where the copy
    sat: from a Space that window doesn't show. The tabs in between start
    a row off and slide back over about 300 ms. The guards wrap each
    window's `tabDragAndDrop.handle_drop_transition` and skip it for
    copies of a tab zenius placed in the last 2 s (`zeniusPlaced(tab)`;
    `placeTab`, `addBackgroundTab` and `pages.moveIn` call
    `notePlacing`). The user's own drags still animate.
  - A window can lack a copy for good. Zen hands a new window the other
    windows' tabs as a first window's state, and Firefox's
    `restoreWindow` drops a first window's lone tab with no history: a
    window opened while a new agent page is the session's only tab gets
    no copy of it. Window sync puts a copy after the copy of the tab
    before it and does nothing when that one is missing, so the next
    page's copy stays where it opened, in the Space the window shows.
    So `registerWindow` makes a new window's missing copies of agent
    pages (the Agents Space's and claimed workspaces'), once its window
    sync is ready (`fillCopies(tabs, win)`; made as Zen's `on_TabOpen`
    makes one). After each placement, `repairCopiesSoon(tab)` makes the
    copies a window's strip lacks up to the tab. `fillCopies` runs only
    in a promise job: Zen's queued `TabOpen` handler must find the copy's
    sync id set, or it would copy the copy into every window.
- `pages.keepView(fn)` runs every strip change zenius makes and returns
  its value: `addTab` from the add on (which passes through the window's
  active Space), a popup's add and move, `closeTab`'s `removeTab`, and
  `settle()`. zen-ux's view keeper replaces it: Zen's strip has no scroll
  anchoring. For an add, it puts every window's view back once window sync
  has made the copies (`syncedSoon`).

**Closing tabs (built).** `pages.closeTab(tab)` is how agent code closes
a tab, for every kind of record. It returns whether the close waits.
- A window *shows* a tab (`isShown(tab)`, `shownTabs(win)` in
  `modules/windows.sys.mjs`) when the tab is the window's selected tab, or
  in the split view holding it (Zen's `split-view-group`). Minimized or
  covered windows count (SPEC §3.5); with window sync, each window counts
  on its own. Being on screen is for what depends on being seen (zen-ux's
  checks).
- A tab no window shows closes at once, inside `pages.keepView`.
- A shown tab waits, and leaves its task now: its label ends
  (`pageClosed` goes out), the tag and keep-alive go, and its session value
  gets `closing: true`. The service emits `tabClosing {space, tab}` with
  `service.emitLocal`, in process only, since it carries the element: that's
  zen-ux's "Task finished" pill.
- The tab closes on the first of these:
  - a `TabSelect` in its window that leaves it unshown (another tab, or a
    workspace switch): `pages.closeLeft()`;
  - `service.closeDeferred(tab)`, the pill's Close.
- `service.keepDeferred(tab)`, the pill's Keep, ends the wait: the tab
  stays as the user's, a tab of user origin of its task while the task
  exists (a plain tab once it's gone). A waiting tab dragged to another
  window is the user's too.
- `pages.close` returns `{ok, deferred}`, and `finish` counts waiting tabs
  in `pendingCloseCount` (PROTOCOL). A `finish` that closes the task leaves
  the Agents Space while a waiting tab is in it; it goes after that tab.
- `finish` never removes a workspace (SPEC 3.4). On a claimed workspace of
  the user's, even with no tab of theirs left, it closes the agent's pages
  and ends the task, and the workspace stays the user's: `closedSpace`
  false. `spaces.remove` deletes a workspace only for test cleanup, and not
  while a window shows it.
- An Agents Space left empty while a window shows it (the user closed its
  last tab there) goes at that window's next `TabSelect` elsewhere.
- At start, tabs marked `closing` close, unless a window shows them
  (step 4).

**The auto-close (built).** SPEC §3.4, at Zen start (step 4) and when a
client connects (the server's `onOpen`, before the client's first frame):
- `service.isIdleTask(rec)`: a task the agent owns (not paused), never
  handed to the user (`rec.handedToUser`, set by any move to
  `agentDelegatedToUser`), all of whose tabs the agent opened, that no
  client named for `zenius.autoCloseHours` (default 72; 0 turns it off).
  zen-ux's panel marks the same tasks.
- `rec.lastNamedAt` is updated by `ctx.resolveSpace`, so any method with
  `space` counts, and saved at most once a minute per task.
- `service.closeIdleTask(rec)` closes it as `finish({keep: []})` does
  (`finishTask` in `methods/spaces.sys.mjs`), waiting closes included: the
  auto-close and the panel's one-click close.

**Which tabs a task has (built).** `pages.tabsOf(rec)`: a workspace
record's are every tab in its workspace; a task's are its pages and the
tabs its ledger keeps unmanaged (`ledger.unmanaged`, tab id → origin).
`tabs.list`, `findTab`, `inventory` (so `finish`) and zen-snapshot's
untracked count go through it. A finished task's kept pages stay in its
ledger, unmanaged; the task goes when its last tab closes.

**`userPage` and `active` (built).** A task's `userPage` is the task's tab
a window shows (its front tab, if a window shows that one). Otherwise it's
the task's front tab, `pages.frontTab(rec)`: Ego's current Page, the tab the
user would see on opening the task, where zen-ux's panel Open lands.
- The front tab is whichever came last of:
  - a tab the agent made current: `pages.new`, an acting call
    (`ACTIVATING_PAGE_METHODS`, from `#afterCall`), keys and the cursor
    (zen-ux's `notePage`, which the service follows with `onNotePage`);
  - a task tab the user selected (`TabSelect`).
- Else it's the task's first page, else its first tab. If the front tab
  closes, the same fallback applies.
- It's kept in memory: after a restart it's the first page until one of
  those happens.
- It moves no window (I1). `pages.list`'s `active` marks the same tab
  (`pages.userTab(rec)`). The manager approved this on 2026-11-20.

**Restart (built).** The first window starts the rebuild (or a timer, 30 s
after start, if no window comes). It waits, at most 30 s in all, for
`SessionStore.promiseAllWindowsRestored` and then every window's
`gZenWorkspaces.promiseInitialized`: until a window's tab strip is set up,
Zen's `allStoredTabs` lists only part of its tabs (a flake under load).
Then:
1. `spaces.healAgentsSpace()` sorts out the Agents Spaces Zen brought back,
   by zenius's mark (below).
2. Each tab's value puts it back in its task: under its label if it was a
   page (`pages.reattach`), else as an unmanaged tab of its origin. A tab
   marked `closing` closes, or waits if a window shows it, as §3.5's closes
   do. A value naming a task that's gone is deleted.
3. Tasks none of whose tabs came back are removed, which frees their names.
   Their ids go into a list in `spaces.json` (the last 64). A call naming
   one fails at once with `ZEN_TASK_SPACE_NOT_FOUND`,
   `data.reason: "not_restored"`.
4. `publishAgentBrowsers()` runs, and documents restored tabs already have
   get their guards. With `zen.workspaces.continue-where-left-off`, a
   window on the Agents Space at the quit loads its selected agent page at
   start, before the rebuild.
5. `maybeRemoveAgentsSpace()` runs, then the auto-close.

`dispatch()` holds every call until the rebuild ends, in arrival order. The
rebuild reads no network and no page.

**Unloaded pages (built).** Zen restores tabs unloaded, and the user can
unload one. Before a `page.*` method runs on a page whose tab is unloaded
(`pending`, or with no browser yet), `dispatch()`'s first page gate acts
(`pages.close` isn't a `page.*` method: the tab closes unloaded):
- `page.goto`: inserts the tab's browser (`gBrowser.insertBrowser`), then
  waits for `SSTabRestoring`, Zen's sign that the tab's history is back.
  Only from then on does Zen's session restore take a load in the tab as
  the tab's restore. Earlier, it would later restore the saved page over
  the agent's. goto's own load follows.
- Any other method first checks the URL the tab shows (its current history
  entry) with zen-observe's `checkAgentLoad()`.
  - If agents can't load it (the user took the tab to `about:preferences`
    or a `file:` page), the call fails with `ZEN_URL_NOT_ALLOWED`,
    `data.reason: "unloaded"`. The tab stays unloaded.
  - Otherwise the tab loads that URL through `page.goto` (`waitUntil:
    "load"`, the call's `options.timeout`): the agent's own load. It never
    carries the system principal of a load the user typed, and never loads
    a URL the user only typed. Then the call goes on.
  - If that load fails, a method that acts in the document fails with its
    error; the others go on.

So a Zen start loads no agent page itself, which keeps I4's "nothing until
an agent connects". The goto adds a history entry, so one `goBack()` after
it returns to the same URL.

**Crashes.** Zen restores a crashed session (`resume_from_crash`, on by
default, off in the dev profiles) from its own `zen-sessions.jsonlz4`. That
file holds what its last periodic save collected, and a save drops tabs
without history entries. Firefox collects a new tab's history late: in a
dev Zen, a tab loaded 1.5 s before still had none. So a tab opened just
before a crash doesn't come back, and a task with no tab saved yet ends as
`not_restored`. The crash test flushes the tab states before its `kill -9`,
as a later save would have them.

A clean quit has one such limit too. Zen's save keeps a blank tab
(`about:blank` and no other history) only once it has a sync id
(`ZenSessionManager`'s `#shouldCollectTab`). A task whose p1 was still
blank and had opened just before the quit sometimes didn't come back in
the ownership test, which now loads a page in each p1 first.

**The Agents Space's mark (built, 2026-11-20).** zenius knows the Agents
Space it made by a mark in the Space's own object in Zen, `zenius:
"agents-space"` (`MARK_FIELD`, `AGENTS_MARK`, `hasAgentsMark()` in
`modules/spaces.sys.mjs`), never by its name.
- **Why.** `spaces.json` records the Space's removal at once, but Zen
  writes its Space list only with a session save, and creating or removing
  a Space causes none. A kill or a crash in between brought back an Agents
  Space that `spaces.json` no longer named, and `refresh()` took it for one
  of the user's. Each such run left one more empty "Agents" on a profile
  kept between runs (the Mac's `coretest-eval`), and a crash or a
  force-quit would do the same in the daily Zen.
- **It lasts.** Zen 1.24.2b keeps a field it doesn't know through all it
  does with a Space: rename, icon and container edit the object in place,
  window sync shares the objects, `getWorkspacesForSessionStore` copies
  each one whole, restore takes them back, and the Spaces sync applier
  merges into the existing object. Sync's records name their own fields, so
  the mark never leaves the device.
- **Saved.** Once every window's Space list has the Agents Space zenius
  made, or has dropped the one it removed, zenius saves the session
  (`saveSessionWhen`, `SessionSaver.run()`), and Zen writes its own file in
  that save. Zen updates each window's list a tick after a removal, or after
  the switch away from a Space the window showed, so a save at once would
  write the old list.
- **At start** (rebuild step 1), `healAgentsSpace()`:
  - marks the recorded Agents Space if it has no mark (made before the mark
    existed);
  - with no Agents Space, adopts a marked Space that holds tabs, or that a
    window shows: restored tabs go back to their tasks there;
  - removes any other marked Space that's empty and that no window shows;
  - leaves any other one, and logs it. It renames it "<name> (old)" once,
    so the user can tell it from the Agents Space, which likely has the
    same name (the manager's call: it's zenius's own Space).
    `browser.health`'s `strayAgentsSpaces` lists it with its `position` in
    Zen's Space switcher, so `zenius doctor` warns and the user can find it
    and remove it.
- **Never by name.** A Space without the mark is never touched: a Space the
  user named Agents stays theirs. Agents Spaces an earlier zenius made and
  no longer records have no mark either, and stay as Spaces of the user's.
  `refresh()` never registers a marked Space as the user's.
- **Sync.** If the user signs in to Sync and turns on Zen's Spaces engine
  (`services.sync.engine.spaces`, off by default), the Agents Space reaches
  their other devices as a plain Space, without the mark. Keeping it out of
  Sync's records is planned after the install.
- **Tests** (`tests/core/restart.test.mjs`): a kill after the finish, with
  Zen's saves stubbed out: an empty marked Space goes at the start, and a
  Space the user named Agents stays; one with a tab becomes the Agents
  Space again; zenius's own save puts the Space in Zen's file and takes it
  out. `tests/core/lib.mjs`'s `close()` removes the Spaces a file's tests
  made, and saves.

**Guards (built).** `publishAgentBrowsers()` publishes two sets of
browserIds:
- `AGENT_BROWSERS_KEY`: pages of tasks whose ownership is `agent`.
- `TASK_BROWSERS_KEY`: pages of agent tasks under any ownership.

Guard actors install in every document of a task page at DOMWindowCreated,
and check the agent-driven set per call. A tab that joins the task-page set
gets `ZeniusService.installGuards(tab)` for the documents it already has.
Actors register with `addGuardActor(name)` and answer `"installGuards"`.

**The back-forward cache (built, 2026-11-20).** A document Back or Forward
restores from the bfcache comes back with a `pageshow` (persisted), not a
DOMWindowCreated, so the guards miss it: a tab that joined a task with
pages from before would bring them back unguarded (zen-snapshot's
adoptBack and userTabBack, `docs/research/device-bypass.md` §1). So
`publishAgentBrowsers()` empties a tab's bfcache
(`sessionHistory.evictAllDocumentViewers()`, by browserId):
- when the tab joins the task-page set (adopt, a claim, a task claimed
  again after a Stop, a page's first publish), before its documents get
  their guards;
- when it leaves it (finish's kept pages, release, the Stop):
  the documents it had in the task, the agent's code and the guards
  included, don't come back into the user's session. Back loads them
  afresh, as the user's.

The page on screen stays. A browserId moves with the page's docShell
between window copies, so a window move is neither. Within a task, Back and
Forward use the bfcache as usual: those documents were guarded when they
were made. Tests: the three bfcache tests in
`tests/core/guards.test.mjs`, on pages of their own (the fixture's are
no-store, which Gecko never caches). They check the history entry's
`isInBFCache` before each eviction: a page left during its load is never
cached, and without that check a test could pass with no eviction at
all.

**Decisions** (the manager, 2026-11-20, on this design):
1. **The Agents Space goes once it's empty and no window shows it.**
   `spaces.json` keeps its name and icon, and `ensureAgentsSpace` reapplies
   them, so a rename by the user survives removals.
2. **Claiming a user's workspace works there**, after the user approved, as
   in Ego.
3. **The user closing a task's last tab ends the task**, as the panel's Stop
   does. The `TabClose` handler sees the task's last tab go and calls
   `setOwnership(rec, "user", {source: "user"})`.

**Who changes what.**
- **zen-core:**
  - records with `kind`, and the session value;
  - the Agents Space's lifecycle;
  - placement and flags in `addBackgroundTab` and popups;
  - `closeTab` and its deferral;
  - the restart rebuild;
  - `userPage`/`active` and `tabs.list` per task;
  - `finish` and the auto-close per task;
  - `bringToFront` recording the front tab.
- **zen-ux:**
  - the per-tab task tag, which kept pages and other tabs left to the user
    don't carry;
  - the panel's grouped view and its Open;
  - the "Task finished" pill, on `tabClosing`;
  - the view keeper;
  - no more `lastSelectedWorkspaceTabs` writes;
  - the needs-you badge on the Agents Space;
  - takeover per task (its lookups already go tab → task).
- **zen-sdk:** the Skill's wording ("each task runs in its own Zen Space").
  No API change.
- **zen-input, zen-observe, zen-snapshot:** none expected. They address
  pages by label, and `dispatch()` loads an unloaded page before their
  methods run.
- **zen-eval:**
  - a restart on the Mac with the daily restore setting;
  - the look of the tag and the pill, light and dark;
  - two windows showing the Space.

**Tests.** Each I1 rule gets a test with a window showing the Agents Space,
measured as zen-ux's probe did: the selected tab, the active Space, the
strip's `scrollTop`, and the user's tab's place on screen.
- A new task, a page and a popup while the user views the Space: none of
  the four changes.
- `finish()` with a shown tab: the tab waits, then closes on `TabSelect`;
  the Space is never empty.
- `bringToFront` changes none of the four.
- The landing tab after the user switches away and back.
- A restart with `browser.startup.page` 3 (`ZENIUS_DEV_PREFS`): the tasks,
  labels and origins come back, unloaded. A page call loads its page as the
  agent's own load, with the guards (built).
- A crash: `kill -9` of a dev Zen with tasks open, with `resume_from_crash`
  on. They come back the same way (built).
- A task whose tabs didn't come back: the agent's next call fails at once
  with `ZEN_TASK_SPACE_NOT_FOUND` (built).
- A restored task tab the user had taken to a browser page (`about:robots`
  in the test) stays unloaded, and a page call on it is refused (built).
- A window on the Agents Space at the quit, with
  `continue-where-left-off`: its agent page loads at start and has its
  guards at the first call; a closing tab it shows waits (built).
- A start that restores no tabs ends every task, and the empty Agents
  Space goes (built).
- The user closing a task's last tab ends the task.
- The Agents Space's name and icon survive its removal and re-creation.
- The auto-close per task, with a shown tab.

## Closed groups (zen-core)

The rule (the manager's decision on zen-snapshot's I1 map; the plan is
`docs/research/user-tab-reach.md`, "Fix: closed groups"): a document where
the agent's code can run never shares a browsing context group with a
window outside its task, during the task or after it. Gecko groups a window
with every window it opened with an opener, and code in one reaches the
others through `opener`, named lookups and message sources.

`modules/pages.sys.mjs`:
- `pages.outsideTask(space, tab)`: how many top-level windows in the tab's
  group (`group.getToplevels()`) aren't pages of the task. A top counts by
  its `browserId`, so a page's own documents in the back-forward cache
  (which Gecko keeps in their old group, with `isInBFCache`) are its own. A
  top with no embedder and nothing in the cache is a window still opening:
  it's in a tab before code could use it, so it doesn't count.
- `pages.codeRefusal(space, page)`: `{reason: "group", windows}` or null.
  Once a check finds a window outside the task, the page never runs the
  agent's code again while it's in the task (the mark is per page record,
  in memory: a restart gives every tab a group of its own). `register()`
  checks when a tab joins a task (`pages.new`, `pages.adopt`, popups).
  Every method that runs the agent's code checks before each call:
  zen-observe's `page.evaluate`, `page.waitForFunction` and `page.goto`
  to `data:` or `blob:`, and zen-input's paste with `html`. They raise
  zen-observe's `ZEN_AGENT_CODE_REFUSED`. No URL of the user's window goes
  in the reply. While the tab's document isn't in a web content process,
  there's no answer (null) and nothing is kept: an add-on's page
  (`about:compat`, any `moz-extension:` page) shares its group with the
  add-on's background page, which is no window of the user's. zenius runs no
  agent code in such a document, and a load from it to the web gets a
  group of its own.
- `pages.groupMates(space, page)`: the task's other pages in the page's
  group. `pages.release` refuses a page that has any
  (`ZEN_PAGE_GROUP_SHARED`), unless `group: true` releases them all.

Openings during a task (item 2): `popupRoute` (the `gBrowser.addTab`
wrapper, `modules/guards.sys.mjs`) makes an open with an opener
(`openWindowInfo` with `forceNoOpener` false: `window.open`, a named
target, a `rel=opener` link, a feature popup) from a page of a live task
(`spaces.isAgentTask`) a page of that task, whoever opened it: the agent,
the site's code, or the user during a hold. During a hold it opens where
and as Zen opens any popup (the user clicked), then joins the task. An
open with no opener has a group of its own and is routed as before: the
agent's while the agent drives, else a tab of user origin.

After the task (item 3): the same wrapper module replaces each browser
window's `browserDOMWindow.createContentWindowInFrame` (an own property
on its `wrappedJSObject`). `service.openRefusal(params)` refuses an open
with an opener when the opener isn't a page of a live task and its group
holds a document with the agent's code (zen-observe's
`agentCodeDocument` over `getToplevels()`; zen-ux's kept mark counts,
and goes by site). The wrapper then throws `NS_ERROR_ABORT`: the page's
`window.open` returns null, as for a blocked popup, and nothing opens.
Returning null instead would make Gecko open a new window. Nothing opens
in its place: the hook gets the same `params` for a form's POST as for a
GET, and a POST never becomes a GET. While `AGENT_CODE_DOCS_KEY` is empty
the check returns at once, without loading `agentcode.sys.mjs` (I4).

Popup windows (items 2 and 3 for windows; zen-eval's Mac finding). A
feature popup (`window.open` with a size or position) opens as a window
under Firefox's default `browser.link.open_newwindow.restriction` (2), on
the Mac and on Linux alike, and a window never reaches the tab hooks above.
Two layers:
- The content side's `window.open` (`content/guards.sys.mjs`) drops size
  and position features, so the popup becomes a tab and meets the hooks
  above. It does so in a task's page, the user's hold included, and after
  the task in a document with the agent's code (`isAgentCodeDocument`).
- A window that opens anyway (`document.open(url, name, features)` is
  `window.open` without that wrapper) meets zenius's window creator.
  `setPopupWindowGuard` (`modules/guards.sys.mjs`) wraps the app's
  `nsIWindowCreator` (`Services.ww.setWindowCreator`, delegating to
  `Services.startup`'s) while a task is live or a document is marked.
  `service.updatePopupWindowGuard()` decides, at `publishAgentBrowsers`
  and from zen-observe's `syncHooks` as the marks change. Otherwise the
  app's creator is untouched (I4). `createChromeWindow` gets the open's
  `openWindowInfo`, but not its URL.
  - Item 3: `openRefusal({openWindowInfo})`, then
    `noteOpenRefused({browser, url: "", reopened: false})` and
    `NS_ERROR_ABORT`. The page's `window.open` (or `document.open`) gets
    null, and no window exists. Don't close a popup window in its first
    moments instead: in Gecko 160 the opener's `window.open` then never
    returns.
  - Item 2: the window is made. At its `browser-delayed-startup-finished`,
    `service.joinPopupWindow` moves its tab into the opener page's window
    with `gBrowser.adoptTab`, then labels it as `adoptPopup` does (tag,
    label, `popup` event), and the popup window closes. `adoptTab` keeps
    the browsing context, so the page's handle and `opener` still work.
    During a hold the tab comes to the front, as Zen shows a `window.open`
    it turned into a tab, unless `browser.tabs.loadDivertedInBackground`
    is set.
  - `nsIWindowWatcher` has no getter for the creator, so turning the guard
    off restores `Services.startup`'s. Nothing else in Zen sets one.

`modules/windows.sys.mjs`: `onOpenRefused(fn)` (returns a remover) and
`noteOpenRefused({browser, url, reopened})`. Item 3 calls the second for
each open it refuses, with `reopened: false`; zen-ux's pill listens and
says the page can't open windows until it reloads, with Reload.

Kept pages' refusals, for zen-ux. Under the user's decision (A), a page
whose top document holds the agent's code keeps the task's refusals after
the task, and zen-ux's handler is how
one there, right after the user's own click or key, reloads the page
quietly (`cleanLoad`); it also feeds the card of a page the agent made.
`onKeptRefused(fn)` (returns a remover) and `noteKeptRefused({browser,
kind, api, asked})`, in `modules/windows.sys.mjs`. After its task, a tab
whose top document holds the agent's code keeps the task's refusals
(`content/refusals.sys.mjs`). The service's `onContentEvent` drops
`observe.refused` from a page no live task holds, except that it passes
one from a web-content document whose tab's top document is marked
(`agentCodeDocument`) to `noteKeptRefused`. Since the event comes from the
page's own process, only a kind in `KEPT_REFUSAL_KINDS` passes, and `api`
and `asked` (zen-observe's) are cut to `KEPT_TEXT_MAX` (80) characters.
zen-ux checks that the user's own input came just before.

## The hand-off (zen-core)

The manager's rule (2026-11-20), on evidence since the user's call
(2026-11-21, `docs/briefs/defenses-evidence.md`, A1 to A3) and for the
safety rubric's test a (page code capturing what the user types after a
takeover), in this order: nothing the agent's code left can reach what the
user types in the page they hold (H); H keeps its opener when it can; only
a document the agent's code left something in loads afresh, never one
that is only reachable from such a document (the rubric's rule 3). That's
zen-observe's evidence flag ("The evidence flag",
`observe/evidence.sys.mjs`) with reason `hooked`, what the agent's code
left that outlives the discard of its world, read by `evidenceOf` and
`needsCleanCopy` in `modules/handoff.sys.mjs`. A page the agent made
(`made`, a data: or blob: page it opened) comes back the same from a
reload, so it is refused to the agent or held as it is. `cleanable` is
either reason, the evidence of the agent's code that the hold's COOP, its
channel mute, its refusal of new windows and the refusal events key on.
Filling, clicking, reading and plain text are no evidence. A `listed` or
`flagged` page gets zen-ux's warning, never a reload or a clean copy: the
danger is the page itself, which a reload brings back (the manager's
call). zen-observe keeps everything else away while H is held (`holdPage`
in `observe/hold.sys.mjs`). zen-core picks the remedy and does the loads
(`modules/handoff.sys.mjs`).

Entry points (`modules/service.sys.mjs`):
- `holdForUser(rec, browser, {source, reason})` holds H, makes it safe,
  then calls `setOwnership(rec, "agentDelegatedToUser", {reason, source,
  reloaded, carried})`. Its `spaceChanged` carries `reloaded` ("reload" or
  "get") only when H itself loaded afresh, and `carried: true` when a field
  came back filled. `spaces.handOff` calls it for the task's front page
  (`pages.userTab`) and refuses a page the agent made
  (`ZEN_HANDOFF_REFUSED`, `agentPage`). zen-ux's `userTakeOver(rec,
  browser)` holds that page as it is. On a page of a task that is already
  held, it holds and loads that page too, without a `spaceChanged`: its
  result says what happened. Its `evidence` maps each reloaded page's
  label to the evidence it had before its load ({reason: detail}), for
  zen-ux's notice.
- Secret steps: `spaces.handOff {secret: true}` notes H
  (`noteSecretStep`), and `spaceChanged` says `secret: true` for zen-ux's
  card. At the hand back, `blankSecretSteps(rec)` runs before anything
  else. That's `spaces.takeOver` and `spaces.claim` through `handBack`, and
  the user's Resume through zen-ux's `beforeHandBack`, which calls it first
  (zen-core's glue). For H and the popups that share its hold (`heldWith`),
  `blankTab` loads `about:blank`, waits until that entry is the history's
  last, and purges the rest, so neither back nor the back-forward cache
  brings the secret back. A tab that won't blank is closed. The hand
  back's notes say `blanked`. The task's end drops its secret steps.
  With zen-ux's quiet loads off (a test switch), Resume doesn't run
  `beforeHandBack`, so nothing is blanked there.
- `cleanLoad(browser)`: the quiet load alone, for zen-ux's Resume.
- Landing (2), the clean loads under the isolated world, on evidence:
  - `evidenceOf(target)`, the page's evidence over its top document and
    frames (unreadable, it counts as hooked), and zen-observe's
    `urlBefore(target)` (an error counts as no URL), read through the
    service. `needsCleanCopy(target)`: hooked, and not made, since a page
    the agent made comes back the same from a reload (zen-input's guard
    drops the typing there instead).
  - `cleanOnDemand(browser)`: zen-input's typing guard calls it at the
    user's first press or key in a hooked page. Such a page loads afresh
    as H's quiet load does, staying on its site, its form carried over and
    the focus on the field the user went for (content
    `forms.noteUserTarget(field)`, which zen-input calls first). It
    resolves `{how: null}` when the page needs no clean copy, rejects when
    no new document came, and puts the page in the task's hand back notes.
    Its result's `evidence` is the page's as the press came, before any
    load, for zen-ux's notice.
  - It also rejects, before any replay, when the new document came in with
    evidence of the agent's code. That happens when the agent's code, in
    another window of its group (a popup on its site, or the page that
    opened it), leaves something in the copy as it comes in. The tab's
    typing stays held on that copy (zen-input's `dropUserTyping` release
    with `{failed: true, holdNow: true}`), until the page loads again. On
    99cdc39 the replay set off the next clean copy there, without end
    (zen-snapshot's Take over probes, when a document beside a hooked one
    came in marked). The error has `stillEvident` and the copy's
    `evidence`.
  - At most 5 clean copies on demand per tab in 60 s (`CLEAN_COPY_CAP`;
    tests set `service.cleanCopyCap`). Past that it rejects before loading,
    and the typing stays held.
  - The keys the user types while that load runs go into the clean copy
    (zen-input's replay, bf4eaf9): `forms#record` says whether its
    `focused` is the noteUserTarget field (`userTarget`), and when
    `forms#fill` puts the focus back on that field, `forms.userFieldBack(doc)`
    names it. zen-input's guard types the replay only into that field.
  - The task's end (`endTaskCode(rec, closing)`), once per end. finish()
    calls it before endTask, while the tabs are still the task's (endTask's
    publish drops them from `zenius:taskSpaces`, where a `{task}` discard
    looks). Stop and a task's last tab closing reach it through the
    ownership event. Every discard goes out at once: the `{task}` one, and
    `discard(browser)` for the group of each of the task's tabs, kept pages
    included. Then each tab that stays open and needs a clean copy loads
    afresh the same way, each on its own (`reloadHookedAfterTask`). One
    whose load brings no new document keeps its evidence.
  - One clean load runs per page at a time: the user's press during the
    task's-end reload (`cleanOnDemand`) shares it.
  - `onOpenRefused` and `onKeptRefused` events carry `evident: true` and
    the page's `evidence` ({reason: detail}) when it has evidence of the
    agent's code (`cleanable`: hooked or made), and leave both out
    otherwise: zen-ux then reads the page.
  - During a hold, a load of H gets COOP when a window it would join,
    outside the hold, shows the load's site and has evidence of the
    agent's code (`cleanable`): H is never reachable from what the agent's
    code left. `openerCut` is noted when H had an opener.
- `noteReloaded(rec, browsers)` and the hand back's notes:
  `spaces.takeOver` and `spaces.waitForControl` report `reloaded` (labels)
  and `openerCut` once (`spaces.takeHandBackNotes`). A hold's start clears
  them.
- `beforeHandBack(rec)`: zen-ux replaces it. `spaces.takeOver` and
  `spaces.claim` of a held task await it after `checkUserQuiet`, so the
  agent's own call does what the user's Resume does first.
- Every end of a hold (an ownership change away from
  `agentDelegatedToUser`: Resume, the agent's takeOver, Stop, finish)
  releases the task's held pages (`releaseHolds`).
- `discardAgentCode(target)`: zen-observe's `discard` (the user's decision
  (A)), the agent's sandboxes and the workers they started, in every
  process. `holdFor` calls it with `{task}` at every hand-off and Take
  over, and `#onSpaceEvent` at the task's end (its ownership becomes
  `user`: Stop, finish, its last tab closed), before `publishAgentBrowsers`
  takes the task's pages out of the list zen-observe reads.

The remedy (`holdFor`):
- A page the agent made (H's top document is `made`) is refused to the
  agent before anything is discarded, so the agent keeps its code; the
  user's Take over holds it as it is.
- Then the discard, before any load: what the agent's code left running
  can't act on H or on the loads. A process that hasn't finished in 10 s
  refuses the hand-off (`discardFailed`) and releases the hold. H's
  channels and shared-worker ports are muted with it only when a task
  page, or a window of H's group, outside its hold, shows one of H's sites
  and has evidence of the agent's code (`channelsReach`).
- The windows that could reach H (`markedReaching`): those of H's group,
  outside its hold, that show a site one of H's documents shows, top or
  frame on either side, and need a clean copy themselves. A window that is
  only reachable from a hooked one isn't hooked (the rubric's rule 3).
- Each of them loads afresh in place, one at a time, then H, if it needs
  a clean copy (`cleanLoad`, H's with `sameSite`). Before each window's
  load, zen-observe's `holdReload(window, H)` makes its new documents the
  hold's. Nothing marks a document for being beside a hooked one, so each
  copy comes in clean: H keeps its group and opener, and each history
  keeps its length.
- H never moves into a group of its own at the hand-off. The group switch
  that did (`zenius.handoff.groupSwitch`) is gone, by the user's pass on the
  defenses (2026-11-21), and a profile's leftover pref does nothing.
- Then the check again: anything left loads afresh once more, and if even
  that leaves something, the hold is released and the hand-off refused
  (`reachable`). A load that brings no new document in 15 s is
  `reloadFailed`, with the pages already loaded afresh in
  `data.reloaded`.
- `zenius.handoff.quietReload` (default true) turns these loads off, and H
  is held as it is. Only tests of the hold's other layers set it, to keep
  code planted before a hand-off. zenius never writes it outside tests,
  and zen-sdk's doctor warns when a profile has it off.

The quiet load (`cleanLoad`):
- It goes to zen-observe's `urlBefore` when that isn't null: the URL the
  top document had before the agent's code last changed it in place
  (pushState, replaceState, a hash), chained over the agent's consecutive
  changes, while the page still shows the URL the agent's code set, and
  only on the page's own origin (http, https), which those calls can't
  leave. The site's own routing stays the target. Else the current URL:
- The URL again as a new GET entry in place of the current one
  (`LOAD_FLAGS_REPLACE_HISTORY`, system principal). Measured on Gecko 160: a
  plain reload restores form state, hidden inputs included, where the
  agent may have planted a payee or a redirect. A cache-bypassing reload or
  a new entry restores nothing; the new entry keeps subresources cached. A
  POST result (`nsISHEntry.postData`) loads its URL by GET, without a
  fragment, so nothing is resubmitted. A GET entry with a fragment uses
  the cache-bypassing reload, since the same URL with a fragment would only
  scroll.
- The page the user is about to hold stays on its site (eTLD+1, no
  scheme; `cleanLoad`'s `sameSite`). The site's own router can put its
  open redirect in the URL (pushState takes any same-origin URL;
  zen-snapshot's siteRouterRedirect), so a redirect response
  (`http-on-examine-response`) that leaves the site is cancelled before
  anything of the other site loads, and so is the page's own script
  sending it to another site as it loads (siteRouterJsRedirect): until
  300 ms after the fill, every document request of the tab to another site
  is cancelled before it's sent (`http-on-modify-request`). After such a
  stop the load goes once more, to the URL that brought the document: its
  channel's, after redirects (`docShell.currentDocumentChannel`, which
  `content/forms.sys.mjs`'s record returns as `loadedFrom`), which the
  site's pushState and replaceState don't change. Only on the shown URL's
  origin, without its fragment, and stopped off the site the same way; the
  fields come back from the first record. With no such URL (none, another
  origin, or the URL just stopped), or when that load is stopped too, the
  load fails (`reloadFailed`), and the old document stays unless the first
  load brought one (the manager, 2026-11-21). A fresh document that ends on
  another site anyway (a service worker's redirect, say) fails it at once.
  Later loads of the held page that its own code starts may cross sites,
  as sign-ins need (the manager, 2026-11-20);
  zen-ux's hold card names H's current site. The windows loaded afresh
  because they could reach H may leave the site.
- Fields come back only into a document of the recorded one's origin.
- `content/forms.sys.mjs` records the top document's visible, ordinary
  fields that differ from the page's own values, and the focused field's
  key, and clears the page's user activation (Gecko 160 puts up a
  beforeunload handler's prompt only on an activated page, and one call
  clears the frames' too; measured: the load came in 30 ms where a plain
  one waited on the prompt, and `permitUnload("unload")` first didn't
  help, since the load fires beforeunload again). It fills them back once
  the new document has loaded, and puts the
  focus back. A field is keyed by its form's index, its name or id, its
  type (and value, for a checkbox or radio), and its rank among fields with
  that key. Never carried: secrets (zen-input's `secretFields`: passwords,
  card fields), one-time codes, hidden, invisible, disabled or read-only
  fields. A field the user already changed keeps their text. Text goes in
  with `setUserInput`, as form autofill does.
- zen-input's `dropUserTyping(browser)` (`input/typing.sys.mjs`), when it
  exists, drops the user's typing until the form is back, and stays on
  after a failed load.
- The hold's COOP is `same-origin-allow-popups` on that one response
  (`http-on-examine-response` and its cached and merged variants), unless
  the site sends its own non-`unsafe-none` value. Gecko then replaces the
  tab's browsing context. Gecko 160 ignores `noopener-allow-popups`.

During the hold:
- `pages.codeRefusal` answers `{reason: "hold"}` for every page in a group
  with a held page (zen-observe's `HELD_PAGES_KEY`), not kept: it ends with
  the hold.
- A page of the task with evidence of the agent's code (hooked or made)
  opens no window, with an opener or without: `service.openRefusal`, on
  both the tab and the window path. `onOpenRefused` hears it with `hold:
  true`. H and the popups that joined its hold open as usual, and so does
  a page where the agent's code only ran: the hand-off discarded it.

I4: `modules/handoff.sys.mjs` loads with the first hold. Its response
observers are on only while a page is held or a quiet load runs.

Residuals:
- A page that opened H can still `close()` it: the user loses the page,
  but nothing leaks (the manager's decision).
- A leave prompt stops a quiet load only where Gecko prompts without a
  user activation (`dom.require_user_interaction_for_beforeunload` false,
  not the default): the hand-off is then refused (`reloadFailed`), never
  handed with the old document there.
- Fields in frames, and forms a script builds after load, aren't carried.
- The agent's hooked windows that share a site with H load afresh, losing
  their state. A load during the hold that brings H onto a site where a
  window of its group ran the agent's code (a sign-in's callback to the
  agent's site) leaves H in that group unless that window has evidence of
  the agent's code: the discard ended the agent's code there, and what's
  left is the site's own.
- What evidence can't see stays, under the user's call (the brief's
  list): what the agent's code filled in, a hidden input's value too,
  stays in a page handed off as it is (the Cloudflare case).
- Page code the agent left in a hooked window may already have scripted a
  window of its site that the agent's code never wrote into; that window
  isn't loaded afresh (the rubric's rule 3).

## Spaces and tabs without preemption

- Agent tabs come from `addBackgroundTab()` in `modules/windows.sys.mjs`.
  Don't call `gBrowser.addTab({zenWorkspaceId})`: Zen marks such a tab
  `change-workspace` and switches the window to its workspace. A container
  used by exactly one workspace triggers the same switch, so the helper
  bypasses Zen's container logic for that one call and then moves the tab
  with `gZenWorkspaces.moveTabToWorkspace()`.
- `gBrowser.tabs` lists only the active workspace's tabs in Zen. Use
  `allTabs()` from `modules/windows.sys.mjs` (it reads
  `gZenWorkspaces.allStoredTabs`).
- Agent tabs are kept alive (`keepAlive()` in `modules/guards.sys.mjs`):
  `docShellIsActive = true` and `undiscardable`, so a hidden agent tab runs
  rAF at the display rate, fires timers on time, renders, reports
  `document.hidden === false`, and is never unloaded for low memory. The tab
  switcher deactivates a tab it switched away from; the guards re-activate it,
  and `ctx.resolvePage()` re-checks before every page method.
- Popups from a page the agent drives (`target=_blank`, `window.open()`, and
  `window.open()` with size features, which a content guard turns into a tab
  instead of a window) open in the background in the same space under the
  next label, with `page.opener` set. `framefocusrequested` from such a page
  is swallowed so `window.focus()` can't select it.
- Popup hook for receipts: `const w = ctx.watchPopups(space.id, page.label);
  … perform the action … const popups = w.stop();` gives `[{label,
  targetId}]` (`w.labels` lists the labels). The service also emits
  `popup` events `{space, page, tab, opener}`. Popups get labels whatever
  the page budget, as in Ego.

## Waiting for a load in the parent

Listen on `browser.addProgressListener(l, NOTIFY_STATE_NETWORK |
NOTIFY_LOCATION)` (it follows the tab across process switches), and:

- Resolve on a top-level `STATE_STOP` with `STATE_IS_NETWORK` whose
  `request.QueryInterface(Ci.nsIChannel).originalURI.spec` equals the URL you
  loaded (`Services.io.newURI(url).spec`; it survives redirects). Don't
  require a `STATE_START` first: a new tab's initial about:blank load overlaps
  its first navigation, and that navigation's START is sometimes never
  reported, while its STOP is.
- Ignore other STOPs; the initial about:blank's STOP can arrive after your
  load started.
- A failed load (refused, DNS, TLS, blocked port) may report no STOP at all,
  only `onLocationChange` with `LOCATION_CHANGE_ERROR_PAGE`; the error code is
  the `e=` parameter of `browser.documentURI` (for example `deniedPortAccess`).
- `request.name` throws on these requests (`RemoteWebProgressRequest`).
- Keep a strong reference to the listener while you wait: web progress holds
  it weakly.

zen-observe's `observe/navtracker.sys.mjs` follows this rule.

## UI hooks (zen-ux)

zen-ux maintains this section. The design notes are in
`docs/research/ux.md`.

**The agent sidebar's start.** `agent-sidebar.uc.js` reports each window's
start to `ui.sidebarStatus` (`docs/PROTOCOL.md`) as a property of the
window, set at the end of it:

```js
window.zeniusSidebarStart = Object.freeze({ error }); // the start's exception message, or null
```

A property, not a call into zenius: the sidebar's start loads no zenius
module, which I4 counts. `ui/sidebarstatus.sys.mjs` reads it, loading with
the method modules at the first connection.

**The agent cursor.** Pointer actions show the agent's cursor before they
dispatch:

```js
import { moveCursor } from "chrome://userscripts/content/zenius/ui/cursor.sys.mjs";

const { tab, space } = ctx.resolvePage(params);
await moveCursor(tab, { x, y }, { label: options.label, kind: "click" });
// The user may have clicked during the flight: pass the gate again.
deadline += await ctx.gate();
// …then dispatch the click in content.
```

- `x`, `y`: viewport CSS px of the tab's top document, the page's `clientX`
  and `clientY`. For a target in an iframe, add the frame offsets.
- `label`: the action's `options.label`. Omit it to keep the current label;
  `""` clears it.
- `kind`: `move`, `hover`, `click`, `dblclick`, `down`, `up`, `drag`, `drop`,
  `wheel`, `type`, `focus` or `select`. Clicks get a ripple.
- Result: `{visible, animated, ms}`.
  - When nobody can see the tab (another tab or Space, minimized window), it
    records the point and resolves at once, in about 6 µs.
  - When someone can see it, it resolves when the move animation ends:
    120–380 ms, depending on distance.
  - When the user prefers reduced motion (the OS setting, or the pref
    `ui.prefersReducedMotion`), the cursor jumps, and the call resolves at
    once.
- It never rejects for display problems, and never waits for control. While
  the user controls the Space it draws nothing.
- Call it once per action. For `mouse.move` with `steps`, call it once with
  the end point.
- It also remembers the tab as the page Zen shows when the user opens the
  Space (`notePage()` in `ui/pages.sys.mjs`). Call `notePage(tab)` yourself
  after actions without a cursor, such as `goto`, so the user lands on the
  agent's page instead of an empty tab.
- Then pass the control gate (`await ctx.gate()`, see "Held calls" below)
  before dispatching. The user watching may have clicked during the
  120–380 ms flight and opened the takeover prompt. Add the ms it returns to
  your deadline.

**Takeover.** `ui/takeover.sys.mjs` with the controller in
`ui/index.sys.mjs`, started when `methods/ui.sys.mjs` loads.

- **What counts.**
  - Real input in a managed page of a Space whose ownership is `agent`: a
    mouse button, a touch, a key that types or edits, or a drop.
  - Not counted: moves, wheel scrolling, browser shortcuts, Escape, F-keys.
  - It's detected by window capture listeners in the parent. Input that the
    actors synthesize in content never reaches them.
- **On the first input.**
  - The Space's `paused` flag is set synchronously, before the page sees the
    event.
  - The agent's page shows the pill "Agent paused · it resumes in 10 s"
    (after typing: "You're taking over · in 10 s", with Take over now),
    counting down, with [Take over] [Resume agent].
- **Take over** goes through zen-core's `service.userTakeOver(rec,
  browser)`, which holds the page, checks it, and loads it afresh first
  when the agent's code could see what the user types there, with the form
  and focus carried over. The agent stays paused meanwhile. Then ownership
  is `agentDelegatedToUser` (source `user`), the waiting action fails with
  `ZEN_TASK_SPACE_USER_IN_CONTROL`, and the
  agent's cursor hides, keeping its point and label. The page shows
  "You're in control · the agent waits until you resume it · <site>" with
  [Resume agent] (the site: see "The site" under handOff). A page the
  agent made is held as it is. When zen-core loaded the page afresh
  (`userTakeOver`'s result `how`, "reload" or "get"), it says so too:
  `zenius-reloaded`, below.
- **A Take over that couldn't begin** (zen-core refused the hold:
  `ZEN_HANDOFF_REFUSED` with `data.reason`, or `ZEN_PAGE_NOT_FOUND`): the
  task stays the agent's, paused until the user picks, and the page shows
  `zenius-takeover-refused`, "Can't take over this page", with the reason
  in a line (`takeOverRefusal(error)`, `takeOverRefusedCard(refusal,
  actions)`):
  - `discardFailed`: "The agent's scripts in this task didn't stop in
    time."
  - `reloadFailed`: "The page didn't load afresh in time." If loading it
    afresh would leave its site (`data.offSite`, the other site's URL), the
    line is "Loading it afresh would take you to another site.", and
    there's no Try again: it would fail the same way.
  - `reachable`: "Another of the task's tabs on this site can still reach
    it.", and behind the '?': close those tabs, then try again.
  - No document to hold: "The page has nothing to take over yet."
  - Its buttons: [Try again] (zenius's Take over again) [Stop task] (the
    panel's Stop, safe in every case) [Resume agent] (the panel's Resume).
  - It takes no focus, is announced when its tab is in view, and goes
    after a button, when the task ends or changes hands, or with its tab.
  - Meanwhile the task needs the user: its badge state is `needs-user`
    (`badgeFor`), so its tabs, the strip and its row say so.
- **`taskBadge`**, an in-process event (`service.emitLocal`), for the agent
  sidebar's directory: `{space, state}` whenever a task's badge state
  changes (`working`, `idle`, `paused`, `needs-user`, `user`, or null once
  it's no agent task). `ZeniusUI.badgeFor(rec)` gives the whole badge.
- **`ZeniusUI.noteSidebarTask(spaceId, {running, needs})`**, the agent
  sidebar's word on a task its chat drives, so the strip says what the
  sidebar does. `running`: the chat's agent turn runs, so the task counts as
  working however long since its agent last acted (the strip's 15 s).
  `needs`: why the chat waits for the user ("permission", "question",
  "error", …) or null, so the task needs them in its badge and the strip. A
  key left out keeps what it was.
- **Resume agent** (the prompt's) lifts the pause. Clicks in the next 3 s
  don't prompt again.
- **Ignored.** Each counting input restarts a quiet timer: pref
  `zenius.ux.takeover.quietMs`, default 10000. When it fires:
  - If the user only clicked, the agent continues.
  - If they typed, pasted or dropped into the page, they keep control, as if
    they had pressed Take over.
- **Input dispatched from the parent process.** If any zenius code
  dispatches input into a page from the parent (the chrome window's
  `synthesizeMouseEvent`, a chrome `nsITextInputProcessor`), wrap the
  dispatch in `withAgentInput(() => …)` from `ui/takeover.sys.mjs`.

**Permission prompts.** `ui/permissions.sys.mjs` wraps each window's
`PopupNotifications.show()`.

- The rules follow the page's evidence and who holds the task (the user's
  pass on defenses, A8, 2026-11-21, with zen-observe's C):
  - While the agent drives, a managed page's prompt puts the Space in
    `agentDelegatedToUser` with Ego's reason key (`REASONS`):
    `storage_access` (an embedded sign-in frame's requestStorageAccess()
    during a login), `local_network_access` (Firefox's local-network and
    loopback-network prompts, which carry zen-observe's allowlist past
    top-level loads), `location`, `notifications`, `midi`, `serial`, or
    Ego's catch-all `permission_prompt` (persistent storage, XR). The
    notice words the prompt by its id, not its key.
  - During the user's hold the prompt is theirs, as on any site.
  - The camera, microphone, screen or speakers' prompt
    (`webRTC-shareDevices`) is cancelled while the agent drives: the agent
    never gets them. During the hold it's the user's, and zen-observe
    stops every stream in a tab that becomes the agent's again.
  - On evidence of danger in the page (zen-observe's flag, any reason),
    every prompt is cancelled without asking, held or not, and nothing is
    stored for the site.
- zen-observe's override in `Integration.contentPermission` cancels a
  prompt on evidence before it shows, and its gate denies the devices
  while the agent drives. One that shows anyway (the host's `denies`) is
  removed at once with `withoutUserResponse`, so its request is cancelled,
  and the agent gets `Zenius.refused` `{kind: "promptDenied"}` with why;
  for the location, it reads that a site taking a typed place can have
  one. The user's own tabs, and a task's that ended, keep theirs.
- Firefox keeps a background tab's prompt until the tab is shown, so the
  prompt waits for the user to open the Space. Nothing shows over the user's
  own Space. The agent's page carries "Agent paused · page asks for …", and
  the Space's badge says it needs the user.
- When the last such prompt is answered or goes away, ownership returns to
  `agent`, unless the user took over or the agent handed off meanwhile.
- Other doorhangers (saving a password, add-on installs) change nothing.
- **A page can't ask at will** (the content-boundary audit, item 5; the
  manager's rules of 2026-11-20). While the agent drives, a prompt or a
  passkey request is an automatic handoff. A page can withdraw its own
  request (a reload removes its prompt, an abort ends its passkey call),
  which hands the task back and lets it ask anew, so without limits it
  could pull the user in again and again. ZeniusUI's `#autoHandOffs` keeps,
  per task, the open requests, the origins that left one unanswered, and
  how many were.
  - A handoff left unanswered is spent: the user handed back before
    answering, or the page withdrew the request. Answered ones (allowed,
    blocked, a passkey completed or cancelled in the OS sheet) spend
    nothing. A prompt's answer is PopupNotifications' `withoutUserResponse`
    on removal; a passkey's is the hold ending before the user saw it, or
    the child's `outcome` ("abort").
  - An origin that spent one can't hand the task over again, by prompt or
    passkey alike. After 3 spent in a task, no page can.
  - A refused prompt is removed at once with `withoutUserResponse`. Gecko
    160's PermissionUI and WebRTCParent cancel its request then, and store
    nothing. The agent gets `Zenius.refused` `{kind: "permissionPrompt"}`,
    or for a passkey `{kind: "passkey"}`.
  - The origin is the prompt's `displayURI` (a cross-origin frame's own),
    else the tab's; for a passkey, the requesting document's principal as
    the parent knows it.
  - A prompt that replaces the browser's pending one with the same id (the
    page asking again before the user answered) is the same handoff: the
    old one's removal doesn't give control back.
  - Neither the agent's own `handOff()` nor the user's requests while they
    hold the task are limited.
  - `ZeniusUI.forgetHandOffs(rec)` clears a task's record, for tests.

**handOff.** When ownership becomes `agentDelegatedToUser` with source
`agent`:
- The agent's page shows "Agent needs you" and "<task name> on <site>" with
  [Resume agent]. Its small text is the agent's words, whole, as its own:
  "The agent says: “<state text>”." (the user's design, 2026-11-20; no cap,
  the '?' opens what one line doesn't show). The pill follows later
  state-text changes.
- **The site** the user is on there (the manager, 2026-11-20): Zen's compact
  mode often hides the URL bar, and a sign-in may take the held page to
  another site on its own (a SAML post, an SSO redirect), which zenius
  lets it do. Every hold card (the hand-off, Take over, a permission hold)
  names the page's registrable domain after the task, as Firefox shows it
  (`heldSite`, from `siteName`), never cut: the task's name gives way
  first. When the buttons can't sit beside the title and the site, they
  go under the line (or under the title row, with no line); when even the
  title and the site can't share a row (a long site on a sliver of a
  page), the site takes a row of its own and wraps there. notices.sys.mjs
  `watchSite` picks the layout from the parts' own one-line widths, so it
  can't flip between them. It follows the page's top document
  (`#onHandedPageLocation`). A
  page with no site (data:, blob:, about:) names none. The pill's label
  and the hand-off's announcement say "on <site>"; a move to another
  site isn't announced again, since the page's own load speaks.
- **The Resume line.** Resume agent clears password, card and code fields
  (zen-input's hand-back guard) and reloads a page where one was typed and
  not sent. So once the user types one in the task's pages (zen-input's
  `onSecretTyped`, once per document, autofill included), the hold card's
  small text leads with "Resume agent clears password, card and code
  fields, so submit what you type there first.", and the agent's words wait
  behind the '?'. The line goes when the agent runs again. Without that
  event, the line shows always (`ZeniusUI.secretLineJustInTime`).
- **A secret step** (the agent's hand-off with zen-core's secret flag:
  spaceChanged's `secret: true`, source `agent`): the user's Resume loads
  about:blank in that tab, history and all, before the agent gets control.
  So the hold card leads with "Resume agent clears this page, so copy what
  you need from it first." (`SECRET_LINE`), in place of the Resume line,
  the agent's words behind the '?', and the hand-off's announcement says it
  after the task and site. The tasks panel's row says "Resume agent clears
  the page the agent handed you, so copy what you need from it first."
  under Resume agent. It lasts for that hold: a hand-off without the flag, a
  hold the user began, and the agent's run again end it.
- **Resume agent** first reloads, quietly, each page where the user typed a
  secret and that has evidence a clean copy clears (zen-input's
  `typedSecrets`, zen-observe's `evidenceOf` saying hooked or made, then
  zen-core's `cleanLoad`), tells zen-core (`noteReloaded`), then hands back.
  A page without such evidence keeps what the user typed until zen-input's
  guard empties its secret fields (the user's pass on defenses, 2026-11-21,
  A4). zen-core's own ways back to
  the agent (`spaces.takeOver`, `spaces.claim`) await the same step through
  `service.beforeHandBack`, which zen-ux sets. The agent's calls wait out
  the reload: they're held while the task is paused or the user's, and the
  hand back comes after it.
  - zen-core's switch `zenius.handoff.quietReload` (default `true`) turns
    these reloads off too, for tests of the hand back's other layers
    (zen-input's hand-back tests keep the agent's own password in the
    page). Off, Resume asks nothing and reloads nothing, and hands back
    before the press returns, so zen-input's clear reaches each frame ahead
    of the agent's next call, as before the reloads.
- **A page the agent made** (zen-observe's `agentMadePage`): the hold card
  adds "The agent made this page. It might contain malicious code. Keep
  sensitive information out.", only while the page asks for a password, a
  card's details or a one-time code (zen-input's `secretFields`, through
  `content/uipage.sys.mjs`'s `secretKinds`, asked of every frame), or the
  agent flagged it (A6).
- The Space's badge and the tasks strip show that it needs the user.
- An OS notification is off by default (I1). Pref
  `zenius.ux.handoff.systemNotification` (bool, default `false`) turns it on
  for every moment that needs the user, through the OS alerts service: a
  handOff, a page's permission or passkey request in an agent tab, and the
  claim prompt.
  - Clicking a handoff's notification opens the Space. Clicking a claim's
    raises the window the user was in last.
  - A claim's notification closes when the ask settles. A handoff's closes
    when the task stops waiting: handed back (the permission answered, too)
    or ended. Left up, it sent the user to a moment that was over (B3).
  - None of them focuses or raises a window by itself.

**Tasks panel.** `ui/panel.sys.mjs`.
- A strip above Zen's sidebar foot buttons appears while agent tasks exist
  ("An agent needs you", "2 agents working", "1 agent task"). It's a static
  child of `#TabsToolbar`, not a CustomizableUI widget, so it changes no
  pref (I4).
- Clicking the strip opens a panel listing each task's Space, state, state
  text and current action, and its tabs by name (four, then "+N more"; a
  name opens that tab). Its rows are built as it opens (`actions.rows`):
  titles and idleness change without a badge event. Its buttons:
  - **Open:** watches the task (below): shows the Space, on a page that
    needs the user (a permission prompt, a handOff's), else on the task's
    front tab (zen-core's
    `pages.frontTab`: the last the agent made current or the user picked;
    the manager's decision of 2026-11-20).
  - **Pause / Resume:** while paused, the agent's next action waits, and
    the user's own input in its pages opens no takeover prompt.
  - **Take over:** as the prompt's (zen-core's `userTakeOver`), then
    watches the task.
  - **Resume agent:** as the hold card's: the quiet reload of a page where
    the user typed a secret, then ownership `agent`. The panel's Resume
    (after its Pause) waits for the same reload.
  - **Stop:** ends the task. Ownership becomes `user`: the Space and its
    tabs stay as ordinary ones (keep-alive released), and the agent's calls
    fail with `ZEN_TASK_SPACE_INACTIVE` until it claims the Space again.
- **Watching a task** (`ZeniusUI.watch(rec, win, {tab, tabId})`,
  `ui/watch.sys.mjs`; the user's design of 2026-11-21). Every way the user
  goes to an agent's task is a watch: the panel's Open, Take over and tab
  names, a notification's click (`openSpace` is a watch), and the agent
  sidebar's live card and directory, which call it.
  - The window remembers where the user was: their tab, or, from an
    agent's page or Space, their own Space (`#userWorkspace`). Watching
    another task keeps that.
  - While it watches, the strip reads "Watching <task> [⌃Tab]" ("Ctrl+Tab"
    off the Mac), the key a keycap, the name cut, never the key. It's a
    hint: a click opens the panel, as before. Its tooltip and accessible name add "⌃Tab goes
    back to your tabs" and the strip's own news.
  - Where the strip can't be read (`stripSeen`: a collapsed sidebar, which
    shows only its dot, or compact mode while the sidebar is away), a chip
    in the page area's top left corner (`#zenius-watch-pill`) says the
    same. It's at most 280 px or 40 % of the page area wide, never over the
    page's top middle, and every click goes through it to the page. It
    follows compact mode, the sidebar's hover and width, and the window's
    size, 300 ms after each change (Zen's slide).
  - ⌃Tab goes back: the user's own key only (trusted), caught in the
    system group at the window before Zen's tab box and ctrlTab see it, and
    the rest of that press is swallowed. Whenever the window doesn't watch,
    ⌃Tab is Zen's: the listeners are in only during a watch.
  - Picking a tab outside the task, or another Space, ends the watch where
    the user went. There's no Back control (the user's decision).
  - The task's end doesn't end it (the manager's decision, 2026-11-21: the
    user reaches for ⌃Tab right then). The window stays where it is: on
    the task's page, whose close waits until the user leaves it (SPEC
    §3.5), or on a page the task kept. The strip (`[watching="done"]`), or
    the chip (`[done]`), says "Task done, [⌃Tab] back to your tabs", where
    "back to your tabs" is cut first, never the key. ⌃Tab still goes back
    until the user presses it or picks another tab or Space themselves.
    The tab Zen picks when that page closes (its pill's Close, ⌘W) isn't
    their pick: Firefox selects it before it marks the page closing, so the
    check waits for that call to end, and the page the user left closes a
    tick later (zen-core's `closeLeft`). Another task's watch keeps the way
    back too. Nothing moves by itself.
  - A screen reader hears "Watching <task>. Control Tab goes back to your
    tabs." as a watch begins, and "Task done: <task>. Control Tab goes back
    to your tabs." as its task ends. The closing pill's announcement then
    says only "This tab closes when you leave it."
  - `ZeniusUI.stopWatching(win, {back})` ends it (with `back`, as ⌃Tab),
    an ended task's way back included. `ZeniusUI.watching(win)` gives the
    watched task's Space id, else null. `ZeniusUI.watchingDone(win)` gives
    the ended task's while its way back stays, else null.
  - The window hears `zenius-watch` (`detail: {space, done}`) whenever its
    watch begins, moves or ends, and when its task ends. `space` is the
    watched task, else null. `done` is true while an ended task's way back
    stays. The agent sidebar's card and `data-zenius-watching` follow
    `space`.
- **A remote task's arrival.** `ZeniusUI.remoteArrival(win, {text, watch,
  stop, ms})` is what the agent sidebar calls when a remote task starts while
  it's closed in the front window. It shows a small card, `#zenius-arrival`,
  right over the strip (else over Zen's foot buttons), saying `text` ("Task
  from <address> · <label>") with Watch, Stop and ✕, in the look of the
  sidebar's own card: Working's dot, the text in up to three lines with the
  address a chip (`.zenius-arrival-addr`, the isolate's marks around it), ✕
  on top, and Watch and Stop under them on the right. It takes no focus, opens
  nothing and selects nothing (I1). It goes after `ms`, though not from under
  the pointer or the keyboard's focus, or on any of its buttons. A new
  arrival takes its place. With the sidebar open, the sidebar shows the same
  card itself.
- **Live rows.** A task keeps its row element while it's listed. An update
  changes only the text and attributes that changed, and moves a row only
  when the order does, so a button the user has focused or is pressing
  survives the agents' progress reports (B1: rebuilding every row lost the
  focus and 8 of 10 presses). Open and Stop stay; the buttons between them
  follow who holds the task, with Pause and Resume one button relabelled,
  and focus on a button that goes moves to the first that comes. The
  buttons read their task and action when clicked. A closed panel drops
  its rows.
- **Nothing moves under a press.** Between a mousedown in the panel and its
  release, updates wait (2 s at most), and a row's tabs stay on one line,
  their names shrinking to fit. Otherwise a row that came or grew above (a
  loading tab is named by its URL) took the button from under the pointer:
  3 of 20 presses were lost that way under load.
- **Many tasks.** Past the window's height (`100vh` less 96 px), the rows
  scroll under the panel's title, which stays, and keyboard focus scrolls a
  row into view. A popup can't outgrow the screen, so rows it cut off were
  out of reach (the load pass of 2026-11-20, B4).
- **In the window.** The panel opens above the strip and grows toward the
  window's middle. It lines up with the strip's left edge when the sidebar
  is on the left, and with its right edge when it's on the right. The side
  comes from where the strip sits, so right-to-left works too.
  - A popup is a window of its own. The system keeps it on the screen, but
    not inside the browser's window.
  - On a Mac whose window didn't fill the screen, the panel ran 62 px past
    the window's right edge with the sidebar on the right. In a second
    window it ran 13 px past the left edge. Stop and Resume agent went with it
    (zen-eval, 2026-11-20).
  - How far it overflows depends on its margin (Zen's 8 px shadow margin on
    a Mac, none on Linux) and the window's place on the screen.
  - So `keepInWindow` measures where it landed and moves the panel in by
    the overflow with `moveToAnchor`, at most three times. It measures at
    `popuppositioned`, at `popupshown`, and 150 ms after.
  - The measure is layout's rect of the panel, as the user sees it. The
    opening animation only slides the panel up or down: a CSS transform on
    Windows and Linux, and the window's own `-moz-window-transform` on a
    Mac, which layout doesn't see. While a CSS transform runs, the vertical
    place comes from the popup's screen rect.
  - On Zen 1.24.3b (Gecko 160.0.1) on a Mac, the panel stayed where it
    opened (zen-eval's bisect, 0c25f24). On Linux the screen rect has no
    size at `popuppositioned`, so layout's rect did the work there, and on
    1.24.3b it still does. The Mac's screen rect is the likeliest break.
    1.24.3b changed no popup code in either omni.ja, so the change is
    native.
  - A move that didn't take (the panel is still where it was) is made
    again with `moveTo`, at the screen point layout's rect asks for.
  - Each step goes to the dev log, with the side, the anchor, the rect and
    the move: `[zenius] panel popupshown: open before_end, anchor
    996..1272, layout 988..1342 x …, window 1280x812, off by -66,0:
    moveToAnchor -66,-4`.
  - A narrow window gets a narrower panel: `min(320px, 100vw - 48px)` up
    to `min(440px, 100vw - 48px)`.
- **Right-to-left names.** A row's name, its tabs' titles and a pill's
  detail each hold one text, marked `dir="auto"`. So a clipped right-to-left
  one loses its end to the ellipsis, not its start, and a short one still
  lines up with the rest (B5). Lines that start with zenius's words (a row's
  detail, the Space's status pill, the cursor's label) stay left-to-right;
  their tooltips carry the whole text.
- **Idle tasks** (SPEC §3.4). A task the auto-close would take
  (`service.isIdleTask(rec)`) shows "Idle for 3 days", in days when
  `zenius.autoCloseHours` is whole days, else hours (`idleText`), and
  **Close task**: `service.closeIdleTask(rec)`, `finish({keep: []})` with
  §3.5's waiting closes.
- The panel never opens by itself.

**Ownership.** ui changes it only through Spaces (see "Ownership" above).
- **Sources.** It passes `source: "user"` for the prompt, the panel and
  Resume agent, and `source: "permission"` for permission prompts.
- **Pauses.** The panel's Pause and a takeover prompt both hold the Space
  through `setPaused`. A prompt that closes leaves a Space the user paused
  paused.
- **Events.** Badges, notices and the panel follow `spaceCreated`,
  `spaceChanged` (`source: "agent"` means the agent's own change, such as
  `handOff`) and `spaceFinished`.
- **Deleted Spaces.** A Space the user deletes in Zen sends no event, so ui
  also re-checks Spaces on Zen's `ZenWorkspacesUIUpdate`.

**Notice pills.** `ui/notices.sys.mjs`: `showNotice(tab, value, {title,
detail, until, tone, note, more, buttons, stacked})`, `removeNotice`,
`noticeText`. A button is `{label, onClick(event), primary, stays, icon}`;
`icon: "close"` draws a ✕ whose name stays its label ("Dismiss"), and
`onClick` gets the click, for an action only the user's own click may take.
- One compact line in a chrome layer over the tab's browser, like the
  cursor: never in page DOM or content screenshots, shown only with its tab
  (I1). Bottom center, the user's pick.
- `detail` may hold `{s}`, the whole seconds left until `until`.
- Buttons act on the first click, also right after the window gains focus.
  Clicks in the first 400 ms after a pill appears are ignored, so a double
  click can't land on the pill that replaces it.
- Firefox's notification bar isn't used: it ignores the first click after
  every window focus.
- Each pill is a `role=group` named by its title, detail and note, not a
  live region (see "Accessibility" below). A countdown renames it as its
  text changes, so a screen reader hears the time left now.
- A pill with a `note` shows it as one line of small text, 7 px under the
  title row (the user's layout, 2026-11-20), cut off with a '?': a 14 px
  circle holding an SVG question mark, not focusable and hidden from screen
  readers, which have the whole text in the pill's name. A click on it
  opens the rest; keyboard focus in the pill opens it too. `more` is text
  that waits behind the '?' at any width, so the '?' always shows. A
  ResizeObserver sets `note-cut` when the line runs over.
- Its buttons sit beside the title, or under the note, at its end, when the
  card is `stacked`: one with three buttons always is, and on a page
  narrower than 480 px (a split view's half, a small window) every pill with
  a note and buttons is. The stacked row wraps if it must. So no button
  leaves the pill (`cards.test.mjs` measures every card, at the page's
  width and at 420 px).
- A pill that goes while it holds the user's focus hands it back to where
  it came from (`focusin`'s `relatedTarget`), else to its tab's page if
  that's on screen. An update keeps the focus on the same button.

**Dialogs the agent held.** zen-observe intercepts JS dialogs on pages the
agent drives (see "Navigation and observation"). A page whose dialog it holds
looks frozen to anyone else.
- When a page stops being agent-driven (takeover, handOff, a permission
  prompt, Stop, finish), ui calls `releaseDialog(browser)`. Firefox then
  shows the dialog in its own prompt UI, and the user answers it there.
- ui does that only for a page a window shows; other pages get theirs on
  `TabSelect`. Releasing a `beforeunload` dialog selects its tab, which
  mustn't move the user's view (I1).
- If the agent has control again before the user looks, the dialog stays
  the agent's.

**The Space's clipboard.** `clipboard/` (zen-ux), started by
`methods/ui.sys.mjs`. Agent copy, cut and paste never touch the system
clipboard, which is the user's.
- **Store.** `SpaceClipboard` from `clipboard/store.sys.mjs`, parent only, in
  memory:
  - `read(spaceId)` returns a copy of the Space's ClipData, or null: for the
    agent's own paste.
  - `write(spaceId, data, origin)` stores a copy, with the origin of the
    document that wrote it (null when unknown); null or `{}` empties it.
  - `readFor(spaceId, origin)` is what a page may read: `{data}` for the
    origin that wrote the contents (an empty clipboard reads as empty),
    else null. `originOf(spaceId)` names the writer.
  - `clear(spaceId)` empties it.
  - ClipData is zen-input's: MIME type → data, most preferred first; text
    types are strings, others `Uint8Array`. `toClipData` and `fromClipData`
    in `content/input.sys.mjs` convert to and from `{text, html}`.
  - Emptied when the Space's task finishes or the Space is deleted.
  - zen-input's chords (`clipboardOf` and `noteClipboard` in
    `methods/actions.sys.mjs`) and the page guards below share it: a page's
    own "Copy" button and the agent's Ctrl/Cmd+V meet here.
- **Who may read it** (the content-boundary audit,
  `docs/research/content-boundary.md`). A page's `readText()` and `read()`
  answer from the Space's clipboard only to the origin that wrote its
  contents. Without that, what the agent copied on one site, any other site
  in the task would read on the agent's next click, with no paste prompt.
  - The writer is the document of a page write or copy event, or for the
    agent's chords the frame they copied in (`clipboardOrigin` in
    zen-input's key result, `content/actions.sys.mjs`). The parent keeps a
    chord's origin only if the call's process hosts a document of that
    origin in the tab (`hostedOrigin` in `store.sys.mjs`), else none, which
    no page can read.
  - Another origin gets NotAllowedError, "Clipboard read operation is not
    allowed." (Gecko's words for a refused read), and the agent a
    `Zenius.refused` `{kind: "clipboardRead"}` naming the writer.
  - The agent's own Ctrl/Cmd+V pastes into any page: its choice, as a
    user's paste is.
- **The parent trusts no message.** Only an agent task's documents run the
  guards, so the parent ignores messages from other tabs. Each message's
  shape is checked: only `text/plain` and `text/html` strings, each up to 4
  Mi UTF-16 units (more fails the page's write with NotAllowedError), and a
  call time from the last 5 s, no later than now. So the user's copy reaches
  the system clipboard only from a task page they hold, or use now.
- **Page guards.** The `ZeniusClipboard` actor installs them in every
  document, in every frame, of an agent task's tabs (`isAgentTaskPage`),
  also in one the user loads while holding the task. Each call checks
  `isAgentDriven`, so a tab the user holds behaves natively, and a page they
  loaded meanwhile is guarded once they hand it back.
  - zen-core publishes both sets of browserIds in `publishAgentBrowsers()`:
    `zenius:agentBrowserIds` (the agent drives the tab now) and
    `zenius:taskBrowserIds` (any page of an agent task, whoever holds it).
    Both helpers are in `content/guards.sys.mjs`.
- **Only in a task's documents** (zen-core's I4 finding, and the single
  entry agreed with zen-core). Neither zen-ux actor listens to
  DOMWindowCreated.
  - zen-core's Zenius actor makes them in a task's new documents, top and
    frames, at its own DOMWindowCreated, before the page's scripts. It
    calls their `installGuards()`, for the names `addGuardActor` publishes.
  - The "installGuards" message does the same for the documents a tab
    already had.
  - Their helpers load on first use, and both run in web content processes
    only (`remoteTypes`, as the Zenius actor).
  - So a user's document never makes them, and nothing of zen-ux loads in
    the user's tabs (`tests/ux/actors.test.mjs`).
  - Copy and cut events (`execCommand("copy")`, a page's copy handler): a
    system-group listener on the tab's chrome event handler runs after
    every page listener. It takes what Gecko would write, empties and
    cancels the event, and does a cut's deletion through the editor (undo
    restores it). An event zen-input's `interceptCopyCut` already took (the
    agent's chords) arrives cancelled and empty, and is left alone.
  - `navigator.clipboard.writeText()`, `write()`, `readText()` and
    `read()` are wrapped before the page's scripts run. They need a user
    gesture, as natively. Only text and HTML go into the Space's clipboard:
    a page writing just an image empties it.
  - `document.execCommand("paste")` from a page returns false in Gecko 160
    and reads nothing, so it needs no guard.
- **Whose copy it is.** The parent decides per call, by the time the page
  acted (`ZeniusUI.isUserUsing(browser, at)`):
  - It's the user's while the takeover prompt is open (from the input that
    opened it), while they paused the Space, and for 1 s after their own
    keystroke in the page (a Cmd+C opens no prompt). Their copy goes to
    their clipboard: text and HTML for copy and cut events; the native
    method itself for `navigator.clipboard`, so every type works.
  - Otherwise it's the agent's, and goes to the Space's clipboard.
  - In a tab the user controls, and in their own tabs, nothing is caught.
- **Not covered (Linux only).** Gecko's autocopy (`clipboard.autocopy`)
  puts a select-all or a mouse selection, the agent's too, into the X11
  primary selection. macOS has no primary selection.

**OS UI from agent pages.** `ui/systemui/` (zen-ux), started by
`methods/ui.sys.mjs`. The `ZeniusSystemUi` actor guards page APIs that would
open the operating system's UI over the user's view. Its guards install in
every document of an agent task's tabs, once per document, and decide per
call (`isAgentDriven`). Like the clipboard's actor, it's made only in a
task's documents, by the Zenius actor or zen-core's `installGuards` request
("Only in a task's documents" above).
- **Notifications.** `new Notification()` and
  `registration.showNotification()` from the page, with the permission
  already granted.
  - Nothing is shown.
  - The page gets a Notification of its own: its fields, `on*` handlers,
    `close()`, and a `show` event as a shown one would fire. `instanceof`,
    `Notification.permission` and `requestPermission()` are untouched: the
    constructor is a Proxy of the native one.
  - The agent gets `Zenius.notification {title, body, tag, url}` in
    `page.events()`.
  - A service worker's own calls (push) run outside any page and aren't
    covered.
  - Asking for the permission is denied, as every prompt but two is (see
    "Permission prompts").
- **Passkeys.** `navigator.credentials.create()` and `get()` with
  `publicKey` and without `mediation: "conditional"`.
  - On the Mac, macOS would show its passkey sheet on the window. The call
    waits instead.
  - `ZeniusUI.holdForUser(browser, "permission_prompt", key, "for a passkey",
    origin)` hands the Space over as a permission prompt does. The pill
    says "Agent paused · page asks for a passkey". It returns false when
    the page may not hand the task over (see "A page can't ask at will"):
    the request is refused at once, without a hold.
  - The native call runs once the user holds the Space and sees the tab
    (`isTabVisible`, checked every 150 ms), so the sheet opens in front of
    them.
  - When the request settles, `releaseForUser(browser, key)` returns the
    Space to the agent, unless the user took it meanwhile.
  - Handing back first, the task ending, or the page going away refuses the
    request with NotAllowedError, as a user's Cancel would. The page's
    `signal` aborts it with its own reason.
  - Passkey autofill (conditional mediation) needs the user's own focus on a
    field and passes through.
- **The parent trusts no message** (the content-boundary audit, item 6).
  Only an agent task's pages run the guards, so the parent ignores
  messages from other tabs: a passkey request from one is the page's own.
  It checks each message's fields (a passkey's id is a string; a
  notification's fields count only as strings), and a notification's URL
  is the parent's record of the document. `observe/events.sys.mjs` caps
  the event's text.
- The quiet Notification's Proxy handler has no prototype, so the page's
  `Object.prototype` can't add traps to it or reach its `construct`.
- ZeniusUI takes a task's ownership from its record, not from a
  `spaceChanged` event's params, and only zen-core's sources (`agent`,
  `user`, `permission`).
- **For tests.** `systemUiStats` in `ZeniusSystemUiParent.sys.mjs` counts
  `notifications`, `passkeyHeld`, `passkeyGo` and `passkeyRefused`.
- **Other zen-ux guards.** `holdForUser(browser, reason, key, what, origin)`
  and `releaseForUser(browser, key)` are the permission-prompt path for any
  request a guard holds for the user, under the same limits.
  `releaseForUser(browser, key, false)` says the request was left
  unanswered.
- **Not `ownerGlobal`.** zenius's module scope doesn't see `ownerGlobal`
  on a `<browser>`. Use `browser.ownerDocument.defaultView` for its
  window.

**Muted agent tabs.** `ui/muted.sys.mjs` and `zenius-ux.css` show
zen-observe's mute (`observe/audio.sys.mjs`). A tab with
`zenius-muted-sound` gets a muted-speaker badge on its icon (also with the
sidebar collapsed) and a tooltip line (`MUTED_TOOLTIP`, through a wrapped
`gBrowser.getTabTooltip`). Both go when zen-observe clears the attribute,
once the user sees the tab. The badge isn't clickable: the tab's own speaker
button would make the tab the user's.

**The view keeper.** `ui/viewkeeper.sys.mjs` (zen-ux) is a leaf module that
zen-core's tab code imports.
- `keepView(fn)` runs `fn`, an agent change to tab strips: a tab added,
  moved or closed. It then scrolls each window's strip back by however far
  its anchor tab moved. The anchor is the selected tab if it's in view,
  else the topmost tab in view.
  - `fn` may return a promise; the view is put back once it settles, and
    also when `fn` throws.
  - The scroll is instant: the strip's scrollbox otherwise slides
    (arrowscrollbox's smoothscroll).
- Zen's strip has no scroll anchoring, measured on the Linux server: inserts and moves
  across the shown tab move it 40 px in any strip. Firefox's close code
  scrolls back for a tab closed above, except at the strip's top.
- `stripCanScroll(win)` says whether keepView can help in that window. In a
  strip shorter than its box, a change above the shown tab moves it a row,
  so a new task's first tab goes at the Agents Space's bottom.
- Wrap the whole of `addBackgroundTab`: `addTab` first puts the tab in the
  window's active Space, then `moveTabToWorkspace` moves it.
- zen-core reaches both through `service.pages.keepView` and
  `service.pages.stripCanScroll`, which `methods/ui.sys.mjs` sets.

**Task tags.** `ui/tasktags.sys.mjs` and `zenius-ux.css`, on zen-core's
`zenius-task=<task id>`, which marks task pages.
- zen-ux adds two attributes, from the state `badgeFor` gives the Space
  badge and the panel row:
  - `zenius-task-state` on the tab: working, idle, paused, needs-user or
    user;
  - the task's name as `zenius-task-name` on the tab's `.tab-content`,
    because CSS `attr()` reads the pseudo-element's own element.
- A MutationObserver applies them to tabs tagged later, in every window.
  Tags are found through the DOM, because Zen's `gBrowser.tabs` lists only
  the active Space's tabs.
- The look:
  - With the sidebar expanded, the tag is a chip at the row's end: the
    state's dot and the name, within a third of the row.
  - Zen keeps the close button laid out but hidden until hover. On these
    tabs it gives the chip its place and takes it back on hover.
  - Collapsed to icons, the tag is a dot on the icon.
  - Only paused and needs-user pulse.
- The tooltip adds "Task: <name> · <state>".

**Status with tasks in the Agents Space.**
- Each task's state comes from `badgeFor(rec)` and is kept per task id. The
  panel rows, the strip's counts and the tags read it there. A workspace's
  badge can't stand for the tasks that share it.
- The Agents Space's switcher badge and header status show only while a
  task there needs the user (SPEC §3.8):
  - one task: "Agent needs you <task>, <its state text>";
  - several: "Agent needs you 2 tasks: <names>".
  The end of one task recomputes them for the others.
- **The header status** is a line of its own under the Space's header
  (`zen-workspace > .zenius-space-status`, after the header), starting
  where the header's content does. The header's row has a fixed height,
  and in it the status had shared the width with the name and Zen's
  actions button: at the sidebar's default width it showed "Agent nee…"
  (B6).
  - Its state words ("Agent needs you", "Agent paused") show in the pill's
    color, then a space and the rest in gray, with commas only between the
    rest's own parts (the user's text pass, 2026-11-23). They always show
    whole, even at Zen's narrowest sidebar. Only what follows them clips,
    with an ellipsis (`.zenius-space-status-words`, then `-more`, in a grid
    whose second column has no minimum).
  - The rest shows only with at least 5em of room, or whole. With less it
    hides (`[short]`), and the status's title keeps the whole text. On a
    Mac's narrower system font, Zen's narrowest sidebar left it a few
    pixels: "Agent needs you ·…" (zen-eval, 2026-11-20).
    - `fitStatus` measures it when the text changes.
    - A ResizeObserver on each `zen-workspace` refits it when the
      sidebar's width changes. The status's own width follows its text,
      so it wouldn't grow back.
  - The header's own layout is the same with the status as without it.
  - A collapsed sidebar shows only the status's dot, centered under the
    icon.
- A `workspace` record (a user's workspace, claimed or not) keeps its own
  badge.
- **The landing tab.** An agent's action never changes a Space's landing
  tab (`lastSelectedWorkspaceTabs`): in the Agents Space it is the user's
  own last pick (SPEC §3.5), and a user's claimed workspace stays theirs.
  - `ui/pages.sys.mjs`'s `notePage` only tells the controller which page
    the agent acts on.
  - The panel's Open, which the user asked for, lands on the task's page
    through `landOn(tab)`.

**The pill on a waiting close.** An agent's close of a tab a window shows
waits for the user to leave it (zen-core, SPEC §3.5). On zen-core's
in-process `tabClosing {space, tab}`, ZeniusUI:
- forgets the tab's cursor: its page has ended for the agent, and zen-core
  takes the tag away;
- once the call that closed it is over (`setTimeout 0`: a `finish()`
  drops its record in the same call), shows the pill `zenius-task-finished`:
  - "Task finished" and "<task>, closes when you leave this tab" when the
    task ended (its record gone, or the user's);
  - "Agent closed this page" and "<task>, closes when you leave this tab" for
    a `pages.close` while the task goes on, and without the task's name
    when the event names no task;
- offers **Keep tab** (`service.keepDeferred(tab)`: the tab stays as the
  user's, nothing moves or is selected) and **Close now**
  (`service.closeDeferred(tab)`: now). Leaving the tab closes it, the pill
  with it. It says nothing of the agent's code (the user's choice A, then
  their decision (A)).
- The buttons are chrome, so only the user's own clicks reach them, and
  they arm after 400 ms like every pill's.
- A close that waited across a restart waits again: zen-core's rebuild
  closes the tab again and sends `tabClosing` with `space: null`, after
  `SessionStore.promiseAllWindowsRestored`, which may come before or after
  a window's UI is up. So ZeniusUI also shows the pill at a window's start
  on any tab `service.pages.isDeferred(tab)` holds.

**Pages a task leaves open** (the user's decision (A), 2026-11-20). The
agent's code runs in a sandbox of its own (zen-observe's isolated world),
which ends with the task, so a page the task leaves open (kept at the
finish, left by the panel's Stop, kept from a waiting close) holds none of
it, and shows nothing: no mark, no reminder, no card.
- **Pages with evidence** (zen-observe's evidence flag, per document:
  `evidenceOf(browser)` gives `{reason: detail}` over the page's top
  document and frames). What reloads keys on the evidence a clean copy
  clears, hooked and made (the manager's call, 2026-11-21): a page on a
  list, or that the agent flagged, is dangerous itself, so it gets the
  page warning below instead. Such a page keeps an agent tab's limits until
  its document is replaced: zen-observe and zen-core refuse what it asks
  for, and its window group can't open windows with an opener. When the
  user's own click or key there came just before (5 s, the window's capture
  listener, real input only), a refusal loads the page afresh, quietly,
  through zen-core's `cleanLoad`, with the form carried over, so their next
  try works:
  - `ZeniusUI.keptRefused({browser, kind, asked, evident})`, zen-core's
    `onKeptRefused`: a device, location or notification request;
  - `ZeniusUI.openRefused({browser, url, reopened, hold, evident})`,
    zen-core's `noteOpenRefused`: a window it couldn't open. If this page
    has no such evidence, the pages of its window group that do load afresh
    instead. One a plain tab opened instead (`reopened`) or one refused
    during a hold changes nothing;
  - `ZeniusUI.userLoadRefused` for a local address the page chose.
  The events say `evident: true` when the page has it and leave it out
  otherwise; without it, zen-ux reads `evidenceOf`. Without zen-observe's
  module, or when it fails, a page counts as evident (`unknown`), so these
  act as they did before rather than not at all.
- **The page warning** (`zenius-page-warning`, `pageWarningCard(evidence)`;
  the manager's call and wording, 2026-11-21). A page on a phishing or
  malware list (zen-observe's `listed`, from Safe Browsing) or that the
  agent flagged (`flagged`) says "This page is on a phishing or malware
  list", or "The agent flagged this page" with the agent's reason (one
  line of at most 200 characters, isolated, as text), and "Be careful what
  you enter here."; both: the list first, and "The agent flagged it too:
  <reason>." behind the '?'. It shows while the user is on the page: their
  hold, the agent paused, after the task, or a page no task has; not while
  an agent drives it. It comes as zen-observe's mark does (`onEvident`,
  through `ZeniusUI.evidenceAdded({browser, reason})`), as who holds the
  task changes, and goes with the agent's run or the document. It only
  informs: its one button is ✕, which keeps it away for that document; it
  takes no focus; a screen reader hears it as it comes up, when the tab is
  in view. Window sync moves it with the docShell.
- **Before the user acts.** From the user's first press or key anywhere in
  a page with evidence a clean copy clears (hooked or made), zen-input's guard holds their presses and keys there and
  has zen-core load it afresh (`cleanOnDemand`), in a live task's page or a
  kept one; zen-ux only watches (`onUserTyping`). If no new document comes
  in 15 s, the tab says "This page couldn't reload", "Clicks and typing
  here stay off until it does.", with [Reload] (zen-core's
  `cleanLoad` again; the pill stays while it tries) and ✕. It goes with the
  tab's next document (the manager's recommendation, 2026-11-20). When the
  new document came in with evidence too (zen-core's `stillEvident`: a popup
  or other window on the site shares its group and holds the agent's code),
  Reload alone can't help until that window closes. Then the note reads
  "Clicks and typing here stay off. Close the popup or other window on this
  site, then reload.", and a screen reader hears it.
- **A page that loaded afresh at the user's press or for a hold**
  (`zenius-reloaded`, `reloadedCard({clickLost})`; the manager's ask,
  2026-11-21, after a React form came back at its defaults and the user
  submitted it): when `cleanOnDemand`'s result has a `how` (null: nothing
  to clean); at a Take over whose `userTakeOver` result has one (also on
  the task's other pages in its `reloaded`); and at the agent's hand-off
  whose `spaceChanged` has `reloaded` (on the page handed off, the
  `pages.userTab` zen-core held), and on each page zen-core noted for that
  hold (the record's `handBackReloaded`, by label, which the hold's start
  clears). zen-input's form tests found the hand-off's gap: a press there
  submitted the form's defaults with no word of the reload. The title is "Your click didn't go through",
  with "the page reloaded", when the press went nowhere (zen-input's
  `field` is false), else "This page reloaded". It says why
  (`reloadReason`, the user's pass on defenses, A1), from the evidence
  zen-core acted on (`cleanOnDemand`'s `evidence`, `userTakeOver`'s by
  label) or else the page's own as the press came: "the agent's code had
  changed it", with what it left behind the '?', or "the agent made
  it". The line: "A form here may
  be back to its defaults: check it before you submit.", and behind the
  '?' "It reloaded without the agent's changes." zen-core's `carried` doesn't
  change it: a framework's state and custom widgets don't come back. It only
  informs: its one button is ✕, it takes no focus, a screen reader hears it
  when the tab is in view, and it goes with ✕ or the tab's next document.
  At a hand-off it comes after the hold's card, and is heard after it.
- **Pages the agent made** (data:, blob:, a popup its code filled;
  zen-observe's `agentMadePage`) can't be cleaned by a reload. As the user
  goes to type there (a field has the keyboard after their click, key or
  Tab, or when they switch to the tab), the pill `zenius-kept-code` says
  "The agent made this page", "It might contain malicious code. Keep
  sensitive information out.", with ✕, once per document. A refusal there
  says what it took: "Camera blocked", "The agent made this page, and it
  might contain malicious code, so it can't use your camera." (likewise
  microphone, screen, location, notifications, windows). Typing stays on
  (the user's decision, 2026-11-20). A pill comes up on the page's live
  copy only, announced, with no focus taken; ✕ hides it for that document.
- **The note.** When the task ends (finish or the panel's Stop) and when
  the agent closes a page the user views, zen-ux notes the pages the agent
  made (`agentMadePage`, while zen-observe's record of the task exists),
  for their pill. One the user kept from the agent's close while the task
  went on joins the kept pages when it ends. `ZeniusUI.madePage(target)`
  returns `{task, kept}` for such a page's current top document, or null.
  A new top document has none, and a claim after a Stop lifts the
  end-of-task notes. A page the agent's code only ran in gets no note: the
  evidence flag covers it. (`keptAgentCode` and `ui/agentmark.sys.mjs`,
  which stood in for that flag, went once the world tracked writes.)

**The hand-off and Take over.** The user always types in the agent's own
tab; zenius makes that safe itself, so nothing in the UI asks the user to
decide anything about safety (the user's correction, 2026-11-20). There is
no own tab.
- **Take over** and zen-core's `spaces.handOff` load the handed page afresh
  first when the agent's code could see what the user types there, and the
  pages of its group the sandbox wrote into, in place (the user's decision
  (A)). Each page that loaded afresh says so (`zenius-reloaded`, above).
- **A tab that joins the task** while the user holds it (opened from the
  agent's page) says "Agent's tab · <task>", "You opened it from the
  agent's page, so it's part of the task: the agent can use it once you
  resume it.", with [Resume agent].

**The local-network notice** (the user's design, 2026-11-20). zen-observe
refuses a load the user starts to a private address or a `.local` name in
an agent's tab, and tells zen-ux (`onUserLoadRefused`, `{browser, url,
origin, reason, typed, scope, evident}`).
- **In a task's tab** (the user's hold included), the pill
  `zenius-localnet` says "Network access denied · <host>" (a host over 40
  characters shows its end), "The current network policy doesn't allow
  agents to access <host>.", and behind its '?' that the address is on the
  local network and what the buttons do.
- **Open it yourself**, the main button: the address the user typed, or the
  home page of the site the page chose, in a new tab of the user's own
  Space, selected (they asked), in the agent tab's container, with no
  opener, marked the user's own (`pages.markUserOwn`).
- **Add to allowlist**, only for an address the user typed: zen-ux appends
  that exact host to `zenius.agentTabs.allowPrivateNetworks`, then the
  address loads in the agent's tab (the manager, 2026-11-20: the write is
  zen-ux's).
  - Only the user's own click writes it: a trusted click on that button, in
    that tab's card. The card is chrome, which page code can't reach, and
    the agent's synthesized clicks and keys never leave its content
    (`tests/ux/localnet.test.mjs` presses it every way the agent can: a
    click where it shows, Tab, Enter, Space, and its own code).
  - The format is zen-observe's (their reader, `parseAllowList`, runs at
    each request): `, <host>` appended, the host as `nsIURI.host` gives it,
    lowercased (IPv6 without brackets), never a port or a `/bits` range,
    and nothing when an entry already equals it.
  - zenius writes the list nowhere else. Removing an entry stays in
    about:config.
- **An address the page chose** (a link, a subresource) gets [Open it
  yourself] and ✕ only: allowing it from there would let a page reach a
  device. Its '?' says "It's on your local network, and this page tried to
  reach it; opening it yourself opens its home page in a tab of yours."
- **In a kept page** with the agent's writes, a refused load the page chose
  makes it load afresh, quietly, when the user acted just before; no pill.
- **When it goes:** with the tab's next document, on ✕, or after a button.
  It's announced when its tab is in view, and takes no focus.

**The page-code card** (`ui/pagecode.sys.mjs`; zen-input's glue, with
zen-ux's OK, 2026-11-21). With `zenius.agentTabs.pageCode` at "ask",
zen-observe holds the agent's page code on a site the user hasn't allowed
and asks once per task and site (`onPageCodeAsk`, `{space, browser, site}`;
`space` is the task's record). The tab of `browser` shows the pill
`zenius-pagecode:<site>`, one per site per task: "Allow the agent's code on
<site>?" (the host for https, else the whole site, never cut) with [Allow on
this site] and [Not now].
- **Allow on this site** calls zen-observe's `allowPageCodeSite(site, event,
  card)`, only on a trusted click on that button in that card
  (`#allowLocal`'s check), which writes the exact site to
  `zenius.agentTabs.pageCodeSites` once. Every card asking for that site
  goes. The card stays when the write didn't happen.
- **Not now** calls `declinePageCode(space, site)` and writes nothing; the
  task isn't asked again for that site.
- **When it goes:** after a button, when its task ends (`spaceFinished`, or
  a Stop or finish that leaves its tabs), or with its tab. Not with a new
  document: the ask isn't made again. It's announced when its tab is in
  view, and takes no focus.
- Its title wraps, and the buttons go under it when they don't fit beside
  it (`zenius-ux.css`, for this pill only).
- For others: `pageCodeCard(site, actions)` gives the pill's opts (the Mac
  look test), `siteLabel(site)` the site as the card names it, and
  `PAGE_CODE_NOTICE` the notice's prefix.

**The claim prompt** (the manager's decision on zen-input's method audit,
item 6). When an agent claims a user's Space or an ended task, zen-core's
gate asks the user:
- zen-core sends `claimAsked {id, space, name, client, until}` in process
  (`emitLocal`). There's one pending ask per Space. `client` is the label
  the claim call gave, which zen-core sanitizes, or null. `until` is the
  call's timeout, Ego's 10 minutes by default.
- ZeniusUI shows "Agent request · denied in {t}", with zenius's own words
  first, "An agent asks to work in your Space “<name>”.", and only then
  the client's label, "It calls itself “<label>”.", in the same plain
  text. A steered agent mustn't pose as zenius or the browser (the
  manager's rule). **Allow** (primary) and **Deny** go on the selected tab
  of every window. The prompt moves with the selection, takes no focus and
  selects nothing. Its buttons are chrome: only real clicks reach them,
  and they arm after 400 ms.
- Both names are cleaned again here, as zen-core's runtime does
  (`plainText`): no Unicode Cc or Cf characters (an RLO would reverse the
  rest of the line, a zero-width one hides), no line or paragraph
  separators, whitespace collapsed, at most 40 and 60 code points. The
  Space's name is cleaned too: an ended task's name was the agent's.
- A click calls `service.spaces.answerClaim(id, allow)`, and every
  window's prompt goes. zen-core's `claimSettled {id, verdict}` (allow,
  deny, timeout, gone) removes it too, and so does a second past `until`
  without either: nothing answers for the user.
- A window that opens while an ask waits shows it, from
  `service.spaces.pendingClaims()`.
- Notices count down in minutes from a minute up (`{t}` in the detail).

**Accessibility** (the manager's pass and decisions, 2026-11-20; the
survey is in `docs/reports/zen-ux.md`).
- **Announcements.** Only the moments that need the user are announced.
  They go through Firefox's own `A11yUtils.announce({raw})`: an ARIA alert
  in the window the user was in last, since Firefox notes that JAWS ignores
  aria-live in its chrome. Nothing moves focus.
  - "Agent needs you in <task>, on <site>. The agent says: “<state text>”."
  - A permission or passkey handoff: "Agent paused in <task>, on <site>:
    page asks …"
  - The local-network pill, when its tab is in view: its title, host and
    whole small text.
  - A kept page the agent made, as the user goes to type there or after a
    refusal there, and "This page couldn't reload": the pill's text.
  - The claim prompt: "Agent request." and its sentence.
  - A task that finished on the tab the user is viewing: "Task finished:
    <task>. This tab closes when you leave it."
  - Never routine agent actions, an agent's close of one page, or a pill
    shown again for a new window or after a restart.
  - Moments that come together are heard together. The announcer keeps
    one label, which each announcement replaces, so announcements within
    `ANNOUNCE_MS` (300 ms) of the first go out as one, each in the order it
    came and a repeat dropped (B2: four came within 27 ms). One that comes
    alone goes out that much later.
- **Pills** are groups named by their text, which a screen reader reads as
  the user Tabs to their buttons. As live regions they would be read
  twice.
  - VoiceOver reads a focused button's own name, not its group's (the
    user's VoiceOver check, 2026-11-20). So each button is described by the
    pill's text (`aria-describedby`), countdown included. VoiceOver reads it
    after the button, as the button's hint. The button keeps its short
    name, for Voice Control.
  - The description is a hidden copy of the pill's name
    (`.zenius-card-desc`). It follows the countdown while the focus is
    elsewhere, so it's current when the user Tabs to a button.
  - While a button has the focus, the description changes at most every
    30 s (`DESC_FOCUSED_MS`), and catches up when the focus leaves. Gecko
    fires a description change on the focused button at each change, which
    a screen reader may read: every second of the takeover prompt's
    countdown.
  - Gecko computes it so (`a11y.test.mjs`, with the accessibility service
    on for that test only).
- **Keyboard.** A pill's buttons come after the page in the Tab order: Tab
  past the page's last element, or Shift+Tab from the address bar (F6 or
  Cmd/Ctrl+L first). This holds with macOS's default tab focus too
  (Keyboard navigation off). Enter and Space press them once they arm. The
  ✕ is a button named Dismiss. Focus in a pill opens its small text, '?'
  part included. The strip is in the sidebar's Tab order, and Enter opens
  the panel.
- **The panel's rows** are groups named after their tasks, so Open, Resume
  agent and Stop say which task they're for. For VoiceOver, each button and
  tab in a row is also described by the row, the Resume line under its
  buttons included (once a secret was typed: "Resume clears …" after the
  panel's Pause, "Resume agent clears …" in the user's hold). Close task
  keeps its title as its description, which says what it closes.
- **Right-to-left names.** Every name zenius puts into a string goes
  through `ui/text.sys.mjs`'s `isolate()`: task, Space and client names,
  state text and action labels, page titles and hosts.
  - `isolate()` wraps the name in FSI…PDI, as Fluent does. It first removes
    the name's own embeddings, overrides and isolates, and turns control
    characters into spaces.
  - Each part is isolated before the parts are joined.
  - The tag, a pseudo-element, uses `unicode-bidi: plaintext`.
- **Contrast.**
  - Muted pill text is 70 % ink: AA over a white or a black page, in both
    themes. The header status pill's inks are AA on their tints.
  - Under `prefers-contrast: more` (macOS's Increase contrast), pills are
    opaque with full-ink text and solid edges, and buttons and tags get
    edges.
  - Under `forced-colors` (Windows High Contrast only, untested here),
    edges take system colors and the state dots keep theirs.
- **Reduced motion**, as before: the cursor jumps, pills fade in, and
  nothing pulses.
- **Layouts** (`tests/ux/layouts.test.mjs`): single toolbar, multiple
  toolbars, collapsed, the sidebar on the right, compact mode, two windows
  and split view. 1.24 has no horizontal tabs.
  - Known gap: compact mode hides the sidebar, and the strip and the badge
    with it. A user there learns of a moment that needs them only from the
    OS notification, if they turned it on.
  - The manager decided against flashing the sidebar, which would draw
    over the user's page (I1).

**Two windows** (`tests/ux/windows.test.mjs`; zen-core's "Windows: a page
is its sync id"). What zen-ux shows on a tab stays on the copy that holds
its page, the one the user sees:
- **On zen-core's `pageMoved`**, the pill, the cursor (`moveCursorTab`)
  and the takeover prompt (`Takeover.movePage`) move to `to`. The pill is
  drawn again there, so its buttons act in that window. The focus stays
  where it was (`removeNotice(…, {refocus: false})`).
- **Tabs that aren't pages** follow Zen's swap themselves: on
  `EndSwapDocShells`, which fires on both browsers, after a microtask. The
  pill of a close that waits for the user (`moveNotice`) goes to the copy
  Zen marks visible.
- **Claim prompts** stay per window, on each window's selected tab, so two
  copies of one tab each get one. An answer in any window removes them
  all.
- **The user's window.**
  - The tasks panel's Open, Take over and tab buttons watch the task in the
    panel's window, on its copy (`watch(rec, win, {tabId})`).
  - Zen then gives that copy the page, and no other window's view moves.
    A notification's click still opens the window that has the page.
- A kept page's pill shows on its live copy only (`liveCopy`).
- The takeover's record of the user's last key is keyed by the page's
  `browserId`. So `isUserUsing`, the clipboard's test for a copy the user
  made, follows the page too.

**Held calls.** The manager's rule (2026-11-20), with details settled by
zen-core, zen-sdk and zen-ux (`docs/research/ux.md` §7b):

- **Which calls wait.**
  - zen-core's dispatcher passes the I3 gate before every gated call.
  - Mutating calls wait while the Space is paused (takeover prompt, the
    panel's Pause).
  - Reads (snapshot, info, url, `waitFor*`, events, `pages.list`) never
    wait. Like Ego, they still fail while the user has control.
- **Mid-action.** `ctx.gate()` passes the gate again for the call's own Space
  and returns the ms held. Pointer actions call it after `moveCursor()` and
  add the ms to their deadline.
- **Frames while held.** The runtime sends
  `{"id": N, "held": true, "reason": "paused"}`, then `{"id": N, "held":
  false}` on release, or just the final result or error. Every hold, the
  mid-action one included, sends its own pair.
  - Frames go only to requests whose frame has `"progress": true`. The SDK
    sets it from 9d9eec9 on. A client that takes the first frame with its
    `id` as the answer would otherwise carry on while the action is still
    held. Without the flag, the call is held silently.
- **Timeouts.**
  - Held time is left out of the method's timing: its clock starts at
    release.
  - The SDK stops that call's safety timer on `held: true` and restarts it
    in full on `held: false`. It ignores progress frames it doesn't know.
- **Connection closes while a call is held.** The call is dropped without
  running. It hasn't started, so "a disconnect cancels nothing that already
  started" still holds.
- **Control leaves the agent during the hold.**
  - Take over fails the call with `ZEN_TASK_SPACE_USER_IN_CONTROL` (`data:
    {space, reason}`).
  - Stop in the panel, or `finish`, fails it with `ZEN_TASK_SPACE_INACTIVE`.
  - A Space that's gone gives `ZEN_TASK_SPACE_NOT_FOUND`.

## Refs and locators (zen-snapshot)

zen-snapshot maintains this section; the design is in
`docs/research/snapshot.md`. zen-input resolves `@N` targets and `loc=`
locators through these modules. Their exports stay stable; zen-snapshot tells
zen-input before changing them.

**Refs, in the parent.** One registry per tab:

```js
import { Refs } from "chrome://userscripts/content/zenius/snapshot/refs.sys.mjs";

Refs.parse("@21");           // → 21; also "ref=21" and "21", as Ego's parseRef; anything else → null
Refs.resolve(browser, 21);   // → {refId, browsingContext, innerWindowId, localId, role, name}
Refs.markStale(browser, 21); // after content reported the node gone
```

- `resolve` throws `ZEN_REF_NOT_FOUND` ("Unknown ref: 21; take a new
  snapshot") for a number this tab never printed or has evicted, and
  `ZEN_REF_STALE` ("Stale ref: @21; take a new snapshot") once the ref is
  stale.
- A ref turns stale when its document goes away (navigation, reload, a
  replaced iframe) or the tab stops showing it (a page kept in the bfcache
  still has its document), when a `full_page` snapshot doesn't print it, or
  through `markStale`. A later snapshot that prints the same node revives it under
  the same number. Nothing re-matches by role and name.
- `browsingContext` is the ref's own frame, possibly an out-of-process
  iframe. Call `ctx.content(browsingContext, …)` with `{refId,
  innerWindowId, localId}` in the args.
- Numbers only grow within a tab. The registry keeps at most 10,000 stale
  refs per tab and goes away with the tab.

**Refs, in content.** In the ref's own frame:

```js
import { resolveRef } from "chrome://userscripts/content/zenius/content/snapshot/registry.sys.mjs";

const el = resolveRef(actor, { refId, innerWindowId, localId }); // Element (Xray view)
```

It throws `ZEN_REF_STALE` with the message above when the frame's document
changed or the node is gone: garbage-collected, out of the document, or
moved into another document (a frame's, another window's, a windowless
one). Call `Refs.markStale(browser, refId)` in the parent when it does.

`resolveRef(actor, ref, { detached: true })` also returns a node the page
took out of its document and may put back, as Ego's refs do (input-gaps
11). Only element actions and `dragAndDrop` pass it (`resolveTarget` in
`content/actions.sys.mjs`): they check `isConnected` themselves and retry
"element is not connected" until the node is back. A node moved into
another document is stale either way. A snapshot's `rootRef` and
`waitForSelector`'s probe keep the strict resolve.

A ref can resolve inside a UA widget: the `spinbutton` fields of a date or
time input (`<span class="datetime-edit-field">` in Gecko's datetimebox),
and a media element's controls (`<button id="playButton">`,
`<input type="range" id="volumeControl">`, … in its videocontrols). Their
`getRootNode()` is the host's UA shadow root. Hit testing there finds the
host (`<input>`, `<video>`), as page content would; `page.click` on a
media control plays, pauses and unmutes.

**Locators, roles and names, in content.** A small module, without the
snapshot walker:

```js
import { parseLocator, queryLocator, ariaRole, accessibleName } from
  "chrome://userscripts/content/zenius/content/snapshot/aria.sys.mjs";

parseLocator('role:button[name*="save"]');
// → {kind: "role", role: "button", name: "save", nameMode: "substring"}
//   {kind: "css", selector} | {kind: "href", href}; null if it isn't a locator
queryLocator(document, 'role:button[name="Save"]'); // → Element[] (string or parsed form)
ariaRole(element);       // → "button" | "link" | … | null
accessibleName(element); // → "Save"
```

- `queryLocator` searches one document and its open shadow roots, in Ego's
  order: the document's matches, then each open shadow root's, depth first.
  It doesn't cross frames: run it in each frame and add up the counts. It
  reaches what Ego's resolver reaches, so a locator that a snapshot printed
  matches exactly its node. An invalid selector throws
  `ZEN_INVALID_ARGUMENT`.
- Cost on the GitHub repository page (2,400 elements): `css:` 2–3 ms,
  `href:` 3–5 ms, `role:` 9–30 ms (accessible names dominate). The first
  call in a document also loads the scripts, about 10–20 ms.
- The locator text is what follows `loc=`:
  - `css:<selector>` is `querySelectorAll`. Hidden elements match; closed
    shadow roots don't.
  - `href:<value>` matches an `a[href]` whose resolved `pathname + search +
    hash`, or whose full `href`, equals the value.
  - `role:<role>[name="…"]` and `role:<role>[name*="…"]`. The name is a JSON
    string, a single-quoted string or bare text, as in Ego's
    `parseLocatorName`. Role matching follows Ego's accessibility-tree
    lookup:
    - Elements hidden from the accessibility tree never match.
    - Roles compare lower-cased, with `img` equal to `image`.
    - `name=` compares the accessible name exactly.
    - `name*=` matches a case-insensitive substring after collapsing
      whitespace on both sides.
- `ariaRole` gives the ARIA role, explicit or implicit (Playwright's
  `getAriaRole`). `accessibleName` follows accname 1.2 with Chromium's
  choices where browsers differ (Playwright's `getElementAccessibleName`),
  whitespace collapsed and trimmed.

## Navigation and observation (zen-observe)

zen-observe maintains this section. Its parent-side modules live in
`runtime/JS/zenius/observe/`; the design is in `docs/research/observe.md`.

**What runs with no task (I4).** `observe/setup.sys.mjs` installs
zen-observe's hooks once. The observers that also see the user's own
browsing run only while they have something of the agent's to watch
(`syncHooks`):

- `observe/network.sys.mjs`'s six HTTP topics and the downloads module's
  `blocked-automatic-download` run while a task has pages
  (`TASK_BROWSERS_KEY` isn't empty). zen-core's `publishAgentBrowsers`
  emits the local event `taskBrowsers` after each change, before a new
  page's first load. Turning the network observers off forgets the
  requests in flight, whose ends won't be seen, so a tab that joins a
  later task doesn't wait on them for network idle.
- `observe/dnsprefetch.sys.mjs`'s three `http-on-examine-*response`
  observers run while a task has pages. They add `X-DNS-Prefetch-Control:
  off` to each document and frame response that `requestScope` places in
  a task ("task" scope), fresh or from cache. A document fixes whether it
  prefetches when it's created, and a page can't read its document's
  response headers. `docShell.allowDNSPrefetch` can't do this: turning it
  off leaves the live document prefetching, and a cross-site load gets a
  new docShell with it on (measured 2026-11-20).
- `observe/navguard.sys.mjs`'s content policy (category `content-policy`,
  `@zenius/navguard-policy;1`) is registered under the same rule as the
  local network's observers below: while a task has pages or a page keeps
  the agent's code. It sees every document load in the browser.
- `observe/localnet.sys.mjs`'s `http-on-opening-request` and
  `http-on-modify-request`, and `observe/swbypass.sys.mjs`'s
  `http-on-opening-request`, also run while a page keeps the agent's code
  after its task (`hasAgentCodeMarks()`). `observe/agentcode.sys.mjs`
  drops a mark when its document is destroyed (`window-global-destroyed`,
  heard only while a mark exists) or its tab is gone, and tells the setup.
- `observe/audio.sys.mjs`'s `browsing-context-attached` runs while zenius
  keeps a page muted.
- `hookState()` reports these flags, for tests
  (`tests/observe/hooks.test.mjs`). In content,
  `content/refusals.sys.mjs` loads its text cap and media guard only
  when a task's page first needs them.

**The page gate.** `methods/navigation.sys.mjs` exports `pageGates =
[pageReadyGate, webContentGate]`. zen-core's dispatcher runs them after the
ownership gate for every `page.*` method. Each is a plain function: it
returns nothing when the page is ready, and a promise only when it must
wait. `webContentGate` is I5's (below).

- Methods it never holds or fails: `page.goto`, `page.reload`,
  `page.events`, `page.waitForURL`, `page.waitForLoadState`,
  `page.waitForEvent`, `page.acceptDialog` and `page.dismissDialog`.
  Waiters among them must be armed before the next frame's action runs.
- `page.url`, `page.title` and `page.info` wait for a pending navigation
  like the rest, but an open dialog doesn't fail them.
- While a JavaScript dialog is open in the tab, it throws
  `ZEN_PAGE_DIALOG_OPENED` at once, with Ego's message and the dialog in
  `data.dialog`. Not for `page.mouse.*` and `page.keyboard.*`: Ego drops
  raw input silently while a dialog is open, so their handler should check
  `currentDialog(browser)` and return without sending.
- While a top-level navigation is pending (started, not yet committed), it
  waits for that navigation to commit or end, for at most
  `params.responseTimeout` ms (the SDK sends Ego's
  `EGO_BROWSER_RESPONSE_TIMEOUT_MS`; default 15000). Then it stops the
  navigation and throws `ZEN_PAGE_UNRESPONSIVE` with Ego's message and
  `data: {stopped: true, currentUrl, method, waitedMs}`; for
  `page.evaluate`, `ZEN_PAGE_EVALUATION_TIMED_OUT` with `data.stopped`.
  Gecko keeps the old document responsive meanwhile, so without this wait a
  call would act on a document that is about to go away.
- `page.waitForFunction` and `page.waitForSelector` don't wait for a pending
  navigation: they poll whatever document the tab shows, and follow it
  through the commit, within their own timeout.
  - waitForFunction's poll treats a throw as not yet in two places. The
    content loop does while `document.readyState` is `"loading"`. The parent
    does while the tracker has a navigation pending. That was zen-eval's
    round 2: a results page with no body yet.
  - After a navigation, the next document's first poll waits `polling` ms
    (`delayMs`), the same cadence as Ego.

**Dialogs, for action receipts.** Dialogs in agent tabs never show UI: no
tab-modal dialog, no focus change, no tab switch. The page stays blocked in
`alert()`, `confirm()` or `prompt()` until the agent answers. The exception
is a dialog of a document that isn't web content (`notWebContent`, such as
an add-on's frame), which is never the agent's. While the user can't see
the tab (`isBrowserVisible`), `takeOver` dismisses it unseen. When they
can, it goes to Firefox's own UI for the user, and `currentDialog` never
reports it.

Firefox's own questions about what a page did come the same way, as a
`confirmEx` no page can open (an insecure form submission, a form sent
again on a reload). `takeOver` answers them Cancel at once in a tab the
agent drives and reports `browserConfirmation` with Firefox's text
(`reportRefused`, so an action's receipt has it). A navigation that waits
for a commit also wakes on it (`watchRefusals(browser).first(kind)`), since
a reload the question stopped never starts.

```js
import { watchDialogs, currentDialog } from "chrome://userscripts/content/zenius/observe/dialogs.sys.mjs";

const w = watchDialogs(browser);           // before the action
const call = ctx.content(bc, "actions#click", args);
call.catch(() => {});                      // it may settle long after
try {
  await Promise.race([call, w.opened]);    // a dialog ends the action early
} finally {
  const dialog = w.stop();                 // {type, message, defaultPrompt?, url} or null
  if (dialog) receipt.dialog = dialog;
}
currentDialog(browser);                    // the open dialog, or null
```

- `type` is `alert`, `confirm`, `prompt` or `beforeunload`; `defaultPrompt`
  is there for `prompt` only; `url` is the document that opened it. This is
  Ego's dialog object.
- A content call that opened a dialog doesn't return until the agent
  answers it, so race it against `w.opened` rather than awaiting it.
- `answerDialog(browser, accept, promptText?)` answers it (what
  `page.acceptDialog` and `page.dismissDialog` call); false when none is
  open.
- **For zen-ux, at takeover:** `releaseDialog(browser)` hands the open
  dialog to Firefox's own prompt UI, so the user who takes over sees it
  instead of a page that looks frozen. It returns false when none is open;
  the agent no longer sees the dialog afterwards. Firefox flags the tab for
  attention, and a `beforeunload` prompt also selects its tab
  (tabbrowser's `DOMWillOpenModalDialog` rule). Dialogs that open once the
  user has control aren't intercepted at all.

**Navigation state, in the parent.**

```js
import { trackerFor } from "chrome://userscripts/content/zenius/observe/navtracker.sys.mjs";

const nav = trackerFor(browser);
nav.pending;                  // null, or {url, startedAt, ours} while a navigation hasn't committed
nav.listen(event => {});      // {type: "start" | "commit" | "sameDocument" | "stop", ...}; returns an unsubscribe
await nav.waitUntilSettled(ms); // true once nothing is pending
```

Actions that may navigate, like a click on a link, don't need to wait: the
gate holds the next call until the new document has committed.

A goto to the URL the tab shows with another fragment, or the same one
again, stays in the document, as in Chromium. Gecko reports only
`sameDocument` for it, and that ends the navigation goto marked pending
(`nav.markPending(url, {reload})`), so the next call doesn't wait for a
commit. A data: page's reload loads its URL the same way, so with a
fragment it scrolls and doesn't load the page again.

A tracker belongs to the page, not to a `<browser>`: `trackerFor` and
`peekTracker` key it by `browser.browserId`. When Zen's window sync moves
the page's docShell to another window's copy of its tab, the browserId,
the BrowsingContext and its web progress go too. So the same tracker goes
on hearing the page, and `nav.browser` is the copy that holds the page
now. Pass any copy's `<browser>` that holds the page (`pages.tabFor`).
`page.goto(url, {waitUntil: "commit"})` also waits, at most 250 ms, for the
first chunk to be parsed, as Chromium hands it over with the commit. Gecko
doesn't parse a document whose charset isn't declared before 1024 bytes or
its end.

**Downloads.** A download started from an agent tab goes to zenius's own
folder, with no downloads panel, no toolbar animation and nothing in
`~/Downloads` or history. `page.waitForEvent("download")` returns it.

- **The folder is under the profile:** `<profile>/zenius-downloads`, 0700,
  with each download in a folder of its own inside (`d<random>`, 0700).
  - The browser writes downloads outside any agent's sandbox, so the whole
    path must be out of the agent's reach.
  - The temp folder isn't. A sandboxed CLI may write it (Codex's
    workspace-write can), and a link put in place of a folder there has the
    browser write a site's bytes wherever the link points. A link there
    also has `download.read` hand the agent a file from outside its
    sandbox, or the cleanup delete outside (zen-input's find, 2026-11-21;
    zen-snapshot's `tests/snapshot/tools/staging-probe.mjs`).
  - No sandboxed CLI writes the profile. zen-input's uploads live beside
    the downloads, in `<profile>/zenius-uploads`.
- **Each start makes the folder afresh** (`remakeDownloadRoot`): the last
  run's folder goes whole, then the new one is made exclusively
  (`ignoreExisting: false`).
- **Every top context of an agent tab gets the folder.** `prepareBrowser`
  sets `downloadFolderOverride` at each gated call.
  - A cross-site load can replace the tab's top BrowsingContext (Gecko
    160's `fission.bfcacheInParent`), and the new one starts with no
    override: `CanonicalBrowsingContext::ReplacedBy` doesn't carry it.
  - A download the new page started by itself (an interstitial, a meta
    refresh) then had Gecko's temporary file in its default folder, the
    user's Downloads (zen-input's review of f5b49be).
  - So `contextAttached` sets the override as an agent tab's new top
    context attaches, before its first load. It does the same for a new
    tab an agent tab opened. It listens to `browsing-context-attached`
    only while a task has pages (I4), and `prepareBrowser` records the
    tab's browserId for a replacement it can't yet see as an agent tab.
  - The prompt fails closed for anything that misses. When the launcher's
    file (Gecko's temporary one) isn't directly in the root, the download
    is refused before Gecko moves that file or writes on through it. The
    file is removed, the tab gets the override again, and the agent is
    told "the browser began it outside the folder zenius keeps downloads
    in".
- **Every remove unlinks a link and never follows one.** `IOUtils.remove`
  is `nsIFile::Remove`, which looks at each entry with lstat, inside a
  recursive remove too. `discard` and `deleteDownload` remove only a folder
  directly in the root, and only while the root is still zenius's own
  (`removeOwnFolder`).
- **Old roots in the temp folder** (`zenius-downloads-<profile hash>`, `-1`,
  …, from before 2026-11-21) stay there, for install.sh's uninstall (its
  `rm -rf` doesn't follow links) and the system's temp cleanup. zenius never
  removes or moves them.
  - Removing one, in place or after moving it into the profile, recurses
    through folders that an agent which writes the temp folder, or is
    already inside one, can still change. `nsLocalFile::Remove` checks a
    folder with lstat, then opens it by path, so a folder swapped for a link
    in between has the link's target emptied (zen-snapshot's review of
    f5b49be, as of zen-input's uploads in 7a9df6a).
  - Removing only their plain files has the same flaw: each is reached
    through a folder that can be swapped.
  - `sweepDownloadLeftovers` touches only the root: it removes what no
    download holds. Tests and zen-snapshot's staging-probe call it.
- **Backstop checks:** a folder or file is zenius's own when lstat finds no
  link in its place and the path resolves to the one zenius made
  (`notOwn`), so a link above it fails too. The checks run at four points:
  - `targetFile`, just before the browser gets the path: the root, the new
    folder (made exclusively), and nothing yet where the file or its
    `.part` goes;
  - `register`, when Gecko's transfer joins;
  - when the download succeeds;
  - each `download.read`, through `finishedFile(entry)`.

  A failed check refuses the download (`download` refusal kind, "the folder
  it keeps downloads in had changed …") and removes what zenius can without
  following a link.
  - When the root itself was swapped, Gecko's own temporary file has
    already been made in the link's target. It is made exclusively under a
    random name, and Gecko's cancel keeps it once the response has ended,
    so the refusal removes it by the launcher's `targetFile`.
  - These checks only narrow a race: a path can't be checked and used in
    one step. The profile's placement is the fix.

**Download caps.** `observe/downloads.sys.mjs` counts a task's live
downloads and their `currentBytes` (`taskDownloads(spaceId)`). It checks a
new download when it joins (`register`: refused, it is discarded and never
announced) and every change while it runs (refused, it stays with
`entry.refusal`, which `failureOf` reports). `discard` cancels and finalizes
with `removePartialData`, then removes the download's own folder in the
root, nothing else (`removeOwnFolder`). `deleteTaskDownloads(spaceId)` runs at
`spaceFinished`. Firefox's `blocked-automatic-download` is observed after the
downloads module's own observer is registered (ours goes in only once the
list exists, while a task has pages), so ours runs first; it marks
the next `DownloadSpamProtection.update()` for that window and site to be
skipped, so an agent tab's blocked download never opens the user's panel.

**Event buffers.** `observe/events.sys.mjs` keeps each agent page's
`page.events()`: `pushEvent(browserId, method, params)` copies `params`
through `capText` (`observe/textcap.sys.mjs`, usable in content too). That
cuts the text and marks the event `truncated`. The buffer holds 10000 events
and 1 MiB, oldest out first. `sweepEvents(keep)` runs at `pageClosed` and
`spaceFinished` and keeps only tabs zenius still manages, and
`bufferedEvents(browserId)` reports a buffer's size. Content modules that
forward page text (the console, refusals) cut it before it leaves the
page's process. `cut()` copies what it keeps: a SpiderMonkey `slice()` of a
long string keeps the whole string alive.

**The agent's JavaScript and control (I3).** A method that runs agent
JavaScript in a page gates as `mutate`, so a pause holds it. While it runs,
`watchControl(rec)` from `observe/control.sys.mjs` resolves `lost` when the
agent loses the Space: `{paused: true}`, or `{error}` with the gate's error.
`stoppedError(lost, rec, method)` turns either into the error to throw.
`page.waitForFunction` cancels its content poll (`evaluate#cancelWait`) and
holds; `page.evaluate` fails and stops a script still running.

**Agents stay in web content (SPEC §3.9 I5).** `observe/webcontent.sys.mjs`
holds the rules; use it rather than your own checks:

- An agent's load: `checkAgentLoad(uri, method)` throws
  `ZEN_URL_NOT_ALLOWED` unless the URL is `http:`, `https:`, `data:`,
  `blob:` or `about:blank`; then load with `agentLoadOptions(uri, browser)`
  (`{triggeringPrincipal, loadFlags}`), never the system principal.
  zen-observe's `navigate()` does both; zen-core's restore of a tab
  (resolvePage) is the next caller.
- The page's document: `webContentGate` refuses every method that the
  dispatch gives the page gates, unless its declared I5 class (`ctx.i5`) is
  `outside` (goto, reload, url, info, events and the navigation and event
  waits). It refuses with `ZEN_PAGE_NOT_WEB_CONTENT`, by principal, URL and
  process (`notWebContent(wgp)`), before the handler runs. A ctx without a
  class goes by `OUTSIDE_DOCUMENT`, the same names.
- Frames: zen-core's `ctx.content` calls `checkContentCall(method, bc, i5)`
  first, with the method's declared class. Every class but `outside` and
  `dev` is checked, unknown ones included, so a document method's call to an
  add-on's or error page's frame rejects with the same code
  (`data.frame: true`). Without a class it goes by `actsInDocument(method)`.
  Content code that walks into a same-process frame's document itself
  skips it unless `isWebDocument(doc)`: zen-snapshot's `frameContent` and
  zen-input's `contextsFrom` do. Do the same in any new frame walk.
- Screenshots: `checkPaintable(method, browser, label)` refuses a page
  that holds the browser's own frame, shown or hidden. It returns the
  outermost add-on frames. `page.screenshot` refuses the shot when there
  are any, unless `setAddonPaintOver(true)` (methods/observe.sys.mjs),
  off until the first update: then it paints over them in gray.
  - Content's `nav#frameBoxes({border, content})` gives each frame's box in
    the document that holds it, with that document's viewport size and
    scroll.
  - `addonAreas` maps an add-on frame's border box up through the frames
    that hold it, by offset and scale; a rotated, skewed or flipped frame
    gives its whole box. Screen coordinates can't do it: in a cross-site
    frame's process, `mozInnerScreenX` and `toScreenRect` leave out the
    frame's offset in the page (headless, Gecko 160).
  - The frames are placed before, during and after the paint. A shot counts
    only when all three agree; otherwise it tries again, three times in
    all, then refuses. With no add-on frame there is no extra call.
- Files: no method takes a path or writes or reads a file an agent names.
  Send and return bytes (base64), and let the SDK write them.
- Doctor: `i5Status(service.i5Hooks())` computes `browser.health`'s `i5`.
  `loads` comes from `LOADABLE`, and `pageGate` checks that
  `webContentGate` is among the service's page gates. For `contentGate`,
  `ctx.content` (as `page.click` gets it) must refuse the browser window's
  own document before sending anything. For `refuses`, `checkAgentLoad`
  must refuse `about:config` and `file:///`, and `notWebContent` the
  browser window's document. A new I5 check belongs in it too.

**Refused surfaces.** Firefox UI an agent page may not open (over the
user's view, outside the browser, or into the OS) is refused, and the agent
is told: a `Zenius.refused` event `{kind, message, url}` in `page.events()`,
and `refused: [{kind, message}]` in the receipt of the action that caused
it. PROTOCOL.md lists the kinds; the I1/I4 sweep (docs/research/observe.md
§10) lists every surface and its owner. Where each refusal lives:

- `observe/refusals.sys.mjs`, in the parent: print, HTTP sign-in, external
  apps, `.xpi` installs (amContentHandler), the pop-up-blocked bar
  (PopupAndRedirectBlockingParent), `registerProtocolHandler`
  (WebProtocolHandlerRegistrar), and backstops in the DOMFullscreen and
  PointerLock parent actors.
- `content/refusals.sys.mjs`, in each agent document before its scripts
  (zen-core's `installPageGuards` calls `installRefusalGuards`): fullscreen,
  pointer lock, wake lock, speech, share. The page sees native-looking
  functions that check per call, so a tab handed to the user works as
  usual. A tab that becomes the agent's with its page already loaded
  (adopted, or handed back) gets them in every frame then, through zen-core's
  `installGuards`. Content refusals reach the parent as the `observe.refused`
  content event. The sound notice hears media start from the media guard
  (`content/media.sys.mjs`), which also hears elements in shadow trees and
  elements never put in the document (`new Audio()`).
  - The site's storage (`serviceWorker`, `cacheStorage`; own-tab.md,
    item 3) is refused in every document of a task's page, whoever holds
    it (`isAgentTaskPage`, not `isAgentDriven`).
  - It also covers a popup a task's page opens, from its first document,
    before the parent routes it. `isTaskPopup(bc)` keeps the popup's
    opener as it was then, and zen-core's actor calls
    `installRefusalGuards` for such a popup's documents at
    `DOMWindowCreated`.
  - Workers: once per content process, an `nsIWorkerDebuggerManager`
    listener holds each new worker a task's page starts (dedicated, nested
    or shared) with `setDebuggerReady(false)`. It runs
    `content/workerguard.js` in the worker's debugger global, which puts
    the same refusals in the worker's realm through the Debugger API and
    reports each one through a breakpoint. Then it lets the worker run. A
    worker whose guard fails stays held.
  - Shared workers: in a task's page, the SharedWorker constructor adds
    `#zenius-agent` to the script URL, so Gecko starts a worker of the
    task's own, never one the user's tabs share. The marked URL is how the
    listener knows the worker.
  - BroadcastChannel: `guardBroadcastChannels`, in the same guards, makes
    the constructor a Proxy made in the page-principal sandbox, as for
    SharedWorker. It appends `\0zenius-<scope>` to the channel's name.
    - The scope (`channelScope`) is `task-<space id>` for a task's page,
      its frames and a popup on its way: the first top in its opener chain
      that `TASK_SPACES_KEY` lists. A document that keeps the agent's code
      after its task gets `agent`.
    - `TASK_SPACES_KEY` is a Map, browserId → space id. observe/setup.sys.mjs
      publishes it on each `taskBrowsers` event, right after zen-core
      flushes `TASK_BROWSERS_KEY`, so it's there before a new page's first
      load.
    - The prototype's `name` getter strips the suffix, and
      `prototype.constructor` is the wrapper.
    - Workers: `guardWorker` posts the wrapper's source and the owner's
      scope to workerguard.js right after `initialize`. The debugger global
      installs it in the worker's realm before it reports ready, so a
      worker stays held until its channels are scoped. A shared worker
      gets `agent`, since pages of several tasks may share it.
  - The user's devices and location (`deviceAccess`): `guardDevices`, in
    the same guards, in every page of the task (`isAgentTaskPage`). It
    reads two rules at each call:
    - `devices`: the agent drives the page (or, for a popup not yet the
      task's, its opener), or the page shows evidence.
    - `prompts`: evidence.

    `devices` covers MediaDevices' getUserMedia, getDisplayMedia,
    selectAudioOutput and enumerateDevices, Navigator's mozGetUserMedia
    and SpeechRecognition's start. `prompts` covers Navigator's
    requestMIDIAccess and Geolocation's getCurrentPosition and
    watchPosition. All are replaced before the page's scripts, so a
    refused request reaches neither MediaManager nor the geolocation
    service. The parent's permission UI would be too late: when a site has
    a grant, WebRTCParent's `checkOSPermission` asks macOS before any
    prompt of Firefox's. A refusal's message says why: the agent drives,
    or the evidence, by its first reason (`evidenceWords`). `tests/observe-vectors/devices.test.mjs` counts
    WebRTCParent's `webrtc:Request` messages and the network provider's
    `watch()` calls. Each report also carries `api` and `asked` (PROTOCOL),
    for zen-ux's card in a kept page.
  - Notifications (`notification`): `guardNotifications`, on evidence.
    The Notification constructor becomes a Proxy made in a sandbox with
    the page's principal, as for SharedWorker, which gives a fake
    (`FAKE_NOTIFICATION`) that fires `error`.
    `ServiceWorkerRegistration.prototype.showNotification` rejects.
    workerguard.js has the same fake for workers, and a test compares the
    two texts. In workers it holds for the task's whole life: a worker
    can't read the hold or the evidence (a residual, told to zen-ux). zen-ux's guard (`ui/systemui/ZeniusSystemUiChild.sys.mjs`)
    installs after it at DOMWindowCreated and wraps it: while the agent
    drives a page with the site's grant, theirs answers first.
  - WebRTC (`localNetwork`): `guardPeerConnections` makes RTCPeerConnection
    a Proxy whose construct throws NotAllowedError by the `devices` rule
    (Zen has no moz- or webkit- alias). WebRTC's own list of the browser's peer connections
    (`WebrtcGlobalInformation.getStatsHistoryPcIds`) is the test's counter.
- **The local network.** `observe/localnet.sys.mjs` cancels a task page's
  requests to private and link-local addresses and `.local` names, unless
  the host is in `zenius.agentTabs.allowPrivateNetworks`
  (`refusedReason(host, list)`).
  - It runs at `http-on-opening-request`, before the channel looks the
    host up or connects, and at `http-on-modify-request` for a redirect's
    next channel, which the first topic skips. The status is
    `NS_ERROR_LOCAL_NETWORK_ACCESS_DENIED`.
  - A request is the task's when its browsing context's tab is in the
    task set (`TASK_BROWSERS_KEY`), or a popup's whose opener chain
    (`opener`, `crossGroupOpener`) reaches one.
  - A request with no browsing context is the task's when it carries a
    task worker's mark (`taskWorkerMark(channel)`). The mark sits in the
    fragment of its loading principal's URL, which Gecko makes from the
    worker's URL. A worker script load carries it in its own URL.
    `requestScope` then gives `{browser: null, scope, mark}`. Such
    requests come from a task's shared worker (`content/refusals.sys.mjs`
    marks its URL) and from the workers it starts from a URL
    (`content/workerguard.js` marks theirs). Their refusal is told on a
    tab that `browserOfMark(mark)` finds (observe/setup.sys.mjs: the
    task's space in `TASK_SPACES_KEY`, or the hold in `HELD_PAGES_KEY`),
    or not told when none is open.
  - A blob worker's request names no tab and carries no mark: Gecko gives a
    blob worker its origin's principal, with no path, whichever code made
    the blob (`blobWorkerSite(channel)`; measured for the page's code, the
    agent's world and a worker). While a task's tab, or a tab whose top
    document holds the agent's code, has a document of that origin
    (setup's `taskTabShowing`), such a request is the task's for this
    refusal, told on that tab as "A blob shared worker of this site tried
    to reach …".
    - **The I4 cost** (the manager's call, 2026-11-21): meanwhile the
      user's own blob shared workers on that site lose the local network
      too. A public site's blob shared worker asking for a private address
      is rare and suspect.
    - A task's `data:` shared worker is refused in the page
      (`guardSharedWorkers`, SecurityError, `localNetwork`). Its origin is
      opaque, so its requests name no tab, mark or site.
  - Hosts are read as nsIURI writes them: IPv4 normalized to dotted quad
    and IPv6 in lower case. IPv4-mapped IPv6 counts as its IPv4.
  - `agentLoadRefusal(uri)` is page.goto's check before loading.
  - After a task, `requestScope(channel, {isTask, isAgentCode})` also
    counts a tab whose top document ran the agent's code ("agentCode",
    `agentCodeDocument`). There a top-level load with the system principal
    (the user's address bar, `typedTopLoad(channel)`) goes through.
  - **The site's service worker.** `observe/swbypass.sys.mjs` sets
    `LOAD_BYPASS_SERVICE_WORKER` at `http-on-opening-request` on every
    request `requestScope` places, but not on the user's typed load in an
    agentCode tab. That includes requests with no tab that carry
    `content/refusals.sys.mjs`'s mark (`zenius-agent`, `zenius-task-…`,
    `zenius-held-…`; `taskWorkerMark` above). For the script load of a
    task page's shared worker, the mark is in its URL's fragment. For
    every later request of that worker, or of a worker under it, the mark
    is in the fragment of the loading principal's URL, which Gecko makes
    from the worker's URL (measured on 160:
    `http://…/shared-nest.js#zenius-task-2`). So such a
    worker starts uncontrolled, and its requests skip the site's worker
    even after a claim. `content/workerguard.js` puts the mark in the URL
    of each worker such a worker starts from a URL (`workerMark`, sent
    with the channel scope), and the bypass also reads the mark from a
    worker script's own URL. The wrapper reads the worker's URL only when
    the worker starts another: read before the worker's script has
    loaded, `location` is empty, and stays empty (measured). A blob:
    worker's principal is the origin's and carries no mark. A blob worker
    started by such a worker after a claim inherits the site's worker,
    and nothing places its requests (the bound, research/observe.md).
    So the worker the site registered from the user's tabs sees none of
    a task's requests, navigations included, even after its
    `clients.claim()`. `content/refusals.sys.mjs`'s
    `guardServiceWorkerAccess` hides it from the page (no registration, a
    `ready` that never settles, no controller, a dropped
    `ServiceWorker.postMessage`) and reports `serviceWorker` once per
    document. Its listener drops the site worker's messages too
    (`message` and `messageerror`, trusted only), closes their ports and
    reports once per document. The listener is capturing and the
    document's first, so it runs before the page's listeners,
    `onmessage` and the agent's worlds'. Gecko 160 runs capturing
    listeners first at the target (measured), so only a capturing
    listener that a claimed tab's document added before adoption runs
    earlier. `content/workerguard.js` gives the workers a task's page
    starts the same answers and drops the site worker's messages the
    same way, with natives taken before the worker's code runs. (In
    Gecko 160, dedicated and shared workers have
    `navigator.serviceWorker`; an earlier probe that found none ran on a
    `data:` page.) Each worker reports `serviceWorker` once for a reach
    and once for a dropped message, apart from a refused registration.
  - `onUserLoadRefused(fn)` tells zen-ux's in-tab notice of a refused
    top-level load the user started: the system principal, or a gesture
    while the agent doesn't drive the tab. Its `scope` is the rule that
    refused it: "task" (the tab, or a popup's opener, is a task's) or
    "agentCode" (its document, or the opener's, ran the agent's code).
- **The navigation guard** (`observe/navguard.sys.mjs`; closed groups,
  item 4). Its content policy's `shouldLoad` takes document and frame
  loads of any scheme, before `http-on-opening-request`.
  - The source is the top of `WindowGlobalParent.getByInnerWindowId(
    loadInfo.triggeringWindowId)`; the target the top of
    `loadInfo.browsingContextID`. Only a source whose top document is
    marked (`agentCodeDocument`) is checked.
  - The target is outside unless it's the source's tab, a page of the
    source's live task (`taskOf`: the task set and the page record's
    `spaceId`), or a window that still shows its initial about:blank
    (`isInitialDocument`, or no window global yet): a window being opened,
    whose opening zen-core's items 2 and 3 decide (a kept marked page's
    `noopener` tab opens). The opener doesn't count: a
    `window.open(url, name)` on an existing window makes the caller its
    opener before the load is checked. After the task every other tab
    that has shown a page is outside.
  - An outside target gets `REJECT_REQUEST` and the source a refused line
    (`userTabNavigation`). It fails open on an exception, logged.
  - Measured in Gecko 160 (2026-11-20): from a same-site popup each way
    (location, replace, named open, link and form targets, the opener's
    frame, `blob:`, `about:blank`) arrives with the popup as source. From
    a cross-site popup Gecko itself starts no load into the opener, and a
    named open doesn't find the user's tab, so it opens a new window.
- **The hand-off** (the manager's rule, 2026-11-20): while the user types
  in the page H, nothing of the agent's reaches it. zen-core decides what
  loads afresh, from the evidence flag (`evidenceOf` and `needsCleanCopy`
  in `modules/handoff.sys.mjs`); this side guards the hold.
  - `agentSitesNear(rec, browser)` (`observe/agentcode.sys.mjs`): the sites
    (`siteOriginNoSuffix`) of the documents, frames' too, in the other
    windows of H's group (`top.group.getToplevels()`, less the hold's own
    popups) that may hold the agent's code. A window may hold it when its
    top document is marked, or, while the task lives (`rec`), one of its
    documents shows a site where the agent's code ran. The site rule also
    covers what the code left that isn't a write (a form value). The site
    rule skips fresh documents: a clean load's (zen-core's `cleanLoad`
    calls `noteCleanLoad`) until the agent's code runs in their group
    again; a window's that zen-core reloaded for the hold (`holdReload`),
    until the hold ends; and those a tab of another hold in the group got
    since that hold began (a task may hold several pages, zen-core's
    `holdFor`). A document that comes in beside a written one of its group
    is flagged written itself (`flagIfExposed`), which marks it.
    - Site, not origin: in Gecko 160 `dom.origin_agent_cluster.default` is
      false and `window.originAgentCluster` false (measured), so
      `document.domain` still joins a site's origins.
  - The hold (`observe/hold.sys.mjs`): zen-core calls `holdPage(browser)`
    before its quiet reload, and `releasePage(browser)` at Resume or any
    other end. `held` maps each held tab's browserId to the hold's (H's),
    published as `HELD_PAGES_KEY`. `before` keeps each held tab's
    documents (`innerWindowId`) from the start of its hold, for that site
    rule.
    - `holdPage` empties H's back-forward cache
      (`sessionHistory.evictAllDocumentViewers()`, as zen-core does when a
      tab joins a task).
    - A window whose opener is a held tab joins its hold at
      `browsing-context-attached`, observed only while a page is held (I4).
    - The navigation guard refuses a load whose target top is held and
      whose source top isn't in the same hold (`heldPageNavigation`,
      reported when the source is a task page or marked). Loads with no
      source document (the user's, zenius's reload) go.
    - `channelScope` gives a held tab's documents `held-<hold>` before the
      task's scope, and their shared workers get `#zenius-held-<hold>`, so
      the documents made in H during the hold share a channel or a worker
      with nothing else. Every task document's shared worker carries its
      scope the same way (`#zenius-task-<space>`, `#zenius-agent` after
      the task), so two tasks never share one.
    - The guard also refuses, whoever starts them, a session history load
      (`sessionHistory.requestedIndex` set) of a `data:` or `blob:` entry
      into H or its frames, and a frame in H of a site in
      `agentSitesNear(rec, H)`: the sites of the documents in the windows
      of H's group, outside the hold, that may hold the agent's code.
      zen-ux hears these and the other-document refusals through
      `onHoldRefusal(fn)`: `{browser, kind: "history" | "agentSite" |
      "navigation", url}`. Each refusal is told once in two seconds:
      Gecko may ask the policy more than once for one load.
    - `holdNeedsCoop(rec, browser, uri)`: zen-core asks it at the final
      response of a load into H's top document; true when `uri`'s site is
      in `agentSitesNear`. zen-core then sets COOP on the response, so H
      leaves the group as it loads.
    - `holdReload(browser, heldBrowser)`: zen-core calls it right before it
      reloads a window that reaches H, to keep H's opener. That tab's
      documents from then on count as fresh, so `agentSitesNear` skips
      them by site, until the hold ends; it doesn't join the hold.
    - Measured in Gecko 160 (2026-11-20): the browser's Back and Forward
      skip entries the user never interacted with
      (`browser.navigation.requireUserInteraction`), so they rarely reach
      the agent's `data:` page; the page's own `history.back()` does.
      After the guard refuses a history load, `requestedIndex` stays at
      the refused entry until the next load commits, and `stop()` doesn't
      clear it.
- **Refusals after the task** (`observe/agentcode.sys.mjs`).
  - `noteAgentCode` (page.evaluate, page.waitForFunction) marks the tab's
    top document (`innerWindowId`) before the code runs. `page.goto` and
    `page.reload` mark the document a `data:` or `blob:` load commits,
    whose page is the agent's own code (`pages.new` with a `url` goes
    through `page.goto`), and zen-input's paste with `html` marks the
    page too. It publishes the
    set to content as `AGENT_CODE_DOCS_KEY`
    (`content/refusals.sys.mjs`), so nothing is unmarked when the task's
    tabs leave `TASK_BROWSERS_KEY`.
  - A mark of the agent's world code lasts only while its world does (the
    manager's rule: a group holds the agent's code only while a page in it
    has a live world or is written). The parent's `discard` ends it
    (`forgetWorldMarks`) unless the page is written, and a written document
    marks its tab's top for good (`onWritten`). The marks of a page the
    agent made and of its html paste last while the tab lives. Back to a
    marked document finds it.
  - In content, `isAgentCodeDocument(bc)` reads `bc.top`'s current
    WindowContext. `isTaskDocument` and `isTaskPopup` count it, so the
    task-long refusals apply. `needsRefusals(bc)` is what zen-core's actor
    asks at DOMWindowCreated outside task pages, so frames and popups made
    after the task get the guards from their first document.
- **Per-tab network.** `observe/network.sys.mjs` follows every channel of
  an agent tab, its frames' too, keyed by browserId.
  - `inflight(browserId)` lists the counted requests in flight.
  - `waitForNetworkIdle(browserId, {idleMs, timeoutMs})` waits for
    `networkidle`.
  - `networkQuietMs(browserId)` (zen-input's missing-target fail-fast)
    is 0 while a counted request is in flight. Otherwise it is the ms
    since the last counted start or end, and Infinity before the tab has
    a record.
- `observe/audio.sys.mjs`: the mute. `syncAudio(browser)` mutes an agent
  tab the user can't see (`ui/visibility.sys.mjs`) through its
  MediaController, and unmutes it when they can. `syncAll()` runs on
  TabSelect, TabSwitchDone, split view, window visibility and agent list
  changes. A manual mute or unmute (TabAttrModified `muted`) makes the tab
  the user's. The content guards send `observe.sound` when playback
  starts, and `noteSound` reports `audio`. For zen-ux's indicator, the tab
  has the attribute `zenius-muted` while zenius keeps it muted, and
  `zenius-muted-sound` once a page has played sound in that time. It also
  publishes the browserIds it keeps muted in `sharedData`
  (`MEDIA_HIDDEN_KEY`) for the media guard.
  - Its record goes by browserId, so the mute follows the page into
    another window's copy of its tab. The marks go on the copy that holds
    the page, and they all come off when the mute ends.
  - A process switch can replace the page's top BrowsingContext, for
    example from about:blank to a site. The new one has an unmuted
    MediaController of its own, so `browsing-context-attached` mutes it
    at once.
- `observe/agentcode.sys.mjs`: the record of the agent's own code, for
  zen-ux's "Use your own tab", by site, per task, for the task's life
  (`docs/research/own-tab.md`, item 1). Code the agent ran on a site can
  outlive its document: in a same-site popup or frame it wrote to, a
  `blob:` page it navigated to, the site's storage, or a page that later
  navigates to the site.
  - Closed groups, item 1: before that, `page.evaluate`
    (`runEvaluation`) and each poll of `page.waitForFunction` ask zen-core's
    `pages.codeRefusal(space, page)`, and `navigate()` asks before a
    `data:` or `blob:` load or one of another site (`sameSite`: the target's
    `siteOriginNoSuffix` against the document principal's, an opaque one's
    precursor's, or `currentURI`'s, so a reload or an error page's own URL
    passes). A refusal throws `msg.agentCodeRefused` (`ZEN_AGENT_CODE_REFUSED`)
    and marks nothing. zen-input's paste with html asks the same. They ask
    only while the document runs in a web content process
    (`webcontent.sys.mjs` `inWebProcess`): an add-on's pages share its
    group with its background page, which the check would count, and its
    answer sticks; a top-level load from an add-on's, the browser's, a
    privileged about: or a file page to the web lands in a new group
    (measured 2026-11-20), and I5 refuses the agent's methods there.
  - `page.evaluate` and `page.waitForFunction` call `noteAgentCode(rec,
    bc)` right before their content call, and `page.goto` and `page.reload`
    right after a `data:` or `blob:` load commits. It records the document's site
    (`siteOriginNoSuffix`: scheme and eTLD+1, no port) under the task.
    `blob:` and about:blank documents go by their principal's site.
  - An opaque document (a null principal: a sandboxed or `data:` frame,
    what a sandboxed frame writes into its popup) goes by its precursor's
    site, the site that made it. One with no site behind it at all counts
    as the agent's, record or not. In practice that is the agent's own
    top-level `data:` page, since content can't navigate a top level to
    `data:`, and a site's `data:` and sandboxed frames have the site as
    precursor (own-tab.md, second round).
  - `agentCodeOnSite(rec, site)` takes a principal or a site. It answers
    whether the agent's code ran on that site in the task, in any document.
  - `agentCodeInPage(rec, browser)` answers whether the page shows such a
    site: its top document or any frame. zen-ux asks at a handOff or a
    takeover, and again at each of the page's navigations while the user
    holds the task. Pass the `<browser>` that holds the page
    (`pages.tabFor`), whether or not the tab is still one of the task's
    pages.
  - `agentMadePage(rec, browser)` answers whether the page's top document
    may be the agent's own rather than a page a website served. That is
    when its address is about:blank, about:srcdoc, `data:` or `blob:`,
    and either it has no site behind it or its site is one where the
    agent's code ran in the task. zen-ux's pill then says the agent made
    the page, with no own tab.
    - A page served over http(s) never counts.
    - Neither does a popup another document filled with `document.write`:
      Gecko gives it the writer's URL, as the HTML spec says.
    - `agentCodeInPage` covers both.
    - Nor does the document a tab of the user's showed when the agent
      adopted it, such as their blank New Tab, even after the agent's code
      ran there. zen-core's `pages.adopt` calls `noteAdopted(browser,
      openedBy)` for it (a tab the agent opened is skipped). A document
      the tab loads later follows the rule above.
  - The spaceFinished sweep drops a finished task's record.
- `content/media.sys.mjs`: the media guard, installed with the refusal
  guards in every document of an agent tab, frames included. While its tab
  is in `MEDIA_HIDDEN_KEY`, it pauses each playing video that holds the
  display's wake lock by Gecko's rule (a video track, and an audio track or
  a MediaStream source), through its Xray, after the page's `play()`
  promise has resolved. It resumes what it paused when the tab leaves the
  list. It hears media through system-group listeners on the window, on
  each shadow root the page attaches (`attachShadow`), and on each element
  outside the document's tree that the page plays (`new Audio()`). The
  page's `pause()` takes an element off zenius's list, and so does a new
  source (`emptied`). It sends `observe.media` `{action, count, url}`, which
  `observe/setup.sys.mjs` turns into `Zenius.mediaPaused` or
  `Zenius.mediaResumed`.

```js
import { reportRefused, watchRefusals } from "chrome://userscripts/content/zenius/observe/refusals.sys.mjs";

reportRefused(browser, "fullscreen", "The page asked for fullscreen …");  // a surface you refuse
const r = watchRefusals(browser);        // before an action
// … the action …  (r.seen: what was refused so far)
const refused = r.stop();                // [{kind, message}]; put it in the receipt when not empty
```

### Parent backstops

`modules/backstops.sys.mjs` (built by zen-core, finished by zen-observe;
zen-snapshot's facts in docs/research/parent-backstops.md, the manager's
list of 2026-11-20). The parent refuses a task's pages again where their
code can't reach: the second line behind the page refusals and the
world's mirror of them.

- **In only while a task has pages (I4).** zen-core's service calls
  `setBackstops(service, on)` from publishAgentBrowsers: in with a live
  task's first page, out after its last, when Gecko's own functions are
  back (tests/core/backstops.test.mjs checks both).
- **Devices.** `WebRTCParent.prototype.receiveMessage` is wrapped:
  `webrtc:Request` from a task's page or its frame goes to `denyRequest`
  before `prompt()` while the agent drives the tab (`AGENT_BROWSERS_KEY`)
  or the tab shows evidence (`deviceRule`; during the hold the request
  goes on). That is before the doorhanger, which grants a stored
  permission as it shows, and before macOS's own check
  (`checkOSPermission`). When webrtcUI has no peer blocker API, the
  wrapper also denies `rtcpeer:Request`.
- **The startup check fails closed.** The patch goes in only if Gecko's
  source still has `receiveMessage` handling `"webrtc:Request"` and
  `denyRequest` sending `"webrtc:Deny"`. If not (a new Zen), the process
  actor `ZeniusDeviceBackstop` (`content/devicebackstop.sys.mjs`, on
  `getUserMedia:request`) refuses, in its content process, a request from
  a tab the agent drives or a task's tab with evidence. It needs `safeForUntrustedWebProcess: true`, or web processes
  don't load it. WebRTCChild still sends the parent a copy then: a
  doorhanger may show, and its Allow reaches nothing; zen-ux cancels
  webRTC doorhangers in a task's page as its own second line.
  `backstopState()` says which is in (`devices`: `"parent"`, `"content"`
  or `"off"`, with `devicesProblem`).
- **Peer connections.** `webrtcUI.addPeerConnectionBlocker`, mapping the
  request's innerWindowID to its tab, by the devices' rule. Gecko lets an
  offer through when a blocker throws, so the blocker catches everything
  and denies.
- **Prompts.** An `Integration.contentPermission` override cancels a
  task page's prompt of any type before PermissionUI shows it when the
  tab shows evidence (`promptRule`), the user's hold included. So zen-ux's
  hand-off, which starts when a doorhanger shows, never opens for it. A
  stored geolocation grant is covered: PermissionUI reads it inside the
  prompt the override replaces. Every other prompt of a task's page goes
  on to PermissionUI (`backstopState().kept` counts them): zen-ux's
  hand-off while the agent drives, the user's answer during the hold (A8,
  agreed with zen-ux, 2026-11-21).
- **Streams stop when the agent has the tab again.**
  `observe/capture.sys.mjs`'s `stopCapture(browser)` runs from setup's
  `watchAgentTabs` for each tab newly in `AGENT_BROWSERS_KEY` (Resume, a
  claim, an adoption).
  - It calls `webrtcUI.forgetActivePermissionsFromBrowser` first, as
    Firefox's own stop does, so WebRTCParent allows no grace period.
  - It then sends `webrtc:StopSharing` to each capturing document of the
    tab (`webrtcUI._streams`), with a `screen:` id too for a shared
    screen.
  - It makes one `deviceAccess` report, `api: "stopSharing"`.
  - Stored grants stay: the device gate refuses before they could apply.
  - Fake devices count as capturing only with
    `media.navigator.permission.fake` (tests/core/backstops.test.mjs).
- **An error refuses.** A check that throws counts in
  `backstopState().errors` and refuses, the user's own tab's request
  included, while a task is live.
- **What has no parent hook** (zen-snapshot's backstops-probe in zenius
  mode). The page refusals, the world's mirror of them and zen-ux's quiet
  notification remain the only gate for:
  - service worker registration (`serviceWorker`);
  - a notification the site has the user's grant for: content reads the
    stored grant itself, so `requestPermission()` answers `"granted"`
    with no prompt, and showing one asks the parent nothing;
  - MIDI the site has the user's grant for, which content answers;
  - a local-network reach with a stored grant, which Gecko answers (the
    type is kept anyway).
- Each refusal tells the agent once per document and API, through
  observe/refusals.sys.mjs's `reportRefused`: `deviceAccess` (with `api:
  "stopSharing"` for a stopped stream), `localNetwork` with `api:
  "RTCPeerConnection"`, `promptDenied`.

### Remote tasks

The `sidebar.*` methods are described in PROTOCOL's "Remote tasks: the
sidebar", and the brief is `docs/briefs/remote-tasks.md`. They're
cross-owner: zen-observe's code in zen-ux's sidebar, which zen-ux reviews.
- `agent-sidebar/remote.sys.mjs` keeps `conv.remote`: `{address, label,
  requestId, startedAt, endsAt, endedAt, final}`. It reads a task's state
  from the sidebar's own (`taskInfo`). AgentService imports it at the
  sidebar's start, so it imports nothing of zenius's (I4).
- AgentService calls its hooks from these places:
  - the instructions: the remote rules go after `WORK_INSTRUCTIONS`;
  - the tasks file: `conv.remote` is saved with the task, and a task that
    was running when Zen quit ends as `zen_quit`;
  - `cancel`: the user's Stop, from the panel or the arrival card, whether
    a turn runs or not;
  - a turn that ends in an error;
  - `removeTask`: a tombstone that holds no text and lasts until Zen quits;
  - `pruneTasks`: a remote task stays until 24 h after it ended;
  - `refreshTask`: it moves `updatedAt`.
- `final` freezes the status when the task ends. No later turn goes back
  to the caller, not even one the user starts in the chat.
- `methods/sidebar.sys.mjs`:
  - checks the params and holds the limits;
  - arms each task's time limit with a timer, and checks it again at each
    call in case Zen slept past it;
  - watches the off pref only while a remote task is active.
- The methods module sets `conv.source = "remote"` and `conv.remote` before
  the first `send`. That send's `addTask` shows zen-ux's arrival card. Each
  of the caller's messages is marked `source: "remote"`.
- No log line carries a request's text.

### The evidence flag

The defenses act only on evidence of phishing or danger: the user's pass on
`docs/briefs/defenses-evidence.md`, with the design in
`docs/research/hooked.md`. It replaces written as their trigger. Written
stays until no defense reads it.
- Each document (innerWindowId) may have reasons, each with a detail of one
  line, at most 200 characters:
  - `hooked`: the agent's code left something that outlives the discard of
    its world, set by the world and by zen-input's paste;
  - `made`: a data: or blob: top document the agent opened, set by
    `noteMade`;
  - `listed`: Gecko's phishing or malware lists name it (zen-core);
  - `flagged`: the agent flagged it (zen-core's tool).
- The flags are only ever added, and they're per document, so a reload or
  a new load starts clean. `EVIDENCE_DOCS_KEY` (`content/worldkeys.sys.mjs`)
  is the sharedData copy: a Map of innerWindowId → `{reason: detail}`.
- Parent, `observe/evidence.sys.mjs`:
  - `markEvident(target, reason, detail)` marks the document now in a
    BrowsingContext, a WindowGlobalParent, or a `<browser>`'s top document.
  - `isEvident(target)` and `evidenceOf(target)` read the page: its top
    document and frames.
  - `onEvident(fn)` hears each new reason once per document.
- Content, `content/evidence.sys.mjs`, synchronous:
  - `isEvident`, `evidenceOf`, and `evidenceFlag` (pageFlag's contract:
    `"drop"` for a made top document, `"clean"` for a hooked one). Listed
    and flagged pages get zen-ux's warning, not a clean copy: a reload
    brings the danger back (the manager's call);
  - `markHooked(target, detail)` marks the window's document and the other
    documents of its group in that process, at once and through the
    `zenius:evident` message;
  - `hookedMarkup(node)`: the check of inserted markup that the world and
    zen-input's paste share.
- The parent takes `zenius:evident` only for the sending process's own
  documents, and only as hooked.
- How the agent world finds hooked (`content/agentworld.sys.mjs`):
  - Its routes into the page's own JavaScript run instead of being refused,
    and mark the page. They are a script element, the page's `eval` and
    `Function` (the compile hook), a string timer, another window's timer or
    location setter (the native hook can't see their URL), and a
    `javascript:` URL through `window.location` or `window.open`.
  - From the world's first write in a run, a MutationObserver watches its
    group's documents, and their shadow roots once its code has read into
    one. The run ends when its oldest frame of the world's pops (a return,
    a throw, an await), and the watch stops then.
  - Records are taken at each built-in the world calls. Only those a write
    made count, checked by `hookedRecord`. An action's records are the
    page's own doing: a click whose handler adds a form isn't the agent's.
  - Style rules, `attachShadow` (also through `content/media.sys.mjs`'s
    shim) and `document.write`/`open` leave no record. They mark the page
    by their built-in.
  - A mark takes only the document the agent's code wrote into (rule 3 of
    `docs/safety-rubric.md`). A same-site window of its group that page
    code left there could reach isn't hooked; that route is a line in
    `docs/potential-issues.md`.
  - Limits: a shadow root that appears during a run isn't watched until the
    next run. When page code dispatches an event synchronously to a
    listener the world left, a change the page makes after that listener
    can count as the world's.

## Input (zen-input)

### Upload staging

A file chooser's answer reaches the page as files on disk, since Firefox's
picker hands over nsIFiles. So `filechooser.setFiles` writes the client's
bytes to files of the runtime's own (`input/filechooser.sys.mjs`,
`writeUploadFiles`). `page.setInputFiles` makes DOM files in memory and
writes nothing.

- **Where.** `<profile>/zenius-uploads/upload-<n>/<i>/<name>`.
  - Each answer gets a fresh `upload-<n>` (`IOUtils.createUniqueDirectory`).
  - Each file gets a folder of its own, since two files may share a name.
  - The root and every folder are 0700, the files 0600.
- **Out of the agent's reach.** The whole path is under the profile, which
  no sandboxed CLI writes.
  - Until 2026-11-21 these files went in the system temp folder, which a
    sandboxed CLI can write (Codex's `workspace-write` can). zen-snapshot's
    `tests/snapshot/tools/staging-probe.mjs` showed that an agent there
    could plant or swap links and have its bytes written outside.
  - Checks at creation alone can't stop a folder being swapped after it's
    made. The location is the fix, and the checks below are a backstop.
- **Backstops.**
  - The root must be a folder, not a link.
  - Every folder below it is made with `ignoreExisting: false`, and every
    file with `mode: "create"`, so nothing already there is used.
  - Before each folder and each file, and again after the last write, no
    entry from the root down may be a link, and each file must resolve
    inside the root.
  - A failed check removes the answer's folder and fails the call with
    `ZEN_INTERNAL`. The chooser stays open.
  - Removal touches only folders directly in the root, and only while the
    root is a folder of zenius's own, not a link. That covers a closed tab,
    quit, a failed check and the start-up sweep. (zen-observe's review of
    7a9df6a.)
  - **Known limits.** Each needs write access to the profile, which is
    outside the threat model.
    - `setPermissions` and `setModificationTime` run by path after the
      exclusive write. A link swapped in at the file's place in between
      would have them follow it; the check after the last write then fails
      the answer.
    - The page reads the files lazily, after every check, so only the
      location keeps a link swapped in later from being read.
- **Cleanup.**
  - An answer's folder goes when its tab closes or Zen quits, and at most
    20 are kept.
  - A start removes the root's leftovers.
  - Removal unlinks a link and never follows it.
  - The `zenius-upload-<hash>` folders that earlier versions left in the
    temp folder stay there, for the system's temp cleanup.
    - Removing one, in place or after a rename into the profile, recurses
      through folders that an agent may still change. That covers an
      agent that writes the temp folder, and one already inside such a
      folder under a sandbox that grants the temp folder by mount.
    - `nsLocalFile::Remove` checks a folder, then opens it by path. So a
      folder swapped for a link in between has the link's target emptied.
    - Removing only their plain files has the same flaw: each file is
      reached through a folder that can be swapped.
    - zen-snapshot found this contact in the rename version (7a9df6a).
- **Tests.** `tests/input/uploads.test.mjs` plays each race through
  `uploadTestHooks` (`making`, `made`), at the moments a racing agent would
  act.

### Folder uploads

A payload's `relativePath` makes a folder upload (input-gaps 24,
`docs/research/folder-uploads.md`).

- **Checks.** `folderPlan` refuses a bad path before anything is decoded or
  written (PROTOCOL lists the refusals), so every path stays inside the
  folder it names.
- **Writing.** `writeUploadFolder` writes
  `<profile>/zenius-uploads/upload-<n>/<relativePath>`, by the staging rules
  above.
  - Folders are made parent first, each exclusively. Each file is written
    with `mode: "create"`.
  - The link checks run before each folder and file, and after the last
    write.
  - The tree must then hold exactly the files sent.
  - A name that lands on one already written fails the call with
    `ZEN_INVALID_ARGUMENT` (APFS folds letter case and Unicode forms).
- **Delivery.** A content process may read a folder only once Gecko's
  picker parent has granted it that folder (`FileSystemSecurity`).
  `HTMLInputElement.mozSetDirectory` without that grant has the parent kill
  the content process. So both routes go through the input's folder chooser:
  - `filechooser.setFiles` answers the page's own chooser with the folder
    (`setChooserFolder` sets the picker's `file`, which `FilePickerParent`
    reads in folder mode).
  - `page.setInputFiles` has the content side open the input's chooser
    itself (`setInputFolder`): `notifyUserGestureActivation()`, then
    `showPicker()`, then `consumeTransientUserGestureActivation()` at once.
    - `openOwnChooser` keeps an action's chooser guard from counting it.
    - The parent answers it through `claimFolderChooser`, before any waiter
      sees it.

  Gecko then walks the folder and fires `input` and `change`, after the
  answer. `awaitFileInput` waits for that `input` event at the window and
  at the input that opened the chooser.
  - An input the page never attached sends it only to itself.
  - Gecko names that input as its chooser opens: it notifies
    `file-input-picker-opening` right after the picker's `init`, for
    WebDriver BiDi. zenius's content picker hands the input over with the
    answer.
  - So the call returns once the input holds the whole folder
    (zen-observe's review). The 10 s cap is only a backstop.
- **Firefox's folder question.** Gecko asks before any folder pick reaches
  a page (`nsIPromptCollection.confirmFolderUpload`, Bug 1338637). In an
  agent tab, zen-observe's handler answers Cancel. With the manager's go
  (2026-11-21), `content/filepicker.sys.mjs` puts a prompt collection in
  front of Firefox's in each content process that holds a task page:
  - The parent arms a token on its own actor message, for one frame and the
    folder it staged (`expectOwnFolder`, from `awaitFileInput` and
    `setInputFolder`).
  - zenius's content picker takes the token as it hands that frame its
    answer. During that delivery, one ask for that folder's name in that
    frame gets yes, once.
  - The token lapses when the delivery ends, or after 5 s.
  - Every other ask, the user's tabs in the same process included, goes to
    Firefox's service. An error there is never a yes.
  - The picker reports whether zenius answered yes. If it didn't (the token
    lapsed), nothing was attached: the call fails with `ZEN_INTERNAL`, and
    the staged folder goes.
- **Activation.** Gecko grants the page transient activation for every
  pick (`nsFilePickerShownCallback::Done`), before its folder question.
  Every folder delivered to an agent tab is the runtime's, not a person's.
  So that activation is spent before the input's events, whatever the
  answer, just as `setInputFiles` with files grants none.
- **Known limit.** A claim is per tab, since Gecko's picker doesn't say
  which input opened it. A page that opens another folder chooser in the
  same tab during the call, with an activation of its own, can get the
  folder on that input instead. The files still reach only that page.
- **Tests.** `tests/input/folders.test.mjs` covers:
  - both routes, and each refusal;
  - a chooser opened by an input the page never attached, timed;
  - a planted link, and cleanup;
  - the folder question in every case the manager named;
  - the Mac's name collisions.

### The typing guard and the paste, on evidence

The user's call of 2026-11-21 (`docs/briefs/defenses-evidence.md`, A1 and
A5): the guard acts only on evidence against a page, zen-observe's evidence
flag, and of its reasons only on hooked (the manager's call, the same day).
Written doesn't count.

- **The guard.** `content/typing.sys.mjs` holds the user's first press or
  key in a page that has hooked evidence, in its top document or a frame
  (content's `evidenceOf`). Their input stays held there until the top
  document is replaced, and zen-core is asked for a clean copy. The guard
  never holds:
  - a page the agent's code only filled, clicked or wrote text into;
  - a listed or flagged page: the danger there is the page itself, which a
    clean copy can't remove, so zen-ux warns instead;
  - a page the agent made (`evidenceFlag` "drop"), hooked or not;
  - the replay's own keys, whatever the flag says.
- **Arming.** `input/capture.sys.mjs` arms a content process while any of
  these lives there:
  - a task page;
  - a held tab;
  - a hooked document in `EVIDENCE_DOCS_KEY`. Such a page keeps its process
    armed after its task, too.
- **The paste (A5).** Content's paste op runs zen-observe's `hookedMarkup`
  over the agent's html (`hookedPaste` in `content/input.sys.mjs`). It reads
  the markup as the agent sent it, not as the sanitizer lets it through,
  parsed whole by the page's DOMParser through its Xray. When it finds
  something, the document is marked hooked (`markHooked`, detail "a paste
  with …") before the paste goes in. This holds for page.keyboard's paste
  and for the Space clipboard's.
- **Until written retires**, every html paste still does what it did:
  - it counts as the agent's code and as written (`markPastedHtml`, and
    `noteWrittenWindow` in content);
  - it's refused in a closed group.
- **Tests.**
  - `tests/input/typing.test.mjs` covers:
    - hooked against listed and flagged;
    - a page the agent's code wrote into without hooking it;
    - a plain paste beside one with a form.
  - `tests/input/zenius.test.mjs` runs the paste's markup cases.

### Each task's steps

Every zenius task shows in the sidebar, whoever drives it (the user's ask,
2026-11-21; `docs/briefs/external-tasks.md`). Its view lists the agent's
steps from `input/steps.sys.mjs`.

- **Recording.** zen-core's dispatcher calls `beginCall` as a client's call
  begins and `endCall` as it ends. A handler's own calls (`ctx.call`)
  aren't steps, and neither are queries (`page.url`, `pages.list`) or the
  runtime's own methods.
  - A step shows while its call runs, with outcome "running".
  - When the call ends, the step gets its outcome ("ok" or the error's
    code), its run time without held time, and the name the action found.
- **Reading.** zen-ux reads the steps beside zen-core's task feed. The feed
  carries a task's life only.
  - `stepsOf(spaceId)` gives the task's last 50 steps,
    `{id, at, ms, method, text, outcome, page}`, in the order their calls
    began.
  - `onStep(fn)` calls `fn({space, step})` when a step begins and again
    when it ends, with the same `id`.
  - A task's steps stay after it ends. The 32 most recently active tasks
    keep theirs.
- **What a step may show.** Steps last, so these rules hold (zen-snapshot's
  points):
  - nothing typed, pasted, chosen or run, and no value or file name;
  - a key only when it types no text;
  - a navigation as its origin only (`originNoSuffix`), never its path,
    query or userinfo;
  - an element's name from the page, put on one line, stripped of invisible
    and control characters, capped at 60 characters, and quoted. Quote
    marks inside it become apostrophes.
- **Names.** Content's `stepName` (`content/actions.sys.mjs`) reads the name
  before the action, without layout. It tries, in order: aria-label,
  aria-labelledby, a field's label, a button's value, placeholder, alt,
  title, then the element's text. It never reads a field's value or an
  editable area's text.
- **`ctx.step`.** A handler sets it when it learns something for its step:
  - page actions set `{target}`, the name `stepName` found;
  - `filechooser.setFiles` sets `{space, page}`, since its call names a
    chooser, not a page.
- **Tests.** `tests/input/steps.test.mjs`.

## Testing

- `scripts/zen-dev.sh <name> start|stop|restart|log|reset` runs your own
  headless dev Zen with this checkout's `runtime/` copied in at each start.
  `quit` exits through the app, so Zen saves its session (`stop` kills it).
  Test runners prepare their profile with `fresh`: removed on Linux, kept
  on the Mac unless `ZENIUS_FRESH=1`, because a first start there relaunches
  Zen and takes about 13 s. On a kept profile, use unique space names and
  finish your spaces.
- `node scripts/zen-rpc.mjs --instance <name> <method> '<json>'` calls any
  method. `--bench N` repeats it and prints round-trip percentiles.
- Experiments without writing a method:
  - `dev.evalChrome {code}`: chrome JS in the parent. The browser window's
    globals (`gBrowser`, `gZenWorkspaces`, `Services`) plus `ctx`, `service`
    and `win` are in scope.
  - `dev.evalContent {space, page, code, privileged?}`: JS in the page. By
    default it runs in the page's own world; `privileged: true` runs chrome
    JS in the content process with `actor` bound.
  - `code` is an expression, or a function body if it doesn't parse as one
    (so `return` works). Promises are awaited.
- `dev.viewState` returns every window's selected tab, active workspace and
  focused element; compare before and after your operations to check I1.
- `node scripts/smoke.mjs --instance <name>` runs the smoke checks against a
  running instance; `scripts/test-smoke.sh` starts one first.
  `scripts/test-all.sh` (smoke, every `tests/<area>/run.sh`, the SDK suites)
  is the merge check.
- `tests/core/` holds zen-core's runtime tests (ownership, I3, pages,
  frames). Its `lib.mjs` has helpers you can copy: a user Space that was
  never claimed, the takeover prompt opening (`setPaused`), the user taking
  over, a clean restart, and an I1 check that the user's view is unchanged
  after the whole file.
- `scripts/lib/rpc.mjs` is a dependency-free NDJSON client for your own Node
  tests: `const c = await connect("zen-input", {callTimeout: 30000});
  await c.call("…", {…})`. It sends `progress: true`, so a held call's timer
  pauses (`c.onProgress(f => …)` sees the frames), and it decodes
  `unserializable` results.

## Install layout (zen-core)

`scripts/install.sh` installs the runtime into one Zen profile, and
`--uninstall` removes it; zen-sdk's `zenius doctor` checks the same layout.
Neither quits or restarts Zen: afterwards the user quits and reopens it.
`--dry-run` prints the changes without making them.

Provided by the user's Zen (fx-autoconfig 0.10.16). zenius never edits the
app bundle, and writes the loader only with `--loader`:
- `<app>/config.js` and `<app>/defaults/pref/config-prefs.js`. `<app>` is
  `/Applications/Zen.app/Contents/Resources` on the Mac, and the directory
  of the `zen` binary on Linux (`~/opt/zen-1.24.2b` on the Linux server). A Zen update
  deletes `config.js`; putting it back needs the user's OK. `install.sh`
  warns when it's missing.
- `<profile>/chrome/utils/boot.sys.mjs` and
  `<profile>/chrome/utils/chrome.manifest`: fx-autoconfig's loader.
  `install.sh` refuses a profile without it, unless `--loader`: then it adds
  the copy in `runtime/vendor/fx-autoconfig/profile`, each file and folder
  the profile lacks and none it has, for a fresh Zen's profile (zen-sdk's
  release bootstrap). `~/.zenius/loader.added` notes what it added, one
  `<profile>\t<path>` line each, and `--uninstall` takes out exactly that,
  after a backup, unless `chrome/JS/` still holds other scripts, which run
  on the loader; a later uninstall takes it out once they're gone.

Written by `install.sh`. It writes copies, never links:
- `<profile>/chrome/JS/zenius.uc.js` and the tree `<profile>/chrome/JS/zenius/`,
  swapped in whole, so files of an earlier version don't linger. Other files
  in `chrome/JS/` (the user's other scripts) are left alone.
- The agent's scripts beside the runtime, those the checkout has
  (`COMPONENTS` in `install.sh`: `agent-sidebar`, `agent-urlbar`, zen-ux's,
  SPEC §8): `<profile>/chrome/JS/<name>.uc.js` and, if the checkout has
  one, the tree `<profile>/chrome/JS/<name>/`, swapped in whole. The profile
  may already hold a script of that name. The install that first replaces
  it backs it up, and `--uninstall` puts it back. A script the profile
  didn't have, `--uninstall` removes. If the backup with the earlier copy is
  gone, `--uninstall` leaves zenius's copy, so the user keeps a working
  script. It never touches the user's other scripts
  (`my-script.uc.js`) or the sidebar's own data
  (`~/Library/Application Support/zenius-agent-sidebar/`).
- `<profile>/chrome/JS/zenius/install.json`: `{runtimeVersion, protocol,
  commit, installedAt, profile}`. `runtimeVersion` and `protocol` are
  `RUNTIME_VERSION` and `PROTOCOL_VERSION` from `modules/util.sys.mjs`.
  `commit` is the checkout's short hash (`-dirty` if `runtime/JS` has
  changes), or `unknown` outside git. `installedAt` is UTC, to the second.
- `~/.zenius/install.json` (mode 0600): `{profile, files, backup,
  runtimeVersion, protocol, commit, installedAt}`. `files` lists every file
  written, as absolute paths. `backup` is the folder holding what this
  install replaced, or null. It's removed again by `--uninstall`.
- `<profile>/user.js`, only with `--disable-ipv6`: two lines at its end, a
  comment and `user_pref("network.dns.disableIPv6", true);`, the one pref
  zenius sets: no IPv6 lookups in Zen. It's the user's choice for their own
  install (2026-11-20), which ends the GitHub stall on their IPv4-only network,
  at the cost of IPv6-only sites; opt-in since 2026-11-21, so nobody else's
  Zen loses IPv6 (the manager's call). An install without the flag leaves
  `user.js` as it is, zenius's line from an earlier install included.
  Zen reads `user.js` at each start and then keeps the value in `prefs.js`
  too, so removing the line alone wouldn't undo it (checked in 1.24.2b).
  The first install records the pref's `prefs.js` line, or that it had
  none, and whether `user.js` existed, in `~/.zenius/dns-pref.prior`.
  `--uninstall` takes zenius's two lines out of `user.js` (removing a
  `user.js` it made), and, once Zen has quit, puts that `prefs.js` line
  back and deletes the record. Run while Zen is open, it leaves the record
  for the next `--uninstall`, and no other profile gets zenius with
  `--disable-ipv6` until then.
  `browser.health`'s `dnsDisableIPv6` is the value Zen has.
- `~/.zenius/components.prior` (mode 0600): one line for each profile and
  agent's script an install put there, split by tabs: `<profile>`,
  `<name>`, the backup folder holding the copy it replaced (empty if there
  was none), and a fingerprint of zenius's copy as installed (`cksum` over
  the names, link targets and contents of `<name>.uc.js` and `<name>/`).
  Each script's first install writes its line before the swap, later
  installs keep it, and `--uninstall` drops it once the earlier copy is
  back. A copy that no longer matches the fingerprint was put there by the
  user or another installer, after zenius's. A reinstall backs it up as the
  copy to put back and points the line at that backup, and `--uninstall`
  leaves it in place.
  It lives outside the profile on purpose. Going back to a version from
  before these scripts runs that version's `install.sh`, which rewrites
  `chrome/JS/zenius/` and leaves the scripts, since it doesn't know them.
  The line survives that, so the next install or `--uninstall` by a newer
  `install.sh` still finds the earlier copy. An install from a checkout
  that lacks a noted script puts the earlier copy back, as `--uninstall`
  does. To go fully back to such a version, its scripts included,
  uninstall with the newer checkout first, then install the older commit.
- `~/.zenius/backups/<UTC time>/`: before an install replaces zenius's files
  or an uninstall removes them, they're copied here, under their paths in
  the profile (`chrome/JS/zenius.uc.js`, `chrome/JS/zenius/…`,
  `chrome/JS/agent-sidebar.uc.js`, …), as are the user's own copies of the
  agent's scripts, `user.js` and `prefs.js` before any of them changes.
  Backups are never deleted. An uninstall leaves no zenius behind; it
  doesn't bring back an earlier version. To go back, read the replaced
  version's commit from the backup and install that commit
  (`docs/install-daily.md`, "Going back to the previous version"); don't
  copy a backup into the profile by hand.

Removed by `--uninstall`, though `install.sh` never writes it:
`<profile>/agent-sidebar-workspace/`. zenius's sidebar keeps its agent
sessions' working folders and limit files there, and rewrites the limits
before each session (zen-ux's; the manager's ruling, 2026-11-21).
`--uninstall` backs it up, with whatever the agents left in it, then
removes it. That includes a workspace an older version's uninstall left
behind. The sidebar's chats, `<profile>/agent-sidebar-tasks.json`, are the
user's: `--uninstall` leaves them, without a copy, and its "left in place"
line names them when they're there.

Rules `install.sh` keeps:
- **Which profile.** `--profile`, else the one Zen opens: the `[Install…]`
  section's `Default=` in `profiles.ini`, then the `[Profile…]` with
  `Default=1`. If `[Install…]` sections (one per Zen installation) name
  different profiles, it asks for `--profile`.
- **One profile at a time.** Both would serve instance `default`, so it
  refuses a second profile while the record's profile still has zenius.
- **Not under a running zenius.** While a Zen has the profile open (Linux:
  the live pid in `<profile>/lock`; Mac: `lsof` on `.parentlock`) and
  zenius is installed there, it changes nothing, because modules that load
  later would come from the new files and the actor's content side from
  either. It also changes nothing while that Zen runs a copy of an agent's
  script that the run would replace or remove: the Zen has loaded it, and
  loads files from its folder as it goes. `--while-running` overrides
  both; then the user should reopen Zen soon. A first install into a
  running Zen that has none of these scripts is fine: nothing loads until
  the next start.
- **No cache purge.** Zen doesn't serve the previous runtime from its
  startup cache after an update, although the cache holds zenius's
  modules: checked on Gecko 160, where a new tree loaded at the next normal
  start. `tests/core/install.test.mjs` checks it every run, so `install.sh`
  leaves `compatibility.ini` and the caches alone.

Never in a daily profile: pref `zenius.dev` (the `dev.*` methods), or a link
into a checkout.

While Zen runs, as instance `default` (pref `zenius.instance`, unset on a
daily profile):
- `~/.zenius/run/default.sock` (mode 0600, in a 0700 directory).
- `~/.zenius/instances/default.json`: `{instance, pid, socket, profileDir,
  zenVersion, runtimeVersion, install, startedAt}`, removed at quit.
- `~/.zenius/state/default/spaces.json`.
- `~/.zenius/selfcheck/default.sock` (mode 0600, in a 0700 directory): the
  post-install self-check's own socket, which serves `selfcheck.run` alone
  (PROTOCOL, "Self-check"). The runtime opens it at idle after the agents'
  socket.
- `~/.zenius/selfcheck/default/<time>/`: one self-check run's
  `summary.json` and PNGs, made only when a run starts.
- zenius follows no link below `~/.zenius`: a folder of its own that is a
  link stops the runtime from making it (no socket then, or no saved
  Spaces), and its records go to a fresh temporary file made exclusively,
  then renamed over the record, so a link at either name is never written
  through. `~/.zenius` itself, and the folders above it, may be links
  (zen-snapshot's sweep, 2026-11-21; `tests/core/zhome.test.mjs`).
- `browser.version` and the registry's `install` are `{commit,
  installedAt}` from the `install.json` the runtime found when Zen started,
  or null on a profile `install.sh` didn't fill. The runtime reads it once,
  so if it differs from the profile's `install.json`, Zen still runs an
  earlier install: quit and reopen it. That works even when
  `runtimeVersion` didn't change.

On a Mac, the daily profile is a folder like
`~/Library/Application Support/zen/Profiles/<id>.Default (release)`;
`install.sh` finds it as the default profile in
`~/Library/Application Support/zen/profiles.ini`.

Tests: `ZENIUS_INSTALLED=1 scripts/zen-dev.sh <name> start` starts a dev
profile the way the daily Zen starts: with the runtime `install.sh` put
there, and without `-purgecaches`.

### CLI (zen-sdk)

`scripts/install-cli.sh` installs the `zenius` CLI that agents call, and
`zenius doctor`'s first check reports which copy runs. It never touches Zen.
It writes a copy, never a link into a checkout, so a pull or an edit in the
checkout doesn't change what agents run. Rerun it to update the copy.

- `~/.zenius/cli/` (`$ZENIUS_HOME/cli`, or `ZENIUS_CLI_DIR`), swapped in
  whole:
  - `sdk/bin/zenius`, `sdk/dist/zenius.mjs` and `sdk/dist/guide.md`, with
    no sources, so it always runs the bundle and needs only Node 22.3.
    `sdk/package.json` holds just `{"private": true, "type": "module"}`.
  - `skill/zenius/`: the entry Skill and its site learnings. Learnings
    added to the previous copy are carried over.
  - `runtime/vendor/fx-autoconfig/`: the files doctor's restore steps copy
    from.
  - `install.json`: `{version, commit, installedAt, from}`. `commit` and
    `installedAt` use `install.sh`'s notation, and `from` is the checkout
    it came from.
- `~/.local/bin/zenius` (`ZENIUS_BIN_DIR`): a link to the copy's
  `sdk/bin/zenius`.
- With `--skill`: `~/.claude/skills/zenius` and `~/.agents/skills/zenius`
  (`ZENIUS_SKILL_DIRS`), links to the copy's `skill/zenius`.

It builds the bundle first when `sdk/node_modules` is there. Otherwise it
installs only a bundle at least as new as the sources. It replaces only its
own copy, and links that point to a zenius CLI or Skill. `--uninstall`
removes the copy and those links.
