// The self-check's scenarios (runtime/JS/agent-sidebar/selfcheck.sys.mjs's
// prepare, run and cleanup), in a window that isn't a browser window, as
// the core's runner hands one over. The tests open the runner's own window
// (zenius/selfcheck/window.xhtml) themselves, at its own size, and drive the
// three functions as the runner does; the UI's end-to-end test runs the
// whole of it through the runner.
//
// The user's side is set up first: a Work task of theirs, saved and shown in
// their sidebar with All tasks open, and a zenius task in the strip. From a
// run's start to the end of its cleanup, the user's side stays as it was:
// AgentService's lists and counts, the strip in the user's window, what the
// sidebar tells zenius waits, and, after, the tasks, chats and options files
// byte for byte and every uc.agent-sidebar. and zenius. pref. The run's own
// window lists only its own tasks. That holds for a run that passes, one where
// a check fails, and one cut short.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

const SCENARIOS = "chrome://userscripts/content/agent-sidebar/selfcheck.sys.mjs";
const CHECKS = ["menu", "archive", "follow"];
const WINDOW_URL = "chrome://userscripts/content/zenius/selfcheck/window.xhtml";
const run = Date.now().toString(36).slice(-5);

let h;
let user = null;

const HARNESS = `
  const SC = ChromeUtils.importESModule(${JSON.stringify(SCENARIOS)});
  const g = win.ucAgentSidebar;
  const A = g.AgentService;
  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (!(await fn())) {
      if (Date.now() > end) throw new Error("timed out waiting for " + fn);
      await new Promise(r => win.setTimeout(r, 25));
    }
  };
  const words = el => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
  /** The user's side, as it must stay through a run: nothing in it changes on its own. */
  const userSide = () => {
    const strip = win.document.getElementById("zenius-agents-strip");
    const drawer = win.document.getElementById("zenius-sidebar-directory");
    return {
      tasks: [...A.tasks.keys()],
      list: A.taskList().map(c => c.uid),
      directory: A.directoryList().map(c => c.uid),
      archived: A.archivedTasks().map(c => c.uid),
      needs: A.needsCount(),
      harnesses: A.harnessList().map(x => x.id),
      waiting: A.waitingSent,
      chats: A.liveChats.size,
      strip: strip ? { hidden: strip.hidden, text: words(strip) } : null,
      drawer: drawer && !drawer.hidden ? [...drawer.querySelectorAll(".asb-dir-row[data-task]")].map(r => r.dataset.task) : null,
      mode: g.mode,
      task: g.currentTask?.uid ?? null,
    };
  };
  const files = async () => {
    const read = async path => {
      try {
        return await IOUtils.readUTF8(path);
      } catch {
        return null;
      }
    };
    return { tasks: await read(A.tasksPath()), chats: await read(A.chatsPath()), options: await read(A.optionsPath()) };
  };
  const prefs = () => {
    const values = {};
    for (const branch of ["uc.agent-sidebar.", "zenius."]) {
      for (const name of Services.prefs.getChildList(branch)) {
        if (!Services.prefs.prefHasUserValue(name)) continue;
        const type = Services.prefs.getPrefType(name);
        values[name] =
          type === Services.prefs.PREF_BOOL ? Services.prefs.getBoolPref(name)
          : type === Services.prefs.PREF_INT ? Services.prefs.getIntPref(name)
          : Services.prefs.getStringPref(name);
      }
    }
    return values;
  };
  // The runner's window, at the size its root gives it.
  const WINDOW_URL = ${JSON.stringify(WINDOW_URL)};
  const openWindow = async () => {
    const w = Services.ww.openWindow(null, WINDOW_URL, "_blank", "chrome,dialog=no,resizable", null);
    await until(() => w.document?.documentURI === WINDOW_URL && w.document.readyState === "complete");
    win.focus();
    return w;
  };
  /**
   * One run, as the core's runner drives it: prepare, run, then cleanup and
   * the window's close. Each shot samples the user's side and the run's own
   * directory. With arg.how, the first shot of check how.check throws
   * ("fail") or aborts the run ("abort").
   */
  const runOnce = async (how = {}) => {
    const base = userSide();
    const baseText = JSON.stringify(base);
    const before = { files: await files(), prefs: prefs() };
    const out = { shots: [], checked: [], diffs: [], foreign: [], waiting: [], result: null, error: null, tripped: null };
    const ui = A.zeniusUI();
    const noteWaiting = ui?.noteSidebarWaiting;
    if (noteWaiting) {
      ui.noteSidebarWaiting = function (list) {
        out.waiting.push(list.map(t => t.uid));
        return noteWaiting.call(this, list);
      };
    }
    const conns = A.conns.size;
    const control = new AbortController();
    const w = await openWindow();
    let scope = null;
    try {
      scope = await SC.prepare(w);
      out.prepared = { windowtype: w.document.documentElement.getAttribute("windowtype"), browserWindow: w.document.documentElement.getAttribute("windowtype") === "navigator:browser", glue: w.ucAgentSidebar?.scope === scope, tasks: scope.tasks.size, userTasks: [...scope.tasks.keys()].filter(uid => A.tasks.has(uid)).length };
      out.result = await SC.run(w, {
        signal: control.signal,
        checked: c => out.checked.push({ id: c.id, ok: c.ok, failedStep: c.failedStep ?? null }),
        shot: async (name, rect) => {
          const check = String(name).split("/")[0];
          out.shots.push({ name, inside: !!rect && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 && rect.x + rect.width <= w.innerWidth + 1 && rect.y + rect.height <= w.innerHeight + 1 });
          const now = JSON.stringify(userSide());
          if (now !== baseText && out.diffs.length < 5) out.diffs.push({ name, now });
          const drawer = w.document.getElementById("zenius-sidebar-directory");
          if (drawer && !drawer.hidden) {
            for (const row of drawer.querySelectorAll(".asb-dir-row[data-task]")) {
              if (!scope.tasks.has(row.dataset.task)) out.foreign.push(row.dataset.task);
            }
          }
          out.inUserTasks = (out.inUserTasks ?? 0) + [...scope.tasks.keys()].filter(uid => A.tasks.has(uid)).length;
          out.conns = Math.max(out.conns ?? 0, A.conns.size - conns);
          if (how.check === check && !out.tripped) {
            out.tripped = name;
            if (how.kind === "fail") throw new Error("the test's failing step");
            control.abort();
          }
          return name;
        },
      });
    } catch (e) {
      out.error = e?.name ?? String(e);
    } finally {
      SC.cleanup();
      // Safe to call again, as the runner's finally may.
      SC.cleanup();
      if (noteWaiting) ui.noteSidebarWaiting = noteWaiting;
      w.close();
      await until(() => w.closed, 5000).catch(() => {});
    }
    // What a stray timer would write comes within a second or two.
    await new Promise(r => win.setTimeout(r, 1500));
    out.after = {
      scopeTasks: scope?.tasks.size ?? null,
      closed: !!scope?.closed,
      scoped: [...A.conversations.values()].filter(c => c.scope).length,
      sessions: [...A.bySession.keys()].filter(id => String(id).startsWith("selfcheck-")).length,
      windows: [...Services.wm.getEnumerator("zenius:selfcheck")].length,
      side: userSide(),
      files: JSON.stringify(await files()) === JSON.stringify(before.files),
      prefs: prefs(),
    };
    out.base = base;
    out.prefsBefore = before.prefs;
    return out;
  };
`;

