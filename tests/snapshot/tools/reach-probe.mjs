// Reach probes. A task's document holds a
// handle to a window of the user's when the two share a browsing context
// group. This maps, headless on the Linux server, with loopback fixtures only:
// 1. the paths that put a task document in a group with a user's window:
//    adopting a popup, claiming a tab that has an opener or popups, tabs the
//    user opens from a task page while they hold it (Use your own tab,
//    gone since zen-ux removed it, was one too);
// 2. the handles the task document's code gets: opener, a named lookup
//    (window.open('', name)), a message's source, the site's own variables,
//    and frames, parent, top and opener through each;
// 3. what that code can do with each, same-origin and cross-origin: run code
//    in the window's realm, read it, ask for the camera, register a service
//    worker, fetch, leave code that runs after the task ("caps"); navigate
//    it, focus it, close it ("nav").
//
//   ZENIUS_DEV_PREFS=tests/snapshot/tools/reach-prefs.js scripts/zen-dev.sh zen-snapshot-reach start
//   ZENIUS_INSTANCE=zen-snapshot-reach node tests/snapshot/tools/reach-probe.mjs [path[:run] ...]
//
// A camera request that gets through gets Gecko's fake stream: the probe
// refuses to run without reach-prefs.js, and grants the fixture site only
// for the run.
import { openKit } from "./owntab-kit.mjs";

if (process.platform === "darwin") {
  console.error("reach-probe: never on the Mac");
  process.exit(2);
}

const kit = await openKit();
const { call, chrome, A, B, sleep, newTask } = kit;
// page.evaluate. Closed groups' refusal (ZEN_AGENT_CODE_REFUSED) is a result here, not a failure.
const ev = (space, page, fn) =>
  kit.ev(space, page, fn).catch(e => {
    if (e.code === "ZEN_AGENT_CODE_REFUSED") return { refused: `${e.code}: ${String(e.message).slice(0, 160)}` };
    throw e;
  });
const step = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const js = v => JSON.stringify(v).replace(/</g, "\\u003c");
const q = v => encodeURIComponent(v);
/** A role's page; `extra` comes before the site parameters, so a stripped URL keeps it. */
const page = (base, role, extra = "") => `${base}/reach?role=${role}${extra}&a=${q(A.base)}&b=${q(B.base)}`;
const NAMES = ["zsW", "zsU", "zsP", "zsQ", "zsR", "zsF1", "zsF2", "zsH", "zsT", "zsV"];

/** Chrome-side helpers, after the kit's. */
const C = `
  const AGENTS = ctx.spaces.agentsSpace.uuid;
  const R = (win.__reach ??= { roles: {} });
  const taskIds = () => Services.ppmm.sharedData.get("zenius:taskBrowserIds") ?? new Set();
  const topById = id => BrowsingContext.getCurrentTopByBrowserId(id);
  const tabById = id => {
    const el = topById(id)?.embedderElement;
    return el ? el.ownerDocument.defaultView.gBrowser.getTabForBrowser(el) : null;
  };
  const roleOfId = id => Object.entries(R.roles).find(([, v]) => v === id)?.[0] ?? null;
  const strip = u => (u ?? "").replace(/&a=.*$/, "");
  const show = async t => {
    const w = t.ownerDocument.defaultView;
    const ws = t.getAttribute("zen-workspace-id");
    if (ws && w.gZenWorkspaces.activeWorkspace !== ws) await w.gZenWorkspaces.changeWorkspaceWithID(ws);
    w.gBrowser.selectedTab = t;
    await until(() => w.gBrowser.selectedTab === t, 3000).catch(() => {});
    await sleep(250);
  };
  // The user's click (button 0), middle click (1) or right click (2) on sel.
  const userClick = async (t, sel, button = 0) => {
    await show(t);
    const at = await inContent(t, "const r = document.querySelector(" + JSON.stringify(sel) + ").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2];");
    const w = t.ownerDocument.defaultView;
    const r = t.linkedBrowser.getBoundingClientRect();
    const send = (type, buttons = 0) => w.synthesizeMouseEvent(type, r.left + at[0], r.top + at[1],
      { identifier: 0, button, buttons, clickCount: 1, modifiers: 0, inputSource: 1 },
      { isDOMEventSynthesized: false, isWidgetEventSynthesized: false, isAsyncEnabled: false });
    send("mousemove"); await sleep(30); send("mousedown", [1, 4, 2][button]); await sleep(40); send("mouseup");
  };
  // The new tab a step opens, once it shows role r's page.
  const opened = async (fn, r, ms = 10000) => {
    const before = new Set(all());
    await fn();
    let t = null;
    await until(() => (t = all().find(x => !before.has(x) && x.linkedBrowser?.currentURI?.spec.includes("role=" + r + "&") && loaded(x))), ms);
    return t;
  };
  const spaceOf = t => {
    const ws = t.getAttribute("zen-workspace-id");
    return ws === R.userSpace ? "user" : ws === AGENTS ? "agents" : "task";
  };
  const describe = () => {
    const out = {};
    const ids = taskIds();
    for (const [role, id] of Object.entries(R.roles)) {
      const bc = topById(id);
      const t = tabById(id);
      if (!bc || !t) {
        out[role] = { closed: true };
        continue;
      }
      out[role] = {
        url: strip(bc.currentURI?.spec),
        title: t.label,
        group: bc.group?.id ?? null,
        task: ids.has(id),
        managed: !!ctx.service.lookup(t),
        marked: AC.agentCodeDocument(t.linkedBrowser),
        opener: bc.opener ? roleOfId(bc.opener.top.browserId) ?? "other" : null,
        space: spaceOf(t),
        selected: t.ownerDocument.defaultView.gBrowser.selectedTab === t,
      };
    }
    // A window the agent's code opened by a named lookup that found nothing (the "?" handle).
    const known = new Set(Object.values(R.roles));
    for (const t of all()) {
      const bc = t.linkedBrowser?.browsingContext;
      if (!bc || known.has(t.linkedBrowser.browserId) || !bc.name?.startsWith("zs")) continue;
      out["new " + bc.name] = {
        url: strip(bc.currentURI?.spec),
        group: bc.group?.id ?? null,
        task: ids.has(t.linkedBrowser.browserId),
        opener: bc.opener ? roleOfId(bc.opener.top.browserId) ?? "other" : null,
        space: spaceOf(t),
      };
    }
    return out;
  };
  // Who else is in the task document's browsing context group.
  const groupOf = role => {
    const ids = taskIds();
    return topById(R.roles[role])?.group?.getToplevels().map(bc => {
      const r = roleOfId(bc.browserId);
      return (r ?? "unknown") + (ids.has(bc.browserId) ? " (task)" : " (user)");
    }) ?? null;
  };
  // Every document's innerWindowId, to its role (frames as role/name).
  const docIds = () => {
    const out = {};
    for (const [role, id] of Object.entries(R.roles)) {
      for (const bc of topById(id)?.getAllBrowsingContextsInSubtree() ?? []) {
        const wg = bc.currentWindowGlobal;
        if (wg) out[wg.innerWindowId] = bc.parent ? role + "/" + (bc.name || "frame") : role;
      }
    }
    return out;
  };
`;

