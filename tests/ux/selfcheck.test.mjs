// The post-install self-check from the user's side.
//
// A self-check runs zen-sidebar's scenarios in a window of its own, with
// synthetic tasks and a mock agent, inside the user's running Zen. The
// user's own window must show none of it, from the run's start to the end of
// its cleanup:
// - its agent directory, zenius's strip and its waiting line, the Spaces'
//   badges, the tabs' task tags, zenius's cards and system notifications;
// - their own agent sidebar: open or not, its width, its mode, its task and
//   the draft in its box;
// - the window's focus: it stays the active window and the front browser
//   window, and never gets a deactivate or a blur.
// Those hold for a run that passes, one where a check fails, one that runs
// past its limit, and one whose task comes to need the user. The runs go through SelfCheck.start()'s test-only
// options (a wrapped scenario, a short limit, a scratch folder), which only
// chrome JS on a dev Zen can pass; the socket's entry takes no options.
//
// The last test is the run end to end, as step 6 runs it: `zenius selfcheck`
// from outside the sandbox, through the self-check socket. All three checks
// pass, and the run's folder holds exactly its summary and one PNG per step.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

const CLI = new URL("../../sdk/bin/zenius", import.meta.url).pathname;
const MEDIA_CHECK = new URL("../../scripts/media-check.pl", import.meta.url).pathname;
// zen-core's runner and zen-sidebar's scenarios.
const SELFCHECK = "chrome://userscripts/content/zenius/modules/selfcheck.sys.mjs";
const SCENARIOS = "chrome://userscripts/content/agent-sidebar/selfcheck.sys.mjs";
// The user's sidebar, read by the module the self-check's scenarios drive
// theirs by (agent-sidebar/sidebarview.sys.mjs).
const VIEW = `const V = ChromeUtils.importESModule("chrome://userscripts/content/agent-sidebar/sidebarview.sys.mjs").sidebarView(win);`;
// Step 6's checks, in its order.
const CHECKS = ["menu", "archive", "follow"];
// The opt-in that lets zenius show system notifications (ui/index.sys.mjs's
// handOff); on here, so a notification a run caused would be seen.
const NOTIFY = "zenius.ux.handoff.systemNotification";

const instance = process.env.ZENIUS_INSTANCE;
const home = process.env.ZENIUS_HOME || join(homedir(), ".zenius");
const run = Date.now().toString(36).slice(-5);

let h;
let scratch;

before(async () => {
  h = await setup();
  scratch = mkdtempSync(join(tmpdir(), "zenius-ux-selfcheck-"));
});

after(async () => {
  if (scratch) {
    rmSync(scratch, { recursive: true, force: true });
  }
  await h?.close();
});

/**
 * What the user's window shows, as a JSON-able value with nothing that
 * changes on its own (no times): `seen()`. `win` is the user's browser
 * window, the one dev.evalChrome runs in. The self-check's window is never a
 * browser window, so it can't be `win`.
 */
const SEEN = `
  ${VIEW}
  const SB = "viewAgentSidebar";
  const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");
  const words = el => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const seen = () => {
    const d = win.document;
    const g = win.ucAgentSidebar;
    const pdoc = V.pdoc();
    const drawer = V.drawer();
    const strip = d.getElementById("zenius-agents-strip");
    return {
      directory: drawer && !drawer.hidden ? [...drawer.querySelectorAll(".asb-dir-row[data-task]")].map(r => r.dataset.task) : null,
      archived: drawer?.querySelector(".asb-dir-archived .asb-dir-count")?.textContent ?? null,
      strip: strip ? { hidden: strip.hidden, text: words(strip) } : null,
      waiting: [...d.querySelectorAll(".zenius-tasks-waiting-text")].map(words),
      badges: [...d.querySelectorAll("[zenius-agent]")].map(el => el.getAttribute("zenius-agent")),
      tags: [...d.querySelectorAll("[zenius-task-state]")].map(el => el.getAttribute("zenius-task-state")),
      cards: [...d.querySelectorAll(".zenius-card")].map(el => words(el.querySelector(".zenius-card-title"))),
      // The panel's orange Needs-you count on Work, and the count it and the
      // strip go by: a synthetic task in Needs you must show in neither.
      needs: {
        badge: pdoc?.getElementById("needs") ? { hidden: pdoc.getElementById("needs").hidden, text: words(pdoc.getElementById("needs")) } : null,
        count: g.AgentService.needsCount(),
      },
      sidebar: {
        open: win.SidebarController.isOpen && win.SidebarController.currentID === SB,
        width: d.getElementById("sidebar-box")?.style.width ?? null,
        widthPref: Services.prefs.getIntPref("uc.agent-sidebar.width", 0),
        mode: g.mode,
        task: g.currentTask?.uid ?? null,
        draft: pdoc?.getElementById("input")?.value ?? null,
      },
      // Headless Linux has no stacking order to read. What "frontmost" can
      // mean here: the user's window stays the active one and the one zenius
      // and Zen pick as the front browser window (the self-check's, of
      // another type, is never a candidate). zen-eval checks how it looks on
      // the Mac.
      focus: {
        active: Services.focus.activeWindow === win,
        recentBrowser: Services.wm.getMostRecentWindow("navigator:browser") === win,
        top: BrowserWindowTracker.getTopWindow() === win,
        hasFocus: d.hasFocus(),
      },
    };
  };
`;

