// What every error code and refused kind means, and what an agent does
// next. help("errors") prints this table. Each ZeniusError's message gets its
// code's next step on a line of its own, unless the message already says what
// to do, and so does each plain Error the runtime sends.
//
// The codes are Ego's (EGO_X is ZEN_X) where Ego has the code. Ego owns the
// wording of only its two hard stops, which errors.ts keeps word for word, and
// otherwise shows the browser's own message, as zenius does: the next step
// follows that message and never replaces it.

import { apiEntry, normalizeApiName } from "./api-schema.ts";

/** One error code: what happened, and what to do next. */
export type CodeGuide = {
  what: string;
  /** Added to the message on a line of its own; `{help}` names the failed method's help(). */
  next: string;
  /** When the message matches, it already says what to do, and nothing is added. */
  said?: RegExp;
  /** Ego's code for the same failure. */
  ego?: string;
  /** The SDK's own wording replaces the message (the hard stops), so nothing is added. */
  owned?: boolean;
  /**
   * Left out of help("errors") and help("<code>"), which agents read: only a
   * command agents never run meets the code (`zenius selfcheck`), or one that
   * words it itself.
   */
  unlisted?: boolean;
  /** Sent as a plain Error without a code, as Ego throws it: scripts see only the message. */
  plain?: boolean;
};

/** One kind of browser UI zenius refuses in agent tabs (PROTOCOL "Refused surfaces"). */
export type RefusalGuide = { what: string; next: string };

const SNAPSHOT_AGAIN = /take a new snapshot/i;

