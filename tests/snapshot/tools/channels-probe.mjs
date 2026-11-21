// Same-origin channels that need no window handle, between the agent's page
// and the user's tab on the same site (docs/research/user-tab-reach.md,
// "Channels without a window handle"): BroadcastChannel, storage events and
// a SharedWorker, and the state behind them (localStorage, cookies).
// - a: a task page (spaces.create, the agent's container) and the user's
//   tab;
// - b: a claimed tab (adopted after the user allows the claim, still in the
//   user's container) and the user's other tab, in a second Space that the
//   task doesn't claim.
// - twoTasks: pages of two tasks on the same site, and then one task's
//   kept page and the other's page;
// - kept: after a finish that keeps the agent's page T and a same-site
//   popup P2 it opened, T's planted code makes channels in T, in P2 and in
//   a frame of P2.
// Each side speaks once on every channel, and the other side's page says
// what it heard. The agent speaks with page.evaluate; the user's tab is read
// and driven with dev#evalContent, which marks nothing.
//
// Since zen-observe's a018702 a task's BroadcastChannels are its own (a
// constructor wrapper in its documents and workers). In a and b the agent's
// code then also tries other ways to a channel (bypassRun): the prototype's
// constructor, a frame's constructor (a fresh about:blank one, srcdoc, a
// same-site URL), a fresh popup's, and workers (classic, module, nested,
// shared, one started from the fresh frame).
//
//   ZENIUS_INSTANCE=<dev profile> node tests/snapshot/tools/channels-probe.mjs [a] [aContainer] [b] [kept] [twoTasks]
//
// Dev profiles only, loopback fixtures only. Each case closes the tabs and
// the Space it opened and finishes its task.
import { openKit, runProbes } from "./owntab-kit.mjs";

const kit = await openKit();
const { call, chrome, ev, A, sleep, cleanUp } = kit;
const step = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const CHAN = `${A.base}/chan`;

/** Chrome-side helpers: tabs by browserId, their container, opening a /chan tab in a Space. */
const H = `
  const byId = id => all().find(t => t.linkedBrowser?.browserId === id);
  const containerOf = t => {
    const bc = t.linkedBrowser.browsingContext;
    return { userContextId: bc.originAttributes?.userContextId ?? null, suffix: t.linkedBrowser.contentPrincipal?.originSuffix ?? null };
  };
  const ready = t => until(async () => (await inContent(t, "return window.__chanReady === true")) === true, 8000);
  const openIn = async (uuid, url) => {
    if (gZenWorkspaces.activeWorkspace !== uuid) await gZenWorkspaces.changeWorkspaceWithID(uuid);
    const t = gBrowser.addTrustedTab(url, { inBackground: false });
    await until(() => t.linkedBrowser.currentURI.spec === url && loaded(t), 10000);
    await ready(t);
    return t;
  };
  // The profile's first Space that isn't the Agents Space: task Spaces come after it.
  const userSpace = () => gZenWorkspaces.getWorkspaces().find(x => x.uuid !== ctx.spaces.agentsSpace.uuid);
`;

/** What one page heard from the other: each channel, and the shared state it sees. */
function heard(log, tag) {
  const mine = (log ?? []).filter(e => JSON.stringify(e).includes(tag));
  return {
    broadcast: mine.some(e => e.via === "broadcast"),
    storage: mine.some(e => e.via === "storage"),
    worker: mine.filter(e => e.via === "worker").map(e => e.data?.ports ?? e.error ?? null),
  };
}

/**
 * One exchange between the agent's page (space, label) and the user's tab
 * (by browserId): the agent speaks, then the user.
 */
