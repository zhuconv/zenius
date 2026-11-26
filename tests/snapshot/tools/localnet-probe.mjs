// Bypass probes for the observe layer's local network refusal
// (runtime/JS/zenius/observe/localnet.sys.mjs).
// The parent cancels a task page's requests to private and link-local
// addresses and .local names. It finds a request's tab from its load info,
// and for a popup not yet routed, through the popup's openers. These vectors
// look for requests it can't place:
// - popups with no opener;
// - a page or frame going away;
// - the user's tab, navigated by a task page;
// - requests made for a page outside it (early hints, CSP reports, workers);
// - agent code that runs after the task ends.
//
// Safety. the Linux server sits on a shared LAN, and a request the refusal misses must reach
// nothing real:
// - The probe runs only in a network namespace that has nothing but loopback.
//   It checks this and refuses otherwise.
// - The dev profile's prefs (localnet-prefs.js) send every non-loopback
//   request to an HTTP proxy on loopback, with no failover. The probe points
//   that proxy at its recorder, which answers every request itself and never
//   forwards or tunnels. So a missed request is counted there.
// - Before any private address, it checks that the proxy covers each address
//   form (nsIProtocolProxyService), and that a control request to a
//   documentation address (192.0.2.1, which the refusal lets through) lands
//   on the recorder.
// - .local names resolve to 127.0.0.1 inside Gecko (network.dns.localDomains).
// - It refuses to run on macOS.
//
//   unshare -rn sh -c 'ip link set lo up &&
//     export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH &&
//     ZENIUS_DEV_PREFS=tests/snapshot/tools/localnet-prefs.js scripts/zen-dev.sh zen-snapshot-net start &&
//     ZENIUS_INSTANCE=zen-snapshot-net node tests/snapshot/tools/localnet-probe.mjs [vectors...];
//     scripts/zen-dev.sh zen-snapshot-net stop'
//
// A vector is REACHED when the recorder gets its request (tagged /zs/<name>),
// or the parent starts a speculative connection to a private host for it.
import http from "node:http";
import os from "node:os";
import { openKit } from "./owntab-kit.mjs";
import { netHits } from "./owntab-site.mjs";

if (process.platform === "darwin") {
  console.error("localnet-probe: never on the Mac");
  process.exit(2);
}
const outside = Object.entries(os.networkInterfaces()).filter(([, addrs]) => addrs.some(a => !a.internal));
if (outside.length) {
  console.error(`localnet-probe: run it in a network namespace with only loopback (its header); found ${outside.map(([n]) => n).join(", ")}`);
  process.exit(2);
}

const kit = await openKit();
const { call, chrome, ev, A, B, sleep, newTask, cleanUp } = kit;
const step = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const js = v => JSON.stringify(v).replace(/</g, "\\u003c");