export const CODE_GUIDE: Record<string, CodeGuide> = {
  ZEN_INVALID_ARGUMENT: {
    ego: "EGO_INVALID_ARGUMENT",
    what: "A method got an argument or option it can't use, or a file it can't read.",
    next: "Fix the call: {help}.",
    // A file chooser the runtime cancelled (the agent stopped driving its tab) says to open it again,
    // and a folder upload whose files changed while they were read says to try again.
    said: /open it again|try again once nothing is writing/,
  },
  ZEN_PATH_NOT_ALLOWED: {
    what: "In the sandboxed CLI, a write outside the working folder and the temporary folder, or an upload of a file outside the working folder, the folder the command started in, the temporary folder and the folder the install lets scripts read (install-cli.sh --read-dir, such as ~/Downloads), or of a link to one. In either CLI, a working folder zenius can't use: one it can't make, or a config file that doesn't name it as the installer writes it.",
    next: "Give screenshot() and saveAs() a relative path, which lands in the working folder. For an upload, ask the user to copy the file into the working folder, or into the folder the message names that scripts may read. When the message is about the working folder itself, ask the user to run the installer again with --working-dir <folder>.",
    said: /Pass a relative path|ask the user to copy|--working-dir/,
  },
  ZEN_UNSUPPORTED: {
    what: "zenius has no such method, option or combination, such as CDP or a drag between frames.",
    next: "Do it another way: help() lists what zenius supports.",
    said: /help\(\)/,
  },
  ZEN_INTERNAL: {
    what: "Something inside zenius or the browser failed in a way it didn't expect.",
    next: 'Retry the call once. If it fails again, report it with `zenius feedback "<what you were doing, without URLs or page text>"`: it shows the user a report in Zen\'s sidebar to send, copy or discard, and prints what they chose. Then finish the task another way with zenius\'s other calls if there is one, and otherwise stop and tell the user what failed, quoting this error.',
  },
  ZEN_BROWSER_UNAVAILABLE: {
    ego: "EGO_BROWSER_UNAVAILABLE",
    what: "The CLI can't reach Zen: it's closed or still starting, zenius isn't running in it, or the connection closed during the call.",
    next: "Run `zenius doctor` and do what it says; never start, restart or quit the user's Zen yourself.",
    said: /zenius doctor|zenius nodejs/,
  },
  ZEN_TASK_SPACE_NOT_FOUND: {
    ego: "EGO_TASK_SPACE_NOT_FOUND",
    what: "No task space has that id or name any more: it was finished, closed after 3 idle days, or lost its tabs.",
    next: "listTaskSpaces() shows what's left; for a goal that's still open, start again with taskSpace(name).",
    said: /Start a new task/,
  },
  ZEN_TASK_SPACE_NOT_SELECTED: {
    ego: "EGO_TASK_SPACE_NOT_SELECTED",
    what: "The call needed a task space and got none.",
    next: "Make the call on a TaskSpace from taskSpace(), takeOverTaskSpace() or claimTaskSpace().",
  },
  ZEN_TASK_SPACE_INACTIVE: {
    ego: "EGO_TASK_SPACE_INACTIVE",
    owned: true,
    what: "The task has ended (data.reason): task.finish() (\"finished\"), the user's Stop in Zen (\"stopped\"), or its last tab closed (\"closed\").",
    next: "A hard stop: don't retry. Claim it with claimTaskSpace(id) only when the user asks you to continue there.",
  },
  ZEN_TASK_SPACE_UNAVAILABLE: {
    ego: "EGO_TASK_SPACE_UNAVAILABLE",
    what: "The task space can't take calls right now. (Ego's code; zenius's runtime doesn't raise it today.)",
    next: "Retry once; if it persists, stop and tell the user.",
  },
  ZEN_TASK_SPACE_USER_IN_CONTROL: {
    ego: "EGO_TASK_SPACE_USER_IN_CONTROL",
    owned: true,
    what: "The user has control of the task: handOff(), a takeover in the browser, or a browser prompt (data.reason says which). With data.retryAfterMs, the user used the tabs of a task handed to them under 10 s ago, so takeOverTaskSpace() and claimTaskSpace() wait. With data.secret, the user's step shows a secret (handOff({ secret: true }), or the user marked it), so both are refused until the user presses Resume agent.",
    next: "A hard stop: don't retry. Resume with takeOverTaskSpace(id) once the user says to continue. With error.retryAfterMs, wait that long and make the call once more. With error.secret, only the user's Resume agent gives the task back: leave `zenius wait <id>` running in the background if your harness tells you when it exits.",
  },
  ZEN_TASK_SPACE_NAME_IN_USE: {
    ego: "EGO_TASK_SPACE_NAME_IN_USE",
    what: "One of the user's Spaces, or a task the user owns, already has that name (data.spaceId).",
    next: "Pick another name. Work in the user's Space only if they ask you to, with claimTaskSpace(id).",
  },
  ZEN_TASK_SPACE_CLAIM_DENIED: {
    what: "The user said no, in the browser, to an agent working in their Space (data.verdict \"deny\"), or nobody answered in time (\"timeout\").",
    next: "Don't claim it again on your own: say in your reply what you want to do in that Space, and claim it again only once the user agrees; they then allow it in the browser.",
  },
  ZEN_HANDOFF_REFUSED: {
    what: "task.handOff() didn't hand the task to the user, and it stays yours (data.page, data.reason): the page they'd hold is one your code made, data: or blob: or a blank page it wrote (\"agentPage\"); a page zenius meant to load afresh brought no new document, and the message names it (\"reloadFailed\"); another of your Pages on its site could still reach it (\"reachable\"); or your page code didn't stop in every process within 10 s (\"discardFailed\"). Except after agentPage, zenius has already discarded your page code's sandboxes, as at a hand back: their globals, listeners and timers are gone.",
    next: "data.reloaded names the Pages that had already loaded afresh: what your code kept there is gone, so look again. agentPage: load the site's own page and hand that off. reloadFailed or discardFailed: call task.handOff() once more; if it fails again, tell the user and go on without the hand-off. reachable: close your other Pages on that site with page.close(), then call task.handOff() again.",
    // The core's four messages each say their own next step.
    said: /hand that off|task\.handOff\(\) again/,
  },
  ZEN_PROFILE_NOT_FOUND: {
    ego: "EGO_PROFILE_NOT_FOUND",
    what: "No browser profile or Zen container has that profileId.",
    next: "profiles() lists the ids; pass one only when the user asked for that container.",
  },
  ZEN_PAGE_NOT_FOUND: {
    what: "The task has no Page with that label, or its tab has closed.",
    next: "await task.pages() lists the open Pages; task.newPage() opens another.",
  },
  ZEN_PAGE_BUDGET_REACHED: {
    ego: "EGO_PAGE_BUDGET_REACHED",
    what: "The task has as many Pages open as it may.",
    next: "Close Pages you no longer need (await task.page(label).close()), then retry.",
    said: /Close: /,
  },
  ZEN_PAGE_GROUP_SHARED: {
    what: "task.release() would hand the user a tab that shares a window group with other Pages of the task (an opener and its popups), whose code could reach it (data.pages).",
    next: "Release the whole group with task.release(label, { group: true }), or close its other Pages first. For the user's input mid-task, such as a login, use task.handOff() instead.",
    said: /group: true/,
  },
  ZEN_PAGE_UNRESPONSIVE: {
    ego: "EGO_PAGE_UNRESPONSIVE",
    what: "The page didn't answer in time: a long-running script, a hung page, or a document that went away (data.reason).",
    next: "Retry once. If it still doesn't answer, page.reload() it and look again with snapshot().",
    said: /Retry the call|reload/i,
  },
  ZEN_PAGE_EVALUATION_TIMED_OUT: {
    ego: "EGO_PAGE_EVALUATION_TIMED_OUT",
    what: "page.evaluate() ran past its timeout (data.executionStopped, data.mayHaveLateEffects).",
    next: "Check the page before you repeat anything with side effects, then try shorter code or a longer timeout.",
    said: /side effects/,
  },
  ZEN_NAVIGATION_FAILED: {
    plain: true,
    what: "page.goto() or reload() failed; Chromium's net::ERR_ name says why (data.error).",
    next: "Check the URL. If the site is down or unreachable, tell the user rather than retrying.",
  },
  ZEN_TIMEOUT: {
    plain: true,
    what: "A wait ran out of time: waitForSelector(), waitForURL(), waitForLoadState(), waitForEvent(), waitForControl() or reload(). Waits on the page are plain Errors, as in Ego.",
    next: "Look at the page with snapshot(), then wait for something that will happen, or pass a longer timeout.",
  },
  ZEN_SNAPSHOT_FAILED: {
    ego: "EGO_SNAPSHOT_FAILED",
    what: "The snapshot couldn't be taken. (Ego's code; zenius's runtime doesn't raise it today.)",
    next: "Retry once; if the page is still loading, page.waitForLoadState() first.",
  },
  ZEN_REF_STALE: {
    what: "The ref came from a snapshot of a document that's gone: the page navigated or re-rendered.",
    next: "Take a new snapshot() and use its refs.",
    said: SNAPSHOT_AGAIN,
  },
  ZEN_REF_NOT_FOUND: {
    what: "No element has that ref.",
    next: "Take a new snapshot() and use its refs.",
    said: SNAPSHOT_AGAIN,
  },
  ZEN_SELECTOR_NOT_FOUND: {
    what: "Nothing in the page matches the target.",
    next: "Take a snapshot() and target what it shows, by ref or by role and name; if the element is still to come, waitForSelector() first.",
    said: /snapshot/i,
  },
  ZEN_SELECTOR_AMBIGUOUS: {
    what: "More than one element matches where one is needed (data.matches).",
    next: "Make the target unique: a ref from snapshot(), a role with its name, or nth.",
  },
  ZEN_NOT_ACTIONABLE: {
    what: "The element can't take the action: it's hidden, disabled, covered or not editable (data.reason).",
    next: "Wait for it to be ready, close what covers it, or act on the element the message names; snapshot() shows the page as it is.",
  },
  ZEN_DIALOG_NOT_FOUND: {
    what: "No JavaScript dialog is open to accept or dismiss. page.acceptDialog() and page.dismissDialog() return false for it, as Ego's do, instead of throwing.",
    next: "page.info() shows whether one is open; it may have closed already.",
  },
  ZEN_DOWNLOAD_FAILED: {
    plain: true,
    what: "A download failed, or the file it saved is gone.",
    next: "download.failure() says why; repeat the action that started it to download again.",
  },
  ZEN_NAVIGATION_TIMEOUT: {
    ego: "EGO_NAVIGATION_TIMEOUT",
    what: "page.goto() didn't reach its waitUntil state in time (data.committed, data.stopped).",
    next: 'If it committed, the page may be usable: check with snapshot(). Otherwise retry once with a longer timeout, or waitUntil: "domcontentloaded".',
  },
  ZEN_PAGE_DIALOG_OPENED: {
    ego: "EGO_PAGE_DIALOG_OPENED",
    what: "A JavaScript dialog (alert, confirm or prompt) is open, or opened during the call (data.dialog), such as a page's change handler's alert during selectOption().",
    next: "Handle it with page.acceptDialog() or page.dismissDialog(). If it was open before the call, make the call again; if it opened during the call, check the page with snapshot() before you repeat anything.",
    said: /acceptDialog/,
  },
  ZEN_URL_OPENED_IN_POPUP: {
    ego: "EGO_URL_OPENED_IN_POPUP",
    what: "The URL page.waitForURL() waited for opened in a popup of the Page, not in the Page (data.popup).",
    next: "Don't repeat the action: continue in task.page(data.popup).",
    said: /Continue with/,
  },
  ZEN_EVALUATION_FAILED: {
    plain: true,
    what: "The page's code threw, or returned an Error.",
    next: "Fix the code that ran in the page: the error above is the page's own.",
  },
  ZEN_FETCH_FAILED: {
    plain: true,
    what: "page.fetch() failed or timed out: a network error, a CORS refusal or the timeout.",
    next: "Check the URL. page.fetch() runs as the page, with its cookies and CORS rules; to open the URL as a page, use page.goto().",
  },
  ZEN_URL_NOT_ALLOWED: {
    what: "Agents load only http:, https:, data:, blob: and about:blank URLs, never browser, local or add-on pages (data.url, data.scheme).",
    next: "Load a web page instead; if the task needs this one, ask the user to open it.",
    said: /ask the user to open it/,
  },
  ZEN_PAGE_NOT_WEB_CONTENT: {
    what: "The page, or a frame in it, shows a browser, local, add-on or error page, where agents can't act (data.url).",
    next: "Load a web page with page.goto(), or hand the task to the user with task.handOff().",
    // page.screenshot's refusal for an add-on's frame says page.snapshot still works.
    said: /Load one with page\.goto|act elsewhere|page\.snapshot still works/,
  },
  ZEN_SIGN_IN_PAGE: {
    what: "The page is the user's sign-in (data.reason, data.page). \"authorization_response\": its address, or the address it came from, carries the code of a sign-in, which with the right key is the user's account, so zenius reads and does nothing there: no snapshot, text, screenshot, code or input, and its title, console and requests aren't reported. \"device_login\": a provider's page for typing a device code, which you may read but not type into or click. \"consent\": a provider's consent screen, where only the user grants an app access to their account: you may read it, but not click or type there.",
    next: "Hand the page to the user with task.handOff() if they need to finish there, or wait for the site to move on (most send you back to the app at once), or go to the app's own URL again with page.goto(). Never type a device code or grant an app access for the user.",
    // The runtime's three messages each say to hand off or go elsewhere.
    said: /task\.handOff\(\)/,
  },
  ZEN_AGENT_CODE_REFUSED: {
    what: "zenius ran none of the agent's code in this page, or stopped it (data.method, data.reason). \"group\": the page shares a window group with a window outside the task, which code here could reach (data.windows); that covers page.evaluate(), page.waitForFunction(), page.goto() to a data: or blob: URL or to another site, and page.keyboard.paste() with html. \"hold\": the user holds a page in its window group after your handOff().",
    next: "Clicks, typing, snapshots and screenshots still work here. To run code on this site, or to load another site, open it in a new Page (task.newPage(), then goto()); to paste, pass the text alone.",
    said: /new page of the task|Paste the text without html/,
  },
  ZEN_PAGE_GLOBAL_HIDDEN: {
    what: "Your page code (page.evaluate(), page.waitForFunction()) read one of the page's own JavaScript globals (data.name): as a bare name, with typeof, or through window, self or globalThis. Page code runs in a sandbox that sees the page's DOM but not its JavaScript, and the call fails even if your code caught the ReferenceError.",
    next: "Read the DOM instead: text, attributes, form state, or data the page puts in its markup, such as JSON in a <script> element (JSON.parse of its textContent).",
  },
  ZEN_PAGE_CODE_OFF: {
    what: "The user turned off agents' page code in this Zen (zenius.agentTabs.pageCode is never): page.evaluate() and page.waitForFunction() don't run, and the agent's own data: and blob: pages don't load in page.goto(), task.newPage() or page.reload() (data.method, data.page, data.setting).",
    next: "Work without page code: read the page with snapshot() and act through clicks, fills and keys, on the site's own pages. The setting is the user's: don't look for another way to run code in the page. If the task can't be done without it, tell the user why.",
    // The observe layer's messages say what to do, in words an MCP agent's tools share.
    said: /clicks, fills and keys instead|the site's own pages/,
  },
  ZEN_PAGE_CODE_ASKED: {
    what: "The user runs agents' page code only on sites they allow (zenius.agentTabs.pageCode is ask, or a value zenius doesn't know), and hasn't allowed the page's site (data.site, scheme://eTLD+1; null for a page with no site to allow, such as about:blank). data.asked: this call showed the user a card in the tab asking them. data.declined: they said \"Not now\" for this task.",
    next: "Carry on with snapshot(), clicks, fills and keys. If the task can't go on without page code, hand it to the user with task.handOff(), saying why, and try again after they resume you. After data.declined, don't ask or hand off for it again.",
    said: /clicks, fills and keys instead|carry on with clicks, fills and reading the page/i,
  },
  ZEN_FILE_CHOOSER_OPENED: {
    ego: "EGO_FILE_CHOOSER_OPENED",
    what: "The action opened a file chooser that nothing waited for, so it was cancelled.",
    next: "Use page.setInputFiles() on the file input, or start page.waitForFileChooser() before the action.",
    said: /setInputFiles/,
  },
  ZEN_FILE_CHOOSER_TIMEOUT: {
    ego: "EGO_FILE_CHOOSER_TIMEOUT",
    what: "No file chooser opened before page.waitForFileChooser() timed out.",
    next: "Check that the action opens one; for an <input type=file> in the page, use page.setInputFiles().",
  },
  ZEN_REMOTE_OFF: {
    what: "The user turned remote tasks off (zenius.agentSidebar.allowRemoteTasks is false), so the sidebar takes none.",
    next: "Don't retry. Tell whoever asked that the user's browser isn't taking remote tasks now.",
  },
  ZEN_REMOTE_LIMIT: {
    what: "A remote-task limit refused it: 2 tasks running at once (error.limit is running) or 20 starts in an hour (hourly).",
    next: "Wait until a task's turn ends (`zenius sidebar list`), or error.retryAfterMs for the hourly limit, then try once more.",
  },
  ZEN_REMOTE_TASK_NOT_FOUND: {
    what: "No remote task has that taskId: it never ran in this Zen, or the user removed it and Zen has quit since.",
    next: "`zenius sidebar list` shows the remote tasks there are; treat a task you started as ended.",
  },
  ZEN_REMOTE_TASK_BUSY: {
    what: "The task's turn is still running, or waits for the user, so it can't take a follow-up yet.",
    next: "Wait for the turn to end (`zenius sidebar status <taskId> --wait 10m`), then send it again.",
  },
  ZEN_REMOTE_TASK_ENDED: {
    what: "The task has stopped or failed, so it takes no more messages.",
    next: "Start a new task with `zenius sidebar start` if the work isn't done.",
  },
  ZEN_SIDEBAR_UNAVAILABLE: {
    what: "The sidebar can't run the task: it isn't in this Zen (error.reason no_sidebar), has no agents (no_agents), or the agent asked for can't run (agent_unavailable).",
    next: "Run `zenius doctor`: its sidebar line says what's missing. Don't retry until it's fixed.",
  },
  // Only `zenius selfcheck` calls selfcheck.run, and it words these itself,
  // so they're owned; and unlisted, so no help an agent reads names them.
  ZEN_SELFCHECK_BUSY: {
    what: "A self-check is already running in this Zen; one runs at a time.",
    next: "Wait for it to end, about two minutes at most.",
    owned: true,
    unlisted: true,
  },
  ZEN_SELFCHECK_UNAVAILABLE: {
    what: "This Zen can't run the self-check: its agent sidebar has none, or its instance name isn't a plain one.",
    next: "Run `zenius doctor`: its sidebar line says what's missing.",
    owned: true,
    unlisted: true,
  },
  // Only `zenius feedback` calls feedback.propose, and it words these itself.
  ZEN_FEEDBACK_PENDING: {
    what: "Another problem report waits for the user in Zen's agent sidebar; one waits at a time.",
    next: "Don't send another: tell the user it's there.",
    owned: true,
    unlisted: true,
  },
  ZEN_FEEDBACK_DECLINED: {
    what: "The user discarded a problem report less than 10 minutes ago.",
    next: "Don't send another before then.",
    owned: true,
    unlisted: true,
  },
  // Only zenius mcp cancels a call: for a tool call its client canceled,
  // which it answers nothing then, or for a script whose tool call is over,
  // whose leftover work nobody waits for.
  ZEN_CANCELED: {
    what: "zenius mcp stopped the call: its client canceled the tool call this call was for, or the script it was for had ended.",
    next: "Nothing: the client stopped waiting for it, and its next call runs.",
    owned: true,
    unlisted: true,
  },
};

