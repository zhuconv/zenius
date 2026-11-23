# tests/

zen-eval's suites, runnable against Ego Lite (`--target ego`) and against a
zenius dev instance (`--target zenius --instance <name>`), so both browsers run
the same scripts. Each worker keeps its own runtime tests in `tests/<area>/`
(zen-ux: `tests/ux/` and `tests/parse/`); the rest of `tests/` is zen-eval's.

| Path | What | Run |
|---|---|---|
| `fixtures/server.mjs` | Ego's e2e fixture server (ported), `/zoo/` pages, golden DOM replays | `node tests/fixtures/server.mjs --port 8765` |
| `golden/` | Ego's snapshots of fixture pages and live sites (see `golden/README.md`) | `node tests/golden/capture.mjs --target ego` |
| `e2e/` | Ego's real-browser e2e suite, 83 cases, plus zen-eval's own cases; on zenius, against a fresh headless dev instance | `tests/e2e/run.sh` |
| `bench/` | latency benchmarks, 20 iterations, p50/p95 | `node tests/bench/bench.mjs --target ego` |
| `live/` | rubric C: live-site tasks, one fresh Claude Code agent each, scored by script and a blind judge | `node tests/live/run.mjs --instance <name> --keys <json> --judge` |
| `unit/` | checks for the tooling itself, no browser needed; part of `scripts/test-all.sh` | `tests/unit/run.sh` |
| `parse/` | zen-ux's parse check: every script in `runtime/JS` parses as Gecko loads it, so a bad rebase fails in a second with its file and line; no browser needed; part of `scripts/test-all.sh` | `tests/parse/run.sh` |
| `security/` | zen-sdk's escape suite (SPEC I5): zen-eval's browser probes on a headless dev instance, and the canary of the launcher `install-cli.sh --sandbox` writes; part of `scripts/test-all.sh` | `tests/security/run.sh` |
| `lib/targets.mjs` | runs a script on either target | |

The zenius target runs `sdk/bin/zenius` under Node 24 (`ZENIUS_NODE`
overrides; on the Mac, Homebrew's `node@24`). Start the instance first with
`scripts/zen-dev.sh <name> start`.

## e2e

- `e2e/run.sh` runs the zenius target on a fresh headless dev instance of
  its own, in about 2 minutes. It fails unless every case that runs passes;
  the manifest's N/A cases and deliberate differences don't run.
- `e2e/cases/` are Ego's case files at tag v2.2.1, unchanged. `e2e/source.mjs`
  is Ego's prelude; on zenius it changes three things:
  - It renames error codes, markers and default file names (`EGO_X` →
    `ZEN_X`, `[ego-browser:` → `[zenius:`, `ego-browser-shot-` →
    `zenius-shot-`). Configuration knobs (`EGO_BROWSER_*`) keep Ego's names,
    which the zenius SDK reads too, so the prelude's
    `EGO_BROWSER_PAGE_BUDGET=3` caps Pages on both targets.
  - Page bookkeeping uses `task.pages()`.
  - It adds test-only stand-ins for Ego's v1 tab helpers (`openOrReuseTab`,
    `listTabs`, `currentTab`, `closeTab`), its Page ledger file
    (`readPageLedger`) and CDP iframe targets (`__zenFrame`, `js`). They are
    built on the dev runtime's `dev.evalChrome`, so they only work on dev
    profiles.
- `e2e/zen-adapt.mjs` patches the adapt cases that need more than the
  stand-ins, mostly where they use raw CDP. Each patch is an exact-string
  replacement with its reason, and `tests/unit` checks that each still
  matches its case exactly once.
- `ZENIUS_FIXTURE_READS` in `e2e/zen-adapt.mjs` covers the isolated world,
  where the agent's page code can't see a page's own JavaScript objects. On
  zenius, the cases' reads of a fixture page's own objects
  (`window.__fixtureState` and the like) run in the page's own world through
  the dev runtime (`__zenPageWorld`). `tests/unit` checks that every such
  read is moved and nothing else is. Ego runs the cases unchanged.
- A case passes only when its script exits 0 and prints the success line
  carrying the run's nonce, so a launcher that never runs the script can't
  pass anything.
- `e2e/manifest.mjs` says how each case counts for rubric A (SPEC §6) and
  why a case is N/A. `e2e/zen-cases/` holds cases zen-eval adds where Ego's
  suite leaves a v2 API covered only by legacy-helper cases, or where Zen
  needs its own counterpart of a Chromium case (pdf.js). A case's `targets`
  limits where it runs; elsewhere it is N/A.
- Reports: `node tests/e2e/report.mjs baseline <results.json>… --notes
  docs/eval/notes/<name>.md --json docs/eval/<name>.json --out
  docs/eval/<name>.md` merges runs (a case that passes in some and fails in
  others is flaky), and `node tests/e2e/parity.mjs --ego <json> [--zenius
  <json>] --out docs/PARITY.md` maps Ego's API to the cases. The notes files
  hold the written analysis that the generated reports include.

Options: `--only "name,name"`, `--results <path>`, `--include-na` (run N/A
cases on zenius anyway), `--sdk-path <path>` (ego: a checkout's SDK build
instead of the one embedded in Ego Lite), `--keep`.

`e2e/restart-check.mjs --case restart|edge|crash` is the Mac restart check
for the Agents Space.

- It runs on a fresh dev profile. Tasks share the Agents Space.
- `browser.startup.page` and `resume_from_crash` stay at Zen's defaults,
  unless `--startup-page 0`.
