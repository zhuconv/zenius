// The hold map (docs/research/user-tab-reach.md, "The hold"). The manager's
// rule (2026-11-20): while the user types in the page H they hold after a
// hand-off, nothing of the agent's reaches it. This maps, headless on the Linux server
// with loopback fixtures only, where H sits (PATHS) against what the agent
// could do during the hold (RUNS).
// - Paths. The agent's page T (site A) always runs the agent's code, planted
//   before the hold (T_PLANT). H is:
//   - popupXS: a sign-in popup of site B that T opened;
//   - popupSS: such a popup of T's site;
//   - popupRet: a popup of site B that returns to T's site during the hold,
//     by its own load (a sign-in redirect);
//   - page: another page of the task on T's site, with no opener;
//   - codePage: such a page where the agent's code ran too (H_PLANT);
//   - madePage: a page the agent made (data:), check only.
// - Runs:
//   - check: whether H needs a clean copy at the hand-off, from zen-core's
//     own decision (needsCleanCopy(evidenceOf(H)), modules/handoff.sys.mjs),
//     and whether H was reloaded or moved to a new group;
//   - agentCode: the agent's calls during the hold, on H and on T;
//   - keys: the user types in H's fields; what code planted earlier in T
//     (through its handle, and the site's own sync) and in H captured;
//   - channels: H's site code speaks on its load-time channels and on a new
//     one, and T's planted code speaks back, and posts H a message;
//   - windows: new windows from T's code, from a timer and on the user's
//     click, and H's own popup;
//   - loads: loads into H and its frame that T's code starts;
//   - backData, backBlob: Back into an entry the agent made before the hold.
// spaces.handOff holds the task's front page (zen-core's ab3e065), so the
// probe shows H's tab first. The probe holds nothing itself: each result
// lists what the hand-off held (handOff.held), and a hand-off that holds
// nothing says so there. A refused hand-off skips the run.
//
//   scripts/zen-dev.sh zen-snapshot start
//   ZENIUS_INSTANCE=zen-snapshot node tests/snapshot/tools/hold-probe.mjs [path[:run] ...]
//
// Dev profiles only, loopback fixtures only. Each case hands the task back,
// ends the hold, finishes the task and closes the tabs it opened. The user's
// clicks and keys come from the parent, as in the other probes.
import { openKit } from "./owntab-kit.mjs";

if (process.platform === "darwin") {
  console.error("hold-probe: headless on the Linux server only");
  process.exit(2);
}

const kit = await openKit();
const { call, chrome, A, B, sleep } = kit;
const step = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const q = v => encodeURIComponent(v);
const brief = e => `${e?.code ?? ""}: ${String(e?.message ?? e).slice(0, 160)}`;
/** page.evaluate; a refusal is a result here. */
const ev = (space, page, fn) => kit.ev(space, page, fn).catch(e => ({ refused: brief(e) }));
const outcome = p => p.then(r => r ?? "ok", e => ({ error: brief(e) }));
const holdUrl = (base, role, name) => `${base}/hold?role=${role}&name=${name}`;
const reachUrl = (base, role, name) => `${base}/reach?role=${role}&name=${name}&a=${q(A.base)}&b=${q(B.base)}`;
/** Where T's code sends H: each load says which act started it. */
const target = via => `${A.base}/hold-frame?via=${via}`;