/** After a certificate warning, only the user can decide (navigation's data.certificateWarning). */
const CERTIFICATE_NEXT =
  "Call task.handOff() and end the round: tell the user which site showed the warning. Only they can decide whether to trust it; never look for a way past it.";

/** A goto onto a file (Ego's "navigation started a download"): the download goes on. */
const DOWNLOAD_NEXT =
  'This URL downloads a file instead of opening a page: start page.waitForEvent("download") before page.goto(), let the goto fail, and save the file with download.saveAs().';

/**
 * A dialog that opened during the call stopped it there: what the call did
 * before took effect, and nothing after. A select's choice may be made with
 * its change event unsent.
 */
const DIALOG_DURING_NEXT =
  "What the call did before the dialog opened took effect: after you handle it, check the page with snapshot() before you repeat anything.";

/** takeOver or claim of a task handed to the user, under 10 s after the user's input there. */
const userInputWaitNext = (retryAfterMs: number) =>
  `Wait ${Math.max(1, Math.ceil(retryAfterMs / 1000))} s (error.retryAfterMs), then make the same call once more. ` +
  "If it's refused again, the user is still working there: end the round and tell them what you'll do once they're done.";

/** The connection to the socket was refused by the system, not by Zen (EPERM, EACCES). */
export const SANDBOX_BLOCKED_NEXT =
  "Don't start or restart Zen. Run this zenius command outside that sandbox: in Codex, rerun it with " +
  'sandbox_permissions "require_escalated", or ask the user to turn on network access for the workspace.';