/** The private hosts the vectors use, as Gecko writes them in URI.host. */
const LIT = "172.31.254.1";
const HOSTS = [LIT, "192.168.254.254", "169.254.169.254", "fd00::1", "zs-lan.local", "zs-printer.local"];
const T = tag => `http://${LIT}/zs/${tag}`;
const TL = tag => `http://zs-lan.local/zs/${tag}`;
const hostOf = target => {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `http://${target}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
};
const isPrivate = target => HOSTS.includes(hostOf(target));

/** A page of a public http site, served by the recorder (192.0.2.1 is a documentation address, not private). */
const PUBLIC = "http://192.0.2.1/zs/site/net";
const PUBLIC_PAGE = `<!doctype html><meta charset=utf-8><title>Public site</title>
<button id=go>Go</button> <a id=lnk href="/zs/site/next">link</a>
<form id=frm method=post action="/zs/site/form"><button id=sub>Send</button></form>
<p id=text>Some text of the site.</p>
<script>window.__out = {};</script>`;

/** What reached the recorder, in order. */
const recorded = [];
/** When each TCP connection to the recorder opened. */
const sockets = [];

function startRecorder() {
  const server = http.createServer((req, res) => {
    const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(req.url);
    const target = absolute ? req.url : `${req.headers.host ?? "?"}${req.url}`;
    recorded.push({ kind: absolute ? "proxied" : "direct", method: req.method, target, tag: /\/zs\/([\w-]+)/.exec(req.url)?.[1] ?? null, t: Date.now() });
    req.resume();
    let u = null;
    try {
      u = new URL(req.url, "http://x");
    } catch {}
    // A public site that redirects to the local network.
    const to = u?.pathname === "/zs/redir" ? u.searchParams.get("to") : null;
    if (to) {
      // CORS-allowed, so a fetch from another origin follows it.
      res.writeHead(302, { location: to, "access-control-allow-origin": "*", "cache-control": "no-store" });
      return res.end();
    }
    // A public site's page (PUBLIC), an insecure http origin unlike the
    // loopback fixture, which Gecko counts as a secure context.
    if (u?.pathname.startsWith("/zs/site/")) {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      return res.end(PUBLIC_PAGE);
    }
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end("zs-recorder");
  });
  // Tunnels are refused, never opened.
  server.on("connect", (req, sock) => {
    recorded.push({ kind: "connect", method: "CONNECT", target: req.url, tag: null, t: Date.now() });
    sock.on("error", () => {});
    sock.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  server.on("upgrade", (req, sock) => {
    recorded.push({ kind: "upgrade", method: req.method, target: req.url, tag: /\/zs\/([\w-]+)/.exec(req.url)?.[1] ?? null, t: Date.now() });
    sock.on("error", () => {});
    sock.destroy();
  });
  server.on("connection", sock => {
    sockets.push(Date.now());
    sock.on("error", () => {});
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** Page helpers for the agent's code. */
const H = `
  const blob = src => URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const settle = (p, ms = 3000) => Promise.race([
    Promise.resolve(p).then(v => "resolved: " + v, e => "rejected: " + (e?.name ?? e)),
    new Promise(r => setTimeout(() => r("pending"), ms)),
  ]);
  const fromWorker = (w, ms = 3000) => new Promise(r => {
    w.onmessage = e => r(String(e.data));
    w.onerror = e => r("error: " + (e.message ?? ""));
    setTimeout(() => r("pending"), ms);
  });
  const add = (tag, attrs) => { const el = document.createElement(tag); Object.assign(el, attrs); document.head.append(el); return el; };
  const loadedFrame = src => new Promise(r => { const f = document.createElement("iframe"); f.src = src; f.onload = () => r(f); document.body.append(f); });
`;

/**
 * The user's tab on the site, in a Space of theirs. Their click opens the
 * site's tool in a popup that keeps the tab as its opener. The agent claims
 * the Space, the user allows it, and the agent adopts the popup only.
 */
async function userPopupAdopted() {
  const made = await chrome(
    `
    const agents = ctx.spaces.agentsSpace.uuid;
    const mine = gZenWorkspaces.getWorkspaces().find(ws => ws.uuid !== agents);
    if (gZenWorkspaces.activeWorkspace !== mine.uuid) await gZenWorkspaces.changeWorkspaceWithID(mine.uuid);
    const u = gBrowser.addTrustedTab(arg, { inBackground: false });
    gBrowser.selectedTab = u;
    await until(() => u.linkedBrowser.currentURI.spec === arg && loaded(u), 10000);
    win.__userTab = u;
    await sleep(300);
    const at = await inContent(u, "const r = document.getElementById('pop').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2];");
    const before = new Set(all());
    const r = u.linkedBrowser.getBoundingClientRect();
    const send = (type, buttons = 0) => win.synthesizeMouseEvent(type, r.left + at[0], r.top + at[1],
      { identifier: 0, button: 0, buttons, clickCount: 1, modifiers: 0, inputSource: 1 },
      { isDOMEventSynthesized: false, isWidgetEventSynthesized: false, isAsyncEnabled: false });
    send("mousemove"); await sleep(30); send("mousedown", 1); await sleep(40); send("mouseup");
    await until(() => all().some(t => !before.has(t)), 8000);
    const p = all().find(t => !before.has(t));
    await until(() => loaded(p) && p.linkedBrowser.currentURI.spec.endsWith("/net"), 10000);
    win.__userPopup = p;
    const opener = p.linkedBrowser.browsingContext.opener;
    return {
      space: ctx.spaces.peekUuid(mine.uuid).id,
      popup: ctx.service.pages.tabId(p),
      openerIsUserTab: opener?.id === u.linkedBrowser.browsingContext.id,
    };
  `,
    `${A.base}/net-user`
  );
  const claim = call("spaces.claim", { space: made.space, client: "red team", timeout: 20000 });
  claim.catch(() => {});
  await call("dev.answerClaim", { space: made.space, timeout: 10000 });
  await claim;
  const adopted = await call("pages.adopt", { space: made.space, tab: made.popup });
  return { ...made, label: adopted.label };
}

async function dropUserTabs(space) {
  if (space !== undefined) {
    await call("spaces.finish", { space, keep: [] }).catch(() => {});
  }
  await chrome(
    `for (const t of [win.__userTab, win.__userPopup]) if (t?.isConnected) t.ownerDocument.defaultView.gBrowser.removeTab(t, { animate: false });
     delete win.__userTab; delete win.__userPopup; return true;`
  ).catch(() => {});
}

/**
 * The agent's code, `code`, runs in p1 (/net), and the task ends keeping it.
 * Then the user, in the kept tab, clicks in it (`click`), goes elsewhere from
 * the address bar (`away`) and maybe Back (`back`), or closes it (`close`).
 * Before leaving, it waits for the page's load to end, so Gecko may cache it.
 */
async function kept(s, code, user = {}) {
  await run(s, `${code} return true;`);
  const finished = await call("spaces.finish", { space: s, keep: ["p1"] }).then(() => "kept", e => e.code);
  await sleep(300);
  const did = await chrome(
    `
    const out = {};
    const t = all().find(x => x.linkedBrowser.currentURI.spec === arg.url && !ctx.service.lookup(x));
    if (!t) return { error: "no kept tab" };
    await gZenWorkspaces.changeWorkspaceWithID(t.getAttribute("zen-workspace-id"));
    gBrowser.selectedTab = t;
    await until(() => gBrowser.selectedTab === t, 3000).catch(() => {});
    await sleep(300);
    if (arg.click) {
      const r = t.linkedBrowser.getBoundingClientRect();
      const send = (type, buttons = 0) => win.synthesizeMouseEvent(type, r.left + 300, r.top + 200,
        { identifier: 0, button: 0, buttons, clickCount: 1, modifiers: 0, inputSource: 1 },
        { isDOMEventSynthesized: false, isWidgetEventSynthesized: false, isAsyncEnabled: false });
      send("mousemove"); await sleep(30); send("mousedown", 1); await sleep(40); send("mouseup");
      out.clicked = true;
    }
    if (arg.away) {
      await loadEnded(t);
      const bc = t.linkedBrowser.browsingContext.id;
      t.linkedBrowser.loadURI(Services.io.newURI(arg.away), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      await until(() => t.linkedBrowser.currentURI.spec === arg.away && loaded(t), 10000);
      await sleep(300);
      out.cachedByUser = !!BrowsingContext.get(bc)?.isInBFCache;
      if (arg.back) {
        t.linkedBrowser.goBack();
        await until(() => t.linkedBrowser.currentURI.spec === arg.url && loaded(t), 10000);
        out.back = await inContent(t, "return performance.getEntriesByType('navigation')[0]?.type ?? null");
      }
    }
    if (arg.close) {
      t.ownerDocument.defaultView.gBrowser.removeTab(t, { animate: false });
      out.closed = true;
    }
    return out;
  `,
    { url: user.url ?? `${A.base}/net`, ...user }
  );
  return { finished, ...did };
}

/** Install a click handler from agent code, have zenius click it, and return what it left in window.__p. */
async function clickWith(s, code) {
  await ev(s, "p1", `() => { ${H} document.getElementById("go").onclick = () => { ${code} }; return true; }`);
  const click = await call("page.click", { space: s, page: "p1", target: "#go", options: {} }).catch(e => ({ error: `${e.code}: ${e.message}` }));
  if (click?.error) {
    return `click failed: ${click.error}`;
  }
  return ev(s, "p1", `async () => (await window.__p) ?? "clicked"`).catch(e => `evaluate failed: ${e.code}: ${String(e.message).slice(0, 120)}`);
}

const run = (s, code) => ev(s, "p1", `async () => { ${H} ${code} }`).catch(e => `evaluate failed: ${e.code}: ${String(e.message).slice(0, 120)}`);
const clickOn = (s, target, page = "p1") => call("page.click", { space: s, page, target, options: {} }).then(() => "clicked", e => `click failed: ${e.code}`);

/**
 * expect: what the refusal's design says. "refused", or why a request may
 * go out: "residual" (the observe layer lists it) or "pending" (the per-document
 * refusal we may add, not built yet).
 */
const VECTORS = {
  // Controls: a task page's fetch is refused; the user's own tab's isn't.
  fetchTask: { expect: "refused", run: (s, tag) => run(s, `return settle(fetch(${js(T(tag))}).then(r => r.status));`) },
  fetchUserTab: {
    expect: "reached (a user tab: the measurement's control)",
    custom: async (s, tag) =>
      chrome(
        `
        const u = gBrowser.addTrustedTab(arg.page, { inBackground: true });
        try {
          await until(() => u.linkedBrowser.currentURI.spec === arg.page && loaded(u), 10000);
          return await inContent(u, "return fetch(" + JSON.stringify(arg.to) + ").then(r => 'status ' + r.status, e => e.name)");
        } finally {
          gBrowser.removeTab(u, { animate: false });
        }
      `,
        { page: `${A.base}/net`, to: T(tag) }
      ),
  },
  // Popups with no opener to walk, before the parent routes them.
  noopenerOpen: { expect: "refused", wait: 3000, click: tag => `window.open(${js(T(tag))}, "_blank", "noopener");` },
  noreferrerOpen: { expect: "refused", wait: 3000, click: tag => `window.open(${js(T(tag))}, "_blank", "noreferrer");` },
  noopenerLocalName: { expect: "refused", wait: 3000, click: tag => `window.open(${js(TL(tag))}, "_blank", "noopener");` },
  noopenerRedirect: {
    expect: "refused",
    wait: 3000,
    click: tag => `window.open(${js(`${A.base}/redirect?to=${encodeURIComponent(T(tag))}`)}, "_blank", "noopener");`,
  },
  openerOpen: { expect: "refused", wait: 3000, click: tag => `window.open(${js(T(tag))}, "zsWin");` },
  blankLink: {
    expect: "refused",
    wait: 3000,
    custom: async (s, tag) => {
      await run(s, `const a = document.getElementById("lnk"); a.href = ${js(T(tag))}; a.target = "_blank"; return true;`);
      return clickOn(s, "#lnk");
    },
  },
  blankForm: {
    expect: "no request (the insecure-form warning first)",
    wait: 3000,
    budget: 20000,
    custom: async (s, tag) => {
      await run(s, `const f = document.getElementById("frm"); f.action = ${js(T(tag))}; f.target = "_blank"; return true;`);
      return clickOn(s, "#sub");
    },
  },
  // A page or frame that goes away, and what it sends as it goes.
  beaconOnClose: {
    expect: "refused",
    wait: 2500,
    custom: async (s, tag) => {
      await run(s, `addEventListener("pagehide", () => navigator.sendBeacon(${js(T(tag))}, "x")); return true;`);
      return call("pages.close", { space: s, page: "p1" }).then(() => "closed", e => e.code);
    },
  },
  keepaliveOnClose: {
    expect: "refused",
    wait: 2500,
    custom: async (s, tag) => {
      await run(s, `addEventListener("pagehide", () => fetch(${js(T(tag))}, { method: "POST", body: "x", keepalive: true })); return true;`);
      return call("pages.close", { space: s, page: "p1" }).then(() => "closed", e => e.code);
    },
  },
  beaconOnFinish: {
    expect: "refused",
    wait: 2500,
    custom: async (s, tag) => {
      await run(s, `addEventListener("pagehide", () => navigator.sendBeacon(${js(T(tag))}, "x")); return true;`);
      return call("spaces.finish", { space: s, keep: [] }).then(() => "finished", e => e.code);
    },
  },
  beaconOnNavigate: {
    expect: "refused",
    custom: async (s, tag) => {
      await run(s, `addEventListener("pagehide", () => navigator.sendBeacon(${js(T(tag))}, "x")); return true;`);
      return call("page.goto", { space: s, page: "p1", url: `${A.base}/net?next` }).then(() => "navigated", e => e.code);
    },
  },
  frameRemoveBeacon: {
    expect: "refused",
    run: (s, tag) =>
      run(s, `const f = await loadedFrame("/net?frame"); const w = f.contentWindow;
        w.addEventListener("pagehide", () => w.navigator.sendBeacon(${js(T(tag))}, "x")); f.remove(); return "removed";`),
  },
  frameRemoveKeepalive: {
    expect: "refused",
    run: (s, tag) =>
      run(s, `const f = await loadedFrame("/net?frame"); const w = f.contentWindow;
        w.addEventListener("pagehide", () => w.fetch(${js(T(tag))}, { method: "POST", body: "x", keepalive: true })); f.remove(); return "removed";`),
  },
  frameNavigateBeacon: {
    expect: "refused",
    run: (s, tag) =>
      run(s, `const f = await loadedFrame("/net?frame"); const w = f.contentWindow;
        w.addEventListener("pagehide", () => w.navigator.sendBeacon(${js(T(tag))}, "x")); f.src = "/net?frame2"; return "navigated";`),
  },
  popupCloseBeacon: {
    expect: "refused",
    wait: 3000,
    click: tag => `const w = window.open("/net?popup", "zsPopClose");
      const iv = setInterval(() => { try { if (w.location.search === "?popup" && w.document.readyState === "complete") {
        clearInterval(iv); w.addEventListener("pagehide", () => w.navigator.sendBeacon(${js(T(tag))}, "x")); w.close(); } } catch {} }, 50);`,
  },
  // Agent code that runs after the task ends, in a page the user keeps. Its
  // document keeps the refusal until it is replaced, judged by the
  // tab's current top document.
  keptTimer: { expect: "refused", wait: 4500, custom: (s, tag) => kept(s, `setTimeout(() => fetch(${js(T(tag))}).catch(() => {}), 2500);`) },
  keptNavigate: { expect: "refused", wait: 3000, custom: (s, tag) => kept(s, `setTimeout(() => { location.href = ${js(T(tag))}; }, 1500);`) },
  keptOpenerPopup: {
    expect: "refused",
    wait: 3000,
    custom: (s, tag) => kept(s, `addEventListener("click", () => window.open(${js(T(tag))}, "zsKeptWin"), { once: true });`, { click: true }),
  },
  keptNoopenerPopup: {
    expect: "refused",
    wait: 3000,
    custom: (s, tag) => kept(s, `addEventListener("click", () => window.open(${js(T(tag))}, "_blank", "noopener"), { once: true });`, { click: true }),
  },
  // As the marked document goes away: the user leaves it from the address
  // bar, or closes the tab.
  keptLeaveBeacon: {
    expect: "refused",
    wait: 2500,
    custom: (s, tag) => kept(s, `addEventListener("pagehide", () => navigator.sendBeacon(${js(T(tag))}, "x"));`, { away: `${A.base}/net?user` }),
  },
  keptCloseBeacon: {
    expect: "refused",
    wait: 2500,
    custom: (s, tag) => kept(s, `addEventListener("pagehide", () => navigator.sendBeacon(${js(T(tag))}, "x"));`, { close: true }),
  },
  // The same document back from the user's own bfcache: still marked. On
  // /bf, which Gecko may cache (the fixture's other pages are no-store).
  keptBackFetch: {
    expect: "refused",
    wait: 2500,
    custom: async (s, tag) => {
      await call("page.goto", { space: s, page: "p1", url: `${A.base}/bf?kept` });
      return kept(s, `addEventListener("pageshow", e => { if (e.persisted) fetch(${js(T(tag))}).catch(() => {}); });`, {
        url: `${A.base}/bf?kept`,
        away: `${A.base}/bf?user`,
        back: true,
      });
    },
  },
  // The planted code chooses the next document: a load replaces the marked
  // one, and the new one is the site's.
  keptReplaced: {
    expect: "reached (by design: a load replaced the marked document)",
    wait: 4000,
    custom: (s, tag) => kept(s, `setTimeout(() => { location.href = ${js(`${A.base}/net-lan?to=${encodeURIComponent(T(tag))}`)}; }, 1500);`),
  },
  // The user's tab, navigated by a task page that has it as its opener.
  openerNavigate: {
    expect: "refused",
    custom: async (s, tag) => {
      let made;
      try {
        made = await userPopupAdopted();
        const out = await ev(made.space, made.label, `() => { opener.location.href = ${js(T(tag))}; return "navigated"; }`).catch(e => `${e.code}: ${e.message}`);
        await sleep(2000);
        return { openerIsUserTab: made.openerIsUserTab, out, userTab: await chrome(`return win.__userTab?.linkedBrowser.currentURI.spec ?? null;`) };
      } finally {
        await dropUserTabs(made?.space);
      }
    },
  },
  openerNamed: {
    expect: "refused",
    custom: async (s, tag) => {
      let made;
      try {
        made = await userPopupAdopted();
        const out = await ev(made.space, made.label, `() => { window.open(${js(T(tag))}, "zsUserTab"); return "opened"; }`).catch(e => `${e.code}: ${e.message}`);
        await sleep(2000);
        return { openerIsUserTab: made.openerIsUserTab, out, userTab: await chrome(`return win.__userTab?.linkedBrowser.currentURI.spec ?? null;`) };
      } finally {
        await dropUserTabs(made?.space);
      }
    },
  },
  // Requests made for the page outside its own document.
  earlyHints: {
    expect: "refused",
    wait: 2500,
    custom: (s, tag) => call("page.goto", { space: s, page: "p1", url: `${A.base}/early?to=${encodeURIComponent(T(tag))}` }).then(() => "loaded", e => e.code),
  },
  earlyHintsControl: {
    expect: "control: the fixture counts the preload",
    wait: 2500,
    custom: (s, tag) => call("page.goto", { space: s, page: "p1", url: `${A.base}/early?to=${encodeURIComponent(`${A.base}/hit?${tag}`)}` }).then(() => "loaded", e => e.code),
  },
  // Does Gecko preload a cross-origin early hint at all? The other loopback site.
  earlyHintsCrossControl: {
    expect: "control: the fixture counts the preload",
    wait: 2500,
    custom: (s, tag) => call("page.goto", { space: s, page: "p1", url: `${A.base}/early?to=${encodeURIComponent(`${B.base}/hit?${tag}`)}` }).then(() => "loaded", e => e.code),
  },
  cspReportDoc: {
    expect: "refused",
    wait: 2500,
    custom: async (s, tag) => {
      await call("page.goto", { space: s, page: "p1", url: `${A.base}/net-csp?report=${encodeURIComponent(T(tag))}` });
      return run(s, `const i = new Image(); i.src = ${js(`${B.base}/hit?csp-img`)}; document.body.append(i); return "violated";`);
    },
  },
  cspReportWorker: {
    expect: "refused",
    wait: 2500,
    custom: async (s, tag) => {
      await call("page.goto", { space: s, page: "p1", url: `${A.base}/net-csp?report=${encodeURIComponent(T(tag))}` });
      return run(s, `return fromWorker(new Worker(blob("fetch(" + ${js(js(`${B.base}/hit?csp-w`))} + ").then(r => postMessage('status ' + r.status), e => postMessage(e.name));")));`);
    },
  },
  cspReportControl: {
    expect: "control: the fixture counts the report",
    wait: 2500,
    custom: async (s, tag) => {
      await call("page.goto", { space: s, page: "p1", url: `${A.base}/net-csp?report=${encodeURIComponent(`${A.base}/hit?${tag}`)}` });
      return run(s, `const i = new Image(); i.src = ${js(`${B.base}/hit?csp-img`)}; document.body.append(i); return "violated";`);
    },
  },
  favicon: { expect: "refused", wait: 3000, run: (s, tag) => run(s, `add("link", { rel: "icon", href: ${js(T(tag))} }); return "added";`) },
  linkPrefetch: { expect: "refused", wait: 3000, run: (s, tag) => run(s, `add("link", { rel: "prefetch", href: ${js(T(tag))} }); return "added";`) },
  linkPreload: { expect: "refused", run: (s, tag) => run(s, `add("link", { rel: "preload", as: "image", href: ${js(T(tag))} }); return "added";`) },
  modulePreload: { expect: "refused", run: (s, tag) => run(s, `add("link", { rel: "modulepreload", href: ${js(T(tag))} }); return "added";`) },
  cssImport: { expect: "refused", run: (s, tag) => run(s, `add("style", { textContent: "@import url(" + ${js(T(tag))} + ");" }); return "added";`) },
  cssFont: {
    expect: "refused",
    run: (s, tag) => run(s, `add("style", { textContent: "@font-face { font-family: zsf; src: url(" + ${js(T(tag))} + "); } #text { font-family: zsf; }" }); return "added";`),
  },
  importScripts: {
    expect: "refused",
    run: (s, tag) => run(s, `return fromWorker(new Worker(blob("try { importScripts(" + ${js(js(T(tag)))} + "); postMessage('imported'); } catch (e) { postMessage(e.name); }")));`),
  },
  moduleWorkerImport: {
    expect: "refused",
    run: (s, tag) => run(s, `return fromWorker(new Worker(blob("import " + ${js(js(T(tag)))} + "; postMessage('imported');"), { type: "module" }));`),
  },
  nestedWorker: {
    expect: "refused",
    run: (s, tag) =>
      run(s, `const inner = "fetch(" + ${js(js(T(tag)))} + ").then(r => postMessage('status ' + r.status), e => postMessage(e.name));";
        return fromWorker(new Worker(blob("const w = new Worker(URL.createObjectURL(new Blob([" + JSON.stringify(inner) + "], { type: 'text/javascript' }))); w.onmessage = e => postMessage(e.data);")));`),
  },
  sharedWorker: {
    expect: "residual",
    run: (s, tag) =>
      run(s, `const w = new SharedWorker(blob("onconnect = e => fetch(" + ${js(js(T(tag)))} + ").then(r => e.ports[0].postMessage('status ' + r.status), x => e.ports[0].postMessage(x.name));"));
        return new Promise(r => { w.port.onmessage = e => r(String(e.data)); setTimeout(() => r("pending"), 3000); });`),
  },
  audioWorklet: {
    expect: "refused",
    run: (s, tag) => run(s, `const ac = new AudioContext(); const r = await settle(ac.audioWorklet.addModule(${js(T(tag))})); ac.close(); return r;`),
  },
  publicRedirect: {
    expect: "refused",
    run: (s, tag) => run(s, `return settle(fetch("http://192.0.2.1/zs/redir?to=" + encodeURIComponent(${js(T(tag))})).then(r => r.status));`),
  },
  metaRefresh: {
    expect: "refused",
    wait: 2500,
    run: (s, tag) => run(s, `add("meta", { httpEquiv: "refresh", content: "0;url=" + ${js(T(tag))} }); return "added";`),
  },
  // Forms from the loopback fixture, a secure context: Firefox's tab-modal
  // insecure-form warning ("Security Warning") stops a submission to any
  // non-loopback http address before a request, and zenius's click waits on
  // it past its timeout.
  formSelf: {
    expect: "no request (the insecure-form warning first)",
    budget: 20000,
    custom: async (s, tag) => {
      await run(s, `const f = document.getElementById("frm"); f.action = ${js(T(tag))}; f.target = "_self"; return true;`);
      return clickOn(s, "#sub");
    },
  },
  formSubmitScript: {
    expect: "no request (the insecure-form warning first)",
    run: (s, tag) => run(s, `const f = document.getElementById("frm"); f.action = ${js(T(tag))}; f.target = "_self"; setTimeout(() => f.submit(), 0); return "submitting";`),
  },
  // The same from a public site's page, an insecure origin, where no warning comes.
  publicFormPost: {
    expect: "refused",
    budget: 20000,
    custom: async (s, tag) => {
      await call("page.goto", { space: s, page: "p1", url: PUBLIC });
      await run(s, `const f = document.getElementById("frm"); f.action = ${js(T(tag))}; f.target = "_self"; return true;`);
      return clickOn(s, "#sub");
    },
  },
  publicFetch: {
    expect: "refused",
    custom: async (s, tag) => {
      await call("page.goto", { space: s, page: "p1", url: PUBLIC });
      return run(s, `return settle(fetch(${js(T(tag))}).then(r => r.status));`);
    },
  },
  linkSelf: {
    expect: "refused",
    budget: 20000,
    custom: async (s, tag) => {
      await run(s, `const a = document.getElementById("lnk"); a.href = ${js(T(tag))}; a.target = "_self"; return true;`);
      return clickOn(s, "#lnk");
    },
  },
  webSocket: {
    expect: "refused",
    run: (s, tag) =>
      run(s, `const w = new WebSocket(${js(`ws://${LIT}/zs/${tag}`)}); return new Promise(r => { w.onopen = () => r("open"); w.onerror = () => r("error"); setTimeout(() => r("pending"), 2500); });`),
  },
  // Connection hints make no request, but they open a connection.
  preconnect: { expect: "residual", port: 4401, run: (s, tag) => run(s, `add("link", { rel: "preconnect", href: "http://${LIT}:4401" }); return "added";`) },
  preconnectHttps: { expect: "residual", port: 4402, run: (s, tag) => run(s, `add("link", { rel: "preconnect", href: "https://${LIT}:4402" }); return "added";`) },
  preconnectLocalName: { expect: "residual", port: 4403, run: (s, tag) => run(s, `add("link", { rel: "preconnect", href: "http://zs-printer.local:4403" }); return "added";`) },
};

/** Parent-side watch of every channel to the vectors' hosts, and of speculative connections. */
function installWatch() {
  return chrome(
    `
    if (win.__zsNet) return "already";
    const { TASK_BROWSERS_KEY } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/guards.sys.mjs");
    const L = (win.__zsNet = { chans: [], spec: [], undo: [] });
    const hosts = new Set(arg);
    const plain = h => String(h ?? "").toLowerCase().replace(/^\\[|\\]$/g, "").replace(/\\.$/, "");
    const watch = (subject, topic) => {
      let ch;
      try { ch = subject.QueryInterface(Ci.nsIHttpChannel); } catch { return; }
      let host = "";
      try { host = plain(ch.URI.host); } catch { return; }
      if (!hosts.has(host)) return;
      const li = ch.loadInfo;
      // The way the refusal finds the tab (localnet.sys.mjs's taskBrowserOf).
      let bc = null;
      try {
        bc = li.browsingContext || li.associatedBrowsingContext ||
          (li.frameBrowsingContextID ? BrowsingContext.get(li.frameBrowsingContextID) : null) ||
          (li.browsingContextID ? BrowsingContext.get(li.browsingContextID) : null);
      } catch {}
      let browserId = null;
      try { browserId = bc?.top?.embedderElement?.browserId ?? null; } catch {}
      let openers = 0;
      try { for (let t = bc?.top; t && openers < 5; openers++) { const o = t.opener ?? t.crossGroupOpener; if (!o) break; t = o.top; } } catch {}
      L.chans.push({
        ch, topic, url: ch.URI.spec, type: li.externalContentPolicyType,
        ids: { bc: li.browsingContextID, frame: li.frameBrowsingContextID },
        found: !!bc, browserId, openers,
        task: browserId !== null && !!Services.ppmm.sharedData.get(TASK_BROWSERS_KEY)?.has(browserId),
        t: Date.now(),
      });
    };
    for (const topic of ["http-on-opening-request", "http-on-modify-request"]) {
      Services.obs.addObserver(watch, topic);
      L.undo.push(() => Services.obs.removeObserver(watch, topic));
    }
    const spec = (subject, topic, data) => L.spec.push({ data: String(data), t: Date.now() });
    Services.obs.addObserver(spec, "speculative-connect-request");
    L.undo.push(() => Services.obs.removeObserver(spec, "speculative-connect-request"));
    return "installed";
  `,
    HOSTS
  );
}

function takeWatch() {
  return chrome(`
    const L = win.__zsNet;
    const chans = L.chans.splice(0).map(c => {
      let status = null;
      try { status = c.ch.status; } catch {}
      const { ch, ...rest } = c;
      return { ...rest, refused: status === Cr.NS_ERROR_LOCAL_NETWORK_ACCESS_DENIED, status: status === null ? null : "0x" + (status >>> 0).toString(16) };
    });
    return { chans, spec: L.spec.splice(0) };
  `);
}

function removeWatch() {
  return chrome(`const L = win.__zsNet; if (!L) return false; for (const u of L.undo) { try { u(); } catch {} } delete win.__zsNet; return true;`);
}

/** The dev profile's safety prefs, read back. */
async function checkSafe() {
  const prefs = await chrome(`
    const read = name => {
      switch (Services.prefs.getPrefType(name)) {
        case Services.prefs.PREF_INT: return Services.prefs.getIntPref(name);
        case Services.prefs.PREF_BOOL: return Services.prefs.getBoolPref(name);
        case Services.prefs.PREF_STRING: return Services.prefs.getStringPref(name);
        default: return null;
      }
    };
    return Object.fromEntries(arg.map(n => [n, read(n)]));
  `, [
    "network.proxy.type", "network.proxy.http", "network.proxy.ssl", "network.proxy.socks", "network.proxy.no_proxies_on",
    "network.proxy.allow_hijacking_localhost", "network.proxy.failover_direct", "network.dns.localDomains",
    "network.dns.disablePrefetch", "network.trr.mode", "network.http.http3.enable", "network.webtransport.enabled",
    "media.peerconnection.ice.no_host", "media.peerconnection.ice.proxy_only", "media.peerconnection.ice.obfuscate_host_addresses",
  ]);
  const want = {
    "network.proxy.type": 1,
    "network.proxy.http": "127.0.0.1",
    "network.proxy.ssl": "127.0.0.1",
    "network.proxy.socks": "",
    "network.proxy.no_proxies_on": "",
    "network.proxy.allow_hijacking_localhost": false,
    "network.proxy.failover_direct": false,
    "network.dns.disablePrefetch": true,
    "network.trr.mode": 5,
    "network.http.http3.enable": false,
    "network.webtransport.enabled": false,
    "media.peerconnection.ice.no_host": true,
    "media.peerconnection.ice.proxy_only": true,
    "media.peerconnection.ice.obfuscate_host_addresses": false,
  };
  const wrong = Object.entries(want).filter(([k, v]) => prefs[k] !== v).map(([k, v]) => `${k} is ${JSON.stringify(prefs[k])}, not ${JSON.stringify(v)}`);
  const names = String(prefs["network.dns.localDomains"] ?? "").split(",").map(x => x.trim());
  for (const name of ["zs-lan.local", "zs-printer.local"]) {
    if (!names.includes(name)) wrong.push(`network.dns.localDomains lacks ${name}`);
  }
  if (wrong.length) {
    throw new Error(`unsafe profile (start it with ZENIUS_DEV_PREFS=tests/snapshot/tools/localnet-prefs.js): ${wrong.join("; ")}`);
  }
  return prefs;
}

function setProxyPort(port) {
  return chrome(`for (const k of ["network.proxy.http_port", "network.proxy.ssl_port"]) Services.prefs.setIntPref(k, arg); return true;`, port);
}

/**
 * Before any private address: every form resolves to the recorder, with no
 * failover, and loopback goes direct. Then a control request to a
 * documentation address, which the refusal lets through, must land there.
 */
async function preflight(port) {
  const urls = [
    "http://192.0.2.1/", `http://${LIT}/`, `https://${LIT}/`, "http://192.168.254.254/", "http://169.254.169.254/",
    "http://[fd00::1]/", "http://zs-lan.local/", "http://zs-printer.local:4403/", `http://${LIT}:4401/`, `https://${LIT}:4402/`, `${A.base}/`,
  ];
  const resolved = await chrome(
    `
    const pps = Cc["@mozilla.org/network/protocol-proxy-service;1"].getService(Ci.nsIProtocolProxyService);
    const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
    const one = spec => new Promise(resolve => {
      const ch = NetUtil.newChannel({ uri: spec, loadUsingSystemPrincipal: true });
      pps.asyncResolve(ch, 0, { onProxyAvailable(req, c, pi) { resolve(pi ? { type: pi.type, host: pi.host, port: pi.port, failover: !!pi.failoverProxy } : "direct"); } });
    });
    const out = {};
    for (const spec of arg) out[spec] = await one(spec);
    return out;
  `,
    urls
  );
  const bad = Object.entries(resolved).filter(([spec, pi]) =>
    spec.startsWith(A.base) ? pi !== "direct" : !(pi?.type === "http" && pi.host === "127.0.0.1" && pi.port === port && !pi.failover)
  );
  const before = recorded.length;
  const control = await chrome(`try { const r = await win.fetch(arg); return "status " + r.status; } catch (e) { return e.name + ": " + e.message; }`, "http://192.0.2.1/zs/preflight");
  await sleep(300);
  const landed = recorded.slice(before).some(r => r.tag === "preflight");
  return { ok: !bad.length && landed, resolved, bad: bad.map(([spec]) => spec), control, landed };
}