/** The user's windows: W (on wBase) opens U; U opens Q and R, and P with `pop` if given. */
async function userWindows({ wBase = A.base, pop = null } = {}) {
  return chrome(
    C +
      `
    const ws = gZenWorkspaces.getWorkspaces().find(x => x.uuid !== AGENTS);
    R.userSpace = ws.uuid;
    R.roles = {};
    if (gZenWorkspaces.activeWorkspace !== ws.uuid) await gZenWorkspaces.changeWorkspaceWithID(ws.uuid);
    const w = gBrowser.addTrustedTab(arg.W, { inBackground: false });
    gBrowser.selectedTab = w;
    await until(() => w.linkedBrowser.currentURI.spec === arg.W && loaded(w), 10000);
    R.roles.W = w.linkedBrowser.browserId;
    const u = await opened(() => userClick(w, "#openU"), "U");
    R.roles.U = u.linkedBrowser.browserId;
    await until(() => u.linkedBrowser.browsingContext.children.length === 2 && u.linkedBrowser.browsingContext.children.every(c => c.currentWindowGlobal && !c.currentWindowGlobal.isInitialDocument), 8000).catch(() => {});
    R.roles.Q = (await opened(() => userClick(u, "#openQ"), "Q")).linkedBrowser.browserId;
    R.roles.R = (await opened(() => userClick(u, "#openR"), "R")).linkedBrowser.browserId;
    if (arg.pop) R.roles.P = (await opened(() => userClick(u, arg.pop), "P")).linkedBrowser.browserId;
    await show(u);
    return { space: ctx.spaces.peekUuid(ws.uuid).id };
  `,
    { W: page(wBase, "W", "&name=zsW"), pop }
  );
}

/** The agent claims the user's Space (the user allows it) and adopts one of its tabs. */
async function claimAndAdopt(space, role) {
  const claim = call("spaces.claim", { space, client: "red team", timeout: 20000 });
  claim.catch(() => {});
  await call("dev.answerClaim", { space, timeout: 10000 });
  await claim;
  const tab = await chrome(C + `return ctx.service.pages.tabId(tabById(R.roles[arg]));`, role);
  const adopted = await call("pages.adopt", { space, tab });
  return adopted.label;
}