/**
 * The user's own state, as a user who uses the sidebar has it: the agent
 * sidebar open and wider than its default, in Work on a task of theirs with
 * earlier messages, a draft in its box, and All tasks open. Returns what the
 * test sets back afterwards (`USER_END`).
 */
const USER_START = `
  ${VIEW}
  const g = win.ucAgentSidebar, A = g.AgentService;
  const wasOpen = win.SidebarController.isOpen && win.SidebarController.currentID === "viewAgentSidebar";
  if (!wasOpen) await win.SidebarController.show("viewAgentSidebar");
  const until = async (fn, ms = 10000) => {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error("timed out waiting for " + fn);
      await new Promise(r => win.setTimeout(r, 25));
    }
  };
  await until(() => g.panel);
  g.setMode("work");
  const conv = await g.newTask();
  const question = "My own question " + arg.run;
  conv.push({ role: "user", text: question, selection: "", files: [], attachments: [] });
  conv.push({ role: "assistant", text: "My own answer.", state: "done" });
  // A task joins All tasks with its first question.
  A.addTask(conv, question);
  await A.saveTasks();
  const pdoc = win.document.getElementById("sidebar").contentDocument;
  await until(() => g.currentTask === conv && pdoc.getElementById("input"));
  const input = pdoc.getElementById("input");
  input.value = "A draft of mine " + arg.run;
  input.dispatchEvent(new pdoc.defaultView.Event("input", { bubbles: true }));
  // The width the user dragged the splitter to; agent-sidebar.uc.js keeps it.
  const box = win.document.getElementById("sidebar-box");
  box.style.width = "470px";
  await until(() => Services.prefs.getIntPref("uc.agent-sidebar.width", 0) === 470);
  if (!g.directoryOpen) g.toggleDirectory();
  await until(() => V.row(conv));
  win.gBrowser.selectedBrowser.focus();
  await until(() => Services.focus.activeWindow === win);
  return { uid: conv.uid, wasOpen };
`;

const USER_END = `
  const g = win.ucAgentSidebar, A = g.AgentService;
  g.closeDirectory();
  const conv = A.taskList().find(c => c.uid === arg.user.uid);
  if (conv) A.removeTask(conv);
  g.setMode("chat");
  Services.prefs.clearUserPref("uc.agent-sidebar.width");
  win.document.getElementById("sidebar-box").style.width = "";
  if (!arg.user.wasOpen) win.SidebarController.hide();
  return true;
`;

/**
 * One self-check run through SelfCheck.start(), with zen-sidebar's scenarios
 * wrapped. Each step's shot first samples the user's window. `arg.how` makes
 * the first step of the second check take its shot and then throw ("fail")
 * or never return ("hang": the run's limit ends it). Either way the summary
 * fails that check at that step, whether the scenarios catch a step's error
 * themselves or the runner finds the check its last shot was in. With
 * "needs", the first step of the last check first puts a new task of the
 * run's in Needs you, as a turn that failed leaves one, and samples the
 * user's window for half a second (zen-observe's review of these tests).
 *
 * A timer samples the user's window every 50 ms, from before the start to
 * after `done` settles, and the window's own deactivate and blur events are
 * counted: a focus that goes and comes back between two samples still
 * counts.
 *
 * Returns the base sample, every sample that differs from it (with the step
 * the run was at), the counted events, the waiting lists the sidebar sent
 * zenius, the notifications shown, the run's result and what was left after.
 */