async function exchange(space, label, userId) {
  const agentRead = () => ev(space, label, "() => ({ chan: window.__chan.splice(0), peek: window.__peek() })");
  const userRead = () => chrome(H + `return { chan: await inContent(byId(arg), "return window.__chan.splice(0)"), peek: await inContent(byId(arg), "return window.__peek()") };`, userId);
  // The workers' own greetings and earlier traffic aren't part of it.
  await agentRead();
  await userRead();
  await ev(space, label, "() => window.__send('from-agent')");
  await sleep(800);
  const u1 = await userRead();
  const a1 = await agentRead();
  await chrome(H + `return inContent(byId(arg), "return window.__send('from-user')");`, userId);
  await sleep(800);
  const a2 = await agentRead();
  const u2 = await userRead();
  return {
    agentToUser: { ...heard(u1.chan, "from-agent"), userSeesLocal: u1.peek.local?.startsWith("from-agent") ?? false, userSeesCookie: /zschan=from-agent/.test(u1.peek.cookie) },
    agentOwnEcho: heard(a1.chan, "from-agent").worker,
    userToAgent: { ...heard(a2.chan, "from-user"), agentSeesLocal: a2.peek.local?.startsWith("from-user") ?? false, agentSeesCookie: /zschan=from-user/.test(a2.peek.cookie) },
    userOwnEcho: heard(u2.chan, "from-user").worker,
  };
}

/**
 * The agent's ways to a channel named "zs-chan" in its page. Each route
 * says "from-agent-<route>" once and logs what it hears, in window.__bp.
 * Workers pass on what they hear. A button (#bpPopup) makes the popup route
 * on the agent's click, since a popup needs one. No template literals
 * inside: this is a template literal itself.
 */
const BYPASS_SETUP = `async () => {
  const bp = (window.__bp = {});
  const note = (v, ch) => {
    bp[v] = { heard: [], name: null, error: null };
    try {
      bp[v].name = ch.name;
      ch.onmessage = e => bp[v].heard.push(e.data);
      ch.postMessage("from-agent-" + v);
    } catch (e) {
      bp[v].error = String(e);
    }
  };
  const tryV = (v, f) => {
    try {
      note(v, f());
    } catch (e) {
      bp[v] = { heard: [], name: null, error: String(e) };
    }
  };
  tryV("plain", () => new BroadcastChannel("zs-chan"));
  tryV("protoCtor", () => new BroadcastChannel.prototype.constructor("zs-chan"));
  const blank = document.createElement("iframe");
  document.body.append(blank);
  tryV("blankFrame", () => new blank.contentWindow.BroadcastChannel("zs-chan"));
  const loaded = f => new Promise(r => { f.onload = () => r(true); setTimeout(() => r(false), 5000); });
  const srcdoc = document.createElement("iframe");
  srcdoc.srcdoc = "<p>srcdoc</p>";
  const l1 = loaded(srcdoc);
  document.body.append(srcdoc);
  await l1;
  tryV("srcdocFrame", () => new srcdoc.contentWindow.BroadcastChannel("zs-chan"));
  const url = document.createElement("iframe");
  url.src = "/lab";
  const l2 = loaded(url);
  document.body.append(url);
  await l2;
  tryV("urlFrame", () => new url.contentWindow.BroadcastChannel("zs-chan"));
  const body = v => 'const c = new BroadcastChannel("zs-chan"); c.onmessage = e => postMessage({ heard: e.data }); c.postMessage("from-agent-' + v + '"); postMessage({ ready: c.name });';
  const blob = code => URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  const make = (v, f) => {
    bp[v] = { heard: [], name: null, error: null };
    try {
      const w = f();
      const port = w.port ?? w;
      port.onmessage = e => {
        if ("heard" in e.data) bp[v].heard.push(e.data.heard);
        if ("ready" in e.data) bp[v].name = e.data.ready;
      };
      w.onerror = e => { bp[v].error = "error event " + (e.message ?? ""); };
      w.port?.start();
    } catch (e) {
      bp[v].error = String(e);
    }
  };
  make("worker", () => new Worker(blob(body("worker"))));
  make("moduleWorker", () => new Worker(blob(body("moduleWorker")), { type: "module" }));
  make("nestedWorker", () => new Worker(blob('const i = new Worker(URL.createObjectURL(new Blob([' + JSON.stringify(body("nestedWorker")) + '], { type: "text/javascript" }))); i.onmessage = e => postMessage(e.data);')));
  make("frameWorker", () => new blank.contentWindow.Worker(blob(body("frameWorker"))));
  make("sharedWorker", () => new SharedWorker(blob('onconnect = e => { const p = e.ports[0]; const c = new BroadcastChannel("zs-chan"); c.onmessage = m => p.postMessage({ heard: m.data }); c.postMessage("from-agent-sharedWorker"); p.postMessage({ ready: c.name }); };')));
  const b = document.createElement("button");
  b.id = "bpPopup";
  b.textContent = "popup";
  b.style = "position:fixed;left:0;top:0;z-index:9";
  b.onclick = () => {
    const w = (window.__bpWin = window.open(""));
    tryV("blankPopup", () => new w.BroadcastChannel("zs-chan"));
  };
  document.body.prepend(b);
  return Object.keys(bp);
}`;

