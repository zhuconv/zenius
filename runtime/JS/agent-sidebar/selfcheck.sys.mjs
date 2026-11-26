/* Agent Sidebar, the post-install self-check's scenarios: the sidebar's half
 * of the self-check. The core's runner and its window are in
 * zenius/modules/selfcheck.sys.mjs.
 *
 * The runner opens a window that isn't a browser window and hands it here:
 *  - prepare(win) fills its host box with the panel and All tasks' drawer,
 *    and gives that window a glue of its own (the .uc.js glue loads only in
 *    browser windows). Its sidebar lists only the run's tasks, talks only to
 *    an agent in this process, and writes no pref, file or draft of the
 *    user's. It returns the run's scope.
 *  - run(win, {shot, checked, signal}) goes through install-daily.md's step 6
 *    checks, in its order: the ⋯ menu, Archive, and sending that follows the
 *    answer. Each step ends with shot("<check>/<step>", rect).
 *  - cleanup() ends the run's tasks and agent; it's safe to call again.
 *
 * What keeps the user's sidebar out of it is AgentService's scope
 * (openScope), on two conditions:
 *  - a synthetic task is never in AgentService.tasks, so it's never saved,
 *    never in sidebar.status or list, never in zenius's waiting line, and
 *    never in another window's list;
 *  - it never gets a zenius task or a remote record: the agent here has no
 *    tools and no network, so noteZen, remoteChanged and zenius's
 *    notifications never hear of it.
 *
 * The panel's and All tasks' parts a check reads and drives are
 * sidebarview.sys.mjs's, which the tests (tests/ux) read them by too.
 */

import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { AgentService, SELF_CHECK_HARNESS } from "./AgentService.sys.mjs";
import { Directory } from "./directory.sys.mjs";
import { sidebarView, stopIfAborted, waitFor } from "./sidebarview.sys.mjs";

const PANEL_URL = new URL("panel.html", import.meta.url).href;
const PREF_SHORTCUT = "uc.agent-sidebar.shortcut";
// The panel as wide as a sidebar a user keeps, and room beside it for All
// tasks' drawer (directory.sys.mjs's WIDTH), which comes out of its edge.
const SIDEBAR_WIDTH = 420;
const MIN_WIDTH = 300;
const DRAWER_ROOM = 280;
// How long a step waits for the panel or the agent before it fails.
const WAIT_MS = 15000;
// The agent's pace while it writes numbered lines: slow enough to scroll
// mid-answer, quick enough for the run's limit.
const LINE_MS = 30;

const EARLIER = {
  question: "An earlier task of the self-check.",
  answer: "Done: this task was here before the run's own.",
};
const FIRST = "Say hello for the self-check.";
const FIFTY = "Write 50 numbered lines, one short sentence each.";
const MORE = "Now 50 more, numbered on from 51.";

// The three checks, in step 6's order (docs/install-daily.md).
const CHECKS = [
  { id: "menu", title: "The ⋯ menu", run: menuCheck },
  { id: "archive", title: "Archive, Archived and Unarchive", run: archiveCheck },
  { id: "follow", title: "Sending follows the answer", run: followCheck },
];

// --- The agent ----------------------------------------------------------------

/**
 * The self-check's agent: AcpConnection's shape, in this process. It answers
 * in words alone (no tool, no permission, no ask) and reaches nothing: no
 * process, no file, no network. Its answers are fixed by the question, so a
 * run looks the same each time. `holdAt` pauses a numbered answer after a
 * line, so a check can scroll while it's still writing.
 */
class SelfCheckAgent {
  exited = false;
  stopping = false;
  initResult = null;
  lastUsed = Date.now();
  harness = SELF_CHECK_HARNESS;
  slot = SELF_CHECK_HARNESS;
  config = {};
  onNotification = () => {};
  onRequest = () => {};
  onExit = () => {};

  #sessions = new Map(); // id -> { turn: {cancelled} | null }
  #count = 0;
  #stopAt = null; // a numbered answer pauses once it has this many lines
  #resume = null; // goes on from that pause
  #lines = 0; // the numbered lines the current answer has written