/** Each path sets up its windows and returns {space, label, taskRole, notes}. */
const PATHS = {
  // The user's tab opens the site's tool in a popup; the agent adopts the popup.
  popup: async () => {
    const { space } = await userWindows({ pop: "#openP" });
    return { space, label: await claimAndAdopt(space, "P"), taskRole: "P" };
  },
  // The same, with the tool on the other site.
  popupXO: async () => {
    const { space } = await userWindows({ pop: "#openPB" });
    return { space, label: await claimAndAdopt(space, "P"), taskRole: "P" };
  },
  // The agent adopts a tab that has an opener (W) and popups (Q, R).
  claimTab: async () => {
    const { space } = await userWindows();
    return { space, label: await claimAndAdopt(space, "U"), taskRole: "U" };
  },
  // The same, with the opener on the other site.
  claimTabXO: async () => {
    const { space } = await userWindows({ wBase: B.base });
    return { space, label: await claimAndAdopt(space, "U"), taskRole: "U" };
  },
  // A tab of the user's with no opener and no popups.
  claimAlone: async () => {
    const space = await chrome(
      C +
        `
      const ws = gZenWorkspaces.getWorkspaces().find(x => x.uuid !== AGENTS);
      R.userSpace = ws.uuid;
      R.roles = {};
      if (gZenWorkspaces.activeWorkspace !== ws.uuid) await gZenWorkspaces.changeWorkspaceWithID(ws.uuid);
      const v = gBrowser.addTrustedTab(arg, { inBackground: false });
      await until(() => v.linkedBrowser.currentURI.spec === arg && loaded(v), 10000);
      R.roles.V = v.linkedBrowser.browserId;
      return ctx.spaces.peekUuid(ws.uuid).id;
    `,
      page(A.base, "V", "&name=zsV")
    );
    return { space, label: await claimAndAdopt(space, "V"), taskRole: "V" };
  },
  // The agent's own page, with the user's windows open elsewhere.
  agentPage: async () => {
    await userWindows();
    const { id: space } = await call("spaces.create", { name: `reach agent ${Date.now().toString(36).slice(-4)}` });
    await call("page.goto", { space, page: "p1", url: page(A.base, "T", "&name=zsT") });
    await chrome(C + `R.roles.T = ctx.resolvePage({ space: arg, page: "p1" }).tab.linkedBrowser.browserId; return true;`, space);
    return { space, label: "p1", taskRole: "T" };
  },
  // The user holds the task and opens tabs from its page: a click on a
  // target=_blank link, with and without rel=opener, on a named target, on
  // the other site's rel=opener link; a middle click; the context menu's Open
  // Link in New Tab. Then the agent takes the task back.
  hold: async () => {
    const { id: space } = await call("spaces.create", { name: `reach hold ${Date.now().toString(36).slice(-4)}` });
    await call("page.goto", { space, page: "p1", url: page(A.base, "T", "&name=zsT") });
    await call("spaces.handOff", { space });
    const how = await chrome(
      C +
        `
      R.roles = {};
      R.userSpace = gZenWorkspaces.getWorkspaces().find(x => x.uuid !== AGENTS).uuid;
      const t = ctx.resolvePage({ space: arg, page: "p1" }).tab;
      R.roles.T = t.linkedBrowser.browserId;
      const how = {};
      for (const [role, sel, button, key] of [["H1", "#blank", 0, "H1"], ["H2", "#blankOpener", 0, "H2"], ["H3", "#named", 0, "H3"], ["H5", "#blankOpenerB", 0, "H5"], ["H4", "#plain", 1, "H4mid"]]) {
        try {
          R.roles[key] = (await opened(() => userClick(t, sel, button), role)).linkedBrowser.browserId;
          how[key] = "opened";
        } catch (e) {
          how[key] = "not opened: " + String(e.message).slice(0, 60);
        }
      }
      const w = t.ownerDocument.defaultView;
      const menu = w.document.getElementById("contentAreaContextMenu");
      try {
        R.roles.H4menu = (await opened(async () => {
          const shown = new Promise(r => menu.addEventListener("popupshowing", r, { once: true }));
          await userClick(t, "#plain", 2);
          await Promise.race([shown, sleep(3000).then(() => { throw new Error("no context menu"); })]);
          await sleep(100);
          w.document.getElementById("context-openlinkintab").doCommand();
          menu.hidePopup();
        }, "H4")).linkedBrowser.browserId;
        how.H4menu = "opened";
      } catch (e) {
        how.H4menu = "not opened: " + String(e.message).slice(0, 60);
        try { menu.hidePopup(); } catch {}
      }
      how.duringHold = describe();
      return how;
    `,
      space
    );
    // The user clicked in the page, so the agent can't take it over: the
    // user hands it back on the pill.
    const handBack = await kit.handBack(space).then(
      () => "ok",
      e => e.code ?? String(e.message).slice(0, 80)
    );
    return { space, label: "p1", taskRole: "T", notes: { ...how, handBack } };
  },
};

/** The task document's code collects every handle it can get, and tags each. */
const HANDLES = `async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const hs = [];
  // In the agent's world, window isn't the page's own WindowProxy, so
  // top and parent of a top page fail h === window: compare documents too.
  const self = h => { if (h === window) return true; try { return h.document === document; } catch (e) { return false; } };
  const add = (how, h) => {
    if (!h || self(h)) return;
    const x = hs.find(x => x.h === h);
    if (x) { if (x.how.length < 6) x.how.push(how); return; }
    hs.push({ how: [how], h });
  };
  add("opener", window.opener);
  add("top", window.top);
  add("parent", window.parent);
  for (const v of ["__u", "__p", "__q", "__r"]) add("window." + v, window[v]);
  for (const n of ${js(NAMES)}) {
    try { add("open('', " + n + ")", window.open("", n)); } catch (e) {}
  }
  const sources = [];
  const onMsg = e => { if (e.data && e.data.sync && e.source && !sources.includes(e.source)) sources.push(e.source); };
  addEventListener("message", onMsg);
  await sleep(1200);
  removeEventListener("message", onMsg);
  for (const h of sources) add("message.source", h);
  for (let i = 0; i < hs.length && i < 60; i++) {
    const h = hs[i].h;
    const how = hs[i].how[0];
    try { add(how + ".opener", h.opener); } catch (e) {}
    try { add(how + ".top", h.top); } catch (e) {}
    try { add(how + ".parent", h.parent); } catch (e) {}
    try { for (let k = 0; k < h.length; k++) add(how + ".frames[" + k + "]", h.frames[k]); } catch (e) {}
    for (const v of ["__u", "__p", "__q", "__r"]) { try { add(how + "." + v, h[v]); } catch (e) {} }
  }
  window.__zsH = hs.map(x => x.h);
  return hs.map((x, i) => {
    let sameOrigin = false;
    try { sameOrigin = !!x.h.document; } catch (e) {}
    try { x.h.postMessage({ zs: "k" + i }, "*"); } catch (e) {}
    return { key: "k" + i, how: x.how, sameOrigin };
  });
}`;

/** Which window got each tag: every document of every tab says. */
const GOT = `
  const out = [];
  const ids = taskIds();
  for (const t of all()) {
    const top = t.linkedBrowser?.browsingContext;
    for (const bc of top?.getAllBrowsingContextsInSubtree() ?? []) {
      let r = null;
      try { r = await ctx.content(bc, "dev#evalContent", { code: "return [window.__role ?? null, window.__got ?? null];" }); } catch (e) { continue; }
      if (!r?.[1]?.length) continue;
      out.push({ role: r[0], frame: !!bc.parent, tab: roleOfId(top.browserId), task: ids.has(top.browserId), got: r[1] });
    }
  }
  return out;
`;

async function handlesOf(space, label) {
  const hs = await ev(space, label, HANDLES);
  if (!Array.isArray(hs)) {
    return { error: hs };
  }
  await sleep(500);
  const got = await chrome(C + GOT);
  const where = {};
  for (const g of got) {
    for (const k of g.got) {
      where[k] = { role: g.role, frame: g.frame, tab: g.tab, task: g.task };
    }
  }
  return hs.map(h => ({ ...h, window: where[h.key] ?? null }));
}

