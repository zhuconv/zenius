# Zenius wire protocol (v1)

This is the contract between the Node SDK (`sdk/`) and the browser runtime
(`runtime/`). The SDK stays thin: it validates arguments, prints help and
output, and maps each public API call to one request below. Parameter names
and semantics follow Ego's public API. Where this file says "options", it
means the options documented for that method in
`refs/ego-lite/package/ego-browser/src/public-api-schema.ts`, passed through
unchanged.

Owners: `zen-core` keeps the frame format and the space and page methods;
each other worker adds and maintains the section for its own methods. When a
method's shape changes, update this file in the same commit.

## Frames

Each frame is one JSON object followed by `\n`, over the Unix socket
`~/.zenius/run/<instance>.sock`.

```jsonc
// server → client, first frame after connect
{"event": "hello", "params": {"protocol": 1, "instance": "default", "runtimeVersion": "0.1.1", "zenVersion": "1.24.2b"}}
// request
{"id": 7, "method": "page.click", "params": {"space": 3, "page": "p1", "target": "@21", "options": {"label": "submit form"}}}
// success
{"id": 7, "result": {"popups": [{"label": "p2"}]}}
// failure
{"id": 7, "error": {"code": "ZEN_SELECTOR_AMBIGUOUS", "message": "…", "data": {"matches": 3}}}
// event (only after events.subscribe)
{"event": "download", "params": {"space": 3, "page": "p1", "download": "d1", "url": "…"}}
// a result JSON can't carry
{"id": 8, "result": null, "unserializable": "NaN"}
// progress, only for a request that set "progress": true
{"id": 9, "held": true, "reason": "paused"}
{"id": 9, "held": false}
```

- Requests on one connection may run concurrently; responses carry the `id`.
  A call ends only with a frame that has `result` or `error`.
- Handlers start in frame order: a request's handler has started, and
  registered any waiter, before the next frame on the connection is
  handled. So `page.waitForEvent` sent before the action that triggers the
  event catches it.
- `unserializable`: a result JSON can't carry, as text: `NaN`, `Infinity`,
  `-Infinity`, `-0`, `123n` (a BigInt) or `undefined`. `result` is then
  `null`. Inside objects such values follow JSON (`null`, `0`, `"123n"`).
- Held calls. While the user decides on a takeover prompt, a call that
  would change the page is held: it hasn't started, and its timeouts start
  at release. A request with top-level `"progress": true` gets `{id, held:
  true, reason: "paused"}`, then `{id, held: false}` at release (or just its
  final frame); a client stops its own timer while held. Other requests are
  held silently. A held call whose connection closes is dropped without
  running. Ignore progress frames you don't know.
- Page budget. A request may carry top-level `"pageBudget": n`, a positive
  integer: the page budget for that request, as Ego's
  `EGO_BROWSER_PAGE_BUDGET` (the SDK sends it with every request of a
  process that set the variable). Without it, pref `zenius.pageBudget`,
  else 8. Any other value fails the request with `ZEN_INVALID_ARGUMENT`.
- A frame that isn't valid JSON, or has no `method`, gets an error response
  with `id: null` (or its own `id`) and `ZEN_INVALID_ARGUMENT`. An unknown
  method fails with `ZEN_UNSUPPORTED`.
- A result of `undefined` is sent as `null`.
- An absent option takes Ego's default for that method, applied in the
  runtime; the SDK passes options through and never fills defaults. Ego's
  defaults (from `refs/ego-lite/package/ego-browser/src`): `goto` and
  `reload` 15000 ms; `waitForURL`, `waitForFunction` and the other waits
  10000 ms; `setInputFiles` 10000 ms; other page actions 3000 ms; `evaluate`
  15000 ms (the runtime response timeout). Check Ego's source for any method
  not listed.
- A client that disconnects cancels nothing that already started in the
  browser. Long operations are bounded by their own `timeout`.

## Addressing

- `space`: the numeric id of a task, or of one of the user's workspaces
  (`ownership: "user"`).
- `page`: a label (`"p1"`), for managed pages.
- `tab`: an internal tab id from `tabs.list`, for unmanaged tabs (adopt,
  release, read-only info).
- `target`: a selector string, exactly as the agent wrote it: `@21`, `ref=21`,
  `text=…`, `loc=css:…`, `loc=role:…`, `loc=href:…`, `xpath=…`, raw CSS, or the
  Playwright subset. It is parsed in the runtime.

## Methods

### Browser and profiles (zen-core)

| Method | Params | Result |
|---|---|---|
| `browser.version` | none | `{zenVersion, runtimeVersion, updateAvailable: false, install}`; `install` is `{commit, installedAt}` from the `chrome/JS/zenius/install.json` this runtime was loaded with (read at startup), or null on a profile `scripts/install.sh` didn't fill (SPI "Install layout") |
| `browser.health` | none | `{ok, windows, spaces, pid, webdriver, strayAgentsSpaces, dnsDisableIPv6}`; `webdriver` is a browser window's `navigator.webdriver` (true while Marionette or the Remote Agent runs; I4 wants false); `strayAgentsSpaces` is `[{uuid, name, tabs, position}]`: Spaces zenius made as its Agents Space, other than the current one, that a start left since they hold tabs or a window shows them (SPI "The Agents Space's mark"), for `zenius doctor` to list; `position` is the Space's place in Zen's Space switcher, 1 first, since two of them can share a name; `dnsDisableIPv6` is Zen's `network.dns.disableIPv6` now, the one pref `install.sh` sets (true: no IPv6 lookups, the user's choice) |
| `browser.methods` | none | `{methods: [names]}`: every method this runtime registered |
| `profiles.list` | none | `{profiles: [{id, name, isDefault}]}`: `default`, plus `container-<n>` for each Zen container |

### Task spaces (zen-core)

| Method | Params | Result |
|---|---|---|
| `spaces.list` | none | `{taskSpaces: [{id, name, createdBy, ownership, profileId, profileName, recentTabTitles, pages?, source?}]}`; only spaces with ownership `agent` carry `pages` (below), and only those created or claimed with a source carry `source`. `recentTabTitles` is empty for a workspace of the user's that no agent claimed: its tabs' titles are the user's (I2). |
| `spaces.create` | `{name, profileId?, source?}` | `{id, name, ownership, profileId, pages}`, where `pages` is the live Pages as `[{label, tab, openedBy}]` (here `[{label: "p1", tab: "t…", openedBy: "agent"}]`), so the SDK has each `targetId` without a call; creates the task in the Agents Space (and the Space itself if needed) without switching any window and, as in Ego, starts it with managed page `p1` (`about:blank`). A name any task or user workspace already has fails with `ZEN_TASK_SPACE_NAME_IN_USE` (`data.spaceId`). `source` says who drives the task, for the sidebar's directory: `{terminal?, agent?, folder?, sidebar?}`, for example `{terminal: "t5x", agent: "Claude Code", folder: "zenius-eval"}`. Each of the first three is kept only when, trimmed, it's 1 to 80 characters of ASCII letters, digits, spaces and `- _ . / : @ #`. `sidebar`, the agent sidebar's conversation id, is kept only exactly as given: 1 to 64 ASCII letters, digits and `-`. Anything else is left out, and the task starts anyway. |
| `spaces.open` | `{space}` | `{id, name, ownership}`; fails unless the agent controls the space |
| `spaces.claim` | `{space, name?, client?, timeout?, source?}` | `{id, name, ownership: "agent", userPage, pages}` (`pages` as in `spaces.create`). A user Space or an ended task needs the user's Allow in the browser first: the call waits for it, up to `timeout` ms (Ego's 600000), and fails with `ZEN_TASK_SPACE_CLAIM_DENIED` on Deny or no answer. `client` is the name the client gives itself, which the prompt quotes after zenius's own words. A task handed to the user follows `spaces.takeOver`'s 10 s rule. Tabs that aren't pages stay unmanaged until adopted; `finish()` ended the old labels, a Stop by the user didn't. `name` renames the space. |
| `spaces.takeOver` | `{space}` | `{id, name, ownership: "agent", userPage, pages, openerCut?, reloaded?, blanked?}` (`pages` as in `spaces.create`; `openerCut`, `reloaded` and `blanked` below). For a task handed to the user; an ended task or a user Space fails with `ZEN_TASK_SPACE_INACTIVE` (claim it instead). Fails with `ZEN_TASK_SPACE_USER_IN_CONTROL` (`data.retryAfterMs`) until 10 s after the user's last real input in the task's tabs, and so does `spaces.claim` of such a task: an agent can't take a task back while the user types. |
| `spaces.handOff` | `{space, reason?, secret?}` | `{id, ownership: "agentDelegatedToUser", reloaded?}`; `reason` defaults to `manual_takeover`. Before the user gets the task, the page they see is made safe for their typing (below, "The hand-off"): `reloaded` lists the pages that loaded afresh. `secret: true` says the user's step will show a secret (an API key, a token, recovery codes): at the hand back, before the agent has control, the tab shows `about:blank` with its history gone (`blanked`, below). Fails with `ZEN_HANDOFF_REFUSED` when it can't be, and the task stays the agent's. |
| `spaces.waitForControl` | `{space, interval?, timeout?}` | `{ownership: "agent", openerCut?, reloaded?, blanked?}` once the agent controls the space without taking control; `timeout` defaults to Ego's 600000 ms (`ZEN_TIMEOUT`); an ended task fails at once with `ZEN_TASK_SPACE_INACTIVE` |
| `spaces.setState` | `{space, text}` | `{ok}`: the agent's progress text on the space (Ego's `setAgentTaskState`) |
| `spaces.finish` | `{space, keep: "all" \| [labels]}` | Ego's receipt `{spaceId, closedSpace, keptManagedLabels, closedManagedLabels, preservedUnmanagedCount}` plus `protectedTabCount` and `pendingCloseCount`. Closes the agent's pages not kept and ends the task. A tab a window shows closes once the user leaves it: it counts in `closedManagedLabels` and `pendingCloseCount`. `closedSpace` is true when none of the task's tabs stays, as with `keep: []` and no tab of user or unknown origin. Otherwise those tabs go to the user. A claimed workspace of the user's is never removed (SPEC 3.4): there `closedSpace` is false even then, and the workspace stays listed as the user's. |

