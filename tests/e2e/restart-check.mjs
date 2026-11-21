#!/usr/bin/env node
// zen-eval's Mac restart check for the Agents Space (SPEC §3.4, "Restarts";
// docs/SPI.md, "Tasks in the Agents Space"). Tasks share the Agents Space, and
// a task's tabs carry their task in the session value `zenius`. After a
// restart or a crash the runtime puts each restored tab back in its task
// (step 4, 50fde32). Its pages stay unloaded until an agent's call uses one.
// tests/core/restart.test.mjs checks this on Linux with browser.startup.page
// set to 3 in user.js. Here the restore prefs stay at Zen's own defaults, as
// on the user's daily profile, which sets neither: browser.startup.page (3)
// and browser.sessionstore.resume_from_crash (true).
//
//   node tests/e2e/restart-check.mjs --case restart|edge|crash [--startup-page default|0]
//                                    [--name <profile>] [--out <file.json>] [--keep]
//
// - restart: two tasks and the user's tabs; Zen quits as the user quits it.
// - edge: zen.workspaces.continue-where-left-off on, and the window shows a
//   task's page in the Agents Space at the quit, so Zen loads that page at
//   start; the first call finds it guarded.
// - crash: one task stays until Zen's own session file has it; another is a
//   few seconds old when Zen is killed (SIGKILL). zen-core found that the
//   periodic save drops tabs whose history it hasn't collected yet, so that
//   task should end as not_restored.
// --startup-page 0 keeps zen-dev.sh's usual value instead, as a control.
//
// Each run uses a fresh headless dev profile, removed afterwards unless
// --keep, with dev methods on (the reads go through dev.evalChrome). A
// loopback server serves the pages, so nothing leaves the machine.
//
// The kill: the user's daily Zen runs from the same Zen.app binary, so the
// one process killed is the pid zen-dev.sh recorded for this instance, and
// only after its command line shows this profile under ~/.zenius-dev.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { connect } from "../../scripts/lib/rpc.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ZEN_DEV = join(ROOT, "scripts", "zen-dev.sh");
const VALUE_KEY = "zenius";
const DEV_HOME = join(homedir(), ".zenius-dev");

const opts = { case: null, startupPage: "default", keep: false, name: null, out: null };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--case") opts.case = process.argv[++i];
  else if (a === "--startup-page") opts.startupPage = process.argv[++i];
  else if (a === "--name") opts.name = process.argv[++i];
  else if (a === "--out") opts.out = process.argv[++i];
  else if (a === "--keep") opts.keep = true;
  else throw new Error(`unknown argument ${a}`);
}
if (!["restart", "edge", "crash"].includes(opts.case)) throw new Error("--case is restart, edge or crash");
if (!["default", "0"].includes(opts.startupPage)) throw new Error("--startup-page is default or 0");
const name = opts.name ?? `zen-eval-restart-${opts.case}${opts.startupPage === "0" ? "-p0" : ""}`;
const profile = join(DEV_HOME, "profiles", name);
const stateDir = join(homedir(), ".zenius", "state", name);

// Tasks always share the Agents Space since b3d226e, which removed pref
// zenius.agentsSpace; only the edge case sets a pref of its own.
const prefs = opts.case === "edge" ? { "zen.workspaces.continue-where-left-off": true } : {};
const devEnv = { ...process.env };
delete devEnv.ZENIUS_DEV_METHODS;
// Dropped from user.js and prefs.js, so Zen's own defaults apply.
devEnv.ZENIUS_DEV_DEFAULT_PREFS = [
  ...(opts.startupPage === "default" ? ["browser.startup.page"] : []),
  "browser.sessionstore.resume_from_crash",
].join(" ");
delete devEnv.ZENIUS_DEV_PREFS;
if (Object.keys(prefs).length) {
  devEnv.ZENIUS_DEV_PREFS = join(tmpdir(), `${name}-prefs.js`);
  writeFileSync(
    devEnv.ZENIUS_DEV_PREFS,
    Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n") + "\n",
  );
}

