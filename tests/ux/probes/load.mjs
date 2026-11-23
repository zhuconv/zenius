// Load probe (a load test, 2026-11-20). Not a test: no suite runs it, and
// it asserts nothing. It prints "# key: json" lines.
//
//   ZENIUS_UX_INSTANCE=zen-ux-load tests/ux/run.sh tests/ux/probes/load.mjs
//   PHASE_MS=10000 shortens each phase (default 20000).
//
// What it does, on one headless dev Zen:
// - Three clients: lib's setup() connection and two more connect()s.
// - Ten tasks, round-robin over the clients (4, 3, 3), with five pages each
//   on the fixture's /zoo/forms.html (one site, 127.0.0.1).
// - The window shows the Agents Space, with task 1's first page selected
//   and focused.
// - Each task runs one loop of goto, fill, click, evaluate, waitForSelector,
//   hover and spaces.setState on a page, then moves to its next page.
// - Phases: idle 5 s; A, full speed, panel closed; B, full speed, panel open
//   with the keyboard on a row's button; C, ten presses on the panel's
//   Pause/Resume, idle and under load; D, a 0.5 s think time (±50%).
// - It measures I1 events, the chrome event loop's lag, the strip's
//   mutations, panel rebuilds and focus, per-op latency (clicks split by the
//   task in view and the rest), and the processes' memory before, during and
//   after (with a minimize at the end).
import { after, before, test } from "node:test";
import { performance } from "node:perf_hooks";
import { connect } from "../../../scripts/lib/rpc.mjs";
import { setup } from "../lib.mjs";

const PHASE_MS = Number(process.env.PHASE_MS ?? 20000);
const run = Date.now().toString(36).slice(-4);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let h;
const extra = [];
/** @type {{client: any, id: number, pages: string[]}[]} */
const tasks = [];
const log = (k, v) => console.log(`# ${k}: ${JSON.stringify(v)}`);

const UI = `const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));`;

before(async () => {
  h = await setup();
  extra.push(await connect(process.env.ZENIUS_INSTANCE), await connect(process.env.ZENIUS_INSTANCE));
});

after(async () => {
  for (const t of tasks) {
    await t.client.call("spaces.finish", { space: t.id, keep: [] }).catch(() => {});
  }
  for (const c of extra) {
    c.close?.();
  }
  await h?.close();
});

const mem = (label) =>
  h.chrome(`
    ${UI}
    if (${label === "end"}) {
      await new Promise(r => Cc["@mozilla.org/memory-reporter-manager;1"].getService(Ci.nsIMemoryReporterManager).minimizeMemoryUsage(r));
    }
    const info = await ChromeUtils.requestProcInfo();
    const kids = info.children ?? [];
    const mb = b => Math.round((b ?? 0) / 1048576);
    return {
      parentMB: mb(info.memory),
      childrenMB: mb(kids.reduce((s, c) => s + (c.memory ?? 0), 0)),
      processes: kids.length + 1,
      tabs: gBrowser.tabs.length,
      zeniusEls: win.document.querySelectorAll("[class^='zenius-'], [id^='zenius-']").length,
      allEls: win.document.getElementsByTagName("*").length,
      rows: UI.tasks().length,
    };
  `);