/** The checks every run shares: the user's side as it was, throughout and after, and nothing of the run left. */
function assertQuiet(out) {
  assert.deepEqual(out.prepared, { windowtype: "zenius:selfcheck", browserWindow: false, glue: true, tasks: 1, userTasks: 0 }, "prepared in a window of its own, with one earlier task of its own");
  assert.deepEqual(out.diffs, [], "the user's side changed during the run");
  assert.deepEqual(out.foreign, [], "the run's All tasks listed a task not its own");
  assert.equal(out.inUserTasks, 0, "a task of the run's was in AgentService.tasks");
  assert.equal(out.conns, 0, "the run started an agent process");
  assert.ok(
    out.waiting.every(list => list.every(uid => out.base.tasks.includes(uid))),
    `the sidebar told zenius of a waiting task not the user's: ${JSON.stringify(out.waiting)}`
  );
  assert.deepEqual(out.after.side, out.base, "after the run, the user's side is as it was");
  assert.equal(out.after.files, true, "the tasks, chats and options files are byte for byte as they were");
  assert.deepEqual(out.after.prefs, out.prefsBefore, "the sidebar's and zenius's prefs are as they were");
  assert.deepEqual(
    { scopeTasks: out.after.scopeTasks, closed: out.after.closed, scoped: out.after.scoped, sessions: out.after.sessions, windows: out.after.windows },
    { scopeTasks: 0, closed: true, scoped: 0, sessions: 0, windows: 0 },
    "cleanup ended every task of the run, its sessions and its agent"
  );
  for (const shot of out.shots) {
    assert.match(shot.name, /^(menu|archive|follow)\/[a-z0-9-]+$/, `a shot's name is <check>/<step>: ${shot.name}`);
    assert.ok(shot.name.length <= 40, `at most 40 characters: ${shot.name}`);
    assert.ok(shot.inside, `its rect is inside the window: ${shot.name}`);
  }
}

