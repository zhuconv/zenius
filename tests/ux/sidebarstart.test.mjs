// The agent sidebar's start in each kind of browser window, and every way
// out of it. In a daily profile, doctor said "zenius's sidebar failed to
// start in the running Zen: can't access property "tabContainer", gBrowser
// is undefined". The window was a site's popup: its toolbar isn't visible,
// so fx-autoconfig takes it for a dialog and runs the sidebar's script
// before the browser makes gBrowser.
// - A popup gets no sidebar, and nothing is registered for it.
// - A start that throws midway undoes what it did.
// - A closed window leaves nothing of the sidebar's in AgentService: the
//   task listeners that held every closed window before (the arrival
//   card's, the directory's), with the panel's, and the window's chat
//   listener (clearing history re-renders the way back).
// - Doctor's ui.sidebarStatus reports each window. Keeping only the first
//   window's error, a popup's, would hide that the main window loaded.
// Whether the closed window is then collected isn't checked: in a headless
// dev Zen on the Linux server, no closed browser window was, even with none of our
// scripts in it (60 s of forced collections). Its retaining
// paths went through Zen's own URL bar element and a callback held from C++.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { connect } from "../../scripts/lib/rpc.mjs";

const instance = process.env.ZENIUS_INSTANCE;
const run = Date.now().toString(36).slice(-5);
const SCRIPT = "chrome://userscripts/content/agent-sidebar.uc.js";

let client;
let server;

const www = () => `http://127.0.0.1:${server.address().port}`;
const chrome = (code, arg) => client.call("dev.evalChrome", { code: `${HELPERS}\n${code}`, arg });

const HELPERS = `
  const A = win.ucAgentSidebar.AgentService;
  /** AgentService's listeners: for tasks, and for chats a purge took (a window keeping chats has one). */
  const counts = () => ({ tasks: A.taskListeners.size, chats: A.chatListeners?.size ?? 0 });
  /** The listeners over \`base\` (counts()). */
  const over = base => {
    const now = counts();
    return { tasks: now.tasks - base.tasks, chats: now.chats - base.chats };
  };
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const until = async (fn, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) {
      let v;
      try {
        v = await fn();
      } catch {}
      if (v || Date.now() > end) return v;
      await sleep(50);
    }
  };
  const browserWindows = () => [...Services.wm.getEnumerator("navigator:browser")];
  const { sidebarStatus } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/sidebarstatus.sys.mjs");
  /** What doctor reads of the windows' starts. */
  const status = async () => {
    const s = await sidebarStatus();
    return { windows: s.windows, error: s.error ?? null };
  };
  /** What window \`w\` has of the sidebar. */
  const sidebarIn = w => ({
    start: w.zeniusSidebarStart ? { error: w.zeniusSidebarStart.error } : null,
    glue: !!w.ucAgentSidebar,
    commands: !!w.document.getElementById("agent-sidebar-commands"),
    keys: !!w.document.getElementById("agent-sidebar-keys"),
    panel: (() => {
      try {
        return !!w.SidebarController?.sidebars?.has("viewAgentSidebar");
      } catch (e) {
        return "SidebarController throws: " + e.message;
      }
    })(),
  });
  /** The keys switched off in \`w\`'s document. */
  const offKeys = w => [...w.document.querySelectorAll("key[disabled='true']")].map(k => k.id || k.getAttribute("modifiers") + "+" + (k.getAttribute("key") || k.getAttribute("keycode"))).sort();
  /** A new browser window like the user's (\`options\`: {private}), once its sidebar has started and its late startup is done. */
  const openWindow = async options => {
    const w = win.OpenBrowserWindow(options);
    await until(() => w.gBrowser && w.document.readyState === "complete" && w.zeniusSidebarStart, 15000);
    await w.delayedStartupPromise;
    // Past the sidebar's second pass over the keys, a second after that.
    await sleep(1500);
    return w;
  };
  /**
   * Closes \`w\`; true once it has unloaded. A window reads as closed at
   * once and unloads a moment later: its own unload listeners first (the
   * sidebar's among them), then its frames' (the panel's), after this one.
   */
  const closeWindow = async w => {
    const unloaded = new Promise(r => w.addEventListener("unload", () => r(true), { once: true }));
    w.close();
    const done = await Promise.race([unloaded, sleep(10000).then(() => false)]);
    await sleep(0);
    return done;
  };
  /** AgentService's listeners over \`base\`, once they're back to it or 5 s on. */
  const listenersOver = async base => {
    await until(() => {
      const d = over(base);
      return d.tasks === 0 && d.chats === 0;
    }, 5000);
    return over(base);
  };
`;

