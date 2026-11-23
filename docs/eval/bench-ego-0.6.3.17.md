# Bench: Ego Lite 0.6.3.17

chromium 156.0.8078.96, node v24.22.1. Run 2026-11-20 05:26 UTC on the user's Mac (darwin arm64), 20 iterations per operation after 2 warm-up iterations, with the task space in the background as agents use it.

```sh
node tests/bench/bench.mjs --target ego
```

Warm operations run in a loop inside one script, the way an agent chains actions within a round.
"First call in a new process" spawns one CLI process per sample and times its first call after
`taskSpace(id)`, which is what each agent round pays first. Local pages come from
`tests/fixtures/server.mjs`: `/zoo/bench.html`, and the GitHub and Wikipedia replays of
`tests/golden/ego/dom/`, so both targets snapshot the same input.

## What the numbers say

- **A click costs about a second; the cursor animation costs nothing.**
  - `page.click` takes 1008 ms p50 in a loop and 812 ms as the first call of a
    new process. `mouse.click` takes 13–50 ms in half the samples and about
    1 s in the other half. Keyboard input is fast: `press` 8 ms, `fill` 21 ms,
    `keyboard.type` of 50 characters 68 ms.
  - The cursor doesn't change the time: clicking the same button again,
    clicking corners 1300 px apart, and doing so with a label all take
    1015–1022 ms p50. In each of the 80 timed clicks the page saw exactly one
    `pointermove`, at the target: Ego moves the pointer straight there, and
    its cursor animation (`showAgentMousePosition`) runs in Ego's own UI
    without being awaited.
  - The second is spent waiting, either before the first input event or
    after `click`; the input itself takes at most 22 ms.
  - The page itself runs normally. In an Ego task-space page,
    `document.visibilityState` is "visible"; in a quiet moment 100 ms timers
    fired after 101–116 ms and animation frames came 2–17 ms apart. (Right
    after a full e2e run, the same probe saw a 100 ms timer fire after up to
    1.8 s.) So the wait most likely sits in the mouse-input path, which
    Ego's own e2e code describes: "Native mouse input can wait up to a second for an occluded
    window." Keyboard input takes another path and stays fast.
  - For zenius: SPEC §5 asks for per-action p50 ≤ Ego and for the cursor
    animation to be skipped when nobody can see it. Ego's animation already
    costs nothing; the click's cost is this wait, which zenius avoids if its
    clicks don't go through the window's native input path.
- **Snapshots grow steeply with page size.** 4.6 ms for the small fixture,
  103 ms for GitHub's repository page (16 KiB of text, viewport), 134 ms for
  the same page in full (60 KiB), and 9.3 s for the Wikipedia table page
  (588 KiB). SPEC §5's target for zenius is 60 ms for a typical viewport
  snapshot, and Ego's own 134 ms for the GitHub page in full.
- **Process start is Ego's floor for every agent round.** A new
  `ego-browser nodejs` process reaches its first RPC in 166 ms (SPEC target
  for zenius: 80 ms) and resumes a task space in another 10 ms.
- **Navigation:** 258 ms to load a local fixture page, 527 ms for
  example.com. **Task spaces:** 246 ms to create, 54 ms to finish.
  **Screenshots:** 84 ms for the viewport, 115 ms for a 2.8k px page.

## Process

| Operation | p50 ms | p95 ms | mean | min | max | n | Note |
|---|---|---|---|---|---|---|---|
| spawn to first RPC (listTaskSpaces) | 166 | 192 | 171 | 153 | 200 | 20 | SPEC target ≤ 80 ms |
| spawn to exit, script with one RPC | 171 | 199 | 177 | 160 | 202 | 20 |  |

## Task spaces

| Operation | p50 ms | p95 ms | mean | min | max | n | Note |
|---|---|---|---|---|---|---|---|
| taskSpace(name), new space | 246 | 292 | 246 | 200 | 305 | 20 |  |
| finish({ keep: [] }), blank space | 54.3 | 130 | 62.0 | 7.1 | 130 | 20 |  |

## Navigation

| Operation | p50 ms | p95 ms | mean | min | max | n | Note |
|---|---|---|---|---|---|---|---|
| goto local fixture | 258 | 308 | 262 | 187 | 318 | 20 |  |
| goto https://example.com/ | 527 | 632 | 523 | 412 | 652 | 20 |  |

## Snapshot

