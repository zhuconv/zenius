## Reading the comparison

- **The zenius rows were run from a headless dev Zen on the Mac.**
  - The runtime is `a065dcc`; the checkout, `c314f9b`, adds only docs.
  - Each row is 20 timed iterations, and the whole run took about 3 s.
  - Ego ran in its real window, with task spaces in background Spaces.
  - The daily Zen is headed and keeps agent tabs in background workspaces, so
    a headed zenius run may come out differently.
  - This run has only the rows zen-observe asked for, plus the actions. The
    rest of the table comes from later runs (the last three sections).
- **The sub-millisecond numbers are real round trips.** A separate check ran
  500 `page.evaluate(() => document.title)` calls in 81 ms of wall time
  (0.16 ms each), and every result was correct. `page.url()` is answered in
  the parent process; evaluate, the waits and the keyboard go through the
  content process and still stay under a millisecond.
- **Click is the one zenius action measured in tens of ms: 33.5 ms, against
  Ego's 1008 ms.** Ego's second goes to its native mouse path, which waits for
  the occluded window (see `bench-ego-0.6.3.17.md`). zenius's 33.5 ms is
  within SPEC §5's "per-action p50 ≤ Ego" target, with room to spare.
- **The goto row compares like with like (checked by zen-observe).**
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
- **Process start, from a later run.**
  - The run: e9a3373, a headless dev Zen on the Mac, 20 iterations per row,
    with only the user's two workspaces in the profile.
  - The table's spawn and first-evaluate rows are the installed CLI under the
    PATH node (v23.5), which agents on the Mac run. The copy was installed by
    `scripts/install-cli.sh` into a temporary home, which is now removed.
  - p50 in ms, by launcher:

    | Launcher | spawn to first RPC | spawn to exit | first evaluate | `taskSpace(id)` resume |
    |---|---|---|---|---|
    | zenius checkout, node 24 | 36.5 | 38.4 | 0.6 | 2.6 |
    | zenius installed copy, node 24 | 36.0 | 38.9 | 0.6 | 2.6 |
    | zenius installed copy, PATH node 23.5 | 51.0 | 53.0 | 0.6 | 2.7 |
    | Ego Lite's CLI (node 24.22.1) | 166 | 171 | 7.0 | 9.2 |

  - Most of zenius's time is Node starting up. `node -e 0` alone takes 44.5
    ms under the PATH node and 30.2 ms under node 24 (p50 of 20), so zenius
    adds about 6 ms either way. SPEC §5's target for spawn to first RPC is
    80 ms or less.
  - `--timing` on the installed copy (PATH node, 10 runs) shows where the
    time goes, on the process's own clock: the launcher at 11.6–12.3 ms, the
    bundle loaded by 13.4–14.2, the script read by 14.6–15.4, the first
    request sent by 15.8–16.7, connected by 16.5–17.4, and the hello by
    17.0–17.9.
- **The other rows, from a later run.**
  - The run: cc3849a, the same headless dev Zen and launcher as the first
    run (the checkout under node 24), 20 iterations per row.
  - p50 in ms against Ego's:

    | Row | zenius | Ego |
    |---|---|---|
    | taskSpace(name), new space | 36.0 | 246 |
    | finish({ keep: [] }), blank space | 7.5 | 54.3 |
    | snapshot, small | 0.6 | 4.6 |
    | waitForSelector, element appears after 200 ms | 201 | 216 |
    | click, the same button or alternating corners | 33–34 | 1015–1022 |
    | mouse.click, alternating corners | 0.5 | 517 |
    | first click in a new process | 10.2 | 812 |
    | goto https://example.com/ | 252 | 527 |

  - Ego's motion rows move its native mouse, which waits for the occluded
    window (`bench-ego-0.6.3.17.md`). zenius's clicks draw their cursor in the
    page and leave the system pointer alone.
  - goto-real fetches example.com, the IANA example domain, with a fresh
    query each time. Most of its time is the network.
- **The replay snapshot rows, from runs on 6b00f45.**
  - zenius's snapshots are the same size as Ego's within 5%, so the times
    compare like with like:

    | Row | zenius p50 (ms) | Ego p50 (ms) | zenius bytes | Ego bytes |
    |---|---|---|---|---|
    | GitHub replay, viewport | 5.4 | 103 | 15,598 | 16,331 |
    | GitHub replay, full page | 7.7 | 134 | 63,918 | 61,898 |
    | Wikipedia table replay, full page | 41.9 | 9290 | 606,945 | 602,516 |
    | first snapshot in a new process | 6.4 | 82.1 | | |

  - The replays are served locally, but they load public stylesheets and
    images from GitHub's and Wikimedia's CDNs, as in Ego's baseline run.
    The GitHub page alone makes 121 such requests.
  - On a cold cache the GitHub replay's load event didn't come within the
    bench's 15 s goto timeout, so the first try's two GitHub rows failed in
    setup. Rerun with the cache warm, its goto took about 270 ms.
- **type-50 rose from about 34 to 47 ms on the Linux server between ce24f90 and 9ce85d1
  (zen-sdk's runs, 2026-11-21). It's explained and closed with no runtime
  change, so don't chase it again.**
  - It comes from `3da910a`, which changed only the click's `settle()` and
    made clicks about 75 ms faster (110 → 34 ms). On ce24f90 with
    `3da910a` alone, type-50 went from 33–35 to 46–53 ms.
  - Typing does no more work per key. A raw replay of the same rows over
    one connection shows the click gain but typing within noise (p50 28.1
    against 28.2 ms), with the same CPU per call in the page process (27.4
    against 27.5 ms). Profiles show the same work per key on both sides.
  - The move shows only in the bench's sequence: typing right after the
    fast clicks, each row in a new CLI process and connection, in a hidden
    agent tab whose frames stall (the compositor acknowledges its paints
    only every 200–500 ms). Where the time goes in that state wasn't
    traced further.
  - Details: `docs/reports/zen-input.md` (2026-11-21, 07:40Z) and
    `docs/reports/zen-sdk.md`.