// ZEN_PAGE_GLOBAL_HIDDEN whose message already says to read the DOM: what the
// help entry's next step adds to it.
const PAGE_GLOBAL_MARKUP_NEXT =
  "Data the page keeps in its markup counts too, such as JSON in a <script> element: JSON.parse of its textContent.";

/** The runtime itself didn't answer in time (rpc.ts's safety limit). */
// ZEN_AGENT_CODE_REFUSED with reason "hold": a call already under way when
// handOff() began, on a page of the held page's window group. It ends at the
// hand back, unlike the closed-group refusal.
const HOLD_NEXT = "The user holds a page in this window group after your handOff(): wait for the hand back with task.waitForControl(), then retry.";

// ZEN_PAGE_NOT_FOUND with reason "theirs": a page Zen loaded before zenius
// started after a restart, which the user navigated, clicked or typed in
// since (data.why), left the task for good.
const THEIRS_NEXT =
  "The page is the user's now, with what they entered: don't ask to reload it. Open a new page with task.newPage() (data.url is where it was), or ask the user to hand you what you need from it.";

const NO_RESPONSE_NEXT = "Zen may be busy or hung: retry once, and if it still doesn't answer, run `zenius doctor`.";

/**
 * Another element takes the action's point (data.cover at data.position):
 * in the option names the CLI and zenius mcp's click, hover and drag share,
 * so the agent needn't change the page to get through.
 */
