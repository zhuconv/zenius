<!-- Written from zenius's sources by sdk/scripts/write-references.ts: change those, then run it. -->

# Error codes

A failed call's error carries a code: error.code in a script (error.error_code too, as in Ego, whose EGO_ codes are zenius's ZEN_ ones), and the line after the step in an MCP tool's result. Its message says what happened, then, on a line of its own, what to do next.

The next steps name a script's calls. The MCP tools make the same ones:

- open and goto: page.goto()
- read_page: page.snapshot()
- click, fill, press and select: page.click(), page.fill(), page.press() and page.selectOption()
- wait: page.waitForSelector(), page.waitForURL() and page.waitForLoadState(), or with user: true task.waitForControl()
- hand_off: task.handOff()
- evaluate: page.evaluate()
- finish: task.finish()

help() is the CLI's: zenius help <name>.

## Codes

### ZEN_INVALID_ARGUMENT (Ego: EGO_INVALID_ARGUMENT)

A method got an argument or option it can't use, or a file it can't read.

Next: Fix the call: help("<method>") prints its signature and options.

### ZEN_PATH_NOT_ALLOWED

In the sandboxed CLI, a write outside the working folder and the temporary folder, or an upload of a file outside the working folder, the folder the command started in, the temporary folder and the folder the install lets scripts read (install-cli.sh --read-dir, such as ~/Downloads), or of a link to one. In either CLI, a working folder zenius can't use: one it can't make, or a config file that doesn't name it as the installer writes it.

Next: Give screenshot() and saveAs() a relative path, which lands in the working folder. For an upload, ask the user to copy the file into the working folder, or into the folder the message names that scripts may read. When the message is about the working folder itself, ask the user to run the installer again with --working-dir <folder>.

### ZEN_UNSUPPORTED

zenius has no such method, option or combination, such as CDP or a drag between frames.

Next: Do it another way: help() lists what zenius supports.

### ZEN_INTERNAL

Something inside zenius or the browser failed in a way it didn't expect.

Next: Retry the call once. If it fails again, report it with `zenius feedback "<what you were doing, without URLs or page text>"`: it shows the user a report in Zen's sidebar to send, copy or discard, and prints what they chose. Then finish the task another way with zenius's other calls if there is one, and otherwise stop and tell the user what failed, quoting this error.

### ZEN_BROWSER_UNAVAILABLE (Ego: EGO_BROWSER_UNAVAILABLE)

The CLI can't reach Zen: it's closed or still starting, zenius isn't running in it, or the connection closed during the call.

Next: Run `zenius doctor` and do what it says; never start, restart or quit the user's Zen yourself.

### ZEN_TASK_SPACE_NOT_FOUND (Ego: EGO_TASK_SPACE_NOT_FOUND)

No task space has that id or name any more: it was finished, closed after 3 idle days, or lost its tabs.

Next: listTaskSpaces() shows what's left; for a goal that's still open, start again with taskSpace(name).

### ZEN_TASK_SPACE_NOT_SELECTED (Ego: EGO_TASK_SPACE_NOT_SELECTED)

The call needed a task space and got none.

Next: Make the call on a TaskSpace from taskSpace(), takeOverTaskSpace() or claimTaskSpace().

### ZEN_TASK_SPACE_INACTIVE (Ego: EGO_TASK_SPACE_INACTIVE)

The task has ended (data.reason): task.finish() ("finished"), the user's Stop in Zen ("stopped"), or its last tab closed ("closed").

Next: A hard stop: don't retry. Claim it with claimTaskSpace(id) only when the user asks you to continue there.

### ZEN_TASK_SPACE_UNAVAILABLE (Ego: EGO_TASK_SPACE_UNAVAILABLE)

The task space can't take calls right now. (Ego's code; zenius's runtime doesn't raise it today.)

Next: Retry once; if it persists, stop and tell the user.

### ZEN_TASK_SPACE_USER_IN_CONTROL (Ego: EGO_TASK_SPACE_USER_IN_CONTROL)

