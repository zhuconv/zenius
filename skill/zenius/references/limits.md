<!-- Written from zenius's sources by sdk/scripts/write-references.ts: change those, then run it. -->

# Limits

## Script timeouts

Each call's timeout option sets its own.

- page.goto() and page.reload(): 15 s to reach their waitUntil state, load unless it says.
- page.waitForSelector(), waitForURL(), waitForLoadState(), waitForFunction() and waitForEvent(): 10 s.
- Actions such as page.click() and page.fill(): 3 s for the element to become usable. A selector that matches nothing on an idle page fails sooner.
- page.fetch(): 20 s.
- task.waitForControl(): 10 min.

## A task

- Pages: 8 open at once, unless EGO_BROWSER_PAGE_BUDGET sets another number. One more gets ZEN_PAGE_BUDGET_REACHED.
- Downloads: 50 files and 1,024 MiB held at once.
- Uploads: 50 MB in all per call, and 1,000 files in a folder upload.
- Remote tasks (zenius sidebar start): 2 running at once, and 20 started in an hour. One more gets ZEN_REMOTE_LIMIT. Each ends after 1 h.

## The agent's mouse

- The agent's mouse events carry pointerId 32767 (PointerEvent.pointerId), not the real mouse's 0, so that a page's pointer capture of the agent's press can't take the user's mouse. If a site breaks on that id, the user can set zenius.input.agentPointerId to 0 in about:config, which gives the agent's events the real mouse's id again.

## The MCP tools

- read_page returns at most 60,000 characters: read a part with root: ref=N.
- evaluate returns at most 20,000 characters.
- open names the task in at most 80 characters.
- wait: 10 s unless its seconds says otherwise, at most 50 s. With user: true, 50 s, at most 600 s.
- report_problem answers within 50 s, unless its wait asks for longer: at most 600 s.

## Problem reports

- A report's line: at most 300 characters.
- zenius feedback --wait: at most 600 s.
- After the user discards a report, no new one shows for 10 min.