before(async () => {
  if (!instance) {
    throw new Error("ZENIUS_INSTANCE is not set; run tests/ux/run.sh");
  }
  client = await connect(instance, { callTimeout: 90000 });
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const html = body => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><meta charset="utf-8">${body}</html>`);
    if (path === "/opener") {
      // A site's sign-in button, as the page opens it: a window with no toolbar.
      html(`<title>Opener</title></head><body><p>opener</p><script>window.open("/popup", "_blank", "popup,toolbar=no,width=480,height=420");</script></body>`);
    } else if (path === "/popup") {
      html(`<title>Popup ${run}</title></head><body><p>a site's popup</p></body>`);
    } else {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  await client?.close?.();
  await new Promise(resolve => (server ? server.close(resolve) : resolve()));
});

test("a site's popup (window.open with no toolbar) gets no sidebar: no start error for doctor, nothing registered for it, and nothing of it is left once it closes", async () => {
  const out = await chrome(
    `
    const known = new Set(browserWindows());
    const base = counts();
    const res = { before: await status() };
    // Popups open during a page's load only with the blocker off: the user's
    // click does it on the real site.
    const PREF = "dom.disable_open_during_load";
    const had = Services.prefs.prefHasUserValue(PREF) ? Services.prefs.getBoolPref(PREF) : null;
    Services.prefs.setBoolPref(PREF, false);
    let tab = null;
    let popup = null;
    try {
      tab = win.gBrowser.addTab(arg.opener, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      win.gBrowser.selectedTab = tab;
      popup = await until(() => browserWindows().find(w => !known.has(w)), 15000);
      if (!popup) {
        res.opened = false;
        return res;
      }
      res.opened = true;
      res.loaded = !!(await until(() => popup.gBrowser?.selectedBrowser?.contentTitle === arg.title && popup.document.readyState === "complete", 15000));
      await popup.delayedStartupPromise;
      await sleep(1500);
      res.popup = { toolbar: popup.toolbar.visible, ...sidebarIn(popup), listeners: over(base) };
      res.during = await status();
      res.unloaded = await closeWindow(popup);
      popup = null;
      res.closed = { listeners: await listenersOver(base), after: await status() };
      return res;
    } finally {
      if (popup && !popup.closed) {
        popup.close();
      }
      if (tab) {
        win.gBrowser.removeTab(tab, { animate: false });
      }
      if (had === null) {
        Services.prefs.clearUserPref(PREF);
      } else {
        Services.prefs.setBoolPref(PREF, had);
      }
    }
  `,
    { opener: `${www()}/opener`, title: `Popup ${run}` }
  );
  assert.equal(out.opened, true, "the page's window.open opened a window");
  assert.equal(out.loaded, true, "the popup loaded its page");
  assert.equal(out.popup.toolbar, false, "a popup's toolbar isn't visible, as a site's sign-in window's");
  assert.deepEqual(
    out.popup,
    { toolbar: false, start: null, glue: false, commands: false, keys: false, panel: false, listeners: { tasks: 0, chats: 0 } },
    "no sidebar in the popup: no start, no glue, key, command or panel, no listener"
  );
  assert.deepEqual(out.during, out.before, "doctor sees no start error, and the same windows with a sidebar");
  assert.equal(out.unloaded, true, "the popup unloaded");
  assert.deepEqual(out.closed, { listeners: { tasks: 0, chats: 0 }, after: out.before }, "closed, nothing of the popup is left");
});

test("a window that closes leaves nothing of the sidebar's in AgentService: its task listeners (the arrival card's, the directory's, the panel's) go with it", async () => {
  const out = await chrome(`
    const base = counts();
    const res = { before: await status() };
    let w = await openWindow();
    try {
      // The directory and the panel listen for tasks too, once they're made.
      w.ucAgentSidebar.toggleDirectory();
      await w.ucAgentSidebar.toggle();
      res.panelShown = !!(await until(() => w.ucAgentSidebar.panel, 15000));
      res.open = { toolbar: w.toolbar.visible, ...sidebarIn(w), listeners: over(base), status: await status() };
      res.unloaded = await closeWindow(w);
      w = null;
      res.closed = { listeners: await listenersOver(base), after: await status() };
      return res;
    } finally {
      if (w && !w.closed) {
        w.close();
      }
    }
  `);
  assert.equal(out.panelShown, true, "the second window's panel opened");
  assert.deepEqual(
    out.open,
    { toolbar: true, start: { error: null }, glue: true, commands: true, keys: true, panel: true, listeners: { tasks: 3, chats: 1 }, status: { windows: out.before.windows + 1, error: null } },
    "the second window's sidebar started, with the arrival card's, the directory's and the panel's task listeners, and its chat listener"
  );
  assert.equal(out.unloaded, true, "the window unloaded");
  assert.deepEqual(out.closed, { listeners: { tasks: 0, chats: 0 }, after: out.before }, "closed, nothing of it is left in AgentService");
});

