// zenius's docs about itself, for the agents that use it: what each error
// code means and what to do next, which URLs agents may load, where a
// script's files go, and this version's limits. Each topic is built from the
// code that does what it says (error-guide.ts, files.ts, limits.ts, and the
// runtime's constants in RUNTIME_LIMITS, which test/docs.test.ts checks
// against their sources), so an install's docs are its own version's.
//
// The same text goes out four ways: the MCP server's docs tool and its
// zenius://docs/<topic> resources (mcp.ts), `zenius docs [topic]` (cli.ts),
// and the skill's references, skill/zenius/references/<topic>.md, which
// scripts/write-references.ts writes from here and test/docs.test.ts keeps
// in step.

import { CODE_GUIDE, codeParts, REFUSAL_GUIDE, REFUSED_KINDS } from "./error-guide.ts";
import { MAX_LINE, MAX_WAIT_S } from "./feedback.ts";
import { readFolders, UPLOAD_LIMIT_BYTES, UPLOAD_LIMIT_FILES, writeFolders } from "./files.ts";
import { defaultEntries, formatEntry } from "./help.ts";
import {
  CALL_MARGIN_S,
  MAX_RESULT_CHARS,
  MAX_SNAPSHOT_CHARS,
  REPORT_CALL_S,
  SCRIPT_DEFAULT_S,
  SCRIPT_MAX_S,
  TASK_NAME_MAX,
  WAIT_DEFAULT_S,
  WAIT_MAX_S,
  WAIT_USER_DEFAULT_S,
  WAIT_USER_MAX_S,
  WEB_PROTOCOLS,
} from "./limits.ts";
import { VERSION } from "./version.ts";

/**
 * A limit set outside the SDK, and where: the docs test reads `file` for
 * `name`, a constant or a key of the runtime's LIMITS, and checks the value,
 * and that `file` names `pref`, the setting that changes it.
 */
type SourcedLimit = { file: string; name: string; value: number; pref?: string };

/** The runtime's defaults and limits the docs state, and the launcher's one. */
export const RUNTIME_LIMITS = {
  goto: { file: "runtime/JS/zenius/observe/common.sys.mjs", name: "GOTO_TIMEOUT_MS", value: 15_000 },
  wait: { file: "runtime/JS/zenius/observe/common.sys.mjs", name: "WAIT_TIMEOUT_MS", value: 10_000 },
  fetch: { file: "runtime/JS/zenius/observe/common.sys.mjs", name: "FETCH_TIMEOUT_MS", value: 20_000 },
  action: { file: "runtime/JS/zenius/methods/actions.sys.mjs", name: "DEFAULT_ACTION_TIMEOUT_MS", value: 3000 },
  control: { file: "runtime/JS/zenius/modules/spaces.sys.mjs", name: "CONTROL_WAIT_TIMEOUT_MS", value: 600_000 },
  pages: { file: "runtime/JS/zenius/modules/pages.sys.mjs", name: "DEFAULT_PAGE_BUDGET", value: 8 },
  downloads: { file: "runtime/JS/zenius/observe/downloads.sys.mjs", name: "DEFAULT_MAX_COUNT", value: 50 },
  downloadMiB: { file: "runtime/JS/zenius/observe/downloads.sys.mjs", name: "DEFAULT_MAX_MIB", value: 1024 },
  reportCooldown: { file: "runtime/JS/zenius/modules/feedback.sys.mjs", name: "DECLINED_MS", value: 600_000 },
  remoteRunning: { file: "runtime/JS/zenius/methods/sidebar.sys.mjs", name: "maxRunning", value: 2 },
  remoteHourly: { file: "runtime/JS/zenius/methods/sidebar.sys.mjs", name: "maxPerHour", value: 20 },
  remoteSeconds: { file: "runtime/JS/zenius/methods/sidebar.sys.mjs", name: "maxTaskSeconds", value: 3600 },
  agentPointer: {
    file: "runtime/JS/zenius/content/capture.sys.mjs",
    name: "AGENT_POINTER_ID",
    value: 32767,
    pref: "zenius.input.agentPointerId",
  },
} satisfies Record<string, SourcedLimit>;

