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
