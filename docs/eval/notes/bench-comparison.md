## Reading the comparison

- **Every zenius row comes from one run on round 2's build,** a 0.1.0
  pre-release from 2026-11-21, so all four rubrics cite one build.
  - A headless dev Zen on the Mac, on a fresh profile, 2026-11-22 01:21 UTC.
    Each row is 20 timed iterations after 2 warm-up ones; the whole run took
    55 s.
  - The checkout was round 2's build plus round 2's harness, a
    local commit that touches only `tests/live`, two unit tests and
    `docs/eval` (now on `main`). The runtime, the SDK and the bench are the
    build's own.
  - Every row runs the checkout's CLI under node 24.22.2, the spawn rows too.
  - The Mac was busy. Its load average was 11.5 at the start and 8.8 at the
    end (over 1 minute, on 8 cores), and the user's try-out Zen ran beside it.
    Ego's run didn't record its load.
  - Ego ran in its real window, with task spaces in background Spaces.
  - The daily Zen is headed and keeps agent tabs in background workspaces, so
    a headed zenius run may come out differently.
  - The table this replaces combined runs on four builds from 2026-11-20.
- **What moved since then, and why: an A/B.** The runtime, SDK and bench of
  the last of those four builds ran against round 2's on the same Zen
  1.24.3b, under the same load (4–7), in four alternating pairs. The first
  pair warmed the old profile's cache and is left out. The old build's own
  `zen-dev.sh` predates the update guard, so round 2's started both
  instances. p50 in ms, the median of the three pairs:

  | Row | Old build | Round 2 | Round 2 / old |
  |---|---|---|---|
  | snapshot, huge (Wikipedia table replay) | 40.2 | 69.4 | 1.73 |
  | snapshot, large (GitHub replay, full page) | 7.43 | 12.4 | 1.66 |
  | snapshot, typical (GitHub replay, viewport) | 5.63 | 8.05 | 1.43 |
  | keyboard.type, 50 characters | 4.59 | 6.62 | 1.44 |
  | finish({ keep: [] }) | 9.60 | 13.5 | 1.40 |
  | click(selector) | 33.4 | 25.0 | 0.75 |
  | first snapshot in a new process | 6.69 | 7.58 | 1.13 |
  | snapshot, small | 0.65 | 0.72 | 1.11 |
  | taskSpace(name), new space | 43.3 | 40.8 | 0.94 |

  - **The snapshot of a large page is slower by design.**
    - Snapshots now print CSS generated content, as Ego's do. The walker asks
      Gecko about each element's `::before` and `::after` boxes, and keeps
      one computed style per element.
    - On the Wikipedia replay (10,085 elements), the runtime's own log shows
      the walk at 22 ms on the old build and 47 ms on round 2's (medians). It makes
      8,819 pseudo-element queries and keeps 5,723 styles, against 2,641.
    - The change weighed that cost when it was made. A cached scan of the style rules
      would have saved at most 30–35 ms per full page on the Linux server, but it would
      have charged each site's first snapshot for the scan. The A/B measured
      29 ms on the Wikipedia replay.
    - Small pages barely move.
  - **keyboard.type:** the shift explained in the last section. The Mac shows
    it too.
  - **click is faster** on round 2's build.
  - **finish isn't settled.** Its pairs overlap: 7.4–12.0 ms on the old build,
    10.2–16.4 ms on round 2's.
  - **The sub-millisecond rows** (`page.url()`, evaluate, waitForSelector with
    the element present, `mouse.click`) move by fractions of a millisecond.
  - **The table's run had more load on top.** snapshot-huge took 79.2 ms there
    (load about 10), and 63.8–90.8 ms across the A/B's pairs (load 4–7).
- **The sub-millisecond numbers are real round trips.** A separate check, on
  an earlier build, ran 500 `page.evaluate(() => document.title)` calls in
  81 ms of wall time (0.16 ms each), and every result was correct.
  `page.url()` is answered in the parent process; evaluate, the waits and the
  keyboard go through the content process and still stay under a millisecond.
- **Click is the one zenius action measured in tens of ms: 26.8 ms, against
  Ego's 1008 ms.** Ego's second goes to its native mouse path, which waits for
  the occluded window (see `bench-ego-0.6.3.17.md`). zenius's 26.8 ms is
  within SPEC §5's "per-action p50 ≤ Ego" target, with room to spare.
