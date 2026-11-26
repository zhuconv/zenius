# Parity: Ego Lite API → zenius

Each public method and property of Ego Lite 0.6.3.17 (`public-api-schema.ts`, skill guide v2.2.1),
the ported e2e cases that call it (`tests/e2e/cases/`), and how those cases fare. A status counts only
cases that rubric A counts for zenius (`tests/e2e/manifest.mjs`); a case exercises many methods, so a
failing case marks every method it calls. Regenerate with
`node tests/e2e/parity.mjs --ego docs/eval/baseline-ego-0.6.3.17.json [--zenius <json>] --out docs/PARITY.md`.

While zenius's methods are still landing, a case fails at its first missing method, so the zenius column mostly shows which cases are blocked. `docs/eval/e2e-zenius.md` ranks the missing methods by the cases each one blocks.

| API | Cases that call it | Ego | zenius | Divergence |
|---|---|---|---|---|
| `profiles` | TaskSpace profile selection | pass (1/1) | pass (1/1) |  |
| `listTaskSpaces` | task spaces and control; TaskSpace profile selection; zen-eval: v2 control lifecycle | pass (2/2) | pass (2/2) | A user workspace no agent has claimed lists an empty recentTabTitles, and keeps its name. Tasks and claimed workspaces, current or ended, keep their titles; Ego lists them for every space. In the daily browser those titles are the user's private tabs (mail, bank, health), which would otherwise reach the model provider. |
| `taskSpace` | task spaces and control; TaskSpace profile selection; v2 cross-space routing; page labels: create; +73 more | 55 pass, 10 flaky, 3 fail of 68 | pass (71/71) |  |
| `claimTaskSpace` | task spaces and control; zen-eval: v2 control lifecycle | pass (1/1) | pass (1/1) | A claim of one of the user's Spaces, or of an ended task, waits up to 10 minutes for the user's Allow in the browser; Deny or no answer fails it with ZEN_TASK_SPACE_CLAIM_DENIED. A claim of the agent's own task asks no one. Ego shows no prompt and relies on the agent asking in chat. |
| `takeOverTaskSpace` | task spaces and control; zen-eval: v2 control lifecycle | pass (1/1) | pass (1/1) | Fails with ZEN_TASK_SPACE_USER_IN_CONTROL until 10 s after the user's last real input in the task's tabs, so an agent can't take a task back while the user types. Ego takes it back at once. Like the user's Resume agent, it first empties the password, card and code fields the user typed in, loading those pages afresh (The hand-off and the hold, below). |
| `TaskSpace.spaceId` | task spaces and control; TaskSpace profile selection; page labels: create; page actions and popup adoption; +4 more | 6 pass, 1 fail of 7 | pass (7/7) |  |
| `TaskSpace.name` | environment initialization; task spaces and control; TaskSpace profile selection; observation helpers; +7 more | 3 pass, 1 flaky, 1 fail of 5 | pass (6/6) |  |
| `TaskSpace.ownership` | task spaces and control; zen-eval: v2 control lifecycle | pass (1/1) | pass (1/1) |  |
| `TaskSpace.page` | task spaces and control; TaskSpace profile selection; v2 cross-space routing; page labels: restore and reuse; +18 more | 15 pass, 3 flaky, 1 fail of 19 | pass (20/20) |  |
| `TaskSpace.userPage` | task spaces and control; zen-eval: v2 control lifecycle | pass (1/1) | pass (1/1) |  |
| `TaskSpace.pages` | page labels: create | pass (1/1) | pass (1/1) |  |
| `TaskSpace.tabs` | task spaces and control; TaskSpace profile selection; page labels: create; page labels: close and do not reuse; +4 more | 6 pass, 1 fail of 7 | pass (7/7) | Doesn't re-adopt an untracked tab by its opener. zenius registers popups as their tabs open, so none is missed, and adopting by opener alone could claim a tab the user opened from an agent page, which finish() would then close. |
| `TaskSpace.newPage` | task spaces and control; page labels: create; page labels: close and do not reuse; page labels: persist before hard stop; +60 more | 43 pass, 9 flaky, 3 fail of 55 | pass (58/58) |  |
| `TaskSpace.adopt` | page adoption and release; zen-eval: v2 control lifecycle | pass (2/2) | pass (2/2) |  |
| `TaskSpace.release` | page adoption and release | pass (1/1) | pass (1/1) |  |
| `TaskSpace.waitForControl` | task spaces and control; zen-eval: v2 control lifecycle | pass (1/1) | pass (1/1) | The first waitForControl or takeOver after the user's hold reports, once, in task.handBack: reloaded lists the Pages zenius loaded afresh since the agent last had control, so the agent looks at them again; rarely, openerCut says the page the user held lost its opener, so a sign-in popup's report never reached the agent's Page. Ego reports nothing on hand back (The hand-off and the hold, below). |
| `TaskSpace.handOff` | task spaces and control; zen-eval: v2 control lifecycle | pass (1/1) | pass (1/1) | Before the user's card shows, zenius loads afresh the page the user will hold, and any window that could reach it, wherever the agent's code may be, so nothing of the agent's sees what the user types. It refuses a page the agent made, or one it can't make safe, with ZEN_HANDOFF_REFUSED. Ego gives the tab over as it is (The hand-off and the hold, below). |
| `TaskSpace.finish` | task spaces and control; TaskSpace profile selection; v2 cross-space routing; Concurrent TaskSpace downloads; +1 more | pass (4/4) | pass (4/4) |  |
| `TaskSpace.cdp` | page basic operations; Page JavaScript dialog handling; Page snapshot iframe viewport; Page OOPIF actions; +6 more | 6 pass, 1 flaky, 1 fail of 8 | pass (8/8) | Not supported: fails with ZEN_UNSUPPORTED and points at the documented methods (SPEC §2: no CDP emulation). |
| `Page.label` | task spaces and control; TaskSpace profile selection; page labels: create; page labels: restore and reuse; +26 more | 22 pass, 5 flaky, 2 fail of 29 | pass (29/29) |  |
| `Page.spaceId` | task spaces and control; TaskSpace profile selection; page labels: create; page actions and popup adoption; +4 more | 6 pass, 1 fail of 7 | pass (7/7) |  |
| `Page.openedBy` | task spaces and control; TaskSpace profile selection; page labels: create; page adoption and release; +1 more | 3 pass, 1 fail of 4 | pass (4/4) |  |
| `Page.targetId` | environment initialization; TaskSpace profile selection; navigation helpers; target-scoped event isolation; +19 more | 15 pass, 3 flaky, 2 fail of 20 | pass (20/20) | An opaque zenius tab id, not a CDP target id. |
| `Page.goto` | task spaces and control; TaskSpace profile selection; v2 cross-space routing; page labels: create; +66 more | 49 pass, 9 flaky, 3 fail of 61 | pass (64/64) |  |
| `Page.reload` | Page load states; Page API alignment | 1 pass, 1 flaky of 2 | pass (2/2) |  |
| `Page.snapshot` | page labels: create; page labels: restore and reuse; page labels: close and do not reuse; page labels: restore after hard stop; +28 more | 26 pass, 3 flaky, 1 fail of 30 | pass (31/31) | A ref'd button, ARIA link or href-less anchor that would print with no name takes its accessible name (hidden text, else its title), as in pdf.js's toolbar: button "Download". Ego prints those nameless. Links with href keep Ego's form. |
| `Page.screenshot` | page basic operations; Page drag and canvas drawing; Page JavaScript dialog handling; Page media playback; +5 more | 7 pass, 1 flaky, 1 fail of 9 | pass (9/9) |  |
| `Page.url` | page basic operations; page actions and popup adoption; Page action popup receipts; Page JavaScript dialog handling; +8 more | 5 pass, 3 flaky, 2 fail of 10 | pass (11/11) |  |
| `Page.waitForURL` | Page refs across rounds: resume; Page popup waiter and URL diagnostic; Page load states; zen-eval: pdf.js viewer download | 2 pass, 1 flaky of 3 | pass (4/4) |  |
| `Page.waitForEvent` | Page popup waiter and URL diagnostic; Page download lifecycle; Concurrent TaskSpace downloads; Concurrent Page downloads: slow response; +4 more | 3 pass, 3 flaky of 6 | pass (7/7) |  |
| `Download.page` | task spaces and control; TaskSpace profile selection; v2 cross-space routing; page labels: restore and reuse; +18 more | 15 pass, 3 flaky, 1 fail of 19 | pass (20/20) |  |
| `Download.url` | page basic operations; page actions and popup adoption; Page action popup receipts; Page JavaScript dialog handling; +8 more | 5 pass, 3 flaky, 2 fail of 10 | pass (11/11) |  |
| `Download.suggestedFilename` | Page download lifecycle; Concurrent TaskSpace downloads; Concurrent Page downloads: slow response; Page Chromium PDF viewer download; +2 more | 3 pass, 1 flaky of 4 | pass (5/5) |  |
| `Download.saveAs` | Page download lifecycle; Concurrent TaskSpace downloads; Page Chromium PDF viewer download; Page download across rounds: prepare; +2 more | 2 pass, 2 flaky of 4 | pass (5/5) |  |
| `Download.path` | Page download lifecycle; Concurrent TaskSpace downloads; Concurrent Page downloads: slow response | pass (3/3) | pass (3/3) |  |
| `Download.failure` | Page download lifecycle; Concurrent TaskSpace downloads; Page Chromium PDF viewer download; zen-eval: pdf.js viewer download | pass (2/2) | pass (3/3) |  |
| `Download.cancel` | none | no counted case | no counted case |  |
| `Download.delete` | Page download lifecycle; Concurrent TaskSpace downloads; Concurrent Page downloads: slow response; Page Chromium PDF viewer download; +3 more | 3 pass, 2 flaky of 5 | pass (6/6) |  |
| `Page.waitForTimeout` | page basic operations; Page JavaScript dialog handling; Page refs across rounds: resume; Page Chromium PDF viewer download; +5 more | 3 pass, 1 flaky, 1 fail of 5 | pass (7/7) |  |
| `Page.title` | TaskSpace profile selection; page basic operations | 1 pass, 1 fail of 2 | pass (2/2) |  |
| `Page.info` | v2 cross-space routing; page basic operations | 1 pass, 1 fail of 2 | pass (2/2) |  |
| `Page.acceptDialog` | Page JavaScript dialog handling | 1 flaky of 1 | pass (1/1) |  |
| `Page.dismissDialog` | Page JavaScript dialog handling | 1 flaky of 1 | pass (1/1) |  |
| `Page.evaluate` | page labels: restore and reuse; page basic operations; page complex evaluate; page fetch; +51 more | 37 pass, 10 flaky, 3 fail of 50 | pass (52/52) |  |
| `Page.waitForFunction` | page basic operations; page actions and popup adoption; Page action popup receipts; Page JavaScript dialog handling; +4 more | 3 pass, 3 flaky, 2 fail of 8 | pass (8/8) |  |
| `Page.fetch` | page labels: restore and reuse; page fetch | pass (2/2) | pass (2/2) |  |
| `Page.cdp` | page basic operations; Page JavaScript dialog handling; Page snapshot iframe viewport; Page OOPIF actions; +6 more | 6 pass, 1 flaky, 1 fail of 8 | pass (8/8) | Not supported: fails with ZEN_UNSUPPORTED and points at the documented methods (SPEC §2: no CDP emulation). |
| `Page.waitForSelector` | page basic operations; Page action idle fail-fast; Page media playback; Page snapshot locator quality; +10 more | 9 pass, 2 flaky, 1 fail of 12 | pass (13/13) |  |
| `Page.waitForLoadState` | page basic operations; Page action idle fail-fast; Page load states; Page API alignment | 1 pass, 2 flaky, 1 fail of 4 | pass (4/4) |  |
| `Page.events` | page basic operations; Page JavaScript dialog handling; Page load states; Page automation hooks; +1 more | 1 pass, 1 flaky, 1 fail of 3 | pass (4/4) |  |
| `Page.click` | page labels: restore and reuse; page basic operations; page actions and popup adoption; Page action popup receipts; +36 more | 25 pass, 9 flaky, 2 fail of 36 | pass (38/38) | The input of a file chooser nobody waits for hears cancel, and at an open dialog the click fails at once, where Ego's waits (Input, below). |
| `Page.dblclick` | page actions and popup adoption | 1 fail of 1 | pass (1/1) |  |
| `Page.hover` | page actions and popup adoption; Page refs after failed actions: resume; Page actionability | 2 pass, 1 fail of 3 | pass (3/3) |  |
| `Page.dragAndDrop` | page actions and popup adoption; Page drag and canvas drawing; Page actionability | 2 pass, 1 fail of 3 | pass (3/3) |  |
| `Page.fill` | page basic operations; page actions and popup adoption; Page action popup receipts; Page click hit target; +12 more | 10 pass, 2 flaky, 2 fail of 14 | pass (15/15) |  |
| `Page.selectOption` | page labels: restore and reuse; Page action popup receipts; Page refs across rounds: resume; Page API alignment; +1 more | 3 pass, 2 flaky of 5 | pass (5/5) | Fires trusted input and change events, as a user's choice does. Ego's are untrusted (Input, below). |
| `Page.focus` | keyboard and file helpers; page basic operations; Page refs after failed actions: resume; v1 and v2 action parity; +2 more | 2 pass, 2 fail of 4 | pass (4/4) |  |
| `Page.press` | page basic operations; Page refs across rounds: resume; Page refs after upload: resume; Page API alignment; +4 more | 3 pass, 1 flaky, 2 fail of 6 | pass (7/7) |  |
| `Page.setInputFiles` | page basic operations; zen-eval: v2 checks from N/A cases | 1 fail of 1 | pass (2/2) | An empty list clears the input, as in Playwright. Ego keeps the file it had (Input, below). |
| `Page.waitForFileChooser` | page basic operations; Page JavaScript dialog handling; Page refs after upload: prepare | 1 pass, 1 flaky, 1 fail of 3 | pass (3/3) |  |
| `FileChooser.isMultiple` | page basic operations | 1 fail of 1 | pass (1/1) |  |
| `FileChooser.setFiles` | page basic operations; Page JavaScript dialog handling; Page refs after upload: prepare | 1 pass, 1 flaky, 1 fail of 3 | pass (3/3) |  |
| `Page.close` | task spaces and control; page labels: close and do not reuse; page labels: restore after hard stop; page inventory and budget; +60 more | 43 pass, 9 flaky, 3 fail of 55 | pass (58/58) |  |
| `Page.mouse.click` | page actions and popup adoption; Page click hit target; visual workflow | 2 pass, 1 fail of 3 | pass (3/3) |  |
| `Page.mouse.move` | page actions and popup adoption; Page drag and canvas drawing; visual workflow | 2 pass, 1 fail of 3 | pass (3/3) | The pointer's position and held buttons belong to the page, shared by all its handles. Ego keeps them per handle (Input, below). |
| `Page.mouse.down` | page actions and popup adoption; Page drag and canvas drawing | 1 pass, 1 fail of 2 | pass (2/2) |  |
| `Page.mouse.up` | page actions and popup adoption; Page drag and canvas drawing | 1 pass, 1 fail of 2 | pass (2/2) |  |
| `Page.mouse.wheel` | page actions and popup adoption | 1 fail of 1 | pass (1/1) |  |
| `Page.keyboard.down` | page actions and popup adoption; Page keyboard interface | 2 fail of 2 | pass (2/2) | Held keys belong to the page, shared by all its handles. Ego keeps them per handle (Input, below). |
| `Page.keyboard.up` | page actions and popup adoption; Page keyboard interface | 2 fail of 2 | pass (2/2) |  |
| `Page.keyboard.press` | page basic operations; Page API alignment; v1 and v2 action parity; portable keyboard workflow; +1 more | 1 pass, 1 flaky, 2 fail of 4 | pass (4/4) | Cmd/Ctrl+C, X and V go to the Space's private clipboard, not the system clipboard (see keyboard.paste). |
| `Page.keyboard.type` | page basic operations; page actions and popup adoption; Page refs after failed actions: resume; Page keyboard interface | 1 pass, 3 fail of 4 | pass (4/4) |  |
| `Page.keyboard.insertText` | page actions and popup adoption; Page keyboard interface | 2 fail of 2 | pass (2/2) |  |
| `Page.keyboard.paste` | Page keyboard interface | 1 fail of 1 | pass (1/1) | Agent tabs get a private per-Space clipboard: agent copy, cut and paste never read or overwrite the user's system clipboard. Copy-then-paste inside a task still works. |