const RUN = `
  ${SEEN}
  const g = win.ucAgentSidebar, A = g.AgentService;
  const ui = A.zeniusUI();
  const { SelfCheck } = ChromeUtils.importESModule(${JSON.stringify(SELFCHECK)});
  const SC = ChromeUtils.importESModule(${JSON.stringify(SCENARIOS)});
  const base = seen();
  const baseText = JSON.stringify(base);
  const out = { base, diffs: [], events: { deactivate: 0, blur: 0 }, waiting: [], alerts: [], steps: [] };
  let step = "start";
  const look = () => {
    const now = seen();
    if (JSON.stringify(now) !== baseText && out.diffs.length < 20) out.diffs.push({ step, seen: now });
  };
  const onDeactivate = () => out.events.deactivate++;
  const onBlur = e => {
    if (e.target === win || e.target === win.document) out.events.blur++;
  };
  win.addEventListener("deactivate", onDeactivate, true);
  win.addEventListener("blur", onBlur, true);
  const noteWaiting = ui.noteSidebarWaiting;
  ui.noteSidebarWaiting = function (list) {
    out.waiting.push(list.map(t => t.uid));
    return noteWaiting.call(this, list);
  };
  const alerts = ui.alertsService;
  ui.alertsService = { showAlert: alert => out.alerts.push(alert?.title ?? "an alert"), closeAlert() {} };
  const timer = win.setInterval(look, 50);
  const t0 = Date.now();
  let first = null;
  let handle = null;
  try {
    handle = SelfCheck.start({
      outDir: arg.outDir,
      timeoutMs: arg.timeoutMs,
      run: (w, ctx) => {
        out.windowtype = w.document.documentElement.getAttribute("windowtype");
        out.isUserWindow = w === win;
        return SC.run(w, {
          ...ctx,
          shot: async (name, rect) => {
            step = name;
            out.steps.push(name);
            look();
            const check = String(name).split("/")[0];
            first ??= check;
            if (arg.how === "needs") {
              if (check === "follow" && !out.tripped) {
                out.tripped = name;
                const scope = w.ucAgentSidebar.scope;
                const conv = A.createTask({ source: "new", scope });
                const question = "A task of the self-check's that needs the user";
                conv.push({ role: "user", text: question, selection: "", files: [], attachments: [] });
                conv.push({ role: "error", text: "The agent's turn failed." });
                A.addTask(conv, question);
                A.refreshTask(conv);
                out.needs = {
                  state: conv.task.state,
                  scoped: conv.scope === scope,
                  inRun: A.needsCount(scope),
                  userLists: A.taskList().includes(conv) || A.directoryList().includes(conv),
                };
                // Time for the strip, the badges and the waiting line to hear of it.
                for (let i = 0; i < 10; i++) {
                  await new Promise(r => win.setTimeout(r, 50));
                  look();
                }
              }
              return ctx.shot(name, rect);
            }
            if (arg.how !== "pass" && check !== first && !out.tripped) {
              out.tripped = name;
              await ctx.shot(name, rect);
              if (arg.how === "fail") throw new Error("the test's failing step");
              await new Promise(() => {});
            }
            return ctx.shot(name, rect);
          },
        });
      },
    });
    out.result = await handle.done;
    out.ms = Date.now() - t0;
    step = "done";
    // A little after: nothing comes back late.
    await new Promise(r => win.setTimeout(r, 500));
    look();
  } finally {
    win.clearInterval(timer);
    win.removeEventListener("deactivate", onDeactivate, true);
    win.removeEventListener("blur", onBlur, true);
    ui.noteSidebarWaiting = noteWaiting;
    ui.alertsService = alerts;
  }
  out.left = {
    windowClosed: !!handle?.window?.closed,
    selfcheckWindows: [...Services.wm.getEnumerator("zenius:selfcheck")].length,
    final: seen(),
  };
  return out;
`;

