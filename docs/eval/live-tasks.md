# Rubric C: live-site tasks (proposal, for zen-manager's review)

SPEC §6 C asks for live-site tasks with per-task rubrics, like Ego's
Real-World Bench, run by the same agent and model with each skill and scored
on success, rubric average, turns, wall time and tokens. The target is zenius
≥ Ego Lite.

Ego's own bench has 31 tasks. Each tool ran with the same agent, model, judge
and step limits, and a task counts as a full success only when every rubric
item is met. Ego reports turns, rubric average, perfect rate, trajectory
efficiency, duration and cost. Its task list isn't published, so these 15
tasks are ours. Nothing runs before you approve them.

## Decisions needed

1. **The task list below.** Edit freely. S1–S3 are spares in case a site
   walls off automated visitors.
2. **Agent and model.** Proposal: Claude Code (`claude -p --output-format
   json`, version pinned) with one fixed model and effort for every run, for
   example Opus 5.5.
3. **zenius's window.** For the scored runs, proposal: a headed dev Zen on the
   kept `zen-eval` profile. It sits behind other windows, as Ego's window
   does while its task spaces run. All runs together take about 7 hours, over
   two or three sittings, so the user should OK it. The pilot can run
   headless.
4. **Ego runs in the user's Ego Lite profile.** These sites' cookies and
   history entries land there. A task space shares its profile's cookie jar
   and HTTP cache with the user's own tabs (Ego's
   `references/clearing-state.md`). If the user is signed in to one of these
   sites in Ego, that run notes it; no task needs an account. Is this
   acceptable? Alternatively the user can create a second Ego profile for
   the runs: the user's Ego Lite has one profile today (`Profile 1`), and
   Ego's `createTaskSpace(name, profileId)` can target another.
5. **Cost.** 15 tasks × 2 targets × 2 rounds = 60 agent runs. A pilot of 6
   runs measures cost and time first. For scale, Ego's bench averaged 26.5
   turns, 398 s and $1.64 per task, with a different agent and model.

## How the runs work

- **Safety.**
  - Every task is read-only on a public site: no sign-in, posting, purchase,
    or form that changes anything (search and filter forms are fine).
  - The one download (T9, under 1 MB) goes to a temporary folder and is
    deleted after the run.
  - The prompt says all of this, and the harness checks the trajectory for it.
- **One skill per run.**
  - Each run starts a fresh agent in an empty working folder that sees only
    one browser skill: Ego's `ego-browser`, or zenius's `skill/zenius`.
  - WebFetch and WebSearch are off, so the browser is the only way to the
    web.
  - The pilot settles how the user's own skills are hidden (a separate
    config folder or settings file). Each transcript is checked to show that
    only its skill loaded.
- **The same prompt for both targets.**
  - Each run gets the task's prompt, plus a common tail: "Use the browser
    skill. Do not sign in, post, buy or submit anything except search and
    filter forms. When done, end your task and give the answer in one short
    paragraph."
  - Both skills end a task with `finish()`. The harness lists task spaces
    before and after each run and reports any left behind, apart from the
    score.
- **Limits.** 60 agent turns and 20 minutes per run. A run that hits a limit
  keeps the rubric items it met.
- **Rounds and order.**
  - Two rounds per target.
  - For each task, the two targets run back to back, so live answers come
    from about the same site state.
  - Round 1 starts with Ego on odd tasks and with zenius on even ones; round 2
    swaps.
- **Grading.**
  - Each rubric item passes or fails.
  - **Fixed** items are checked by script against an answer key recorded
    from the sites before the runs, which you review.
  - **Live** items are graded by a judge model (fixed prompt and model)
    against the run's own page reads. The judge sees the task, the rubric,
    the final answer and the tool log with the skill names replaced by
    "browser", so it can't tell the targets apart.
  - If the two targets give different answers to the same live item, I check
    the transcripts by hand and say so in the report.