/**
 * The agent's routes to a channel in its page (BYPASS_SETUP), then the
 * user's tab speaks once. For each route: does the user's tab hear it, and
 * does it hear the user's tab? The routes hearing each other shows they
 * share the task's scope.
 */
async function bypassRun(space, label, userId, { popup = true } = {}) {
  const userLog = () => chrome(H + `return inContent(byId(arg), "return window.__chan.splice(0)");`, userId);
  await userLog();
  const set = await ev(space, label, BYPASS_SETUP);
  let popups = null;
  if (popup) {
    popups = await call("page.click", { space, page: label, target: "#bpPopup", options: {} }).then(
      r => (r?.popups ?? []).map(p => p.label),
      e => e.code ?? String(e.message).slice(0, 120)
    );
  }
  // The workers start, then speak.
  for (let i = 0; i < 20; i++) {
    const ready = await ev(space, label, "() => Object.values(window.__bp).every(x => x.name !== null || x.error)");
    if (ready === true) break;
    await sleep(250);
  }
  await sleep(800);
  const userHeard = (await userLog()).filter(e => e.via === "broadcast").map(e => String(e.data));
  await chrome(H + `return inContent(byId(arg), "return window.__send('from-user-bp')");`, userId);
  await sleep(1000);
  const bp = await ev(space, label, "() => JSON.parse(JSON.stringify(window.__bp))");
  if (popup) await ev(space, label, "() => { window.__bpWin?.close(); return true; }").catch(() => {});
  const routes = {};
  for (const [v, r] of Object.entries(bp)) {
    const heard = (r.heard ?? []).map(String);
    routes[v] = {
      reachesUser: userHeard.includes(`from-agent-${v}`),
      hearsUser: heard.includes("from-user-bp"),
      hearsOtherRoutes: heard.filter(x => x.startsWith("from-agent-")).length,
      name: r.name,
      ...(r.error ? { error: r.error } : {}),
    };
  }
  return { set, popups, userHeardFromAgent: userHeard.filter(x => x.startsWith("from-agent-")), routes };
}

/** A task page and the user's tab: the task opens with profileId (spaces.create), the user's tab in the default container. */
async function taskCase(name, profileId, { bypass = false } = {}) {
  const { id: space } = await call("spaces.create", { name: `${name} ${Date.now().toString(36).slice(-4)}`, ...(profileId ? { profileId } : {}) });
  await call("page.goto", { space, page: "p1", url: CHAN });
  let userId = null;
  try {
    const agentTab = await chrome(H + `const t = ctx.resolvePage({ space: arg, page: "p1" }).tab; await ready(t); return { id: t.linkedBrowser.browserId, ...containerOf(t) };`, space);
    const user = await chrome(H + `const t = await openIn(userSpace().uuid, arg); return { id: t.linkedBrowser.browserId, ...containerOf(t) };`, CHAN);
    userId = user.id;
    step(name, "agent", JSON.stringify(agentTab), "user", JSON.stringify(user));
    const r = { profileId: profileId ?? "default", containers: { agent: agentTab, user }, ...(await exchange(space, "p1", userId)) };
    if (bypass) {
      step(name, "bypass routes");
      r.bypass = await bypassRun(space, "p1", userId);
    }
    return r;
  } finally {
    if (userId) await chrome(H + `const t = byId(arg); if (t) gBrowser.removeTab(t, { animate: false }); return true;`, userId).catch(() => {});
    await cleanUp([space]);
  }
}

