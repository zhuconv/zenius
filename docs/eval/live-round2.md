# Rubric C, round 2: zenius and Ego Lite (2026-11-21)

zen-eval ran round 2 of `live-tasks.md` on both targets on 2026-11-21, 23:14 to 23:46 UTC,
on zenius 9abcd8e. Each of the 15 tasks ran once on each target, the two runs back to back,
in the opposite order from round 1. Gutenberg was down again, so T9 ran in neither round.
Fourteen tasks ran on both targets, and every run was a full success.

## Results

### Each round

| Round | Target | Full successes, judged | After hand checks | Items passed, judged | Mean turns | Mean wall time | Agent cost | Judge cost |
|---|---|---|---|---|---|---|---|---|
| 1 | zenius | 14/14 | 14/14 | 100.0% | 10.2 | 42 s | $3.31 | $1.20 |
| 1 | Ego Lite | 12/14 | 13/14 | 94.0% | 10.9 | 44 s | $3.40 | $1.17 |
| 2 | zenius | 14/14 | 14/14 | 100.0% | 10.6 | 65 s | $3.46 | $1.26 |
| 2 | Ego Lite | 14/14 | 14/14 | 100.0% | 11.6 | 61 s | $3.56 | $1.19 |

### Both rounds pooled

| | zenius | Ego Lite | Fisher's exact test, two-sided |
|---|---|---|---|
| Full successes, judged | 28/28 | 26/28 | p = 0.49 |
| Full successes, after hand checks | 28/28 | 27/28 | p = 1.0 |

**Twenty-eight runs a target are still too few for 28 against 26, or 28 against 27, to be
a real difference.** Both targets did every task in round 2. Ego's two misses in round 1
were a prompt that read two ways (T4) and a judge that couldn't see screenshots (T10).
Neither was the browser's, and round 2 fixed both. The two rounds show that both targets
can do these tasks. They can't rank them.

### Round 2, task by task

The times are wall-clock times on the user's Mac while the user worked on it throughout.
Treat them as rough. Turn counts don't depend on the load.

| Task | First | zenius | turns | wall | cost | Ego | turns | wall | cost |
|---|---|---|---|---|---|---|---|---|---|
| T1 | zenius | yes | 9 | 36 s | $0.25 | yes | 17 | 202 s | $0.37 |
| T2 | Ego | yes | 8 | 29 s | $0.19 | yes | 8 | 25 s | $0.20 |
| T3 | zenius | yes | 14 | 315 s | $0.35 | yes | 14 | 59 s | $0.28 |
| T4 | Ego | yes | 11 | 37 s | $0.25 | yes | 10 | 45 s | $0.24 |
| T5 | zenius | yes | 9 | 24 s | $0.20 | yes | 11 | 41 s | $0.21 |
| T6 | Ego | yes | 10 | 60 s | $0.23 | yes | 10 | 46 s | $0.22 |
| T7 | zenius | yes | 9 | 39 s | $0.20 | yes | 13 | 66 s | $0.28 |
| T8 | Ego | yes | 13 | 67 s | $0.29 | yes | 14 | 80 s | $0.32 |
| T10 | Ego | yes | 8 | 24 s | $0.17 | yes | 11 | 38 s | $0.22 |
| T11 | zenius | yes | 10 | 41 s | $0.27 | yes | 14 | 74 s | $0.30 |
| T12 | Ego | yes | 20 | 101 s | $0.39 | yes | 10 | 40 s | $0.21 |
| T13 | zenius | yes | 9 | 34 s | $0.20 | yes | 10 | 43 s | $0.22 |
| T14 | Ego | yes | 9 | 56 s | $0.25 | yes | 10 | 48 s | $0.23 |
| T15 | zenius | yes | 9 | 44 s | $0.23 | yes | 10 | 49 s | $0.24 |

- **Round 2's runs took longer than round 1's on both targets**, with about the same
  number of turns. Two runs account for most of it: zenius's T3 (315 s) and Ego's T1
  (202 s). The transcripts' timestamps split each run into tool calls and the model's
  turns between them, and most of both runs was the model's:
  - zenius's T3: 245 s of 309 s between tool calls, in turns of up to 91 s. Its tool
    calls took 61 s. One of them took 50 s: the agent's locator for the search box was
    invalid, so no search ran, and the script's two waits ran out the 20 s and 30 s
    timeouts the agent gave them.
  - Ego's T1: 151 s of 200 s between tool calls, one turn of 89 s among them. Its tool
    calls took 46 s.