  get appendsSystemPrompt() {
    return false;
  }

  get restoreMethods() {
    return ["session/resume"];
  }

  get closesSessions() {
    return true;
  }

  get forksSessions() {
    return false;
  }

  async start() {
    this.initResult = {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, embeddedContext: true },
        sessionCapabilities: { resume: {}, close: {} },
      },
      authMethods: [],
      agentInfo: { name: "zenius self-check", version: "1" },
    };
    return this.initResult;
  }

  /** The numbered lines the answer being written has so far. */
  get lines() {
    return this.#lines;
  }

  /** A numbered answer writes on until it has `at` lines, then pauses: from a pause, it goes on. */
  holdAt(at) {
    this.#stopAt = at;
    this.#wake();
  }

  /** It writes on to its end. */
  release() {
    this.#stopAt = null;
    this.#wake();
  }

  #wake() {
    const resume = this.#resume;
    this.#resume = null;
    resume?.();
  }

  async request(method, params = {}) {
    if (this.exited) {
      throw new Error("the agent is not running");
    }
    switch (method) {
      case "session/new": {
        const sessionId = `selfcheck-${++this.#count}`;
        this.#sessions.set(sessionId, { turn: null });
        return { sessionId };
      }
      case "session/resume":
        if (!this.#sessions.has(params.sessionId)) {
          throw new Error("no such session");
        }
        return {};
      case "session/close":
        return {};
      case "session/prompt":
        return this.#turn(params);
      default: {
        const error = new Error(`${method} is not supported`);
        error.code = -32601;
        throw error;
      }
    }
  }

  notify(method, params = {}) {
    if (method === "session/cancel") {
      const session = this.#sessions.get(params.sessionId);
      if (session?.turn) {
        session.turn.cancelled = true;
      }
      this.release();
    }
  }

  respond() {}

  respondError() {}

  stderrTail() {
    return "";
  }

  kill() {
    if (this.exited) {
      return;
    }
    // On purpose: onExit records no exit for the user's next note.
    this.stopping = true;
    this.exited = true;
    for (const session of this.#sessions.values()) {
      if (session.turn) {
        session.turn.cancelled = true;
      }
    }
    this.release();
    Promise.resolve().then(() => this.onExit(0));
  }

  async #turn({ sessionId, prompt = [] }) {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new Error("no such session");
    }
    const turn = { cancelled: false };
    session.turn = turn;
    const texts = prompt.filter(block => block?.type === "text").map(block => String(block.text ?? ""));
    const question = texts.at(-1) ?? "";
    const message = `m${this.#count}-${Date.now()}`;
    const say = text =>
      this.onNotification({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: message, content: { type: "text", text } } },
      });
    try {
      const numbered = /(\d+) numbered lines/i.exec(question);
      const more = /(\d+) more, numbered on from (\d+)/i.exec(question);
      if (numbered || more) {
        const count = Math.min(Number((more ?? numbered)[1]), 100);
        const from = more ? Number(more[2]) : 1;
        this.#lines = 0;
        for (let i = 0; i < count; i++) {
          if (turn.cancelled || this.exited) {
            return { stopReason: "cancelled" };
          }
          say(`${i ? "\n" : ""}${from + i}. A short line from the self-check's agent, number ${from + i}.`);
          this.#lines = i + 1;
          while (this.#stopAt !== null && this.#lines >= this.#stopAt && !turn.cancelled && !this.exited) {
            await new Promise(resolve => (this.#resume = resolve));
          }
          await new Promise(resolve => setTimeout(resolve, LINE_MS));
        }
        return { stopReason: turn.cancelled ? "cancelled" : "end_turn" };
      }
      await new Promise(resolve => setTimeout(resolve, LINE_MS));
      if (turn.cancelled || this.exited) {
        return { stopReason: "cancelled" };
      }
      say(/hello/i.test(question) ? "Hello. This is the self-check's agent: it answers in words only, with no tools." : "Noted.");
      return { stopReason: "end_turn" };
    } finally {
      if (session.turn === turn) {
        session.turn = null;
      }
    }
  }
}