/** The task document's code, with each handle to a window outside the task. */
const capsCode = idx => `async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const settle = (p, ms = 3000) => Promise.race([Promise.resolve(p).then(v => "resolved: " + v, e => "rejected: " + (e && e.name || e)), sleep(ms).then(() => "pending")]);
  const camera = nav => nav.mediaDevices.getUserMedia({ video: true }).then(s => { const n = s.getVideoTracks().length; s.getTracks().forEach(t => t.stop()); return "stream (" + n + " video)"; });
  const out = {
    own: {
      camera: await settle(camera(navigator)),
      sw: await settle(navigator.serviceWorker.register("/sw-noop.js").then(r => "registered")),
    },
  };
  for (const i of ${js(idx)}) {
    const h = window.__zsH[i];
    const r = (out["k" + i] = {});
    let same = false;
    try { same = !!h.document; } catch (e) {}
    if (!same) {
      try { h.eval("1"); r.exec = "ran"; } catch (e) { r.exec = "threw " + e.name; }
      continue;
    }
    try { r.exec = "ran in " + h.eval("window.__role"); } catch (e) { r.exec = "threw " + e.name; }
    try { r.read = h.document.getElementById("text").textContent; } catch (e) { r.read = "threw " + e.name; }
    r.camera = await settle(camera(h.navigator), 4000);
    r.sw = await settle(h.navigator.serviceWorker.register("/sw-noop.js").then(reg => { const s = new URL(reg.scope).pathname; reg.unregister(); return "registered " + s; }));
    r.fetch = await settle(h.fetch("/hit?reach-k" + i).then(res => "status " + res.status));
    try { h.eval("setTimeout(() => { document.title = 'planted ' + document.title; }, 8000)"); r.plant = "set"; } catch (e) { r.plant = "threw " + e.name; }
  }
  return out;
}`;

/** Navigate, focus and close each handle's window: frames first, then tops. */
const navCode = plan => `async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = {};
  for (const { i, url, route } of ${js(plan)}) {
    const h = window.__zsH[i];
    try {
      if (route === "asUser") h.eval("location.href = " + JSON.stringify(url));
      else h.location.href = url;
      out["k" + i] = route + ": ok";
    } catch (e) { out["k" + i] = route + ": threw " + e.name; }
    await sleep(400);
  }
  return out;
}`;
const oneCall = (what, i) => `async () => { try { window.__zsH[${i}].${what}(); return "ok"; } catch (e) { return "threw " + e.name; } }`;

const OBSERVE_ON = `
  win.__zsSeen = [];
  if (win.__zsObs) Services.obs.removeObserver(win.__zsObs, "http-on-opening-request");
  win.__zsObs = { observe(subject) {
    try {
      const ch = subject.QueryInterface(Ci.nsIHttpChannel);
      const spec = ch.URI.spec;
      if (!/\\/hit\\?reach-|[?&]nav=/.test(spec)) return;
      const li = ch.loadInfo;
      const bc = li.frameBrowsingContextID ? BrowsingContext.get(li.frameBrowsingContextID) : li.browsingContext;
      win.__zsSeen.push({
        url: strip(spec).replace(/^https?:\\/\\/[^/]+/, ""),
        tab: roleOfId(bc?.top?.browserId) ?? (bc ? "other" : null),
        task: taskIds().has(bc?.top?.browserId),
        frame: !!bc?.parent,
        triggeringWindowId: "triggeringWindowId" in li ? li.triggeringWindowId : "absent",
        triggering: li.triggeringPrincipal?.origin ?? null,
      });
    } catch (e) { win.__zsSeen.push({ error: String(e) }); }
  } };
  Services.obs.addObserver(win.__zsObs, "http-on-opening-request");
  return true;
`;
const OBSERVE_OFF = `
  if (win.__zsObs) Services.obs.removeObserver(win.__zsObs, "http-on-opening-request");
  delete win.__zsObs;
  return win.__zsSeen ?? [];
`;

/**
 * Code the agent plants in its page before the user opens tabs from it: it
 * wraps window.open (the site's own buttons call it) and takes over the
 * user's clicks on links that open a new tab, opening them itself with an
 * opener. In each same-origin window it gets, it then runs code: a title
 * change and a camera request.
 */
const PLANT = `() => {
  window.__captured = [];
  window.__capturedOut = [];
  const nativeOpen = window.open;
  const take = (via, w) => {
    const rec = { via, got: !!w };
    window.__capturedOut.push(rec);
    if (!w) return;
    window.__captured.push(w);
    setTimeout(() => {
      try {
        rec.exec = "ran in " + w.eval("window.__role");
        w.eval("document.title = 'planted ' + document.title");
        w.navigator.mediaDevices.getUserMedia({ video: true }).then(s => { rec.camera = "stream"; s.getTracks().forEach(t => t.stop()); }, e => { rec.camera = e.name; });
      } catch (e) { rec.exec = "threw " + e.name; }
    }, 1500);
  };
  window.open = function () { const w = Reflect.apply(nativeOpen, window, Array.from(arguments)); take("window.open", w); return w; };
  document.addEventListener("click", e => {
    const a = e.target.closest && e.target.closest("a[target]");
    if (!a || e.button !== 0) return;
    e.preventDefault();
    take("click #" + a.id, Reflect.apply(nativeOpen, window, [a.href, a.target]));
  }, true);
  document.addEventListener("auxclick", e => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a || e.button !== 1) return;
    e.preventDefault();
    take("middle click #" + a.id, Reflect.apply(nativeOpen, window, [a.href, "_blank"]));
  }, true);
  return "planted";
}`;

/**
 * T's capture record, as an expression for code in C with \`t\` set: in the
 * page's JavaScript where the agent's code ran there (main before the
 * isolated world), else in the agent's world. A discarded world reads as a
 * fresh one, without it.
 */
const RECORD = `((await inContent(t, "return window.__capturedOut ?? null")) ?? (await inContent(t, "let AW; try { AW = ChromeUtils.importESModule('chrome://userscripts/content/zenius/content/agentworld.sys.mjs'); } catch (e) { return null; } if (typeof AW.worldFor !== 'function') return null; return JSON.parse(Components.utils.evalInSandbox('JSON.stringify(window.__capturedOut ?? null)', AW.worldFor(window).sandbox));", true)))`;

