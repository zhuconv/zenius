# e2e on zenius 0.1.0 (6c1ed53)

Ego's real-browser e2e suite (83 cases, tag v2.2.1), ported to `tests/e2e` and run on zenius (zen 1.24.2b, commit 6c1ed53; SDK: zenius). 1 full run, started 2026-11-20 14:02 UTC, on the user's Mac against a headless dev instance.

```sh
node tests/e2e/runner.mjs --target zenius --instance <name>
```

## Summary

| | Cases | Pass | Flaky | Fail | N/A |
|---|---|---|---|---|---|
| All cases | 83 | 68 | 0 | 0 | 15 |
| Rubric A (not N/A on zenius) | 68 | 68 | 0 | 0 | |

Rubric A counts the cases `tests/e2e/manifest.mjs` doesn't mark N/A for zenius: it leaves out the 12 cases that exercise Ego's legacy v1 helpers (not in skill guide v2.2.1), the 2 that test CDP itself and the one that drives Chromium's PDF viewer. Flaky means the case passed in some runs and failed in others.

zen-eval's own cases (`tests/e2e/zen-cases/`), outside Ego's suite and its counts:

- **zen-eval: v2 control lifecycle**: pass, 21 assertions
- **zen-eval: pdf.js viewer download**: pass, 11 assertions

## Reading this run

All 68 rubric-A cases pass at 6c1ed53, and so do zen-eval's own two cases:
the control lifecycle, and the pdf.js viewer case. This is the regression
gate before the install candidate.
- **Same as at 3ce3e2c:** each case keeps its verdict and its assertion
  count from the last full run (991 in all), and none got twice as slow.
- **What landed in between (232 commits, 98 of them in `runtime/` or
  `sdk/src`):**
  - I5;
  - the Agents Space as the default;
  - the claim prompt;
  - the event, download and handoff caps;
  - CSS generated content in snapshots.
- **The claim prompt:** the runner answers each prompt with Allow through
  `dev.answerClaim`, as the user would (5d08803). In this run only the control
  lifecycle case asks: it claims its ended task.
- **The harness, for the Agents Space (6c1ed53):** the first run at 5188ec5
  failed four page-label cases. The cause was the harness.
  - The `openOrReuseTab` stand-in put its tab into the task's workspace,
    which made it the task's untracked tab only while each task had a
    workspace of its own.
  - In the shared Space a tab belongs to a task through its session value,
    so the stand-in now marks its tab as the task's tab of unknown origin, as
    the runtime marks a claimed workspace's tabs.
  - Cleanup then adopts and closes such tabs before `finish()`, which keeps
    them. Closing the task's last tab from outside the SDK would end the task
    and make the next call a hard stop.
- **The pdf.js case:** pdf.js renders all 60 pages, the snapshot shows its
  page counter, and a click on `#next` moves it. Its download button then
  gives the viewer Page a download whose file matches the served PDF byte
  for byte.
- **The adapt cases:** all 18 run with test-only stand-ins, ten of them also
  patched ("Adapted for zenius" below lists both). All 18 pass.