test("uninit, and a start that throws midway, undo everything the start did: no glue, key, command, panel or task listener, and Zen's own keys back; a start after them works", async () => {
  const out = await chrome(
    `
    const base = counts();
    const res = {};
    let w = await openWindow();
    try {
      w.ucAgentSidebar.toggleDirectory();
      res.started = { ...sidebarIn(w), listeners: over(base) };
      w.ucAgentSidebar.uninit();
      res.uninit = { ...sidebarIn(w), listeners: over(base) };
      const keysOff = offKeys(w);
      // The start's last step throws: everything else has been set up by then.
      w.gBrowser.addProgressListener = () => {
        throw new Error(arg.mark);
      };
      try {
        Services.scriptloader.loadSubScriptWithOptions(arg.script, { target: w, ignoreCache: true });
      } finally {
        delete w.gBrowser.addProgressListener;
      }
      res.failed = { ...sidebarIn(w), listeners: over(base), doctor: (await status()).error };
      // Nothing of it comes back later either: the second pass over the keys.
      await sleep(1500);
      res.failedLater = { ...sidebarIn(w), keysBack: JSON.stringify(offKeys(w)) === JSON.stringify(keysOff) || offKeys(w) };
      Services.scriptloader.loadSubScriptWithOptions(arg.script, { target: w, ignoreCache: true });
      w.ucAgentSidebar.toggleDirectory();
      res.again = { ...sidebarIn(w), listeners: over(base) };
      res.unloaded = await closeWindow(w);
      w = null;
      res.closed = { listeners: await listenersOver(base) };
      return res;
    } finally {
      if (w && !w.closed) {
        delete w.gBrowser?.addProgressListener;
        w.close();
      }
    }
  `,
    { script: SCRIPT, mark: `ZS-START-THROWS-${run}` }
  );
  const none = { glue: false, commands: false, keys: false, panel: false };
  assert.deepEqual(out.started, { start: { error: null }, glue: true, commands: true, keys: true, panel: true, listeners: { tasks: 2, chats: 1 } }, "started, with its directory");
  assert.deepEqual(out.uninit, { start: { error: null }, ...none, listeners: { tasks: 0, chats: 0 } }, "uninit undid it all");
  assert.equal(out.failed.start?.error, `ZS-START-THROWS-${run}`, "the start's error, for doctor");
  assert.equal(out.failed.doctor, `ZS-START-THROWS-${run}`, "doctor reads it");
  const { start: _start, doctor: _doctor, ...failed } = out.failed;
  assert.deepEqual(failed, { ...none, listeners: { tasks: 0, chats: 0 } }, "the failed start undid what it did before the throw");
  assert.deepEqual(out.failedLater, { start: { error: `ZS-START-THROWS-${run}` }, ...none, keysBack: true }, "and nothing of it came back a second later: Zen's own keys stay on");
  assert.deepEqual(out.again, { start: { error: null }, glue: true, commands: true, keys: true, panel: true, listeners: { tasks: 2, chats: 1 } }, "a start after it works");
  assert.equal(out.unloaded, true, "the window unloaded");
  assert.deepEqual(out.closed, { listeners: { tasks: 0, chats: 0 } }, "closed, nothing is left in AgentService");
});

