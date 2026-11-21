# Golden snapshots

Snapshots that Ego Lite 0.6.3.17 (Chromium 156, skill guide v2.2.1) produced
for fixture pages and live public sites, for zen-snapshot to match. Captured
with the default options an agent uses: `page.snapshot()` (viewport) and
`page.snapshot({ scope: "full_page" })`.

```text
tests/golden/
  pages.mjs          the page list: fixture paths and live sites, with why each was picked
  capture.mjs        captures one target into tests/golden/<target>/
  ego/
    index.json       per capture: URL, final URL, title, time, viewport, timings, sizes, errors
    <slug>.viewport.txt
    <slug>.full_page.txt
    <slug>.replay.viewport.txt    the same site, replayed from its DOM dump (below)
    <slug>.replay.full_page.txt
    dom/<slug>.html.gz             rendered DOM of each live site at capture time
```

## Reading the files

- Each `.txt` file is Ego's output byte for byte, except that fixture URLs are
  normalized: `{{BASE}}` is the fixture server origin `http://127.0.0.1:<port>`
  (`{{BASE_HOST}}` without the scheme, as untitled pages show it in the header)
  and `{{CROSS}}` is the same server as `http://localhost:<port>`, a different
  site, so its iframes run out of process.
- The header line names the capture's task space (`space "zen-eval golden
  …"(N)`). Compare it loosely.
- Ref numbers come from one Page ledger that lived through the whole capture,
  so they keep counting up from page to page (the forms page starts at 48).
  Compare which nodes get a ref, not the numbers.
- The viewport was the size of Ego's background task-space tab; `index.json`
  records `w`/`h` (and `pw`/`ph`, the page size) for every capture. Use the same
  viewport when comparing `viewport` files.

## Fixture pages

`tests/fixtures/server.mjs` serves them: Ego's e2e routes (`/`, `/frame.html`,
`/visual`, …) and our `/zoo/` pages (`forms`, `aria`, `semantics`, `shadow`,
`frames`, `long`), which put one example of each element type, ARIA widget,
visibility rule, shadow root and frame kind on a page. They're deterministic,
so zenius should match their structure closely.

```sh
node tests/fixtures/server.mjs --port 8765   # then open http://127.0.0.1:8765/zoo/forms.html
```

## Live sites and replays

Live sites drift by the hour. To compare on identical input, each live
capture also saved the rendered DOM: open shadow roots serialized as
declarative shadow DOM, scripts and CSP/refresh metas removed, and a `<base>`
pinned to the page URL so stylesheets and images still load from the site.
The fixture server serves a dump at `/golden-replay/<slug>.html`, and Ego's
snapshot of that static page is the `.replay.*.txt` pair. For a like-for-like
check, snapshot `{{BASE}}/golden-replay/<slug>.html` in zenius and diff against
the replay files. Closed shadow roots, iframe documents and form state typed
after load aren't in the dumps.

## Recapturing

```sh
node tests/golden/capture.mjs --target ego                      # everything (about 6 minutes)
node tests/golden/capture.mjs --target ego --only site-npm,zoo-forms
node tests/golden/capture.mjs --target zenius --instance zen-eval   # writes tests/golden/zenius/
```

A capture creates one task space, reuses `p1` for every page and finishes the
space at the end. Things seen while capturing on 2026-11-19:

- craigslist.org/about/sites asks for geolocation. Ego then hands the space to
  the user (`ZEN_TASK_SPACE_USER_IN_CONTROL`, reason `location`) and every
  later call fails, so the list uses gnu.org's manual index instead, and the
  script takes the space back if it happens again.
- Chromium occasionally showed `ERR_SOCKET_NOT_CONNECTED` for sites the Mac
  reached fine; the script retries a network-error page once.
- Bing's results page once made Ego time out on `Page.getFrameTree` (15 s)
  for the viewport snapshot.
- A frameset page (the-internet.herokuapp.com/nested_frames) snapshots as a
  bare `root`: Ego doesn't descend into `<frame>` elements.