before(async () => {
  h = await setup();
  // The user's side: a Work task of theirs, saved, shown in their sidebar
  // with All tasks open, and a zenius task in the strip.
  await h.createSpace({ name: `zen-sidebar selfcheck ${run}` });
  user = await h.call("dev.evalChrome", {
    code: `
      const g = win.ucAgentSidebar;
      const A = g.AgentService;
      const until = async (fn, ms = 15000) => {
        const end = Date.now() + ms;
        while (!(await fn())) {
          if (Date.now() > end) throw new Error("timed out waiting for " + fn);
          await new Promise(r => win.setTimeout(r, 25));
        }
      };
      const wasOpen = win.SidebarController.isOpen && win.SidebarController.currentID === "viewAgentSidebar";
      if (!wasOpen) await win.SidebarController.show("viewAgentSidebar");
      await until(() => g.panel);
      const conv = A.createTask({ source: "new" });
      conv.push({ role: "user", text: "My own question " + arg.run, selection: "", files: [], attachments: [] });
      conv.push({ role: "assistant", text: "My own answer.", state: "done" });
      A.addTask(conv, "My own question " + arg.run);
      A.refreshTask(conv);
      await A.saveTasks();
      g.showTask(conv);
      if (!g.directoryOpen) g.toggleDirectory();
      await until(() => g.directoryOpen);
      await until(() => win.document.getElementById("zenius-agents-strip") && !win.document.getElementById("zenius-agents-strip").hidden);
      return { uid: conv.uid, wasOpen };
    `,
    arg: { run },
  });
});

after(async () => {
  try {
    if (user) {
      await h.call("dev.evalChrome", {
        code: `
          const g = win.ucAgentSidebar;
          const A = g.AgentService;
          g.closeDirectory();
          const conv = A.taskList().find(c => c.uid === arg.uid);
          if (conv) A.removeTask(conv);
          g.setMode("chat");
          if (!arg.wasOpen) win.SidebarController.hide();
          return true;
        `,
        arg: user,
      });
    }
  } finally {
    await h?.close();
  }
});

test("the self-check's three checks pass in a window of their own, in step 6's order: the ⋯ menu, Archive, and sending that follows the answer; each step's shot is named <check>/<step> with a rect inside the window, and checked() hears each check as it ends; from the run's start to the end of its cleanup the user's side stays as it was (their tasks, lists and counts, the strip, their sidebar and All tasks, what zenius hears waits), the run's All tasks lists only its own tasks, no agent process starts, and the files and prefs are byte for byte as they were", async () => {
  const out = await h.call("dev.evalChrome", { code: `${HARNESS}\nreturn await runOnce();` });
  assert.equal(out.error, null, `the run went through: ${out.error}`);
  assert.deepEqual(
    (out.result?.checks ?? []).map(c => [c.id, c.ok, c.failedStep, c.error ? String(c.error.message ?? c.error) : null]),
    CHECKS.map(id => [id, true, null, null]),
    `every check passed: ${JSON.stringify(out.result?.checks)}`
  );
  assert.deepEqual(out.checked, CHECKS.map(id => ({ id, ok: true, failedStep: null })), "checked() heard each check as it ended");
  const order = out.shots.map(s => CHECKS.indexOf(s.name.split("/")[0]));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "the shots in the checks' order");
  for (const id of CHECKS) {
    assert.ok(out.shots.filter(s => s.name.startsWith(id + "/")).length >= 3, `${id} has its steps: ${out.shots.map(s => s.name).join(", ")}`);
  }
  assertQuiet(out);
});

