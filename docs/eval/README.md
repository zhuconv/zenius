# Evaluation results

Ego Lite 0.6.3.17 against zenius on the user's Mac, with the same scripts on
both (SPEC §6). The suites live in `tests/` (see `tests/README.md`).

| File | Rubric | What |
|---|---|---|
| `baseline-ego-0.6.3.17.md` (+ `.json`) | A | Ego's e2e suite on Ego Lite: per-case result, timing, and which cases count for zenius |
| `bench-ego-0.6.3.17.md` (+ `.json`) | B | latency of each operation on Ego Lite, p50 and p95, and what Ego's cursor motion costs |
| `bench-comparison.md` (+ `bench-zenius.json`) | B | Ego's bench rows next to zenius's, with the ratio |
| `e2e-zenius.md` (+ `.json`) | A | the same suite on a zenius dev instance: what passes, and what blocks the rest |
| `../PARITY.md` | A | each Ego API, the cases that cover it, and its status on both targets |
| `live-tasks.md` | C | the live-site tasks, their rubrics and how they run (approved) |
| `live-pilot.md` | C | the zenius half of the pilot: results and cost, how runs are isolated and contained, the canary |
| `pilot-evaluate-bodies.md` | C | the pilot's `page.evaluate` and `waitForFunction` bodies, scrubbed to their shape, with counts by pattern (for zen-sdk's isolated-world measurement) |
| `live-round1.md` | C | round 1 on both targets: the judged and hand-checked scores, the hand checks, per-task times and costs, the method, and its safety record |
| `live-round2.md` | C | round 2, with round 1's fixes and the order swapped: both rounds' scores and the pooled test, the hand checks, per-task times and costs, what changed in the method, and its safety record |
| `tryout.md` | – | the user's try-out Zen (profile "try", installed as the install would) and its agent: what opens, what to try, how to stop and restart |
| `no-preemption.md` | D | requirement 3: what each browser did to the user's view while an agent worked, from owner-only window samples |

`e2e-zenius` is regenerated as the runtime's methods land; git history keeps
the earlier runs. `bench-comparison` is regenerated the same way.

How to read the numbers:

- Every run happens on the user's Mac (Apple Silicon, 16 GB) while the user
  works, with the agent's task space in the background, as agents use it.
  Expect some noise; p95 shows it.
- Ego's task spaces live in background macOS Spaces. macOS throttles
  rendering for windows nobody sees, which slows Ego's wheel-scrolled
  actions; that is part of what agents get on this Mac.
