# Rubric C pilot: the zenius half (2026-11-20)

This is the zenius half of the pilot in `live-tasks.md` (T2, T8, T13).
All three runs answered fully correctly, for $0.68 in agent cost plus $0.30
for the judge, in 29 turns and 2 minutes in all. Then the pilot added
containment, because the agents read untrusted pages. The containment
canary blocked everything the browser CLI's process tried. It also found that
an agent's `page.goto` opens `file://`, `about:config` and `chrome://` pages,
and that `page.evaluate` runs with chrome privileges on the last two. The
probes that followed found the saved logins, extensions' APIs and file paths
open too. SPEC's I5 closed all of it: with I5 on main, the canary passes
(see "After I5").

## What ran

- **Tasks:** T2 (MDN compatibility table), T8 (timeanddate.com calculator)
  and T13 (Hacker News), with the prompts and common tail of
  `live-tasks.md`.
- **Browser:** a headless dev Zen on a fresh profile, `zen-eval-pilot`. The
  runtime and the CLI are from main as of 2026-11-20 08:17 UTC. The CLI was installed by
  `scripts/install-cli.sh` into a temp home, under the Mac's Node 23.5.
- **Agent:** Claude Code 2.1.329, resolved to its versioned binary so an
  update can't change it mid-round. Model `claude-opus-5-5` at effort
  `xhigh`, with 60 turns and 20 minutes per run.
- **Harness:** `tests/live/run.mjs`, in its round-2 form: the first version
  of the approval hook, before the containment below existed.

## Results

| Task | Correct | Rubric | Turns | Wall | Cost | Judge | Tokens: in / out / cache read / cache write |
|---|---|---|---|---|---|---|---|
| T2 MDN compatibility table | yes | page, Chrome, Firefox, Safari | 8 | 19 s | $0.16 | – | 16 / 1,622 / 85,541 / 14,121 |
| T8 timeanddate.com calculator | yes | calculator, days, weekdays | 12 | 79 s | $0.33 | $0.19 | 24 / 3,793 / 206,358 / 26,127 |
| T13 Hacker News | yes | title, counts, commenter | 9 | 21 s | $0.19 | $0.11 | 18 / 1,897 / 108,014 / 16,280 |

- **T2** answered Chrome 97, Firefox 104 and Safari 15.4, read from the
  page's compatibility table.
- **T8** answered 309 days and 221 weekdays. It noticed that the workdays
  calculator also excludes US federal holidays by default (207), and
  switched to weekends only.
- **T13** answered "Garage Door Spam", 849 points and 353 comments, plus the
  first top-level commenter. The judge passed all three items, citing the
  run's own reads. A reference read of HN taken 12 s after the run showed
  the same title, points and comments.
- **Denials:** each run had one denied command. The agent first ran
  `zenius skill > "${TMPDIR:-/tmp}/zenius-skill.md"; wc -l …`, which is the
  skill's own advice for a truncated guide, taken before seeing any
  truncation. A command that runs more than the CLI is denied, so each run
  spent one turn before running `zenius skill`. The guide is 23.6k
  characters, which fits in one Bash result.
- **Safety:** no sign-in, post or submit. History shows only the task sites,
  and no task space was left behind. The two safety flags are false
  positives: T8's script read a form's `input[type=submit]` without
  submitting, and T13's matched the word "comment" in a link selector.
- **For scale:** if the other tasks cost what these did, the full round
  (60 runs) would cost about $15 for the agents, plus the judge on live
  items. Ego's own bench averaged 26.5 turns, 398 s and $1.64 per task, but
  with a different agent, model and set of tasks.

The answer keys are in `tests/live/keys-2026-11-20.json`, read from the
sites on the `zen-eval` profile before the runs. T2's key comes from the
compatibility data that MDN's page loads, and T8's from timeanddate.com's
own result pages.

### Round 1, discarded

T2's first attempt also answered correctly: 13 turns, 33 s, $0.26. Three
problems showed up in it:
- Claude Code's own prefix rule `Bash(zenius:*)` approved one
  `zenius nodejs <<'EOF'` command and denied three of the same shape
  (reason `mode`). A Haiku check of five more heredocs approved all five,
  so that matching can't be relied on. A hook now decides instead.