/**
 * Planted in T during the task: a button that opens P2 (same site), a
 * channel made now, and a poller that, when T's document asks after the
 * task, makes channels in T, in P2, and in fresh frames of both, and speaks
 * on them and on the one made during the task.
 */
const KEPT_PLANT = url => `() => {
  const kp = (window.__kp = { heard: {}, names: {} });
  const watch = (k, ch) => {
    kp.heard[k] = [];
    kp.names[k] = ch.name;
    ch.onmessage = e => kp.heard[k].push(e.data);
    return ch;
  };
  const b = document.createElement("button");
  b.id = "kp2";
  b.textContent = "P2";
  b.style = "position:fixed;left:0;top:40px;z-index:9";
  b.onclick = () => { window.__p2 = window.open(${JSON.stringify(url)}, "zsKP2"); };
  document.body.prepend(b);
  const during = watch("duringTask", new BroadcastChannel("zs-chan"));
  window.__kpPoll = setInterval(() => {
    if (document.documentElement.dataset.go !== "1") return;
    delete document.documentElement.dataset.go;
    const r = [];
    const act = (k, f) => {
      try {
        f();
        r.push(k);
      } catch (e) {
        r.push(k + " " + e);
      }
    };
    act("duringTask", () => during.postMessage("from-kept-duringTask"));
    act("T", () => watch("T", new BroadcastChannel("zs-chan")).postMessage("from-kept-T"));
    act("Tframe", () => {
      const f = document.createElement("iframe");
      document.body.append(f);
      watch("Tframe", new f.contentWindow.BroadcastChannel("zs-chan")).postMessage("from-kept-Tframe");
    });
    act("P2", () => watch("P2", new window.__p2.BroadcastChannel("zs-chan")).postMessage("from-kept-P2"));
    act("P2frame", () => {
      const f = window.__p2.document.createElement("iframe");
      window.__p2.document.body.append(f);
      watch("P2frame", new f.contentWindow.BroadcastChannel("zs-chan")).postMessage("from-kept-P2frame");
    });
    document.documentElement.dataset.done = r.join(",");
  }, 100);
  return true;
}`;