const startMonitors = () =>
  h.chrome(`
    const L = (win.__zuLoad = { tabSelect: 0, focus: [], popups: [], activate: 0, ws: 0, focusMoved: 0, lag: [], strip: [], rebuilds: 0, running: true });
    const doc = win.document;
    L.onTabSelect = () => L.tabSelect++;
    L.onFocus = e => L.focus.push(String(e.target?.id || e.target?.localName || e.target));
    L.onPopup = e => L.popups.push(e.target.id || e.target.localName);
    L.onActivate = () => L.activate++;
    gBrowser.tabContainer.addEventListener("TabSelect", L.onTabSelect);
    win.addEventListener("focus", L.onFocus, true);
    doc.addEventListener("popupshowing", L.onPopup, true);
    win.addEventListener("activate", L.onActivate);
    L.start = { ws: gZenWorkspaces.activeWorkspace, tab: gBrowser.selectedTab, focused: Services.focus.focusedElement, active: Services.focus.activeWindow };
    let t0 = win.performance.now();
    const tick = () => {
      const now = win.performance.now();
      L.lag.push(now - t0 - 10);
      t0 = now;
      if (L.running) win.setTimeout(tick, 10);
    };
    win.setTimeout(tick, 10);
    L.poll = win.setInterval(() => {
      if (gZenWorkspaces.activeWorkspace !== L.start.ws) L.ws++;
      if (Services.focus.focusedElement !== L.start.focused) L.focusMoved++;
    }, 50);
    const strip = doc.getElementById("zenius-agents-strip");
    L.stripObs = new win.MutationObserver(() => L.strip.push(strip.querySelector(".zenius-strip-text").textContent + " | " + strip.getAttribute("state")));
    L.stripObs.observe(strip, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["state"] });
    return true;
  `);

const stopMonitors = () =>
  h.chrome(`
    const L = win.__zuLoad;
    L.running = false;
    win.clearInterval(L.poll);
    L.stripObs.disconnect();
    L.panelObs?.disconnect();
    win.clearInterval(L.focusPoll);
    gBrowser.tabContainer.removeEventListener("TabSelect", L.onTabSelect);
    win.removeEventListener("focus", L.onFocus, true);
    win.document.removeEventListener("popupshowing", L.onPopup, true);
    win.removeEventListener("activate", L.onActivate);
    const lag = L.lag.slice().sort((a, b) => a - b);
    const q = p => +lag[Math.min(lag.length - 1, Math.floor(p * lag.length))].toFixed(1);
    return {
      lag: { samples: lag.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +lag.at(-1).toFixed(1), over50ms: lag.filter(x => x > 50).length },
      i1: {
        tabSelect: L.tabSelect, focusEvents: L.focus.length, focusFirst: L.focus.slice(0, 6), focusMovedSamples: L.focusMoved,
        popups: L.popups, activate: L.activate, wsChangeSamples: L.ws,
        sameTab: gBrowser.selectedTab === L.start.tab, sameWs: gZenWorkspaces.activeWorkspace === L.start.ws,
        sameFocus: Services.focus.focusedElement === L.start.focused, sameActiveWindow: Services.focus.activeWindow === L.start.active,
      },
      strip: { changes: L.strip.length, distinct: [...new Set(L.strip)].slice(0, 8) },
      panel: L.focusBtn ? { rebuilds: L.rebuilds, focusLostSamples: L.focusLost, focusSamples: L.focusSamples, stillFocused: win.document.activeElement === L.focusBtn, btnConnected: L.focusBtn.isConnected, activeNow: String(win.document.activeElement?.id || win.document.activeElement?.localName) + "." + (win.document.activeElement?.className ?? "") } : { rebuilds: L.rebuilds },
    };
  `);

const OPS = [
  ["goto", (c, s, p, n) => c.call("page.goto", { space: s, page: p, url: `${h.base}/zoo/forms.html?n=${n}` })],
  ["fill", (c, s, p, n) => c.call("page.fill", { space: s, page: p, target: "#email", value: `a${n}@example.com`, options: {} })],
  ["click", (c, s, p) => c.call("page.click", { space: s, page: p, target: "input[type=button]", options: {} })],
  ["evaluate", (c, s, p) => c.call("page.evaluate", { space: s, page: p, fn: "() => document.title", isFunction: true })],
  ["waitForSelector", (c, s, p) => c.call("page.waitForSelector", { space: s, page: p, target: "#email", options: {} })],
  ["hover", (c, s, p) => c.call("page.hover", { space: s, page: p, target: "button[type=reset]", options: {} })],
  ["setState", (c, s, p, n) => c.call("spaces.setState", { space: s, text: `Step ${(n % 9) + 1} of 9: checking the form` })],
];