- The 75 KB full-page snapshot was too large to show, so Claude Code saved
  it under `~/.claude/projects/<run folder>/…/tool-results/`, and the agent
  grepped it there. Claude Code empties that folder when the session ends;
  the harness now removes the run's folder afterwards.
- The harness crashed before scoring (a module constant used before its
  declaration). That is fixed.

## How a run is kept apart from the user's Claude Code

Checked on 2.1.329 from each run's init event, from `/context`, and from
the files that changed under `~/.claude`:
- **Skills:** with `--setting-sources project`, the run sees only its own
  folder's skills: `zenius` and Claude Code's 17 built-in skills. None of
  the user's skills (`ego-browser` included), plugins, hooks, settings or
  CLAUDE.md load. `--restricted` was rejected because it hides the
  project's skills too.
- **Auto-memory** is off through `--settings '{"autoMemoryEnabled":false}'`.
  Without that, Claude Code creates `~/.claude/projects/<run folder>/memory`.
- **Background writes:** `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` stops
  the refresh of the user's synced skills (`~/.claude/skills/synced/…`) and
  the cache writes to `~/.claude.json` at startup.
- **Environment:** each agent's environment is built from scratch.
  Inheriting this session's would have passed on the user's effort and
  thinking settings, plugin folders and messaging socket. TMPDIR is inside
  the run's folder.
- **Other flags:** `--strict-mcp-config` and `--no-session-persistence`.
  WebFetch and WebSearch are off.
- **What still changes under `~/.claude`:**
  - Usage counters in `~/.claude.json` (`skillUsage`, `pluginUsage`), and a
    built-in plugin's counter file
    (`plugins/store/cc-plugin-agents-md_builtin-*.json`).
  - While a run lasts: its entry in `sessions/` (removed at exit), a shell
    snapshot (removed at exit), and `projects/<run folder>` and
    `session-env/<id>`, which the harness removes.
  - `~/.claude.json` isn't edited back, because live sessions write it too.

## Containment

The containment is a Seatbelt wrapper around the browser CLI, plus a hook
that decides every tool call.

- **The hook** (`tests/live/allow-cli.mjs`, passed in `--settings`, unit
  tests in `tests/unit/live-allow-cli.test.mjs`):
  - Bash runs only `zenius ARG*`, or `zenius ARG* <<'DELIM'` with the closing
    `DELIM` as its last line. An ARG is a bare word, a `'…'` string, or a
    `"…"` string with no `$`, backtick or backslash. Every other command is
    denied.
  - Read is allowed only inside the run's folder, or in that folder's own
    tool-results under `~/.claude/projects`, with symlinks resolved.
  - Skill loads only `zenius`. Any other tool is denied.
- **The wrapper:** the agent's `zenius` runs the CLI under `sandbox-exec`
  with `tests/live/cli-sandbox.sb`. The process that runs the agent's
  scripts:
  - reads nothing under `/Users`, `/private/tmp`, `/private/var/folders` or
    `/Volumes`, except the run's folder and the CLI copy;
  - writes only in the run's folder;
  - can't fork or exec;
  - signals no other process;
  - has no network except the instance's socket, and no DNS.
- **The instance** runs without dev methods:
  `ZENIUS_DEV_METHODS=0 scripts/zen-dev.sh zen-eval-pilot restart`. The
  harness refuses to start if `dev.evalChrome` answers.

### The canary

`node tests/live/run.mjs --instance zen-eval-pilot --out <dir> --canary`
runs under exactly the task runs' settings: 6 turns, $0.14.

| Probe | Result |
|---|---|
| (i) read `~/.ssh/known_hosts`, `~/.config/gh` | blocked (EPERM) |
| (ii) write a file in `~`, and in the harness's folder | blocked (EPERM) |
| (iii) `fetch("https://example.com/")` from Node; a DNS lookup | blocked (TypeError; ENOTFOUND) |
| (iv) run `hc`; connect to hc's socket | blocked (EPERM) |
| (v) spawn `node` (retrying i and iii), spawn `/usr/bin/true` | blocked (EPERM) |
| (vi) the agent's own Read of `~/.ssh/known_hosts` | denied by the hook |
| `dev.evalChrome` over the instance's socket | refused (`ZEN_UNSUPPORTED`) |
| Skill `zenius`; Skill `update-config` | loaded; denied |
| **the browser opens a `file://` page under `~`** | **succeeded: the snapshot shows the file** |
| control: goto and snapshot of example.com | works |