- **T9 (Gutenberg):** site down for both targets, HTTP 503 ("Temporarily Down for
  Maintenance") at 23:46:38 UTC, as before the round (22:53 and 22:56). T9 has run in
  neither round.
- **Costs:** the agents $3.46 (zenius) and $3.56 (Ego); the judge $1.26 and $1.19; the
  canary $0.22. The whole round cost $9.69.

## Hand checks

No judged item failed, so there was no miss to check. I checked a sample of passes on
both targets for false passes.

- **The judge's images.** The judge saw 5 images, in three runs: Ego's T10 and T11, and
  zenius's T12. In Ego's T10 it passed `table2` citing the screenshot of page 8. That
  screenshot, taken from the agent's own transcript, shows Table 2 with
  "Transformer (big)" at 28.4 EN-DE and 41.8 EN-FR, as the judge and the answer say.
  This is the item round 1's judge failed for want of the image.
- **T12, T13 and T15, round 1's sample.** For each, I looked for every value the answer
  gives in what the tools printed (the tool results only, not the agent's own words):
  - T12: the select's values and texts before and after: Volvo, Audi, the edited "Zen"
    option (its value still "volvo"), Saab, Opel.
  - T13: the #10 story's title, 441 points, 218 comments and the first commenter.
  - T15: Firefox 160.0.1, November 17, 2026, Chrome 158.0.8127.36 (".36/.37" on Windows
    and Mac, as the blog writes it), and the newer "Early Stable" post the answers
    rightly leave out.

Every value is in the tool output on both targets, and the two targets' answers agree on
all of them. The sample has no false pass.

## What else the runs show

- **T4 now reads one way.** Both agents searched the exact phrase and matched the key: 47
  results, the first "Multi-Candidate Speculative Decoding".
- **A wait that an error in the page ended, in zenius's T3.** zenius's agent submitted a
  search, then waited for the results with `waitForFunction`.
  - Its function read `document.body.innerText`. It first ran in the results page
    before that page had a body, so it threw "document.body is null".
  - The wait ended at once with that error, which zenius reports as the page's own, and
    didn't poll on. The agent guarded the read and waited again, which worked at once.
    It cost one step.
  - Whether a wait should poll on past such an error is with zen-observe.
- **Ego runs in the user's own profile, whose settings can add text to pages.** In T13,
  Ego's agent noticed lines its browser had added to the page and gave the page's own
  text.

## Method

As in round 1 (`live-round1.md`, "Method"), except for what this section lists.

### The agent

Claude Code 2.1.330 with Opus 5.5 at effort xhigh, as in round 1, for every run and for
the judge. Each run allows 60 turns and 20 minutes. The isolation, the one Skill per run,
WebFetch and WebSearch off, and the prompt with its common tail are round 1's.

### The targets

- **zenius at 9abcd8e**, main when the round started. It has zen-observe's fix for a
  `goto` to a `#fragment` (9b85f61), and test-all was green on it. Without that fix, such
  a `goto` held the next call for 15 s.
  - The round used 9abcd8e's runtime, SDK and scripts, which the round checked were
    identical to 9abcd8e's at its start, with round 2's harness commits on top (local
    branch `zen-eval/round2-9abcd8e`, dce8dc4).
  - It ran on a headed dev Zen (profile `zen-eval-r2`, new for the round) behind the
    user's windows, with no developer methods, and each run installed the sandboxed
    launcher into its own temp home, as in round 1.
  - The containment canary passed on that Zen right before the round: 44 checks passed
    and none failed (8 turns, $0.22).
- **Ego Lite 0.6.3.17**, the user's own app and profile, as in round 1, uncontained by the
  user's choice. Before the round, the smoke run with a stand-in agent checked the Ego
  wiring: it opened one task space on example.com, closed it, and its screenshot was
  removed.

### Round 2's fixes

These are round 1's "Fixes for round 2".

- **T4 names the exact phrase.** The prompt now asks for "papers with the exact phrase
  'speculative decoding' in the title". Its key is the phrase's: 47 results, the first
  "Multi-Candidate Speculative Decoding" (arXiv:2401.06706), the same at 50 and at 100
  results per page.
- **The judge sees the images the agent read.**
  - Each image a tool returned follows the step that returned it, labeled with its step,
    in the judge's one message. The step's text still shows "[image]" where it was.
  - The judge gets at most the last 20 images, and whole steps from the end within round
    1's text limit. An image left out says why, where it would have been.
  - Before the round, the new judge re-graded five of round 1's saved runs:
    - Ego's T10: `table2` now passes, citing the screenshot of page 8. That is round 1's
      hand check.
    - Ego's T11 and T7 (with images), zenius's T13 and Ego's T15 (text only): every
      verdict stayed the same.
- **T9: the site first.** gutenberg.org answered HTTP 503 ("Temporarily Down for
  Maintenance") at 22:53 and 22:56 UTC, before the round. So T9's key stayed pending, and
  T9 ran last, behind its site check, as in round 1. A hook would have recorded the key
  first had the site come back by T9's turn.

### Keys

Recorded from 22:57 to 22:59 UTC, before the round, by zen-eval's own scripts (not an
agent) on a fresh headless dev profile (`tests/live/keys-2026-11-21-r2.json`). Every key
script other than T4's printed exactly what it printed for round 1, so those keys are
round 1's. T8's is carried over, as before.

### Order

Swapped from round 1: zenius ran first on odd tasks and Ego on even ones. Each task's two
runs went back to back.

### The Mac during the round

- The user worked on the Mac throughout, by their choice, in their own Zen and other
  apps. As in round 1, they waived the idle wait. The lock, call and screen-share checks
  stayed, and the round never had to wait for them.
- At the round's start, the user put a harmless word on the pasteboard, since Ego's
  `keyboard.paste()` reads the pasteboard to restore it afterwards.
- The dev Zen's window opened at 23:13:22 UTC, while another app was in front.
  - The focus guard handed the front back once, at 23:13:25, as the window opened.
  - No canary probe or task run brought the dev Zen forward. In round 1 that happened
    8 times, 7 of them at the window's start and during the canary.
- A display-sleep assertion kept the Mac awake for exactly the round's length.

### Grading

As in round 1:
- Fixed items are checked by script against the keys.
- Trajectory items are checked against the run's own tool log.
- Live items are graded by the judge against the run's tool log, now with the images the
  agent read.

Both targets are judged by their own tool logs only.

## Safety and cleanup

- **No sign-in, post or buy.** The safety flags are keyword matches for a person to read:
  6 on zenius and 10 on Ego. I read them all.
  - In T13 and T15, they matched "comment" and "post" in CSS selectors while the agents
    read.
  - In T4 and T8, the agents clicked the submit button of arXiv's search form and of the
    date calculator, which the rules allow.
- **Every task space closed.** No run left a task space, on either target. The Ego smoke
  run closed its one.
- **Denials were the same on both targets.** In all 28 runs, the agent first tried to
  save its CLI's Skill text to a temp file in one compound command. The hook allows one
  plain command, so it refused, and the agent ran `skill` alone. Nothing else was denied.
- **Ego's temp images:** 8 removed after their runs (T1 three, T8 one, T10 two, T11 two),
  plus the smoke run's one. Each was removed by the literal path its tool log names,
  after checking that it was a plain image file created since the run began.
- **The pasteboard:** the round never read or wrote it. It compared only its
  changeCount, which went from 21564 to 21574 while the user worked.
  - It moved six times during runs: five times in zenius's T1 and once in Ego's T2.
  - Each time, the run's scripts had no clipboard or paste call, only loads, clicks,
    waits and reads. At those seconds the user was switching between their own apps.
  - In T12, zenius's agent pasted "Zen" with `keyboard.paste`, and the count didn't move
    during that run. zenius's paste uses the task Space's own clipboard and never the
    system's.
  - No Ego script in the round called paste or the clipboard.
- **The user's Zen:** the guards' snapshot covers Zen's data folder outside the user's
  profile, its update folder and Zen's LaunchServices entries. Across the round, only
  the update folder's lock file changed, as in every run. The dev Zen had its own
  profile.

## Appendix: the scripts the agents ran

The hook kept every command it allowed, one file each, numbered in order, in the run's
results (`<task>.scripts/`). Ego's include the full text of each `ego-browser nodejs`
script.

| Task | Ego | zenius |
|---|---|---|
| T1 | 10 | 5 |
| T2 | 4 | 4 |
| T3 | 10 | 10 |
| T4 | 6 | 7 |
| T5 | 7 | 5 |
| T6 | 6 | 6 |
| T7 | 9 | 5 |
| T8 | 10 | 9 |
| T10 | 5 | 4 |
| T11 | 8 | 6 |
| T12 | 6 | 15 |
| T13 | 6 | 5 |
| T14 | 6 | 5 |
| T15 | 6 | 5 |
| Total | 99 | 91 |

The round's raw results (round.json and round.md, each run's summary, hook log and
scripts, and the agents' transcripts) stay out of this repository: they hold paths and
session details from the user's Mac.