// --- The window's glue ----------------------------------------------------------

/**
 * What agent-sidebar.uc.js gives a browser window's panel and drawer, for the
 * self-check's window: Chat and Work on the run's own conversations, All
 * tasks over its own list. It opens no page, link or tab, takes no focus,
 * watches no task and writes no pref.
 */
function makeGlue(win, scope) {
  let panel = null;
  const waiters = [];
  let mode = "work";
  let currentTask = null;
  let draft = null;
  let chat = null;
  let directory = null;

  const newDraft = () => {
    if (!draft || draft.forgotten || AgentService.isListed(draft) || draft.messages.length || draft.busy) {
      draft = AgentService.createTask({ source: "new", scope });
    }
    return draft;
  };
  const workConversation = () => {
    if (!AgentService.isListed(currentTask) && (currentTask !== draft || currentTask?.forgotten)) {
      currentTask = AgentService.taskList(scope)[0] ?? null;
    }
    currentTask ??= newDraft();
    return currentTask;
  };
  const chatConversation = () => {
    if (!chat || chat.forgotten) {
      chat = AgentService.createConversation("chat", { scope });
    }
    return chat;
  };
  const shown = () => (mode === "work" ? workConversation() : chatConversation());
  const openPanel = () => (panel ? Promise.resolve(panel) : new Promise(resolve => waiters.push(resolve)));
  const setMode = next => {
    mode = next === "chat" ? "chat" : "work";
    panel?.show(shown());
  };
  const showTask = task => {
    const conv = typeof task === "string" ? AgentService.taskByUid(task, scope) : task;
    if (!conv) {
      return;
    }
    mode = "work";
    currentTask = conv;
    panel?.show(conv);
  };
  const shortcut = shortcutLabel();

  const glue = {
    AgentService,
    scope,
    get mode() {
      return mode;
    },
    setMode,
    get currentTask() {
      return mode === "work" ? workConversation() : currentTask;
    },
    showTask,
    async newTask() {
      const conv = newDraft();
      mode = "work";
      currentTask = conv;
      (await openPanel()).compose(conv, { selection: "" });
      return conv;
    },
    leaveTask(conv) {
      if (currentTask === conv) {
        currentTask = AgentService.taskList(scope)[0] ?? null;
      }
      setMode("work");
    },
    conversationFor: () => chatConversation(),
    submit(conv, { question, selection, attachments, replace, source = null }) {
      return AgentService.send(conv, { question, selection, attachments, replace, source });
    },
    enqueue(conv, { question, selection, attachments }) {
      return AgentService.enqueue(conv, { question, selection, attachments });
    },
    steer(conv, { question, selection, attachments }) {
      return AgentService.steer(conv, { question, selection, attachments });
    },
    get shortcut() {
      return shortcut;
    },
    shortcutLabel,
    // No task here has a zenius task: nothing to watch or take over.
    watch: async () => false,
    stopWatching: async () => false,
    takeOver: async () => false,
    get watching() {
      return null;
    },
    pageInfo: () => ({ title: "zenius self-check", host: "", image: "", url: "" }),
    toggleDirectory() {
      directory ??= new Directory(win, glue);
      directory.toggle();
    },
    closeDirectory() {
      directory?.close({ now: true });
    },
    get directoryOpen() {
      return !!directory?.isOpen;
    },
    get directory() {
      return directory;
    },
    attachPanel(api) {
      panel = api;
      for (const resolve of waiters.splice(0)) {
        resolve(api);
      }
      api.show(shown());
    },
    detachPanel(api) {
      if (panel === api) {
        panel = null;
        directory?.close({ now: true });
      }
    },
    closePanel() {},
    focusPage() {},
    openLink() {},
    defaultQuestion: () => "Explain this.",
    get panel() {
      return panel;
    },
    destroy() {
      directory?.destroy();
      directory = null;
      panel = null;
    },
  };
  return glue;
}