// Asynchronous on purpose: the loopback server below runs in this process, and
// a synchronous child would block it while Zen waits for a page.
const run = promisify(execFile);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function zenDev(cmd) {
  try {
    const r = await run("bash", [ZEN_DEV, name, cmd], { env: devEnv, encoding: "utf8", timeout: 120000 });
    return `${r.stdout}${r.stderr}`.trim();
  } catch (e) {
    throw new Error(`zen-dev.sh ${name} ${cmd} failed: ${`${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message}`);
  }
}

let client = null;
async function reconnect() {
  client?.close();
  client = await connect(name, { timeout: 30000, callTimeout: 45000 });
}
const call = (method, params = {}) => client.call(method, params);
const chrome = (code, arg) => call("dev.evalChrome", { code, arg });
/** A call's error as {code, reason}, or null when it succeeds. */
async function failure(method, params) {
  try {
    await call(method, params);
    return null;
  } catch (e) {
    return { code: e.code ?? null, reason: e.data?.reason ?? null };
  }
}

const PREFS = `
  const b = Services.prefs.getDefaultBranch("");
  const pref = (n, get) => ({ value: Services.prefs[get](n), userSet: Services.prefs.prefHasUserValue(n) });
  return {
    startupPage: { ...pref("browser.startup.page", "getIntPref"), default: b.getIntPref("browser.startup.page") },
    resumeFromCrash: { ...pref("browser.sessionstore.resume_from_crash", "getBoolPref"), default: b.getBoolPref("browser.sessionstore.resume_from_crash") },
    restoreOnDemand: Services.prefs.getBoolPref("browser.sessionstore.restore_on_demand", null),
    continueWhereLeftOff: Services.prefs.getBoolPref("zen.workspaces.continue-where-left-off", null),
    zen: Services.appinfo.version,
  };`;

const STATE = `
  const all = gZenWorkspaces?.workspaceEnabled ? [...gZenWorkspaces.allStoredTabs] : [...gBrowser.tabs];
  const tabs = all.map(t => {
    let url = t.linkedBrowser?.currentURI?.spec ?? null;
    try {
      const st = JSON.parse(SessionStore.getTabState(t));
      const e = st.entries?.[(st.index || st.entries.length) - 1];
      if (e?.url) url = e.url;
    } catch {}
    return {
      url,
      space: t.getAttribute("zen-workspace-id") || null,
      unloaded: !t.linkedPanel || t.hasAttribute("pending"),
      selected: t.selected,
      value: SessionStore.getCustomTabValue(t, ${JSON.stringify(VALUE_KEY)}) || null,
    };
  });
  return {
    active: gZenWorkspaces.activeWorkspace,
    agentsSpace: ctx.spaces.agentsSpace?.uuid ?? null,
    spaces: gZenWorkspaces.getWorkspaces().map(w => ({ uuid: w.uuid, name: w.name })),
    tabs,
  };`;

/** A page's tab, in chrome code with `arg` {space, page}. */
const TAB = "const t = ctx.pages.tabFor(ctx.pages.get(ctx.spaces.get(arg.space), arg.page));";
const tabsOf = async space => (await call("tabs.list", { space })).map(t => [t.label ?? null, t.openedBy]);
/** A task's tabs: [label (null: not a page), unloaded]. */
const unloaded = space =>
  chrome(
    `return ctx.pages.tabsOf(ctx.spaces.get(arg)).map(t => [ctx.pages.forTab(t)?.label ?? null, !t.linkedPanel || t.hasAttribute("pending")]);`,
    space,
  );
/** The page's tab: whether it waits unloaded, whether its entry was the system's, its documents' guards. */
const loadState = page =>
  chrome(
    `${TAB}
     // A lazy tab's browser gets inserted, and so loads, when most of its
     // properties are read: only the tab's own attributes then.
     if (!t.linkedPanel || t.hasAttribute("pending")) return { lazy: !t.linkedPanel, pending: t.hasAttribute("pending") };
     const sh = t.linkedBrowser.browsingContext?.sessionHistory;
     const docs = t.linkedBrowser.browsingContext?.getAllBrowsingContextsInSubtree() ?? [];
     return {
       pending: t.hasAttribute("pending"),
       system: sh && sh.count ? sh.getEntryAtIndex(sh.index).triggeringPrincipal.isSystemPrincipal : null,
       guards: await Promise.all(docs.map(bc => ctx.content(bc, "guards#installed", {}).catch(() => false))),
       top: t.linkedBrowser.browsingContext?.currentWindowGlobal?.documentURI?.spec ?? null,
     };`,
    page,
  );

/** mozLz4 files: an 8-byte magic, the decoded size, then one LZ4 block. */
function readMozLz4(path) {
  const buf = readFileSync(path);
  if (buf.subarray(0, 8).toString("latin1") !== "mozLz40\0") throw new Error(`${path}: not mozLz4`);
  const src = buf.subarray(12);
  const out = Buffer.alloc(buf.readUInt32LE(8));
  let i = 0;
  let o = 0;
  while (i < src.length) {
    const token = src[i++];
    let lit = token >> 4;
    if (lit === 15) for (let b = 255; b === 255; lit += b) b = src[i++];
    src.copy(out, o, i, i + lit);
    i += lit;
    o += lit;
    if (i >= src.length) break;
    const off = src[i] | (src[i + 1] << 8);
    i += 2;
    let len = token & 15;
    if (len === 15) for (let b = 255; b === 255; len += b) b = src[i++];
    len += 4;
    for (let k = 0; k < len; k++, o++) out[o] = out[o - off];
  }
  return JSON.parse(out.subarray(0, o).toString("utf8"));
}

/** Every saved tab in a session file: its URL and whether it carries a task. */
function savedTabs(data) {
  const found = [];
  const walk = node => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.entries) && ("index" in node || "pinned" in node || "extData" in node)) {
      const e = node.entries[(node.index || node.entries.length) - 1];
      found.push({ url: e?.url ?? null, task: node.extData?.[VALUE_KEY] ? JSON.parse(node.extData[VALUE_KEY]).task ?? null : null });
      return;
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(data);
  return found;
}

const SESSION_FILES = ["zen-sessions.jsonlz4", "sessionstore.jsonlz4", join("sessionstore-backups", "recovery.jsonlz4")];
/** Our pages each session file holds now, by path; null when the file is missing. */
function savedPages() {
  const files = {};
  for (const f of SESSION_FILES) {
    const p = join(profile, f);
    if (!existsSync(p)) {
      files[f] = null;
      continue;
    }
    try {
      files[f] = savedTabs(readMozLz4(p))
        .filter(t => t.url?.startsWith(base))
        .map(t => t.url.slice(base.length + 1).replace(/\.html$/, ""));
    } catch (e) {
      files[f] = { error: String(e.message ?? e) };
    }
  }
  return files;
}

const server = http.createServer((req, res) => {
  const page = (/^\/([a-z0-9-]+)\.html/.exec(req.url ?? "") ?? [])[1] ?? "page";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><title>${page}</title><h1>${page}</h1>`);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const url = page => `${base}/${page}.html`;
const USER_TABS = ["user-1", "user-2"];

/** A task with one page per name, each loaded by the agent. */
async function task(title, pages) {
  const space = (await call("spaces.create", { name: title })).id;
  const labels = [];
  for (const page of pages) {
    const { label } = await call("pages.new", { space });
    await call("page.goto", { space, page: label, url: url(page) });
    labels.push(label);
  }
  return { title, space, pages, labels };
}

/** Kill this instance's Zen as a crash would: only the pid zen-dev.sh recorded, once it proves to be ours. */
async function killOurZen() {
  const pid = Number(readFileSync(join(DEV_HOME, "run", `${name}.pid`), "utf8").trim());
  const command = (await run("ps", ["-ww", "-o", "command=", "-p", String(pid)])).stdout.trim();
  const ours = `--profile ${profile}`;
  if (!profile.startsWith(`${DEV_HOME}/`) || !(command.includes(`${ours} `) || command.endsWith(ours))) {
    throw new Error(`pid ${pid} isn't this instance's Zen (its command line has no ${ours}); not killing it`);
  }
  // Its child processes, to see that they end with it.
  const children = (await run("ps", ["-A", "-o", "pid=,ppid="])).stdout
    .trim()
    .split("\n")
    .map(l => l.trim().split(/\s+/).map(Number))
    .filter(([, ppid]) => ppid === pid)
    .map(([p]) => p);
  process.kill(pid, "SIGKILL");
  const alive = p => {
    try {
      process.kill(p, 0);
      return true;
    } catch (e) {
      return e.code !== "ESRCH";
    }
  };
  const end = Date.now() + 10000;
  while (alive(pid) && Date.now() < end) await sleep(50);
  while (children.some(alive) && Date.now() < end) await sleep(100);
  return { pid, commandHasProfile: true, gone: !alive(pid), children: children.length, childrenLeft: children.filter(alive) };
}

const report = { name, case: opts.case, startupPage: opts.startupPage, prefs, at: new Date().toISOString(), rows: [] };
const check = (what, expected, got) => report.rows.push({ what, expected, got, pass: JSON.stringify(expected) === JSON.stringify(got) });
const tasks = [];
try {
  await zenDev("stop");
  rmSync(profile, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });

  report.start1 = (await zenDev("start")).split("\n").pop();
  await reconnect();
  report.prefs1 = await chrome(PREFS);

  // The user's own tabs, in the Space the window shows: real tabs, not Zen's
  // empty new-tab placeholder, which Zen never saves.
  await chrome(
    `const p = Services.scriptSecurityManager.getSystemPrincipal();
     const tabs = arg.map(u => gBrowser.addTab(u, { triggeringPrincipal: p, inBackground: true, skipBackgroundNotify: true }));
     gBrowser.selectedTab = tabs[0];
     return true;`,
    USER_TABS.map(url),
  );

  if (opts.case === "restart") {
    tasks.push(await task("restart A", ["a-1", "a-2"]), await task("restart B", ["b-1"]));
  } else if (opts.case === "edge") {
    tasks.push(await task("edge shown", ["f-1"]), await task("edge other", ["a-1", "a-2"]));
    // The user opens the Agents Space and selects the first task's page.
    report.shown = await chrome(
      `${TAB}
       await win.gZenWorkspaces.changeWorkspaceWithID(ctx.spaces.agentsSpace.uuid);
       win.gBrowser.selectedTab = t;
       return { agentsSpaceShown: win.gZenWorkspaces.activeWorkspace === ctx.spaces.agentsSpace.uuid, selected: win.gBrowser.selectedTab === t };`,
      { space: tasks[0].space, page: tasks[0].labels[0] },
    );
  } else {
    tasks.push(await task("crash saved", ["k-1", "k-2"]));
    // Until Zen's own session file, which it restores a crash from, has this
    // task: no flush, only its periodic save.
    const t0 = Date.now();
    let files = null;
    while (Date.now() - t0 < 120000) {
      files = savedPages();
      const zen = files["zen-sessions.jsonlz4"];
      if (Array.isArray(zen) && ["k-1", "k-2"].every(p => zen.includes(p))) break;
      await sleep(1000);
    }
    report.savedTaskInZenFileAfterS = Math.round((Date.now() - t0) / 1000);
    report.filesBeforeNew = files;
    tasks.push(await task("crash new", ["n-1"]));
    report.newTaskLoadedAt = Date.now();
  }

  report.before = {};
  for (const t of tasks) report.before[t.title] = await tabsOf(t.space);
  report.stateBefore = await chrome(STATE);

  if (opts.case === "crash") {
    report.filesAtKill = savedPages();
    report.newTaskAgeAtKillMs = Date.now() - report.newTaskLoadedAt;
    report.kill = await killOurZen();
    client.close();
  } else {
    client.close();
    report.quit = (await zenDev("quit")).split("\n").pop();
  }
  report.filesAfterEnd = savedPages();

  const t1 = Date.now();
  report.start2 = (await zenDev("start")).split("\n").pop();
  await reconnect();
  if (opts.case === "edge") {
    // The first call after the start: Zen loaded the shown page itself, and
    // the rebuild guarded its documents before answering.
    const f = tasks[0];
    report.firstCall = await chrome(
      `${TAB}
       const docs = t.linkedBrowser.browsingContext.getAllBrowsingContextsInSubtree();
       return {
         selected: win.gBrowser.selectedTab === t,
         loaded: !t.hasAttribute("pending"),
         guards: await Promise.all(docs.map(c => ctx.content(c, "guards#installed", {}).catch(e => "error: " + e.message))),
       };`,
      { space: f.space, page: f.labels[0] },
    );
  }
  report.firstCallAfterStartMs = Date.now() - t1;
  report.prefs2 = await chrome(PREFS);
  report.stateAfter = await chrome(STATE);
  report.listed = (await call("spaces.list")).taskSpaces.map(s => s.id);

  // Each task: back with the same tabs, unloaded, or gone as not_restored.
  report.after = {};
  for (const t of tasks) {
    const t0 = Date.now();
    const error = await failure("pages.list", { space: t.space });
    report.after[t.title] = error
      ? { error, ms: Date.now() - t0 }
      : { tabs: await tabsOf(t.space), unloaded: await unloaded(t.space) };
  }

  // A page call on a restored page loads it, as the agent's own load.
  const used = opts.case === "crash" ? { t: tasks[0], i: 1 } : opts.case === "edge" ? { t: tasks[1], i: 0 } : { t: tasks[0], i: 0 };
  const page = { space: used.t.space, page: used.t.labels[used.i] };
  report.pageCall = { task: used.t.title, page: page.page, expected: url(used.t.pages[used.i]), before: await loadState(page) };
  report.pageCall.href = await call("page.evaluate", { ...page, fn: "location.href", isFunction: false });
  report.pageCall.after = await loadState(page);
  report.pageCall.unloadedAfter = await unloaded(used.t.space);
} catch (e) {
  report.error = String(e.stack ?? e);
} finally {
  client?.close();
  try {
    await zenDev("stop");
  } catch {}
  if (!opts.keep) {
    rmSync(profile, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    // A killed instance leaves its socket, record and pid file behind.
    rmSync(join(homedir(), ".zenius", "run", `${name}.sock`), { force: true });
    rmSync(join(homedir(), ".zenius", "instances", `${name}.json`), { force: true });
    rmSync(join(DEV_HOME, "logs", `${name}.log`), { force: true });
    rmSync(join(DEV_HOME, "run", `${name}.pid`), { force: true });
  }
  if (devEnv.ZENIUS_DEV_PREFS) rmSync(devEnv.ZENIUS_DEV_PREFS, { force: true });
  server.close();
}

// The verdict.
const p2 = report.prefs2;
check("restore prefs at the restart", { startupPage: opts.startupPage === "default" ? "3, Zen's default" : "0, set", resumeFromCrash: "true, Zen's default" }, p2 ? {
  startupPage: `${p2.startupPage.value}, ${p2.startupPage.userSet ? "set" : "Zen's default"}`,
  resumeFromCrash: `${p2.resumeFromCrash.value}, ${p2.resumeFromCrash.userSet ? "set" : "Zen's default"}`,
} : null);
const back = t => report.after?.[t.title]?.tabs ?? null;
const allUnloaded = t => report.after?.[t.title]?.unloaded?.every(([, u]) => u) ?? null;
if (opts.case === "crash") {
  const [saved, fresh] = tasks;
  check("Zen killed: our pid, its command line under ~/.zenius-dev; it and its children gone", true, !!(report.kill?.gone && report.kill.childrenLeft.length === 0));
  // The file as Zen left it, which is what it restores from.
  const zenFile = report.filesAfterEnd?.["zen-sessions.jsonlz4"];
  check("the older task in Zen's file at the kill", true, Array.isArray(zenFile) && zenFile.includes("k-1") && zenFile.includes("k-2"));
  check("the seconds-old task in Zen's file at the kill", false, Array.isArray(zenFile) && zenFile.includes("n-1"));
  check(`"${saved.title}" back with its tabs`, report.before?.[saved.title], back(saved));
  check(`"${saved.title}" unloaded`, true, allUnloaded(saved));
  check(`"${fresh.title}" (seconds old) ends as not_restored`, { code: "ZEN_TASK_SPACE_NOT_FOUND", reason: "not_restored" }, report.after?.[fresh.title]?.error ?? "back");
  check(`"${fresh.title}" fails at once (< 1 s)`, true, (report.after?.[fresh.title]?.ms ?? Infinity) < 1000);
} else {
  check("Zen quit cleanly", true, /\bquit$/.test(report.quit ?? ""));
  for (const t of tasks) {
    check(`"${t.title}" back with its tabs`, report.before?.[t.title], back(t));
    if (!(opts.case === "edge" && t === tasks[0])) check(`"${t.title}" unloaded`, true, allUnloaded(t));
  }
  if (opts.case === "edge") {
    check("the shown page at the first call: selected, loaded, guarded", { selected: true, loaded: true, guards: [true] }, report.firstCall ?? null);
  }
}
const pc = report.pageCall;
check("the page waits unloaded before the call", true, pc?.before ? !!(pc.before.lazy || pc.before.pending) : null);
check("a page call returns its page's URL", pc?.expected ?? "a page call", pc?.href ?? null);
check("that call's tab: loaded by the agent's load (not the system's), guarded", { pending: false, system: false, guards: [true] }, pc?.after ? { pending: pc.after.pending, system: pc.after.system, guards: pc.after.guards } : null);
check("only that page of its task loaded", pc?.unloadedAfter?.map(([label]) => [label, label !== pc.page]) ?? null, pc?.unloadedAfter ?? null);
const userBack = USER_TABS.map(p => report.stateAfter?.tabs?.find(t => t.url === url(p)));
check("the user's tabs back, outside the Agents Space", USER_TABS.map(() => true), userBack.map(t => !!t && t.space !== report.stateAfter.agentsSpace));

const failed = report.rows.filter(r => !r.pass);
if (opts.out) writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`${name}: case ${opts.case}, startup page ${opts.startupPage}, prefs ${JSON.stringify(prefs)}`);
if (report.error) console.log(`ERROR ${report.error.split(homedir()).join("~")}`);
for (const r of report.rows) console.log(`  ${r.pass ? "ok  " : "FAIL"} ${r.what}${r.pass ? "" : `\n       expected ${JSON.stringify(r.expected)}\n       got      ${JSON.stringify(r.got)}`}`);
if (opts.case === "crash") console.log(`  (the older task was in Zen's file ${report.savedTaskInZenFileAfterS} s after its pages loaded; the new one was ${report.newTaskAgeAtKillMs} ms from its last load to the kill)`);
console.log(`  first call ${report.firstCallAfterStartMs} ms after the restart began; ${failed.length ? `${failed.length} failed` : "all passed"}`);
process.exitCode = report.error || failed.length ? 1 : 0;
