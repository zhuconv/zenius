// The restart rebuild (SPI "Restart"): after Zen quits or crashes, each
// task comes back from its tabs' session values. Its pages stay unloaded
// until an agent's call uses one, and the call loads a page only if agents
// may load the URL it shows (I5). Each test quits and starts the dev Zen
// with the prefs it needs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import http from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { connect } from "../../scripts/lib/rpc.mjs";
import { setup, sleep } from "./lib.mjs";

let h;
const dir = mkdtempSync(join(tmpdir(), "zenius-restart-"));

before(async () => {
  h = await setup();
});
after(async () => {
  // The dev profile's prefs again, for the test files after this one.
  await h
    ?.chrome(
      `for (const name of ["zenius.autoCloseHours", "zen.workspaces.continue-where-left-off"]) {
         Services.prefs.clearUserPref(name);
       }
       Services.prefs.setIntPref("browser.startup.page", 0);
       Services.prefs.setBoolPref("browser.sessionstore.resume_from_crash", false);
       for (const rec of ctx.spaces.records()) {
         if (rec.kind === "task" && !rec.gone) {
           for (const t of ctx.pages.tabsOf(rec)) ctx.pages.closeTab(t);
           ctx.spaces.remove(rec);
         }
       }
       return true;`
    )
    .catch(() => {});
  await h?.close();
  rmSync(dir, { recursive: true, force: true });
});

const url = path => `${h.base}${path}`;
const SS = `const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");`;
/** A page's tab, in chrome code with `arg` {space, page}. */
const TAB = `const t = ctx.pages.tabFor(ctx.pages.get(ctx.spaces.get(arg.space), arg.page));`;