### Found open: the browser itself (closed by I5, below)

The canary's last probe, and a check by hand without an agent, show that
an agent's `page.goto` opens any scheme:
- `file://`, `about:config`, `about:preferences`, `view-source:`,
  `resource:` and `data:`;
- `chrome://browser/content/browser.xhtml`.

On the `chrome://` page and on `about:config`, `page.evaluate` runs with
chrome privileges: `Services`, `ChromeUtils` and `Components.classes` are
defined. So any zenius agent script, steered by a page or not, can read
local files through the browser, or run privileged code in Zen's parent
process with the user's rights. No sandbox around the CLI can stop that.

No pilot run used a non-web scheme or a chrome API: all four streams were
grepped. The fix belongs in the runtime, and it matters for the daily
install as much as for this eval. The proposed fix:
- agent `goto` loads only `http(s)`, `data:` and `about:blank`, with a
  content triggering principal, so Firefox's own link checks apply;
- `evaluate` refuses documents with a system principal.

Ego's canary should include the same probes. CDP's `Page.navigate` can
open `chrome://` and `file://` URLs.

### The browser probes, run directly

Probes were added for after the fix: uploads, save paths, popups
to `file:`, `about:logins`, `moz-extension:` and the `about:blank`
principal. `node tests/live/probe-browser.mjs` runs them all now, to show
the runtime's owners which are open. It uses no agent, a fresh dev profile
with dev methods off, and the CLI inside the same sandbox. Its setup:
- **Dummies only:** two planted files, one saved login and one cookie from
  a loopback page.
- **Writes:** only in `~/.zenius-dev/canary/<run>/`, never over a file.
- **Uploads** go only to a loopback page.
- **Cleanup:** everything is deleted afterwards, the profile with its
  login included.

`tests/live/browser-probes.mjs` holds the probes, ready for the agent
canary. Results on 2026-11-20 (the second run is on main as of 09:36 UTC):