test("a check that fails names its step, and the next check still runs; a run cut short ends the same; either way cleanup leaves nothing of the run, and the user's side, files and prefs are as they were", async () => {
  const failed = await h.call("dev.evalChrome", { code: `${HARNESS}\nreturn await runOnce(arg);`, arg: { check: "archive", kind: "fail" } });
  assert.equal(failed.tripped, "archive/archived");
  assert.deepEqual(
    failed.result.checks.map(c => [c.id, c.ok, c.failedStep]),
    [["menu", true, null], ["archive", false, "archived"], ["follow", true, null]],
    `the archive check failed at its step, and follow ran: ${JSON.stringify(failed.result.checks)}`
  );
  // An Error comes back from chrome JS as its fields.
  assert.match(String(failed.result.checks[1].error?.message ?? failed.result.checks[1].error), /the test's failing step/);
  assertQuiet(failed);

  const cut = await h.call("dev.evalChrome", { code: `${HARNESS}\nreturn await runOnce(arg);`, arg: { check: "follow", kind: "abort" } });
  assert.equal(cut.tripped, "follow/answered");
  assert.equal(cut.error, "Stopped", "the run stops once the signal aborts");
  assert.deepEqual(cut.checked, [{ id: "menu", ok: true, failedStep: null }, { id: "archive", ok: true, failedStep: null }], "checked() heard the checks that ended before");
  assertQuiet(cut);
});

test("the self-check's agent is in no picker, and a scope's conversations write no pref: harnessList() never lists it and a scope's lists none; setHarness, pickModel and setOption on its chat change nothing; and once the scope is closed its agent can't start again", async () => {
  const out = await h.call("dev.evalChrome", {
    code: `
      const { AgentService: A, SELF_CHECK_HARNESS } = ChromeUtils.importESModule("chrome://userscripts/content/agent-sidebar/AgentService.sys.mjs");
      const prefs = () => Services.prefs.getChildList("uc.agent-sidebar.").filter(n => Services.prefs.prefHasUserValue(n)).map(n => [n, Services.prefs.getPrefType(n) === Services.prefs.PREF_STRING ? Services.prefs.getStringPref(n) : String(Services.prefs.getPrefType(n) === Services.prefs.PREF_INT ? Services.prefs.getIntPref(n) : Services.prefs.getBoolPref(n))]);
      const before = JSON.stringify(prefs());
      let started = 0;
      const scope = A.openScope({ connect: () => { started++; return { exited: false, start: async () => ({}), kill() { this.exited = true; } }; } });
      const conv = A.createConversation("chat", { scope });
      const task = A.createTask({ source: "new", scope, harness: Object.keys(A.config?.agents ?? {})[0] ?? null });
      const res = {
        harness: [conv.harness, task.harness],
        listed: A.harnessList().some(x => x.id === SELF_CHECK_HARNESS),
        scoped: A.harnessList(scope),
        available: A.harnessAvailable(SELF_CHECK_HARNESS).ok,
      };
      A.setHarness(conv, Object.keys(A.config?.agents ?? {})[0] ?? "claude");
      await A.pickModel(conv, "some-model", "high");
      await A.setOption(conv, "mode", "plan");
      res.harnessAfter = conv.harness;
      res.prefs = JSON.stringify(prefs()) === before;
      await A.scopeConnection(scope);
      res.started = started;
      A.closeScope(scope);
      res.closed = await A.scopeConnection(scope).then(() => "started", e => e.message);
      res.left = [...A.conversations.values()].filter(c => c.scope === scope).length;
      return res;
    `,
  });
  assert.deepEqual(out, {
    harness: ["zenius:selfcheck", "zenius:selfcheck"],
    listed: false,
    scoped: [],
    available: true,
    harnessAfter: "zenius:selfcheck",
    prefs: true,
    started: 1,
    closed: "the self-check has ended",
    left: 0,
  });
});

test("an ended scope makes nothing more: createConversation and createTask refuse it, and a panel in a window with no glue stops before it lists or subscribes to the user's tasks; and a self-check task's failed turn never shows the user's own agent's last exit", async () => {
  const out = await h.call("dev.evalChrome", {
    code: `${HARNESS}
      const { SELF_CHECK_HARNESS } = ChromeUtils.importESModule("chrome://userscripts/content/agent-sidebar/AgentService.sys.mjs");
      const res = {};
      // An agent shaped like the self-check's, whose every turn fails as a
      // stopped agent's does.
      let sessions = 0;
      const failing = {
        exited: false, stopping: false, initResult: null, lastUsed: Date.now(), harness: SELF_CHECK_HARNESS, slot: SELF_CHECK_HARNESS, config: {},
        appendsSystemPrompt: false, restoreMethods: ["session/resume"], closesSessions: true, forksSessions: false,
        onNotification() {}, onRequest() {}, onExit() {},
        async start() {
          this.initResult = { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: { image: false, embeddedContext: true }, sessionCapabilities: { resume: {}, close: {} } }, authMethods: [] };
          return this.initResult;
        },
        async request(method) {
          if (method === "session/new") return { sessionId: "selfcheck-failing-" + ++sessions };
          if (method === "session/prompt") throw new Error("the agent is not running");
          return {};
        },
        notify() {}, respond() {}, respondError() {}, stderrTail: () => "",
        kill() { this.exited = true; this.stopping = true; },
      };
      // The user's own agent's last exit, which a failed turn of theirs shows.
      const lastExit = A.lastExit;
      A.lastExit = "Exit code 1: USER-AGENT-TAIL-" + arg.run;
      const scope = A.openScope({ connect: () => failing });
      try {
        const task = A.createTask({ source: "new", scope });
        await A.send(task, { question: "This turn fails." }).catch(() => {});
        await until(() => !task.busy && task.messages.at(-1)?.role === "error", 10000);
        res.userTail = String(task.messages.at(-1).text).includes("USER-AGENT-TAIL");
      } finally {
        A.lastExit = lastExit;
        A.closeScope(scope);
      }
      const refused = make => {
        try {
          make();
          return "made";
        } catch (e) {
          return e.message;
        }
      };
      res.closed = {
        chat: refused(() => A.createConversation("chat", { scope })),
        task: refused(() => A.createTask({ source: "new", scope })),
        left: [...A.conversations.values()].filter(c => c.scope === scope).length,
      };
      // The panel in the runner's window with no glue, as after cleanup. It
      // must stop at its guard, first: what panel.js reports is that alone.
      const listeners = A.taskListeners.size;
      const reported = [];
      const listener = {
        observe(message) {
          if (message instanceof Ci.nsIScriptError && String(message.sourceName).endsWith("/agent-sidebar/panel.js")) {
            reported.push(message.errorMessage);
          }
        },
      };
      Services.console.registerListener(listener);
      const w = Services.ww.openWindow(null, WINDOW_URL, "_blank", "chrome,dialog=no,resizable", null);
      try {
        await until(() => w.document?.documentURI === WINDOW_URL && w.document.readyState === "complete");
        win.focus();
        const browser = w.document.createXULElement("browser");
        browser.setAttribute("flex", "1");
        browser.setAttribute("disablehistory", "true");
        browser.setAttribute("src", "chrome://userscripts/content/agent-sidebar/panel.html");
        w.document.getElementById("zenius-selfcheck-host").append(browser);
        await until(() => browser.contentDocument?.documentURI?.endsWith("/panel.html") && browser.contentDocument.readyState === "complete");
        await new Promise(r => win.setTimeout(r, 500));
        const doc = browser.contentDocument;
        res.noGlue = {
          glue: !!w.ucAgentSidebar,
          subscribed: A.taskListeners.size - listeners,
          title: doc.getElementById("title")?.textContent ?? null,
          needs: doc.getElementById("needs")?.textContent ?? null,
          atGuard: reported.length === 1 && reported[0].includes("the panel's window has no glue"),
        };
        res.reported = reported;
      } finally {
        Services.console.unregisterListener(listener);
        w.close();
        await until(() => w.closed, 5000).catch(() => {});
      }
      return res;
    `,
    arg: { run },
  });
  assert.deepEqual(out.closed, { chat: "the self-check has ended", task: "the self-check has ended", left: 0 }, "an ended scope makes no chat or task");
  assert.deepEqual(out.noGlue, { glue: false, subscribed: 0, title: "", needs: "", atGuard: true }, `a panel with no glue stops at its guard, before it subscribes to or shows the user's tasks: ${JSON.stringify(out.reported)}`);
  assert.equal(out.userTail, false, "a self-check task's error doesn't name the user's agent's exit");
});

test("the self-check window lists none of the user's earlier chats (Chat's way back; its shots must never show the user's chats): its glue offers none, its panel's empty Chat view has no line for one, and its All tasks' search lists none, where the user's own window's search lists it", async () => {
  const out = await h.call("dev.evalChrome", {
    code: `${HARNESS}
      // An earlier chat of the user's: saved, and shown by no tab.
      const uid = "sc-way-" + arg.run;
      const mark = "SCWAY-" + arg.run;
      const page = { url: "https://example.com/sc-way-" + arg.run, title: "Self-check way " + arg.run };
      const at = Date.now() - 3600e3;
      A.savedChats.set(uid, {
        uid, harness: A.preferredHarness(), createdAt: at, activeAt: at, page, session: null,
        instructed: false, instructedBy: null, lineage: [],
        messages: [{ role: "user", text: mark, page, files: [] }, { role: "assistant", text: "An answer." }],
      });
      const field = w => w.document.querySelector("#zenius-sidebar-directory .asb-dir-search input");
      const search = (w, query) => {
        field(w).value = query;
        field(w).dispatchEvent(new w.Event("input", { bubbles: true }));
      };
      const listed = w => ({
        rows: w.document.querySelectorAll("#zenius-sidebar-directory .asb-dir-row[data-chat]").length,
        group: !!w.document.querySelector('#zenius-sidebar-directory .asb-dir-group[data-group="chats"]'),
      });
      const res = {};
      try {
        const w = await openWindow();
        try {
          await SC.prepare(w);
          const wg = w.ucAgentSidebar;
          const opened = await wg.openEarlierChat?.(uid);
          res.glue = { offer: wg.earlierChat?.() ?? null, opened: opened ?? false, keeps: !!wg.keepsChats, live: A.liveChats.has(uid) };
          wg.setMode("chat");
          const pdoc = w.document.getElementById("sidebar").contentDocument;
          await until(() => pdoc?.documentElement?.dataset.mode === "chat" && pdoc.getElementById("empty"));
          await new Promise(r => win.setTimeout(r, 300));
          const line = pdoc.getElementById("earlier");
          res.panel = { there: !!line, shown: !!line && line.getClientRects().length > 0 };
          wg.toggleDirectory();
          await until(() => wg.directoryOpen && field(w));
          search(w, mark);
          await new Promise(r => win.setTimeout(r, 300));
          res.search = listed(w);
          wg.closeDirectory();
        } finally {
          SC.cleanup();
          w.close();
          await until(() => w.closed, 5000).catch(() => {});
        }
        // The control: the user's own window's search lists it. Their All
        // tasks ends as it was, open or not, with no query.
        const wasOpen = g.directoryOpen;
        if (!wasOpen) g.toggleDirectory();
        await until(() => g.directoryOpen && field(win));
        search(win, mark);
        await until(() => listed(win).rows > 0, 5000).catch(() => {});
        res.control = listed(win);
        search(win, "");
        if (!wasOpen) g.closeDirectory();
      } finally {
        A.savedChats.delete(uid);
        if ((await files()).chats?.includes(uid)) await A.saveChats();
      }
      return res;
    `,
    arg: { run },
  });
  assert.deepEqual(out.glue, { offer: null, opened: false, keeps: false, live: false }, "the self-check window's glue offers no earlier chat, and opens none");
  assert.deepEqual(out.panel, { there: true, shown: false }, "its empty Chat view has no line for one");
  assert.deepEqual(out.search, { rows: 0, group: false }, "its All tasks' search lists no earlier chat");
  assert.deepEqual(out.control, { rows: 1, group: true }, "where the user's own window lists it");
});