/** The user opens tabs from T: clicks, a middle click, the context menu, the site's own popup button. */
const USER_OPENS = `
  const how = {};
  for (const [key, role, sel, button] of [["H1", "H1", "#blank", 0], ["H3", "H3", "#named", 0], ["H4mid", "H4", "#plain", 1], ["Q", "Q", "#openQ", 0]]) {
    try {
      R.roles[key] = (await opened(() => userClick(t, sel, button), role)).linkedBrowser.browserId;
      how[key] = "opened";
    } catch (e) {
      how[key] = "not opened: " + String(e.message).slice(0, 60);
    }
  }
  const w = t.ownerDocument.defaultView;
  const menu = w.document.getElementById("contentAreaContextMenu");
  try {
    R.roles.H4menu = (await opened(async () => {
      const shown = new Promise(r => menu.addEventListener("popupshowing", r, { once: true }));
      await userClick(t, "#plain", 2);
      await Promise.race([shown, sleep(3000).then(() => { throw new Error("no context menu"); })]);
      await sleep(100);
      w.document.getElementById("context-openlinkintab").doCommand();
      menu.hidePopup();
    }, "H4")).linkedBrowser.browserId;
    how.H4menu = "opened";
  } catch (e) {
    how.H4menu = "not opened: " + String(e.message).slice(0, 60);
    try { menu.hidePopup(); } catch {}
  }
  await sleep(3000);
  how.captured = await ${RECORD};
  how.windows = describe();
  return how;
`;

/**
 * Planted code captures the tabs the user opens from the agent's page:
 * "hold", while the user holds the task (then the agent takes it back and
 * the task ends), or "kept", from the page the task kept for the user.
 */
/**
 * Closed groups after the task: two kept pages of one group keep their
 * handles. During the task the agent's page T opens P2 (its site) and P3
 * (the other site) as task popups (item 2), moves P2 once so it has a page
 * to go back to, and plants a poller. The task ends keeping all three. Then
 * the poller acts on P2 and P3, one action at a time, when a flag on T's
 * document asks it to (set with dev#evalContent, which marks nothing).
 * Item 4 refuses loads that T starts in them; the plan names what it can't
 * see: a history move, a reload, a navigation run as the target's own code,
 * and close().
 */
const KEPT_ACTS = ["href", "back", "reload", "realm", "asTarget", "crossHref", "crossClose", "close"];

function keptPlant(urls) {
  return `() => {
  const open = (id, url, name) => {
    const b = document.createElement("button");
    b.id = id;
    b.textContent = id;
    b.addEventListener("click", () => { window["__" + id] = window.open(url, name); });
    document.body.append(b);
  };
  const u = ${JSON.stringify(urls)};
  open("p2", u.p2, "zsP2");
  open("p3", u.p3, "zsP3");
  const acts = {
    href: () => { __p2.location.href = u.x1; return "set"; },
    back: () => { __p2.history.back(); return "called"; },
    reload: () => { __p2.location.reload(); return "called"; },
    realm: () => { const was = __p2.document.title; __p2.document.title = "changed by T"; return "read " + was; },
    asTarget: () => { __p2.eval("location.href = " + JSON.stringify(u.x2)); return "called"; },
    crossHref: () => { __p3.location = u.x3; return "set"; },
    crossClose: () => { __p3.close(); return "called"; },
    close: () => { __p2.close(); return "called"; },
  };
  window.__keptPoll = setInterval(() => {
    const go = document.documentElement.dataset.go;
    if (!go) return;
    delete document.documentElement.dataset.go;
    let r;
    try { r = acts[go](); } catch (e) { r = e.name + ": " + e.message; }
    document.documentElement.dataset.done = go + ": " + r;
  }, 100);
  return true;
}`;
}

async function keptPairRun() {
  const out = { path: "keptPair", run: "afterTask" };
  const t0 = Date.now();
  let space;
  try {
    const urls = {
      p2: page(A.base, "P2", "&name=zsP2"),
      p2b: page(A.base, "P2b", "&name=zsP2"),
      p3: page(B.base, "P3", "&name=zsP3"),
      x1: page(A.base, "X1"),
      x2: page(A.base, "X2"),
      x3: page(B.base, "X3"),
    };
    ({ id: space } = await call("spaces.create", { name: `reach kept pair ${Date.now().toString(36).slice(-4)}` }));
    await call("page.goto", { space, page: "p1", url: page(A.base, "T", "&name=zsT") });
    out.plant = await ev(space, "p1", keptPlant(urls));
    const labels = {};
    for (const id of ["p2", "p3"]) {
      const r = await call("page.click", { space, page: "p1", target: `#${id}`, options: {} });
      labels[id] = r?.popups?.[0]?.label ?? null;
    }
    await sleep(800);
    await ev(space, "p1", `() => { __p2.location.href = ${JSON.stringify(urls.p2b)}; return true; }`);
    await sleep(800);
    await chrome(
      C +
        `
      R.roles = {};
      R.userSpace = gZenWorkspaces.getWorkspaces().find(x => x.uuid !== AGENTS).uuid;
      R.roles.T = ctx.resolvePage({ space: arg.space, page: "p1" }).tab.linkedBrowser.browserId;
      for (const [role, label] of Object.entries(arg.labels)) if (label) R.roles[role.toUpperCase()] = ctx.resolvePage({ space: arg.space, page: label }).tab.linkedBrowser.browserId;
      return true;
    `,
      { space, labels }
    );
    out.labels = labels;
    out.duringTask = await chrome(C + `return describe();`);
    out.finish = await call("spaces.finish", { space, keep: ["p1", ...Object.values(labels).filter(Boolean)] }).then(
      () => "kept",
      e => e.code
    );
    space = undefined;
    await sleep(800);
    out.afterFinish = await chrome(C + `return describe();`);
    out.acts = {};
    for (const act of KEPT_ACTS) {
      step("keptPair", act);
      const done = await chrome(
        C +
          `
        const t = tabById(R.roles.T);
        if (!t) return "no T";
        await inContent(t, "delete document.documentElement.dataset.done; document.documentElement.dataset.go = " + JSON.stringify(arg) + "; return true;");
        let done = null;
        await until(async () => (done = await inContent(t, "return document.documentElement.dataset.done ?? null")) !== null, 5000).catch(() => {});
        await sleep(1200);
        return done;
      `,
        act
      );
      const w = await chrome(C + `return describe();`);
      out.acts[act] = {
        result: done,
        P2: w.P2?.closed ? "closed" : { url: w.P2?.url?.replace(/^.*\/reach\?role=/, "role="), title: w.P2?.title },
        P3: w.P3?.closed ? "closed" : { url: w.P3?.url?.replace(/^.*\/reach\?role=/, "role="), title: w.P3?.title },
      };
    }
  } catch (e) {
    out.error = String(e?.message ?? e);
  } finally {
    await tearDown(space);
    out.ms = Date.now() - t0;
  }
  return out;
}