async function agentLoop(t, until, thinkMs) {
  const lat = {};
  const errors = [];
  let n = 0;
  while (Date.now() < until) {
    const [name, op] = OPS[n % OPS.length];
    const page = t.pages[Math.floor(n / OPS.length) % t.pages.length];
    const t0 = performance.now();
    try {
      await op(t.client, t.id, page, n);
    } catch (e) {
      errors.push(`${name}: ${e.code ?? ""} ${String(e.message).slice(0, 90)}`);
    }
    (lat[name] ??= []).push(performance.now() - t0);
    n++;
    if (thinkMs) {
      await sleep(thinkMs * (0.5 + Math.random()));
    }
  }
  return { n, lat, errors };
}

async function load(thinkMs) {
  const until = Date.now() + PHASE_MS;
  const res = await Promise.all(tasks.map(t => agentLoop(t, until, thinkMs)));
  const calls = res.reduce((s, r) => s + r.n, 0);
  const by = {};
  for (const r of res) {
    for (const [k, v] of Object.entries(r.lat)) (by[k] ??= []).push(...v);
  }
  const q = (a, p) => +a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(1);
  const lat = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { n: v.length, p50: q(v, 0.5), p95: q(v, 0.95) }]));
  const errors = res.flatMap(r => r.errors);
  const clickInView = res[0].lat.click ?? [];
  const clickElsewhere = res.slice(1).flatMap(r => r.lat.click ?? []);
  const split = { inView: clickInView.length ? { n: clickInView.length, p50: q(clickInView, 0.5), p95: q(clickInView, 0.95) } : null, elsewhere: clickElsewhere.length ? { n: clickElsewhere.length, p50: q(clickElsewhere, 0.5), p95: q(clickElsewhere, 0.95) } : null };
  return { clickSplit: split, calls, perSecond: +(calls / (PHASE_MS / 1000)).toFixed(1), lat, errors: errors.length, firstErrors: [...new Set(errors)].slice(0, 5) };
}

