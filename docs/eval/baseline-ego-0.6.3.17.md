# e2e baseline: Ego Lite 0.6.3.17

Ego's real-browser e2e suite (83 cases, tag v2.2.1), ported to `tests/e2e` and run on the installed Ego Lite (chromium 156.0.8078.96, node v24.22.1; SDK: embedded). 3 full runs, started 2026-11-20 04:46, 2026-11-20 05:19, 2026-11-20 05:31 UTC, on the user's Mac with its task spaces in Ego's background Spaces, as agents use it.

```sh
node tests/e2e/runner.mjs --target ego
```

## Summary

| | Cases | Pass | Flaky | Fail | N/A |
|---|---|---|---|---|---|
| All cases | 83 | 67 | 11 | 5 | 0 |
| Rubric A (not N/A on zenius) | 68 | 55 | 10 | 3 | |

Rubric A counts the cases `tests/e2e/manifest.mjs` doesn't mark N/A for zenius: it leaves out the 12 cases that exercise Ego's legacy v1 helpers (not in skill guide v2.2.1), the 2 that test CDP itself and the one that drives Chromium's PDF viewer. Flaky means the case passed in some runs and failed in others.

zen-eval's own cases (`tests/e2e/zen-cases/`), outside Ego's suite and its counts:

- **zen-eval: v2 control lifecycle**: pass, 21 assertions

## What this means for rubric A

In single runs Ego Lite passed 64, 60 and 61 of the 68 rubric-A cases (88–94%).
Only 55 passed in all three runs. Rubric A asks zenius for ≥ 90% under the same
conditions, so the bar is roughly what Ego reaches in a good run here, not 100%.
Flaky cases deserve a second look before they count against zenius.

## What fails on Ego Lite, and why

Ego's repository runs this suite as its pre-push hook (`lefthook.yml`), so it
normally passes where Ego is developed. The failures here most likely come
from conditions on this Mac: task spaces sit in background macOS Spaces, and
the user works alongside. Grouped by cause, with each case's result in runs
1, 2 and 3 (P pass, F fail):

- **Actions on targets below the fold time out** with "element is not
  visible in the viewport":
  - page actions and popup adoption (FFF);
  - Page text locators (PFP), Page open Shadow DOM locators (FPP), Page ref
    identity across partial snapshots (PPF);
  - Page download across rounds: prepare (PFP). Its resume half then fails
    for lack of the prepared state (PFP);
  - the legacy pointer case (PFF, an iframe target).

  Ego scrolls a target into view with wheel input. In the words of Ego's own
  e2e prelude: "While the browser window is covered …, macOS slows its frames
  to about one per second, and Chromium holds the next mouse event's
  acknowledgement for up to a second until the wheel gesture ends." The
  prelude gives three case files a 10 s `scrollingActionTimeout` for that
  reason; these cases keep the 3 s default.
- **Escape never reaches the page** (FFF in page basic operations and in
  Page keyboard interface). `page.keyboard.press("Escape")` is lost, and so
  is an `ArrowDown` sent right after it. Enter, letters and Meta+A arrive.
  The cause isn't known yet.
- **Ego's own latency checks fail under load** (PPF):
  - Page action popup receipts: four fills and a select must finish within
    250 ms; they took 2168 ms.
  - Page action idle fail-fast: a missing target must be rejected within
    2 s; it took 2081 ms.
- **Other timeouts:**
  - Page popup waiter (PFP): `waitForEvent("popup")` timed out at 3 s.
  - Page API alignment (PFP): a `selectOption` error should list the
    options, but instead says the Page didn't answer `Page.getFrameTree`.
  - Page JavaScript dialog handling (PPF): `waitForFileChooser` timed out at
    2 s. The error was thrown from a timer, so it ended the script.
- **Legacy help text** (FFF, v1 runtime case, N/A).
  `help("legacy", "click", "fillInput")` answers "Unknown legacy helper:
  click". The SDK embedded in Ego Lite 0.6.3.17 lacks the legacy JSDoc that
  the v2.2.1 checkout has. No v2 case found any other difference between the
  embedded SDK and tag v2.2.1.
- **Chromium's PDF viewer** (FFF, N/A) never shows its download button
  within 10 s (`cr-icon-button#save`).

zenius's agent tabs also run where the user isn't looking, as background tabs
in other Zen Spaces, so its runs should happen the same way: with the user's
work in front.

## Failures on this target