/** The prefs a run must leave as they were: the sidebar's and zenius's. */
const PREFS = `
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
`;

/**
 * A run of `how` ("pass", "fail" or "hang"), with the user's state set up
 * before and set back after; the checks every kind of run shares.
 */
async function userRun(how, timeoutMs) {
  const outDir = mkdtempSync(join(scratch, `${how}-`));
  await h.chrome(`Services.prefs.setBoolPref(${JSON.stringify(NOTIFY)}, true); return true;`);
  const user = await h.call("dev.evalChrome", { code: USER_START, arg: { run } });
  try {
    const prefs = await h.chrome(PREFS);
    const out = await h.call("dev.evalChrome", { code: RUN, arg: { how, timeoutMs, outDir } });
    const prefsAfter = await h.chrome(PREFS);
    const { base } = out;
    // The user's state is in place: the run has something to disturb.
    assert.deepEqual(
      { open: base.sidebar.open, width: base.sidebar.width, widthPref: base.sidebar.widthPref, mode: base.sidebar.mode, task: base.sidebar.task, draft: base.sidebar.draft },
      { open: true, width: "470px", widthPref: 470, mode: "work", task: user.uid, draft: `A draft of mine ${run}` },
      "the user's sidebar, as they left it"
    );
    assert.ok(base.directory?.includes(user.uid), "the user's All tasks is open, on their task");
    assert.deepEqual(base.focus, { active: true, recentBrowser: true, top: true, hasFocus: true }, "the user's window has the focus");
    assert.deepEqual({ windowtype: out.windowtype, isUserWindow: out.isUserWindow }, { windowtype: "zenius:selfcheck", isUserWindow: false }, "the run is in a window of its own, not a browser window");
    // Throughout, and after: the user's window as it was.
    assert.deepEqual(out.diffs, [], "the user's window showed something of the run, or lost the focus");
    assert.deepEqual(out.events, { deactivate: 0, blur: 0 }, "the user's window never lost the focus");
    assert.deepEqual(out.left.final, base, "after the run, the user's window is as it was");
    assert.ok(
      out.waiting.every(list => list.every(uid => uid === user.uid)),
      `the sidebar told zenius about a synthetic task waiting: ${JSON.stringify(out.waiting)}`
    );
    assert.deepEqual(out.alerts, [], "no notification");
    assert.deepEqual(prefsAfter, prefs, "the sidebar's and zenius's prefs are as they were");
    // The run itself ended and went.
    assert.equal(out.left.windowClosed, true, "the self-check's window closed");
    assert.equal(out.left.selfcheckWindows, 0, "no self-check window is left");
    return out;
  } finally {
    await h.call("dev.evalChrome", { code: USER_END, arg: { user } });
    await h.chrome(`Services.prefs.clearUserPref(${JSON.stringify(NOTIFY)}); return true;`);
  }
}

test("a self-check that passes shows nothing in the user's window, from its start to the end of its cleanup: their All tasks lists only their own tasks, zenius's strip, its waiting line, the Spaces' badges and the tabs' tags stay as they were, no card or notification shows, their own sidebar keeps its open state, width, mode, task and draft, and their window keeps the focus and stays the front browser window", async () => {
  const out = await userRun("pass", 120_000);
  assert.equal(out.result?.ok, true, `the run passed: ${JSON.stringify(out.result)}`);
  assert.deepEqual(
    (out.result?.checks ?? []).map(c => [c.id, c.ok]),
    CHECKS.map(id => [id, true])
  );
  assert.ok(
    CHECKS.every(id => out.steps.some(s => s.startsWith(id + "/"))),
    `the user's window was looked at in every check's steps: ${out.steps.join(", ")}`
  );
});

test("a self-check whose check fails mid-way shows nothing in the user's window either, and cleans up the same: the failing check says which step failed, and the user's window, sidebar and focus are as they were", async () => {
  const out = await userRun("fail", 120_000);
  assert.equal(out.result?.ok, false, "the run failed");
  const check = String(out.tripped).split("/")[0];
  const failed = (out.result?.checks ?? []).find(c => c.id === check);
  assert.equal(failed?.ok, false, `the check whose step threw failed: ${JSON.stringify(out.result)}`);
  assert.ok(failed?.failedStep && String(out.tripped).endsWith(String(failed.failedStep)), `it names the step: ${failed?.failedStep} for ${out.tripped}`);
  assert.equal(out.result.checks[0].ok, true, "the check before it passed");
});