/** A vector's private requests at the recorder: its own tag, or none (a CONNECT names only host and port). */
const privateOf = (name, rec) => rec.filter(r => isPrivate(r.target) && (r.tag === name || r.tag === null));

function verdictOf(name, v, rec, w, hits, connections) {
  const reached = [];
  const mine = privateOf(name, rec);
  if (mine.length) reached.push(`the recorder got ${mine.length} (${[...new Set(mine.map(r => `${r.kind} ${r.method}`))].join(", ")})`);
  const spec = w.spec.filter(x => isPrivate(x.data) && (!v.port || x.data.includes(`:${v.port}`)));
  if (spec.length) reached.push(`speculative connections ${spec.length} (${spec.map(x => x.data).join(", ")})`);
  // A connection hint opens a connection to the proxy and sends nothing.
  if (v.port && connections > rec.length) reached.push(`bare connections to the proxy ${connections - rec.length}`);
  if (reached.length) return `REACHED: ${reached.join("; ")}`;
  if (v.expect.startsWith("control")) return hits.length ? `control ran (${hits.length})` : "control did not run";
  const chans = w.chans.filter(c => c.url.includes(`/zs/${name}`));
  if (!chans.length) return "no request seen";
  return chans.every(c => c.refused) ? `refused (${chans.length} cancelled)` : `not sent (${chans.map(c => c.status).join(", ")})`;
}