const COVERED_NEXT =
  "Close or use what covers it first, such as a banner's button; or act at a point of the element it doesn't cover, with position (x and y from its top left); or, when it's the page's own layer over the element, as on a game board or a map, act at that point anyway with force: the cover takes the event, as it would a user's.";
const COVERED_DRAG_NEXT =
  "Close or use what covers it first; or drag from or to a point of that end it doesn't cover, with that end's position (x and y from its top left); or, when it's the page's own layer, as on a game board, drag there anyway with force: the cover takes the events, as it would a user's.";

/** waitForControl ran out while the user still has control (its data names the ownership). */
const STILL_THE_USERS =
  "The user still has control: end the round, tell them what you need, and resume with takeOverTaskSpace(id) once they say so.";

// What counts as evidence of danger in a page (SPI, "The evidence flag"):
// hooked, made, listed and flagged.
const EVIDENCE =
  "a page with evidence (your code wrote into it, you opened it as a data: or blob: page, a phishing or malware list names its site, or you flagged it)";

// With no location, sites ask for a typed place. A device is the user's
// during their hold, unless the page shows evidence (docs/PROTOCOL.md,
// "Permission prompts in a task's pages").
const DEVICE_NEXT =
  "For the location, sites then ask for a typed place (a city or postcode): type it, or ask the user for it. If the task needs a device, hand the task to the user with task.handOff({ message }) saying what for: the page asks them during their hold, unless the message names evidence; then tell the user it works in their own tab.";