/** What each MCP tool calls in the SDK, for an error's next step, which names the script's call. */
export const TOOL_CALLS: Array<[tools: string, calls: string]> = [
  ["open and goto", "page.goto()"],
  ["read_page", "page.snapshot()"],
  ["click, fill, press and select", "page.click(), page.fill(), page.press() and page.selectOption()"],
  ["wait", "page.waitForSelector(), page.waitForURL() and page.waitForLoadState(), or with user: true task.waitForControl()"],
  ["hand_off", "task.handOff()"],
  ["evaluate", "page.evaluate()"],
  ["finish", "task.finish()"],
];

/** `skill: false`: zenius mcp's alone, so the skill, for the CLI, has no reference of it. */
type Topic = { name: string; title: string; summary: string; body: () => string; skill?: false };

const TOPICS: Topic[] = [
  {
    name: "errors",
    title: "Error codes",
    summary:
      "what each error code means, and what to do next. A code, such as ZEN_URL_NOT_ALLOWED, or a refused kind, such as localNetwork, as the topic gives that one alone.",
    body: errorsBody,
  },
  { name: "urls", title: "URLs", summary: "which URLs agents may load, and the pages where they can't act.", body: urlsBody },
  { name: "files", title: "Files", summary: "where a script's files go, and which files it may upload.", body: filesBody },
  { name: "limits", title: "Limits", summary: "this version's limits and default timeouts, and the agent's pointer id.", body: limitsBody },
  {
    name: "script",
    title: "Scripts in zenius mcp",
    summary: "how zenius mcp's script tool runs a script: its task, the user, its files, its time limit, and the API.",
    body: scriptBody,
    skill: false,
  },
];

/** The topics the skill has as references (sdk/scripts/write-references.ts). */
export const SKILL_TOPICS: readonly string[] = TOPICS.filter((topic) => topic.skill !== false).map((topic) => topic.name);

/** The topics, in the order the index lists them. */
export const DOC_TOPICS: ReadonlyArray<Pick<Topic, "name" | "title" | "summary">> = TOPICS.map(({ name, title, summary }) => ({
  name,
  title,
  summary,
}));

/**
 * The docs for a topic, a code or a refused kind, as the docs tool and
 * `zenius docs` serve them: after a line naming this version. No topic gives
 * the index; one that names nothing gives the index too, with found false.
 */
export function docsText(topic?: string): { text: string; found: boolean } {
  const asked = topic?.trim() ?? "";
  const body = asked ? lookup(asked) : index();
  // The name as asked, without what could change how the line reads (bidi
  // controls and the like): a sidebar may show the result.
  const shown = Array.from(asked.replace(/[\p{Cc}\p{Cf}]/gu, "")).slice(0, 80).join("");
  const text = body ?? `There is no zenius doc named "${shown}".\n\n${index()}`;
  return { text: `zenius ${VERSION}\n\n${text}`, found: body !== undefined };
}

/** A topic's text as the skill's reference has it: the same body, without the version (the skill carries it). */
export function referenceText(name: string): string {
  const topic = TOPICS.find((t) => t.name === name);
  if (!topic) throw new Error(`docs: no topic named ${name}`);
  return `<!-- Written from zenius's sources by sdk/scripts/write-references.ts: change those, then run it. -->\n\n${topic.body()}\n`;
}

function index(): string {
  return [
    "# zenius docs",
    "",
    "About zenius itself, for this version. The topics:",
    "",
    ...TOPICS.map((t) => `- ${t.name}: ${t.summary}`),
  ].join("\n");
}

function lookup(asked: string): string | undefined {
  const name = asked.toLowerCase();
  const topic = TOPICS.find((t) => t.name === name);
  if (topic) return topic.body();
  const code = Object.keys(CODE_GUIDE).find((c) => c.toLowerCase() === name);
  if (code && codeParts(code)) return `${codeSection(code, "#")}\n\nThe errors topic has every code.`;
  const kind = Object.keys(REFUSAL_GUIDE).find((k) => k.toLowerCase() === name);
  if (kind) return `${kindSection(kind, "#")}\n\nA refused kind: ${REFUSED_KINDS}\n\nThe errors topic has every kind.`;
  return undefined;
}

/** A code as a section: its name and notes, what happened, and what to do next. */
function codeSection(code: string, level = "###"): string {
  const parts = codeParts(code);
  if (!parts) throw new Error(`docs: ${code} isn't a code agents read`);
  const notes = parts.notes.length ? ` (${parts.notes.join("; ")})` : "";
  return [`${level} ${code}${notes}`, "", parts.what, "", `Next: ${parts.next}`].join("\n");
}

