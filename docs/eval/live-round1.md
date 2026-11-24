# Rubric C, round 1: zenius and Ego Lite (2026-11-21)

zen-eval ran round 1 of `live-tasks.md` on both targets on 2026-11-21, 19:24 to 19:50 UTC.
Each of the 15 tasks ran once on each target, the two runs back to back. Gutenberg was
down, so T9 didn't run and moves to round 2. Fourteen tasks ran on both targets.

## Results

Two scores: the judge's, as the round ran, and the score after my hand checks.

| Target | Full successes, judged | After hand checks | Items passed, judged | Mean turns | Mean wall time | Agent cost |
|---|---|---|---|---|---|---|
| zenius | 14/14 | 14/14 | 100% | 10.2 | 42 s | $3.31 |
| Ego Lite | 12/14 | 13/14 | 94.0% | 10.9 | 44 s | $3.40 |

**Fourteen tasks are too few for 14 against 12, or 14 against 13, to be a real
difference.** A two-sided Fisher's exact test gives p = 0.48 for 14/14 against 12/14, and
p = 1.0 for 14/14 against 13/14. This round shows that both targets can do these tasks. It
can't rank them. Neither of Ego's two misses was the browser's (next section).

The per-task times and costs are below. They are wall-clock times on the user's Mac
while the user worked on it throughout: treat them as rough. Each task's two runs went back
to back, so that load fell on both alike. Turn counts don't depend on the load.

| Task | First | zenius | turns | wall | cost | Ego | turns | wall | cost |
|---|---|---|---|---|---|---|---|---|---|
| T1 | Ego | yes | 12 | 58 s | $0.26 | yes | 14 | 52 s | $0.33 |
| T2 | zenius | yes | 8 | 29 s | $0.18 | yes | 8 | 23 s | $0.18 |
| T3 | Ego | yes | 12 | 39 s | $0.26 | yes | 12 | 45 s | $0.29 |
| T4 | zenius | yes | 12 | 74 s | $0.35 | no | 11 | 46 s | $0.25 |
| T5 | Ego | yes | 10 | 27 s | $0.20 | yes | 10 | 28 s | $0.20 |
| T6 | zenius | yes | 8 | 27 s | $0.19 | yes | 8 | 27 s | $0.17 |
| T7 | Ego | yes | 7 | 24 s | $0.17 | yes | 11 | 52 s | $0.24 |
| T8 | zenius | yes | 11 | 61 s | $0.27 | yes | 15 | 72 s | $0.32 |
| T10 | zenius | yes | 8 | 23 s | $0.17 | yes (by hand; judged no) | 11 | 30 s | $0.24 |
| T11 | Ego | yes | 11 | 45 s | $0.27 | yes | 16 | 72 s | $0.36 |
| T12 | zenius | yes | 16 | 72 s | $0.33 | yes | 11 | 47 s | $0.20 |
| T13 | Ego | yes | 9 | 28 s | $0.19 | yes | 8 | 30 s | $0.18 |
| T14 | zenius | yes | 9 | 35 s | $0.24 | yes | 9 | 41 s | $0.23 |
| T15 | Ego | yes | 10 | 45 s | $0.23 | yes | 9 | 45 s | $0.22 |