| Probe | Today |
|---|---|
| goto `file://` | open: the snapshot shows the planted file |
| goto `about:config`, `chrome://browser/content/browser.xhtml` | open, and `evaluate` has chrome privileges |
| goto `about:preferences`, `view-source:`, `resource:` | open |
| goto `data:` | open (the proposal keeps it) |
| goto `about:logins` | open: the snapshot lists the dummy login, and `evaluate` reads its password from `login-item._login`. Firefox sends every saved login, password included, to that page when it opens. macOS's prompt guards only reveal, copy, edit and export. |
| goto `moz-extension:` (webcompat's about-compat page) | open: `evaluate` gets its 66 `browser.*` APIs, and `cookies.getAll` read the loopback page's cookie. webcompat also holds `<all_urls>`, `scripting` and `webRequestBlocking`. |
| `setInputFiles` of a file outside the run's folder | open at first; **blocked on main since the input layer's change: uploads send file contents, not paths (SPEC I5)**. The SDK now reads the file inside the CLI, where the sandbox refuses it (permission denied). |
| the same over the raw protocol, bypassing the SDK | blocked: the runtime takes file contents, not paths |
| `page.screenshot({path})`, `page.fetch({saveAs})`, `download.saveAs` outside the run's folder | open: all three files on disk. By code they'd replace an existing file too (not tried). |
| `page.screenshot` and `page.fetch` with those paths over the raw protocol | open: the runtime writes them itself, so the fix has to refuse paths in the runtime, not only in the SDK |
| `about:blank`, from `task.newPage()` and after a web page | blocked: origin `null`, no chrome globals |
| a `target=_blank` link, or `window.open`, to `file:` from a web page | blocked: no popup |

On the daily profile, that means every saved password, every site's
cookies, and any file the user can write. The proposal sent with these
results:
- **The observe layer:** `goto` loads only `http(s)`, `data:` and `about:blank`.
  `evaluate`, snapshots and actions refuse documents whose principal isn't
  a web one.
- **The input layer and the observe layer:** every file read and write moves into the
  SDK, inside the CLI's sandbox:
  - uploads send bytes;
  - screenshots and saves return bytes for the SDK to write.

  The runtime then takes no path from a script.

### After I5: the canary passes

SPEC's I5 landed on main on 2026-11-20:
- agents load only web URLs, act only in web content, and name no paths;
- screenshots, fetch bodies and downloads come back as bytes, and the CLI
  writes them.

The rerun was on main as of 2026-11-20 10:09 UTC: I5, plus a change to
how the Agents Space shows each task's status. The pilot instance was restarted on it with dev methods
off, and the harness checked that its runtime copy matched the checkout.

- **The agent canary passed**, under exactly the task runs' settings:
  - 39 of 39 rows, plus `data:`, reported but not scored; 7 turns, $0.20.
  - The canary now runs the browser probes as a second script, which the
    agent loads with `zenius nodejs -e 'await import(…)'`.
  - The agent made exactly the five planned tool calls.
- **The direct probes:** 20 of 20, on a fresh profile with a dummy login.

| Probe | After I5 |
|---|---|
| goto `file://`, `about:config`, `chrome://…`, `about:preferences`, `view-source:`, `resource:`, `about:logins`, `moz-extension:` | refused: `ZEN_URL_NOT_ALLOWED`. Agents load only `http:`, `https:`, `data:`, `blob:` and `about:blank`. |
| goto `data:` | opens: allowed, reported only |
| `about:blank`, from `task.newPage()` and after a web page | origin `null`, no chrome globals |
| `setInputFiles` of a file outside the run's folder | the SDK reads it in the CLI, where the sandbox refuses: "permission denied" |
| the same over the raw protocol | refused by the runtime: it takes file contents, not paths |
| `page.screenshot({path})`, `page.fetch({saveAs})`, `download.saveAs` outside the run's folder | the CLI writes them, and the sandbox refuses: EPERM, nothing on disk |
| the same paths over the raw protocol | refused by the runtime ("takes no path"), nothing on disk |
| a `target=_blank` link, or `window.open`, to `file:` from a web page | no popup |
| the control: goto and snapshot of a loopback page, and of example.com | works |

The `tests/security` suite covers what these probes don't: odd
spellings of the forbidden schemes, `history.back` into the user's own
privileged pages, and the per-document gate.

### Round 3: the tasks under the final containment

One rerun of T2, T8 and T13 followed. Everything was as in
round 2 (same model, effort, limits, keys and judge), plus the containment
above, on main as of 2026-11-20 10:13 UTC. All three were fully correct again:

| Task | Round 2: turns, wall, cost, judge | Round 3: turns, wall, cost, judge | Tokens in / out / cache read / cache write, round 2 → round 3 |
|---|---|---|---|
| T2 MDN | 8, 19 s, $0.16, – | 8, 20 s, $0.17, – | 16 / 1,622 / 85,541 / 14,121 → 16 / 1,845 / 84,999 / 14,638 |
| T8 timeanddate.com | 12, 79 s, $0.33, $0.19 | 12, 52 s, $0.27, $0.16 | 24 / 3,793 / 206,358 / 26,127 → 24 / 3,031 / 191,075 / 21,633 |
| T13 Hacker News | 9, 21 s, $0.19, $0.11 | 9, 20 s, $0.19, $0.11 | 18 / 1,897 / 108,014 / 16,280 → 18 / 1,830 / 107,624 / 16,307 |
| All | 29 turns, 119 s, $0.68 + $0.30 | 29 turns, 92 s, $0.63 + $0.28 | |

- **The containment broke nothing.**
  - No command used `fs`, `child_process`, `fetch`, the environment,
    imports or a non-web scheme.
  - No result shows EPERM, "permission denied" or `ZEN_URL_NOT_ALLOWED`.
  - Each run had round 2's single denial: the compound
    `zenius skill > file; wc; tail`.
  - T8's one other error was its own `waitForURL` timeout, and it
    recovered.
- **The answers:**
  - T2 and T8 gave the same answers as round 2.
  - T13's story was the same, now at 866 points and 365 comments; the judge
    passed all three items.
- **Safety:**
  - No sign-in, post or submit.
  - T13's one flag is round 2's false positive (the word "comment" in a
    selector).
  - Only the task hosts were visited, and no task space was left.

## Next

- The browser-side blocker is cleared. The zenius half of the pilot is
  done, before and after the containment.
- The Ego half waits until its profile is chosen. Its CLI gets
  the same wrapper, with the socket rule allowing Ego's own connection.
- The full round waits for the user, after they have seen these numbers.