/** The sidebar's key as the panel's hints show it, from the pref the browser windows bind (agent-sidebar.uc.js's shortcutLabel). */
function shortcutLabel() {
  const spec = Services.prefs.getStringPref(PREF_SHORTCUT, "accel,shift+A");
  const plus = spec.lastIndexOf("+");
  const key = spec.slice(plus + 1);
  const mac = Services.appinfo.OS === "Darwin";
  const held = new Set(
    (plus > 0 ? spec.slice(0, plus) : "")
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(m => (m === "accel" ? (mac ? "meta" : "control") : m))
  );
  const name = key.length === 1 ? key.toUpperCase() : key.replace(/^VK_/, "");
  if (mac) {
    const marks = [["meta", "⌘"], ["control", "⌃"], ["alt", "⌥"], ["shift", "⇧"]];
    return marks.filter(([m]) => held.has(m)).map(([, mark]) => mark).join("") + name;
  }
  const words = [["control", "Ctrl"], ["alt", "Alt"], ["shift", "Shift"], ["meta", "Meta"]];
  return [...words.filter(([m]) => held.has(m)).map(([, word]) => word), name].join("+");
}

// --- prepare, run, cleanup ----------------------------------------------------------

/** The run in progress: { win, scope, glue, agents, layout } */
let current = null;

/**
 * Fill the self-check window with the panel and the drawer, on a scope of
 * the run's own, with one earlier task in it (so Archive has a task to
 * move on to). Resolves with the scope once the panel shows.
 *
 * @param {Window} win  the runner's window (the core's window.xhtml)
 * @returns {Promise<object>} the scope (AgentService.openScope)
 */
export async function prepare(win) {
  cleanup();
  const agents = [];
  const scope = AgentService.openScope({
    connect: () => {
      const agent = new SelfCheckAgent();
      agents.push(agent);
      return agent;
    },
  });
  const glue = makeGlue(win, scope);
  current = { win, scope, glue, agents, layout: null };

  const earlier = AgentService.createTask({ source: "new", scope });
  earlier.push({ role: "user", text: EARLIER.question, selection: "", files: [], attachments: [] });
  earlier.push({ role: "assistant", text: EARLIER.answer, state: "done" });
  AgentService.addTask(earlier, EARLIER.question);
  AgentService.refreshTask(earlier);

  // The glue first: the panel reads it as it loads.
  win.ucAgentSidebar = glue;
  const doc = win.document;
  const host = doc.getElementById("zenius-selfcheck-host") ?? doc.documentElement;
  // What the drawer and the panel expect of a browser window: #browser holds
  // the drawer, beside #sidebar-box, whose #sidebar is the panel.
  const area = doc.createXULElement("hbox");
  area.id = "browser";
  area.setAttribute("flex", "1");
  area.style.position = "relative";
  area.style.background = "light-dark(#eeeef1, #2b2b30)";
  const page = doc.createXULElement("vbox");
  page.setAttribute("flex", "1");
  const box = doc.createXULElement("vbox");
  box.id = "sidebar-box";
  box.setAttribute("agent-sidebar", "");
  // Narrower in a narrow window, so the drawer still fits beside it.
  box.style.width = `${Math.max(MIN_WIDTH, Math.min(SIDEBAR_WIDTH, win.innerWidth - DRAWER_ROOM))}px`;
  box.style.position = "relative";
  const browser = doc.createXULElement("browser");
  browser.id = "sidebar";
  browser.setAttribute("flex", "1");
  browser.setAttribute("disablehistory", "true");
  browser.setAttribute("src", PANEL_URL);
  box.append(browser);
  area.append(page, box);
  host.append(area);
  current.layout = { area, box, browser };

  await waitFor(() => glue.panel && browser.contentDocument?.getElementById("input"), { win, what: "the panel to load" });
  return scope;
}

/**
 * Step 6's checks, one after another. A check that fails stops at the step
 * that failed, and the next check still runs from a clean start.
 *
 * @param {Window} win
 * @param {{shot: (name: string, rect?: object) => Promise<any>, checked?: (check: object) => void, signal?: AbortSignal}} ctx
 * @returns {Promise<{checks: object[]}>}
 */
