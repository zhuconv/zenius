<!-- Written from zenius's sources by sdk/scripts/write-references.ts: change those, then run it. -->

# Limits

## Script timeouts

Each call's timeout option sets its own.

- page.goto() and page.reload(): 15 s to reach their waitUntil state, load unless it says.
- page.waitForSelector(), waitForURL(), waitForLoadState(), waitForFunction() and waitForEvent(): 10 s.
- Actions such as page.click() and page.fill(): 3 s for the element to become usable. A selector that matches nothing on an idle page fails sooner.
- page.fetch(): 20 s.
- task.waitForControl(): 10 min.
- zenius wait: until the user gives the task back, unless --timeout sets a limit, at most 168 h.

## A task

- Pages: 8 open at once, unless EGO_BROWSER_PAGE_BUDGET sets another number. One more gets ZEN_PAGE_BUDGET_REACHED.
- Downloads: 50 files and 1,024 MiB held at once.
- Uploads: 50 MB in all per call, and 1,000 files in a folder upload.
- Remote tasks (zenius sidebar start): 2 running at once, and 20 started in an hour. One more gets ZEN_REMOTE_LIMIT. Each ends after 1 h.

## The agent's mouse

- The agent's mouse events carry pointerId 32767 (PointerEvent.pointerId), not the real mouse's 0, so that a page's pointer capture of the agent's press can't take the user's mouse. If a site breaks on that id, the user can set zenius.input.agentPointerId to 0 in about:config, which gives the agent's events the real mouse's id again.

## Pages that load afresh

- Page code (page.evaluate(), waitForFunction()) that leaves code in a page, or a change to what the user types into, hooks the page: a script element, an inline handler (onclick=...), a javascript: URL, the page's eval or Function, a string timer, a frame, an object or embed, a form or field, an editable area, a base element, a meta refresh, a style sheet, style rule or font face, a shadow root, document.write. Reading the page, clicking, and setting values, text, classes, inline styles or other attributes don't.
- zenius loads a hooked page afresh when it's handed to the user, before the user clicks or types there, and at the task's end. The load carries the form's fields over, but what the page keeps only in its memory, such as a game's moves or an editor's undo, is lost.
- The call that hooks a page says so in a notice, which zenius mcp's evaluate tool and script result show, and at the task's end Zen's agent sidebar names the pages that loaded afresh.
- To keep such state, leave nothing in the page, or reach the state's own address first with page.goto(), such as a board's position in its URL. An address the agent's code sets in place (history.pushState(), the hash) doesn't keep it: the load goes to the address the page had before.
- When a tab joins or leaves your task, its Back and Forward pages load afresh.

## The MCP tools

- read_page returns at most 60,000 characters: read a part with root: ref=N.
- evaluate returns at most 20,000 characters.
- open names the task in at most 80 characters.
- wait: 10 s unless its seconds says otherwise, at most 50 s. With user: true, 50 s, at most 600 s.
- report_problem answers within 50 s, unless its wait asks for longer: at most 600 s.
- script: 50 s unless its seconds says otherwise, at most 600 s. At its limit its call ends with the output so far, and its later calls fail.
- No call goes past the client's tool timeout less 10 s: a script's limit, wait and report_problem. The client's server entry gives it as ZENIUS_TOOL_TIMEOUT, in seconds; without it, Codex and other clients get 60 s, and Claude Code none.

## Problem reports

- A report's line: at most 300 characters.
- zenius feedback --wait: at most 600 s.
- After the user discards a report, no new one shows for 10 min.