/** Chrome-side helpers, after the kit's. */
const C = `
  // T's planted record (window.__tp): in the page's JavaScript where the
  // agent's code runs there (main before the isolated world), else in the
  // agent's world. A discarded world reads as a fresh one, without it.
  const tpEval = async (t, body) => {
    if (await inContent(t, "return typeof window.__tp === 'object' && window.__tp !== null")) return inContent(t, body);
    const code =
      "let AW; try { AW = ChromeUtils.importESModule('chrome://userscripts/content/zenius/content/agentworld.sys.mjs'); } catch (e) { return null; }" +
      "if (typeof AW.worldFor !== 'function') return null;" +
      "const w = AW.worldFor(window);" +
      "return JSON.parse(Components.utils.evalInSandbox('JSON.stringify((() => {' + " + JSON.stringify(body) + " + '})() ?? null)', w.sandbox));";
    return inContent(t, code, true);
  };
  const R = (win.__holdmap ??= { roles: {} });
  const topById = id => BrowsingContext.getCurrentTopByBrowserId(id);
  const tabById = id => {
    const el = topById(id)?.embedderElement;
    return el ? el.ownerDocument.defaultView.gBrowser.getTabForBrowser(el) : null;
  };
  const roleOfId = id => Object.entries(R.roles).find(([, v]) => v === id)?.[0] ?? null;
  const heldMap = () => Services.ppmm.sharedData.get("zenius:heldPages") ?? new Map();
  const taskIds = () => Services.ppmm.sharedData.get("zenius:taskBrowserIds") ?? new Set();
  const short = u => (u ?? "").replace(/^http:\\/\\/127\\.0\\.0\\.1:\\d+/, "A").replace(/^http:\\/\\/127\\.0\\.0\\.2:\\d+/, "B").replace(/&a=.*$/, "").slice(0, 90);
  const show = async t => {
    const w = t.ownerDocument.defaultView;
    const ws = t.getAttribute("zen-workspace-id");
    if (ws && w.gZenWorkspaces.activeWorkspace !== ws) await w.gZenWorkspaces.changeWorkspaceWithID(ws);
    w.gBrowser.selectedTab = t;
    await until(() => w.gBrowser.selectedTab === t, 3000).catch(() => {});
    await sleep(250);
  };
  // The user's click on sel, from the parent.
  const userClick = async (t, sel) => {
    await show(t);
    const at = await inContent(t, "const r = document.querySelector(" + JSON.stringify(sel) + ").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2];");
    const w = t.ownerDocument.defaultView;
    const r = t.linkedBrowser.getBoundingClientRect();
    const send = (type, buttons = 0) => w.synthesizeMouseEvent(type, r.left + at[0], r.top + at[1],
      { identifier: 0, button: 0, buttons, clickCount: 1, modifiers: 0, inputSource: 1 },
      { isDOMEventSynthesized: false, isWidgetEventSynthesized: false, isAsyncEnabled: false });
    send("mousemove"); await sleep(30); send("mousedown", 1); await sleep(40); send("mouseup");
  };
  // The user's keys, from the parent: a text input processor on the chrome window.
  const userKeys = async text => {
    const tip = (win.__holdTip ??= Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor));
    if (!tip.beginInputTransactionForTests(win)) throw new Error("no keyboard transaction on the chrome window");
    for (const ch of text) {
      const up = ch.toUpperCase();
      const k = new win.KeyboardEvent("", { key: ch, code: /[0-9]/.test(ch) ? "Digit" + ch : "Key" + up, keyCode: up.charCodeAt(0) });
      tip.keydown(k);
      tip.keyup(k);
      await sleep(20);
    }
  };
  // Each role's tab: where it is, its group and opener, its hold.
  const state = () => {
    const out = {};
    for (const [role, id] of Object.entries(R.roles)) {
      const bc = topById(id);
      const t = tabById(id);
      if (!bc || !t) {
        out[role] = { closed: true };
        continue;
      }
      const frame = bc.children[0] ?? null;
      out[role] = {
        url: short(bc.currentURI?.spec),
        title: t.label,
        doc: bc.currentWindowGlobal?.innerWindowId ?? null,
        group: bc.group?.id ?? null,
        opener: bc.opener ? roleOfId(bc.opener.top.browserId) ?? "other" : null,
        held: heldMap().has(id) ? roleOfId(heldMap().get(id)) ?? "other" : null,
        task: taskIds().has(id),
        marked: AC.agentCodeDocument(t.linkedBrowser),
        frame: frame ? short(frame.currentURI?.spec) : null,
        frameDoc: frame?.currentWindowGlobal?.innerWindowId ?? null,
      };
    }
    return out;
  };
  const ready = async t => {
    await until(async () => {
      try {
        return (await inContent(t, "return window.__holdReady === true")) === true;
      } catch {
        return false;
      }
    }, 8000);
  };
`;