const cases = {
  /** a, with a container profile: a container made for the probe, removed after. */
  async aContainer() {
    const made = await chrome(
      `const { ContextualIdentityService: CIS } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
       return CIS.create("zs agent", "fingerprint", "blue").userContextId;`
    );
    try {
      const profiles = await call("profiles.list", {});
      const r = await taskCase("channels ac", `container-${made}`);
      return { profiles: profiles.profiles.map(x => x.id), ...r };
    } finally {
      await chrome(
        `const { ContextualIdentityService: CIS } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
         return CIS.remove(arg);`,
        made
      ).catch(e => step("removing the container failed:", e.message));
    }
  },

  /** a: a task page with the default profile (the user's cookies and logins, SPEC 3.4), and the user's tab. */
  async a() {
    return taskCase("channels a", null, { bypass: true });
  },

  /** b: a claimed tab, in the user's container, and the user's other tab in a second Space. */
  async b() {
    const setup = await chrome(
      H +
        `
      const ws = userSpace();
      const claimed = await openIn(ws.uuid, arg);
      const second = (await gZenWorkspaces.createAndSaveWorkspace("zs channels", undefined, true)).uuid;
      const other = await openIn(second, arg);
      await gZenWorkspaces.changeWorkspaceWithID(ws.uuid);
      return {
        space: ctx.spaces.peekUuid(ws.uuid).id,
        second,
        claimed: { id: claimed.linkedBrowser.browserId, tab: ctx.service.pages.tabId(claimed), ...containerOf(claimed) },
        user: { id: other.linkedBrowser.browserId, ...containerOf(other) },
      };
    `,
      CHAN
    );
    try {
      const claim = call("spaces.claim", { space: setup.space, client: "red team", timeout: 20000 });
      claim.catch(() => {});
      await call("dev.answerClaim", { space: setup.space, timeout: 10000 });
      await claim;
      const { label } = await call("pages.adopt", { space: setup.space, tab: setup.claimed.tab });
      const after = await chrome(H + `return containerOf(byId(arg));`, setup.claimed.id);
      step("b: claimed", JSON.stringify(setup.claimed), "after adoption", JSON.stringify(after), "user", JSON.stringify(setup.user));
      const r = { containers: { claimed: setup.claimed, claimedAfterAdoption: after, user: setup.user }, ...(await exchange(setup.space, label, setup.user.id)) };
      // Channels the claimed tab's document makes after adoption.
      step("b: bypass routes");
      r.bypass = await bypassRun(setup.space, label, setup.user.id, { popup: false });
      return r;
    } finally {
      await call("spaces.finish", { space: setup.space, keep: [] }).catch(() => {});
      await chrome(
        H +
          `
        for (const id of arg.ids) { const t = byId(id); if (t) gBrowser.removeTab(t, { animate: false }); }
        gZenWorkspaces.removeWorkspace(arg.second);
        await until(async () => !(await gZenWorkspaces.getWorkspaces()).some(w => w.uuid === arg.second), 5000);
        return true;
      `,
        { ids: [setup.claimed.id, setup.user.id], second: setup.second }
      ).catch(e => step("b cleanup failed:", e.message));
      await kit.cleanTabs().catch(() => {});
    }
  },

  /**
   * kept: T (where the agent's code ran) and P2, a same-site popup T opened,
   * kept at the finish. Then T's planted code acts (KEPT_PLANT), and the
   * user's tab speaks once.
   */
  async kept() {
    const { id: space } = await call("spaces.create", { name: `channels kept ${Date.now().toString(36).slice(-4)}` });
    const ids = [];
    let finished = false;
    try {
      await call("page.goto", { space, page: "p1", url: CHAN });
      const user = await chrome(H + `const t = await openIn(userSpace().uuid, arg); return { id: t.linkedBrowser.browserId };`, CHAN);
      ids.push(user.id);
      await ev(space, "p1", KEPT_PLANT(CHAN));
      const click = await call("page.click", { space, page: "p1", target: "#kp2", options: {} });
      const p2 = click?.popups?.[0]?.label ?? null;
      const tabs = await chrome(
        H +
          `
        const r = { T: ctx.resolvePage({ space: arg.space, page: "p1" }).tab.linkedBrowser.browserId, P2: null };
        if (arg.p2) {
          const t = ctx.resolvePage({ space: arg.space, page: arg.p2 }).tab;
          r.P2 = t.linkedBrowser.browserId;
          await ready(t);
        }
        return r;
      `,
        { space, p2 }
      );
      ids.push(tabs.T, tabs.P2);
      const finish = await call("spaces.finish", { space, keep: ["p1", ...(p2 ? [p2] : [])] }).then(
        () => "kept",
        e => e.code ?? String(e.message).slice(0, 120)
      );
      finished = true;
      await sleep(800);
      const userLog = () => chrome(H + `return inContent(byId(arg), "return window.__chan.splice(0)");`, user.id);
      await userLog();
      step("kept: T's planted code acts");
      const acted = await chrome(
        H +
          `
        const t = byId(arg);
        await inContent(t, "document.documentElement.dataset.go = '1'; return true;");
        let done = null;
        await until(async () => (done = await inContent(t, "return document.documentElement.dataset.done ?? null")) !== null, 5000).catch(() => {});
        return done;
      `,
        tabs.T
      );
      await sleep(1000);
      const userHeard = (await userLog()).filter(e => e.via === "broadcast").map(e => String(e.data));
      await chrome(H + `return inContent(byId(arg), "return window.__send('from-user-kept')");`, user.id);
      await sleep(1000);
      const kp = await chrome(H + `return inContent(byId(arg), "return JSON.parse(JSON.stringify(window.__kp))");`, tabs.T);
      const channels = {};
      for (const [k, heard] of Object.entries(kp.heard)) {
        channels[k] = { hearsUser: heard.map(String).includes("from-user-kept"), heard: heard.map(String), name: kp.names[k] };
      }
      return { p2, finish, acted, userHeardFromKept: userHeard.filter(x => x.startsWith("from-kept-")), channels };
    } finally {
      await chrome(H + `for (const id of arg) { const t = byId(id); if (t) gBrowser.removeTab(t, { animate: false }); } return true;`, ids.filter(Boolean)).catch(e =>
        step("kept cleanup failed:", e.message)
      );
      if (!finished) {
        await cleanUp([space]);
      } else {
        await kit.cleanTabs().catch(() => {});
      }
    }
  },

  /**
   * twoTasks: pages of two tasks on the same site. A's page speaks with
   * page.evaluate, and B's page takes the user's side of exchange(). Then A
   * finishes keeping its page, and the kept page and B's page speak again,
   * both driven with dev#evalContent. BroadcastChannel is scoped per task;
   * the shared worker's mark is the same for every task's pages.
   */
  async twoTasks() {
    const a = (await call("spaces.create", { name: `channels A ${Date.now().toString(36).slice(-4)}` })).id;
    const b = (await call("spaces.create", { name: `channels B ${Date.now().toString(36).slice(-4)}` })).id;
    let aDone = false;
    const ids = [];
    try {
      await call("page.goto", { space: a, page: "p1", url: CHAN });
      await call("page.goto", { space: b, page: "p1", url: CHAN });
      const aTab = await chrome(H + `const t = ctx.resolvePage({ space: arg, page: "p1" }).tab; await ready(t); return { id: t.linkedBrowser.browserId, ...containerOf(t) };`, a);
      const bTab = await chrome(H + `const t = ctx.resolvePage({ space: arg, page: "p1" }).tab; await ready(t); return { id: t.linkedBrowser.browserId, ...containerOf(t) };`, b);
      ids.push(aTab.id);
      const live = await exchange(a, "p1", bTab.id);
      await call("spaces.finish", { space: a, keep: ["p1"] });
      aDone = true;
      await sleep(800);
      const log = id => chrome(H + `return { chan: await inContent(byId(arg), "return window.__chan.splice(0)") };`, id);
      const send = (id, tag) => chrome(H + `return inContent(byId(arg.id), "return window.__send(" + JSON.stringify(arg.tag) + ")");`, { id, tag });
      await log(aTab.id);
      await log(bTab.id);
      await send(aTab.id, "from-keptA");
      await sleep(800);
      const b1 = await log(bTab.id);
      const a1 = await log(aTab.id);
      await send(bTab.id, "from-B");
      await sleep(800);
      const a2 = await log(aTab.id);
      const b2 = await log(bTab.id);
      return {
        note: "live: agentToUser is task A's page to task B's, userToAgent is B to A",
        containers: { a: aTab, b: bTab },
        live,
        keptAtoB: { ...heard(b1.chan, "from-keptA"), keptOwnEcho: heard(a1.chan, "from-keptA").worker },
        BtoKeptA: { ...heard(a2.chan, "from-B"), bOwnEcho: heard(b2.chan, "from-B").worker },
      };
    } finally {
      if (aDone) {
        await chrome(H + `for (const id of arg) { const t = byId(id); if (t) gBrowser.removeTab(t, { animate: false }); } return true;`, ids).catch(() => {});
      }
      await cleanUp(aDone ? [b] : [a, b]);
    }
  },
};

await runProbes(cases, process.argv.slice(2).length ? process.argv.slice(2) : ["a", "aContainer", "b", "kept", "twoTasks"], kit);