- **Measures, per run (from the CLI's JSON):**
  - full success (every item);
  - rubric average;
  - turns (`num_turns`);
  - wall time (`duration_ms`);
  - tokens (input, output and cache);
  - cost.

  The report gives them per task and pooled, in the shape of
  `docs/eval/bench-comparison.md`.
- **Privacy.** Transcripts stay in local scratch. Committed results hold
  scores, timings and the answers. Account names, and anything a signed-in
  page shows, are scrubbed.
- **Pilot.** T2, T8 and T13 (fixed, fixed and live), on both targets, one
  round: 6 runs. They calibrate the limits, the judge and cost. The full run
  follows if you say go.

## Tasks

Each task lists its prompt, what it exercises, and its rubric. Answers
marked fixed have an answer key; live ones are judged from the run.

### T1. Wikipedia: infobox and language menu (fixed)

Prompt: "Open the English Wikipedia article on the Rhine. Report the river's
length and the countries listed in its infobox. Then use the article's
language menu to open the German article, and report the length it gives."

Exercises: search with suggestions, infobox extraction, a popup language
menu, a cross-site navigation.

1. English length as in the infobox.
2. Every country in the infobox, no extra ones.
3. Reached the German article (de.wikipedia.org, "Rhein").
4. German length as in its infobox.

### T2. MDN: browser-compatibility table (fixed)

Prompt: "On MDN, find the reference page for Array.prototype.findLast(). From
its browser compatibility table, report the first version of Chrome, Firefox
and Safari that supports it."

Exercises: site search, a long reference page, a script-built table read by
column.

1. Reached the findLast() reference page.
2. Chrome version.
3. Firefox version.
4. Safari version.

### T3. Python docs: version menu and search (fixed)

Prompt: "On docs.python.org, switch the documentation to Python 3.9 with its
version menu. Then find str.removeprefix() and report the version note shown
under it, word for word, and the URL of the page."

Exercises: a select menu that navigates, the docs' script-driven search, an
anchored page.

1. The page is the 3.9 documentation.
2. Found str.removeprefix().
3. The version note, word for word.
4. The page URL (with or without the anchor).

### T4. arXiv: advanced search form (fixed)

Prompt: "Use arXiv's Advanced Search to find papers whose title contains
'speculative decoding', in Computer Science, submitted from 2024-01-01 to
2024-12-31. Sort the results oldest first. Report the number of results and
the title of the first one."

Exercises: a multi-field form, field selects, a subject checkbox, date
fields, a sort select, reading a result count.

1. Title-only search term.
2. Computer Science and the 2024 date range applied.
3. Result count.
4. Title of the oldest result.

### T5. PyPI: project page and release history (live and fixed)

Prompt: "On pypi.org, open the page of the 'requests' project. Report its
latest version and that version's release date. Then open its release history
and report the oldest release and its date."

Exercises: search results, a project page's side navigation, a long list to
its end.

1. Latest version as the page showed it (live).
2. Its release date (live).
3. Oldest release (fixed).
4. Its date (fixed).

### T6. OpenStreetMap: search and feature tags (fixed)

Prompt: "On openstreetmap.org, search for 'Eiffel Tower' and open the tower
itself (not a stop or shop nearby). Report its OSM object type and id, and its
'height' and 'wikidata' tags."

Exercises: a single-page app's search sidebar, picking the right result, a
tag table.

1. The tower's object (type and id).
2. height tag.
3. wikidata tag.

### T7. Can I use: live search (live and fixed)

Prompt: "On caniuse.com, look up the CSS :has() selector. Report the global
percentage of users with full support, as shown, and the first Firefox version
that supports it."

Exercises: search-as-you-type with no submit, a dynamic support table.

1. Reached the :has() feature.
2. Global full-support percentage as the page showed it (live).
3. First Firefox version (fixed).

### T8. timeanddate.com: date calculator (fixed)

Prompt: "Use timeanddate.com's Date Duration calculator (days between two
dates). Count the days from 15 January 2026 to 20 November 2026, end date not
included. Then count them again with weekends excluded. Report both numbers."

Exercises: a form with several fields, an options checkbox, reading a result,
ads and consent banners.

1. Used the calculator with both dates.
2. Day count.
3. Weekend-excluded day count.

### T9. Project Gutenberg: a download (fixed)