export async function run(win, { shot, checked = () => {}, signal } = {}) {
  if (!current || current.win !== win) {
    throw new Error("the self-check wasn't prepared in this window");
  }
  const checks = [];
  for (const def of CHECKS) {
    stopIfAborted(signal);
    const check = { id: def.id, title: def.title, ok: false, failedStep: null, error: null };
    const t = tester(win, def.id, { shot, signal });
    try {
      await t.reset();
      await def.run(t);
      check.ok = true;
    } catch (e) {
      check.failedStep = t.at;
      check.error = e;
    }
    // Cut short: the runner fails the check in progress itself.
    stopIfAborted(signal);
    checks.push(check);
    checked(check);
  }
  return { checks };
}

/** End the run's tasks and agent, and the window's glue. Safe to call again. */
export function cleanup() {
  const run = current;
  current = null;
  if (!run) {
    return;
  }
  try {
    run.glue.destroy();
  } catch (e) {
    console.error("[agent-sidebar] self-check cleanup:", e);
  }
  AgentService.closeScope(run.scope);
  for (const agent of run.agents) {
    agent.kill();
  }
  try {
    if (!run.win.closed && run.win.ucAgentSidebar === run.glue) {
      delete run.win.ucAgentSidebar;
    }
  } catch {}
}

// --- The checks ------------------------------------------------------------------

/** The ⋯ menu: New, Rename, Archive and Close in Work, New and Close in Chat, each with its tooltip. */
async function menuCheck(t) {
  await t.step("new-task", async () => {
    await t.openDirectory();
    t.click(t.drawer().querySelector(".asb-dir-new"));
    await t.until(() => !t.glue.directoryOpen && t.conv().messages.length === 0 && t.mode() === "work", "a new task");
    t.send(FIRST);
    await t.until(() => t.conv().messages.some(m => m.role === "assistant" && /Hello/.test(m.text)) && !t.conv().busy, "the agent's answer");
    await t.until(() => t.$("messages").textContent.includes("Hello."), "the answer in the panel");
    return t.panelRect();
  });
  await t.step("work", async () => {
    const menu = await t.openMenu();
    t.expect(menu, {
      "new-task": { label: "New", kbd: null, tip: "New task" },
      "rename-task": { label: "Rename", kbd: null, tip: "Rename the task" },
      "archive-task": { label: "Archive", kbd: null, tip: "Moves the task to Archived, at the bottom of All tasks." },
      close: { label: "Close", kbd: t.glue.shortcut, tip: "Close the sidebar" },
    }, "Work's ⋯ menu");
    return t.panelRect();
  });
  await t.step("chat", async () => {
    t.closeMenu();
    t.glue.setMode("chat");
    await t.until(() => t.pdoc().documentElement.dataset.mode === "chat", "Chat");
    const menu = await t.openMenu();
    t.expect(menu, {
      "new-chat": { label: "New", kbd: null, tip: "New chat for this tab" },
      close: { label: "Close", kbd: t.glue.shortcut, tip: "Close the sidebar" },
    }, "Chat's ⋯ menu");
    return t.panelRect();
  });
}