| Operation | p50 ms | p95 ms | mean | min | max | n | Note |
|---|---|---|---|---|---|---|---|
| snapshot, small (bench fixture, viewport) | 4.6 | 6.5 | 4.9 | 3.7 | 6.7 | 20 | 0.6 KiB of text |
| snapshot, typical (GitHub repo replay, viewport) | 103 | 261 | 142 | 61.2 | 644 | 20 | 15.9 KiB of text; SPEC target ≤ 60 ms |
| snapshot, large (GitHub repo replay, full_page) | 134 | 183 | 141 | 125 | 215 | 20 | 60.4 KiB of text; SPEC target ≤ 134 ms |
| snapshot, huge (Wikipedia table replay, full_page) | 9290 | 10062 | 8106 | 5186 | 10098 | 10 | 588.4 KiB of text |

## Actions

| Operation | p50 ms | p95 ms | mean | min | max | n | Note |
|---|---|---|---|---|---|---|---|
| click(selector) | 1008 | 1124 | 1062 | 203 | 2924 | 20 |  |
| fill(selector, text) | 21.4 | 69.1 | 28.1 | 9.5 | 82.1 | 20 |  |
| press(selector, Enter) | 8.2 | 14.9 | 9.8 | 6.5 | 25.3 | 20 |  |
| keyboard.type, 50 characters | 68.0 | 166 | 80.6 | 21.9 | 222 | 20 |  |
| evaluate(() => document.title) | 5.2 | 14.2 | 6.7 | 4.4 | 19.8 | 20 |  |

## Screenshot

| Operation | p50 ms | p95 ms | mean | min | max | n | Note |
|---|---|---|---|---|---|---|---|
| screenshot, viewport | 84.3 | 100 | 81.6 | 46.1 | 122 | 20 | SPEC target ≤ 300 ms |
| screenshot, full page (about 2.8k px tall) | 115 | 132 | 106 | 75.2 | 136 | 20 |  |

## Waits

| Operation | p50 ms | p95 ms | mean | min | max | n | Note |
|---|---|---|---|---|---|---|---|
| waitForSelector, element present | 5.8 | 10.2 | 7.1 | 5.0 | 18.3 | 20 |  |
| waitForSelector, element appears after 200 ms | 216 | 231 | 219 | 209 | 248 | 20 |  |

## Round-trip floor

| Operation | p50 ms | p95 ms | mean | min | max | n | Note |
|---|---|---|---|---|---|---|---|
| page.url() round trip | 1.5 | 15.8 | 3.5 | 0.6 | 18.4 | 20 |  |

## First call in a new process

| Operation | p50 ms | p95 ms | mean | min | max | n | Note |
|---|---|---|---|---|---|---|---|
| first snapshot in a new process (GitHub replay, viewport) | 82.1 | 97.5 | 83.0 | 74.0 | 106 | 20 | taskSpace(id) resume p50 9.5 ms; process wall p50 249 ms |
| first click in a new process | 812 | 917 | 787 | 43.6 | 1703 | 20 | taskSpace(id) resume p50 10.0 ms; process wall p50 1007 ms |
| first evaluate in a new process | 7.0 | 10.9 | 8.0 | 6.4 | 15.2 | 20 | taskSpace(id) resume p50 9.2 ms; process wall p50 155 ms |

## Cursor motion

| Operation | p50 ms | p95 ms | mean | min | max | n | Note |
|---|---|---|---|---|---|---|---|
| click the same button repeatedly | 1015 | 1045 | 1019 | 997 | 1084 | 20 |  |
| click alternating corners (about 1300 px travel) | 1022 | 1091 | 1028 | 832 | 1231 | 20 |  |
| click alternating corners, with label | 1016 | 1098 | 1024 | 790 | 1259 | 20 |  |
| mouse.click alternating corners | 517 | 1030 | 524 | 12.7 | 1037 | 20 |  |

Each timed call is matched with the page-side input events it caused (the bench fixture logs
pointer, click, key and wheel events with wall-clock times). *Before input* runs from the SDK call
to the first input event (resolve, actionability, cursor), *input span* from the first input
event to `click`, *after click* from `click` to the call returning. The columns are means, so
they add up to the call's mean; times have 1 ms resolution.

| Variant | call mean | before input | input span | after click | pointermoves per click | all trusted |
|---|---|---|---|---|---|---|
| click the same button repeatedly | 1019 | 600 | 8.9 | 410 | 1 | yes |
| click alternating corners (about 1300 px travel) | 1028 | 518 | 4.8 | 505 | 1 | yes |
| click alternating corners, with label | 1024 | 453 | 5.3 | 566 | 1 | yes |
| mouse.click alternating corners | 524 | 356 | 5.5 | 162 | 1 | yes |