/** zen-observe's agent-code mark and written flag of the browser \`b\`, for code in C. */
const FLAGS = `const flags = {};
  try { flags.mark = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/agentcode.sys.mjs").agentCodeTop(b); } catch (e) { flags.mark = "n/a"; }
  try { flags.written = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/agentworld.sys.mjs").isWritten(b); } catch (e) { flags.written = "n/a"; }`;

/** The agent's code also writes into T (keptWritten): a written page keeps its mark. */
const WRITE = `() => { document.body.append(Object.assign(document.createElement("i"), { id: "zsWrote", textContent: "w" })); return "wrote"; }`;

async function plantedRun(kind, opts = {}) {
  const out = { path: opts.write ? "keptWritten" : `${kind}Planted`, run: "capture" };
  const t0 = Date.now();
  let space;
  try {
    ({ id: space } = await call("spaces.create", { name: `reach ${kind} planted ${Date.now().toString(36).slice(-4)}` }));
    await call("page.goto", { space, page: "p1", url: page(A.base, "T", "&name=zsT") });
    out.plant = await ev(space, "p1", PLANT);
    if (opts.write) out.write = await ev(space, "p1", WRITE);
    // T's document before the step: landing (2) reloads a written page at its task's end.
    const docBefore = await chrome(C + `return ctx.resolvePage({ space: arg, page: "p1" }).tab.linkedBrowser.browsingContext.currentWindowGlobal?.innerWindowId ?? null;`, space).catch(() => null);
    // The control for "captured": T's record just before the hand-off or the finish.
    out.recordBefore = await chrome(C + `const t = ctx.resolvePage({ space: arg, page: "p1" }).tab; return (${RECORD}) === null ? "none" : "there";`, space).catch(e => "unread: " + String(e.message).slice(0, 80));
    if (kind === "hold") {
      await call("spaces.handOff", { space });
    } else {
      out.finish = await call("spaces.finish", { space, keep: ["p1"] }).then(
        () => "kept",
        e => e.code
      );
      await sleep(500);
    }
    // T's mark and written flag after the step, before the user's opens.
    out.afterStep = await chrome(
      C + `const t = arg.kind === "hold" ? ctx.resolvePage({ space: arg.space, page: "p1" }).tab : all().find(x => x.linkedBrowser?.currentURI?.spec.includes("role=T&") && !ctx.service.lookup(x)); if (!t) return "no T"; const b = t.linkedBrowser; ${FLAGS} flags.reloaded = arg.docBefore === null ? null : (b.browsingContext.currentWindowGlobal?.innerWindowId ?? null) !== arg.docBefore; return flags;`,
      { kind, space, docBefore }
    ).catch(e => "unread: " + String(e.message).slice(0, 80));
    step(out.path, "user opens tabs");
    out.user = await chrome(
      C +
        `
      R.roles = {};
      R.userSpace = gZenWorkspaces.getWorkspaces().find(x => x.uuid !== AGENTS).uuid;
      const t = arg.kind === "hold" ? ctx.resolvePage({ space: arg.space, page: "p1" }).tab : all().find(x => x.linkedBrowser?.currentURI?.spec.includes("role=T&") && !ctx.service.lookup(x));
      if (!t) return { error: "no page T" };
      R.roles.T = t.linkedBrowser.browserId;
      ${USER_OPENS}
    `,
      { kind, space }
    );
    if (kind === "hold") {
      out.handBack = await kit.handBack(space).then(
        () => "ok",
        e => e.code ?? String(e.message).slice(0, 80)
      );
      out.afterHandBack = await chrome(C + `return describe();`);
      out.finish = await call("spaces.finish", { space, keep: [] }).then(
        () => "finished",
        e => e.code
      );
      space = undefined;
      await sleep(2000);
      out.afterTask = await chrome(C + `return describe();`);
    }
  } catch (e) {
    out.error = `${e.code ?? ""} ${e.message ?? e}`.trim().slice(0, 300);
  } finally {
    await tearDown(space);
    out.ms = Date.now() - t0;
  }
  return out;
}

/** Close this path's windows and tasks. */
async function tearDown(space) {
  if (space !== undefined) {
    await call("spaces.finish", { space, keep: [] }).catch(() => {});
  }
  await chrome(
    C +
      `
    for (const id of Object.values(R.roles)) {
      const t = tabById(id);
      if (t && !ctx.service.lookup(t)) t.ownerDocument.defaultView.gBrowser.removeTab(t, { animate: false });
    }
    for (const t of all()) {
      // Never about:blank: Zen keeps an empty tab per Space, and removing it
      // breaks addTab. A popup the agent's code opened with the user's
      // activation is blank, and named: it goes by its name.
      const blank = t.linkedBrowser?.currentURI?.spec === "about:blank";
      const ours = blank ? /^zs/.test(t.linkedBrowser.browsingContext?.name ?? "") : /\\/reach\\?/.test(t.linkedBrowser?.currentURI?.spec ?? "");
      if (ours && !ctx.service.lookup(t) && !t.pinned && !t.hasAttribute("zen-empty-tab")) t.ownerDocument.defaultView.gBrowser.removeTab(t, { animate: false });
    }
    R.roles = {};
    return true;
  `
  ).catch(e => step("tearDown failed:", e.message));
  await kit.cleanTabs().catch(() => {});
}