/** Archive moves the task to Archived, the last group, and the panel on; opened from there it reads as it was; Unarchive brings it back. */
async function archiveCheck(t) {
  const task = () => t.scope.tasks.get(t.state.menuTask ?? "") ?? null;
  await t.step("archived", async () => {
    // The task the menu check asked in, as step 6 goes on with it.
    const conv = AgentService.taskList(t.scope).find(c => c.messages.some(m => m.role === "user" && m.text === FIRST));
    t.must(conv, "the menu check's task");
    t.state.menuTask = conv.uid;
    t.glue.showTask(conv);
    await t.until(() => t.$("title").textContent === conv.title, "the task in the panel");
    // Archive's tooltip is checked by its text, with no shot of its own. A
    // native tooltip is drawn outside the window, so no capture shows it,
    // and the open menu would only repeat the menu check's shot.
    const menu = await t.openMenu();
    t.expect(menu["archive-task"], { label: "Archive", kbd: null, tip: "Moves the task to Archived, at the bottom of All tasks." }, "Archive's item");
    t.click(t.$("archive-task"));
    await t.until(() => conv.archivedAt && t.glue.currentTask !== conv, "the task archived");
    const next = AgentService.taskList(t.scope)[0];
    t.must(t.glue.currentTask === next, "the panel on the newest of the other tasks");
    await t.until(() => t.$("title").textContent === next.title, "the newest other task in the panel");
    return t.panelRect();
  });
  await t.step("group", async () => {
    await t.openDirectory();
    const head = t.drawer().querySelector(".asb-dir-archived");
    t.must(head, "an Archived group");
    t.expect(
      {
        last: [...t.drawer().querySelectorAll(".asb-dir-group")].at(-1)?.dataset.group ?? null,
        label: head.querySelector(".asb-dir-label")?.textContent ?? null,
        count: head.querySelector(".asb-dir-count")?.textContent ?? null,
        expanded: head.getAttribute("aria-expanded"),
        row: !!t.row(task()),
      },
      { last: "archived", label: "Archived", count: "1", expanded: "false", row: false },
      "Archived, last and collapsed, with a count"
    );
    return t.directoryRect();
  });
  await t.step("row", async () => {
    t.click(t.drawer().querySelector(".asb-dir-archived"));
    await t.until(() => t.row(task()), "the archived task's row");
    t.must(t.row(task()).dataset.archived === "true", "the row reads as archived");
    return t.directoryRect();
  });
  await t.step("opened", async () => {
    t.click(t.row(task()));
    await t.until(() => t.glue.currentTask === task() && t.pdoc().documentElement.dataset.archived === "true", "the archived task in the panel");
    t.expect(
      {
        bar: t.visible(t.$("archived-bar")) ? t.$("archived-text").textContent : null,
        unarchive: t.visible(t.$("unarchive")),
        input: t.visible(t.$("input")),
        thread: t.$("messages").textContent.includes(FIRST),
      },
      { bar: "Archived", unarchive: true, input: false, thread: true },
      "the task as it was, with no box"
    );
    const menu = await t.openMenu();
    t.expect(menu["archive-task"], { label: "Unarchive", kbd: null, tip: "Brings the task back to the list." }, "the menu's Unarchive");
    return t.panelRect();
  });
  await t.step("unarchived", async () => {
    t.closeMenu();
    t.click(t.$("unarchive"));
    const conv = task();
    await t.until(() => !conv.archivedAt && t.visible(t.$("input")), "the box back");
    t.must(t.glue.currentTask === conv, "the task still shown");
    await t.openDirectory();
    const row = t.row(conv);
    t.expect(
      { group: t.groupOf(row), archived: !!t.drawer().querySelector(".asb-dir-archived") },
      { group: "done", archived: false },
      "the task under Done, and no Archived group"
    );
    return t.directoryRect();
  });
}