- It does two starts, with a clean quit between them or, in the `crash`
  case, a SIGKILL.
- The kill goes only to the pid zen-dev.sh recorded for its instance, once
  that pid's command line shows the instance's profile under
  `~/.zenius-dev`. The user's Zen runs from the same binary.

## bench

`node tests/bench/bench.mjs --target <t> [--iterations 20] [--only name,…]`
writes `bench/out/bench-<target>-<time>.json`;
`node tests/bench/report.mjs baseline <json> [--notes <md>] --out docs/eval/…` renders it.
Warm operations loop inside one script; cold ones spawn a process per sample.
The cursor-motion group matches each call with the page's own input-event
timeline to show where an action's time goes.

The snapshot rows replay live sites' DOM (`golden/ego/dom/`). Those pages
still load their CSS, images and frames from the live hosts, so before a row
whose setup loads a replay, the bench loads that replay until its load event
fires: up to 5 tries of 15 s (`replayWarmup` in the row's result).

- **Zen needs the retries on the GitHub replay.** On a fresh profile, 8 of
  its header images (`github.githubassets.com/assets/platform-….png`,
  `copilot-…`, `changelog-…` and their dark variants) stay incomplete in the
  first one to three documents that load it, so `load` doesn't fire.
  - One document still waited after 200 s.
  - Loading the same URL again doesn't help.
  - curl gets those images in 0.1 s, and the next document gets them at
    once.
  - It happens in a plain tab too, and with the replay's
    `<link rel="preload" as="image">` removed.
- **Without the warm-up,** `snapshot-typical` and `snapshot-large` failed
  their setup on every fresh profile.
- Compare commits on the same profile all the same.

## live

`node tests/live/run.mjs --instance <name> --keys tests/live/keys-<date>.json --tasks T2,T8,T13 --out <dir> [--judge]`
gives each task's prompt (`live/tasks.mjs`, from `docs/eval/live-tasks.md`) to a fresh `claude -p`:
Opus 5.5 at effort xhigh, 60 turns and 20 minutes. It scores each run three ways: fixed items by
script against the keys, trajectory items against the profile's history, and live items by a
judge that sees no target's name. `--target ego` runs the same tasks on the
running Ego Lite.
- **Before any round,** run `--canary` under the same settings: it tries what the containment
  must block, and a control that must still work. `live/canary.mjs` covers the CLI's sandbox and
  the hook; `live/browser-probes.mjs` covers the browser, run as a second script the agent loads
  from its folder. `--smoke` checks the wiring
  with one cheap agent.
- **The instance** must run without dev methods, on this checkout's runtime:
  `ZENIUS_DEV_METHODS=0 scripts/zen-dev.sh <name> restart` after every pull. The harness compares
  the profile's runtime copy with `runtime/`, and refuses to start on either count.
- **The agents read untrusted pages,** so:
  - `live/allow-cli.mjs` decides every tool call, as a PreToolUse hook passed in `--settings`.
    Bash runs only the zenius CLI, pointed at the run's own launcher by its path (Claude Code's
    Bash tool sources the user's shell snapshot, whose PATH could find their own `zenius` first)
    and kept on the run's instance. Read stays in the run's temp home, and Skill loads only zenius.
  - The agent's `zenius` is the sandboxed launcher the user chose (`scripts/install-cli.sh
    --sandbox`, on Homebrew's node@24 on the Mac), installed into each run's temp home. Its CLI
    reads only the CLI copy, the instance registry, the run's working folder and its own
    temporary and output folders, writes only those two, starts no process, and connects only to
    the instance's socket. Each run checks, before its agent starts, that the launcher grants
    the working folder, and afterwards that every allowed command started that launcher.
- **Isolation:** each run gets a fresh temp home in `--out`. Its working folder holds only
  `.claude/skills/zenius`, the install's link to its CLI copy's Skill, and the run checks that the
  skill came from there, not from the user's own install. Its environment is built from scratch.
  `--setting-sources project` keeps the user's skills, plugins, hooks, settings and CLAUDE.md
  out. `docs/eval/live-pilot.md` has the checks.
- **Without a model:** `--claude tests/live/stand-in-agent.mjs` runs `--smoke` or `--canary`
  with a scripted stand-in for Claude Code. It follows the prompt's steps through the same hook,
  with a decoy `zenius` first on its PATH. `--local-control` loads the canary's control page from
  loopback instead of example.com, and `--node` names the launcher's Node 24 off the Mac.
- **The browser** runs outside that sandbox. `live/browser-probes.mjs` asks what an agent's script
  can still reach through it, and `node tests/live/probe-browser.mjs` runs those probes without an
  agent. It uses planted dummies under `~/.zenius-dev/canary/`, a dev profile with dev methods
  off, and only loopback pages, and deletes everything afterwards.
- **The allow rule** for the sandboxed launcher (`install-cli.sh --sandbox`) is `Bash(zenius:*)`
  with dontAsk. `node tests/live/allow-rule.mjs` checks, with one cheap headless Claude Code run,
  that the rule lets `zenius` commands run and nothing that runs another program or picks another
  `zenius`: variable prefixes, `env`, chained commands. Rerun it when Claude Code updates.
- **Output:** the raw streams stay in `--out`. `summary.json` and `summary.md` hold the scores,
  timings, tokens and answers. The CLI is installed into each run's temp home there, never
  `~/.zenius` or `~/.local/bin`.