export const REFUSAL_GUIDE: Record<string, RefusalGuide> = {
  print: {
    what: "The page called window.print(): no print dialog opens, and the page saw a Cancel.",
    next: "Nothing to do; to keep what the page shows, take a screenshot().",
  },
  httpAuth: {
    what: "The site asked for a username and password (HTTP authentication): no sign-in dialog opens, and the page without them loads.",
    next: "If the task needs the sign-in, call task.handOff() so the user signs in; never guess credentials.",
  },
  passkey: {
    what: "The page asked for a passkey after earlier requests in the task went unanswered, so it got NotAllowedError without asking the user.",
    next: "If the task needs it, call task.handOff() and tell the user what to approve.",
  },
  permissionPrompt: {
    what: "The page asked for a permission, such as for storage access, after earlier requests in the task went unanswered, so the prompt was cancelled without asking the user.",
    next: "If the task needs it, call task.handOff() and tell the user what to allow.",
  },
  externalApp: {
    what: "A link tried to open another app (mailto:, zoommtg:, …): nothing opened.",
    next: "If the user should open it, tell them the link.",
  },
  addonInstall: {
    what: "A navigation led to a browser add-on: nothing was downloaded or installed.",
    next: "If the user wants it, tell them the link.",
  },
  popupBlocked: {
    what: "The page opened a pop-up without a user action, and the browser blocked it, as for any page.",
    next: "Click what opens it (page.click).",
  },
  redirectBlocked: {
    what: "A frame tried to redirect the whole page without a user action, and the browser blocked it.",
    next: "If the page needs it, click what triggers it, or goto its URL.",
  },
  protocolHandler: {
    what: "The page asked to handle a kind of link for the user (registerProtocolHandler): refused.",
    next: "Nothing to do.",
  },
  fullscreen: {
    what: "The page asked for fullscreen: denied, so it stays in its tab.",
    next: "Nothing to do.",
  },
  pointerLock: {
    what: "The page locked the pointer: released at once.",
    next: "Nothing to do; drive the page with the mouse methods.",
  },
  wakeLock: {
    what: "navigator.wakeLock.request() was refused.",
    next: "Nothing to do.",
  },
  speech: {
    what: "speechSynthesis.speak() was refused, so nothing was spoken.",
    next: "Nothing to do.",
  },
  share: {
    what: "navigator.share() was refused, as after a Cancel.",
    next: "If the user should share it, tell them the link.",
  },
  colorPicker: {
    what: "No color picker opens in agent tabs.",
    next: "Set the value with page.fill().",
  },
  datePicker: {
    what: "No date or time picker opens in agent tabs.",
    next: "Set the value with page.fill().",
  },
  selectDropdown: {
    what: "No dropdown opens for a <select> in agent tabs.",
    next: "Choose with page.selectOption().",
  },
  clipboardRead: {
    what: "The page asked to read the task's clipboard, which only the site that wrote it may read.",
    next: "Nothing to do; your own paste still works.",
  },
  download: {
    what: "zenius refused a download, as its message says: the task holds as many downloads, or as many MB, as it may.",
    next: "Delete the downloads the task no longer needs with download.delete(), which deletes their files in the working folder, to make room, or ask the user to raise the limit.",
  },
  audio: {
    what: "The tab plays sound while the user can't see it, so zenius muted it: muted, not refused.",
    next: "Nothing to do; the sound comes back when the user opens the tab.",
  },
  serviceWorker: {
    what: "The page, or a worker it started, tried to register a service worker: refused in a task's pages for the task's whole life, since it would stay in the user's profile and run in their own tabs on the site. The page got a SecurityError (\"The operation is insecure.\"). Or the page, or a worker it started, tried to reach the site's own worker, which the user's tabs registered: a task's pages and their workers don't use it, so to them the site has none. Or that worker sent the page, or a worker it started, a message: zenius dropped it and closed the ports it carried.",
    next: "Nothing to do; the site works without it. If the task needs the site's offline or push features, tell the user they work in their own tab.",
  },
  cacheStorage: {
    what: "The page, or a worker it started, tried to write to the site's Cache Storage: refused in a task's pages, since what it stores would reach the user's own tabs on the site after the task. The page got a SecurityError (\"The operation is insecure.\"); reads still work.",
    next: "Nothing to do; the page loads what it needs from the network.",
  },
  deviceAccess: {
    what: `The page asked for the camera, microphone, screen, speakers or speech recognition while you drive it, or for any of these, the location or MIDI on ${EVIDENCE}, where they stay refused during the user's hold too. zenius refused it before any prompt, since the system's consent would cover the user's whole browser: the page got a user's no (NotAllowedError; location: PERMISSION_DENIED), and enumerateDevices() lists none. With api "stopSharing", zenius stopped the streams the user started in the page during their hold, as it came back to you.`,
    next: DEVICE_NEXT,
  },
  notification: {
    what: `The page tried to show a desktop notification on ${EVIDENCE}, during the user's hold too, or a worker of a task's page tried to, which is always refused. The page got an error event (new Notification) or a TypeError (showNotification).`,
    next: "Nothing to do; read what the page shows instead.",
  },
  promptDenied: {
    what: `zenius cancelled a permission prompt without asking the user, and stored nothing for the site: on ${EVIDENCE}, every prompt is cancelled, during the user's hold too, and while you drive, so is the camera, microphone, screen or speakers' prompt. The message says which. The page got what a dismissed prompt gives (location: PERMISSION_DENIED).`,
    next: DEVICE_NEXT,
  },
  localNetwork: {
    what: "The page, or a blob: shared worker of its site, tried to reach a private or link-local address or a .local name, or the page tried to start WebRTC, which reads local addresses: refused in a task's pages, since macOS's consent for the local network would cover the user's whole browser. Loopback stays open; new RTCPeerConnection() throws NotAllowedError. A shared worker from a data: URL is refused too (SecurityError): its requests name no site, so zenius couldn't keep them from the local network.",
    next: "Your own load of that host just fails. If the task needs it, call task.handOff({ message }) with what the user must do, such as \"Open 10.0.0.1 in this tab\", or ask in your reply. When the user types the address in your tab, its card offers Open it yourself, which opens it in a tab of theirs, and Add to allowlist, which lets every agent tab reach that host and loads it in your tab for you after Resume agent. Mention the allowlist only as the way to let you do the step yourself. You can't see the user's own tab, so ask for anything you need back, such as a confirmation or a value. An allowlist entry is removed in about:config (zenius.agentTabs.allowPrivateNetworks). WebRTC (calls) works only in the user's own tab.",
  },
  userTabNavigation: {
    what: "A page where the agent's code ran tried to load a page in a tab outside the task, such as the user's tab that opened it: zenius stopped the load before it was sent, and that tab stayed as it was. The page heard nothing.",
    next: "Nothing to do; load what the task needs in a Page of its own (task.newPage()).",
  },
  heldPageNavigation: {
    what: "A page tried to load a page in the page the user holds after a hand-off, or in one of its frames: while the user holds a page, no other page moves it, so zenius stopped the load before it was sent, and the page stayed as it was. The page heard nothing.",
    next: "Nothing to do; wait for the user to hand the task back.",
  },
  browserConfirmation: {
    what: "Firefox asked to confirm what the page did, such as sending a form from a secure page over an insecure connection, or sending a form again on a reload: zenius answered Cancel, so it didn't happen. The message quotes Firefox's question.",
    next: "If the task needs it, tell the user: they can do it in their own tab. To see a page a form posted to again, go to its URL instead of reloading it.",
  },
};