The user has control of the task: handOff(), a takeover in the browser, or a browser prompt (data.reason says which). With data.retryAfterMs, the user used the tabs of a task handed to them under 10 s ago, so takeOverTaskSpace() and claimTaskSpace() wait.

Next: A hard stop: don't retry. Resume with takeOverTaskSpace(id) once the user says to continue. With error.retryAfterMs, wait that long and make the call once more.

### ZEN_TASK_SPACE_NAME_IN_USE (Ego: EGO_TASK_SPACE_NAME_IN_USE)

One of the user's Spaces, or a task the user owns, already has that name (data.spaceId).

Next: Pick another name. Work in the user's Space only if they ask you to, with claimTaskSpace(id).

### ZEN_TASK_SPACE_CLAIM_DENIED

The user said no, in the browser, to an agent working in their Space (data.verdict "deny"), or nobody answered in time ("timeout").

Next: Don't claim it again on your own: say in your reply what you want to do in that Space, and claim it again only once the user agrees; they then allow it in the browser.

### ZEN_HANDOFF_REFUSED

task.handOff() didn't hand the task to the user, and it stays yours (data.page, data.reason): the page they'd hold is one your code made, data: or blob: or a blank page it wrote ("agentPage"); a page zenius meant to load afresh brought no new document, and the message names it ("reloadFailed"); another of your Pages on its site could still reach it ("reachable"); or your page code didn't stop in every process within 10 s ("discardFailed"). Except after agentPage, zenius has already discarded your page code's sandboxes, as at a hand back: their globals, listeners and timers are gone.

Next: data.reloaded names the Pages that had already loaded afresh: what your code kept there is gone, so look again. agentPage: load the site's own page and hand that off. reloadFailed or discardFailed: call task.handOff() once more; if it fails again, tell the user and go on without the hand-off. reachable: close your other Pages on that site with page.close(), then call task.handOff() again.

### ZEN_PROFILE_NOT_FOUND (Ego: EGO_PROFILE_NOT_FOUND)

No browser profile or Zen container has that profileId.

Next: profiles() lists the ids; pass one only when the user asked for that container.

### ZEN_PAGE_NOT_FOUND

The task has no Page with that label, or its tab has closed.

Next: await task.pages() lists the open Pages; task.newPage() opens another.

### ZEN_PAGE_BUDGET_REACHED (Ego: EGO_PAGE_BUDGET_REACHED)

The task has as many Pages open as it may.

Next: Close Pages you no longer need (await task.page(label).close()), then retry.

### ZEN_PAGE_GROUP_SHARED

task.release() would hand the user a tab that shares a window group with other Pages of the task (an opener and its popups), whose code could reach it (data.pages).

Next: Release the whole group with task.release(label, { group: true }), or close its other Pages first. For the user's input mid-task, such as a login, use task.handOff() instead.

### ZEN_PAGE_UNRESPONSIVE (Ego: EGO_PAGE_UNRESPONSIVE)

The page didn't answer in time: a long-running script, a hung page, or a document that went away (data.reason).

Next: Retry once. If it still doesn't answer, page.reload() it and look again with snapshot().

### ZEN_PAGE_EVALUATION_TIMED_OUT (Ego: EGO_PAGE_EVALUATION_TIMED_OUT)

page.evaluate() ran past its timeout (data.executionStopped, data.mayHaveLateEffects).

Next: Check the page before you repeat anything with side effects, then try shorter code or a longer timeout.

### ZEN_NAVIGATION_FAILED (often a plain Error with no code, as in Ego)

page.goto() or reload() failed; Chromium's net::ERR_ name says why (data.error).

Next: Check the URL. If the site is down or unreachable, tell the user rather than retrying.

### ZEN_TIMEOUT (often a plain Error with no code, as in Ego)

A wait ran out of time: waitForSelector(), waitForURL(), waitForLoadState(), waitForEvent(), waitForControl() or reload(). Waits on the page are plain Errors, as in Ego.

Next: Look at the page with snapshot(), then wait for something that will happen, or pass a longer timeout.