- **pointer and scroll helpers** (flaky, `pointer.mjs`): click scrolls a same-process iframe target into view and lands on it: expected "partial,far,far,framed", got "partial,far,far"
- **wait, fetch, cdp, js, help** (fail, `runtime.mjs`): help returns multiple helper docs: expected "Unknown legacy helper: click" to include "fillInput"
- **page basic operations** (fail, `page-labels.mjs`): page.keyboard.press delivers a native key event to the focused element: expected " ,Meta,A,r,e,p,l,a,c,e,d" to include "Escape"
- **page actions and popup adoption** (fail, `page-labels.mjs`): page.fill timed out after 3928ms: page.fill failed: element is not visible in the viewport
- **Page action popup receipts** (flaky, `page-action-latency.mjs`): four fills and a select complete without fixed settle delays (2168ms)
- **Page action idle fail-fast** (flaky, `page-action-latency.mjs`): an idle page rejects a missing target well before the 3s action timeout (2081ms)
- **Page JavaScript dialog handling** (flaky, `page-dialogs.mjs`): ego script exited with code 1: page.waitForFileChooser timed out after 2000ms
- **Page ref identity across partial snapshots** (flaky, `page-ref-identity.mjs`): page.click timed out after 6287ms: page.click failed: element is not visible in the viewport
- **Page open Shadow DOM locators** (flaky, `page-shadow-dom.mjs`): page.fill timed out after 3015ms: page.fill failed: element is not visible in the viewport
- **Page text locators** (flaky, `page-text-locators.mjs`): page.click timed out after 3030ms: page.click failed: element is not visible in the viewport
- **Page popup waiter and URL diagnostic** (flaky, `page-popup-waiter.mjs`): page.waitForEvent("popup") timed out after 3000ms
- **Page Chromium PDF viewer download** (fail, `page-download.mjs`): page.waitForSelector timed out after 10000ms: loc=css:cr-icon-button#save[iron-icon$='download']
- **Page download across rounds: prepare** (flaky, `page-download.mjs`): page.click timed out after 3012ms: page.click failed: element is not visible in the viewport
- **Page download across rounds: resume** (flaky, `page-download.mjs`): ENOENT: no such file or directory, open '$TMPDIR/zen-eval-e2e-Yt0UwF/download-round-state.json'
- **Page API alignment** (flaky, `page-api-alignment.mjs`): a missing option error lists the real available labels and values: expected "page.selectOption timed out after 245ms: Page p73 (http://127.0.0.1:61296/?page-api-alignment=1795152272272) did not answer Page.getFrameTree w
- **Page keyboard interface** (fail, `page-keyboard.mjs`): named keys accept case-insensitive spellings through both Page APIs: expected "Enter,Escape,ArrowDown", got "Enter"

## Per case