test("load: 3 clients, 10 tasks, 50+ tabs, the Agents Space in view", { timeout: 15 * 60000 }, async () => {
  log("memory.before", await mem("before"));
  const clients = [h.client, ...extra];
  const t0 = performance.now();
  await Promise.all(
    clients.map(async (client, k) => {
      for (let i = k; i < 10; i += 3) {
        const { id } = await client.call("spaces.create", { name: `Load ${run} · task ${i + 1}` });
        await client.call("page.goto", { space: id, page: "p1", url: `${h.base}/zoo/forms.html` });
        const pages = ["p1"];
        while (pages.length < 5) {
          const { label } = await client.call("pages.new", { space: id, url: `${h.base}/zoo/forms.html` });
          pages.push(label);
        }
        tasks.push({ client, id, pages });
      }
    })
  );
  tasks.sort((a, b) => a.id - b.id);
  log("setup", { tasks: tasks.length, pages: tasks.reduce((s, t) => s + t.pages.length, 0), ms: Math.round(performance.now() - t0) });

  // The user looks at the Agents Space: task 1's first page, focused.
  log(
    "view",
    await h.chrome(`
      ${UI}
      const Pages = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
      const { tab, space: rec } = ctx.resolvePage({ space: ${tasks[0].id}, page: "p1" });
      Pages.landOn(tab);
      await gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
      for (let i = 0; i < 100 && gBrowser.selectedTab !== tab; i++) await sleep(25);
      tab.linkedBrowser.focus();
      await sleep(200);
      return { selected: gBrowser.selectedTab === tab, agentsSpace: !!ctx.service.spaces.isAgentsSpace?.(gZenWorkspaces.activeWorkspace), focused: Services.focus.focusedElement?.localName, tabs: gBrowser.tabs.length, strip: win.document.querySelector("#zenius-agents-strip .zenius-strip-text")?.textContent };
    `)
  );
  log("memory.loaded", await mem("loaded"));

  // Baseline: nobody acts.
  await startMonitors();
  await sleep(5000);
  log("phase0.idle", await stopMonitors());

  // A: agents back to back, panel closed.
  await startMonitors();
  const a = await load(0);
  log("phaseA.stress.panelClosed", { load: a, ...(await stopMonitors()) });
  log("memory.afterA", await mem("afterA"));

  // B: the same, with the user's panel open and their keyboard on a button.
  await startMonitors();
  log(
    "phaseB.panelOpen",
    await h.chrome(`
      ${UI}
      const L = win.__zuLoad;
      const t0 = win.performance.now();
      const panel = UI.openTasksPanel(win);
      await new Promise(r => (panel.state === "open" ? r() : panel.addEventListener("popupshown", r, { once: true })));
      const openMs = +(win.performance.now() - t0).toFixed(1);
      const body = panel.querySelector(".zenius-tasks");
      L.panelObs = new win.MutationObserver(recs => {
        for (const r of recs) for (const n of r.removedNodes) if (n.classList?.contains("zenius-tasks-title")) L.rebuilds++;
      });
      L.panelObs.observe(body, { childList: true });
      const btn = body.querySelectorAll(".zenius-task")[1].querySelector("button[data-action=open]");
      btn.focus();
      L.focusBtn = btn;
      L.focusLost = 0;
      L.focusSamples = 0;
      L.focusPoll = win.setInterval(() => {
        L.focusSamples++;
        const a = win.document.activeElement;
        if (!(a?.localName === "button" && a.closest(".zenius-task")?.dataset.space === btn.closest(".zenius-task").dataset.space && a.dataset.action === "open")) L.focusLost++;
      }, 100);
      return { openMs, rows: body.querySelectorAll(".zenius-task").length, focused: win.document.activeElement === btn };
    `)
  );
  const b = await load(0);
  log("phaseB.stress.panelOpen", { load: b, ...(await stopMonitors()) });

  // C: the user's mouse presses on the panel's Pause/Resume, under load and not.
  const clicks = () =>
    h.chrome(`
      ${UI}
      const panel = win.document.getElementById("zenius-tasks-panel");
      const pick = () => panel.querySelectorAll(".zenius-task")[2];
      let ok = 0;
      const tries = 10;
      for (let i = 0; i < tries; i++) {
        const row = pick();
        const id = row.dataset.space;
        const b = row.querySelector("button[data-action=pause], button[data-action=resume]");
        const before = b.dataset.action;
        const r = b.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        win.synthesizeMouseEvent("mousedown", x, y, { button: 0, buttons: 1, clickCount: 1 }, { isDOMEventSynthesized: false });
        await sleep(120);
        win.synthesizeMouseEvent("mouseup", x, y, { button: 0, buttons: 0, clickCount: 1 }, { isDOMEventSynthesized: false });
        await sleep(250);
        const now = panel.querySelector('.zenius-task[data-space="' + id + '"]')?.querySelector("button[data-action=pause], button[data-action=resume]")?.dataset.action;
        if (now && now !== before) ok++;
      }
      // Leave it running.
      const row = panel.querySelector('.zenius-task button[data-action=resume]');
      if (row) row.click();
      return { tries, ok };
    `);
  log("phaseC.clicks.idle", await clicks());
  const until = Date.now() + 9000;
  const [c] = await Promise.all([clicks(), Promise.all(tasks.map(t => agentLoop(t, until, 0)))]);
  log("phaseC.clicks.underLoad", c);
  await h.chrome(`${UI} UI.closeTasksPanel(win); return true;`);

  // D: agents with think time (a model's pace is seconds; this is faster).
  await startMonitors();
  const d = await load(500);
  log("phaseD.think500ms.panelClosed", { load: d, ...(await stopMonitors()) });
  log("memory.afterLoad", await mem("afterLoad"));
  log("dev.stats", await h.call("dev.stats").then(s => JSON.stringify(s).slice(0, 1500)).catch(e => String(e)));

  for (const t of tasks) {
    await t.client.call("spaces.finish", { space: t.id, keep: [] }).catch(() => {});
  }
  tasks.length = 0;
  await sleep(1000);
  log("memory.end", await mem("end"));
  log(
    "end",
    await h.chrome(`
      ${UI}
      return { strip: win.document.getElementById("zenius-agents-strip")?.hidden, cards: win.document.querySelectorAll(".zenius-card").length, tags: win.document.querySelectorAll(".tabbrowser-tab[zenius-task]").length };
    `)
  );
});