### ZEN_SNAPSHOT_FAILED (Ego: EGO_SNAPSHOT_FAILED)

The snapshot couldn't be taken. (Ego's code; zenius's runtime doesn't raise it today.)

Next: Retry once; if the page is still loading, page.waitForLoadState() first.

### ZEN_REF_STALE

The ref came from a snapshot of a document that's gone: the page navigated or re-rendered.

Next: Take a new snapshot() and use its refs.

### ZEN_REF_NOT_FOUND

No element has that ref.

Next: Take a new snapshot() and use its refs.

### ZEN_SELECTOR_NOT_FOUND

Nothing in the page matches the target.

Next: Take a snapshot() and target what it shows, by ref or by role and name; if the element is still to come, waitForSelector() first.

### ZEN_SELECTOR_AMBIGUOUS

More than one element matches where one is needed (data.matches).

Next: Make the target unique: a ref from snapshot(), a role with its name, or nth.

### ZEN_NOT_ACTIONABLE

The element can't take the action: it's hidden, disabled, covered or not editable (data.reason).

Next: Wait for it to be ready, close what covers it, or act on the element the message names; snapshot() shows the page as it is.

### ZEN_DIALOG_NOT_FOUND

No JavaScript dialog is open to accept or dismiss. page.acceptDialog() and page.dismissDialog() return false for it, as Ego's do, instead of throwing.

Next: page.info() shows whether one is open; it may have closed already.

### ZEN_DOWNLOAD_FAILED (often a plain Error with no code, as in Ego)

A download failed, or the file it saved is gone.

Next: download.failure() says why; repeat the action that started it to download again.

### ZEN_NAVIGATION_TIMEOUT (Ego: EGO_NAVIGATION_TIMEOUT)

page.goto() didn't reach its waitUntil state in time (data.committed, data.stopped).

Next: If it committed, the page may be usable: check with snapshot(). Otherwise retry once with a longer timeout, or waitUntil: "domcontentloaded".

### ZEN_PAGE_DIALOG_OPENED (Ego: EGO_PAGE_DIALOG_OPENED)

A JavaScript dialog (alert, confirm or prompt) is open, or opened during the call (data.dialog), such as a page's change handler's alert during selectOption().

Next: Handle it with page.acceptDialog() or page.dismissDialog(). If it was open before the call, make the call again; if it opened during the call, check the page with snapshot() before you repeat anything.

### ZEN_URL_OPENED_IN_POPUP (Ego: EGO_URL_OPENED_IN_POPUP)

The URL page.waitForURL() waited for opened in a popup of the Page, not in the Page (data.popup).

Next: Don't repeat the action: continue in task.page(data.popup).

### ZEN_EVALUATION_FAILED (often a plain Error with no code, as in Ego)

The page's code threw, or returned an Error.

Next: Fix the code that ran in the page: the error above is the page's own.

### ZEN_FETCH_FAILED (often a plain Error with no code, as in Ego)

page.fetch() failed or timed out: a network error, a CORS refusal or the timeout.

Next: Check the URL. page.fetch() runs as the page, with its cookies and CORS rules; to open the URL as a page, use page.goto().

### ZEN_URL_NOT_ALLOWED

Agents load only http:, https:, data:, blob: and about:blank URLs, never browser, local or add-on pages (data.url, data.scheme).

Next: Load a web page instead; if the task needs this one, ask the user to open it.

### ZEN_PAGE_NOT_WEB_CONTENT

The page, or a frame in it, shows a browser, local, add-on or error page, where agents can't act (data.url).

Next: Load a web page with page.goto(), or hand the task to the user with task.handOff().

### ZEN_SIGN_IN_PAGE

The page is the user's sign-in (data.reason, data.page). "authorization_response": its address, or the address it came from, carries the code of a sign-in, which with the right key is the user's account, so zenius reads and does nothing there: no snapshot, text, screenshot, code or input, and its title, console and requests aren't reported. "device_login": a provider's page for typing a device code, which you may read but not type into or click. "consent": a provider's consent screen, where only the user grants an app access to their account: you may read it, but not click or type there.

