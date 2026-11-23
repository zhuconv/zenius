# Memory and CPU: Ego Lite vs zenius

One run per browser on 2026-11-22, 23:15 to 23:23 UTC, on the user's Mac
(Apple Silicon, 16 GB), while the user was away from it. Each browser ran the
same script five times, and the run sampled its whole process tree from the
process table every 2 s.

- **Ego Lite** as installed on the Mac (0.6.3.17 at the bench of 2026-11-20;
  we never upgrade it). It wasn't running, so the run's first call through
  `ego-browser nodejs` started it, with its window.
- **zenius:** a dev Zen (Zen 1.24.3b, zenius at `d815f22`) on a fresh dev
  profile, with the agent's scripts as the daily install has them, and a
  window like Ego Lite's.

## Results

Memory is macOS's physical footprint, the number in Activity Monitor's
Memory column, in MiB (1 GB = 1024 MiB, as Activity Monitor counts). CPU is
% of one core.

| | Ego Lite | zenius |
|---|---|---|
| Processes in the tree | 48 to 55 | 10 to 11 |
| Memory at rest before the rounds, median | 7,166 | 926 |
| Memory at rest after the rounds, median | 6,607 | 950 |
| The browser without its pages | 969, plus 351 in 5 extension processes | 950, the whole tree |
| CPU at rest before the rounds, mean | 80.0% | 8.9% |
| CPU at rest after the rounds, mean (range of samples) | 24.6% (10.5 to 70.5) | 0.6% (0 to 9.5) |
| Time per round, median | 2,068 ms | 576 ms |
| The five rounds | 4,645, 2,120, 1,711, 2,068, 1,984 ms | 970, 544, 648, 576, 543 ms |
| CPU per round, above the background | 3.0 CPU-s | 0.51 CPU-s |
| CPU per round, with the background | 4.77 CPU-s | 0.54 CPU-s |
| Memory added during the rounds, at the peak sample | +825, and 49 to 55 processes | +122, 11 processes |
| Rounds that passed | 5 of 5 | 5 of 5 |

## What isn't like for like

- **The memory at rest.** Ego Lite's start brought up far more than a blank
  window: one visible window, and 45 renderer processes within its first
  minute (38 after the rounds, 5 of them for extensions). That looks like its
  saved session reopening. The run counted processes and windows only, never
  what they showed. The dev Zen had a fresh profile. So the rows to compare
  are the per-round ones and "the browser without its pages":
  - Ego Lite's 33 page renderers held 4,922 MiB. Its browser, GPU and
    service processes held 969 MiB, plus 351 MiB in its 5 extension
    processes. That's one look at its tree after the rounds, grouped by
    Chromium's process type.
  - The whole dev Zen held 950 MiB, its content processes included.
- **Ego Lite's background CPU was still settling.** It averaged 80% over
  the minute before the rounds, as its pages loaded, and 24.6% over the
  minute after them. So its per-round CPU depends on the background taken:
  - 3.0 CPU-s against the after-rounds mean;
  - from 0.6 to 3.4 CPU-s against shorter windows just before or after the
    rounds.

  zenius's background stayed near zero, so its 0.51 CPU-s holds.
- **One run each, five rounds.** A round's time has run-to-run noise.
  `bench-comparison.md` has each operation's p50 and p95 over many runs.

## Method

- **Phases:**
  - a warm-up: one `listTaskSpaces()` call, which for Ego Lite is the call
    that starts it;
  - 30 s to settle, then 60 s at rest;
  - five rounds, 5 s apart;
  - another 60 s at rest.
- **A round** is one script, run end to end through each target's CLI
  (`ego-browser nodejs`, `zenius nodejs`), so its time includes the CLI's
  start: `taskSpace(name)`, then `page.goto("https://en.wikipedia.org/wiki/Kyoto")`,
  then `page.snapshot()`, then `task.finish({ keep: [] })`. No task space is
  left open.
- **The process tree:** the processes whose command line holds the app's
  path, or the dev profile's, and every process under them. The sampler never
  records a command line.
  - Memory is the sum of `top`'s MEM over the tree.
  - CPU is the tree's CPU time since the last sample, per process, so a
    process that starts or ends between samples doesn't skew it.
- **CPU per round above the background:** the CPU-seconds over the rounds'
  samples, minus the after-rounds mean times their span, divided by five.
- **Memory added during the rounds:** the highest sample while the rounds ran,
  minus the median of the 20 s before them.
- **RSS isn't used.** On this Mac it swung by up to a factor of six within a
  minute for the same tree, as macOS compressed memory (zenius's tree went
  from 2,150 to 332 MiB), while the footprint moved by under 20%.

Ego Lite's rounds exited 0, and each brought up about 6 processes that closed
after it. Their snapshot lengths weren't recorded: `ego-browser nodejs` writes
a script's output to stderr when stdout isn't a terminal, and the run read
only stdout. zenius's five snapshots were 24,907 characters each. The script
reads both streams now.

## Disk

Disk use wasn't compared, at the user's choice: CPU and memory are what
matter to them, not size (2026-11-22). No disk numbers were taken, and
nothing was downloaded for this comparison.

## Data

The raw samples, every 2 s, each run's summary and the process-type split
are on the Mac, in `~/.zenius-dev/eval/footprint-20261122/`. They aren't in
git.