T9 (Gutenberg): site down for both targets, HTTP 503 ("Temporarily Down for
Maintenance") at 19:49:44 UTC. It moves to round 2, with no substitute task.

Costs: the agents $3.31 (zenius) and $3.40 (Ego); the judge $1.20 and $1.17; the canary
$0.26. The whole round cost $9.34.

## Hand checks

I checked Ego's two misses, and a sample of passes on both targets for false passes.

### Ego's misses

- **T4, an ambiguous prompt.** The prompt asks for "papers whose title contains
  'speculative decoding'". The key took the two words, unquoted: 50 results, the first
  "SPEED: Speculative Pipelined Execution for Efficient Decoding". zenius's agent typed them
  unquoted and matched the key. Its answer also named the first exact-phrase match. Ego's
  agent quoted the phrase: 47 results, the first "Multi-Candidate Speculative Decoding"
  (arXiv:2401.06706). That is a fair reading of the prompt, and its answer is right for it.
  Both runs used the right form, field, category, dates and order; the trajectory items
  pass. T4 stays a miss for Ego, since the key decides fixed items, but it says nothing
  about the browser. If either reading counts, Ego is 14/14 as well: zenius's answer
  covered both readings, and Ego's is right for its own. The tables keep the key's strict
  score, so both are on the page.
- **T10, the judge can't see screenshots.** The judge grades live items from the run's
  tool log, where an image shows only as "[image]". zenius's agent read Table 2 as text.
  Ego's agent read it from a screenshot of page 8, so the judge couldn't confirm it and
  failed `table2`. The screenshot, taken from the agent's own transcript, shows Table 2
  with "Transformer (big)" at 28.4 EN-DE and 41.8 EN-FR, as Ego's answer says. Its `bleu`
  item (28.4) passed. By hand, T10 passes for Ego. No other judged fail rested on an
  image.

### False passes: a sample, on both targets

T12, T13 and T15 hold ten judged items per target. For each, I looked for every value the
answer gives in what the tools printed (the tool results only, not the agent's own words):

- T12: the select's values and texts before and after: volvo, Audi, the edited "Zen"
  option, Saab, Opel. Ego's log shows the edit applied, then the options read back.
- T13: the #10 story's title, 94 points, 18 comments (written with a no-break space) and
  the first commenter.
- T15: Firefox 160.0.1, November 17, 2026, Chrome 158.0.8127.36, and the newer "Early
  Stable Update" post the answers rightly leave out.

Every value is in the tool output on both targets, and the two targets' answers agree on
all ten items. The sample has no false pass.

## Fixes for round 2

- **T4:** say which reading is meant, for example "papers with the exact phrase
  'speculative decoding' in the title". Or record both keys (47 for the phrase, 50 for the
  words) and accept either answer that names its reading.
- **The judge:** give it the images the agent read, from the transcript, next to the
  "[image]" steps. Until then, check by hand every judged fail that rests on an image, as
  here.
- **T9:** check the site before round 2, as round 1 did. If it's up, record the key first.

Round 2 applied all three (`live-round2.md`, "Round 2's fixes").

## Method

Rubric C (`docs/eval/live-tasks.md`): 15 tasks on public sites, each run by a fresh agent
with one browser skill, on two targets. This is round 1 of two.

### The agent

- Claude Code 2.1.330 with Opus 5.5 at effort xhigh, the same for every run and for the
  judge. Each run allows 60 turns and 20 minutes.
- Each run starts a fresh agent in its own empty working folder. It sees one Skill, the
  target's, and none of the user's skills, settings, plugins, hooks or CLAUDE.md
  (`--setting-sources project`). Each run checks that the Skill it loaded was the run's
  own.
- WebFetch and WebSearch are off, so the browser is the only way to the web.
- Both targets get the same prompt: the task's prompt plus the common tail "Use the
  browser skill. Do not sign in, post, buy or submit anything except search and filter
  forms. When done, end your task and give the answer in one short paragraph."

### The targets

- **zenius, a 0.1.0 release candidate of 2026-11-21 (18:36 UTC)**, the build the user gets
  next. The round used its runtime, SDK and scripts, which the round checked were identical
  to the build's at its start, with the harness's `tests/live` commits on top. It ran on a
  headed dev Zen (profile `zen-eval`, new for the round) behind the
  user's windows, with no developer methods.
  - Each run installs the sandboxed launcher (`install-cli.sh --sandbox`) into its
    own temp home: the agents read untrusted pages, so their scripts run contained.
  - The containment canary passed on that Zen right before the round: 44 checks passed
    and none failed (8 turns, $0.26).
- **Ego Lite 0.6.3.17**, the user's own app and profile, through its own `ego-browser`
  CLI. Each run's folder holds a copy of Ego's Skill, unchanged, with Ego's MIT notice
  beside it.
  - **Ego ran uncontained, as it ships.** Ego runs each script in its own Node helper, a
    child of the Ego Lite app, outside any sandbox of ours. So Ego's containment canary
    is recorded as failing by design. The probe of 2026-11-21 showed that a script there
    can start processes.
  - Before the round, a smoke run with a stand-in agent checked the Ego wiring. It opened
    one task space on example.com, closed it, and removed its screenshot.
  - Its window may come to the front during its runs. Its `keyboard.paste()` reads the
    user's pasteboard to restore it afterwards.

### The same limits on both targets

A PreToolUse hook decides every tool call on both targets:
- Bash runs only the target's CLI, as one plain command. On Ego, that means only the
  subcommands browser work needs: `skill`, `help`, `--version` and `nodejs`. Its `import`,
  `upgrade` and `--ego-server-name` never run.
- Read is limited to the run's own folder. On Ego it also takes the images an Ego script
  saved in the temp folders since the run began: Ego saves a screenshot at the absolute
  path the script names, or in the system temp folder. zenius's screenshots land in the
  run's own folder. Ego's images are deleted after the run, each by the literal path its
  tool log names.
- Skill loads only the target's Skill. Every other tool is denied.

Every command the hook allowed, scripts included, is kept with the run's results. The
appendix counts them.

### Order

Each task's two runs go back to back, so live answers come from about the same site
state. Round 1 started with Ego on odd tasks and with zenius on even ones; round 2 swaps.
Before each run, the round waits while the screen is locked, a call is on, or the screen
is shared. It never had to wait.

### The Mac during the round

- The user worked on the Mac throughout, in their own Zen and other apps. Our headed
  tests normally wait for the user to be idle before a window opens; that wait was off
  for this round, so the round could run while they worked. The lock, call and
  screen-share checks stayed.
- The dev Zen's window opened only while an app other than Zen was in front. The focus
  guard handed the front back whenever the dev Zen came forward: 8 times, each at once. Seven were at the window's start and during the canary, whose probes open
  popups and downloads on purpose. One came during an Ego run, at a moment that suggests
  the user was switching to their own Zen: with two Zens open, the Dock and ⌘-Tab show two
  Zen icons. No ordinary task run brought the dev Zen forward.
- A display-sleep assertion kept the Mac awake for exactly the round's length.

### Grading

- **Fixed items:** checked by script against answer keys recorded from the sites on
  2026-11-21, before the round (`tests/live/keys-2026-11-21.json`).
- **Trajectory items** (for example, that the run opened the German article): checked
  against the run's own tool log, meaning its commands and what they printed.
- **Live items:** graded by the judge, with a fixed prompt and the same model, against the
  run's tool log. The judge sees the task, the rubric, the final answer and the log, with
  the targets' names replaced by "browser".
- **Both targets are judged by their own tool logs only. This is a change from the pilot,
  for fairness.** In the pilot, trajectory items and the judge also saw the URLs zenius's
  profile visited, read from its history. Ego's history may not be read. Giving that list
  to zenius alone would have been extra evidence for zenius only. zenius's history list
  stays in its results, as information.
- Where the two targets' grades on an item differ, I checked both transcripts by hand
  (above).

## Safety and cleanup

- **No sign-in, post or buy.** The safety flags are keyword matches for a person to
  read, and I read them all. T4 and T8 (both targets) clicked the submit button of a search
  form and of a date calculator, which the rules allow. T13 (zenius) and T15 (both)
  matched the words "comment" and "post" in CSS selectors while reading.
- **Every task space closed.** No run left a task space, on either target. The Ego smoke
  run closed its one.
- **Denials were the same on both targets.** In 27 of 28 runs, the agent first tried to
  save its CLI's Skill text to a temp file in one compound command
  (`… skill > file; wc -l file; tail -3 file`). The hook allows one plain command, so it
  refused, and the agent ran `skill` alone. Ego's T13 run didn't try. Nothing else was
  denied.
- **Ego's temp images:** 6 removed after their runs (T1, T7, T10 two, T11 two), each by
  the literal path its tool log names, after checking it was a plain image file created
  since the run began.
- **The pasteboard:** the round never read or wrote it; it compared only its
  changeCount. That went from 21453 to 21484 while the user worked and copied. Each move
  is listed in the run's results next to the script that ran last before it. That is not
  a cause. One is worth naming: in T12, zenius's agent pasted "Zen" into the code editor
  with `keyboard.paste`. zenius's paste uses the task Space's own clipboard and never the
  system's (`runtime/JS/zenius/methods/actions.sys.mjs`). The count moved 6 s later, the
  second the user brought their own Zen to the front. No Ego script in the round called
  paste or the clipboard.
- **The user's Zen:** the guards' snapshot covers Zen's data folder outside the user's
  profile, its update folder and Zen's LaunchServices entries. Across the round, only the
  update folder's lock file changed, as in every run. The user's profile itself is outside
  the snapshot, since their Zen was open and in use. The round never wrote to it: the
  dev Zen had its own profile.

## Appendix: the scripts the agents ran

The hook kept every command it allowed, one file each, numbered in order, in the run's
results (`<task>.scripts/`). Ego's include the full text of each `ego-browser nodejs`
script.

| Task | Ego | zenius |
|---|---|---|
| T1 | 9 | 8 |
| T2 | 4 | 4 |
| T3 | 8 | 8 |
| T4 | 7 | 8 |
| T5 | 6 | 6 |
| T6 | 4 | 4 |
| T7 | 6 | 3 |
| T8 | 11 | 7 |
| T10 | 5 | 4 |
| T11 | 10 | 7 |
| T12 | 7 | 12 |
| T13 | 5 | 5 |
| T14 | 5 | 5 |
| T15 | 5 | 6 |
| Total | 92 | 87 |

The round's raw results (round.json and round.md, each run's summary, hook log and
scripts, and the agents' transcripts) stay out of this repository: they hold paths and
session details from the user's Mac.
