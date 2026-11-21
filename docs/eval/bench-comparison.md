# Bench comparison: Ego Lite 0.6.3.17 vs zenius 0.1.0

Ego run 2026-11-20T05:26:50.000Z, zenius run 2026-11-20T07:04:37.044Z (zen 1.24.2b, commit c314f9b). Ratio below 1 means zenius is faster.

| Operation | Ego p50 | zenius p50 | ratio | Ego p95 | zenius p95 |
|---|---|---|---|---|---|
| spawn to first RPC (listTaskSpaces) | 166 | 51.0 | 0.31 | 192 | 56.2 |
| spawn to exit, script with one RPC | 171 | 53.0 | 0.31 | 199 | 59.0 |
| taskSpace(name), new space | 246 | 36.0 | 0.15 | 292 | 39.4 |
| finish({ keep: [] }), blank space | 54.3 | 7.5 | 0.14 | 130 | 9.1 |
| page.url() round trip | 1.5 | 0.1 | 0.08 | 15.8 | 0.3 |
| goto local fixture | 258 | 5.4 | 0.02 | 308 | 7.5 |
| goto https://example.com/ | 527 | 252 | 0.48 | 632 | 301 |
| snapshot, small (bench fixture, viewport) | 4.6 | 0.6 | 0.14 | 6.5 | 1.1 |
| snapshot, typical (GitHub repo replay, viewport) | 103 | 5.4 | 0.05 | 261 | 6.4 |
| snapshot, large (GitHub repo replay, full_page) | 134 | 7.7 | 0.06 | 183 | 9.4 |
| snapshot, huge (Wikipedia table replay, full_page) | 9290 | 41.9 | 0.00 | 10062 | 45.6 |
| click(selector) | 1008 | 33.5 | 0.03 | 1124 | 38.2 |
| fill(selector, text) | 21.4 | 0.6 | 0.03 | 69.1 | 0.9 |
| press(selector, Enter) | 8.2 | 0.4 | 0.05 | 14.9 | 0.6 |
| keyboard.type, 50 characters | 68.0 | 5.2 | 0.08 | 166 | 6.0 |
| evaluate(() => document.title) | 5.2 | 0.1 | 0.02 | 14.2 | 0.3 |
| screenshot, viewport | 84.3 | 9.9 | 0.12 | 100 | 12.1 |
| screenshot, full page (about 2.8k px tall) | 115 | 23.1 | 0.20 | 132 | 25.7 |
| waitForSelector, element present | 5.8 | 0.1 | 0.02 | 10.2 | 0.3 |
| waitForSelector, element appears after 200 ms | 216 | 201 | 0.93 | 231 | 202 |
| click the same button repeatedly | 1015 | 33.8 | 0.03 | 1045 | 39.1 |
| click alternating corners (about 1300 px travel) | 1022 | 33.4 | 0.03 | 1091 | 64.9 |
| click alternating corners, with label | 1016 | 33.8 | 0.03 | 1098 | 39.6 |
| mouse.click alternating corners | 517 | 0.5 | 0.00 | 1030 | 0.7 |
| first snapshot in a new process (GitHub replay, viewport) | 82.1 | 6.4 | 0.08 | 97.5 | 10.3 |
| first click in a new process | 812 | 10.2 | 0.01 | 917 | 26.2 |
| first evaluate in a new process | 7.0 | 0.6 | 0.08 | 10.9 | 0.7 |

Times in ms. A dash means the zenius run didn't include that row.

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