/**
 * The agent's code in T, planted before the hold (page.evaluate):
 * - the site's channels, joined by the agent's code: a BroadcastChannel,
 *   storage events and the shared worker of the hold page's names;
 * - #openH, which opens H as a popup on the agent's click (paths popup*);
 * - #openW, a button whose handler opens a window, for the user's click;
 * - a poller that reads H through T's handle and listens to its keys, again
 *   on each new document of H;
 * - acts the probe asks for by a data attribute on T's document, set with
 *   dev#evalContent (which marks nothing).
 * No template literals inside: this is one.
 */
const T_PLANT = ({ hUrl, hName }) => `() => {
  const t = (window.__tp = { heard: [], keys: [], values: null, valueErr: null, acts: {} });
  const ch = new BroadcastChannel("zs-hold");
  ch.onmessage = e => t.heard.push({ via: "broadcast", data: e.data });
  addEventListener("storage", e => { if (e.key === "zs-hold") t.heard.push({ via: "storage", data: e.newValue }); });
  let port = null;
  try {
    const w = new SharedWorker("/chan-worker.js", "zs-hold");
    port = w.port;
    port.onmessage = e => t.heard.push({ via: "worker", data: e.data });
    port.start();
  } catch (e) {
    t.heard.push({ via: "worker", error: String(e) });
  }
  const button = (id, top, onclick) => {
    const b = document.createElement("button");
    b.id = id;
    b.textContent = id;
    b.style = "position:fixed;left:0;top:" + top + "px;z-index:9";
    b.onclick = onclick;
    document.body.prepend(b);
  };
  const H_URL = ${JSON.stringify(hUrl)};
  const H_NAME = ${JSON.stringify(hName)};
  const X = ${JSON.stringify(Object.fromEntries(["open", "click", "href", "named", "link", "frame", "frameNamed"].map(v => [v, target(v)])))};
  const FORM = ${JSON.stringify(`${A.base}/hold-frame`)};
  if (H_URL) button("openH", 0, () => { window.__ph = window.open(H_URL, H_NAME); });
  button("openW", 30, () => {
    try {
      const w = window.open(X.click, "zsWclick");
      t.acts.clickOpen = w ? "opened" : "null";
    } catch (e) {
      t.acts.clickOpen = e.name + ": " + e.message;
    }
  });
  setInterval(() => {
    const h = window.__ph;
    if (!h) return;
    try {
      const d = h.document;
      t.values = { user: d.getElementById("user")?.value ?? null, secret: d.getElementById("secret")?.value ?? null };
      if (!d.__tpKeys) {
        d.__tpKeys = true;
        d.addEventListener("keydown", e => t.keys.push(e.key), true);
      }
      t.valueErr = null;
    } catch (e) {
      t.valueErr = e.name;
    }
  }, 100);
  const ACTS = {
    send: () => { ch.postMessage("from-T"); localStorage.setItem("zs-hold", "from-T " + Date.now()); port?.postMessage("from-T"); return "sent"; },
    post: () => { window.__ph.postMessage("from-T-post", "*"); return "posted"; },
    open: () => (window.open(X.open, "zsWtimer") ? "opened" : "null"),
    frame: () => { window.__ph.frames[0].location.href = X.frame; return "set"; },
    frameNamed: () => (window.open(X.frameNamed, "zsHF") ? "a window" : "null"),
    reload: () => { window.__ph.location.reload(); return "called"; },
    back: () => { window.__ph.history.back(); return "called"; },
    href: () => { window.__ph.location.href = X.href; return "set"; },
    named: () => { const w = window.open(X.named, H_NAME); return w ? (w === window.__ph ? "H" : "another window") : "null"; },
    link: () => { const a = document.createElement("a"); a.href = X.link; a.target = H_NAME; document.body.append(a); a.click(); return "clicked"; },
    form: () => {
      const f = document.createElement("form");
      f.action = FORM;
      f.method = "get";
      f.target = H_NAME;
      const i = document.createElement("input");
      i.name = "via";
      i.value = "form";
      f.append(i);
      document.body.append(f);
      f.submit();
      return "submitted";
    },
  };
  setInterval(() => {
    const go = document.documentElement.dataset.go;
    if (!go) return;
    delete document.documentElement.dataset.go;
    let r;
    try {
      r = String(ACTS[go]());
    } catch (e) {
      r = e.name + ": " + String(e.message).slice(0, 100);
    }
    t.acts[go] = r;
    document.documentElement.dataset.done = go;
  }, 50);
  return true;
}`;