/**
 * The next step to add to an error's message, or undefined when it has
 * none or the message already says what to do.
 */
export function nextStep(code: string, message: string, data?: Record<string, unknown>): string | undefined {
  const guide = CODE_GUIDE[code];
  if (!guide) return undefined;
  // Unlike the hard stops, the wait after the user's input ends by itself.
  if (code === "ZEN_TASK_SPACE_USER_IN_CONTROL" && typeof data?.retryAfterMs === "number") {
    const wait = userInputWaitNext(data.retryAfterMs);
    return message.includes(wait) ? undefined : wait;
  }
  if (guide.owned) return undefined;
  // zenius refused the load (the local network, an add-on install): the site
  // isn't down, and the refusal's own words say what to do.
  if (code === "ZEN_NAVIGATION_FAILED" && (data?.error === "localNetwork" || (Array.isArray(data?.refused) && data.refused.length > 0))) {
    return undefined;
  }
  const special =
    code === "ZEN_NAVIGATION_FAILED" && data?.certificateWarning === true
      ? CERTIFICATE_NEXT
      : code === "ZEN_NAVIGATION_FAILED" && message.endsWith("navigation started a download")
        ? DOWNLOAD_NEXT
        : code === "ZEN_PAGE_DIALOG_OPENED" && / opened while \S+ was running/.test(message)
        ? DIALOG_DURING_NEXT
        : code === "ZEN_AGENT_CODE_REFUSED" && data?.reason === "hold"
        ? HOLD_NEXT
        : code === "ZEN_PAGE_NOT_FOUND" && data?.reason === "theirs"
        ? THEIRS_NEXT
        : code === "ZEN_PAGE_GLOBAL_HIDDEN" && /from the DOM/.test(message)
        ? PAGE_GLOBAL_MARKUP_NEXT
        : code === "ZEN_TIMEOUT" && typeof data?.ownership === "string" && data.ownership !== "agent"
        ? STILL_THE_USERS
        : code === "ZEN_TIMEOUT" && data?.reason === "no_response"
          ? NO_RESPONSE_NEXT
          : code === "ZEN_NOT_ACTIONABLE" && data?.reason === "covered"
          ? (data.end === "source" || data.end === "target" ? COVERED_DRAG_NEXT : COVERED_NEXT)
          : code === "ZEN_BROWSER_UNAVAILABLE" && (data?.errno === "EPERM" || data?.errno === "EACCES")
            ? SANDBOX_BLOCKED_NEXT
            : undefined;
  if (special) return message.includes(special) ? undefined : special;
  if (guide.said?.test(message)) return undefined;
  const next = guide.next.replace("{help}", helpFor(message));
  return message.includes(next) ? undefined : next;
}