/**
 * Closed groups, item 1: which calls run in the task document. The agent's
 * code (evaluate, waitForFunction, a data: page, another site's page, a
 * paste with html) is refused where the document's group holds a window
 * outside the task; snapshots, screenshots and clicks still run. The
 * navigations go last: where they're allowed they replace the document.
 */
async function refusalOf(setup) {
  const t = { space: setup.space, page: setup.label };
  const url = await chrome(C + `return tabById(R.roles[arg])?.linkedBrowser.currentURI.spec ?? null;`, setup.taskRole);
  const own = url?.startsWith(B.base) ? B.base : A.base;
  const other = own === A.base ? B.base : A.base;
  const tries = [
    ["evaluate", () => call("page.evaluate", { ...t, fn: "() => 1", isFunction: true })],
    ["waitForFunction", () => call("page.waitForFunction", { ...t, fn: "() => true", isFunction: true, options: { timeout: 2000 } })],
    ["paste html", () => call("page.keyboard", { ...t, action: "paste", text: "zs", html: "<b>zs</b>", options: {} })],
    // zen-input's neighbor: html on the Space's clipboard, copied in a page of
    // the task outside T's group, then the agent's ControlOrMeta+V in T's
    // editor. What landed, and zen-observe's agent-code mark and written
    // flag on T before and after.
    ["Ctrl+V html", async () => {
      const flags = () =>
        chrome(
          C +
            `const b = tabById(R.roles[arg])?.linkedBrowser; const out = {};
          try { out.mark = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/agentcode.sys.mjs").agentCodeTop(b); } catch (e) { out.mark = "n/a"; }
          try { out.written = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/agentworld.sys.mjs").isWritten(b); } catch (e) { out.written = "n/a"; }
          return out;`,
          setup.taskRole
        );
      const { label } = await call("pages.new", { space: setup.space, url: `${own}/reach?role=CB` });
      try {
        await call("page.evaluate", { space: setup.space, page: label, fn: `() => { const d = document.createElement("div"); d.innerHTML = "<b>zsHtml</b>"; document.body.append(d); const s = getSelection(); s.removeAllRanges(); const r = document.createRange(); r.selectNode(d); s.addRange(r); return true; }`, isFunction: true });
        await call("page.keyboard", { space: setup.space, page: label, action: "press", key: "ControlOrMeta+C", options: {} });
      } finally {
        await call("pages.close", { space: setup.space, page: label }).catch(() => {});
      }
      const before = await flags();
      await call("page.focus", { ...t, target: "#zsEd", options: {} });
      await call("page.keyboard", { ...t, action: "press", key: "ControlOrMeta+V", options: {} });
      await sleep(400);
      const after = await flags();
      const ed = await chrome(C + `return inContent(tabById(R.roles[arg]), "return document.getElementById('zsEd')?.innerHTML ?? null");`, setup.taskRole);
      const landed = /<b>zsHtml<\/b>/.test(ed ?? "") ? "pasted html" : /zsHtml/.test(ed ?? "") ? "pasted as text" : "nothing pasted";
      return `${landed}; mark ${before.mark}->${after.mark}; written ${before.written}->${after.written}`;
    }],
    ["snapshot", () => call("page.snapshot", { ...t, options: {} }).then(r => `ok, ${r?.text?.length ?? 0} chars`)],
    ["screenshot", () => call("page.screenshot", { ...t, options: {} }).then(r => `ok, ${r?.base64?.length ?? 0} base64 chars`)],
    ["click body", () => call("page.click", { ...t, target: "body", options: { timeout: 3000 } })],
    ["goto data:", () => call("page.goto", { ...t, url: "data:text/html,<p>zs</p>", options: { timeout: 5000 } })],
    ["goto other site", () => call("page.goto", { ...t, url: `${other}/`, options: { timeout: 5000 } })],
    ["goto own site", () => call("page.goto", { ...t, url: `${own}/`, options: { timeout: 5000 } })],
  ];
  const out = { url: (url ?? "").replace(/&a=.*$/, "") };
  for (const [name, f] of tries) {
    try {
      const r = await f();
      out[name] = typeof r === "string" ? r : "ok";
    } catch (e) {
      out[name] = `${e.code}${e.data?.reason ? ` [${e.data.reason}]` : ""}: ${String(e.message).slice(0, 120)}`;
    }
  }
  return out;
}