/** The dev profile's user.js lines for these prefs. */
function prefsFile(prefs) {
  const file = join(dir, "prefs.js");
  const lines = Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

/** Quit Zen as the user does (it saves its session), then start it with these prefs. */
async function restart(prefs, opts) {
  await h.chrome(`await ctx.service.flushState(); return true`);
  process.env.ZENIUS_DEV_PREFS = prefsFile(prefs);
  try {
    await h.restart({}, opts);
  } finally {
    delete process.env.ZENIUS_DEV_PREFS;
  }
}

/**
 * This instance's dev Zen, checked before the crash below SIGKILLs it: its
 * command line must name the instance's profile under ~/.zenius-dev. A pid
 * file can be stale and its pid reused by any process, the user's daily Zen
 * included (pids get recycled, on the Mac too). The pid file's pid if it is
 * that Zen, else the one found by the profile's path, as zen-dev.sh's
 * profile_pid finds a Zen that relaunched itself; else a loud error, and no
 * kill.
 */
function devZenPid() {
  const home = process.env.ZENIUS_DEV_HOME || join(homedir(), ".zenius-dev");
  const profile = join(home, "profiles", h.instance);
  const commandOf = pid => {
    try {
      return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  // Exact arguments, so profile "x" never matches "x-2"; never a content process.
  const names = command => {
    const args = command.split(/\s+/);
    return !args.includes("-contentproc") && args.some((arg, i) => arg === "--profile" && args[i + 1] === profile);
  };
  const recorded = Number(readFileSync(join(home, "run", `${h.instance}.pid`), "utf8").trim());
  if (Number.isInteger(recorded) && recorded > 1 && names(commandOf(recorded))) {
    return recorded;
  }
  for (const row of execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(row);
    if (m && names(m[2])) {
      return Number(m[1]);
    }
  }
  throw new Error(
    `Not killing pid ${recorded}: the pid file names it, but its command line ` +
      `(${JSON.stringify(commandOf(recorded).slice(0, 200))}) doesn't name the dev profile ${profile}, ` +
      "and no process does. It may be another process, such as the user's own Zen."
  );
}

/**
 * Save the session as Zen's periodic save would, and wait until Zen's own
 * file (zen-sessions.jsonlz4, from which it restores its Spaces and a
 * crashed session) has every one of these strings: URLs, Space uuids.
 */
const saveSession = strings =>
  h.chrome(
    `const { SessionSaver } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionSaver.sys.mjs");
     const { TabStateFlusher } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs");
     // Zen's periodic save writes the tab states it has collected, which
     // for a tab this new can still lack its history: collect them first,
     // as a save some seconds later would have them.
     await TabStateFlusher.flushWindow(win);
     await SessionSaver.run();
     await ctx.service.flushState();
     // Zen writes its own file in that run, which doesn't wait for it.
     const file = PathUtils.join(PathUtils.profileDir, "zen-sessions.jsonlz4");
     const end = Date.now() + 10000;
     for (;;) {
       let text = "";
       try {
         text = JSON.stringify(await IOUtils.readJSON(file, { decompress: true }));
       } catch {}
       if (arg.every(u => text.includes(u))) {
         return true;
       }
       if (Date.now() > end) {
         throw new Error("Zen's session file never had " + arg.join(", "));
       }
       await new Promise(r => win.setTimeout(r, 50));
     }`,
    strings
  );

/** Does the Space list in Zen's own session file have this Space now? */
const zenFileHas = uuid =>
  h.chrome(
    `const file = PathUtils.join(PathUtils.profileDir, "zen-sessions.jsonlz4");
     try {
       return (await IOUtils.readJSON(file, { decompress: true })).spaces?.some(s => s.uuid === arg) ?? false;
     } catch {
       return false;
     }`,
    uuid
  );

/**
 * Kill Zen as a crash would, once its session file has these URLs; then
 * start it with these prefs.
 */
async function crash(prefs, urls) {
  await saveSession(urls);
  await killAndStart(prefs);
}

/** SIGKILL this instance's Zen (devZenPid checks it's ours), then start it with these prefs. */
async function killAndStart(prefs) {
  h.client.close();
  const pid = devZenPid();
  process.kill(pid, "SIGKILL");
  for (let alive = true, end = Date.now() + 10000; alive; ) {
    try {
      process.kill(pid, 0);
      assert.ok(Date.now() < end, `Zen (pid ${pid}) still runs 10 s after SIGKILL`);
      await sleep(50);
    } catch (e) {
      if (e.code !== "ESRCH") {
        throw e;
      }
      alive = false;
    }
  }
  execFileSync(process.env.ZENIUS_DEV, [h.instance, "start"], {
    env: { ...process.env, ZENIUS_DEV_PREFS: prefsFile(prefs) },
    stdio: "ignore",
  });
  h.client = await connect(h.instance, { callTimeout: 30000 });
  h.restarted = true;
}

/** A task with one page per path, each loaded by the agent; returns {space, labels}. */
async function task(name, paths) {
  const space = await h.space(name);
  const labels = [];
  for (const path of paths) {
    const { label } = await h.call("pages.new", { space });
    await h.call("page.goto", { space, page: label, url: url(path) });
    labels.push(label);
  }
  return { space, labels };
}

const tabsOf = async space => (await h.call("tabs.list", { space })).map(t => [t.label ?? null, t.openedBy]);
/** A task's tabs, home Space first, in strip order: [label (null: not a page), unloaded]. */
const unloaded = space =>
  h.chrome(
    `return ctx.pages
       .tabsOf(ctx.spaces.get(arg))
       .map(t => [ctx.pages.forTab(t)?.label ?? null, !t.linkedPanel || t.hasAttribute("pending")]);`,
    space
  );
/** Every one of these tabs is unloaded, except the pages named. */
const allUnloadedBut = (tabs, loaded = []) => tabs.map(([label]) => [label, !loaded.includes(label)]);
/** Whether each document of a page's tab has the page guards, the top one first. */
const guarded = (space, page) =>
  h.chrome(
    `${TAB}
     return Promise.all(
       t.linkedBrowser.browsingContext.getAllBrowsingContextsInSubtree().map(bc => ctx.content(bc, "guards#installed", {}))
     );`,
    { space, page }
  );
const topURL = (space, page) =>
  h.chrome(`${TAB} return t.linkedBrowser.browsingContext?.currentWindowGlobal?.documentURI?.spec ?? "";`, {
    space,
    page,
  });
/** The user opens the Agents Space and selects a task's page. */
const userViews = (space, page) =>
  h.chrome(
    `${TAB}
     await win.gZenWorkspaces.changeWorkspaceWithID(ctx.spaces.agentsSpace.uuid);
     win.gBrowser.selectedTab = t;
     return true;`,
    { space, page }
  );
/** The user goes back to their first Space. */
const userGoesHome = () =>
  h.chrome(
    `const home = win.gZenWorkspaces.getWorkspaces().find(ws => !ctx.spaces.isAgentsSpace(ws.uuid));
     await win.gZenWorkspaces.changeWorkspaceWithID(home.uuid);
     return true;`
  );
const listedIds = async () => (await h.call("spaces.list")).taskSpaces.map(s => s.id);
/** Is any tab, in any window and Space, at this URL? Zen's gBrowser.tabs has only the active Space's. */
const anyTabAt = u =>
  h.chrome(
    `const { allTabs } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     return [...allTabs()].some(t => t.linkedBrowser.currentURI.spec === arg);`,
    u
  );
const notRestored = space => ({ code: "ZEN_TASK_SPACE_NOT_FOUND", data: { space, reason: "not_restored" } });

/**
 * The secret steps' pages, each request counted by its path and query: ?r=
 * names the page (its title), ?nostore makes it uncacheable, so no load of
 * it comes from the cache unseen. Its form field is one the session saves
 * and puts back. Its dropdown, with no option marked, and its email field,
 * whose value attribute its type cleans up, show other than their markup
 * says, though no one changed them: that's no one's input. Its first
 * script notes what it got (FIRST_SCRIPT). ?frame
 * adds a frame from another site (localhost, this server too) with a page
 * of its own, field included; ?sub, an image from there, a site no mark of
 * a step on this one names; ?design, an editor in designMode.
 */
const steps = { hits: new Map() };
/** window.__first: the page refusals' natives its first script saw unwrapped, and whether zen-ux's quiet Notification was there. */
const FIRST_SCRIPT = `window.__first = {
  native: ["Notification", "RTCPeerConnection", "SharedWorker", "BroadcastChannel"].filter(n => Function.prototype.toString.call(window[n]).includes(n)),
  quiet: window.Notification === window.Notification.prototype.constructor && !/function Notification\\(/.test(Function.prototype.toString.call(window.Notification)),
};`;
const GUARDED_FIRST = { native: [], quiet: true };
const stepServer = http.createServer((req, res) => {
  steps.hits.set(req.url, (steps.hits.get(req.url) ?? 0) + 1);
  const u = new URL(req.url, "http://x");
  const r = u.searchParams.get("r") ?? "step";
  const other = `http://localhost:${stepServer.address().port}`;
  if (r.endsWith("-sub")) {
    // An image: one the browser can't decode it drops from the cache.
    res.writeHead(200, { "content-type": "image/gif" });
    res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
    return;
  }
  res.writeHead(200, { "content-type": "text/html", ...(u.searchParams.has("nostore") ? { "cache-control": "no-store" } : {}) });
  res.end(
    `<!doctype html><title>${r}</title><script>${FIRST_SCRIPT}</script>` +
      `<form><input name=nickname><select name=size><option>small</option><option>large</option></select><input type=email name=mail value=" a@example.com "></form>` +
      (u.searchParams.has("frame") ? `<iframe src="${other}/?r=${r}-frame"></iframe>` : "") +
      (u.searchParams.has("sub") ? `<img src="${other}/?r=${r}-sub">` : "") +
      (u.searchParams.has("design") ? `<script>document.designMode = "on";</script>` : "")
  );
});
let stepBase = "";
before(async () => {
  await new Promise(resolve => stepServer.listen(0, "127.0.0.1", resolve));
  stepBase = `http://127.0.0.1:${stepServer.address().port}`;
});
after(() => {
  stepServer.close();
  stepServer.closeAllConnections();
});
/** Run `code` (a function body) as the page's own script. */
const inPage = (space, page, code) =>
  h.chrome(`${TAB} return ctx.content(t.linkedBrowser.browsingContext, "dev#evalContent", { code: arg.code, privileged: false });`, {
    space,
    page,
    code,
  });
/** A load the user makes in the held tab. */
const userLoads = (space, page, u) =>
  h.chrome(
    `${TAB} t.linkedBrowser.loadURI(Services.io.newURI(arg.url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); return true;`,
    { space, page, url: u }
  );
/** A page's tab now: its top document's URL, its history's length, and whether it's unloaded. */
const tabNow = (space, page) =>
  h.chrome(
    `${TAB} const bc = t.linkedBrowser.browsingContext;
     return { url: bc?.currentWindowGlobal?.documentURI?.spec ?? "", history: bc?.sessionHistory?.count ?? 0, unloaded: !t.linkedPanel || t.hasAttribute("pending") };`,
    { space, page }
  );
/** Is zenius's window creator in? While a task is live (I4). */
const popupGuardOn = () =>
  h.chrome(`return ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/guards.sys.mjs").popupWindowGuardOn();`);
/** The user's Unload Tab, in the background, as Zen's Unload Space does it. */
const userUnloads = async (space, page) => {
  await h.chrome(`${TAB} win.gBrowser.explicitUnloadTabs([t]); return true;`, { space, page });
  await h.until(async () => (await tabNow(space, page)).unloaded, 5000);
};
const loadedAt = (space, page, part) =>
  h.until(async () => {
    const now = await tabNow(space, page).catch(() => null);
    return !!now?.url.includes(part) && (await inPage(space, page, "return document.readyState;").catch(() => "")) === "complete";
  }, 10000);
/** The task's page whose URL has `part`. */
const pageAt = async (space, part) => {
  let found = null;
  await h.until(
    async () =>
      (found = (
        await h.chrome(`return ctx.pages.list(arg).map(p => ({ label: p.label, url: ctx.pages.tabFor(p)?.linkedBrowser.currentURI.spec ?? "" }));`, space)
      ).find(p => p.url.includes(part))),
    10000
  );
  return found.label;
};
/** The user's Resume, as the UI's button does it. */
const resumeByUser = space =>
  h.chrome(
    `const s = ctx.spaces.get(arg); await ctx.service.beforeHandBack(s); ctx.spaces.setOwnership(s, "agent", { source: "user" }); return true;`,
    space
  );
/** Every tab's saved state, in every window and Space, as Zen's session would write it now. */
const savedText = () =>
  h.chrome(
    `${SS} const { allTabs } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     return [...allTabs()].map(t => SessionStore.getTabState(t)).join("\\n");`
  );
const ownershipOf = async space => (await h.call("spaces.list")).taskSpaces.find(s => s.id === space)?.ownership ?? null;
/** The agent's takeOver of a step marked secret: refused until the user's Resume, with no retryAfterMs. */
const refusedAsSecret = e => e.code === "ZEN_TASK_SPACE_USER_IN_CONTROL" && e.data?.secret === true && e.data?.retryAfterMs === undefined;
/** The user's own mark on the step they hold (the UI's toggle). */
const markByUser = (space, on) => h.chrome(`return ctx.service.markSecretByUser(ctx.spaces.get(arg.space), arg.on);`, { space, on });
/** The step's page's mark and held value, as the session keeps them. */
const stepValues = (space, page) =>
  h.chrome(
    `${TAB} const { heldStepOf, secretMarkOf } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/pages.sys.mjs");
     return { mark: secretMarkOf(t), held: heldStepOf(t), step: ctx.service.secretStepOf(ctx.spaces.get(arg.space)) };`,
    { space, page: page ?? "p1" }
  );

test("a restart brings tasks back from their tabs, unloaded; a call loads a page as the agent's own load", async () => {
  const a = await task("restart a", ["/api/text?a1", "/api/text?a2"]);
  // A tab the user opened in the task.
  await h.chrome(
    `const rec = ctx.spaces.get(arg);
     ctx.pages.addUnmanaged(rec, ctx.pages.addTab(rec, win), "user");
     return true;`,
    a.space
  );
  // None of this task's tabs comes back, as if Zen hadn't restored them.
  const gone = await task("restart gone", ["/api/text?g1"]);
  await h.chrome(
    `${SS}
     for (const t of ctx.pages.tabsOf(ctx.spaces.get(arg))) SessionStore.deleteCustomTabValue(t, "zenius");
     return true;`,
    gone.space
  );
  // The user took this page to a browser page.
  const d = await task("restart about", ["/api/text?d1"]);
  await h.chrome(
    `${TAB}
     t.linkedBrowser.fixupAndLoadURIString("about:robots", {
       triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
     });
     const end = Date.now() + 10000;
     while (t.linkedBrowser.currentURI.spec !== "about:robots" && Date.now() < end) {
       await new Promise(r => win.setTimeout(r, 25));
     }
     return true;`,
    { space: d.space, page: d.labels[0] }
  );
  // Zen quit while this page's close waited: its value says closing.
  const e = await task("restart closing", ["/api/text?e1", "/api/text?e2"]);
  await h.chrome(
    `${SS} ${TAB}
     SessionStore.setCustomTabValue(t, "zenius", JSON.stringify({ v: 1, task: arg.space, openedBy: "agent", closing: true, sync: t.id }));
     return true;`,
    { space: e.space, page: e.labels[1] }
  );
  // Nobody has used this one for two hours: the auto-close at start ends it.
  const idle = await task("restart idle", ["/api/text?i1"]);
  await h.chrome(
    `Services.prefs.setIntPref("zenius.autoCloseHours", 1);
     ctx.spaces.get(arg).lastNamedAt = Date.now() - 2 * 3_600_000;
     return true;`,
    idle.space
  );
  const before = await tabsOf(a.space);

  await restart({ "browser.startup.page": 3, "zen.workspaces.continue-where-left-off": false });

  assert.deepEqual(await tabsOf(a.space), before);
  assert.deepEqual(await unloaded(a.space), allUnloadedBut(before), "nothing loads until an agent uses it");
  const t0 = Date.now();
  await assert.rejects(h.call("pages.list", { space: gone.space }), notRestored(gone.space));
  assert.ok(Date.now() - t0 < 1000, "a task that didn't come back fails at once");
  assert.ok(!(await tabsOf(e.space)).some(([label]) => label === e.labels[1]), "the closing tab closed");
  assert.equal(await anyTabAt(url("/api/text?e1")), true);
  assert.equal(await anyTabAt(url("/api/text?e2")), false, "the closing tab closed");
  const ids = await listedIds();
  assert.ok(!ids.includes(idle.space), "the auto-close at start ended the idle task");
  assert.ok(ids.includes(a.space) && ids.includes(d.space));

  // The agent's call loads the page first, as its own load, with the guards.
  const page = { space: a.space, page: a.labels[0] };
  assert.equal(
    await h.call("page.evaluate", { ...page, fn: "location.href", isFunction: false }),
    url("/api/text?a1")
  );
  assert.deepEqual(
    await h.chrome(
      `${TAB}
       const sh = t.linkedBrowser.browsingContext.sessionHistory;
       return { pending: t.hasAttribute("pending"), system: sh.getEntryAtIndex(sh.index).triggeringPrincipal.isSystemPrincipal };`,
      page
    ),
    { pending: false, system: false }
  );
  assert.deepEqual(await guarded(a.space, a.labels[0]), [true]);
  assert.deepEqual(await unloaded(a.space), allUnloadedBut(before, [a.labels[0]]), "only the page the agent used loaded");

  // A page agents can't load stays unloaded, and the call says why.
  const robots = { space: d.space, page: d.labels[0] };
  await assert.rejects(h.call("page.evaluate", { ...robots, fn: "1", isFunction: false }), {
    code: "ZEN_URL_NOT_ALLOWED",
    data: { url: "about:robots", scheme: "about", page: d.labels[0], reason: "unloaded" },
  });
  const dTabs = await unloaded(d.space);
  assert.deepEqual(dTabs, allUnloadedBut(dTabs));
  // page.goto leaves it for a web page.
  await h.call("page.goto", { ...robots, url: url("/api/text?d2") });
  assert.equal(await h.call("page.url", robots), url("/api/text?d2"));
  assert.deepEqual(await unloaded(d.space), allUnloadedBut(dTabs, [d.labels[0]]));

  for (const space of [a.space, d.space, e.space]) {
    await h.remove(space);
  }
});

test("a window on the Agents Space at the quit loads its agent page at start, guarded before any call", async () => {
  const f = await task("restart shown", ["/api/text?f1"]);
  await userViews(f.space, f.labels[0]);

  await restart({ "browser.startup.page": 3, "zen.workspaces.continue-where-left-off": true });

  // The first call after the start: Zen loaded the page itself, and the
  // rebuild guarded its documents before answering.
  assert.deepEqual(
    await h.chrome(
      `${TAB}
       const bc = t.linkedBrowser.browsingContext;
       const docs = bc.getAllBrowsingContextsInSubtree();
       return {
         selected: win.gBrowser.selectedTab === t,
         loaded: !t.hasAttribute("pending"),
         guards: await Promise.all(docs.map(c => ctx.content(c, "guards#installed", {}))),
       };`,
      { space: f.space, page: f.labels[0] }
    ),
    { selected: true, loaded: true, guards: [true] }
  );
  await h.until(async () => (await topURL(f.space, f.labels[0])) === url("/api/text?f1"), 10000);
  assert.deepEqual(await guarded(f.space, f.labels[0]), [true]);
  await h.remove(f.space);
});

test("a closing tab a window shows at the start waits for the user to leave it", async () => {
  const c = await task("restart wait", ["/api/text?c1", "/api/text?c2"]);
  await userViews(c.space, c.labels[1]);
  assert.deepEqual(await h.call("pages.close", { space: c.space, page: c.labels[1] }), { ok: true, deferred: true });

  await restart({ "browser.startup.page": 3, "zen.workspaces.continue-where-left-off": true });

  const waiting = () =>
    h.chrome(
      `const t = win.gBrowser.selectedTab;
       return { waits: ctx.pages.isDeferred(t), url: t.linkedBrowser.currentURI.spec };`
    );
  assert.deepEqual(await waiting(), { waits: true, url: url("/api/text?c2") });
  assert.ok(!(await tabsOf(c.space)).some(([label]) => label === c.labels[1]));
  assert.equal(await anyTabAt(url("/api/text?c2")), true);
  await h.chrome(
    `${TAB} win.gBrowser.selectedTab = t; return true;`,
    { space: c.space, page: c.labels[0] }
  );
  await h.until(async () => !(await anyTabAt(url("/api/text?c2"))));
  await userGoesHome();
  await h.remove(c.space);
});

test("after a crash, tasks come back the same way", async () => {
  const g = await task("restart crash", ["/api/text?k1", "/api/text?k2"]);
  const before = await tabsOf(g.space);

  // The dev profile's startup.page is 0: only the crash restore brings tabs back.
  await crash(
    {
      "browser.sessionstore.resume_from_crash": true,
      "browser.startup.page": 0,
      "zen.workspaces.continue-where-left-off": false,
    },
    [url("/api/text?k1"), url("/api/text?k2")]
  );

  assert.deepEqual(await tabsOf(g.space), before);
  assert.deepEqual(await unloaded(g.space), allUnloadedBut(before));
  assert.equal(
    await h.call("page.evaluate", { space: g.space, page: g.labels[1], fn: "location.href", isFunction: false }),
    url("/api/text?k2")
  );
  await h.remove(g.space);
});

test("a hand-off with secret: after a quit during the user's step, the hand back blanks the step's tab, unloaded since, and its popup, viewed again with the text the session put back", async () => {
  const space = await h.space("restart secret quit");
  const token = `${stepBase}/?r=r1-token&nostore`;
  const popURL = `${stepBase}/?r=r1-pop`;
  // The page's own window.open opens the popup, and in the background, as in handoff.test.mjs.
  await h.chrome(
    `Services.prefs.setBoolPref("dom.disable_open_during_load", false);
     Services.prefs.setBoolPref("browser.tabs.loadDivertedInBackground", true);
     return true;`
  );
  try {
    await h.call("page.goto", { space, page: "p1", url: `${stepBase}/?r=r1` });
    await h.call("spaces.handOff", { space, secret: true });
    // The user's step: the token's page in place, then the site's popup, where they type.
    await userLoads(space, "p1", token);
    await loadedAt(space, "p1", "r1-token");
    assert.equal(await inPage(space, "p1", `return String(!!window.open(${JSON.stringify(popURL)}));`), "true");
    const pop = await pageAt(space, "r1-pop");
    await loadedAt(space, pop, "r1-pop");
    await inPage(
      space,
      pop,
      `const f = document.querySelector("input[name=nickname]"); f.value = "typed-r1-secret"; f.dispatchEvent(new Event("input", { bubbles: true })); return 1;`
    );
    await saveSession([token, popURL]);
    const tokenLoads = steps.hits.get("/?r=r1-token&nostore");

    await restart({ "browser.startup.page": 3, "zen.workspaces.continue-where-left-off": false });

    assert.equal(await ownershipOf(space), "agentDelegatedToUser", "still the user's after the restart");
    assert.equal((await tabNow(space, "p1")).unloaded, true, "the step's tab is unloaded since the start");
    // The user views the popup again: it loads from its URL, and the session puts their text back.
    await userViews(space, pop);
    await h.until(
      async () => (await inPage(space, pop, `return document.querySelector("input[name=nickname]")?.value ?? "";`).catch(() => "")) === "typed-r1-secret",
      10000
    );
    await userGoesHome();
    // The step stays the user's past the restart: only their Resume gives it back.
    await assert.rejects(h.call("spaces.takeOver", { space }), refusedAsSecret);
    await resumeByUser(space);
    const back = await h.call("spaces.takeOver", { space });
    assert.deepEqual([...(back.blanked ?? [])].sort(), ["p1", pop].sort());
    for (const page of ["p1", pop]) {
      const now = await tabNow(space, page);
      assert.deepEqual([now.url, now.history], ["about:blank", 1], `${page}: blank, with no history`);
    }
    assert.equal(steps.hits.get("/?r=r1-token&nostore"), tokenLoads, "the step's saved page never loaded again");
    const saved = await savedText();
    assert.ok(!saved.includes("r1-token") && !saved.includes("typed-r1-secret"), "no tab's saved state has the step's page or the user's text");
  } finally {
    // On disk too: the next test's crash would bring the quit's saved values back.
    await h
      .chrome(
        `Services.prefs.clearUserPref("dom.disable_open_during_load");
         Services.prefs.clearUserPref("browser.tabs.loadDivertedInBackground");
         Services.prefs.savePrefFile(null);
         return true;`
      )
      .catch(() => {});
    await h.remove(space).catch(() => {});
  }
});

test("a hand-off with secret: after a crash during the user's step, the hand back blanks the step's tab the same way", async () => {
  const space = await h.space("restart secret crash");
  const token = `${stepBase}/?r=r2-token&nostore`;
  try {
    await h.call("page.goto", { space, page: "p1", url: `${stepBase}/?r=r2` });
    await h.call("spaces.handOff", { space, secret: true });
    await userLoads(space, "p1", token);
    await loadedAt(space, "p1", "r2-token");
    // Zen's periodic save has the step's page, and the crash comes before the hand back.
    await crash({ "browser.sessionstore.resume_from_crash": true, "browser.startup.page": 0, "zen.workspaces.continue-where-left-off": false }, [token]);
    assert.equal(await ownershipOf(space), "agentDelegatedToUser");
    await assert.rejects(h.call("spaces.takeOver", { space }), refusedAsSecret);
    await resumeByUser(space);
    const back = await h.call("spaces.takeOver", { space });
    assert.deepEqual(back.blanked, ["p1"]);
    const now = await tabNow(space, "p1");
    assert.deepEqual([now.url, now.history], ["about:blank", 1]);
  } finally {
    await h.remove(space).catch(() => {});
  }
});

test("the user's own mark keeps whose it is through a quit, and a hold begun before the quit keeps the sites its step loaded, for a mark made after it", async () => {
  const marked = await h.space("restart user secret before");
  const later = await h.space("restart user secret after");
  const tokenA = `${stepBase}/?r=u1-token&nostore`;
  const tokenB = `${stepBase}/?r=u2-token&nostore`;
  const stepSite = new URL(stepBase).hostname;
  try {
    for (const [space, r] of [[marked, "u1"], [later, "u2"]]) {
      await h.call("page.goto", { space, page: "p1", url: `${stepBase}/?r=${r}` });
      await h.call("spaces.handOff", { space });
    }
    await userLoads(marked, "p1", tokenA);
    await loadedAt(marked, "p1", "u1-token");
    await userLoads(later, "p1", tokenB);
    await loadedAt(later, "p1", "u2-token");
    assert.equal((await markByUser(marked, true)).secretBy, "user");
    const heldBefore = await stepValues(later);
    assert.ok(heldBefore.held?.sites.includes(stepSite), `the held value noted the step's site: ${JSON.stringify(heldBefore)}`);
    assert.equal(heldBefore.mark, null);
    await saveSession([tokenA, tokenB]);

    await restart({ "browser.startup.page": 3, "zen.workspaces.continue-where-left-off": false });

    assert.deepEqual((await stepValues(marked)).step, { secret: true, secretBy: "user" }, "whose mark it is came through the quit");
    await assert.rejects(h.call("spaces.takeOver", { space: marked }), refusedAsSecret);
    const kept = await stepValues(later);
    assert.deepEqual([kept.step, kept.held?.sites.includes(stepSite)], [{ secret: false, secretBy: null }, true], JSON.stringify(kept));
    // The mark after the quit finds the step's tab by its held value, with the site it loaded before.
    assert.deepEqual(await markByUser(later, true), { ok: true, secret: true, secretBy: "user" });
    const now = await stepValues(later);
    assert.ok(now.mark?.sites.includes(stepSite) && now.mark.by === "user", JSON.stringify(now));
    await userGoesHome();
    for (const space of [marked, later]) {
      await resumeByUser(space);
      const tab = await tabNow(space, "p1");
      assert.deepEqual([tab.url, tab.history], ["about:blank", 1], `task ${space}: blank, with no history`);
      assert.deepEqual((await h.call("spaces.takeOver", { space })).blanked, ["p1"]);
    }
    assert.equal((await stepValues(later)).held, null, "the held value went with the hold");
  } finally {
    await h.remove(marked).catch(() => {});
    await h.remove(later).catch(() => {});
  }
});

/** Whether a fetch only the HTTP cache can answer, from the task's page p1 on the steps' site, gets the step page `r` back (its query `extra` too). */
const cachedStep = (space, r, extra = "") =>
  h.call("page.fetch", { space, page: "p1", url: `${stepBase}/?r=${r}${extra}`, options: { cache: "only-if-cached", mode: "same-origin" } }).then(
    res => String(res.body ?? "").includes(`<title>${r}</title>`),
    () => false
  );
/**
 * Does the HTTP cache hold the body of an entry whose address has `part`,
 * in any storage or partition? (A step's subresource from another site,
 * which no task's page can read the same way.) A load with INHIBIT_CACHING
 * leaves an entry with no data, which caches nothing.
 */
const inHttpCache = part =>
  h.chrome(
    `return await new Promise(resolve => {
       let found = false;
       let timer = null;
       Services.cache2.asyncVisitAllStorages({
         onCacheStorageInfo() {},
         onCacheEntryInfo(uri, idEnhance, dataSize) { if (uri.spec.includes(arg) && dataSize > 0) found = true; },
         // Once per storage visited: the last one settles it.
         onCacheEntryVisitCompleted() { win.clearTimeout(timer); timer = win.setTimeout(() => resolve(found), 300); },
         QueryInterface: ChromeUtils.generateQI(["nsICacheStorageVisitor"]),
       }, true);
     });`,
    part
  );
/** The page's first script's note (FIRST_SCRIPT), from its document now. */
const firstView = (space, page) => inPage(space, page, "return JSON.parse(JSON.stringify(window.__first ?? null));");
/** The guard actor's own answer for the page's top document. */
const guardsIn = (space, page) => h.chrome(`${TAB} return ctx.content(t.linkedBrowser.browsingContext, "guards#installed", {});`, { space, page });
/**
 * Waits until the shown page takes a person's input: a chrome step after TAB
 * that defines `browser`, whose content side is arg.untilTakesInput. Gecko
 * ignores the user's input aimed at a document until the document has had
 * dom.input_events.security.minNumTicks refresh ticks and
 * minTimeElapsedInMS since it began loading, against clickjacking. zenius's
 * own events are exempt, but the user's below are OS-like, so a click sent
 * sooner is lost, as a person's would be. One that came right after the
 * agent's first call loaded the page again (the settle's page.goto) landed
 * there on a fast machine, and load widens the window. A person would click
 * again; the test waits instead, so that every click it sends must take.
 */
const UNTIL_TAKES_INPUT = `await ctx.content(browser.browsingContext, "dev#evalContent", { privileged: true, code: arg.untilTakesInput,
       arg: { ticks: Services.prefs.getIntPref("dom.input_events.security.minNumTicks", 0),
              ms: Services.prefs.getIntPref("dom.input_events.security.minTimeElapsedInMS", 0) } });`;
// Privileged, so that its callbacks are no code left in the page.
const TAKES_INPUT_CODE = `const win = actor.contentWindow;
  const t = win.performance.timing;
  // When the document began loading, on the clock performance.now() reads.
  const loading = t.domLoading ? t.domLoading - t.navigationStart : 0;
  for (let i = 0; i <= arg.ticks; i++) {
    await new Promise(resolve => win.requestAnimationFrame(() => resolve()));
  }
  for (let left; (left = loading + arg.ms + 20 - win.performance.now()) > 0; ) {
    await new Promise(resolve => win.setTimeout(resolve, Math.ceil(left)));
  }
  return true;`;
/**
 * The user's click on `selector` in the shown page, and their keys, entering
 * through the parent like OS input, as the input suite's harness plays them
 * (tests/input/harness.mjs).
 */
const userClicks = (space, page, selector) =>
  h.chrome(
    `${TAB} const browser = t.linkedBrowser;
     if (win.gBrowser.selectedBrowser !== browser) throw new Error("the page isn't shown");
     ${UNTIL_TAKES_INPUT}
     const p = await ctx.content(browser.browsingContext, "dev#evalContent", { privileged: false,
       code: "const r = document.querySelector(" + JSON.stringify(arg.selector) + ").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };" });
     const r = browser.getBoundingClientRect();
     for (const type of ["mousedown", "mouseup"]) {
       win.synthesizeMouseEvent(type, r.x + p.x, r.y + p.y, { button: 0, buttons: type === "mousedown" ? 1 : 0, clickCount: 1 }, { isDOMEventSynthesized: false });
     }
     return true;`,
    { space, page, selector, untilTakesInput: TAKES_INPUT_CODE }
  );
const userPresses = (space, page, keys) =>
  h.chrome(
    `${TAB} const browser = t.linkedBrowser;
     if (win.gBrowser.selectedBrowser !== browser) throw new Error("the page isn't shown");
     ${UNTIL_TAKES_INPUT}
     browser.focus();
     const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
     if (!tip.beginInputTransactionForTests(win)) throw new Error("no input transaction");
     for (const key of arg.keys) {
       const ev = new win.KeyboardEvent("", { key });
       tip.keydown(ev);
       tip.keyup(ev);
     }
     return true;`,
    { space, page, keys: [...keys], untilTakesInput: TAKES_INPUT_CODE }
  );
/**
 * Keep a page's tab for after it leaves its task (stash), then read it:
 * whether it's open, its top document, its field's value and whose it is
 * (stashed); close what's kept (unstash).
 */
const stash = (space, page, key) => h.chrome(`${TAB} win.__zrTabs ??= {}; win.__zrTabs[arg.key] = t; return true;`, { space, page, key });
const stashed = key =>
  h.chrome(
    `const t = win.__zrTabs[arg];
     const bc = t.linkedBrowser.browsingContext;
     const value = await ctx.content(bc, "dev#evalContent", { code: "return document.querySelector('input[name=nickname]')?.value ?? null;", privileged: false }).catch(() => null);
     return { open: t.isConnected && !t.closing, doc: bc?.currentWindowGlobal?.innerWindowId ?? null, value, task: ctx.pages.forTab(t)?.spaceId ?? null };`,
    key
  );
const unstash = () =>
  h.chrome(
    `const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
     for (const t of Object.values(win.__zrTabs ?? {})) {
       if (t.isConnected && !t.closing && !ctx.pages.forTab(t)) win.gBrowser.removeTab(t, { animate: false, skipPermitUnload: true });
     }
     delete win.__zrTabs;
     // A takeover prompt the user's input opened in the agent's tab.
     for (const rec of ctx.spaces.records()) UI?.takeover?.resolve(rec.id, "cancel");
     return true;`
  );
/** The call's failure as the agent gets it, or a failed test if it succeeds. */
const refusalOf = (method, params) =>
  h.call(method, params).then(
    r => assert.fail(`${method} succeeded: ${JSON.stringify(r)}`),
    e => ({ code: e.code, message: e.message, data: e.data ?? {} })
  );
/** A task whose page p1 shows `r` at the quit, shown by the window, with Zen started again; its document Zen's own load from before zenius started. */
async function shownAtStart(name, r, { before = async () => {} } = {}) {
  const space = await h.space(name);
  await h.call("page.goto", { space, page: "p1", url: `${stepBase}/?r=${r}` });
  await before(space);
  await userViews(space, "p1");
  await restart({ "browser.startup.page": 3, "zen.workspaces.continue-where-left-off": true });
  // From the HTTP cache, which kept the agent's page.
  await loadedAt(space, "p1", `r=${r}`);
  assert.notDeepEqual(await firstView(space, "p1"), GUARDED_FIRST, "the premise: Zen loaded it before zenius started, so its first script had no guard");
  return space;
}
/** The agent's first call on a page the user touched since the start: the page left the task as theirs, saying why. */
function assertTheirs(refused, why) {
  assert.equal(refused.code, "ZEN_PAGE_NOT_FOUND", refused.message);
  assert.deepEqual({ page: refused.data.page, reason: refused.data.reason, why: refused.data.why }, { page: "p1", reason: "theirs", why });
}

test("a hand-off with secret: after a quit, the step's tab that comes back unloaded writes nothing to the HTTP cache when the user views it, before their Resume", async () => {
  const space = await h.space("restart secret cache unloaded");
  const reader = await h.space("restart secret cache unloaded reader");
  try {
    await h.call("page.goto", { space, page: "p1", url: `${stepBase}/?r=r6` });
    // Another task's page on the steps' site, which reads what its cache has.
    await h.call("page.goto", { space: reader, page: "p1", url: `${stepBase}/?r=r6-reader` });
    await h.call("spaces.handOff", { space, secret: true });
    // The user's step: a cacheable page, loaded only while the step is marked.
    await userLoads(space, "p1", `${stepBase}/?r=r6-step`);
    await loadedAt(space, "p1", "r6-step");
    assert.equal(await cachedStep(reader, "r6-step"), false, "the premise: nothing of the step's page is cached before the quit");
    const loads = steps.hits.get("/?r=r6-step");

    await restart({ "browser.startup.page": 3, "zen.workspaces.continue-where-left-off": false });

    assert.equal(await ownershipOf(space), "agentDelegatedToUser", "still the user's after the restart");
    assert.equal((await tabNow(space, "p1")).unloaded, true, "the step's tab is unloaded since the start");
    // The user views it: it loads from the server...
    await userViews(space, "p1");
    await h.until(async () => steps.hits.get("/?r=r6-step") > loads, 10000);
    await loadedAt(space, "p1", "r6-step");
    // ...with the guards from its first script...
    assert.deepEqual(await firstView(space, "p1"), GUARDED_FIRST, "its first script had the guards");
    assert.equal(await guardsIn(space, "p1"), true);
    // ...and keeps none of it in the cache, where the other task could read it.
    assert.equal(await cachedStep(reader, "r6-step"), false, "the load after the restart was cached");
    await userGoesHome();
    await resumeByUser(space);
  } finally {
    await h.remove(space).catch(() => {});
    await h.remove(reader).catch(() => {});
  }
});

test("a hand-off with secret: after a quit with the step's tab shown, what the load Zen makes of it at the start cached is gone once zenius is up, a site no mark of the step names included, before the user's Resume", async () => {
  const space = await h.space("restart secret cache");
  const reader = await h.space("restart secret cache reader");
  try {
    await h.call("page.goto", { space, page: "p1", url: `${stepBase}/?r=r5` });
    // Another task's page on the steps' site, which reads what its cache has.
    await h.call("page.goto", { space: reader, page: "p1", url: `${stepBase}/?r=r5-reader` });
    await h.call("spaces.handOff", { space, secret: true });
    // The user's step: a cacheable page, loaded only while the step is marked,
    // with a subresource from another site.
    await userLoads(space, "p1", `${stepBase}/?r=r5-step&sub`);
    await loadedAt(space, "p1", "r5-step");
    assert.equal(await cachedStep(reader, "r5-step", "&sub"), false, "the premise: nothing of the step's page is cached before the quit");
    assert.equal(await inHttpCache("r5-step-sub"), false, "the premise: nor of its subresource");
    // Shown at the quit, so Zen loads it itself as it starts.
    await userViews(space, "p1");
    const loads = steps.hits.get("/?r=r5-step&sub");
    const subLoads = steps.hits.get("/?r=r5-step-sub") ?? 0;

    await restart({ "browser.startup.page": 3, "zen.workspaces.continue-where-left-off": true });

    assert.equal(await ownershipOf(space), "agentDelegatedToUser", "still the user's after the restart");
    // Zen asked the server for it at the start, as the window's shown tab,
    // before zenius started, so it cached what it got...
    await h.until(async () => steps.hits.get("/?r=r5-step&sub") > loads && (steps.hits.get("/?r=r5-step-sub") ?? 0) > subLoads, 10000);
    assert.deepEqual(
      await h.chrome(`${TAB} return { selected: win.gBrowser.selectedTab === t, loaded: !t.hasAttribute("pending") };`, { space, page: "p1" }),
      { selected: true, loaded: true }
    );
    // ...which every site's clear takes once zenius is up and that load is
    // done: nothing stays where the other task could read it.
    await h.until(async () => !(await cachedStep(reader, "r5-step", "&sub")) && !(await inHttpCache("r5-step-sub")), 15000).catch(() => {});
    assert.equal(await cachedStep(reader, "r5-step", "&sub"), false, "the load at the start stayed cached");
    assert.equal(await inHttpCache("r5-step-sub"), false, "its subresource from another site stayed cached");
    await userGoesHome();
    await resumeByUser(space);
    // The blank replaced the document from before the start: the agent's
    // next call goes on, on the task's page.
    assert.equal(await h.call("page.url", { space, page: "p1" }), "about:blank");
  } finally {
    await h.remove(space).catch(() => {});
    await h.remove(reader).catch(() => {});
  }
});

test("an agent's tab shown at the quit that the user typed in before the agent's first call: the page leaves the task as theirs, with their text and the document as they were", async () => {
  let space = null;
  try {
    space = await shownAtStart("restart before start typed", "t1");
    await stash(space, "p1", "t1");
    const { doc } = await stashed("t1");
    await userClicks(space, "p1", "input[name=nickname]");
    await userPresses(space, "p1", "mine");
    await h.until(async () => (await stashed("t1")).value === "mine", 10000);
    const hits = steps.hits.get("/?r=t1");
    // A reading call, which a takeover prompt the typing opened doesn't hold.
    assertTheirs(await refusalOf("page.snapshot", { space, page: "p1" }), "typed");
    assert.deepEqual(await stashed("t1"), { open: true, doc, value: "mine", task: null }, "the user's tab, as they left it");
    assert.equal(steps.hits.get("/?r=t1"), hits, "nothing loaded it again");
    // Its label named it only.
    assert.match((await refusalOf("page.url", { space, page: "p1" })).message, /page p1 was released/);
  } finally {
    await userGoesHome().catch(() => {});
    await unstash().catch(() => {});
    if (space) {
      await h.remove(space).catch(() => {});
    }
  }
});

test("an agent's tab shown at the quit with text the session put back: the agent's first call finds it the user's, though no one typed since", async () => {
  let space = null;
  try {
    space = await shownAtStart("restart before start restored", "t2", {
      before: s => h.call("page.fill", { space: s, page: "p1", target: "input[name=nickname]", value: "from before" }),
    });
    await stash(space, "p1", "t2");
    assert.equal((await stashed("t2")).value, "from before", "the premise: the session put the text back");
    const { doc } = await stashed("t2");
    assertTheirs(await refusalOf("page.screenshot", { space, page: "p1" }), "typed");
    assert.deepEqual(await stashed("t2"), { open: true, doc, value: "from before", task: null });
  } finally {
    await userGoesHome().catch(() => {});
    await unstash().catch(() => {});
    if (space) {
      await h.remove(space).catch(() => {});
    }
  }
});

test("an agent's tab shown at the quit that the user clicked in, or went elsewhere in, before the agent's first call: theirs, either way", async () => {
  let space = null;
  try {
    space = await shownAtStart("restart before start clicked", "t3");
    await stash(space, "p1", "t3");
    // A click on the page itself, no field.
    await userClicks(space, "p1", "body");
    assertTheirs(await refusalOf("page.title", { space, page: "p1" }), "clicked");
    assert.equal((await stashed("t3")).task, null);
    await unstash();
    await h.remove(space);

    space = await shownAtStart("restart before start navigated", "t3n");
    await stash(space, "p1", "t3n");
    await userLoads(space, "p1", `${stepBase}/?r=t3n-elsewhere`);
    await loadedAt(space, "p1", "t3n-elsewhere");
    assertTheirs(await refusalOf("page.url", { space, page: "p1" }), "navigated");
    assert.equal((await stashed("t3n")).task, null);
  } finally {
    await userGoesHome().catch(() => {});
    await unstash().catch(() => {});
    if (space) {
      await h.remove(space).catch(() => {});
    }
  }
});

test("an agent's tab shown at the quit, untouched: the agent's first call loads it again first, and acts in a document guarded from its first script", async () => {
  let space = null;
  try {
    space = await shownAtStart("restart before start untouched", "t4");
    const before = await h.chrome(`${TAB} return t.linkedBrowser.browsingContext.currentWindowGlobal.innerWindowId;`, { space, page: "p1" });
    const hits = steps.hits.get("/?r=t4");
    const title = await h.call("page.title", { space, page: "p1" });
    assert.equal(title?.title ?? title, "t4");
    assert.equal(steps.hits.get("/?r=t4"), hits + 1, "loaded again, once");
    const after = await h.chrome(`${TAB} return t.linkedBrowser.browsingContext.currentWindowGlobal.innerWindowId;`, { space, page: "p1" });
    assert.notEqual(after, before, "another document");
    assert.deepEqual(await firstView(space, "p1"), GUARDED_FIRST, "the document the call acted in had the guards from its first script");
    assert.equal(await guardsIn(space, "p1"), true);
    // The next call goes straight on.
    await h.call("page.url", { space, page: "p1" });
    assert.equal(steps.hits.get("/?r=t4"), hits + 1);
  } finally {
    await userGoesHome().catch(() => {});
    if (space) {
      await h.remove(space).catch(() => {});
    }
  }
});

test("an agent's tab shown at the quit, untouched: the agent's page.goto as its first call goes, its new document guarded from its first script", async () => {
  let space = null;
  try {
    space = await shownAtStart("restart before start goto", "t5");
    await h.call("page.goto", { space, page: "p1", url: `${stepBase}/?r=t5-next` });
    assert.deepEqual(await firstView(space, "p1"), GUARDED_FIRST);
    assert.equal(await guardsIn(space, "p1"), true);
    assert.equal(steps.hits.get("/?r=t5") > 0 && (await tabNow(space, "p1")).url.includes("t5-next"), true);
  } finally {
    await userGoesHome().catch(() => {});
    if (space) {
      await h.remove(space).catch(() => {});
    }
  }
});

test("an agent's tab shown at the quit whose frame from another site the user typed in: theirs", async () => {
  let space = null;
  try {
    space = await shownAtStart("restart before start frame", "t6&frame");
    await stash(space, "p1", "t6");
    const frame = `${TAB} const f = t.linkedBrowser.browsingContext.children[0];`;
    await h.until(async () => (await h.chrome(`${frame} return !!f?.currentWindowGlobal?.documentURI?.spec.includes("t6-frame");`, { space, page: "p1" })), 10000);
    // Its field takes the keyboard (headless Zen hands a click into another process's frame to no field), then the user's keys.
    await h.chrome(`${frame} await ctx.content(f, "dev#evalContent", { code: "document.querySelector('input').focus(); return true;", privileged: false }); return true;`, { space, page: "p1" });
    await h.until(async () => (await h.chrome(`${frame} return Services.focus.focusedContentBrowsingContext === f;`, { space, page: "p1" })), 5000);
    await userPresses(space, "p1", "fx");
    await h.until(async () => (await h.chrome(`${frame} return await ctx.content(f, "dev#evalContent", { code: "return document.querySelector('input').value;", privileged: false });`, { space, page: "p1" })) === "fx", 10000);
    assertTheirs(await refusalOf("page.title", { space, page: "p1" }), "typed");
    assert.equal((await stashed("t6")).task, null);
  } finally {
    await userGoesHome().catch(() => {});
    await unstash().catch(() => {});
    if (space) {
      await h.remove(space).catch(() => {});
    }
  }
});

test("an agent's tab shown at the quit, untouched, that the agent hands off as its first call: the user's step is in a document guarded from its first script", async () => {
  let space = null;
  try {
    space = await shownAtStart("restart before start handoff", "t8");
    const hits = steps.hits.get("/?r=t8");
    await h.call("spaces.handOff", { space });
    assert.equal(steps.hits.get("/?r=t8"), hits + 1, "loaded again before the hold");
    assert.deepEqual(await firstView(space, "p1"), GUARDED_FIRST);
    // The user works in it, then hands it back: it's the agent's again, as they left it.
    await userClicks(space, "p1", "input[name=nickname]");
    await userPresses(space, "p1", "ok");
    await h.until(async () => (await inPage(space, "p1", "return document.querySelector('input').value;")) === "ok", 10000);
    await userGoesHome();
    await resumeByUser(space);
    const value = await h.call("page.evaluate", { space, page: "p1", fn: "document.querySelector('input').value", isFunction: false });
    assert.equal(value?.result ?? value, "ok", "the agent has the page the user handed back");
  } finally {
    await userGoesHome().catch(() => {});
    if (space) {
      await h.remove(space).catch(() => {});
    }
  }
});

test("an agent's tab shown at the quit that the user typed in, when the agent's finish would close it: it stays open, the user's, with their text", async () => {
  let space = null;
  try {
    space = await shownAtStart("restart before start finish", "t9");
    await stash(space, "p1", "t9");
    await userClicks(space, "p1", "input[name=nickname]");
    await userPresses(space, "p1", "keep");
    await h.until(async () => (await stashed("t9")).value === "keep", 10000);
    await userGoesHome();
    // Resolve the takeover prompt the typing opened: the user lets the agent go on.
    await h.chrome(`ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI?.takeover?.resolve(arg, "continue"); return true;`, space);
    await h.call("spaces.finish", { space, keep: [] });
    assert.deepEqual({ ...(await stashed("t9")), doc: null }, { open: true, doc: null, value: "keep", task: null }, "the user's tab stays, with their text");
    // The task ended as a finish ends one, though the check made it wait:
    // with no task live, the window creator is the app's again.
    await h.until(async () => !(await popupGuardOn()), 5000);
  } finally {
    await userGoesHome().catch(() => {});
    await unstash().catch(() => {});
    if (space) {
      await h.remove(space).catch(() => {});
    }
  }
});

test("an agent's tab shown at the quit that the user unloads and views again before the agent's first call: the call goes on, in the document guarded from its first script", async () => {
  let space = null;
  try {
    space = await shownAtStart("restart before start unloaded", "t10");
    await userGoesHome();
    await userUnloads(space, "p1");
    await userViews(space, "p1");
    await loadedAt(space, "p1", "r=t10");
    assert.deepEqual(await firstView(space, "p1"), GUARDED_FIRST, "the document that came back had the guards from its first script");
    await userGoesHome();
    const hits = steps.hits.get("/?r=t10");
    assert.equal(await h.call("page.title", { space, page: "p1" }), "t10", "still the task's page");
    assert.equal(steps.hits.get("/?r=t10"), hits, "not loaded again");
  } finally {
    await userGoesHome().catch(() => {});
    if (space) {
      await h.remove(space).catch(() => {});
    }
  }
});

test("an agent's tab shown at the quit that is an editor in designMode: the agent's first call finds it the user's, as the session put its body back", async () => {
  let space = null;
  try {
    space = await shownAtStart("restart before start design", "t11&design");
    assert.equal(await inPage(space, "p1", "return document.designMode;"), "on", "the premise: an editor");
    assertTheirs(await refusalOf("page.title", { space, page: "p1" }), "typed");
  } finally {
    await userGoesHome().catch(() => {});
    await unstash().catch(() => {});
    if (space) {
      await h.remove(space).catch(() => {});
    }
  }
});

test("a hand-off whose step's tab a window showed at the quit: the user's own load in it during the step, then their Resume, gives the agent the page they left", async () => {
  const space = await h.space("restart before start held");
  try {
    await h.call("page.goto", { space, page: "p1", url: `${stepBase}/?r=t12` });
    await h.call("spaces.handOff", { space });
    await userViews(space, "p1");
    await restart({ "browser.startup.page": 3, "zen.workspaces.continue-where-left-off": true });
    await loadedAt(space, "p1", "r=t12");
    assert.notDeepEqual(await firstView(space, "p1"), GUARDED_FIRST, "the premise: Zen loaded it before zenius started");
    assert.equal(await ownershipOf(space), "agentDelegatedToUser", "still the user's step");
    // The step goes on: the user loads the next page in it, and resumes
    // from there, viewing it.
    await userLoads(space, "p1", `${stepBase}/?r=t12-next`);
    await loadedAt(space, "p1", "r=t12-next");
    await resumeByUser(space);
    assert.equal(await h.call("page.url", { space, page: "p1" }), `${stepBase}/?r=t12-next`, "the agent has the page the user left");
  } finally {
    await userGoesHome().catch(() => {});
    await h.remove(space).catch(() => {});
  }
});

test("after a quit, an agent's tab that comes back unloaded and that the user views: guarded from its first script, before any call of the agent's", async () => {
  const space = await h.space("restart unloaded viewed");
  try {
    await h.call("page.goto", { space, page: "p1", url: `${stepBase}/?r=t7` });
    await userGoesHome();
    await restart({ "browser.startup.page": 3, "zen.workspaces.continue-where-left-off": false });
    assert.equal((await tabNow(space, "p1")).unloaded, true, "unloaded since the start");
    await userViews(space, "p1");
    await loadedAt(space, "p1", "r=t7");
    assert.deepEqual(await firstView(space, "p1"), GUARDED_FIRST, "its first script had the guards");
    assert.equal(await guardsIn(space, "p1"), true);
    await userGoesHome();
    await h.call("page.title", { space, page: "p1" });
  } finally {
    await userGoesHome().catch(() => {});
    await h.remove(space).catch(() => {});
  }
});

test("a hand-off with secret: the hand back saves the session at once, so a crash right after brings none of the step's pages back", async () => {
  const space = await h.space("restart secret after");
  const token = `${stepBase}/?r=r3-token&nostore`;
  // No periodic save meanwhile: only the hand back's own can take the step's page out of the file.
  await h.chrome(`Services.prefs.setIntPref("browser.sessionstore.interval", 600000); return true;`);
  try {
    await h.call("page.goto", { space, page: "p1", url: `${stepBase}/?r=r3` });
    await h.call("spaces.handOff", { space, secret: true });
    await userLoads(space, "p1", token);
    await loadedAt(space, "p1", "r3-token");
    await saveSession([token]);
    await resumeByUser(space);
    // Zen's own file, which a crash restores, drops the step's page: its write follows the save's at once.
    await h.chrome(
      `const file = PathUtils.join(PathUtils.profileDir, "zen-sessions.jsonlz4");
       for (const end = Date.now() + 5000; ; ) {
         let text = "";
         try {
           text = JSON.stringify(await IOUtils.readJSON(file, { decompress: true }));
         } catch {}
         if (text && !text.includes(arg)) return true;
         if (Date.now() > end) throw new Error("Zen's session file still has the step's page 5 s after the hand back");
         await new Promise(r => win.setTimeout(r, 50));
       }`,
      "r3-token"
    );
    await killAndStart({ "browser.sessionstore.resume_from_crash": true, "browser.startup.page": 0, "zen.workspaces.continue-where-left-off": false });
    assert.ok(!(await savedText()).includes("r3-token"), "no tab came back with the step's page in its history");
  } finally {
    await h.chrome(`Services.prefs.clearUserPref("browser.sessionstore.interval"); Services.prefs.savePrefFile(null); return true;`).catch(() => {});
    await h.remove(space).catch(() => {});
  }
});

test("a reply after a restart takes up nothing of a task finished before it: the scope is one Zen session", async () => {
  // A Work chat's id, in the form the sidebar gives it (ZENIUS_SIDEBAR_TASK).
  const chat = "5e1f0c3a-7b2d-4c19-9a8e-2f6d4b1c0a03";
  const task = await h.call("spaces.create", { name: h.unique("restart finish reply"), source: { agent: "zen-core test", sidebar: chat } });
  const kept = url("/zoo/forms.html?finish-reply");
  try {
    await h.call("page.goto", { space: task.id, page: "p1", url: kept });
    await h.call("spaces.finish", { space: task.id, keep: ["p1"] });
    assert.deepEqual(await h.chrome(`return await ctx.service.keptPagesOf(arg);`, task.id), [{ page: "p1", why: null }], "kept, and the chat could take it up now");
    await saveSession([kept]);

    await restart({ "browser.startup.page": 3, "zen.workspaces.continue-where-left-off": false });

    assert.equal(await h.chrome(`return await ctx.service.keptPagesOf(arg);`, task.id), null, "no kept pages after the restart");
    assert.equal(
      await h.chrome(`return await ctx.service.resumeFinishedTask(arg.space, { sidebar: arg.chat });`, { space: task.id, chat }),
      null,
      "the chat's reply starts a new task"
    );
    assert.equal(await anyTabAt(kept), true, "the kept tab is still open, the user's");
  } finally {
    await h.remove(task.id).catch(() => {});
  }
});

test("a start that restores no tabs ends every task, and the empty Agents Space goes", async () => {
  const one = await task("restart none 1", ["/api/text?n1"]);
  const two = await task("restart none 2", ["/api/text?n2"]);

  await restart({
    "browser.startup.page": 0,
    "browser.sessionstore.resume_from_crash": false,
    "zen.workspaces.continue-where-left-off": false,
  });

  for (const space of [one.space, two.space]) {
    await assert.rejects(h.call("pages.list", { space }), notRestored(space));
  }
  // By zenius's mark: a Space the user named Agents isn't zenius's.
  assert.deepEqual(
    await h.chrome(
      `const uuid = ctx.spaces.agentsSpace.uuid;
       return { uuid, zen: win.gZenWorkspaces.getWorkspaces().some(ws => ws.zenius === "agents-space") };`
    ),
    { uuid: null, zen: false }
  );
});

/** Remove what earlier tests left that counts as agent work at a start. */
async function removeAgentWork() {
  const work = await h.chrome(
    `return ctx.spaces.records().filter(r => !r.gone && (r.kind === "task" || r.ownership !== "user")).map(r => r.id);`
  );
  for (const space of work) {
    await h.remove(space);
  }
}

// A kill or a crash before Zen's own file has caught up brings back its
// Space list from before (SPI, "The Agents Space's mark"). These kill Zen
// with its session saves stubbed out, as if within the 1.5 s between
// zenius's save and Zen's write, or before Zen's own save for an idle user.
// Zen restores its Space list from its own file whether or not it restores
// tabs: without the crashed session's tabs, a Space comes back empty.
const KILL_PREFS = {
  "browser.sessionstore.resume_from_crash": true,
  "browser.sessionstore.max_resumed_crashes": 99,
  "browser.startup.page": 0,
  "zen.workspaces.continue-where-left-off": false,
};
const KILL_PREFS_NO_TABS = { ...KILL_PREFS, "browser.sessionstore.resume_from_crash": false };
// A save that runDelayed armed before the stub still runs: its timer calls
// SessionSaver's private save, which writes Zen's file without the Space. On
// a loaded machine the kill can come after it (15 s after the last save), so
// the stub cancels it too.
const stubSessionSaves = () =>
  h.chrome(
    `const { SessionSaver } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionSaver.sys.mjs");
     SessionSaver.run = () => Promise.resolve();
     SessionSaver.runDelayed = () => {};
     SessionSaver.cancel();
     return true;`
  );
/** Every Space Zen has: [uuid, name, zenius's mark or null]. */
const zenSpaces = () =>
  h.chrome(`return win.gZenWorkspaces.getWorkspaces().map(ws => [ws.uuid, ws.name, ws.zenius ?? null]);`);
/**
 * The start logged one restart line matching `re`. A mismatch shows every
 * restart line it logged, so a failure says which heal ran, not only that
 * the count was off.
 */
function assertRestartLine(re) {
  const lines = h.instanceLog(/restart: /);
  assert.equal(lines.filter(line => re.test(line)).length, 1, `one restart line matching ${re}; the start logged ${JSON.stringify(lines)}`);
}

test("an empty Agents Space a kill brings back goes at the start, and a Space the user named Agents stays", async () => {
  await removeAgentWork();
  // The user's own Space named Agents: zenius never touches it.
  const mine = await h.chrome(
    `const ws = await win.gZenWorkspaces.createAndSaveWorkspace("Agents", undefined, true, 0); return ws.uuid;`
  );
  h.madeSpaces.add(mine);
  const t = await h.space("orphan empty");
  const agents = await h.chrome(`return ctx.spaces.agentsSpace.uuid;`);
  assert.notEqual(agents, mine);
  // The only marked Space, so the start has exactly one to remove.
  assert.deepEqual(
    (await zenSpaces()).filter(([, , mark]) => mark === "agents-space"),
    [[agents, "Agents", "agents-space"]]
  );
  await saveSession([agents, mine]);

  // The task ends: zenius removes its Space and records none. Zen dies before its file catches up.
  await stubSessionSaves();
  await h.call("spaces.finish", { space: t, keep: [] });
  assert.equal(await h.chrome(`return ctx.spaces.agentsSpace.uuid;`), null);
  assert.ok(await zenFileHas(agents), "Zen's own file still has the Agents Space at the kill");
  const zenFile = join(process.env.ZENIUS_DEV_HOME || join(homedir(), ".zenius-dev"), "profiles", h.instance, "zen-sessions.jsonlz4");
  const checked = statSync(zenFile).mtimeMs;
  await killAndStart(KILL_PREFS_NO_TABS);

  const spaces = await zenSpaces();
  if (!h.instanceLog(/restart: /).length) {
    // Once seen under load: the start healed nothing. Say whether Zen's file
    // lost the Space before the kill, or the heal ran before Zen listed it.
    const changed = statSync(zenFile).mtimeMs !== checked;
    assert.fail(
      `the start healed no marked Space. Zen's file ${changed ? "changed" : "didn't change"} since the check before the kill, ` +
        `and has the Agents Space now: ${await zenFileHas(agents)}. Zen's Spaces now: ${JSON.stringify(await zenSpaces())}. ` +
        `The rebuild: ${JSON.stringify(h.instanceLog(/restart rebuild/))}`
    );
  }
  assert.ok(!spaces.some(([uuid]) => uuid === agents), "the empty marked Space went at the start");
  assert.ok(spaces.some(([uuid, name, mark]) => uuid === mine && name === "Agents" && mark === null), "the user's own Agents stayed");
  assert.equal(await h.chrome(`return ctx.spaces.agentsSpace.uuid;`), null);
  assertRestartLine(/restart: Agents Space not adopted; removed 1 empty marked Space\(s\); left 0 with tabs/);
  assert.deepEqual((await h.call("browser.health")).strayAgentsSpaces, []);
  // Zen's own file drops it at once (zenius saves after its removal).
  await h.until(async () => !(await zenFileHas(agents)), 10000);
});

test("an Agents Space a kill brings back with a tab in it becomes the Agents Space again", async () => {
  await removeAgentWork();
  const t = await task("orphan tab", ["/api/text?orphan-tab"]);
  const agents = await h.chrome(`return ctx.spaces.agentsSpace.uuid;`);
  await saveSession([agents, url("/api/text?orphan-tab")]);

  // finish closes the page and removes the Space, but Zen's file still has both.
  await stubSessionSaves();
  await h.call("spaces.finish", { space: t.space, keep: [] });
  assert.equal(await h.chrome(`return ctx.spaces.agentsSpace.uuid;`), null);
  assert.ok(await zenFileHas(agents), "Zen's own file still has the Agents Space at the kill");
  await killAndStart(KILL_PREFS);

  // The crashed session brings the tab back in its Space; its task is gone,
  // so it stays as an unmanaged tab, and the Space is the Agents Space again.
  assert.equal(await h.chrome(`return ctx.spaces.agentsSpace.uuid;`), agents);
  assert.equal(await anyTabAt(url("/api/text?orphan-tab")), true);
  assertRestartLine(new RegExp(`restart: Agents Space adopted ${agents.replace(/[{}]/g, "\\$&")}; removed 0`));
  assert.ok(!(await listedIds()).includes(t.space));
  // The user closes it: the Space goes as any Agents Space does.
  await h.chrome(
    `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     for (const tab of W.tabsInWorkspace(arg)) tab.ownerDocument.defaultView.gBrowser.removeTab(tab, { animate: false });
     ctx.spaces.maybeRemoveAgentsSpace();
     return true;`,
    agents
  );
  assert.ok(!(await zenSpaces()).some(([uuid]) => uuid === agents));
});

test("a marked Space with a tab that isn't the Agents Space stays at the start, renamed (old), and doctor's list names its place", async () => {
  await removeAgentWork();
  const t = await task("stray kept", ["/api/text?stray-kept"]);
  const agents = await h.chrome(`return ctx.spaces.agentsSpace.uuid;`);
  // As a crash can leave one: zenius's mark, the Agents Space's name, a tab
  // of the user's.
  const stray = await h.chrome(
    `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     const ws = await win.gZenWorkspaces.createAndSaveWorkspace("Agents", undefined, true, 0);
     ws.zenius = "agents-space";
     win.gZenWorkspaces.saveWorkspace(ws);
     W.addBackgroundTab(win, ws.uuid).linkedBrowser.fixupAndLoadURIString(arg, {
       triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
     });
     return ws.uuid;`,
    url("/api/text?stray-tab")
  );
  h.madeSpaces.add(stray);
  await h.until(() => anyTabAt(url("/api/text?stray-tab")), 10000);
  await restart({ "browser.startup.page": 3, "zen.workspaces.continue-where-left-off": false });

  const spaces = await zenSpaces();
  assert.ok(spaces.some(([uuid, name, mark]) => uuid === agents && name === "Agents" && mark === "agents-space"));
  assert.ok(spaces.some(([uuid, name, mark]) => uuid === stray && name === "Agents (old)" && mark === "agents-space"));
  assert.equal(h.instanceLog(/restart: Agents Space not adopted; removed 0 empty marked Space\(s\); left 1 with tabs/).length, 1);
  const position = spaces.findIndex(([uuid]) => uuid === stray) + 1;
  assert.deepEqual((await h.call("browser.health")).strayAgentsSpaces, [{ uuid: stray, name: "Agents (old)", tabs: 1, position }]);
  // A second start names it once.
  await restart({ "browser.startup.page": 3, "zen.workspaces.continue-where-left-off": false });
  assert.ok((await zenSpaces()).some(([uuid, name]) => uuid === stray && name === "Agents (old)"));
  await h.remove(t.space);
});

test("zenius's save puts the Agents Space in Zen's own file when it comes and takes it out when it goes", async () => {
  // No test save here: only zenius's own (saveSessionNow). Without it,
  // nothing saves Zen's Space list after a Space's creation or removal.
  await removeAgentWork();
  const t = await h.space("agents saved");
  const agents = await h.chrome(`return ctx.spaces.agentsSpace.uuid;`);
  await h.until(() => zenFileHas(agents), 10000);
  await h.call("spaces.finish", { space: t, keep: [] });
  await h.until(async () => !(await zenFileHas(agents)), 10000);
});

/** zenius's start and method-loading lines since this start, in order: "listening" or "loaded". */
const startLines = () =>
  h.instanceLog(/\[zenius\] (listening on |loaded \d+ methods in )/).map(line => (/listening on/.test(line) ? "listening" : "loaded"));

/** What loaded the method modules, from their log line: "a connection", "a close waits", … */
const loadReasons = () => h.instanceLog(/\[zenius\] loaded \d+ methods in /).map(line => line.match(/\(([^)]*)\)\s*$/)?.[1] ?? null);

test("with no agent work, the method modules load at the first connection, not at the start", async () => {
  await removeAgentWork();
  await restart({ "browser.startup.page": 0 });
  // The connection's first call: the modules loaded before it ran.
  assert.ok((await h.call("browser.methods")).methods.includes("page.click"));
  assert.deepEqual(startLines(), ["listening", "loaded"], "the socket listened before the modules loaded, at the connection");
  assert.equal(h.instanceLog(/listening on .*\(methods at the first connection,/).length, 1);
  assert.deepEqual(loadReasons(), ["a connection"]);
});

test("a close that waits again after a restart loads the method modules for its pill, with no other agent work", async () => {
  // A finish that kept nothing, while the user looked at its page: the
  // close waits, and spaces.json lists no task.
  await removeAgentWork();
  const w = await task("restart lazy wait", ["/api/text?w1"]);
  await userViews(w.space, w.labels[0]);
  await h.call("spaces.finish", { space: w.space, keep: [] });
  assert.equal(await h.chrome(`return ctx.pages.isDeferred(win.gBrowser.selectedTab);`), true);

  // A connection would load the modules too: none until the rebuild is over.
  await restart(
    { "browser.startup.page": 3, "zen.workspaces.continue-where-left-off": true },
    { beforeConnect: () => untilLogged(/\[zenius\] restart rebuild: /) }
  );
  assert.deepEqual(loadReasons(), ["a close waits"]);
  // The UI's pill on the waiting tab says why it will close.
  await h.until(
    () =>
      h.chrome(
        `const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
         const t = win.gBrowser.selectedTab;
         return ctx.pages.isDeferred(t) && t.linkedBrowser.currentURI.spec === arg && !!N.noticeElement(t, "zenius-task-finished");`,
        url("/api/text?w1")
      ),
    10000
  );
  await userGoesHome();
  await h.until(async () => !(await anyTabAt(url("/api/text?w1"))));
});

/** Wait for a line of the instance's log (since its start) that matches `re`. */
async function untilLogged(re, ms = 30000) {
  for (const end = Date.now() + ms; !h.instanceLog(re).length; ) {
    if (Date.now() > end) {
      throw new Error(`no line matching ${re} in the instance log after ${ms} ms`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test("with a task to come back, the method modules load at the start, before the socket listens", async () => {
  const e = await task("restart eager", ["/api/text?e1"]);
  await restart({ "browser.startup.page": 3 });
  assert.deepEqual(startLines(), ["loaded", "listening"], "a restored agent tab must not load before its guards");
  assert.deepEqual(loadReasons(), ["agent work at the start"]);
  // The restored page, unloaded until a call loads it.
  await h.call("page.title", { space: e.space, page: e.labels[0] });
  await h.until(async () => (await topURL(e.space, e.labels[0])) === url("/api/text?e1"), 10000);
  assert.deepEqual(await guarded(e.space, e.labels[0]), [true]);
  await h.remove(e.space);
});

test("a start that fails fails only its restart: the instance is started again for the tests after it", async () => {
  // A ZEN_BIN with no Zen at it fails zen-dev.sh's start at once, as a start
  // that never gets ready fails it after its wait.
  await assert.rejects(h.restart({}, { env: { ZEN_BIN: join(dir, "no-zen-here") } }), e => {
    assert.match(e.message, /zen-dev\.sh \S+ start failed/);
    assert.match(e.message, /Zen not found at /);
    assert.match(e.message, /The instance was started again, without this restart's prefs, for the tests after this one\./);
    return true;
  });
  assert.equal(typeof (await h.call("browser.version")).runtimeVersion, "string");
});