/** The agent's code in H itself (codePage): a key listener and a poller of its fields. */
const H_PLANT = `() => {
  const h = (window.__hp = { keys: [], values: null });
  document.addEventListener("keydown", e => h.keys.push(e.key), true);
  setInterval(() => {
    h.values = { user: document.getElementById("user").value, secret: document.getElementById("secret").value };
  }, 100);
  return true;
}`;

async function newSpace(name) {
  const { id } = await call("spaces.create", { name: `hold ${name} ${Date.now().toString(36).slice(-4)}` });
  return id;
}

/** The roles' browserIds, recorded on the chrome side for state(). */
async function setRoles(space, labels) {
  return chrome(
    C +
      `
    R.roles = {};
    for (const [role, label] of Object.entries(arg.labels)) {
      const t = ctx.resolvePage({ space: arg.space, page: label }).tab;
      R.roles[role] = t.linkedBrowser.browserId;
    }
    return R.roles;
  `,
    { space, labels }
  );
}

async function waitHeld(id) {
  return chrome(C + `await ready(tabById(arg)); return true;`, id);
}

/** A sign-in popup: T (site A) opens P on `base`, and P is H. */
async function popupPath(name, base) {
  const space = await newSpace(name);
  const env = { space, path: name, labels: { T: "p1" }, hName: "zsP", hUrl: holdUrl(base, "P", "zsP") };
  try {
    await call("page.goto", { space, page: "p1", url: reachUrl(A.base, "T", "zsT") });
    env.plant = await ev(space, "p1", T_PLANT({ hUrl: env.hUrl, hName: env.hName }));
    const click = await call("page.click", { space, page: "p1", target: "#openH", options: {} });
    env.labels.H = click?.popups?.[0]?.label ?? null;
    if (!env.labels.H) throw new Error(`no popup: ${JSON.stringify(click).slice(0, 200)}`);
    env.roles = await setRoles(space, env.labels);
    await waitHeld(env.roles.H);
    return env;
  } catch (e) {
    env.setupError = String(e?.message ?? e);
    return env;
  }
}

/** Another page of the task on T's site, with no opener; with the agent's code in it too (codePage). */
async function pagePath(name, withCode) {
  const space = await newSpace(name);
  const env = { space, path: name, labels: { T: "p1" }, hName: "zsH", hUrl: holdUrl(A.base, "H", "zsH") };
  try {
    await call("page.goto", { space, page: "p1", url: reachUrl(A.base, "T", "zsT") });
    env.plant = await ev(space, "p1", T_PLANT({ hUrl: null, hName: env.hName }));
    const { label } = await call("pages.new", { space, url: env.hUrl });
    env.labels.H = label;
    env.roles = await setRoles(space, env.labels);
    await waitHeld(env.roles.H);
    if (withCode) env.hPlant = await ev(space, label, H_PLANT);
    return env;
  } catch (e) {
    env.setupError = String(e?.message ?? e);
    return env;
  }
}

