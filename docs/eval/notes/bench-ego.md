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
    Ego's own e2e code describes: "Native mouse input can wait up to a
    second for an occluded window." Keyboard input takes another path and
    stays fast.
  - For zenius: SPEC §5 asks for per-action p50 ≤ Ego and for the cursor
    animation to be skipped when nobody can see it. Ego's animation already
    costs nothing; the click's cost is this wait, which zenius avoids if its
    clicks don't go through the window's native input path.
- **Snapshots grow steeply with page size.** 4.6 ms for the small fixture,
  103 ms for GitHub's repository page (16 KiB of text, viewport), 134 ms for
  the same page in full (60 KiB), and 9.3 s for the Wikipedia table page
  (588 KiB). SPEC §5's target for zenius is 60 ms for a typical viewport
  snapshot; zen-snapshot's brief adds 250 ms for a large full page.
- **Process start is Ego's floor for every agent round.** A new
  `ego-browser nodejs` process reaches its first RPC in 166 ms (SPEC target
  for zenius: 80 ms) and resumes a task space in another 10 ms.
- **Navigation:** 258 ms to load a local fixture page, 527 ms for
  example.com. **Task spaces:** 246 ms to create, 54 ms to finish.
  **Screenshots:** 84 ms for the viewport, 115 ms for a 2.8k px page.