Next: Hand the page to the user with task.handOff() if they need to finish there, or wait for the site to move on (most send you back to the app at once), or go to the app's own URL again with page.goto(). Never type a device code or grant an app access for the user.

### ZEN_AGENT_CODE_REFUSED

zenius ran none of the agent's code in this page, or stopped it (data.method, data.reason). "group": the page shares a window group with a window outside the task, which code here could reach (data.windows); that covers page.evaluate(), page.waitForFunction(), page.goto() to a data: or blob: URL or to another site, and page.keyboard.paste() with html. "hold": the user holds a page in its window group after your handOff().

Next: Clicks, typing, snapshots and screenshots still work here. To run code on this site, or to load another site, open it in a new Page (task.newPage(), then goto()); to paste, pass the text alone.

### ZEN_PAGE_GLOBAL_HIDDEN

Your page code (page.evaluate(), page.waitForFunction()) read one of the page's own JavaScript globals (data.name): as a bare name, with typeof, or through window, self or globalThis. Page code runs in a sandbox that sees the page's DOM but not its JavaScript, and the call fails even if your code caught the ReferenceError.

Next: Read the DOM instead: text, attributes, form state, or data the page puts in its markup, such as JSON in a <script> element (JSON.parse of its textContent).

### ZEN_PAGE_CODE_OFF

The user turned off agents' page code in this Zen (zenius.agentTabs.pageCode is never): page.evaluate() and page.waitForFunction() don't run, and the agent's own data: and blob: pages don't load in page.goto(), task.newPage() or page.reload() (data.method, data.page, data.setting).

Next: Work without page code: read the page with snapshot() and act through clicks, fills and keys, on the site's own pages. The setting is the user's: don't look for another way to run code in the page. If the task can't be done without it, tell the user why.

### ZEN_PAGE_CODE_ASKED