One difference is deliberate (zen-manager's decision, in PARITY): zenius
doesn't re-adopt a popup its Page ledger lost.
- zenius registers a popup when its tab opens, so none is lost.
- Adopting by opener alone could claim a tab the user opened from an agent
  page, which `finish()` would then close.
- So "page actions and popup adoption" skips its simulated miss on zenius.

How the runner treats zenius:
- It keeps Ego's configuration names (`EGO_BROWSER_*`), which the zenius SDK
  reads, so the prelude's `EGO_BROWSER_PAGE_BUDGET=3` caps Pages on both
  targets.
- It renames error codes, output markers and the default screenshot name
  (`zenius-shot-`).
- When a round fails, the runner closes the Pages its family of rounds added
  to the suite's space.
- The fixture server declares `/streamed-page`'s charset. Gecko doesn't parse
  a document with no declared charset until it has 1024 bytes or the end.

## Per case

| Case | File | Category | Zenius | Result | Time (median of passes) | Assertions |
|---|---|---|---|---|---|---|
| environment initialization | environment.mjs | v1 | na | na |  |  |
| helper surface | helper-surface.mjs | v1 | na | na |  |  |
| task spaces and control | task-space.mjs | v1 | na | na |  |  |
| TaskSpace profile selection | profile-selection.mjs | v2 | run | pass | 0.3 s | 19 |
| v2 cross-space routing | task-space.mjs | v2 | run | pass | 0.3 s | 4 |
| navigation helpers | navigation.mjs | v1 | na | na |  |  |
| observation helpers | observation.mjs | v1 | na | na |  |  |
| pointer and scroll helpers | pointer.mjs | v1 | na | na |  |  |
| keyboard and file helpers | keyboard.mjs | v1 | na | na |  |  |
| keyboard regression | keyboard-regression.mjs | v1 | na | na |  |  |
| wait, fetch, cdp, js, help | runtime.mjs | v1 | na | na |  |  |
| runtime regression | runtime-regression.mjs | v1 | na | na |  |  |
| target-scoped event isolation | event-isolation.mjs | v1 | na | na |  |  |
| page labels: create | page-labels.mjs | v2+obs | adapt | pass | 0.6 s | 13 |
| page labels: restore and reuse | page-labels.mjs | v2+obs | adapt | pass | 0.1 s | 14 |
| page labels: close and do not reuse | page-labels.mjs | v2+obs | adapt | pass | 0.2 s | 10 |
| page labels: persist before hard stop | page-labels.mjs | v2 | run | pass | 0.1 s | 1 |
| page labels: restore after hard stop | page-labels.mjs | v2 | run | pass | 0.1 s | 3 |
| page inventory and budget | page-labels.mjs | v2+obs | adapt | pass | 0.5 s | 9 |
| page adoption and release | page-labels.mjs | v2+obs | adapt | pass | 0.2 s | 19 |
| page basic operations | page-labels.mjs | v2+cdp | adapt | pass | 0.6 s | 53 |
| page complex evaluate | page-labels.mjs | v2+obs | adapt | pass | 0.3 s | 23 |
| page fetch | page-labels.mjs | v2+obs | adapt | pass | 0.3 s | 25 |
| page actions and popup adoption | page-labels.mjs | v2+ledger | adapt | pass | 1.7 s | 57 |
| Page action popup receipts | page-action-latency.mjs | v2 | run | pass | 0.5 s | 9 |
| Page action idle fail-fast | page-action-latency.mjs | v2 | run | pass | 4.0 s | 14 |
| Page click hit target | page-click-hit-target.mjs | v2 | run | pass | 2.1 s | 17 |
| Page action motion tolerance | page-action-motion.mjs | v2 | run | pass | 0.5 s | 6 |
| Page drag and canvas drawing | page-drag-and-draw.mjs | v2 | run | pass | 0.4 s | 15 |
| Page JavaScript dialog handling | page-dialogs.mjs | v2+cdp | adapt | pass | 0.5 s | 30 |
| Page media playback | page-media-playback.mjs | v2 | run | pass | 4.0 s | 17 |
| Page scrolled screenshot | page-screenshot.mjs | v2 | run | pass | 0.2 s | 13 |
| Page default screenshot path: first run | page-default-screenshot-path.mjs | v2+obs | run | pass | 0.3 s | 9 |
| Page default screenshot path: second run | page-default-screenshot-path.mjs | v2+obs | run | pass | 0.2 s | 4 |
| Page snapshot locator quality | page-snapshot-locators.mjs | v2 | run | pass | 0.2 s | 4 |
| Page snapshot iframe viewport | page-snapshot-subtree.mjs | v2+cdp | adapt | pass | 0.4 s | 13 |
| Page snapshot subtree | page-snapshot-subtree.mjs | v2 | run | pass | 0.6 s | 46 |
| Page auto-scroll past a wheel trap | page-wheel-trap.mjs | v2 | run | pass | 1.3 s | 10 |
| Page snapshot viewport overflow hint | page-snapshot-viewport-overflow.mjs | v2 | run | pass | 0.5 s | 20 |
| Page ref identity across partial snapshots | page-ref-identity.mjs | v2 | run | pass | 0.8 s | 14 |
| Page refs across rounds: prepare | page-ref-identity.mjs | v2 | run | pass | 0.1 s | 5 |
| Page refs across rounds: resume | page-ref-identity.mjs | v2 | run | pass | 4.2 s | 12 |
| Page refs in dialog workflows | page-ref-workflows.mjs | v2 | run | pass | 0.3 s | 10 |
| Page refs after failed actions: prepare | page-ref-workflows.mjs | v2 | run | pass | 0.5 s | 8 |
| Page refs after failed actions: resume | page-ref-workflows.mjs | v2 | run | pass | 0.1 s | 3 |
| Page refs after upload: prepare | page-ref-workflows.mjs | v2 | run | pass | 0.3 s | 2 |
| Page refs after upload: resume | page-ref-workflows.mjs | v2 | run | pass | 0.1 s | 3 |
| Page snapshot lazy iframe | page-snapshot-subtree.mjs | v2 | run | pass | 0.3 s | 14 |
| Page snapshot sibling iframes | page-snapshot-subtree.mjs | v2 | run | pass | 0.2 s | 14 |
| Page snapshot nested iframes | page-snapshot-subtree.mjs | v2 | run | pass | 0.2 s | 18 |
| Page snapshot replaced iframe | page-snapshot-subtree.mjs | v2 | run | pass | 0.4 s | 11 |
| Page open Shadow DOM locators | page-shadow-dom.mjs | v2 | run | pass | 0.4 s | 4 |
| Page text locators | page-text-locators.mjs | v2 | run | pass | 0.4 s | 6 |
| Page Playwright selector compatibility | page-selector-compatibility.mjs | v2 | run | pass | 2.8 s | 16 |
| Page popup waiter and URL diagnostic | page-popup-waiter.mjs | v2 | run | pass | 0.8 s | 11 |
| Page download lifecycle | page-download.mjs | v2 | run | pass | 0.4 s | 8 |
| Concurrent TaskSpace downloads | page-download.mjs | v2 | run | pass | 0.7 s | 13 |
| Concurrent Page downloads: slow response | page-download.mjs | v2 | run | pass | 1.7 s | 6 |
| Page Chromium PDF viewer download | page-download.mjs | chromium | na | na |  |  |
| Page download across rounds: prepare | page-download.mjs | v2 | run | pass | 0.3 s | 1 |
| Page download across rounds: resume | page-download.mjs | v2 | run | pass | 0.1 s | 4 |
| Page OOPIF actions | page-oopif.mjs | v2+cdp | adapt | pass | 0.8 s | 15 |
| Page OOPIF restore and close | page-oopif.mjs | v2+cdp | adapt | pass | 0.1 s | 7 |
| Page load states | page-load-states.mjs | v2+cdp | adapt | pass | 10.7 s | 50 |
| Page automation hooks | page-automation-hooks.mjs | cdp | na | na |  |  |
| Page dedicated Worker startup | page-workers.mjs | v2 | run | pass | 0.1 s | 1 |
| Page AudioWorklet startup | page-workers.mjs | v2 | run | pass | 0.2 s | 1 |
| Page SharedWorker startup | page-workers.mjs | v2 | run | pass | 0.2 s | 1 |
| Page Service Worker startup | page-workers.mjs | v2 | run | pass | 0.3 s | 1 |
| Page API alignment | page-api-alignment.mjs | v2 | run | pass | 3.6 s | 40 |
| Page actionability | page-actionability.mjs | v2 | run | pass | 2.8 s | 46 |
| Page evaluate timeout recovery | page-evaluate-timeout.mjs | v2+obs | run | pass | 13.8 s | 24 |
| Page pending navigation: same process | page-pending-navigation.mjs | v2+cdp | adapt | pass | 8.7 s | 31 |
| Page pending navigation: fresh process | page-pending-navigation.mjs | v2+obs | run | pass | 5.1 s | 6 |
| Page pending navigation: evaluate and screenshot | page-pending-navigation.mjs | v2+cdp | adapt | pass | 10.2 s | 18 |
| Page delayed popup: schedule | page-delayed-popup.mjs | v2+ledger | adapt | pass | 0.4 s | 1 |
| Page delayed popup: resume | page-delayed-popup.mjs | v2+ledger | adapt | pass | 1.1 s | 3 |
| v1 and v2 action parity | workflow-chains.mjs | v1 | na | na |  |  |
| portable keyboard workflow | workflow-chains.mjs | v2 | run | pass | 0.2 s | 4 |
| Page keyboard interface | page-keyboard.mjs | v2 | run | pass | 0.3 s | 38 |
| pure CDP workflow | workflow-chains.mjs | cdp | na | na |  |  |
| snapshot workflow | workflow-chains.mjs | v2 | run | pass | 0.5 s | 7 |
| visual workflow | workflow-chains.mjs | v2 | run | pass | 0.2 s | 5 |
| zen-eval: v2 control lifecycle | zen-cases/control-lifecycle.mjs | v2 | run | pass | 0.3 s | 21 |
| zen-eval: pdf.js viewer download | zen-cases/pdfjs-download.mjs | gecko | run | pass | 1.1 s | 11 |

## Adapted for zenius

The adapt cases run with test-only stand-ins for Ego's v1 tab helpers (`openOrReuseTab`, `listTabs`, `currentTab`, `closeTab`), its Page ledger file (`readPageLedger`) and CDP iframe targets (`__zenFrame`, `js`), built on the dev runtime (`tests/e2e/source.mjs`). These cases are also patched (`tests/e2e/zen-adapt.mjs`):

- **page actions and popup adoption**: The case deletes the popup from Ego's Page ledger file, to simulate an action receipt that missed it, and expects task.tabs() to adopt it again. zenius registers popups when their tabs open, and by decision doesn't re-ad
- **page basic operations**: The case checks page.cdp() and task.cdp() themselves. zenius has no CDP (a PARITY divergence), so on zenius those two checks become: both calls fail with ZEN_UNSUPPORTED.
- **Page JavaScript dialog handling**: One of the calls that must name the open dialog is a raw CDP Page.getFrameTree. zenius has no CDP, so that entry is dropped; snapshot and screenshot keep the check.
- **Page snapshot iframe viewport**: The cross-origin mode checks with CDP's Target.getTargets that the iframe is an OOPIF. On zenius the check asks the dev runtime whether that frame runs in another process than its Page.
- **Page OOPIF actions**: The case finds the cross-site iframe with CDP's Target.getTargets and reads its DOM with Ego's js(code, targetId). On zenius both go through the dev runtime: __zenFrame finds the frame by URL and js() runs code in it.
- **Page OOPIF restore and close**: The case finds the cross-site iframe with CDP's Target.getTargets and reads its DOM with Ego's js(code, targetId). On zenius both go through the dev runtime: __zenFrame finds the frame by URL and js() runs code in it.
- **Page load states**: Three changes. The case turns on console events in Ego's CDP session (egoAutomated.disable, Runtime.enable), which zenius captures without being asked, so those calls go. It finds the slow cross-process iframe with CDP's
- **Page pending navigation: same process**: The case leaves a navigation pending with a raw CDP Page.navigate, which goto never sees. On zenius a script navigation (location.href) does the same: zenius's navigation tracker sees navigations it didn't start.
- **Page pending navigation: evaluate and screenshot**: As in the same-process round: a script navigation (location.href) leaves the navigation pending instead of a raw CDP Page.navigate.
- **page labels: create**: On Ego, the v1 cases (N/A on zenius) create the suite space with useOrCreateTaskSpace, which starts no Page ledger, so the first newPage gets p1. On zenius the space comes from taskSpace(), which starts it with p1 as Ego

## N/A on zenius, and why

- **environment initialization** (v1): uses Ego's legacy v1 helpers (useOrCreateTaskSpace, js, gotoAndWait, …), which skill guide v2.2.1 leaves out; also asserts CDP Runtime.evaluate
- **helper surface** (v1): checks that Ego's legacy v1 helpers (useOrCreateTaskSpace, js, gotoAndWait, …) are installed; skill guide v2.2.1 leaves them out
- **task spaces and control** (v1): uses Ego's legacy v1 helpers (useOrCreateTaskSpace, js, gotoAndWait, …), which skill guide v2.2.1 leaves out; its v2 lifecycle part (handOff, takeover, finish receipts, claim) is covered by "zen-eval: v2 control lifecycle"
- **navigation helpers** (v1): uses Ego's legacy v1 helpers (useOrCreateTaskSpace, js, gotoAndWait, …), which skill guide v2.2.1 leaves out
- **observation helpers** (v1): uses Ego's legacy v1 helpers (useOrCreateTaskSpace, js, gotoAndWait, …), which skill guide v2.2.1 leaves out; also uses CDP Network.enable
- **pointer and scroll helpers** (v1): uses Ego's legacy v1 helpers (useOrCreateTaskSpace, js, gotoAndWait, …), which skill guide v2.2.1 leaves out
- **keyboard and file helpers** (v1): uses Ego's legacy v1 helpers (useOrCreateTaskSpace, js, gotoAndWait, …), which skill guide v2.2.1 leaves out
- **keyboard regression** (v1): uses Ego's legacy v1 helpers (useOrCreateTaskSpace, js, gotoAndWait, …), which skill guide v2.2.1 leaves out
- **wait, fetch, cdp, js, help** (v1): uses Ego's legacy v1 helpers (useOrCreateTaskSpace, js, gotoAndWait, …), which skill guide v2.2.1 leaves out; also asserts CDP
- **runtime regression** (v1): uses Ego's legacy v1 helpers (useOrCreateTaskSpace, js, gotoAndWait, …), which skill guide v2.2.1 leaves out
- **target-scoped event isolation** (v1): uses Ego's legacy v1 helpers (useOrCreateTaskSpace, js, gotoAndWait, …), which skill guide v2.2.1 leaves out; also reads CDP Network events
- **Page Chromium PDF viewer download** (chromium): drives Chromium's PDF viewer (cr-icon-button#save); Zen shows PDFs in pdf.js, covered by "zen-eval: pdf.js viewer download"
- **Page automation hooks** (cdp): tests Ego's egoAutomated CDP domain
- **v1 and v2 action parity** (v1): compares v2 actions with Ego's legacy v1 helpers (useOrCreateTaskSpace, js, gotoAndWait, …), which skill guide v2.2.1 leaves out
- **pure CDP workflow** (cdp): drives a page only through raw CDP (SPEC §2: no CDP emulation)

Every run of every case, with its time and failure message: `docs/eval/e2e-zenius.json`.