test("ui.sidebarStatus reports each browser window: started, failed with its error, or skipped as a popup. A start that threw in one window doesn't hide that the others loaded, a popup counts in none of the totals, and only a failed or not-started window carries its kind, as doctor names those alone: no socket client learns that a private window is open", async () => {
  /** ui.sidebarStatus, without what it says of the agents' config. */
  const status = async () => {
    const { config: _config, configPath: _path, builtin: _builtin, ...s } = await client.call("ui.sidebarStatus", {});
    return s;
  };
  const before = await status();
  const out = await chrome(
    `
    const known = new Set(browserWindows());
    /** The module's answer, as the method gives it, without the config. */
    const now = async () => {
      const { config, configPath, builtin, ...s } = await sidebarStatus();
      return s;
    };
    // Popups open during a page's load only with the blocker off.
    const PREF = "dom.disable_open_during_load";
    const had = Services.prefs.prefHasUserValue(PREF) ? Services.prefs.getBoolPref(PREF) : null;
    const res = {};
    let second = null;
    let priv = null;
    let popup = null;
    let tab = null;
    try {
      second = await openWindow();
      priv = await openWindow({ private: true });
      Services.prefs.setBoolPref(PREF, false);
      tab = win.gBrowser.addTab(arg.opener, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      win.gBrowser.selectedTab = tab;
      popup = await until(() => browserWindows().find(w => !known.has(w) && w !== second && w !== priv), 15000);
      res.popupLoaded = !!(popup && (await until(() => popup.gBrowser?.selectedBrowser?.contentTitle === arg.title && popup.document.readyState === "complete", 15000)));
      if (!res.popupLoaded) {
        return res;
      }
      await popup.delayedStartupPromise;
      res.started = await now();
      // The second window's start throws at its last step, as in the test above.
      second.ucAgentSidebar.uninit();
      second.gBrowser.addProgressListener = () => {
        throw new Error(arg.mark);
      };
      try {
        Services.scriptloader.loadSubScriptWithOptions(arg.script, { target: second, ignoreCache: true });
      } finally {
        delete second.gBrowser.addProgressListener;
      }
      res.failed = await now();
      // An older sidebar file started in popups and threw there.
      popup.zeniusSidebarStart = Object.freeze({ error: arg.old });
      res.oldPopup = await now();
      delete popup.zeniusSidebarStart;
      // A window still opening has no start recorded yet: the private one here.
      const record = priv.zeniusSidebarStart;
      delete priv.zeniusSidebarStart;
      res.opening = await now();
      priv.zeniusSidebarStart = record;
      return res;
    } finally {
      for (const w of [popup, priv, second]) {
        if (w && !w.closed) {
          await closeWindow(w);
        }
      }
      if (tab) {
        win.gBrowser.removeTab(tab, { animate: false });
      }
      if (had === null) {
        Services.prefs.clearUserPref(PREF);
      } else {
        Services.prefs.setBoolPref(PREF, had);
      }
    }
  `,
    { opener: `${www()}/opener`, title: `Popup ${run}`, script: SCRIPT, mark: `ZS-STATUS-THROWS-${run}`, old: `ZS-OLD-POPUP-${run}` }
  );
  const after = await status();
  const all = JSON.stringify({ before, ...out, after });
  assert.equal(out.popupLoaded, true, `the page's window.open opened its popup: ${all}`);
  assert.ok(Array.isArray(before.perWindow), `ui.sidebarStatus lists each window: ${all}`);
  const mark = `ZS-STATUS-THROWS-${run}`;
  const { windows: n, open: m, perWindow: was } = before;
  // A started window and a popup carry no kind: only a failed or not-started one does.
  const started = { sidebar: "started" };
  const browserFailed = { kind: "browser", sidebar: "failed", error: mark };
  const popupSkipped = { sidebar: "skipped" };
  assert.deepEqual(was.at(0), started, `the test's own window comes first: ${all}`);
  assert.deepEqual(before, { loaded: true, windows: n, open: m, failed: 0, perWindow: was }, `before, no start failed: ${all}`);
  assert.deepEqual(
    out.started,
    { loaded: true, windows: n + 2, open: m + 2, failed: 0, perWindow: [...was, started, started, popupSkipped] },
    `a second window and a private one started, neither saying which is private, and the popup is skipped, counted in neither windows nor open: ${all}`
  );
  assert.deepEqual(
    out.failed,
    { loaded: true, windows: n + 1, open: m + 2, failed: 1, error: mark, perWindow: [...was, browserFailed, started, popupSkipped] },
    `one window's start failed, with its error, and the others still count as loaded: ${all}`
  );
  assert.deepEqual(
    out.oldPopup,
    {
      loaded: true,
      windows: n + 1,
      open: m + 2,
      failed: 1,
      error: mark,
      perWindow: [...was, browserFailed, started, { kind: "popup", sidebar: "failed", error: `ZS-OLD-POPUP-${run}` }],
    },
    `a popup's start that threw is listed as it was, and counts in none of the totals: ${all}`
  );
  assert.deepEqual(
    out.opening,
    { loaded: true, windows: n, open: m + 2, failed: 1, error: mark, perWindow: [...was, browserFailed, { kind: "private", sidebar: "none" }, popupSkipped] },
    `a window with no start recorded, as one still opening, counts in open alone, and carries its kind (here the private one): ${all}`
  );
  assert.deepEqual(after, before, `closed, the status is as before: ${all}`);
});