## Deliberate divergences

- **Clipboard.** Agent tabs get a private per-Space clipboard, so an agent's Cmd/Ctrl+C, X and V never
  read or overwrite the user's system clipboard. Ego's `keyboard.paste()` sends the native shortcut and
  restores the user's clipboard afterwards; zenius never touches it. Copy-then-paste inside one task
  still works, as in Ego's portable keyboard workflow case.
- **The page's clipboard API.** In an agent tab, `navigator.clipboard.readText()` and `read()` answer from
  the Space's own clipboard, with no prompt, but only to the origin that wrote its current contents.
  Another origin gets `NotAllowedError`, as after a dismissed paste prompt, and the agent gets
  `Zenius.refused` with `kind: "clipboardRead"`, naming the writer, also in the receipt of the click that
  caused the read. Ego hands the Space to the user with reason `"clipboard"` instead, because its read would
  reach the user's real clipboard. zenius's per-Space clipboard needs no permission, and the
  origin rule keeps one site in a task from reading what the agent copied on another. The agent's own
  Cmd/Ctrl+V still pastes anywhere. Writes go to the Space's clipboard too: in the headed run on the Mac
  (2026-11-20), the system pasteboard's change count didn't move.
- **Service workers and Cache Storage.** In an agent task's pages, their popups and the workers they start,
  `navigator.serviceWorker.register()` and Cache's `put`, `add` and `addAll` reject with `SecurityError`.
  The agent gets `Zenius.refused` with `kind: "serviceWorker"` or `"cacheStorage"` in
  `page.events()`, once per document and once per worker. A registration outlives the task and would
  control the user's own tabs on that site, and what a task writes to Cache Storage would reach them
  likewise. Reading Cache Storage still works, and the user's own tabs on the site are unaffected: they
  register and cache as usual.
  - The site's own service worker, registered from the user's tabs, runs for them, outside the task. A
    task's pages and the workers they start don't use it. Their requests skip it, a
    shared worker's only until the site's worker claims it (a known residual), and
    to them the site has none: `getRegistration()` resolves undefined, `getRegistrations()` an empty list,
    `ready` never settles, `controller` is null, and a ServiceWorker's `postMessage` does nothing.
  - The first such access is reported apart from a refused registration: a second `serviceWorker`
    refusal, once per document and once per worker, whose message names the call ("The page tried to
    reach the site's service worker (getRegistrations)"). So a page that tries to register a worker and
    then lists the site's has two `serviceWorker` refusals in `page.events()`, told apart by their messages.
  - Ego allows registration and Cache Storage writes. Its case "Page Service Worker startup" is a
    deliberate difference on zenius (`tests/e2e/manifest.mjs`). The case zenius adds, "zen-eval: a task's
    service worker is refused", checks both reports: the refused registration once for two `register()`
    calls, and the hidden worker once, at `getRegistrations()`.
- **Video in hidden agent tabs.** In an agent tab the user can't see, zenius pauses each playing video that holds
  the display wake lock by Gecko's rule: a video track, and an audio track or a MediaStream source, muted or not.
  It resumes them when the user looks or the tab stops being the agent's, never a video the page or the agent
  paused. The agent gets `Zenius.mediaPaused` and `Zenius.mediaResumed` (`reason: "hidden"`, `count`,
  `url`) in `page.events`. Ego's hidden task tabs keep playing. The cause is Gecko 160: the flag that keeps a
  hidden agent tab at full speed (`BrowsingContext.isActive`) also makes a playing video's wake lock a foreground
  one, so an unseen agent tab would keep the user's display awake. `<audio>`, Web Audio and other videos hold no
  lock in a muted tab, and play on.
- **The user's Allow before a claim.** A claim of one of the user's Spaces, or of an ended task, shows a
  prompt in the user's window ("An agent asks to work in your Space …", with the name the client gives
  itself) and waits up to 10 minutes for Allow. Deny or no answer fails it with
  `ZEN_TASK_SPACE_CLAIM_DENIED` (SPEC §3.4). A claim of the agent's own task asks no one.
  `takeOverTaskSpace` of a task handed to the user, and a claim of one, fail with
  `ZEN_TASK_SPACE_USER_IN_CONTROL` until 10 s after the user's last real input in its tabs. Ego shows no
  prompt and relies on the agent asking in chat. The e2e runner answers each prompt with Allow through
  `dev.answerClaim`, as the user would, and records the spaces it allowed in each case's result.