The user runs agents' page code only on sites they allow (zenius.agentTabs.pageCode is ask, or a value zenius doesn't know), and hasn't allowed the page's site (data.site, scheme://eTLD+1; null for a page with no site to allow, such as about:blank). data.asked: this call showed the user a card in the tab asking them. data.declined: they said "Not now" for this task.

Next: Carry on with snapshot(), clicks, fills and keys. If the task can't go on without page code, hand it to the user with task.handOff(), saying why, and try again after they resume you. After data.declined, don't ask or hand off for it again.

### ZEN_FILE_CHOOSER_OPENED (Ego: EGO_FILE_CHOOSER_OPENED)

The action opened a file chooser that nothing waited for, so it was cancelled.

Next: Use page.setInputFiles() on the file input, or start page.waitForFileChooser() before the action.

### ZEN_FILE_CHOOSER_TIMEOUT (Ego: EGO_FILE_CHOOSER_TIMEOUT)

No file chooser opened before page.waitForFileChooser() timed out.

Next: Check that the action opens one; for an <input type=file> in the page, use page.setInputFiles().

### ZEN_REMOTE_OFF

The user turned remote tasks off (zenius.agentSidebar.allowRemoteTasks is false), so the sidebar takes none.

Next: Don't retry. Tell whoever asked that the user's browser isn't taking remote tasks now.

### ZEN_REMOTE_LIMIT

A remote-task limit refused it: 2 tasks running at once (error.limit is running) or 20 starts in an hour (hourly).

Next: Wait until a task's turn ends (`zenius sidebar list`), or error.retryAfterMs for the hourly limit, then try once more.

### ZEN_REMOTE_TASK_NOT_FOUND

No remote task has that taskId: it never ran in this Zen, or the user removed it and Zen has quit since.

Next: `zenius sidebar list` shows the remote tasks there are; treat a task you started as ended.

### ZEN_REMOTE_TASK_BUSY

The task's turn is still running, or waits for the user, so it can't take a follow-up yet.

Next: Wait for the turn to end (`zenius sidebar status <taskId> --wait 10m`), then send it again.

### ZEN_REMOTE_TASK_ENDED

The task has stopped or failed, so it takes no more messages.

Next: Start a new task with `zenius sidebar start` if the work isn't done.

### ZEN_SIDEBAR_UNAVAILABLE

The sidebar can't run the task: it isn't in this Zen (error.reason no_sidebar), has no agents (no_agents), or the agent asked for can't run (agent_unavailable).

Next: Run `zenius doctor`: its sidebar line says what's missing. Don't retry until it's fixed.

## Refused kinds

In an agent tab, zenius doesn't open browser UI that would cover the user's view, leave the browser or touch the OS. Nothing throws: the page gets the answer it already handles, and the action's receipt lists { kind, message } in refused, as page.events() does in Zenius.refused events.

### print

The page called window.print(): no print dialog opens, and the page saw a Cancel.

Next: Nothing to do; to keep what the page shows, take a screenshot().

### httpAuth

The site asked for a username and password (HTTP authentication): no sign-in dialog opens, and the page without them loads.

Next: If the task needs the sign-in, call task.handOff() so the user signs in; never guess credentials.

### passkey

The page asked for a passkey after earlier requests in the task went unanswered, so it got NotAllowedError without asking the user.

Next: If the task needs it, call task.handOff() and tell the user what to approve.

### permissionPrompt

The page asked for a permission, such as for storage access, after earlier requests in the task went unanswered, so the prompt was cancelled without asking the user.

Next: If the task needs it, call task.handOff() and tell the user what to allow.

### externalApp

A link tried to open another app (mailto:, zoommtg:, …): nothing opened.

Next: If the user should open it, tell them the link.

### addonInstall

A navigation led to a browser add-on: nothing was downloaded or installed.

Next: If the user wants it, tell them the link.

### popupBlocked

The page opened a pop-up without a user action, and the browser blocked it, as for any page.

Next: Click what opens it (page.click).

### redirectBlocked

A frame tried to redirect the whole page without a user action, and the browser blocked it.

Next: If the page needs it, click what triggers it, or goto its URL.

### protocolHandler

The page asked to handle a kind of link for the user (registerProtocolHandler): refused.

Next: Nothing to do.

### fullscreen

The page asked for fullscreen: denied, so it stays in its tab.

Next: Nothing to do.

### pointerLock

The page locked the pointer: released at once.

Next: Nothing to do; drive the page with the mouse methods.

### wakeLock

navigator.wakeLock.request() was refused.

Next: Nothing to do.

### speech

speechSynthesis.speak() was refused, so nothing was spoken.

Next: Nothing to do.

### share

navigator.share() was refused, as after a Cancel.

Next: If the user should share it, tell them the link.

### colorPicker

No color picker opens in agent tabs.

Next: Set the value with page.fill().

### datePicker

No date or time picker opens in agent tabs.

Next: Set the value with page.fill().

### selectDropdown

No dropdown opens for a <select> in agent tabs.

Next: Choose with page.selectOption().

### clipboardRead

The page asked to read the task's clipboard, which only the site that wrote it may read.

Next: Nothing to do; your own paste still works.

### download

zenius refused a download, as its message says: the task holds as many downloads, or as many MB, as it may.

Next: Delete the downloads the task no longer needs with download.delete(), which deletes their files in the working folder, to make room, or ask the user to raise the limit.

### audio

The tab plays sound while the user can't see it, so zenius muted it: muted, not refused.

Next: Nothing to do; the sound comes back when the user opens the tab.

### serviceWorker

The page, or a worker it started, tried to register a service worker: refused in a task's pages for the task's whole life, since it would stay in the user's profile and run in their own tabs on the site. The page got a SecurityError ("The operation is insecure."). Or the page, or a worker it started, tried to reach the site's own worker, which the user's tabs registered: a task's pages and their workers don't use it, so to them the site has none. Or that worker sent the page, or a worker it started, a message: zenius dropped it and closed the ports it carried.

Next: Nothing to do; the site works without it. If the task needs the site's offline or push features, tell the user they work in their own tab.

### cacheStorage

The page, or a worker it started, tried to write to the site's Cache Storage: refused in a task's pages, since what it stores would reach the user's own tabs on the site after the task. The page got a SecurityError ("The operation is insecure."); reads still work.

Next: Nothing to do; the page loads what it needs from the network.

### deviceAccess

The page asked for the camera, microphone, screen, speakers or speech recognition while you drive it, or for any of these, the location or MIDI on a page with evidence (your code wrote into it, you opened it as a data: or blob: page, a phishing or malware list names its site, or you flagged it), where they stay refused during the user's hold too. zenius refused it before any prompt, since the system's consent would cover the user's whole browser: the page got a user's no (NotAllowedError; location: PERMISSION_DENIED), and enumerateDevices() lists none. With api "stopSharing", zenius stopped the streams the user started in the page during their hold, as it came back to you.

Next: For the location, sites then ask for a typed place (a city or postcode): type it, or ask the user for it. If the task needs a device, hand the task to the user with task.handOff({ message }) saying what for: the page asks them during their hold, unless the message names evidence; then tell the user it works in their own tab.

### notification

The page tried to show a desktop notification on a page with evidence (your code wrote into it, you opened it as a data: or blob: page, a phishing or malware list names its site, or you flagged it), during the user's hold too, or a worker of a task's page tried to, which is always refused. The page got an error event (new Notification) or a TypeError (showNotification).

Next: Nothing to do; read what the page shows instead.

### promptDenied

zenius cancelled a permission prompt without asking the user, and stored nothing for the site: on a page with evidence (your code wrote into it, you opened it as a data: or blob: page, a phishing or malware list names its site, or you flagged it), every prompt is cancelled, during the user's hold too, and while you drive, so is the camera, microphone, screen or speakers' prompt. The message says which. The page got what a dismissed prompt gives (location: PERMISSION_DENIED).

Next: For the location, sites then ask for a typed place (a city or postcode): type it, or ask the user for it. If the task needs a device, hand the task to the user with task.handOff({ message }) saying what for: the page asks them during their hold, unless the message names evidence; then tell the user it works in their own tab.

### localNetwork

The page, or a blob: shared worker of its site, tried to reach a private or link-local address or a .local name, or the page tried to start WebRTC, which reads local addresses: refused in a task's pages, since macOS's consent for the local network would cover the user's whole browser. Loopback stays open; new RTCPeerConnection() throws NotAllowedError. A shared worker from a data: URL is refused too (SecurityError): its requests name no site, so zenius couldn't keep them from the local network.

Next: Your own load of that host just fails. If the task needs it, call task.handOff({ message }) with what the user must do, such as "Open 10.0.0.1 in this tab", or ask in your reply. When the user types the address in your tab, its card offers Open it yourself, which opens it in a tab of theirs, and Add to allowlist, which lets every agent tab reach that host and loads it in your tab for you after Resume agent. Mention the allowlist only as the way to let you do the step yourself. You can't see the user's own tab, so ask for anything you need back, such as a confirmation or a value. An allowlist entry is removed in about:config (zenius.agentTabs.allowPrivateNetworks). WebRTC (calls) works only in the user's own tab.

### userTabNavigation

A page where the agent's code ran tried to load a page in a tab outside the task, such as the user's tab that opened it: zenius stopped the load before it was sent, and that tab stayed as it was. The page heard nothing.

Next: Nothing to do; load what the task needs in a Page of its own (task.newPage()).

### heldPageNavigation

A page tried to load a page in the page the user holds after a hand-off, or in one of its frames: while the user holds a page, no other page moves it, so zenius stopped the load before it was sent, and the page stayed as it was. The page heard nothing.

Next: Nothing to do; wait for the user to hand the task back.

### browserConfirmation

Firefox asked to confirm what the page did, such as sending a form from a secure page over an insecure connection, or sending a form again on a reload: zenius answered Cancel, so it didn't happen. The message quotes Firefox's question.

Next: If the task needs it, tell the user: they can do it in their own tab. To see a page a form posted to again, go to its URL instead of reloading it.