Prompt: "On gutenberg.org, find Pride and Prejudice by Jane Austen and download
its 'Plain Text UTF-8' file through the browser. Report the file's size in bytes
and the title line it starts with, then delete the file."

Exercises: search, the download event, saving and reading the file. The file
is under 1 MB.

1. Downloaded through the browser (the download event, not a fetch).
2. Size in bytes.
3. Title line.
4. File deleted.

### T10. A PDF in the browser's viewer (fixed)

Prompt: "Open the PDF of arXiv paper 1706.03762 ('Attention Is All You Need')
in the browser, without downloading it. From the paper's Table 2, report the
EN-DE BLEU score of 'Transformer (big)'."

Exercises: the browser's PDF viewer (Chromium's on Ego, pdf.js on zenius) and
reading text from a PDF page. This is the live counterpart of the PDF cases
in rubric A.

1. Opened the PDF in the viewer.
2. Found Table 2.
3. The BLEU score.

### T11. Shoelace docs: a dialog in shadow DOM (fixed)

Prompt: "On the Shoelace documentation site, open the Dialog component's page.
In its first example, open the dialog and report its title and body text, then
close it with its own Close button and confirm it closed."

Exercises: web components with shadow roots, a modal with a focus trap, clicks
inside shadow DOM.

1. Opened the example's dialog.
2. Title and body text.
3. Closed it with its Close button.
4. Confirmed it closed.

### T12. W3Schools Tryit: frames and a code editor (fixed)

Prompt: "Open the 'Try it Yourself' editor of the first example on W3Schools'
HTML <select> tag page. In the result pane, choose 'Audi' and report what was
selected before. Then in the code, rename the option 'Volvo' to 'Zen', run it,
and report the dropdown's options from the result pane."

Exercises: a result iframe, typing into a code editor, the Run button, ads and
consent banners.

1. Option selected before 'Audi'.
2. 'Audi' chosen in the result pane.
3. Code edited and run.
4. The new option list.

### T13. Hacker News: front page and comments (live)

Prompt: "On news.ycombinator.com, find the story ranked #10 on the front page
right now. Report its title, points and number of comments. Then open its
comments page and report the username of the first top-level comment's
author."

Exercises: a dense table layout, rank numbers, a nested comment tree.

1. The #10 story's title.
2. Its points and comment count.
3. The first top-level commenter's username.

### T14. dev.to: infinite scroll (live)

Prompt: "On dev.to, search for 'webassembly' and sort by most recent. Scroll
until at least 30 posts have loaded. Report the title and date of the 30th
post."

Exercises: an infinite list that loads as it scrolls, counting loaded items.

1. Search and sort applied.
2. At least 30 posts loaded.
3. The 30th post's title and date.

### T15. Two Pages: Firefox and Chrome releases (live)

Prompt: "In one task, open Firefox's release notes on mozilla.org in one page and
the Chrome Releases blog in another. Report the current stable version of each
and its release date, and say which was released more recently."

Exercises: two Pages of one task, switching between them, extraction.

1. Firefox version and date.
2. Chrome stable version and date, from the newest 'Stable Channel Update for
   Desktop' post.
3. Both read in one task, in two pages.
4. The right comparison.

### Spares

- **S1. apple.com: hover menus (live).** "Using apple.com's top navigation, open
  the tech specs of the newest MacBook Air and report its video-streaming
  battery life."
- **S2. weather.gov: autocomplete (live).** "On weather.gov, get the forecast
  for ZIP code 20001 and report tonight's low and any hazards listed."
- **S3. crates.io: a single-page app (live).** "On crates.io, open the 'serde'
  crate. Report its latest version and the number of crates that depend on
  it."

## What each task covers

| Capability | Tasks |
|---|---|
| Search and navigation | T1, T2, T5, T6, T7 |
| Forms, selects, checkboxes, dates | T3, T4, T8 |
| Popup menus | T1 |
| Shadow DOM and modals | T11 |
| Iframes and editor typing | T12 |
| Long and infinite lists | T5, T14 |
| Downloads | T9 |
| The PDF viewer | T10 |
| Several Pages in one task | T15 |
| Live, dense pages | T13 |