function kindSection(kind: string, level = "###"): string {
  const guide = REFUSAL_GUIDE[kind];
  if (!guide) throw new Error(`docs: ${kind} isn't a refused kind`);
  return [`${level} ${kind}`, "", guide.what, "", `Next: ${guide.next}`].join("\n");
}

function errorsBody(): string {
  const codes = Object.keys(CODE_GUIDE).filter((code) => codeParts(code));
  return [
    "# Error codes",
    "",
    "A failed call's error carries a code: error.code in a script (error.error_code too, as in Ego, whose EGO_ codes are zenius's ZEN_ ones), and the line after the step in an MCP tool's result. Its message says what happened, then, on a line of its own, what to do next.",
    "",
    "The next steps name a script's calls. The MCP tools make the same ones:",
    "",
    ...TOOL_CALLS.map(([tools, calls]) => `- ${tools}: ${calls}`),
    "",
    "help() is the CLI's: zenius help <name>.",
    "",
    "## Codes",
    "",
    codes.map((code) => codeSection(code)).join("\n\n"),
    "",
    "## Refused kinds",
    "",
    REFUSED_KINDS,
    "",
    Object.keys(REFUSAL_GUIDE)
      .map((kind) => kindSection(kind))
      .join("\n\n"),
  ].join("\n");
}

function urlsBody(): string {
  return [
    "# URLs",
    "",
    `Which URLs agents may load, and the pages where they can't act. The MCP tools open and goto take only ${WEB_PROTOCOLS.join(" and ")} URLs. A script's page.goto() takes every URL that ZEN_URL_NOT_ALLOWED below allows.`,
    "",
    codeSection("ZEN_URL_NOT_ALLOWED"),
    "",
    codeSection("ZEN_PAGE_NOT_WEB_CONTENT"),
    "",
    codeSection("ZEN_SIGN_IN_PAGE"),
    "",
    "## Refused without an error",
    "",
    "Nothing throws for these: the page gets the answer it already handles, and the action's receipt lists the kind in refused.",
    "",
    kindSection("localNetwork"),
    "",
    kindSection("externalApp"),
  ].join("\n");
}

function filesBody(): string {
  const mb = UPLOAD_LIMIT_BYTES / (1024 * 1024);
  return [
    "# Files",
    "",
    "## In a script",
    "",
    "page.screenshot({ path }), page.fetch()'s saveAs and download.saveAs() write the file the path names; page.setInputFiles() and fileChooser.setFiles() read the files their paths name and send the bytes. The CLI reads and writes these files, never Zen.",
    "",
    "- The working folder, ~/zenius-files unless the install set another, is where a relative path lands, and where a finished download is: download.path() returns its path there, and it stays after the script ends. The files a run wrote there are listed after its output under [zenius:files].",
    "- The plain CLI runs a script with the user's own access to files.",
    `- The sandboxed CLI (zenius --version ends in sandboxed) keeps a script to a few folders. A script writes only to ${writeFolders("process.env.ZENIUS_WORKING_DIR")}. A script reads files to upload only in ${readFolders("the folder the install lets scripts read (install-cli.sh --read-dir, such as ~/Downloads; process.env.ZENIUS_READ_DIR)")}, and a link that leads outside them is refused too.`,
    `- An upload sends at most ${mb} MB in all. A folder's path uploads that one folder alone, at most ${UPLOAD_LIMIT_FILES.toLocaleString("en-US")} files.`,
    "",
    codeSection("ZEN_PATH_NOT_ALLOWED"),
    "",
    "## Through the MCP tools",
    "",
    "The one-step MCP tools read and write no files: they offer no upload and no screenshot. A file a page downloads in the task lands in the working folder, and a later result says where, under which name, or why it failed. wait with downloads: true waits for the downloads still running, and finish refuses while one runs, since the task's end would cancel it, unless cancel_downloads is true.",
    "",
    "The script tool, which only a server under the sandboxed launcher offers, runs a script with the launcher's folders:",
    "",
    "- In Zen's agent sidebar (zenius mcp --sidebar): the working folder, to read, write and delete, and the script's own temporary folder, its TMPDIR, which goes when its call ends. No other folder: a script starts in the working folder, and keeps a screenshot by saving it there.",
    "- In a terminal: the folders its zenius nodejs gets from the same folder.",
    "- Its result lists the files it read, wrote, deleted and uploaded, as far as the server saw.",
  ].join("\n");
}