- **The hand-off and the hold.** The user types in the agent's own tab, and zenius keeps what they type from
  the agent. Before the card shows, `handOff()` loads afresh the page the user will
  hold, and any window that could reach it, wherever the agent's code may be. It refuses a page the agent
  made, or one it can't make safe, with `ZEN_HANDOFF_REFUSED`. When the user presses Resume agent, or the
  agent takes the task back, zenius first empties the password, card and code fields the user typed in,
  loading those pages afresh. The next `waitForControl` or `takeOverTaskSpace` reports, once, in
  `task.handBack`: `reloaded`, the Pages zenius loaded afresh since the agent last had control, and rarely
  `openerCut`, when the page the user held lost its opener, so a sign-in popup's report never reached the
  agent's Page. Ego gives the tab over as it is and reports nothing on hand back. This replaces Use your
  own tab, which was removed.
- **CDP.** `page.cdp()` and `task.cdp()` fail with `ZEN_UNSUPPORTED` (SPEC §2). Cases that exist to test
  CDP are N/A. Cases that use CDP only for setup or one check run on zenius with an exact-string patch
  (`tests/e2e/zen-adapt.mjs`, listed with its reason in `docs/eval/e2e-zenius.md`).
- **PDF viewer.** Zen shows PDFs in pdf.js, not Chromium's viewer, so Ego's PDF viewer download case is N/A,
  and a case zenius adds, "zen-eval: pdf.js viewer download", covers pdf.js.