async function runPath(path, run) {
  const out = { path, run };
  let setup;
  const t0 = Date.now();
  try {
    step(path, run, "setup");
    setup = await PATHS[path]();
    out.notes = setup.notes;
    out.facts = await chrome(C + `return { windows: describe(), groupOfTaskDoc: groupOf(arg) };`, setup.taskRole);
    if (run === "refusal") {
      step(path, run, "refusal");
      out.refusal = await refusalOf(setup);
      out.afterRefusal = await chrome(C + `return describe();`);
      return out;
    }
    if (run === "lookup") {
      // One named lookup of an existing window, and nothing else: whose opener is it after?
      out.lookup = await ev(setup.space, setup.label, `() => { const w = window.open("", "zsQ"); return w ? "found" : "null"; }`);
      await sleep(300);
      out.afterLookup = await chrome(C + `return describe();`);
      return out;
    }
    step(path, run, "handles");
    out.handles = await handlesOf(setup.space, setup.label);
    out.afterHandles = await chrome(C + `return describe();`);
    const outside = Array.isArray(out.handles) ? out.handles.filter(h => h.window && !h.window.task) : [];
    if (run === "caps" && outside.length) {
      // The user looks at their tab U (W if U is the task's), as they would
      // while the agent works: a camera grant runs there at once.
      await chrome(C + `const t = tabById(R.roles[arg]); if (t) await show(t); return true;`, setup.taskRole === "U" ? "W" : "U");
      await chrome(C + OBSERVE_ON);
      step(path, run, "caps");
      out.caps = await ev(setup.space, setup.label, capsCode(outside.map(h => Number(h.key.slice(1)))));
      await sleep(500);
      out.requests = await chrome(C + OBSERVE_OFF);
      out.afterCaps = await chrome(
        C +
          `
        const d = describe();
        for (const [role, id] of Object.entries(R.roles)) {
          const t = tabById(id);
          if (t && d[role]) d[role].cameraPrompt = !!t.ownerDocument.defaultView.PopupNotifications.getNotification("webRTC-shareDevices", t.linkedBrowser);
        }
        return d;
      `
      );
      step(path, run, "finish, then wait for planted code");
      out.finish = await call("spaces.finish", { space: setup.space, keep: [] }).then(
        () => "finished",
        e => e.code
      );
      await sleep(9000);
      out.afterTask = await chrome(C + `return describe();`);
    }
    if (run === "nav" && outside.length) {
      const order = [...outside].sort((a, b) => Number(b.window.frame) - Number(a.window.frame));
      const plan = order.map(h => ({
        i: Number(h.key.slice(1)),
        route: h.sameOrigin ? "asUser" : "byRef",
        url: `${A.base}/reach?role=${h.window.role}&nav=${h.sameOrigin ? "asUser" : "byRef"}`,
      }));
      out.docIds = await chrome(C + `return docIds();`);
      await chrome(C + OBSERVE_ON);
      const before = await chrome(C + `return gBrowser.selectedTab.linkedBrowser.browserId;`);
      step(path, run, "navigate");
      out.nav = await ev(setup.space, setup.label, navCode(plan));
      await sleep(1500);
      out.requests = await chrome(C + OBSERVE_OFF);
      out.afterNav = await chrome(C + `return describe();`);
      // focus and close each top window outside the task
      const tops = order.filter(h => !h.window.frame);
      out.focus = {};
      out.close = {};
      for (const h of tops) {
        const i = Number(h.key.slice(1));
        const r = await ev(setup.space, setup.label, oneCall("focus", i));
        await sleep(400);
        out.focus[h.window.role] = { call: r, selected: await chrome(C + `const id = gBrowser.selectedTab.linkedBrowser.browserId; return { tab: roleOfId(id) ?? "other", changed: id !== arg, space: spaceOf(gBrowser.selectedTab) };`, before) };
      }
      for (const h of tops) {
        const i = Number(h.key.slice(1));
        const r = await ev(setup.space, setup.label, oneCall("close", i));
        await sleep(400);
        out.close[h.window.role] = { call: r, closed: await chrome(C + `return !tabById(R.roles[arg]);`, h.window.role) };
      }
    }
  } catch (e) {
    out.error = `${e.code ?? ""} ${e.message ?? e}`.trim().slice(0, 300);
  } finally {
    await chrome(C + OBSERVE_OFF).catch(() => {});
    await tearDown(setup?.space);
    out.ms = Date.now() - t0;
  }
  return out;
}

const RUNS = {
  popup: ["caps", "nav", "lookup", "refusal"],
  popupXO: ["caps", "nav", "refusal"],
  claimTab: ["caps", "nav", "refusal"],
  claimTabXO: ["caps", "nav", "refusal"],
  hold: ["caps", "nav", "refusal"],
  agentPage: ["handles", "refusal"],
  claimAlone: ["handles", "refusal"],
  holdPlanted: ["capture"],
  keptPlanted: ["capture"],
  keptWritten: ["capture"],
  keptPair: ["afterTask"],
};
const wanted = process.argv.slice(2);
const todo = wanted.length ? wanted.map(w => w.split(":")).flatMap(([p, r]) => (r ? [[p, r]] : (RUNS[p] ?? []).map(x => [p, x]))) : Object.entries(RUNS).flatMap(([p, rs]) => rs.map(r => [p, r]));

const results = [];
let printed = false;
const print = () => {
  if (!printed) {
    printed = true;
    console.log(JSON.stringify(results, null, 1));
  }
};
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    print();
    process.exit(1);
  });
}

try {
  const ok = await chrome(`return Services.prefs.getBoolPref("media.navigator.streams.fake", false);`);
  if (!ok) {
    throw new Error("reach-probe: start the dev Zen with ZENIUS_DEV_PREFS=tests/snapshot/tools/reach-prefs.js (fake camera)");
  }
  // The site may use the camera, as a site the user uses may: a stored grant.
  await chrome(`for (const b of arg) Services.perms.addFromPrincipal(Services.scriptSecurityManager.createContentPrincipalFromOrigin(b), "camera", Services.perms.ALLOW_ACTION); return true;`, [A.base]);
  for (const [path, run] of todo) {
    if (path === "keptPair") {
      results.push(await keptPairRun());
      continue;
    }
    if (path === "holdPlanted" || path === "keptPlanted") {
      results.push(await plantedRun(path.replace("Planted", "")));
      continue;
    }
    if (path === "keptWritten") {
      results.push(await plantedRun("kept", { write: true }));
      continue;
    }
    if (!PATHS[path]) {
      results.push({ path, run, error: `no path ${path}` });
      continue;
    }
    results.push(await runPath(path, run));
  }
} catch (e) {
  results.push({ error: String(e?.message ?? e) });
} finally {
  await chrome(`for (const b of arg) Services.perms.removeFromPrincipal(Services.scriptSecurityManager.createContentPrincipalFromOrigin(b), "camera"); return true;`, [A.base]).catch(() => {});
  print();
  kit.close();
}