- **The goto row compares like with like.**
  - On both targets, goto returns after the load event of a freshly fetched
    document.
  - Each iteration asks for a different URL (`?goto=<i>`), and the fixture
    server sends `bench.html` with `cache-control: no-store`.
  - On the Linux server, every zenius goto transferred the whole page (2051 B) and
    returned 1–15 ms after `loadEventEnd`.
  - 60 ms of Ego's time is a fixed sleep after each navigation
    (`NAVIGATION_FRAME_SETTLE_MS` in Ego's `page-model.ts`).
    - It lets CDP attach the new document's cross-process iframes before Ego
      lists their sessions.
    - zenius has no CDP sessions to wait for.
    - Without that sleep, Ego's goto p50 would still be about 198 ms.
- **Process start.** The spawn rows now run the checkout's CLI under node 24,
  as every other row does. SPEC §5's target for spawn to first RPC is 80 ms or
  less.
  - An earlier run on a 2026-11-20 build (a headless dev Zen on the Mac, 20 iterations
    per row) compared launchers, including the installed CLI under the PATH
    node (v23.5) that agents on the Mac ran then. p50 in ms:

    | Launcher | spawn to first RPC | spawn to exit | first evaluate | `taskSpace(id)` resume |
    |---|---|---|---|---|
    | zenius checkout, node 24 | 36.5 | 38.4 | 0.6 | 2.6 |
    | zenius installed copy, node 24 | 36.0 | 38.9 | 0.6 | 2.6 |
    | zenius installed copy, PATH node 23.5 | 51.0 | 53.0 | 0.6 | 2.7 |
    | Ego Lite's CLI (node 24.22.1) | 166 | 171 | 7.0 | 9.2 |

  - On that build, most of zenius's time was Node starting up. `node -e 0` alone
    took 44.5 ms under the PATH node and 30.2 ms under node 24 (p50 of 20), so
    zenius added about 6 ms either way.
  - `--timing` on the installed copy (PATH node, 10 runs) showed where the
    time went, on the process's own clock: the launcher at 11.6–12.3 ms, the
    bundle loaded by 13.4–14.2, the script read by 14.6–15.4, the first
    request sent by 15.8–16.7, connected by 16.5–17.4, and the hello by
    17.0–17.9.
- **The replay snapshots are the same size as Ego's within about 6%,** so the
  times compare like with like:

  | Row | zenius p50 (ms) | Ego p50 (ms) | zenius characters | Ego bytes |
  |---|---|---|---|---|
  | GitHub replay, viewport | 7.9 | 103 | 15,330–15,484 | 16,331 |
  | GitHub replay, full page | 13.2 | 134 | 63,470 | 61,898 |
  | Wikipedia table replay, full page | 79.2 | 9290 | 579,645 | 602,516 |
  | first snapshot in a new process | 9.1 | 82.1 | | |

  - zenius's sizes are each snapshot's length in characters, from the
    runtime's log; Ego's are bytes, from its baseline.
  - The replays are served locally, but they load public stylesheets and
    images from GitHub's and Wikimedia's CDNs, as in Ego's baseline run.
    The GitHub page alone makes 121 such requests.
  - The bench loads each replay until its load event comes (up to five
    tries) before timing it. On a cold cache, the GitHub replay's load event
    once missed the 15 s goto timeout.
- **type-50 rose from about 34 to 47 ms on the Linux server between two
  builds of 2026-11-20 and 2026-11-21. It's explained and closed with no
  runtime change, so don't chase it again.**
  - It comes from one change, which touched only the click's `settle()` and
    made clicks about 75 ms faster (110 → 34 ms). On the earlier build with
    that change alone, type-50 went from 33–35 to 46–53 ms.
  - Typing does no more work per key. A raw replay of the same rows over
    one connection shows the click gain but typing within noise (p50 28.1
    against 28.2 ms), with the same CPU per call in the page process (27.4
    against 27.5 ms). Profiles show the same work per key on both sides.
  - The move shows only in the bench's sequence: typing right after the
    fast clicks, each row in a new CLI process and connection, in a hidden
    agent tab whose frames stall (the compositor acknowledges its paints
    only every 200–500 ms). Where the time goes in that state wasn't
    traced further.