/**
 * The API's task functions, which a script in zenius mcp gets in the
 * server's own versions (mcp-script.ts): the topic says what those do.
 */
const SERVER_TASK_FUNCTIONS = new Set(["profiles", "listTaskSpaces", "taskSpace", "claimTaskSpace", "takeOverTaskSpace"]);

/**
 * The script edition of the guide, which the script tool's description and
 * the sidebar's Work point to before a first script. It stays within what
 * both clients keep of a result (Codex about 10,000 tokens).
 */
function scriptBody(): string {
  return [
    "# Scripts in zenius mcp",
    "",
    "The script tool runs a zenius nodejs script in this server's task: JavaScript with zenius's Page and TaskSpace API, for work of many steps in one call, such as a loop over pages or over files in the working folder. Only a server under the sandboxed launcher offers it.",
    "",
    "## A call",
    "",
    `- code is the body of an async function: top-level await and return work. Its console output, then what it returns, as JSON, come back; past ${MAX_RESULT_CHARS.toLocaleString("en-US")} characters they're cut.`,
    "- purpose is one line the user reads as the step, such as Compare the three flights' prices. Never a password, card number or code.",
    '- task is this server\'s task, null until open or taskSpace("<a name>") starts it. page is the current tab, or the one the call\'s page names (p1, p2, ...).',
    "- One call runs at a time. The task, its tabs and the working folder carry over to the next call; a script's variables don't, so return or write what the next one needs.",
    `- Its time limit is seconds, else ${SCRIPT_DEFAULT_S} s, at most ${SCRIPT_MAX_S} s, and never past the client's tool timeout less ${CALL_MARGIN_S} s. At the limit its call answers with the output so far, and its later calls to Zen fail.`,
    "- Wait with page.waitForSelector(), waitForURL() and waitForLoadState(), or with the wait tool, never with a busy loop: a loop with no await holds the server until the client gives up.",
    "",
    "## The task",
    "",
    '- taskSpace() returns this server\'s task, by its name or id too. With no task yet, taskSpace("<a name>") starts one, as open does. Any other task is refused.',
    "- listTaskSpaces() lists this server's task alone.",
    "- claimTaskSpace() and takeOverTaskSpace() are refused: here only the user gives a task back.",
    "",
    "## The user",
    "",
    "- To hand the task to the user, for signing in, paying, a captcha or a code, end the script with task.handOff(), since its later calls are refused. Then call the wait tool with user: true.",
    "- After the user's Take over, the script's next call fails with ZEN_TASK_SPACE_USER_IN_CONTROL. Let that end the script rather than catching it, then ask the user to press Resume agent in Zen, and call the wait tool with user: true.",
    "- When the user stops the script with Stop in Zen's sidebar, its call ends: don't run it again unless they ask.",
    "",
    "## Files",
    "",
    "- In Zen's agent sidebar a script starts in the working folder, where relative paths and downloads land, and it may read, write and delete there. Its own temporary folder, TMPDIR, goes when its call ends. No other folder is open to it. In a terminal it has the folders zenius nodejs has there.",
    "- The result lists the files it read, wrote, deleted and uploaded, as far as the server saw.",
    "- The files topic has the rules for paths and uploads.",
    "",
    "## The API",
    "",
    'The CLI\'s API as help() in a script lists it, without the task functions above. help("<name>") in a script gives one entry, and the errors topic every error code.',
    "",
    defaultEntries()
      .filter((entry) => !SERVER_TASK_FUNCTIONS.has(entry.name))
      .map(formatEntry)
      .join("\n\n"),
  ].join("\n");
}