/** `p`, or an error after `ms`: a vector that hangs fails alone, and the run goes on. */
const within = (p, ms, what) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms))]);

async function runVector(name, v) {
  const s = await newTask(`net ${name}`, `${A.base}/net`);
  try {
    await takeWatch();
    const r0 = recorded.length;
    const k0 = sockets.length;
    const h0 = netHits.length;
    let outcome;
    if (v.custom) {
      outcome = await within(v.custom(s, name), v.budget ?? 60000, "the vector").catch(e => `failed: ${e.message}`);
    } else if (v.click) {
      outcome = await within(clickWith(s, v.click(name)), v.budget ?? 60000, "the click").catch(e => `failed: ${e.message}`);
    } else {
      outcome = await within(v.run(s, name), v.budget ?? 60000, "the code").catch(e => `failed: ${e.message}`);
    }
    step(name, "ran:", JSON.stringify(outcome).slice(0, 160));
    await sleep(v.wait ?? 2000);
    const w = await within(takeWatch(), 30000, "reading the watch");
    const rec = recorded.slice(r0);
    const hits = netHits.slice(h0).filter(h => h.q === name || h.q.startsWith(`${name}`)).map(h => `${h.method} ${h.q}`);
    return {
      expect: v.expect,
      verdict: verdictOf(name, v, rec, w, hits, sockets.length - k0),
      outcome,
      recorder: rec.filter(r => isPrivate(r.target) || r.tag === name).map(r => `${r.kind} ${r.method} ${r.target}`),
      channels: w.chans.filter(c => c.url.includes(`/zs/${name}`) || (v.port && c.url.includes(`:${v.port}`))),
      speculative: w.spec.map(x => x.data),
      connections: sockets.length - k0,
      hits,
    };
  } finally {
    await within(cleanUp([s]), 30000, "cleanUp").catch(e => step(name, e.message));
    const left = await within(chrome(`return ctx.spaces.peek(arg)?.ownership ?? null;`, s), 10000, "reading the task").catch(() => null);
    if (left) {
      const closed = await chrome(`let n = 0; for (const t of taskTabs(arg)) { t.ownerDocument.defaultView.gBrowser.removeTab(t, { animate: false }); n++; } return n;`, s).catch(e => e.message);
      step(`task ${s} stayed open (${left}); closed its ${closed} tabs`);
    }
    // Tabs the vectors left on the vectors' hosts (popups, kept pages).
    await chrome(
      `let n = 0; for (const t of all()) { const u = t.linkedBrowser?.currentURI?.spec ?? ""; if (/\\/zs\\//.test(u) && !ctx.service.lookup(t)) { t.ownerDocument.defaultView.gBrowser.removeTab(t, { animate: false }); n++; } } return n;`
    ).catch(() => {});
  }
}