/** A page the agent made: a data: page with the same fields. */
async function madePath(name) {
  const space = await newSpace(name);
  const env = { space, path: name, labels: { T: "p1" }, hName: null, hUrl: null };
  try {
    await call("page.goto", { space, page: "p1", url: reachUrl(A.base, "T", "zsT") });
    env.plant = await ev(space, "p1", T_PLANT({ hUrl: null, hName: "zsH" }));
    const html = "<title>agent made</title><form><input id=user><input type=password id=secret></form>";
    const { label } = await call("pages.new", { space, url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
    env.labels.H = label;
    env.roles = await setRoles(space, env.labels);
    return env;
  } catch (e) {
    env.setupError = String(e?.message ?? e);
    return env;
  }
}

const PATHS = {
  popupXS: () => popupPath("popupXS", B.base),
  popupSS: () => popupPath("popupSS", A.base),
  popupRet: () => popupPath("popupRet", B.base),
  page: () => pagePath("page", false),
  codePage: () => pagePath("codePage", true),
  madePage: () => madePath("madePage"),
};

/** Ask T's planted code for an act and wait for its answer. */
async function act(env, name) {
  return chrome(
    C +
      `
    const t = tabById(arg.T);
    if (!t) return "no T";
    if (!(await tpEval(t, "return !!window.__tp"))) return "no planted code in T";
    await inContent(t, "delete document.documentElement.dataset.done; document.documentElement.dataset.go = " + JSON.stringify(arg.name) + "; return true;");
    await until(async () => (await inContent(t, "return document.documentElement.dataset.done ?? null")) === arg.name, 5000).catch(() => {});
    return tpEval(t, "return window.__tp ? window.__tp.acts[" + JSON.stringify(arg.name) + "] ?? null : 'no planted code in T'");
  `,
    { T: env.roles.T, name }
  );
}

/** The hand-off, through spaces.handOff alone: H's tab is what the user sees. */
async function handOff(env) {
  await chrome(C + `const t = tabById(arg); if (t) await show(t); return true;`, env.roles.H);
  // The control for tPlanted: T's planted code just before the hand-off.
  const tPlantedBefore = await chrome(C + `const t = tabById(arg); return t ? tpEval(t, "return !!window.__tp") : null;`, env.roles.T).catch(e => "unread: " + e.message);
  const api = await outcome(call("spaces.handOff", { space: env.space }));
  await sleep(600);
  const held = await chrome(C + `return [...heldMap().keys()].map(id => roleOfId(id) ?? "other");`);
  env.refused = !!api?.error;
  // After a quiet reload, H's new document.
  if (!env.refused && env.hUrl) await waitHeld(env.roles.H).catch(() => {});
  await sleep(300);
  const tPlanted = await chrome(C + `const t = tabById(arg); return t ? tpEval(t, "return !!window.__tp") : null;`, env.roles.T).catch(() => null);
  return { api: api?.ownership ? { ownership: api.ownership, ...(api.reloaded ? { reloaded: api.reloaded } : {}) } : api, held, tPlantedBefore, tPlanted };
}

/** popupRet: P's own load to T's site during the hold, as a sign-in returns. */
async function returnToT(env) {
  return chrome(
    C +
      `
    const h = tabById(arg.H);
    await inContent(h, "location.href = " + JSON.stringify(arg.url) + "; return true;").catch(() => {});
    await until(async () => {
      try {
        return (await inContent(h, "return window.__holdReady === true && location.host")) === arg.host;
      } catch {
        return false;
      }
    }, 8000).catch(() => {});
    return state().H;
  `,
    { H: env.roles.H, url: holdUrl(A.base, "Pret", "zsP"), host: new URL(A.base).host }
  );
}

const TYPED = { user: "alice", secret: "hunter2" };
const LOADS = ["frame", "frameNamed", "reload", "back", "href", "named", "link", "form"];
const BLOB_HTML = '<title>agent blob</title><button id=b>b</button><script>document.title = "agent blob ran"</scr' + 'ipt>';
const DATA_HTML = '<title>agent data</title><button id=b>b</button><script>document.title = "agent data ran"</scr' + 'ipt>';
/** The agent clicks in its own entry before leaving it: Back skips entries the user never interacted with. */
const clickMade = env => outcome(call("page.click", { space: env.space, page: env.labels.H, target: "#b", options: {} }));

/** Before the hand-off: the agent's own entry in H's history, then H's page again. */
const PRE = {
  async backData(env) {
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(DATA_HTML)}`;
    env.made = { goto: await outcome(call("page.goto", { space: env.space, page: env.labels.H, url })) };
    env.made.click = await clickMade(env);
    env.made.again = await outcome(call("page.goto", { space: env.space, page: env.labels.H, url: env.hUrl }));
    await waitHeld(env.roles.H);
  },
  async backBlob(env) {
    // T creates it, so it stays valid while T lives.
    const url = await ev(env.space, env.labels.T, `() => URL.createObjectURL(new Blob([${JSON.stringify(BLOB_HTML)}], { type: "text/html" }))`);
    env.made = { blob: typeof url === "string" ? url.replace(/^blob:http:\/\/127\.0\.0\.1:\d+/, "blob:A") : url };
    if (typeof url === "string") {
      env.made.goto = await outcome(call("page.goto", { space: env.space, page: env.labels.H, url }));
      env.made.click = await clickMade(env);
    }
    env.made.again = await outcome(call("page.goto", { space: env.space, page: env.labels.H, url: env.hUrl }));
    await waitHeld(env.roles.H);
  },
};

async function backRun(env) {
  const r = await chrome(
    C +
      `
    const t = tabById(arg);
    await show(t);
    const w = t.ownerDocument.defaultView;
    const b = t.linkedBrowser;
    const sh = b.browsingContext.sessionHistory;
    const entries = () => {
      const out = [];
      for (let i = 0; i < sh.count; i++) {
        const e = sh.getEntryAtIndex(i);
        out.push({ url: short(e.URI?.spec), interacted: e.hasUserInteraction });
      }
      return out;
    };
    const doc = () => b.browsingContext.currentWindowGlobal?.innerWindowId ?? null;
    const before = { index: sh.index, doc: doc(), entries: entries() };
    // The Back button.
    w.gBrowser.goBack();
    await sleep(1800);
    const afterBack = { url: short(b.currentURI.spec), title: t.label, index: sh.index, requestedIndex: sh.requestedIndex, newDoc: doc() !== before.doc };
    // The Back button's history menu: the user picks the agent's entry.
    const made = before.entries.findIndex(e => /^(data:|blob:)/.test(e.url));
    let afterMenu = null;
    if (made >= 0 && sh.index !== made) {
      b.gotoIndex(made);
      await sleep(1800);
      afterMenu = { url: short(b.currentURI.spec), title: t.label, index: sh.index, requestedIndex: sh.requestedIndex, newDoc: doc() !== before.doc };
    }
    return { before, afterBack, afterMenu };
  `,
    env.roles.H
  );
  return { made: env.made, ...r, ranOnBack: / ran$/.test(r.afterBack.title ?? ""), ranOnMenu: / ran$/.test(r.afterMenu?.title ?? "") };
}

const has = (log, tag) => [...new Set((log ?? []).filter(e => JSON.stringify(e).includes(tag)).map(e => e.via))];

const RUNS = {
  async check(env) {
    return chrome(
      C +
        `
      const h = topById(arg.H);
      const HO = ChromeUtils.importESModule('chrome://userscripts/content/zenius/modules/handoff.sys.mjs');
      const ev = HO.evidenceOf(h.embedderElement);
      return { page: HO.needsCleanCopy(ev), agentPage: ev.made !== undefined, hooked: ev.hooked !== undefined };
    `,
      { space: env.space, H: env.roles.H }
    );
  },

  async agentCode(env) {
    return {
      evaluateH: await ev(env.space, env.labels.H, "() => document.title"),
      evaluateT: await ev(env.space, env.labels.T, "() => document.title"),
      gotoH: await outcome(call("page.goto", { space: env.space, page: env.labels.H, url: target("agentGoto") })),
      clickT: await outcome(call("page.click", { space: env.space, page: env.labels.T, target: "#openW", options: {} })),
    };
  },

  async keys(env) {
    await chrome(
      C +
        `
      const h = tabById(arg.H);
      await userClick(h, "#user");
      await sleep(150);
      await userKeys(arg.typed.user);
      await userClick(h, "#secret");
      await sleep(150);
      await userKeys(arg.typed.secret);
      await sleep(700);
      return true;
    `,
      { H: env.roles.H, typed: TYPED }
    );
    const t = (await chrome(C + `return tpEval(tabById(arg), "return window.__tp ? JSON.parse(JSON.stringify(window.__tp)) : null");`, env.roles.T)) ?? { gone: true };
    const h = await chrome(
      C + `return inContent(tabById(arg), "return JSON.parse(JSON.stringify({ hp: window.__hp ?? null, user: document.getElementById('user')?.value ?? null, secret: document.getElementById('secret')?.value ?? null }))");`,
      env.roles.H
    );
    const synced = {};
    for (const e of t.heard ?? []) {
      const s = JSON.stringify(e.data ?? null);
      if (s.includes("typed")) synced[e.via] = s.slice(0, 60);
    }
    return {
      inH: { user: h.user, secret: h.secret },
      T: t.gone ? "no planted code in T" : { handle: t.values, handleErr: t.valueErr, keys: (t.keys ?? []).join(""), siteSync: synced },
      H: h.hp ? { keys: h.hp.keys.join(""), values: h.hp.values } : null,
    };
  },

  async channels(env) {
    const tRead = () => chrome(C + `return tpEval(tabById(arg), "return window.__tp ? window.__tp.heard.splice(0) : null");`, env.roles.T);
    const hRead = () => chrome(C + `return inContent(tabById(arg), "return window.__hold.splice(0)");`, env.roles.H);
    await tRead();
    await hRead();
    await chrome(C + `return inContent(tabById(arg), "__holdSend('from-H-pre'); __holdNew('from-H-new'); return true;");`, env.roles.H);
    await sleep(900);
    const t1 = await tRead();
    const sent = await act(env, "send");
    const posted = await act(env, "post");
    await sleep(900);
    const h1 = await hRead();
    return {
      outOfH: t1 === null ? "no planted code in T" : { loadTime: has(t1, "from-H-pre"), madeInHold: has(t1, "from-H-new") },
      intoH: { sent, posted, heard: has(h1, "from-T") },
    };
  },

  async windows(env) {
    const timer = await act(env, "open");
    const button = await chrome(
      C + `const t = tabById(arg); if (!(await inContent(t, "return !!document.getElementById('openW')"))) return false; await userClick(t, "#openW"); await sleep(1000); return true;`,
      env.roles.T
    );
    const clickOpen = await chrome(C + `return tpEval(tabById(arg), "return window.__tp ? window.__tp.acts.clickOpen ?? null : 'no planted code in T'");`, env.roles.T);
    await chrome(C + `await userClick(tabById(arg), "#pop"); await sleep(1500); return true;`, env.roles.H);
    const windows = await chrome(
      C +
        `
      const out = {};
      for (const t of all()) {
        const bc = t.linkedBrowser?.browsingContext;
        const n = bc?.name ?? "";
        if (!/^zsW|^zsHP$/.test(n)) continue;
        const id = t.linkedBrowser.browserId;
        out[n] = { url: short(bc.currentURI?.spec), opener: bc.opener ? roleOfId(bc.opener.top.browserId) ?? "other" : null, held: heldMap().has(id), task: taskIds().has(id), group: bc.group?.id === topById(R.roles.H)?.group?.id ? "H's" : "other" };
      }
      return out;
    `
    );
    return { timerOpen: timer, clickOpen: button ? clickOpen : "no button in T (planted code gone)", windows };
  },

  async loads(env) {
    const out = {};
    for (const kind of LOADS) {
      const before = (await chrome(C + `return state();`)).H;
      const r = await act(env, kind);
      await sleep(1300);
      const after = (await chrome(C + `return state();`)).H;
      out[kind] = {
        act: r,
        H: after.closed ? "closed" : after.url === before.url && after.doc === before.doc ? "stayed" : `moved: ${after.url}`,
        frame: after.frame === before.frame && after.frameDoc === before.frameDoc ? "stayed" : `moved: ${after.frame}`,
      };
    }
    return out;
  },

  backData: backRun,
  backBlob: backRun,
};

async function tearDown(env) {
  const r = {};
  r.handBack = await kit.handBack(env.space).then(
    () => "ok",
    e => String(e?.message ?? e).slice(0, 80)
  );
  // Hand back ends the hold.
  r.heldAfterHandBack = await chrome(C + `return heldMap().size;`).catch(e => String(e.message));
  r.finish = await call("spaces.finish", { space: env.space, keep: [] }).then(
    () => "finished",
    e => brief(e)
  );
  await chrome(
    C +
      `
    for (const id of Object.values(R.roles)) {
      const t = tabById(id);
      if (t) t.ownerDocument.defaultView.gBrowser.removeTab(t, { animate: false });
    }
    for (const t of all()) {
      const n = t.linkedBrowser?.browsingContext?.name ?? "";
      if (/^zs(W|HP|HF|P|H)/.test(n) && !ctx.service.lookup(t)) t.ownerDocument.defaultView.gBrowser.removeTab(t, { animate: false });
    }
    R.roles = {};
    return true;
  `
  ).catch(() => {});
  await kit.cleanTabs().catch(() => {});
  return r;
}

async function runCase(path, run) {
  const out = { path, run };
  const t0 = Date.now();
  let env = null;
  try {
    env = await PATHS[path]();
    if (env.setupError) throw new Error(`setup: ${env.setupError}`);
    if (PRE[run]) await PRE[run](env);
    out.before = await chrome(C + `return state();`);
    out.handOff = await handOff(env);
    out.atHold = await chrome(C + `return state();`);
    if (path === "popupRet") {
      // What zenius sees at the hand-off, before P's return load.
      if (run === "check") out.checkBeforeReturn = await RUNS.check(env);
      out.returned = await returnToT(env);
    }
    out.result = env.refused && run !== "check" ? { skipped: "the hand-off was refused" } : await RUNS[run](env);
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 300);
  } finally {
    if (env) out.teardown = await tearDown(env);
    out.ms = Date.now() - t0;
  }
  return out;
}

const RUN_NAMES = Object.keys(RUNS);
const DEFAULT = [...["popupXS", "popupSS", "popupRet", "page", "codePage"].flatMap(p => RUN_NAMES.map(r => `${p}:${r}`)), "madePage:check"];
const args = process.argv.slice(2);
const todo = (args.length ? args : DEFAULT).flatMap(a => (a.includes(":") ? [a] : RUN_NAMES.map(r => `${a}:${r}`)));
const results = [];
try {
  for (const key of todo) {
    const [path, run] = key.split(":");
    if (!PATHS[path] || !RUNS[run]) {
      results.push({ path, run, error: "no such path or run" });
      continue;
    }
    step(key);
    const r = await runCase(path, run);
    step(key, r.error ? `error: ${r.error}` : "ok", `${r.ms} ms`);
    results.push(r);
  }
} finally {
  console.log(JSON.stringify(results, null, 1));
  kit.close();
}
