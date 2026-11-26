## Reading this run

All 67 rubric-A cases pass on round 2's build (`live-round2.md`), a 0.1.0
pre-release from 2026-11-21, and so do the four cases zenius adds. The bench
and the no-preemption check ran on it too (`bench-comparison.md`,
`no-preemption.md`), so all four rubrics cite one build.
- **The checkout:** round 2's build plus round 2's harness, a local
  commit that touches only `tests/live`, two unit tests and `docs/eval` (now
  on `main`). The runtime, the SDK and this suite are the build's own.
- **Same as in the last full run (2026-11-20):** every Ego case keeps its
  verdict and assertion count, except "Page Service Worker startup", which is now
  a deliberate difference (below). The pdf.js case zenius adds checks one thing
  more (12 assertions, against 11).
- **What landed in between (812 commits, 301 of them in `runtime/` or
  `sdk/src`).** What this suite sees of it:
  - zenius refuses service worker registration and Cache Storage writes in a
    task's pages;
  - page code runs in an isolated world, so the cases read a fixture page's
    own objects in the page's world ("Adapted for zenius");
  - snapshots print CSS generated content, as Ego does;
  - a middle click on a link opens it as a new page of the task, as on Ego.
- **Two new cases zenius adds:**
  - "a task's service worker is refused": the counterpart of Ego's Service
    Worker case. The agent sees the refusal through the public API: the
    page's call rejects with SecurityError, and `page.events()` reports it
    once. The site's own worker is hidden from a task's pages too,
    and reported apart.
  - "v2 checks from N/A cases": the v2 checks that only N/A cases made, now
    counted.
- **The claim prompt:** the runner answers each prompt with Allow through
  `dev.answerClaim`, as the user would. In this run only the control lifecycle
  case asks: it claims its ended task.
- **The adapt cases:** all 18 run with test-only stand-ins, ten of them also
  patched ("Adapted for zenius" below lists both). All 18 pass.
- **Times:** the suite took 114 s, against 100 s in the last full run, and eight short
  cases took more than twice as long (for example "page basic operations",
  573 ms then and 1904 ms now). The Mac was busy: its load average was about
  10 on 8 cores (the 5-minute average at the run's end). Rubric A counts
  passes and failures only.
  - The bench separated load from code for the snapshot, which is slower on
    large pages by design (`bench-comparison.md`).
  - For these cases load and code weren't separated.

One difference is deliberate (`docs/PARITY.md`, Deliberate divergences): zenius
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