- **Names of icon buttons in snapshots.** Ego names an element only from `aria-label` and
  `aria-labelledby` (Chromium's page-content label), and its viewport snapshot drops visually hidden text, so
  icon buttons such as pdf.js's toolbar print as `button [ref=19]`, Print and Download alike. zenius gives a
  ref'd button, ARIA link or href-less anchor that would print with no name its accessible name: the hidden
  text, else its title (`button "Download"`). Links with href keep Ego's form, since `url=` tells them apart.
  In the snapshot goldens only icon buttons change (MDN's "Search the site", PyPI's "Copy PIP
  instructions").
- **Icon glyphs and empty boxes in snapshots.** Ego prints the text of CSS `::before` and `::after` boxes, and
  so does zenius, except two kinds that tell an agent nothing: text made
  only of private-use characters, which icon fonts draw as icons (PyPI's U+F002, Apple's U+F301: 90 lines
  in the snapshot goldens), and boxes with no text (a clearfix's `content: ""; display: table`, which Ego
  prints as `table > table_row > table_cell`: 384 lines on Stack Overflow).
- **Popup re-adoption.** Ego's `task.tabs()` adopts again an agent popup that its Page ledger lost, such as
  one an action receipt missed. zenius registers a popup when its tab opens, not from a receipt diff, so
  none is missed. It doesn't re-adopt untracked tabs by their opener: that could claim a tab the user opened
  from an agent page, which `finish()` would then close. "page actions and popup adoption" skips its
  simulated miss on zenius.
- **Input.** zenius keeps these on purpose. Ego's side, where
  given, is from a run of the input gap probe on Ego Lite (2026-11-20).
  - `setInputFiles(sel, [])` clears the input, as Playwright does. Ego kept the file the input had.
  - A middle click on a link opens it as a new page of the task, listed in `receipt.popups`, on both. zenius
    opens it itself, in the background, and cancels the browser's own handling, so nothing opens outside the
    task and on Linux nothing is pasted from the user's PRIMARY selection. Ego's main window also came on
    screen and to the front, within a second of this click or of the dismissal of the previous case's alert;
    the samples can't tell which (`docs/eval/no-preemption.md`). zenius's I1 case for it checks that the user's
    view, the window's state and its bounds don't change, and that the only new tab is the task's.
  - A click that opens a file chooser nobody waits for fails on both, before any system dialog shows
    (`ZEN_FILE_CHOOSER_OPENED`, `EGO_FILE_CHOOSER_OPENED`). zenius's input then hears `cancel`, as when a user
    closes the dialog. Ego's heard nothing.
  - While a JavaScript dialog is open, element actions, `mouse.click` and `keyboard.press` fail at once with
    `ZEN_PAGE_DIALOG_OPENED`, and other raw input is dropped, as Ego's code drops it. On Ego the click was
    still pending after 3 s, as was each input sent after it, and the case took 45 s.
  - `selectOption`'s `input` and `change` events are trusted, as a user's choice fires them. Ego dispatches
    untrusted ones from page script.
  - The pointer's position, the held buttons and the held keys belong to the page on the script's
    connection, shared by all its handles. Ego keeps them per `Page` handle, so each `task.page(label)`
    starts at (0, 0) with nothing held.
  - An element covering the target is named as written in the error: `dialog "Sessions expired" intercepts
    pointer events`. Ego's page-side regex drops every `s` and leaves quotes unescaped.
  - `text=` leaves out the text of scripts, styles, noscripts and the page's head, as Playwright's text and
    Ego's own `:has-text()` do. Ego's `text=` reads `textContent`, so text that only a script or the title
    held matched `<body>` or `<html>`: a wait for it passed at once, and a click hit the body.
- **Legacy v1 helpers.** Ego still installs its v1 helpers (`js`, `gotoAndWait`, `click`, …), hidden from
  `help()` and absent from skill guide v2.2.1. The 12 cases that exercise them are N/A for rubric A.