`userPage` is `{label?, tab, openedBy}` or `null`: the tab the user sees in
the space, captured in the same step as the ownership change. Calls on a
space the agent doesn't control fail with `ZEN_TASK_SPACE_USER_IN_CONTROL`
(`data.reason`) while the user has it (a handOff, a takeover, a permission
prompt, or a user Space never claimed), and with `ZEN_TASK_SPACE_INACTIVE`
after its task ended. This holds for reads too, as in Ego. The inactive
error's `data.reason` says how the task ended, when zenius knows: `stopped`
(the user stopped it in Zen), `finished` (the agent's `spaces.finish`) or
`closed` (its tabs were closed). `spaces.claim` takes a `source` as
`spaces.create` does.

The first `spaces.takeOver` or `spaces.waitForControl` after a hold also
reports, once, and only when there's something to say:
- `reloaded`: the labels of the task's pages zenius loaded afresh since the
  agent last had control: at the hand-off, at the user's Take over, or at
  Resume after the user typed a secret into the page.
- `openerCut: true`: during the hold, the page the user held moved to a
  browsing context group of its own, so its `window.opener` is null and
  its opener's handle to it reads closed. A sign-in popup's message to its
  opener never arrived; start the sign-in again without a hand-off.
- `blanked`: the labels of the pages a secret step showed (the hand-off's
  `secret: true`): the tab handed off, and the popups it opened while the
  user held it. Each now shows `about:blank`, with no history to go back
  to; one that wouldn't blank was closed. What the step showed is the
  user's: ask them for anything you need from it.

The hand-off (zen-core, the manager's rule of 2026-11-20): the page the
user will hold is held first (zen-observe's guards keep everything else
away from it while they type), then made safe:
- The agent's page code goes first, in every process, with its listeners,
  timers and the workers it started (zen-observe's isolated world). So does
  the user's Take over, and so does the task's end. After a hand back, what
  the agent's page code kept between calls is gone.
- When the agent's code left something in its documents that outlives
  that discard (zen-observe's evidence, reason `hooked`: a script, an
  inline handler, a frame, a form or field, a style sheet and the like), it
  loads afresh, as a new GET entry in place of the current one: a POST
  result is loaded again by GET, never resubmitted. If the agent's code
  changed the page's URL in
  place (pushState, replaceState), it loads the URL from before that
  change instead, unless the site's own code has moved the page on since. The visible, ordinary fields come back filled
  as they were, and the focus goes back to its field. Passwords, card
  fields, one-time codes and hidden inputs don't come back, and a form a
  script builds may not.
- When another window of its group with such evidence shares a site with
  it, that window loads afresh in place too, first, and the page keeps its
  opener. A window the agent's code left nothing in isn't loaded afresh
  for being beside one it did.
- Filling, clicking, reading and plain text the agent's code wrote are no
  evidence: such a page is handed off as it is, the agent's values in it.
  Nor is a Safe Browsing list or the agent's own `page.flag`: zen-ux warns
  the user on such a page instead.
- A page the agent made (a `data:` or `blob:` URL it opened) isn't handed
  off: `ZEN_HANDOFF_REFUSED`, `data.reason:
  "agentPage"`, and the agent keeps its code. `"discardFailed"`: the
  agent's code didn't stop in every process within 10 s. `"reloadFailed"`:
  a page zenius meant to load afresh brought no new document in 15 s, or
  the page's load would have left its site, through a redirect or the
  page's own script as it loaded, both from the URL it shows and from the
  URL that brought its document, which zenius loads next (a site's router
  may show its open redirect) (the message names the page, or the URL;
  `data.offSite` is then the other site's URL, and Try again fails the same
  way); the user never holds the page while
  the old document is there, nor one that the load took to another site.
  Fields come back only into a page of the same origin. `"reachable"`: another of the task's pages could still reach
  it. `data.page` is the page's label, and `data.reloaded` names the pages
  that had already loaded afresh: what the agent's code kept there is gone.
- A leave prompt can't stop these loads: zenius clears the page's user
  activation first, and Gecko asks the user only on an activated page.

After Zen restarts or crashes, each task comes back with the tabs Zen
restored. Calls wait until the runtime has put them back. A task none of
whose tabs came back is gone: a call naming it fails at once with
`ZEN_TASK_SPACE_NOT_FOUND`, `data.reason: "not_restored"`.

### Pages and tabs (zen-core)

| Method | Params | Result |
|---|---|---|
| `pages.list` | `{space}` | `[{label, tab, openedBy, url, title, active, createdAt, opener}]`: managed pages; `createdAt` is epoch ms, `opener` the label of the page a popup came from (or `null`), `active` marks the page the user sees in the space |
| `tabs.list` | `{space}` | `[{label?, tab, title, url, active, openedBy}]`: every tab of the task, managed or not. That's its pages, plus released pages and tabs the user opened from its pages; for a claimed user workspace, every tab there. |
| `pages.new` | `{space, url?, options?}` | `{label, tab}`; with `url`, also runs `page.goto` with `options` before returning. Fails with `ZEN_PAGE_BUDGET_REACHED` at Ego's 8 managed pages (pref `zenius.pageBudget`). |
| `pages.adopt` | `{space, tab, as?}` | `{label, tab}`: manages a tab from `tabs.list`, keeping its origin; `as` picks the label |
| `pages.release` | `{space, page, group?}` | `{tab, openedBy}`: stops managing a page without closing it; pages the agent opened must be closed instead. A page that shares a browsing context group with other pages of the task (an opener and its popups) fails with `ZEN_PAGE_GROUP_SHARED`: once the user's, it would share a group with pages where the agent's code runs (closed groups, `docs/research/user-tab-reach.md`). With `group: true` it releases the page and every page in its group, agent-opened ones included: `{tab, openedBy, released: [{page, tab, openedBy}]}`, the named page first. |
| `pages.close` | `{space, page}` | `{ok, deferred}`: the page ends at once. `deferred` is true when a window shows its tab, which then closes once the user leaves it. Closing the task's last tab leaves a blank one, which is the agent's and never keeps `finish()` from closing the task. |
| `pages.userPage` | `{space}` | `{label?, tab, openedBy}` or `null`: the task's tab a window shows; else the task's current Page, as in Ego: whichever came last of the page the agent made current (a new page, an acting call) and the task tab the user selected, else its first page. For a claimed workspace: its tab a window shows, else the one Zen shows when the user returns to it. |
| `page.flag` | `{space, page, reason}` | `{ok: true}`: the agent flags the page as looking like phishing or wanting what the task doesn't need. Its current top document gets the evidence reason `flagged`, with `reason` as the detail, and zen-ux warns the user on it. `reason` is required: one line of 1 to 200 characters once trimmed, with no control or bidi formatting character, else `ZEN_INVALID_ARGUMENT`. A page with no document yet fails with `ZEN_PAGE_NOT_FOUND`. Under the control gate, as other page methods. Per document, as all evidence: a reload or a new load starts clean. |

`tab` is a tab id such as `"t12"`, stable while the browser runs. `openedBy`
is `agent` (opened by the agent: new pages, popups, the blank tab) or
`unknown`. Labels are never reused within a task; a closed or released
label fails with `ZEN_PAGE_NOT_FOUND` saying so.

A tab's back-forward cache is emptied when it becomes a task's page
(`pages.adopt`, including a tab of a claimed workspace or one the user
opened from a task's page) and when it stops being one (`spaces.finish`'s
kept pages, `pages.release`, the user's Stop). Back and Forward then load
those pages afresh. The page on screen stays as it is. Within a task, Back
and Forward restore pages from the bfcache as usual.

Zen restores tabs unloaded, and the user can unload one. A `page.*` method
on such a page loads it first, as the agent's `page.goto` of the URL it
shows; `page.goto` doesn't, and `pages.close` closes it unloaded. If agents can't load that URL,
the call fails with `ZEN_URL_NOT_ALLOWED` (`data.reason: "unloaded"`,
`data.url`, `data.scheme`, `data.page`), and the page stays unloaded.

### Navigation and observation (zen-observe)

Semantics and messages are Ego's (`page-model.ts`, `driver/page-waits.ts`).
Every `page.*` request may carry `responseTimeout` (ms; the SDK sends Ego's
`EGO_BROWSER_RESPONSE_TIMEOUT_MS`, default 15000): how long a call waits for
a pending navigation, and `page.evaluate`'s budget.

| Method | Params | Result |
|---|---|---|
| `page.goto` | `{space, page, url, options: {timeout?, waitUntil?, referer?}}` | receipt: `{}`, `{popups: [{label, targetId}]}` or `{dialog}`, plus `refused` when zenius refused something on the way (below) |
| `page.reload` | `{space, page, options: {timeout?, waitUntil?}}` | receipt |
| `page.info` | `{space, page}` | `{url, title, w, h, sx, sy, pw, ph}`, or exactly `{dialog}` while one is open; waits for a pending navigation as `page.url` does. Exactly `{url}` when the page's document isn't web content (I5): its title and metrics are the document's |
| `page.url`, `page.title` | `{space, page, poll?}` | string: the document the tab shows. As in Ego, whose renderer answers nothing until the commit, a pending navigation (after a link click, or a fresh popup's first) holds them one bounded period (`responseTimeout`), then is stopped with `ZEN_PAGE_UNRESPONSIVE`. An open dialog doesn't fail them. `page.url` with `poll: true` answers at once and never stops a navigation: the SDK's `waitForURL(predicate)` polls with it. `pages.list` and `tabs.list` show where a pending popup is going. |
| `page.waitForURL` | `{space, page, matcher, options}` | `null`; matcher `{type: "glob", value, regex}` (the SDK compiles the glob, anchored) or `{type: "regex", value, flags}` |
| `page.waitForLoadState` | `{space, page, state, options: {timeout?, idleMs?}}` | `null`; `domcontentloaded`, `load` or `networkidle` |
| `page.waitForSelector` | `{space, page, target, options: {timeout?, state?}}` | `true`; Ego's selector forms and refs. Looks in every frame, as Ego's resolver does: a match in the main frame wins, else the first frame (tree order) with one; a locator (`loc=`, `text=`, `css=`, or a selector using `:has-text()`: zen-input's resolver treats all of them as Ego's strict locators, so waits and actions agree) must match once in the main frame or, failing that, once across the others, else `ZEN_SELECTOR_AMBIGUOUS` with Ego's text and `data.matches`; a raw CSS or XPath selector takes the first match. A stale ref (its document is gone) fails at once with `ZEN_REF_STALE`, Ego's "Stale ref: @N; take a new snapshot", whatever the state, before the wait or when its document goes during it |
| `page.waitForFunction` | `{space, page, fn, isFunction, arg?, options: {timeout?, polling?}}` | `true`. As in Ego, a predicate that throws ends the wait with `ZEN_EVALUATION_FAILED`, except while the page is still loading (no body yet) or a navigation is under way: then the throw counts as not yet. After a navigation the next document's first poll comes `polling` ms later, as Ego's does |
| `page.waitForEvent` | `{space, page, event, options}` | popup → `{label, openedBy, targetId}`; download → `{download, url, suggestedFilename}` (a pdf.js viewer's own save gives one too, with the PDF's URL and file name); filechooser → `{chooser, multiple}` (zen-input's, see Actions) |
| `page.evaluate` | `{space, page, fn, isFunction, arg?}` | the value, as Chrome's returnByValue; `undefined`, functions and symbols → `null`; NaN, ±Infinity, -0 and BigInt → `unserializable`. The code runs in the agent's isolated world for the document, never in the page's own JavaScript (see below) |
| `page.fetch` | `{space, page, url, options: {timeout?, binary?, ...RequestInit}}` | `{ok, status, statusText, url, headers, body}`; with `binary: true`, `bodyBase64` in place of `body` (the SDK's `saveAs` sends it and writes the file). `options.saveAs` → `ZEN_INVALID_ARGUMENT`. A body over 50 MiB fails as Ego's fetch errors do (plain) |
| `page.screenshot` | `{space, page, options: {fullPage?, clip?, scale?, raw?}}` | `{mimeType: "image/png", base64}`: PNG in CSS px; `clip` in document coordinates. A shot shows what's on screen, as Ego's: the viewport and any clip wholly inside it have the page's scrollbars, and a clip that leaves the viewport is drawn from the document, without them. `options.path` → `ZEN_INVALID_ARGUMENT`: the SDK writes the file it names. `ZEN_PAGE_NOT_WEB_CONTENT` with `data.frame: true` while a frame of the page is the browser's own or an add-on's (a password manager's menu), even hidden (I5). `covered`, the count of add-on frames painted over in gray, comes with the first update, which paints over them instead of refusing |
| `page.acceptDialog` | `{space, page, promptText?}` | `true`, or `false` when no dialog is open. A dialog of a document that isn't web content (an add-on's frame) is never the agent's (I5): no event, no answer. While the user can't see the tab it's dismissed unseen (`confirm` false, `prompt` null); when they can, Firefox shows it to them |
| `page.dismissDialog` | `{space, page}` | `true` or `false` |
| `page.events` | `{space, page}` | `[{method, params}]`, CDP-shaped, drained; the newest 10000 kept, and at most 1 MiB of them. Nothing from a document that isn't web content (I5): not its console, and not the requests it or an add-on makes in the tab |
| `download.read` | `{download, offset?, length?}` | `{base64, size, eof}`: bytes `[offset, offset + length)` of the finished file (`offset` 0, `length` at most and by default 8 MiB). It waits for the download to finish, and fails as Ego's `path()` does for a failed one. The SDK's `saveAs()` and `path()` read it in chunks and write the file themselves |
| `download.saveAs`, `download.path` | `{download, ...}` | `ZEN_INVALID_ARGUMENT`, naming `download.read`: no Download method takes or returns a path |
| `download.failure` | `{download}` | string or null |
| `download.cancel` | `{download}` | `{ok}`; like a mutation in the download's own task (I3): waits at a takeover prompt, and fails with `ZEN_TASK_SPACE_USER_IN_CONTROL` while the user holds the task |
| `download.delete` | `{download}` | `{ok}`; under the same control check as `download.cancel` |

- **A task's downloads are capped.** A task holds at most 50 downloads
  and 1 GiB of them at once (prefs `zenius.observe.downloads.maxCount`
  and `zenius.observe.downloads.maxMiB`). A download beyond either is
  canceled, its partial file is deleted, and `page.events` gets
  `Zenius.refused` with kind `download`. A download the agent never heard
  of starts no `Page.downloadWillBegin`, and a `page.waitForEvent`
  download wait fails with `ZEN_DOWNLOAD_FAILED` (`data.refused`). One it
  already has fails with the refusal as its `download.failure()`.
  `download.delete` makes room. When the task finishes, its downloads and
  their files go, whoever received them. If the user turns on Firefox's
  block of repeated downloads without a click (Zen ships it off), a
  blocked one is refused the same way, and nothing shows in the user's
  window.
- **A download whose folder changed is refused the same way.** zenius keeps
  downloads in a folder of its own under the profile. If a link stands in
  place of that folder, of a download's folder or of its file, the
  download is refused ("the folder it keeps downloads in had changed …"):
  a new one before it starts, a finished one at its next `download.read`.
  Nothing is read or written through the link. So is one the browser began
  outside that folder ("the browser began it outside the folder zenius
  keeps downloads in …"); starting it again works.
- `data.plain: true` marks what Ego throws as a plain `Error` without a
  code: `page.goto failed: …`, reload and wait timeouts, page exceptions
  (`JavaScript evaluation failed …`), fetch and download failures. The SDK
  throws those the same way.
- While a navigation is pending, a call that needs the page waits up to
  `responseTimeout` for its commit, then stops it and fails with
  `ZEN_PAGE_UNRESPONSIVE` (`data.stopped`, `data.currentUrl`), or for
  `page.evaluate` `ZEN_PAGE_EVALUATION_TIMED_OUT` with `data.stopped`.
  While a JavaScript dialog is open, such calls fail at once with
  `ZEN_PAGE_DIALOG_OPENED`.
- `page.evaluate`'s script is stopped after `responseTimeout - 1000` ms (at
  least 1000). Its timeout error has Ego's `executionStopped`,
  `mayHaveLateEffects` and `pageResponsive`. The world's own hook stops it,
  in the call or in a callback the call left running then, loops that call
  no built-in included; a callback that starts later still runs (Ego's late
  effects). Outside a call, a callback may run 1 s at once.
- The isolated world (docs/research/isolated-world.md): one sandbox per
  document, kept across calls, that shares only the page's DOM. A page
  global the world can't see throws a ReferenceError naming it, and the call
  fails with `ZEN_PAGE_GLOBAL_HIDDEN`. Routes into the page's own JavaScript
  (string timers, another window's timers, `javascript:` URLs, location
  setters other than `window.location`, the page's `eval` and `Function`,
  script elements) run there. Since what they leave outlives the world, they
  mark the page with evidence (`hooked`; SPI, "The evidence flag"), and the
  user's defenses then apply to it. The world has the page's guards. The clipboard
  is the Space's, as for the page. A passkey request from the world is
  refused (`NotAllowedError`, a `deviceAccess` refusal), while the page's
  own waits for the user. A user's takeover stops the world's busy script
  within about 200 ms. A page that leaves its task (kept at the finish,
  left by a Stop, released) loses the world at once, with its timers,
  listeners and workers. A page the agent closes takes only its own
  world: the task's other pages keep theirs, its opener included. If the
  close waits for the user viewing the page, its opener's world ends too:
  the opener shares a group with a window outside the task, so its calls
  are refused (closed groups).
- The user's setting for agents' page code (observe/pagecode.sys.mjs):
  `zenius.agentTabs.pageCode` is `always` (the default), `ask` or `never`;
  any other value, or a pref of another type (a Boolean `false`), reads as
  `ask`. `zenius.agentTabs.pageCodeSites` lists the
  sites the user allowed, comma separated, each `scheme://eTLD+1`. Only the
  user writes them: in about:config, or on the Allow button of the card in
  the tab, on its trusted click. No method writes either. Page code is
  `page.evaluate` and `page.waitForFunction` (checked before each poll),
  and the agent's own `data:` and `blob:` pages. The check comes first, so
  a refused call makes no world and leaves no mark.
  - `never`: they fail with `ZEN_PAGE_CODE_OFF`, whatever the list says,
    and so do `page.goto` to a `data:` or `blob:` URL (`pages.new` with
    one too) and `page.reload` of one.
  - `ask`: on a site not on the list they fail with `ZEN_PAGE_CODE_ASKED`.
    The first such call per task and site shows the user the card in that
    tab. After the user's "Not now", the task's calls there fail with
    `data.declined: true`. Once the site is on the list, the next call
    runs. The agent's own pages run without asking. A page with no
    `http(s)` site to allow (`about:blank`, the opener's popup before it
    loads) is refused.
- Closed groups (docs/research/user-tab-reach.md, item 1 and decision 2): in
  a page that shares a browsing context group with a window outside its
  task (zen-core's `pages.codeRefusal`), the agent's code doesn't run.
  `page.evaluate`, `page.waitForFunction` (checked before each poll),
  `page.goto` to a `data:` or `blob:` URL and `page.reload` of one fail with
  `ZEN_AGENT_CODE_REFUSED`, and so does `page.goto` to another site: one
  other than the site of the page's document (an opaque document's
  creator's) or of the URL it shows. The page's own site, `about:blank` and
  a reload of a web page still load. `data`: `method`, `page`, `reason`
  (`"group"`), `windows`; the message names no window or URL of the
  user's. Nothing is marked as the agent's code.
- `page.events()` records `Page.javascriptDialogOpening`,
  `Page.javascriptDialogClosed`, `Page.downloadWillBegin`,
  `Network.requestWillBeSent`, `Network.responseReceived`,
  `Network.loadingFinished`, `Network.loadingFailed`,
  `Runtime.consoleAPICalled`, `Zenius.refused`, `Zenius.mediaPaused` and
  `Zenius.mediaResumed`. Waits never consume them. A page's text can't grow
  the browser's memory:
  - an event carries at most 8192 characters of text, each string at most
    4096;
  - an array or object keeps 64 entries, and nesting 8 levels;
  - a console call forwards 32 arguments;
  - an event that lost anything says `truncated: true`, and so does a
    console argument that was cut;
  - each page keeps its newest 10000 events and at most 1 MiB of them;
  - a page's events go when it closes, or when its task finishes, kept
    tabs included.
- **Refused surfaces.** In a page the agent drives, zenius refuses Firefox
  UI that would open over the user's view, leave the browser or touch the
  OS, and says so. The page gets the answer it already handles:
  - `print`: `window.print()` returns as after Cancel.
  - `httpAuth`: HTTP sign-in; the response to the request without
    credentials loads.
  - `externalApp`: `mailto:`, `zoommtg:` and other links to apps; nothing
    opens.
  - `fullscreen`, `pointerLock`: the element gets `fullscreenerror`, or the
    document `pointerlockerror`, and the request's promise rejects
    (TypeError, NotAllowedError). The window stays as it is and the
    pointer stays free.
  - `wakeLock`: `navigator.wakeLock.request()` rejects with
    NotAllowedError.
  - `speech`: `speechSynthesis.speak()` ends the utterance with an `error`
    event (`synthesis-unavailable`), and nothing is spoken.
  - `share`: `navigator.share()` rejects with AbortError, as after Cancel.
  - `addonInstall`: an `.xpi` is neither downloaded nor installed. A
    `page.goto` to one fails with `ZEN_NAVIGATION_FAILED`, with the
    refusals in `data.refused`.
  - `popupBlocked`: a pop-up the browser blocked (opened without a user
    action) shows no bar, now or later; the event's `url` is the
    pop-up's. `redirectBlocked` is the same for a frame's blocked
    redirect of the whole page.
  - `protocolHandler`: `registerProtocolHandler()` returns as usual,
    changes nothing and shows no bar.
  - `browserConfirmation`: Firefox's own question about what the page did,
    which no page can ask: whether to send a form from a secure page over
    an insecure connection, or to send a form again on a reload. In a tab
    the agent drives, zenius answers Cancel at once, so it doesn't happen,
    and the message quotes Firefox's question and its buttons. Left to
    Firefox, the question would wait unseen in a hidden tab and hold the
    agent's action. A click that submits the form returns with the refusal
    in its receipt's `refused`. `page.reload` of a page a form posted to
    fails at once with `ZEN_NAVIGATION_FAILED` and `data.refused`. During
    the user's hold, Firefox asks the user as usual.
  - `serviceWorker` and `cacheStorage`: the site's storage that would
    outlive the task and reach the user's own tabs on the site
    (`docs/research/own-tab.md`, item 3).
    - `navigator.serviceWorker.register()` and Cache's `put`, `add` and
      `addAll` reject with SecurityError, as when the user's settings block
      site data. Reading Cache Storage still works.
    - This holds in every document of the task's pages, for the task's
      whole life, the user's hold included. It also holds in a popup they
      open from its first document, and in the workers they start:
      dedicated, nested and shared.
    - Each document reports each kind once, and so does each worker.
      The site's own service worker (below) is reported apart, each case
      once, told apart by their messages: a document or worker reports
      `serviceWorker` for a refused registration, for its first reach for
      the site's worker, and for the first message from it that zenius
      dropped.
    - A task's page never shares a shared worker with the user's tabs or
      another task's pages: it gets one of its task's own, whose
      `self.location` ends in `#zenius-task-<space>` (`#zenius-agent` in a
      page kept with the agent's code after its task).
    - A task's BroadcastChannels are its own. In its documents and their
      workers, a channel joins only the same name in the task's other
      documents: never one in the user's tabs or in another task, either
      way. `name` reads as given. A page that keeps the agent's code after
      the task gets channels no tab of the user's joins. A tab the task
      claims keeps the channels its document opened before.
    - A page the task kept is the user's again, unless the agent's code
      ran in it. Then the refusals stay until a load or reload replaces
      the document (see "After the task" below).
    - The site's own service worker, registered from the user's tabs, runs
      for them, outside the task. A task's pages don't use it:
      - Their requests and navigations skip it, frames and dedicated
        workers included, even after it claims them (a new version
        activating, or its own `clients.claim()`). So do a shared worker
        they start and the workers that one starts from a URL, from their
        start and after a claim. Those workers' URLs end in the shared
        worker's mark too (`#zenius-task-<space>`). The exception: a blob:
        worker that a claimed one starts inherits the site's worker.
      - The page, and the agent's code in its world, can't reach it, as
        if the site had none:
        `getRegistration()` resolves undefined, `getRegistrations()` an
        empty list, `ready` never settles, `controller` is null, and a
        ServiceWorker's `postMessage` does nothing.
      - Nor can it reach them first. A message it sends them (to each
        client its `clients.matchAll({ includeUncontrolled: true })`
        lists, say) never arrives: not in the page's listeners or
        `onmessage`, the agent's world, a frame or a worker. The ports it
        carries are closed, so nothing answers through them. Events the
        page dispatches itself still arrive.
      - The first such access reports `serviceWorker` once per document,
        and so does the first message dropped.
      - The workers they start get the same answers, dedicated, nested and
        shared, and each reports its first such access once and its first
        dropped message once.
      - The same holds after the task in a page that keeps the agent's
        code.
  - `deviceAccess`: the user's devices and location. The system's consent
    prompt for them (macOS's TCC) would decide for the user's whole
    browser, their own Zen included.
    - While the agent drives a page, the camera, microphone, screen,
      speakers and speech recognition are refused. `getUserMedia()`,
      `mozGetUserMedia()`, `getDisplayMedia()` and `selectAudioOutput()`
      reject with NotAllowedError, as when the user says no. Speech
      recognition ends with a `not-allowed` error event.
      `enumerateDevices()` resolves to an empty list. No request leaves the
      page: none reaches the browser's prompt or the OS. The message says
      the task can go to the user for it.
    - On evidence (SPI, "The evidence flag"), the location and MIDI are
      refused too. Geolocation calls the error callback with
      PERMISSION_DENIED, and `requestMIDIAccess()` rejects with
      NotAllowedError. All of these hold during the user's hold then, and
      the message names the evidence.
    - Otherwise a page asks for the location and MIDI as any site does.
      Its prompt goes to Firefox's own, which gives the Space to the user
      while the agent drives (`location`), and a stored grant answers.
    - During the user's hold (or Take over), with no evidence, the page
      uses the devices through Firefox's own prompt, as a tab of the
      user's does. When the agent has the tab again (Resume, a claim, an
      adoption), every stream in it stops. The agent hears of it once,
      with `api: "stopSharing"` and `asked` naming the devices it used.
      The site keeps the grants the user gave, and a tab the user keeps at
      the finish keeps its stream.
    - Where it holds is every document of the task's pages, and a popup
      they open from its first document. Workers have none of these APIs.
    - Each document reports each API once. A page the task kept is the
      user's again, as for `serviceWorker`.
  - `notification`: a desktop notification, refused on evidence, during
    the user's hold too. `new Notification()` gives one that fires `error`
    and nothing else, and `showNotification()` rejects with a TypeError,
    as where notifications are blocked. This covers every document of the
    task's pages, their fresh frames and their workers.
    - Without evidence a page makes its notifications as any site does.
      Its prompt goes to Firefox's own. Where the site has the user's
      grant, zen-ux's quiet notification answers while the agent drives:
      the page sees `show`, and the agent gets `Zenius.notification` (see
      "Notifications" in zen-ux's section). During the user's hold the
      page's own shows.
    - A task page's workers are refused for the task's whole life: a
      worker can't tell who holds its page.
  - `localNetwork`: the local network. On macOS 15 an app's first reach
    into it raises the system's Local Network prompt, which decides for the
    whole browser.
    - Requests to private addresses (10/8, 172.16/12, 192.168/16, fc00::/7),
      link-local ones (169.254/16, fe80::/10) and `.local` names are
      cancelled in the parent before they look anything up or connect:
      the page's own loads, frames, fetches, WebSockets, beacons, its
      dedicated workers', a redirect's next request, and a popup's first
      load. So are the requests of a shared worker it starts and of the
      workers that one starts from a URL; their refusals are told on a
      page of the task, as "(a request of a worker it started)". While a
      task's page shows a site, so are that site's blob shared workers'
      requests, told as "A blob shared worker of this site tried to reach
      …". Meanwhile that includes the user's own blob shared workers on
      the site. A task's page can't start a `data:` shared worker:
      SecurityError, reported as `localNetwork`. Gecko's other ways to
      write an IP literal (decimal, hex, IPv4-mapped IPv6) count. Loopback
      (127/8, ::1, localhost) stays open.
    - While the agent drives a page, or on evidence, `new
      RTCPeerConnection()` throws NotAllowedError, since gathering ICE
      candidates reads the machine's addresses. During the user's hold,
      with no evidence, the page makes its own.
    - `page.goto` to such a host fails before loading:
      `ZEN_NAVIGATION_FAILED`, `data.error: "localNetwork"`, a message that
      starts `net::ERR_ACCESS_DENIED.` A redirect there, or the page's own
      navigation, is cancelled the same way, and `page.goto` fails with the
      refusal's message.
    - The user can open hosts and ranges in the
      `zenius.agentTabs.allowPrivateNetworks` preference: a comma-separated
      list of `.local` names, addresses and CIDR ranges (`10.20.0.0/16,
      fd00::/8, printer.local`), empty by default. It is read in the
      parent; agents can't change it. It opens loads and requests, never
      WebRTC.
    - One event per page and host for 30 s, but each refused navigation
      has its own. Where it holds is as for `serviceWorker`.
    - A load the user starts in a task's tab is refused too, even during
      their hold: the agent resumes in that tab. zen-ux's notice in the tab
      says why and offers the user's own tab or the preference.
    - A task's documents and frames don't prefetch DNS: neither
      `<link rel=dns-prefetch>` nor an http page's links look names up.
      Lookups that preconnect and Early Hints make, which never connect to
      a private address, are an accepted residual
      (`docs/research/observe.md`). No event: nothing was refused.
  - `userTabNavigation`: a page where the agent's code ran tried to load a
    page in a tab outside the task, or in a frame of one: by its
    `location`, a named `window.open`, a link or form with its name, a
    `blob:` or `about:blank` alike. The parent stops the load before
    anything is sent, the tab stays as it was, and the page hears nothing.
    The page's own loads, its frames' and its new popups' and tabs' still
    go, and so do a page's where the agent's code didn't run (a sign-in
    popup moving its opener). After the task every other tab is outside. Closed groups'
    second layer (`docs/research/user-tab-reach.md`, item 4): with items 1
    to 3 it shouldn't fire.
  - `heldPageNavigation`: while the user holds a page after a hand-off, a
    page outside the hold tried to load a page in it or in one of its
    frames. The parent stops the load before anything is sent, and the
    held page stays as it was. The held page's own loads, those of the
    popups it opens during the hold (a sign-in popup reporting back), and
    the user's go. The agent hears of it when its page tried.
  - **The parent's second line.** The parent process refuses the same
    requests again, out of the page's reach, for when a page refusal is
    bypassed. It holds for every page of a live task and its frames, a
    stored grant or not, by the same rules. The agent hears of each API
    once per document:
    - Device requests (`getUserMedia`, `getDisplayMedia`,
      `selectAudioOutput`) are denied before any prompt or OS check while
      the agent drives and on evidence: NotAllowedError, `deviceAccess`.
      During the user's hold they reach Firefox's prompt.
    - A WebRTC peer connection is denied the same way, before it gathers
      an address: NotAllowedError, `localNetwork` with `api:
      "RTCPeerConnection"`.
    - On evidence, every permission prompt is cancelled before
      PermissionUI shows it, the user's hold included. That is zen-ux's
      `promptDenied` (see its "Permission prompts in a task's pages"), here
      with `api` and `asked` (`location`, `notifications`, `persistent
      storage`, `midi`, …). The page gets what a dismissed prompt gives:
      geolocation's PERMISSION_DENIED, `"default"` from
      `Notification.requestPermission()`, `false` from `storage.persist()`.
      Without evidence every prompt goes on to Firefox's own: zen-ux's
      hand-off while the agent drives, the user's answer during the hold.
    - What has no parent hook stays with the page refusals: a service
      worker, and a notification or MIDI the site already has the user's
      grant for (SPI's "Parent backstops").
  - **After the task.** `serviceWorker`, `cacheStorage` and `localNetwork`
    stay refused in a page the task leaves to the user while it may hold
    the agent's code: the agent's world wrote into it, the agent pasted html
    into it, or the agent made it (`data:`, `blob:`). `deviceAccess` and
    `notification` follow the evidence there, as in the task. Code the agent only ran in its world goes with the world as
    the page leaves the task, and the refusals go with it. A page leaves the
    task when it is kept at the finish, left by a Stop, released by the
    agent, or closed by the agent while the user views it.
    The code counts if it ran in the page's top document or a frame, or on
    the site of any of its documents during the task. Those are the pages
    where zen-ux shows its "ran the agent's code" pill. Code the agent left
    there keeps running after the task.
    - They hold in every frame of that page, and in the frames, popups
      and workers its code makes, until a load or reload replaces the top
      document. Going Back to that document brings them back.
    - The user's own navigation from the browser (the address bar, a
      bookmark) goes through and replaces the document; the page's own
      navigation to the local network doesn't.
    - The pill offers Reload. A page where the agent only clicked or typed
      is the user's again at once.
  - `audio` is muted, not refused. A tab the user can't see is muted, and
    its pages play on silently; the event comes when a page plays sound
    while muted, once per document. The sound comes back when the user
    opens the tab. A tab the user muted or unmuted by hand keeps their
    choice.

    Meanwhile, video that would keep the display awake pauses (SPEC
    §3.5): any playing video with an audio track, muted or not, and any
    MediaStream video. zenius resumes only what it paused, when the user
    opens the tab or the tab stops being the agent's; what the page or the
    agent paused stays paused. `page.events` gets `Zenius.mediaPaused` and
    `Zenius.mediaResumed` `{reason: "hidden", count, url}`. Pauses of media
    that starts while the tab is hidden come gathered, at most one event
    every 2 s.

  Each refusal is a `Zenius.refused` event `{kind, message, url}` in
  `page.events`. It also appears as `refused: [{kind, message}]` in the
  receipt of the action that caused it (`page.goto`, `page.reload`, and
  zen-input's actions). A `deviceAccess` or `notification` event adds
  `api`, the API the page called (`getUserMedia`,
  `geolocation.watchPosition`, `Notification`, …, or `stopSharing` for a
  stream zenius stopped), and `asked`, what it asked for: `camera`,
  `microphone`, `camera microphone`, `screen`, `speakers`, `device list`,
  `location`, `midi` or `notifications`.
  A task's page shows Firefox's own permission prompts, as any site does,
  unless it shows evidence. While the agent drives, each gives the Space to
  the user as in Ego (`ZEN_TASK_SPACE_USER_IN_CONTROL` with Ego's reason),
  once per site in a task (see zen-ux's "Once per site in a task"). During
  the hold the user answers it. On evidence the parent cancels every
  prompt (`promptDenied`, below). docs/research/observe.md §10 has the
  full sweep.
- **The agent's JavaScript runs only while it controls the Space (I3).**
  `page.evaluate` and `page.waitForFunction` are held while the Space is
  paused (a takeover prompt, the panel's Pause) and refused under user
  control, like actions. A wait already polling stops before its next run
  of the predicate when the Space is paused, and goes on when the agent
  has it back; time paused doesn't count against its timeout. If the user
  takes the Space, the wait fails with `ZEN_TASK_SPACE_USER_IN_CONTROL`
  and `data.stopped`. An evaluation running when the Space is paused or
  taken fails the same way, with `data.reason: "paused"` for a pause, and
  a script still running is stopped: on http(s) and file pages, since
  Firefox doesn't stop scripts on data:, blob: or about:blank pages.
  Callbacks and promise continuations it left in the page aren't stopped.
- **Agents stay in web content (SPEC §3.9 I5).** The browser runs with the
  user's rights, so:
  - `page.goto`, `page.reload` and `pages.new` with a `url` load only
    `http:`, `https:`, `data:`, `blob:` and `about:blank` URLs, and never
    with the system principal (an http(s) load is triggered by the URL's
    own origin, so the request is same-origin, as a site's own link). Any
    other scheme fails with `ZEN_URL_NOT_ALLOWED`, and the page stays
    where it was. That includes a reload of a page the user opened.
  - Every `page.*` method that acts in or reads the document fails with
    `ZEN_PAGE_NOT_WEB_CONTENT` unless the page's document is web content:
    not the system principal or an add-on's; not a `file:`, `about:` (but
    `about:blank` and `about:srcdoc`), `chrome:`, `resource:`, `jar:`,
    `view-source:`, `moz-src:` or `moz-extension:` document, or Firefox's
    error page for a failed load; in a web content process. Firefox's PDF
    and JSON viewers count as web content. That holds whoever opened the
    page, the user during a takeover included, and it is checked before
    the method resolves anything. `page.url`, `page.info`, `page.events`,
    `page.goto`, `page.reload` and the `waitForURL`, `waitForLoadState` and
    `waitForEvent` waits still work, so the agent can see where it is and
    leave. Nothing in them comes from such a document: `page.info` gives
    the URL only, and `page.events` leaves out its console and requests.
  - Frames too: an action aimed at a frame that isn't web content (an
    add-on's frame in a web page, or an error page in a frame) fails the
    same way, with `data.frame: true`; `page.snapshot` prints such a frame
    empty, and locators and `waitForSelector` don't look into it.
    `page.screenshot` paints every frame, so it is refused while the page
    holds an add-on's frame or the browser's own, shown or hidden (the
    page could show a hidden one). Painting over an add-on's frame in gray
    instead is built but off: a page that moves the frame during the paint
    could leave it uncovered. The first update turns it on, with the page
    held still for the paint. No refusal names an add-on frame's URL: its
    host names the add-on. An error page in a frame still paints: it shows what the page
    asked for, and nothing can act in it.
  - A certificate warning is such an error page, though it shows under
    the site's URL: its "Accept the Risk" would add a lasting exception to
    the user's profile. A `page.goto` or `page.reload` that ends on one
    fails with `ZEN_NAVIGATION_FAILED`, Chromium's name for the error
    (`net::ERR_CERT_AUTHORITY_INVALID`, `..._COMMON_NAME_INVALID`,
    `..._DATE_INVALID`, or `net::ERR_CERT_INVALID`), the NSS error in
    `data.error`, and `data.certificateWarning: true`. It returns once the
    tab shows the warning, where every document method is refused.
  - The runtime reads or writes no file an agent names: screenshots,
    fetched bodies and downloads come back as bytes, and a `path` or
    `saveAs` parameter is refused before anything is written.
  - `browser.health` reports `i5: {loads, pageGate, contentGate,
    refuses}`, for zenius doctor, and opens nothing. `loads` lists what an
    agent may load, sorted: `["about:blank", "blob:", "data:", "http:",
    "https:"]`. `pageGate` and `contentGate` say the page gate and the
    content-call check are in place, and `refuses` that the runtime's own
    refusals pass a self-test. All are computed from what enforces them.

### Snapshot (zen-snapshot)

| Method | Params | Result |
|---|---|---|
| `page.snapshot` | `{space, page, options}` | `{text, refs?}`. `text` is the full Ego-format output, header line included; the SDK reads only `text`. `refs: [{ref, role, name, loc?, url?}]` lists the printed refs, only with `includeRefs: true` (for tests and tools). Options: Ego's `scope` (`only_within_viewport` default, `full_page`, `subtree` with `root: "@N"`), `includeActionMarks`, `includeStableLocator`, plus `interactiveOnly` and `maxResultLength` (Ego's native options, which the SDK doesn't take; see `docs/research/snapshot.md` §4.8) |

### Actions (zen-input)

| Method | Params | Result |
|---|---|---|
| `page.click`, `page.dblclick`, `page.hover` | `{space, page, target, options}` | receipt |
| `page.dragAndDrop` | `{space, page, source, target, options}` | receipt; an HTML5 drag carries what the page set in `dragstart` through to `drop`; ends in different frames drag in page coordinates, with mouse events only, as Ego's do |
| `page.fill` | `{space, page, target, value, options}` | receipt |
| `page.selectOption` | `{space, page, target, values, options}` | `{selected: [values]}`; fails with `ZEN_PAGE_DIALOG_OPENED` (`data.dialog`) when its `input` or `change` event opens a dialog, which stays open: as Ego's, it returns values, not a receipt |
| `page.focus` | `{space, page, target, options}` | receipt |
| `page.press` | `{space, page, target, chord, options}` | receipt |
| `page.setInputFiles` | `{space, page, target, files}` | receipt; `files` are file payloads (below), never paths; `[]` clears; an input without `multiple` keeps the first, as Chromium's does |
| `page.mouse` | `{space, page, action: "move"\|"down"\|"up"\|"click"\|"wheel", x?, y?, dx?, dy?, options}` | receipt for `click`, else `{}` |
| `page.keyboard` | `{space, page, action: "down"\|"up"\|"press"\|"type"\|"insertText"\|"paste", key?, text?, html?, options}` | receipt for `press` and `paste`, else `{}` |
| `filechooser.setFiles` | `{chooser, files}` | `{}`, or `{dialog}` if the page opened one; `files` are file payloads, `[]` cancels |

A receipt is `{}` when nothing extra happened. Otherwise, as in Ego, it has
`popups: [{label, targetId}]` for pages the action opened (`targetId` is
the popup's `tabs.list` tab), or `dialog: {type, message, defaultPrompt?,
url}` for a JavaScript dialog it opened. The call returns as soon as a
dialog opens, and the rest of the gesture is never sent, even after the
agent answers: no later click of a `dblclick`, no release, no later key, no
read-back or second try of `fill`, no next step of a wheel motion. Ego's
pending input commands fail the same way. The event whose handler opened
the dialog finishes, as the one Chromium was handling does (a `keydown`'s
`keypress`, a press's focus change). A press left unreleased is released
out of the page's sight, with no click.

A ref (`@21`) whose element the page took out of its document stays that
element's. An action on it retries while the element is out, and acts once
the page puts the same element back, as Ego's does. Still out at the
timeout, it fails with `ZEN_NOT_ACTIONABLE` ("… element is not
connected"). The ref turns stale (`ZEN_REF_STALE`) only once its document
goes away or the element is garbage-collected.

- **A middle click on a link** (an action with `button: "middle"`, or
  `page.mouse`) opens the link as a new page of the task, in the
  background, listed in `popups`, as Ego's does. Firefox's own handling
  stays cancelled, so nothing opens outside the task, and on Linux nothing
  is pasted from the user's PRIMARY selection. Nothing opens when the page
  cancels the `auxclick`, from an editable field, or for a URL that
  `page.goto` couldn't load (`mailto:`, `file:` and the like).
- **The agent's cursor.** On a page someone can see, a pointer action
  flies the agent's cursor to its point before it acts, with the action's
  `label` beside it (`ui.cursor`). A `click` or `dblclick` without a
  `label` shows Ego's "Clicking element"; other actions leave the label
  shown. A `dragAndDrop` flies to its source before the press and on to
  its target before the release, so the release comes after that flight.
  The page hears the same events as on a page nobody sees.
- **File choosers** never show a native dialog in an agent tab. Send
  `page.waitForEvent` with `event: "filechooser"` (the SDK's
  `page.waitForFileChooser`) before the action. It resolves to
  `{chooser, multiple}`, which `filechooser.setFiles` answers, or fails with
  `ZEN_FILE_CHOOSER_TIMEOUT` (default 10000 ms), or at once with
  `ZEN_PAGE_NOT_FOUND` if the page closes first. `filechooser.setFiles`
  returns once the files are on the input and its `input` and `change`
  handlers have run, on an input the page never attached too. Otherwise the action
  cancels the chooser and fails with `ZEN_FILE_CHOOSER_OPENED`, as Ego's
  does, also when the page asks for the chooser itself during the action
  (`input.click()` or `showPicker()` in a handler). One the page opens after
  the action has returned is cancelled, and the action's result stands. A chooser
  waits for its answer only while the agent drives the tab. A handoff, a
  takeover or the task's end cancels it, as a user's Cancel would (the page
  hears `cancel`), so the user's own click finds the input free: an input
  has one chooser at a time. An answer to it then fails, with
  `ZEN_TASK_SPACE_USER_IN_CONTROL` while the user holds the task and
  `ZEN_INVALID_ARGUMENT` after. A chooser whose tab is no longer one of the
  agent's pages (released) is cancelled at the answer, which fails with
  `ZEN_PAGE_NOT_FOUND`.
- **Pickers.** While the agent drives a tab, a date input, a `<select>` or
  a color input opens no browser panel (nor the OS color panel), whether
  the agent clicked it or the page called `showPicker()`. The action's
  receipt and `page.events` carry the refusal: kind `datePicker`,
  `selectDropdown` or `colorPicker`. Set the value with `page.fill` or
  `page.selectOption`. Keys typed into a date or time input still fill its
  fields, in the locale's order, after a click into it or at a field's
  `spinbutton` ref (en-US: `01022024` is 2024-01-02). While the user holds
  control, their own clicks get the pickers.
- **Saved logins, addresses and cards** never reach an agent tab, and
  nothing an agent tab does reaches the user's password manager, autofill
  stores or form history. In a tab of an agent task, whoever holds
  control, nothing fills on load and nothing is captured (no "save
  password", address or card doorhanger, and no form history, whatever
  `browser.formfill.enable` says). While the agent drives, no suggestion
  popup opens (saved logins, addresses, cards, form history) and form
  autofill refills nothing. While the user holds control, their own clicks
  get their saved logins, addresses and cards as in their own tabs (not
  form history). Cookies and sessions stay shared: an agent that needs to
  log in hands off to the user.
- **Hand back clears the user's passwords, card details and one-time codes.** When the
  agent can run a task again (a hand back, `spaces.takeOver`, Resume
  agent on a takeover prompt, Resume after the panel's Pause, `spaces.claim`
  after the user's Stop), every secret field filled while the user held
  it, in every frame of its pages, is empty before the agent's next call
  runs. Secret fields are passwords, a card's number, security code and
  expiry (an expiry `<select>` goes back to its earlier choice), and
  one-time codes (`autocomplete="one-time-code"`). Card fields are found by
  Firefox's form autofill heuristics or by their `autocomplete`
  attribute. That covers what the user typed and what Firefox filled.
  Address fields keep what the user filled, for the agent to go on with.
  Fields the agent set itself keep their values, except the focused one
  after the user's key opened a takeover prompt (that key may have landed
  in it first). `pages.adopt` empties every secret field of the tab that
  holds a value, before the agent's first call there. The page's
  `page.events` gets
  `Zenius.passwordsCleared` `{count, passwords, cards, codes, message, url}`,
  which never says what the fields held.
- **Uploads carry bytes, never a path** (SPEC I5). Each file is
  `{name, mimeType, lastModified, base64}`: `name` is what the page sees as
  `File.name` (one path component; `/`, `\` and control characters become
  `_`), `mimeType` may be `""`, `lastModified` is ms since the epoch
  (default now), and `base64` holds the contents. The client reads the files
  (the SDK raises `<method> could not read <path>: no such file`, `it is a
  directory` or `permission denied` before sending). Refused with
  `ZEN_INVALID_ARGUMENT`, before anything changes:
  - a string in `files`: `<method> takes file contents, not paths: send
    {name, mimeType, lastModified, base64}; the client reads the files`;
  - over 50 MiB decoded in one call (Playwright's limit in remote mode):
    `<method>: the files total <n> bytes, over the limit of 52428800 (50
    MB)`;
  - a payload without a name or base64 contents, or with bad base64.
  An empty `mimeType` gets the type Gecko gives the name, as a real pick
  does. A chooser's files reach the page through Firefox's own picker, which
  hands over files on disk: the runtime writes them to a fresh private
  folder of its own under the profile (`zenius-uploads`), out of reach of
  any sandboxed CLI, unlike the system temp folder. It creates every folder
  and file there exclusively, never through a link, and deletes the folder
  when the tab closes or Zen quits (at most 20 answers are kept). If the
  write meets a link, `filechooser.setFiles` fails with `ZEN_INTERNAL` and
  the chooser stays open. A start removes leftovers from a crash. Their type comes from the name, as
  for a real pick. A one-file chooser keeps the first of several files, as
  Chromium's does. After a refusal the chooser stays open for another
  `filechooser.setFiles`.
- **Folder uploads** (input-gaps 24). Each file may also carry
  `relativePath`, the path the page reads as `File.webkitRelativePath`: the
  folder's own name, its subfolders, then the file's name, joined by `/`
  (`photos/2024/a.jpg`).
  - A call whose files carry it uploads one folder. `page.setInputFiles`
    gives it to an input with `webkitdirectory`, and `filechooser.setFiles`
    to a folder chooser, which Gecko opens for such an input.
  - The page gets the files as from the user's pick, with `input` and
    `change` once Gecko has walked the folder. The call returns after
    those events.
  - If Firefox's folder question wasn't answered yes, nothing is attached,
    and the call fails with `ZEN_INTERNAL`.
  - The runtime writes the folder under `zenius-uploads`, as above, and
    every path stays inside it.
  - Hidden files count. An empty folder sends nothing, so the SDK refuses
    it.

  Refused with `ZEN_INVALID_ARGUMENT`, before anything is written:
  - a `relativePath` that isn't a non-empty string, is absolute, has an
    empty, `.` or `..` segment, or holds a NUL, a backslash or another
    control character;
  - one without a folder (at least `<folder>/<name>`), or one that doesn't
    end in the file's `name`;
  - a segment over 255 UTF-8 bytes, or a path over 768;
  - two folders in one call, or files with and without a `relativePath`;
  - the same path twice, or a file that is another file's folder;
  - more than 1000 files, besides the 50 MiB above;
  - the wrong target: `the input takes files; a folder needs an input with
    webkitdirectory`, `this chooser takes a folder` (files for a folder
    chooser), or `this chooser takes files` (a folder for a file chooser).

  Two names that land on one file on the disk (letter case or Unicode
  forms, on the Mac) fail the call with `ZEN_INVALID_ARGUMENT` too.

  Firefox asks the user before any folder pick reaches a page. For the
  agent's own folder, zenius answers yes itself, once, for that folder in
  that frame. The page keeps no user activation from it.
- **Input lands only in web content (SPEC I5).** Raw `page.mouse` (a
  press, release or wheel, and where a move ends), `page.keyboard`, and the
  point of a click, hover or drag, forced or not, are refused with
  `ZEN_PAGE_NOT_WEB_CONTENT` when the document they would reach isn't web
  content. That means Firefox's error pages (`neterror`, `certerror`,
  `blocked`), an add-on's page, or a browser page, in any frame of the page.
  The check reads that document's own URI and principal, not the tab's
  URL: a certificate warning shows under the site's https URL, and its
  "Proceed" adds a lasting certificate exception. zen-observe's gate
  refuses the same documents as a page or an out-of-process frame. The
  rest of the page still takes input.
- **Other tabs' input comes first.** Gecko shares a content process's
  mouse capture, pointer capture and IME between its tabs, and one site's
  tabs share a few processes. So:
  - A press or release (a click, a drag, `page.mouse` down and up, the
    release of a held press) waits while the user composes text with an IME
    in another tab of its process, since it would commit their word. Moves
    and keys don't wait.
  - Any mouse event waits while a press is held in another tab of its
    process (the user's drag or text selection, another task's
    `page.mouse.down`), since Gecko would give it to that tab.
  - A wheel event (`page.mouse.wheel`, or the wheel that scrolls an
    action's target into view) waits while the user scrolls in another tab
    of its process, until their wheel, momentum included, has been quiet
    for 250 ms. For a while after a wheel event, Gecko sends every wheel
    of the process to the frame that event scrolled (its wheel
    transaction), so either side's would reach the other's page. zenius
    ends its own transaction after each wheel event it sends, so the
    user's wheel doesn't go to an agent's page. An agent's motion still
    scrolls what its first event scrolled, as one gesture does.
  - The wait lasts until the action's timeout (`page.mouse`: 3000 ms), then
    the call fails with `ZEN_TIMEOUT`, `data.reason` `"user_composing"`,
    `"mouse_held_elsewhere"` or `"user_scrolling"`. Nothing reaches the
    page meanwhile, and the
    user's word is never committed or cancelled. A failed `page.mouse` call
    leaves the agent's buttons and pointer where they were.
  - An agent's press keeps no mouse capture. Gecko's press on text
    captures the mouse for the whole process (for auto-scroll), which took
    the user's next press or release into the agent's tab. The agent's
    selection drag goes on without it. A press on a scrollbar, a range
    input or a list box keeps its capture, which its drag needs, and so
    does a page's pointer capture.
  - The user's mouse input that such a capture pulls into the agent's tab
    never reaches the agent's page. The press ends there, unseen by the
    page, and the user's next events go to their own tab. The event that
    ended it is lost to the user's page too, even a press or a release. A
    release that waits for the user's word goes once they finish.
  - Gecko counts `movementX/Y` from the process's last move, so the
    agent's moves count from the agent's own last point in the page (its
    first move there counts 0), never from the user's pointer.
  - When an input call ends, the agent's pointer leaves its tab, the way
    a real pointer leaves the window, and the page keeps its hover and
    hears nothing. So a reflow re-hovers neither the user's page at the
    agent's point nor the agent's page at the user's, and the user's next
    move counts from 0. While the agent holds a button the pointer stays,
    and the user's first move after the agent's isn't heard by their page
    (`docs/research/input-gaps.md`, F 5b).
  - None of this listens in a process where no task page lives: no
    listener there at all.
- **The page's microtasks come between keys.** A real key ends its task,
  and Ego's keys are separate commands, so a page's microtasks after a key
  run before the next key, and `fill` reads the field back after them. A
  field whose `input` handler undoes the text in a microtask fails `fill`
  with `ZEN_NOT_ACTIONABLE` ("page.fill did not accept the text"), as on
  Ego. The page's timers and other tasks run between keys only during a
  `delay`.
- **A page that doesn't come back.** The page ends an action's input call by
  its deadline, unless its script is busy or a browser prompt holds it in
  a nested event loop that zenius doesn't report as a dialog (Firefox's
  warning before a secure page posts a form over http, say). Then the call
  fails 5 s past its deadline (an action's `timeout`; raw input's 3000 ms
  plus its delays) with `ZEN_PAGE_UNRESPONSIVE`, `data.reason:
  "input_stuck"`, and `data.prompt: true` when a browser prompt is open in
  the tab. The input may still take effect (`data.mayHaveLateEffects`), so
  look at the page before repeating it.
- **Dialogs.** While a JavaScript dialog is open, `page.mouse` and
  `page.keyboard` return `{}` without sending, as Ego drops raw input.
  Their `click`, `press` and `paste` fail with `ZEN_PAGE_DIALOG_OPENED`, like
  any other action. A dialog that opens during raw input ends it the same
  way: the call returns `{}` at once, with the dialog open, and sends none
  of its later steps. Only a dialog in the input's own process stops those
  steps: when a cross-site frame opens one, the call still returns at
  once, but steps the input's process hasn't sent yet may still go out.
- **Clipboard.** Copy, cut and paste chords (`ControlOrMeta+C`, `+X`, `+V`)
  and `paste` use the Space's own clipboard. The system clipboard is
  never read or written.
  - On Linux, an agent's selection reaches the selection clipboard
    (PRIMARY) as any Firefox selection does: a double-click on a word, or
    select-all, puts it there for the user's next middle-click paste. The
    user can turn `clipboard.autocopy` off in `about:config`, which also
    ends copy-on-select for their own selections. zenius changes no
    preferences. macOS has no selection clipboard.
  - Pasted html reaches the page sanitized: a `paste`'s `html`, and the
    html a `ControlOrMeta+V` pastes from the Space's clipboard. Gecko's
    own sanitizer drops scripts, event-handler attributes and
    `javascript:` URLs, as Chromium does for a paste, and keeps styles
    and comments. The page and its editor get the sanitized markup as a
    whole document.
  - Any paste of html counts as the agent's code in the document it went
    into, as `page.evaluate` does, sanitized as it is: a `paste` with
    `html`, or a chord that pasted the Space clipboard's html. So the page
    keeps the refusals of "After the task" above when the task leaves it
    to the user. A paste of text alone doesn't count.
  - Pasted markup is evidence against the page (hooked) only when it
    carries code (a script, an inline handler or a `javascript:` URL), a
    frame, an object or embed, a form or a field, an editable area, a
    `<base>`, a meta refresh or a style sheet. It's read as the agent sent
    it, before the sanitizer. Then the user's first press there reloads the
    page clean. Plain markup, such as formatted text pasted into a mail,
    leaves the user's input there as in any page.
  - In a page that shares a window group with a window outside the task,
    a `paste` with `html` fails with `ZEN_AGENT_CODE_REFUSED`, and nothing
    is pasted. Text alone still pastes there, and a paste chord pastes
    only the Space clipboard's text.

### UI (zen-ux)

| Method | Params | Result |
|---|---|---|
| `ui.cursor` | `{space, page, x, y, label?, kind?}` | `{ok, visible, animated}` |
| `ui.state` | `{space}` | `{space, ownership, paused, pausedByUser, reason, badge, prompt, controlNotice, controlNote, controlMore, controlButtons}`: what the user sees of the Space, for tests and tools (`controlNote` is the hold card's small text as shown, `controlMore` what waits behind its '?') |
| `ui.sidebarStatus` | `{}` | `{loaded, windows, open, failed, perWindow, config, configPath, builtin?, error?}`: zenius's agent sidebar, for doctor |

`ui.cursor` moves the page's agent cursor to `x`, `y` (viewport CSS px of the
page's top document) with `label` beside it. `kind` is one of `move`,
`hover`, `click`, `dblclick`, `down`, `up`, `drag`, `drop`, `wheel`, `type`,
`focus`, `select` (default `move`); clicks add a ripple. It resolves when the
move animation ends, or at once with `visible: false` when nobody can see the
page. It fails with `ZEN_TASK_SPACE_USER_IN_CONTROL` when the user takes over
while it waits at the takeover prompt. Page actions call the same code in-process (`docs/SPI.md`, "UI
hooks"); the method is for tests and tools.

`ui.sidebarStatus` says whether zenius's agent sidebar (`docs/agent-sidebar.md`)
runs, for zen-sdk's doctor:
- `perWindow`: each open browser window, oldest first, as
  `{sidebar, kind?, error?}`. `sidebar` is `"started"`, `"failed"` (with the
  start's exception message as `error`), `"skipped"` in a popup (a window
  whose toolbar isn't visible, such as a site's sign-in window), where the
  sidebar doesn't start, or `"none"` when no start is recorded: the window is
  still opening, or its sidebar file isn't zenius's. Only `"failed"` and
  `"none"` carry `kind`, `"browser"`, `"private"` or `"popup"`, for doctor
  to name the window: any socket client may call this method, and other
  windows' kinds would tell it whether a private window is open. A sidebar
  script that isn't zenius's never counts, as only zenius's reports its start.
- `open`: how many windows the sidebar starts in, every one but popups.
  `windows`: in how many of them it started, and `failed`: in how many its
  start threw, with the first one's message as `error`. Popups count in none
  of them. `loaded`: it started in at least one open window.
- `config`: whether its agents' config is there: `"found"`, `"missing"`, or
  `"none"` when the pref `uc.agent-sidebar.config` is `"none"` (no agents,
  as in every dev profile). `configPath` names it: the pref, else
  `~/Library/Application Support/zenius-agent-sidebar/config.json`, in the
  sidebar's own folder. Without that file, while the pref is unset, the sidebar
  offers its built-in agents (`docs/agent-sidebar.md`), and `config` is
  `"builtin"` when one of them can run. So does the pref `"builtin"` (the
  tests'). A path the pref names never falls back to them: when it's
  missing, `config` is `"missing"`, with no `builtin`.
- `builtin`, where the sidebar would use them: what it finds of its
  built-in agents. `agents` lists those that can run. `folder` is the adapters'
  folder (`~/.zenius/agents`), and `node` its link to Node, or null when
  that's missing or broken. `clis` gives each agent's CLI path (or null),
  and `adapters` whether each adapter is installed. `missing` is the one
  line the sidebar shows when none can run, else null. If finding them
  failed: `{agents: [], error}`.

**Clipboard in agent tabs (zen-ux).** A page's own clipboard calls in an
agent tab use the Space's clipboard, like the agent's chords: a "Copy"
button the agent clicks (`navigator.clipboard.writeText()` or `write()`, or
`execCommand("copy")` and `"cut"`) fills it, and `navigator.clipboard.readText()`
and `read()` return it. The system clipboard is never read or written. The
user's own copies in that page (after their click, after Take over) reach
their clipboard as usual.
- A page reads the Space's clipboard only from the site that wrote its
  current contents: the page that copied, or the page where the agent's
  keys copied. Another site's `readText()` or `read()` fails with
  NotAllowedError, as after a dismissed paste prompt. The agent gets a
  `Zenius.refused` event `{kind: "clipboardRead", message, url}` in
  `page.events`, and in the receipt of the action that caused it.
- The agent's own paste (Ctrl/Cmd+V) pastes it into any page.

**Notifications and passkeys in agent tabs (zen-ux).**
- **Notifications.** A notification an agent page shows with the
  permission already granted (`new Notification()`,
  `registration.showNotification()`) appears nowhere. The page sees it
  shown. The agent gets a `Zenius.notification` event in `page.events()`:
  `{title, body, tag, url}`.
- **Passkeys.** A passkey request (`navigator.credentials.create()` or
  `get()` with `publicKey`) puts the Space under user control, as a
  permission prompt does.
  - Agent calls fail with `ZEN_TASK_SPACE_USER_IN_CONTROL`, `data.reason`
    `"permission_prompt"`, or wait if they're held calls.
  - The request runs when the user opens the Space and sees the page. Once
    it settles, control returns to the agent.
  - If the user resumes the agent first, the page's request fails with
    NotAllowedError.
- **A page can't ask at will.** While the agent drives, a page's passkey
  request or permission prompt hands the task to the user automatically.
  Otherwise a page could pull the user in again and again, withdrawing each
  request itself (an abort, a reload) to ask anew. So:
  - A site (the requesting page's origin) that left a request unanswered in
    a task can't hand that task to the user again, by passkey or prompt.
    Unanswered means the user handed back before answering, or the page
    withdrew it. An answered one (allowed, blocked, a passkey completed or
    cancelled) leaves the site free to ask again.
  - After 3 requests left unanswered in a task, no page can hand it to the
    user.
  - Such a request is refused without a handoff, and the agent gets a
    `Zenius.refused` event:
  - `kind: "passkey"`: the page's request fails with NotAllowedError.
  - `kind: "permissionPrompt"`: the prompt is cancelled, as when its page
    goes away, and nothing is stored for the site.
  - The agent's own `handOff()` is never limited, and while the user holds
    the task, the page's requests are theirs, as before. To let the user
    answer a refused one, hand them the task.
- **Permission prompts in a task's pages** (A8, with zen-observe's C):
  - While the agent drives, a page's prompt hands the task to the user
    with Ego's reason key: `storage_access` (an embedded sign-in frame's),
    `local_network_access`, `location`, `notifications`, `midi`, `serial`,
    or `permission_prompt` for one without a key of its own (persistent
    storage, XR).
  - During the user's hold the prompt is theirs.
  - The camera, microphone, screen or speakers' prompt is cancelled while
    the agent drives, and is the user's during the hold.
  - On evidence of danger in the page, every prompt is cancelled without
    asking the user, held or not, and nothing is stored for the site.
  - When zenius cancels one, the agent gets `Zenius.refused`
    `{kind: "promptDenied", message, url}`, whose message says why. A site
    that can't have the location usually takes a typed place.

### Remote tasks: the sidebar (zen-observe)

Another of the user's agents can send the sidebar's agent a task
(`docs/briefs/remote-tasks.md`): a caller on the user's machine passes
each request on through these methods. A remote task is a Work task in
a new chat. It shows in the directory like any task, and its card names its
source. It starts at once.

| Method | Params | Result |
|---|---|---|
| `sidebar.start` | `{text, source: {address, label?}, requestId?, harness?}` | `{taskId, state}` |
| `sidebar.send` | `{taskId, text}` | `{taskId, state}` |
| `sidebar.status` | `{taskId}` | the task's status (below) |
| `sidebar.list` | `{}` | `{tasks}`: each remote task's status, without `answer`, newest first |
| `sidebar.stop` | `{taskId}` | `{taskId, state}` |

- `text`: the task or a follow-up. It's at most 8192 bytes of UTF-8 and
  not blank.
- `source.address`: who asked, which is an hc address such as `lab/t5`.
  It's 1 to 64 characters of
  `A-Z a-z 0-9 . _ : @ / -`. `source.label`: once trimmed, at most 80
  characters of ASCII `A-Z a-z 0-9`, space and `- _ . / : @ #`; empty means
  no label. The agent's rules quote both
  values as JSON strings, so neither can close its quotes.
- `requestId`: the request's id, at most 64 characters of
  `A-Z a-z 0-9 . _ -`. A start with a `requestId` that a remote task
  already has returns that task, with no new chat and no limit check, so
  the caller can retry safely.
- `harness`: an agent in the sidebar's config.json that may run. By
  default it follows the sidebar's order: the user's last pick, then
  config.json's default, then Claude Code.
- `taskId`: the task's id in the directory (its uid).

A task's status is `{taskId, requestId?, state, source, title, harness,
turn, answer?, answerTruncated?, needs?, error?, stopReason?, startedAt,
updatedAt, endsAt, endedAt?}`, with times in ms since the epoch.
- `state`:
  - `running`: a turn is under way.
  - `idle`: the turn ended with an answer. The answer may end with a
    question for the caller.
  - `needs_user`: the user has to act. `needs` is `{reason, message,
    kind}`.
    - `reason` comes from the agent's hand-off: `sign_in`,
      `irreversible`, `human_check` or `other`.
    - `kind` says what holds the task: `handoff` (the agent handed the tab
      over), `takeover` (the user took it), `wait` (the agent waits for
      the user to resume it), `permission`, or `zenius` (zenius can't hand
      this page over).
  - `stopped`: final. `stopReason` is one of:
    - `caller`: `sidebar.stop`;
    - `user`: the user pressed Stop or archived the task, or it was taken
      off the sidebar's list;
    - `limit`: the 60-minute limit;
    - `zen_quit`: Zen quit during a turn;
    - `off`: the user turned remote tasks off.
  - `failed`: final. The turn ended with an error, given as
    `error: {code, message}`.
- `turn`: how many turns have finished, counting from 0.
- `answer`: the agent's text at the end of the latest finished turn, at
  most 32 KB. Beyond that it's cut, with `answerTruncated: true`. Only the
  agent's text goes back: no page, tool result or file.
- `endsAt`: when the 60-minute limit stops the task. `endedAt`: when it
  stopped or failed.

`sidebar.send` starts a turn only when none is running and the task hasn't
ended. That means `idle`, or `needs_user` once the agent's turn is over.
While a turn runs or waits for the user, `send` fails with
`ZEN_REMOTE_TASK_BUSY`. `sidebar.stop` stops the running turn, and changes
nothing on a task that has already ended.

Limits, which are zenius's and not the user's to set:
- At most 2 remote tasks are `running` at once. A `start`, or a `send` that
  would make a third run, fails with `ZEN_REMOTE_LIMIT` `{limit:
  "running"}`.
- At most 20 starts in any 60 minutes. The 21st fails with
  `ZEN_REMOTE_LIMIT` `{limit: "hourly", retryAfterMs}`.
- A task stops 60 minutes after it started.
- When both limits apply, `start` reports the hourly one, since its
  `retryAfterMs` is a wait the caller can keep.
- When a limit refuses a request, the caller keeps it and tries again:
  once `retryAfterMs` has passed for the hourly limit, or once a running
  task has ended.

An ended task stays in `list` and `status` for at least 24 hours, archived
or not. Unarchive leaves it stopped: `send` still fails with
`ZEN_REMOTE_TASK_ENDED`. A task taken off the sidebar's list reads
`stopped`/`user` until Zen quits, and `ZEN_REMOTE_TASK_NOT_FOUND` after
that.

`zenius.agentSidebar.allowRemoteTasks` defaults to true, and about:config
lists it. Setting it to false turns remote tasks off:
- `start` and `send` fail with `ZEN_REMOTE_OFF`;
- active remote tasks stop, with `stopReason: "off"`;
- `status`, `list` and `stop` still answer.

For tests, prefs can lower the limits but never raise them:
`zenius.agentSidebar.remote.maxRunning`, `.maxPerHour` and
`.maxTaskSeconds`. `.windowSeconds`, the span the hourly limit counts, is
read only where `zenius.dev` is true.

A remote task's agent is told that its messages come from another of the
user's agents (the source), not from the user. Steps that can't be undone
stop as `needs_user` with `reason: "irreversible"`, for the user to take
through Take over: paying, sending a message or post as the user, deleting,
and changing account or security settings. Everything else, the agent does
on its own.

The Zen log names each call with its time and outcome, never its params.
These methods name no space, so the control gate never meets them. A remote
task's agent can't reach them: its MCP tools don't, and it has no shell.

### Dev only (zen-core)

Registered only when pref `zenius.dev` is true (dev profiles); a daily
profile doesn't have them.

A result of `dev.evalChrome` or `dev.evalContent` carries at most 1000 items
in each array, Set, Map, typed array or object. One with more fails the call
(`ZEN_INTERNAL`, naming where, such as `result.log`) rather than coming back
cut: return it in parts.

| Method | Params | Result |
|---|---|---|
| `dev.evalChrome` | `{code, arg?}` | value of `code` run as chrome JS in the parent (expression, or function body if it isn't one; promises awaited) |
| `dev.evalContent` | `{space, page, code, arg?, privileged?, timeout?}` | value of `code` run in the page's world, or as chrome JS in its content process with `privileged: true` |
| `dev.stats` | none | `{[method]: {n, p50, p95, max}}` over recent calls |
| `dev.viewState` | none | each window's selected tab, active workspace and focused element, for I1 checks |
| `dev.registry` | none | `[{method, module, access, accessDeclared, i5, i5Declared}]`, sorted by method: each method's access level and I5 class, and whether its module declared them |
| `dev.answerClaim` | `{space?, allow?, timeout?}` | `{id, space, verdict}`: answers the claim prompt for `space` (any, without it) as the user would, `allow` default true, waiting up to `timeout` ms (15000) for the ask; `{verdict: null}` when the claim needed none. Send it alongside the `spaces.claim`. |

### Events (zen-core)

| Method | Params | Result |
|---|---|---|
| `events.subscribe` | `{space?, page?, names?: [..]}` | `{ok}`, then event frames on this connection for every event matching one of its filters |

zen-core's events: `spaceCreated {space, name, createdBy, ownership,
profileId, source?}`, `spaceChanged {space, …}` with only the keys that changed
(`ownership, reason, source`, plus, as a hold begins, `reloaded: "reload" |
"get"` when the page the user holds loaded afresh, `carried: true` when
a field came back filled, `secret: true` when the agent's hand-off said
the step will show a secret, and `evidence: {label: {reason: detail}}`, for
each page the hold loaded afresh, the evidence it had (zen-observe's
reasons: `hooked`, `made`, `listed`, `flagged`); or `paused`, or
`stateText`, or `name`),
`spaceFinished {space, closedSpace}`, `pageClosed {space, page, tab}`,
`popup {space, page, tab, opener}`.

### Self-check (zen-core)

The post-install self-check (`docs/research/selfcheck.md`) has a socket of its
own: `~/.zenius/selfcheck/<instance>.sock`, mode 0600 in a 0700 folder, which
the runtime opens at idle after the agents' socket. It takes the same frames
and sends the same hello, and it serves one method. Anything else there gets
`ZEN_UNSUPPORTED`, `dev.*` included. The agents' socket doesn't have the
method, and the sandboxed CLI can't reach this socket
(`docs/research/method-boundary.md`, finding 12).

| Method | Params | Result |
|---|---|---|
| `selfcheck.run` | none (`{}`) | `{ok, timedOut, callerLeft, ms, waitedMs, window, dir, runtimeVersion, commit, zenVersion, error, checks: [{id, title, ok, failedStep, error, shots}]}`, once the run has ended and cleaned up; `window` is the mode its window opened in: `invisible` on a Mac's display (`corner` if its see-through step failed, and the log says why), `offscreen` on another display, `floating` on a headless Zen, unless a dev Zen's test chose another (`docs/research/selfcheck.md`, "The window") |

- One run goes at a time. The call answers when the run ends, within its
  120 s limit plus 10 s, after any wait.
- While Zen is the app in front, the run waits before its window opens, for
  up to 60 s: a window opened then would take Zen's focus from the user's
  window for a moment. It opens once Zen is in the background, right after a
  check that it is. Meanwhile the call is held (as in "Held calls" above): a
  request with `"progress": true` gets `{id, held: true, reason:
  "zen-in-front"}`, then `{id, held: false}` when the wait ends. The run's
  limit starts after it. `waitedMs` is how long it waited (0 if it didn't).
  If Zen stays in front for the whole wait, nothing opens or runs, and
  `error` says Zen stayed in front. A headless Zen has no front app, so
  there a run doesn't wait.
- Only the connection that started a run can stop it, by closing. The result
  then has `callerLeft: true`.
- `dir` is the run's folder, `~/.zenius/selfcheck/<instance>/<time>/`. It
  holds `summary.json` (the result without `dir`) and a PNG per step. At each
  start, retention there keeps the runs of the last 7 days, at most the 10
  newest.
- `commit` is `""` on a profile that `install.sh` didn't fill. The top-level
  `error` is a failure outside the checks, such as a window that didn't open,
  and null otherwise.

## Errors

`error.code` takes one of the values below. They mirror Ego's codes one for
one, with `ZEN_` in place of `EGO_`, so ported tests can map them
mechanically.

```text
ZEN_INVALID_ARGUMENT        ZEN_UNSUPPORTED             ZEN_INTERNAL
ZEN_BROWSER_UNAVAILABLE     ZEN_TASK_SPACE_NOT_FOUND    ZEN_TASK_SPACE_NOT_SELECTED
ZEN_TASK_SPACE_INACTIVE     ZEN_TASK_SPACE_UNAVAILABLE  ZEN_TASK_SPACE_USER_IN_CONTROL  (data.reason)
ZEN_TASK_SPACE_NAME_IN_USE
ZEN_PROFILE_NOT_FOUND       ZEN_PAGE_NOT_FOUND          ZEN_PAGE_BUDGET_REACHED
ZEN_PAGE_UNRESPONSIVE       ZEN_PAGE_EVALUATION_TIMED_OUT (data.executionStopped, data.mayHaveLateEffects)
ZEN_NAVIGATION_FAILED       ZEN_TIMEOUT                 ZEN_SNAPSHOT_FAILED
ZEN_REF_STALE               ZEN_REF_NOT_FOUND           ZEN_SELECTOR_NOT_FOUND
ZEN_SELECTOR_AMBIGUOUS      ZEN_NOT_ACTIONABLE (data.reason: hidden|disabled|covered|detached)
ZEN_DIALOG_NOT_FOUND        ZEN_DOWNLOAD_FAILED
```

- `ZEN_NAVIGATION_TIMEOUT` (zen-observe): `page.goto` timed out; `data`: `committed`, `stopped`, `url`, `readyState`, `waitUntil`, `timeoutMs`.
- `ZEN_PAGE_DIALOG_OPENED` (zen-observe): a JavaScript dialog is open, or opened during the call; `data.dialog`, `data.method`.
- `ZEN_URL_OPENED_IN_POPUP` (zen-observe): `page.waitForURL`'s URL opened in a popup of the page; `data.popup`, `data.popupUrl`.
- `ZEN_EVALUATION_FAILED` (zen-observe, plain): page code threw, or returned an Error.
- `ZEN_FETCH_FAILED` (zen-observe, plain): `page.fetch` failed or timed out.
- `ZEN_URL_NOT_ALLOWED` (zen-observe, I5): `page.goto` or `page.reload` of a URL agents may not load (anything but `http:`, `https:`, `data:`, `blob:` and `about:blank`); `data.url`, `data.scheme`.
- `ZEN_PAGE_NOT_WEB_CONTENT` (zen-observe, I5): the method would act in or read a document that isn't web content (a browser, local, add-on or error page, or one outside a web content process); `data.url` (what `page.url` reports), `data.page`, `data.method`; for a frame, `data.frame: true` and the frame's URL, except from `page.screenshot`, whose refusal for an add-on's or the browser's frame has no `data.url`.
- `ZEN_PAGE_NOT_WEB_CONTENT` (zen-input, I5): raw input, or the point of a click, hover or drag, would land in a frame of the page that isn't web content; `data.url` is that frame's document, `data.method`, `data.frame: true`. For an add-on's frame there's no `data.url`, and the message says "an add-on's frame": its URL's host is the add-on's id in this profile.
- `ZEN_HANDOFF_REFUSED` (zen-core): `spaces.handOff` can't make the page safe for the user's typing (`data.page`, `data.reason`: `agentPage`, `discardFailed`, `reloadFailed` or `reachable`; "The hand-off" above).
- `ZEN_AGENT_CODE_REFUSED` (zen-observe and zen-input, closed groups): the page shares a window group with a window outside the task, which the agent's code there could reach, so zenius runs none of it. zen-observe's methods that run the agent's code, and its `page.goto` to another site (whose code could reach it), and zen-input's `page.keyboard.paste` with `html` (paste the text alone instead). `data`: `method`, `page`, `reason` (`"group"`), `windows`.
- `ZEN_PAGE_GLOBAL_HIDDEN` (zen-observe): the agent's code read a page global its isolated world can't see; `data`: `method`, `page`, `name`.
- `ZEN_PAGE_CODE_OFF` (zen-observe): the user's setting for agents' page code is `never` (`zenius.agentTabs.pageCode`), so the agent's code doesn't run, and its own `data:` or `blob:` page doesn't load; `data`: `method`, `page`, `setting`.
- `ZEN_PAGE_CODE_ASKED` (zen-observe): the setting is `ask` and the user hasn't allowed page code on the page's site. `data`: `method`, `page`, `setting`, `site` (`null` for a page with no site to allow), `asked` (this call showed the user the card), and `declined: true` once the user said "Not now" for this task, after which the agent shouldn't ask or hand off for it again.
- `ZEN_PAGE_GROUP_SHARED` (zen-core): `pages.release` of a page that shares a browsing context group with other pages of the task; `data.pages` lists them. The message offers `group: true` or closing them first, and the hand-off for the user's input mid-task, in the SDK's calls (`task.release(label, { group: true })`, `task.handOff()`).
- `ZEN_TASK_SPACE_CLAIM_DENIED` (zen-core): the user said no to an agent's `spaces.claim` in the browser (`data.verdict: "deny"`), or nobody answered by its deadline (`"timeout"`); `data.space`.
- `ZEN_FILE_CHOOSER_OPENED` (zen-input): the action opened a file chooser nobody waited for; it was cancelled before any dialog showed.
- `ZEN_FILE_CHOOSER_TIMEOUT` (zen-input): `page.waitForFileChooser` timed out.
- `ZEN_TIMEOUT` (zen-input): an action or a `page.mouse` call waited out its timeout for another tab of its process; `data.reason` is `"user_composing"` (the user is composing text there, which a press would commit), `"mouse_held_elsewhere"` (a press held there would take the event) or `"user_scrolling"` (the user is scrolling there, and the process's wheel transaction would send the wheel to their page), and `data.timeoutMs` is the timeout.
- `ZEN_PAGE_UNRESPONSIVE` (zen-input): an action, or raw `page.mouse` or `page.keyboard` input, hasn't come back from the page 5 s past its deadline; `data.reason: "input_stuck"`, `data.prompt` (a browser prompt is open in the tab, which the agent can't see or answer), `data.mayHaveLateEffects: true`.
- `ZEN_PATH_NOT_ALLOWED` (zen-sdk, the sandboxed CLI): raised in the CLI before any request, never by the runtime. A script's screenshot, download or fetch `saveAs` would write outside its run's output folder and temporary folder, or an upload would read a file outside its working folder, its runs' output folders and its temporary folder, a link to one included; `data.path`, and `data.realPath` for a link.
- `ZEN_REMOTE_OFF` (zen-observe): the user turned remote tasks off (`data.pref`: `zenius.agentSidebar.allowRemoteTasks`).
- `ZEN_REMOTE_LIMIT` (zen-observe): a remote-task limit; `data.limit` is `running` or `hourly`, `data.max`, and `data.retryAfterMs` for `hourly`.
- `ZEN_REMOTE_TASK_NOT_FOUND` (zen-observe): no remote task has that `taskId` (`data.taskId`).
- `ZEN_REMOTE_TASK_BUSY` (zen-observe): `sidebar.send` while the task's turn runs or waits for the user (`data.state`).
- `ZEN_REMOTE_TASK_ENDED` (zen-observe): `sidebar.send` to a stopped or failed task (`data.state`, `data.stopReason`).
- `ZEN_SIDEBAR_UNAVAILABLE` (zen-observe): the sidebar can't run a remote task; `data.reason` is `no_sidebar`, `no_agents` or `agent_unavailable` (with `data.harness`).
- `ZEN_SELFCHECK_BUSY` (zen-core): `selfcheck.run` while a run is going; one runs at a time.
- `ZEN_SELFCHECK_UNAVAILABLE` (zen-core): this profile's agent sidebar has no self-check, or the instance's name isn't a plain one.

`ZEN_TASK_SPACE_USER_IN_CONTROL` uses Ego's reason keys in `data.reason`:
`manual_takeover` (the user's Take over), and from a task's pages
`storage_access`, `local_network_access`, `location`, `notifications`,
`midi`, `serial` and `permission_prompt` (a passkey request, persistent
storage or XR). On evidence of danger, the parent cancels every prompt
before it shows (`promptDenied`; see zen-ux's "Permission prompts in a
task's pages").