test("a self-check that runs past its limit ends at the limit and cleans up the same: the user's window, sidebar and focus are as they were, and nothing of the run is left", async () => {
  // Long enough for the first check to pass on a slow machine: the hang is in
  // the second, with synthetic tasks about.
  const limit = 45_000;
  const out = await userRun("hang", limit);
  assert.ok(out.tripped, `the run reached its hanging step: ${out.steps.join(", ")}`);
  assert.equal(out.result?.timedOut, true, `the run timed out: ${JSON.stringify(out.result)}`);
  assert.equal(out.result?.ok, false);
  // The summary keeps the check that ended, and fails the one in progress at
  // its last shot's step.
  const check = String(out.tripped).split("/")[0];
  const checks = out.result.checks ?? [];
  assert.equal(checks[0]?.ok, true, `the first check ended and passed: ${JSON.stringify(checks)}`);
  const hung = checks.find(c => c.id === check);
  assert.equal(hung?.ok, false, `the check in progress failed: ${JSON.stringify(checks)}`);
  assert.ok(hung.failedStep && String(out.tripped).endsWith(String(hung.failedStep)), `at its last shot's step: ${hung.failedStep} for ${out.tripped}`);
  // The limit, then cleanup: the window closes within 5 s (the note).
  assert.ok(out.ms < limit + 10_000, `done settled ${out.ms} ms after the start`);
});

test("a self-check whose task comes to need the user, as a failed turn leaves one, shows nothing of it in the user's window: zenius's strip and its count, the waiting line, the Spaces' badges, the panel's Needs-you count and notifications stay as they were, and the sidebar tells zenius of no such task; it needs the user in the run's own window alone", async () => {
  const out = await userRun("needs", 120_000);
  assert.deepEqual(out.needs, { state: "needs", scoped: true, inRun: 1, userLists: false }, "the run's task needs the user, in the run's own lists alone");
  assert.equal(out.result?.ok, true, `the run still passed: ${JSON.stringify(out.result)}`);
});

/** Run the CLI as the user's shell would; resolves with its exit code and output. */
function cli(args, timeout) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { timeout, env: { ...process.env } }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? error.signal) : 0, stdout, stderr });
    });
  });
}