/** The message with its next step on a line of its own. */
export function withNextStep(code: string, message: string, data?: Record<string, unknown>): string {
  const next = nextStep(code, message, data);
  return next ? `${message}\n${next}` : message;
}

/** help("page.click") for an error from page.click, when help() knows the method. */
function helpFor(message: string): string {
  const name = /^([a-z][A-Za-z]*(?:\.[A-Za-z]+)+)/.exec(message)?.[1];
  return name && apiEntry(normalizeApiName(name)) ? `help("${name}") prints its signature and options` : "help() lists every method's signature";
}

/** What a refused kind is, before help("errors") and the docs (docs.ts) list them. */
export const REFUSED_KINDS =
  "In an agent tab, zenius doesn't open browser UI that would cover the user's view, leave the browser or touch the OS. Nothing throws: the page gets the answer it already handles, and the action's receipt lists { kind, message } in refused, as page.events() does in Zenius.refused events.";

/** help("errors"): every code, then every refused kind. */
export function errorsHelp(): string {
  const codes = Object.keys(CODE_GUIDE).flatMap((code) => {
    const parts = codeParts(code);
    return parts ? [formatCode(code, parts)] : [];
  });
  const kinds = Object.entries(REFUSAL_GUIDE).map(([kind, guide]) => `${kind}\n  ${guide.what}\n  Next: ${guide.next}`);
  return [
    "Error codes",
    "",
    "error.code (and error.error_code, as in Ego) is one of these; Ego's EGO_ codes are zenius's ZEN_ ones. The message says what happened, then, on a line of its own, what to do next. help(\"<code>\") prints one.",
    "",
    codes.join("\n\n"),
    "",
    "Refused kinds",
    "",
    REFUSED_KINDS,
    "",
    kinds.join("\n\n"),
  ].join("\n");
}

/** help("ZEN_REF_STALE"), or undefined for a name that isn't a code. */
export function codeHelp(name: string): string | undefined {
  const parts = codeParts(name);
  return parts && formatCode(name, parts);
}

/** A code's notes (Ego's code, a plain Error), what happened, and what to do next. */
export type CodeParts = { notes: string[]; what: string; next: string };

/** A code as help() and the docs (docs.ts) show it, or undefined for a name that isn't one agents read. */
export function codeParts(name: string): CodeParts | undefined {
  const guide = Object.hasOwn(CODE_GUIDE, name) ? CODE_GUIDE[name] : undefined;
  if (!guide || guide.unlisted) return undefined;
  return {
    notes: [guide.ego ? `Ego: ${guide.ego}` : "", guide.plain ? "often a plain Error with no code, as in Ego" : ""].filter(Boolean),
    what: guide.what,
    next: guide.next.replace("{help}", 'help("<method>") prints its signature and options'),
  };
}

function formatCode(code: string, { notes, what, next }: CodeParts): string {
  return [`${code}${notes.length ? ` (${notes.join("; ")})` : ""}`, `  ${what}`, `  Next: ${next}`].join("\n");
}
