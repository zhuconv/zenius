## Reading this run

All 67 rubric-A cases pass at 9abcd8e, and so do zen-eval's own four cases.
9abcd8e is round 2's build (`live-round2.md`), and the bench and the
no-preemption check ran on it too (`bench-comparison.md`, `no-preemption.md`),
so all four rubrics cite one build.
- **The checkout:** 9abcd8e plus zen-eval's round 2 harness, a local commit
  that touches only `tests/live`, two unit tests and `docs/eval` (on `main`
  since e8b0182). The runtime, the SDK and this suite are 9abcd8e's, so the
  results name 9abcd8e.
- **Same as at 6c1ed53:** every Ego case keeps its verdict and assertion count
  from the last full run, except "Page Service Worker startup", which is now
  a deliberate difference (below). zen-eval's pdf.js case checks one thing
  more (12 assertions, against 11).
- **What landed in between (812 commits, 301 of them in `runtime/` or
  `sdk/src`).** What this suite sees of it:
  - zenius refuses service worker registration and Cache Storage writes in a
    task's pages (8d22cba);
  - page code runs in an isolated world, so the cases read a fixture page's
    own objects in the page's world ("Adapted for zenius");
  - snapshots print CSS generated content, as Ego does (7819d7d);
  - a middle click on a link opens it as a new page of the task, as on Ego
    (57352b0).
- **Two new zen-eval cases:**
  - "a task's service worker is refused": the counterpart of Ego's Service
    Worker case. The agent sees the refusal through the public API: the
    page's call rejects with SecurityError, and `page.events()` reports it
    once. The site's own worker is hidden from a task's pages too (94a298f),
    and reported apart.
  - "v2 checks from N/A cases": the v2 checks that only N/A cases made, now
    counted.
- **The claim prompt:** the runner answers each prompt with Allow through
  `dev.answerClaim`, as the user would. In this run only the control lifecycle
  case asks: it claims its ended task.
- **The adapt cases:** all 18 run with test-only stand-ins, ten of them also
  patched ("Adapted for zenius" below lists both). All 18 pass.
- **Times:** the suite took 114 s, against 100 s at 6c1ed53, and eight short
  cases took more than twice as long (for example "page basic operations",
  573 ms then and 1904 ms now). The Mac was busy: its load average was about
  10 on 8 cores (the 5-minute average at the run's end). Rubric A counts
  passes and failures only.
  - The bench separated load from code for the snapshot, which is slower on
    large pages by 7819d7d's design (`bench-comparison.md`).
  - For these cases load and code weren't separated.

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