const names = process.argv.slice(2);
const unknown = names.filter(n => !VECTORS[n]);
const results = {};
let recorder = null;
// Killed (an outer timeout): print what there is.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    results.killed = signal;
    console.log(JSON.stringify(results, null, 1));
    process.exit(3);
  });
}
try {
  if (unknown.length) {
    throw new Error(`unknown vectors: ${unknown.join(", ")}; known: ${Object.keys(VECTORS).join(", ")}`);
  }
  results.env = await checkSafe();
  recorder = await startRecorder();
  const port = recorder.address().port;
  await setProxyPort(port);
  results.preflight = await preflight(port);
  step("preflight", JSON.stringify({ ok: results.preflight.ok, bad: results.preflight.bad, control: results.preflight.control, landed: results.preflight.landed }));
  if (!results.preflight.ok) {
    throw new Error("preflight failed: no private address was tried");
  }
  step("watch", await installWatch());
  results.vectors = {};
  for (const name of names.length ? names : Object.keys(VECTORS)) {
    step(name);
    try {
      results.vectors[name] = await runVector(name, VECTORS[name]);
    } catch (e) {
      results.vectors[name] = { expect: VECTORS[name].expect, error: String(e?.message ?? e).slice(0, 300) };
    }
    step(name, "->", results.vectors[name].verdict ?? results.vectors[name].error);
  }
} catch (e) {
  results.error = String(e?.message ?? e);
} finally {
  // Back to the dead port, so the profile fails closed again.
  await setProxyPort(9).catch(() => {});
  await removeWatch().catch(() => {});
  recorder?.close();
  const rows = Object.entries(results.vectors ?? {});
  results.summary = {
    reached: rows.filter(([, r]) => r.verdict?.startsWith("REACHED")).map(([n, r]) => `${n} (expected: ${r.expect})`),
    refused: rows.filter(([, r]) => r.verdict?.startsWith("refused")).map(([n]) => n),
    other: rows.filter(([, r]) => r.verdict && !/^(REACHED|refused)/.test(r.verdict)).map(([n, r]) => `${n}: ${r.verdict}`),
    errors: rows.filter(([, r]) => r.error).map(([n]) => n),
    otherRecorded: recorded.filter(r => !r.tag || !isPrivate(r.target)).map(r => `${r.kind} ${r.method} ${r.target}`).slice(0, 40),
  };
  console.log(JSON.stringify(results, null, 1));
  kit.close();
}