/** A message the user sends takes the chat to its end, even from an earlier answer, and follows the answer until the user scrolls up. */
async function followCheck(t) {
  const agent = () => t.agents.at(-1);
  const m = () => t.$("messages");
  await t.step("answered", async () => {
    // More's New, as step 6 starts it.
    const menu = await t.openMenu();
    t.must(menu["new-task"], "More's New");
    t.click(t.$("new-task"));
    await t.until(() => t.conv().messages.length === 0 && t.$("menu").hidden && t.visible(t.$("input")), "a new task");
    t.send(FIFTY);
    await t.until(() => /50\. A short line/.test(t.lastAnswer()) && !t.conv().busy, "fifty lines");
    await t.frames(3);
    t.must(m().scrollHeight > m().clientHeight * 1.5, "an answer taller than the chat");
    return t.panelRect();
  });
  await t.step("sent", async () => {
    // Up to the answer's first lines, then the next message: the chat goes
    // to its end at once, with the message in view.
    await t.scrollTo(0);
    t.must(!t.atEnd(), "the chat scrolled up to the first lines");
    agent()?.holdAt(12);
    t.send(MORE);
    await t.until(() => t.conv().busy && t.atEnd() && t.lastUser()?.textContent.includes(MORE), "the chat at its end");
    t.must(t.inView(t.lastUser()), "the message in view");
    await t.until(() => agent()?.lines >= 12 && /62\. A short line/.test(t.lastAnswer()), "the answer's first lines");
    await t.frames(3);
    t.must(t.atEnd(), "the view on the answer as it comes");
    return t.panelRect();
  });
  await t.step("following", async () => {
    // It writes on, and the view keeps to its end at each new line.
    const seen = [];
    let height = m().scrollHeight;
    agent()?.holdAt(30);
    const end = Date.now() + WAIT_MS;
    while (!(agent()?.lines >= 30)) {
      stopIfAborted(t.signal);
      t.must(Date.now() < end, "thirty lines in time");
      await t.sleep(40);
      if (m().scrollHeight !== height) {
        height = m().scrollHeight;
        seen.push(t.atEnd());
      }
    }
    await t.frames(3);
    t.must(seen.length > 0 && seen.every(Boolean) && t.atEnd(), `the view on the answer at each new line (${seen.filter(Boolean).length} of ${seen.length})`);
    return t.panelRect();
  });
  await t.step("scrolled-up", async () => {
    // The user scrolls up several lines while it writes: the view stays
    // there, and the answer goes on below.
    await t.scrollTo(Math.max(0, m().scrollTop - 160));
    const top = m().scrollTop;
    t.must(!t.atEnd(), "the chat scrolled up");
    agent()?.holdAt(40);
    await t.until(() => agent()?.lines >= 40 && /90\. A short line/.test(t.lastAnswer()), "ten more lines");
    await t.frames(3);
    t.expect({ top: m().scrollTop, atEnd: t.atEnd(), busy: !!t.conv().busy }, { top, atEnd: false, busy: true }, "the view where the user put it, the answer going on");
    t.state.followTop = top;
    return t.panelRect();
  });
  await t.step("ended", async () => {
    agent()?.release();
    await t.until(() => !t.conv().busy && /100\. A short line/.test(t.lastAnswer()), "the answer's end");
    await t.frames(3);
    t.expect({ top: m().scrollTop, atEnd: t.atEnd() }, { top: t.state.followTop, atEnd: false }, "the view still where the user put it");
    return t.panelRect();
  });
}

// --- The run's view of its window (sidebarview.sys.mjs, shared with tests/ux) ----------

/** The run's view of its window, for one check: its steps, and the panel's and All tasks' parts. */
function tester(win, id, { shot, signal }) {
  const { glue, scope, agents } = current;
  const t = {
    ...sidebarView(win, { signal }),
    glue,
    scope,
    agents,
    signal,
    state: (current.state ??= {}),
    at: null,

    /** One step: act, then the shot that names it. A step checks the signal before it acts. */
    async step(name, act) {
      t.at = name;
      stopIfAborted(signal);
      const rect = await act();
      stopIfAborted(signal);
      await shot(`${id}/${name}`, rect);
    },

    must(ok, what) {
      if (!ok) {
        throw new Error(`expected ${what}`);
      }
    },
    expect(seen, wanted, what) {
      const a = JSON.stringify(seen);
      const b = JSON.stringify(wanted);
      if (a !== b) {
        throw new Error(`${what}: expected ${b}, saw ${a}`);
      }
    },

    /** A clean start for a check: Work, no menu, no drawer, no answer still running. */
    async reset() {
      t.closeMenu();
      glue.closeDirectory();
      for (const conv of scope.tasks.values()) {
        if (conv.busy) {
          AgentService.cancel(conv);
        }
      }
      agents.at(-1)?.release();
      if (glue.mode !== "work") {
        glue.setMode("work");
      }
      await t.until(() => t.pdoc().documentElement.dataset.mode === "work", "Work");
    },

  };
  return t;
}