| Case | File | Category | Zenius | Result | Time (median of passes) | Assertions |
|---|---|---|---|---|---|---|
| environment initialization | environment.mjs | v1 | na | pass | 7.0 s | 23 |
| helper surface | helper-surface.mjs | v1 | na | pass | 0.2 s | 67 |
| task spaces and control | task-space.mjs | v1 | na | pass | 4.2 s | 65 |
| TaskSpace profile selection | profile-selection.mjs | v2 | run | pass | 0.9 s | 19 |
| v2 cross-space routing | task-space.mjs | v2 | run | pass | 1.6 s | 4 |
| navigation helpers | navigation.mjs | v1 | na | pass | 3.7 s | 33 |
| observation helpers | observation.mjs | v1 | na | pass | 7.8 s | 51 |
| pointer and scroll helpers | pointer.mjs | v1 | na | flaky (1/3) | 28.1 s | 56 |
| keyboard and file helpers | keyboard.mjs | v1 | na | pass | 5.6 s | 22 |
| keyboard regression | keyboard-regression.mjs | v1 | na | pass | 1.5 s | 14 |
| wait, fetch, cdp, js, help | runtime.mjs | v1 | na | fail |  | 40 |
| runtime regression | runtime-regression.mjs | v1 | na | pass | 4.3 s | 20 |
| target-scoped event isolation | event-isolation.mjs | v1 | na | pass | 4.2 s | 4 |
| page labels: create | page-labels.mjs | v2+obs | adapt | pass | 1.3 s | 13 |
| page labels: restore and reuse | page-labels.mjs | v2+obs | adapt | pass | 4.3 s | 14 |
| page labels: close and do not reuse | page-labels.mjs | v2+obs | adapt | pass | 1.5 s | 10 |
| page labels: persist before hard stop | page-labels.mjs | v2 | run | pass | 0.7 s | 1 |
| page labels: restore after hard stop | page-labels.mjs | v2 | run | pass | 1.1 s | 3 |
| page inventory and budget | page-labels.mjs | v2+obs | adapt | pass | 1.9 s | 9 |
| page adoption and release | page-labels.mjs | v2+obs | adapt | pass | 1.1 s | 19 |
| page basic operations | page-labels.mjs | v2+cdp | adapt | fail |  | 34 |
| page complex evaluate | page-labels.mjs | v2+obs | adapt | pass | 1.3 s | 23 |
| page fetch | page-labels.mjs | v2+obs | adapt | pass | 1.8 s | 25 |
| page actions and popup adoption | page-labels.mjs | v2+ledger | adapt | fail |  | 5 |
| Page action popup receipts | page-action-latency.mjs | v2 | run | flaky (2/3) | 6.1 s | 9 |
| Page action idle fail-fast | page-action-latency.mjs | v2 | run | flaky (2/3) | 6.5 s | 14 |
| Page click hit target | page-click-hit-target.mjs | v2 | run | pass | 9.6 s | 17 |
| Page action motion tolerance | page-action-motion.mjs | v2 | run | pass | 4.2 s | 6 |
| Page drag and canvas drawing | page-drag-and-draw.mjs | v2 | run | pass | 17.1 s | 15 |
| Page JavaScript dialog handling | page-dialogs.mjs | v2+cdp | adapt | flaky (2/3) | 5.9 s | 34 |
| Page media playback | page-media-playback.mjs | v2 | run | pass | 12.9 s | 17 |
| Page scrolled screenshot | page-screenshot.mjs | v2 | run | pass | 1.8 s | 13 |
| Page default screenshot path: first run | page-default-screenshot-path.mjs | v2+obs | run | pass | 1.1 s | 9 |
| Page default screenshot path: second run | page-default-screenshot-path.mjs | v2+obs | run | pass | 1.9 s | 4 |
| Page snapshot locator quality | page-snapshot-locators.mjs | v2 | run | pass | 0.7 s | 4 |
| Page snapshot iframe viewport | page-snapshot-subtree.mjs | v2+cdp | adapt | pass | 2.2 s | 13 |
| Page snapshot subtree | page-snapshot-subtree.mjs | v2 | run | pass | 3.6 s | 46 |
| Page auto-scroll past a wheel trap | page-wheel-trap.mjs | v2 | run | pass | 4.4 s | 10 |
| Page snapshot viewport overflow hint | page-snapshot-viewport-overflow.mjs | v2 | run | pass | 1.5 s | 20 |
| Page ref identity across partial snapshots | page-ref-identity.mjs | v2 | run | flaky (2/3) | 7.7 s | 14 |
| Page refs across rounds: prepare | page-ref-identity.mjs | v2 | run | pass | 0.8 s | 5 |
| Page refs across rounds: resume | page-ref-identity.mjs | v2 | run | pass | 7.7 s | 12 |
| Page refs in dialog workflows | page-ref-workflows.mjs | v2 | run | pass | 2.6 s | 10 |
| Page refs after failed actions: prepare | page-ref-workflows.mjs | v2 | run | pass | 1.0 s | 8 |
| Page refs after failed actions: resume | page-ref-workflows.mjs | v2 | run | pass | 0.6 s | 3 |
| Page refs after upload: prepare | page-ref-workflows.mjs | v2 | run | pass | 1.8 s | 2 |
| Page refs after upload: resume | page-ref-workflows.mjs | v2 | run | pass | 0.3 s | 3 |
| Page snapshot lazy iframe | page-snapshot-subtree.mjs | v2 | run | pass | 0.9 s | 14 |
| Page snapshot sibling iframes | page-snapshot-subtree.mjs | v2 | run | pass | 1.1 s | 14 |
| Page snapshot nested iframes | page-snapshot-subtree.mjs | v2 | run | pass | 1.8 s | 18 |
| Page snapshot replaced iframe | page-snapshot-subtree.mjs | v2 | run | pass | 1.1 s | 11 |
| Page open Shadow DOM locators | page-shadow-dom.mjs | v2 | run | flaky (2/3) | 4.3 s | 4 |
| Page text locators | page-text-locators.mjs | v2 | run | flaky (2/3) | 4.4 s | 6 |
| Page Playwright selector compatibility | page-selector-compatibility.mjs | v2 | run | pass | 19.5 s | 16 |
| Page popup waiter and URL diagnostic | page-popup-waiter.mjs | v2 | run | flaky (2/3) | 6.6 s | 11 |
| Page download lifecycle | page-download.mjs | v2 | run | pass | 3.7 s | 8 |
| Concurrent TaskSpace downloads | page-download.mjs | v2 | run | pass | 7.9 s | 13 |
| Concurrent Page downloads: slow response | page-download.mjs | v2 | run | pass | 2.9 s | 6 |
| Page Chromium PDF viewer download | page-download.mjs | chromium | na | fail |  | 2 |
| Page download across rounds: prepare | page-download.mjs | v2 | run | flaky (2/3) | 3.5 s | 1 |
| Page download across rounds: resume | page-download.mjs | v2 | run | flaky (2/3) | 1.1 s | 4 |
| Page OOPIF actions | page-oopif.mjs | v2+cdp | adapt | pass | 11.0 s | 15 |
| Page OOPIF restore and close | page-oopif.mjs | v2+cdp | adapt | pass | 1.1 s | 7 |
| Page load states | page-load-states.mjs | v2+cdp | adapt | pass | 14.9 s | 50 |
| Page automation hooks | page-automation-hooks.mjs | cdp | na | pass | 1.2 s | 3 |
| Page dedicated Worker startup | page-workers.mjs | v2 | run | pass | 0.6 s | 1 |
| Page AudioWorklet startup | page-workers.mjs | v2 | run | pass | 0.8 s | 1 |
| Page SharedWorker startup | page-workers.mjs | v2 | run | pass | 0.6 s | 1 |
| Page Service Worker startup | page-workers.mjs | v2 | run | pass | 0.8 s | 1 |
| Page API alignment | page-api-alignment.mjs | v2 | run | flaky (2/3) | 6.7 s | 40 |
| Page actionability | page-actionability.mjs | v2 | run | pass | 14.1 s | 46 |
| Page evaluate timeout recovery | page-evaluate-timeout.mjs | v2+obs | run | pass | 15.3 s | 24 |
| Page pending navigation: same process | page-pending-navigation.mjs | v2+cdp | adapt | pass | 11.7 s | 31 |
| Page pending navigation: fresh process | page-pending-navigation.mjs | v2+obs | run | pass | 7.4 s | 6 |
| Page pending navigation: evaluate and screenshot | page-pending-navigation.mjs | v2+cdp | adapt | pass | 13.6 s | 18 |
| Page delayed popup: schedule | page-delayed-popup.mjs | v2+ledger | adapt | pass | 3.3 s | 1 |
| Page delayed popup: resume | page-delayed-popup.mjs | v2+ledger | adapt | pass | 1.3 s | 3 |
| v1 and v2 action parity | workflow-chains.mjs | v1 | na | pass | 3.4 s | 13 |
| portable keyboard workflow | workflow-chains.mjs | v2 | run | pass | 1.5 s | 4 |
| Page keyboard interface | page-keyboard.mjs | v2 | run | fail |  | 19 |
| pure CDP workflow | workflow-chains.mjs | cdp | na | pass | 2.8 s | 9 |
| snapshot workflow | workflow-chains.mjs | v2 | run | pass | 3.9 s | 7 |
| visual workflow | workflow-chains.mjs | v2 | run | pass | 1.2 s | 5 |
| zen-eval: v2 control lifecycle | zen-cases/control-lifecycle.mjs | v2 | run | pass | 1.1 s | 21 |

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
- **Page Chromium PDF viewer download** (chromium): drives Chromium's PDF viewer (cr-icon-button#save); Zen shows PDFs in pdf.js, which needs its own case
- **Page automation hooks** (cdp): tests Ego's egoAutomated CDP domain
- **v1 and v2 action parity** (v1): compares v2 actions with Ego's legacy v1 helpers (useOrCreateTaskSpace, js, gotoAndWait, …), which skill guide v2.2.1 leaves out
- **pure CDP workflow** (cdp): drives a page only through raw CDP (SPEC §2: no CDP emulation)

Every run of every case, with its time and failure message: `docs/eval/baseline-ego-0.6.3.17.json`.