test("end to end, as step 6 runs it: `zenius selfcheck` from outside the sandbox reaches the self-check socket and runs all three checks, which pass; the run's folder holds exactly summary.json, with names and no paths, and one PNG per step, 0600 and holding only pixels, in a folder of its own that only the user can read; the user's window kept the focus, and no self-check window is left", async () => {
  const sock = join(home, "selfcheck", `${instance}.sock`);
  const runs = join(home, "selfcheck", instance);
  // The runtime opens the socket at idle, after the agents' one.
  for (const end = Date.now() + 30_000; !existsSync(sock) && Date.now() < end; ) {
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(existsSync(sock), `the self-check socket is there: ${sock}`);
  const had = new Set(existsSync(runs) ? readdirSync(runs) : []);
  await h.chrome(`
    const events = { deactivate: 0, blur: 0 };
    const count = type => e => {
      if (type === "deactivate" || e.target === win || e.target === win.document) events[type]++;
    };
    const on = { deactivate: count("deactivate"), blur: count("blur") };
    win.addEventListener("deactivate", on.deactivate, true);
    win.addEventListener("blur", on.blur, true);
    win.zeniusSelfcheckTest = { events, stop() { win.removeEventListener("deactivate", on.deactivate, true); win.removeEventListener("blur", on.blur, true); } };
    return true;
  `);
  let dir = null;
  try {
    const t0 = Date.now();
    const res = await cli(["selfcheck", "--instance", instance], 180_000);
    const ms = Date.now() - t0;
    // The run's new folder, if it made one. Only a real folder named by its
    // UTC start is the test's to remove after, whatever the exit: a failing
    // run leaves anything else alone.
    const made = existsSync(runs) ? readdirSync(runs).filter(name => !had.has(name)) : [];
    const folder = made.length === 1 && /^\d{8}T\d{6}Z$/.test(made[0]) ? lstatSync(join(runs, made[0])) : null;
    if (folder?.isDirectory() && !folder.isSymbolicLink()) {
      dir = join(runs, made[0]);
    }
    // The exit first, with what the front said. A front that fails before
    // the run makes no folder, and only its words say why: on the night
    // cut's Mac run, one that failed in 87 ms showed only ENOENT.
    assert.equal(res.code, 0, `exit 0 when all pass (it took ${ms} ms)\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    // The folder: its own, by its UTC start, for the user only.
    assert.equal(made.length, 1, `one run folder: ${made.join(", ")}`);
    assert.match(made[0], /^\d{8}T\d{6}Z$/);
    assert.ok(dir, "the run's folder is a folder, not a link");
    assert.ok(ms < 150_000, `the run took ${ms} ms`);
    assert.equal(folder.mode & 0o777, 0o700, "the run's folder is 0700");
    // The summary: every check passed, by name, with no path in it.
    const text = readFileSync(join(dir, "summary.json"), "utf8");
    const summary = JSON.parse(text);
    assert.equal(summary.ok, true, text);
    assert.equal(summary.timedOut, false);
    assert.deepEqual(summary.checks.map(c => [c.id, c.ok, c.failedStep ?? null, c.error ?? null]), CHECKS.map(id => [id, true, null, null]));
    for (const key of ["runtimeVersion", "commit", "zenVersion"]) {
      assert.equal(typeof summary[key], "string", `summary.${key}`);
    }
    const strings = [];
    const walk = v => (typeof v === "string" ? strings.push(v) : v && typeof v === "object" && Object.values(v).forEach(walk));
    walk(summary);
    assert.deepEqual(strings.filter(v => v.includes(homedir()) || v.startsWith("/")), [], "summary.json names files and holds no path");
    // The shots: one per step, each check's in its order, and nothing else.
    const shots = summary.checks.flatMap(c => c.shots);
    assert.ok(
      summary.checks.every(c => c.shots.length > 0 && c.shots.every(name => new RegExp(`^\\d+-${c.id}-[a-z0-9-]+\\.png$`).test(name))),
      `each check's shots are <n>-<check>-<step>.png: ${shots.join(", ")}`
    );
    assert.deepEqual(readdirSync(dir).sort(), ["summary.json", ...shots].sort(), "the folder holds the summary and the shots only");
    for (const name of shots) {
      const st = lstatSync(join(dir, name));
      assert.ok(st.isFile(), `${name} is a file`);
      assert.equal(st.mode & 0o777, 0o600, `${name} is 0600`);
      const png = readFileSync(join(dir, name));
      assert.equal(png.subarray(0, 8).toString("binary"), "\x89PNG\r\n\x1a\n", `${name} is a PNG`);
      assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0, `${name} has pixels`);
    }
    const media = await new Promise(resolve =>
      execFile("perl", [MEDIA_CHECK, ...shots.map(name => join(dir, name))], (error, stdout) => resolve({ code: error?.code ?? 0, stdout }))
    );
    assert.equal(media.code, 0, `each shot holds only its pixels:\n${media.stdout}`);
    // What the front printed: a line for each check, and the folder.
    for (const c of summary.checks) {
      assert.ok(res.stdout.includes(c.title), `the front names "${c.title}":\n${res.stdout}`);
    }
    assert.ok(res.stdout.includes(made[0]), `the front names the folder:\n${res.stdout}`);
    // The user's window kept the focus, and the run's window is gone.
    const after = await h.chrome(`
      const t = win.zeniusSelfcheckTest;
      return { events: t.events, windows: [...Services.wm.getEnumerator("zenius:selfcheck")].length, active: Services.focus.activeWindow === win };
    `);
    assert.deepEqual(after, { events: { deactivate: 0, blur: 0 }, windows: 0, active: true });
  } finally {
    await h.chrome(`win.zeniusSelfcheckTest?.stop(); delete win.zeniusSelfcheckTest; return true;`);
    // The run's folder is the test's to remove; the instance's others aren't.
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
