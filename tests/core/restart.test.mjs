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
 * and puts back.
 */
const steps = { hits: new Map() };
const stepServer = http.createServer((req, res) => {
  steps.hits.set(req.url, (steps.hits.get(req.url) ?? 0) + 1);
  const u = new URL(req.url, "http://x");
  res.writeHead(200, { "content-type": "text/html", ...(u.searchParams.has("nostore") ? { "cache-control": "no-store" } : {}) });
  res.end(`<!doctype html><title>${u.searchParams.get("r") ?? "step"}</title><form><input name=nickname></form>`);
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
    const back = await h.call("spaces.takeOver", { space });
    assert.deepEqual(back.blanked, ["p1"]);
    const now = await tabNow(space, "p1");
    assert.deepEqual([now.url, now.history], ["about:blank", 1]);
  } finally {
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
  // zen-ux's pill on the waiting tab says why it will close.
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