/** A duration as the docs say it: 15 s, 10 min, 1 h. */
const duration = (ms: number) =>
  ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1000} s`;

function limitsBody(): string {
  const L = RUNTIME_LIMITS;
  return [
    "# Limits",
    "",
    "## Script timeouts",
    "",
    "Each call's timeout option sets its own.",
    "",
    `- page.goto() and page.reload(): ${duration(L.goto.value)} to reach their waitUntil state, load unless it says.`,
    `- page.waitForSelector(), waitForURL(), waitForLoadState(), waitForFunction() and waitForEvent(): ${duration(L.wait.value)}.`,
    `- Actions such as page.click() and page.fill(): ${duration(L.action.value)} for the element to become usable. A selector that matches nothing on an idle page fails sooner.`,
    `- page.fetch(): ${duration(L.fetch.value)}.`,
    `- task.waitForControl(): ${duration(L.control.value)}.`,
    "",
    "## A task",
    "",
    `- Pages: ${L.pages.value} open at once, unless EGO_BROWSER_PAGE_BUDGET sets another number. One more gets ZEN_PAGE_BUDGET_REACHED.`,
    `- Downloads: ${L.downloads.value} files and ${L.downloadMiB.value.toLocaleString("en-US")} MiB held at once.`,
    `- Uploads: ${UPLOAD_LIMIT_BYTES / (1024 * 1024)} MB in all per call, and ${UPLOAD_LIMIT_FILES.toLocaleString("en-US")} files in a folder upload.`,
    `- Remote tasks (zenius sidebar start): ${L.remoteRunning.value} running at once, and ${L.remoteHourly.value} started in an hour. One more gets ZEN_REMOTE_LIMIT. Each ends after ${duration(L.remoteSeconds.value * 1000)}.`,
    "",
    "## The agent's mouse",
    "",
    `- The agent's mouse events carry pointerId ${L.agentPointer.value} (PointerEvent.pointerId), not the real mouse's 0, so that a page's pointer capture of the agent's press can't take the user's mouse. If a site breaks on that id, the user can set ${L.agentPointer.pref} to 0 in about:config, which gives the agent's events the real mouse's id again.`,
    "",
    "## Pages that load afresh",
    "",
    "- Page code (page.evaluate(), waitForFunction()) that leaves code in a page, or a change to what the user types into, hooks the page: a script element, an inline handler (onclick=...), a javascript: URL, the page's eval or Function, a string timer, a frame, an object or embed, a form or field, an editable area, a base element, a meta refresh, a style sheet, style rule or font face, a shadow root, document.write. Reading the page, clicking, and setting values, text, classes, inline styles or other attributes don't.",
    "- zenius loads a hooked page afresh when it's handed to the user, before the user clicks or types there, and at the task's end. The load carries the form's fields over, but what the page keeps only in its memory, such as a game's moves or an editor's undo, is lost.",
    "- The call that hooks a page says so in a notice, which zenius mcp's evaluate tool and script result show, and at the task's end Zen's agent sidebar names the pages that loaded afresh.",
    "- To keep such state, leave nothing in the page, or reach the state's own address first with page.goto(), such as a board's position in its URL. An address the agent's code sets in place (history.pushState(), the hash) doesn't keep it: the load goes to the address the page had before.",
    "",
    "## The MCP tools",
    "",
    `- read_page returns at most ${MAX_SNAPSHOT_CHARS.toLocaleString("en-US")} characters: read a part with root: ref=N.`,
    `- evaluate returns at most ${MAX_RESULT_CHARS.toLocaleString("en-US")} characters.`,
    `- open names the task in at most ${TASK_NAME_MAX} characters.`,
    `- wait: ${WAIT_DEFAULT_S} s unless its seconds says otherwise, at most ${WAIT_MAX_S} s. With user: true, ${WAIT_USER_DEFAULT_S} s, at most ${WAIT_USER_MAX_S} s.`,
    `- report_problem answers within ${REPORT_CALL_S} s, unless its wait asks for longer: at most ${WAIT_USER_MAX_S} s.`,
    `- script: ${SCRIPT_DEFAULT_S} s unless its seconds says otherwise, at most ${SCRIPT_MAX_S} s. At its limit its call ends with the output so far, and its later calls fail.`,
    `- No call goes past the client's tool timeout less ${CALL_MARGIN_S} s: a script's limit, wait and report_problem. The client's server entry gives it as ZENIUS_TOOL_TIMEOUT, in seconds; without it, Codex and other clients get 60 s, and Claude Code none.`,
    "",
    "## Problem reports",
    "",
    `- A report's line: at most ${MAX_LINE} characters.`,
    `- zenius feedback --wait: at most ${MAX_WAIT_S} s.`,
    `- After the user discards a report, no new one shows for ${duration(L.reportCooldown.value)}.`,
  ].join("\n");
}
