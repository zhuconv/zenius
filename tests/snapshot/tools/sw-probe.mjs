// Red-teaming zen-observe's sw-bypass: a task's pages don't use the site's
// service worker that the user's tabs registered. The manager's checks for
// the final candidate (2026-11-21):
// - an agent page on a site where the user's tab registered a service
//   worker isn't controlled by it, and the user's tab still is;
// - navigator.serviceWorker.ready and .controller read from the agent's
//   world agree with the page;
// - a task's shared worker isn't the one the user's tabs share;
// - with the worker guard (107f93c), a task page's workers find no
//   registration and no controller, and nothing they send reaches the
//   site's worker: blob, site script, shared, nested, module, a same-site
//   frame's, and one that first deletes the members the guard replaced.
// - with e333c7c, a worker the task's shared worker starts from a URL skips
//   the site's worker, before and after the claim; a blob one started after
//   the claim is zen-observe's documented bound (reported, not judged).
// Then the offer, apart from those: the site's worker posts a port to every
// client it sees, twice. Does any of the task's clients (its page and frame,
// its dedicated and shared workers, the agent's world and worker) answer
// through it or through e.source, while each kind in the user's tab does?
// And what does each task document and worker report (once each)?
//
// Headless on the Linux server, loopback only (127.0.0.1 is a secure context, so a
// worker registers over http). The user's tabs are opened from chrome, as
// the user's; the agent's page is this probe's zenius client's. The site's
// worker claims every client and answers /sw-marked and /sw-nav itself, and
// logs every request it sees to /sw-log; its shared worker answers each
// connect with its own random id.
//
//   scripts/zen-dev.sh <name> start
//   ZENIUS_INSTANCE=<name> node tests/snapshot/tools/sw-probe.mjs > out.json

import { createServer } from "node:http";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const PORT = Number(process.env.ZS_PORT_SW) || 47437;
const A = `http://127.0.0.1:${PORT}`;
const swLog = [];

// The page computes what it sees itself, in its own world, and writes it to
// its DOM (readable from any world): its worker's state, a fetch the worker
// would answer, and its shared worker's id.
const STATE_SCRIPT = `
  const sw = navigator.serviceWorker;
  const state = async () => {
    const ready = await Promise.race([sw.ready.then(r => "ready:" + (r && r.active ? "active" : "none")), new Promise(r => setTimeout(() => r("pending"), 1500))]);
    const reg = await sw.getRegistration().then(r => (r ? "reg" : "none"), e => "error:" + e.name);
    const regs = await sw.getRegistrations().then(l => l.length, e => "error:" + e.name);
    const viaSw = await fetch("/sw-marked?from=" + encodeURIComponent(location.search)).then(r => r.text(), () => "error");
    return { controller: !!sw.controller, ready, reg, regs, viaSw };
  };
  const write = async () => { document.documentElement.dataset.swstate = JSON.stringify(await state()); };
  if (location.search.includes("register")) {
    sw.register("/sw.js", { scope: "/" }).then(() => {}, e => { document.documentElement.dataset.registerError = e.name; });
  }
  sw.addEventListener("controllerchange", write);
  sw.addEventListener("message", e => {
    const port = e.ports && e.ports[0];
    if (port) port.postMessage("page" + location.search);
    // And back through the message's source, the site's worker itself.
    try { if (e.source) e.source.postMessage("ping:page-source" + location.search); } catch {}
    document.documentElement.dataset.offer = JSON.stringify({ got: true, port: !!port, source: !!e.source });
  });
  if (sw.startMessages) sw.startMessages();
  setInterval(write, 1000);
  write();
  try {
    const shared = new SharedWorker("/shared.js", "zs");
    shared.port.onmessage = e => { document.documentElement.dataset.shared = JSON.stringify(e.data); };
    shared.port.start();
    // Who connects, so the shared worker can say whose it is.
    shared.port.postMessage("hello" + location.search);
    // Its fetch again every 2 s: a later claim may take the shared worker.
    setInterval(() => shared.port.postMessage("fetch"), 2000);
  } catch (e) {
    document.documentElement.dataset.shared = JSON.stringify({ error: e.name });
  }
  try {
    // The page's search in its URL: its requests say whose they are.
    const dw = new Worker("/dw.js" + location.search);
    dw.onmessage = e => { document.documentElement.dataset.dw = JSON.stringify(e.data); };
  } catch (e) {
    document.documentElement.dataset.dw = JSON.stringify({ error: e.name });
  }
  // With ?reach, the site's own code tries to reach the worker: through its
  // container, and through a fresh about:blank frame's, whose prototypes
  // nothing has touched yet.
  if (location.search.includes("reach")) {
    const reach = async (container, label, out) => {
      try {
        const reg = await Promise.race([container.getRegistration(), new Promise(r => setTimeout(() => r("timeout"), 1500))]);
        out[label + "Reg"] = reg === "timeout" ? "timeout" : reg ? "reg" : "none";
        if (reg && reg !== "timeout" && reg.active) reg.active.postMessage("ping:" + label);
        out[label + "Ready"] = await Promise.race([container.ready.then(r => { if (r && r.active) r.active.postMessage("ping:" + label + "-ready"); return "ready"; }), new Promise(r => setTimeout(() => r("pending"), 1500))]);
      } catch (e) {
        out[label + "Error"] = e.name;
      }
    };
    (async () => {
      const out = {};
      await reach(navigator.serviceWorker, "page", out);
      const blank = document.createElement("iframe");
      document.body.append(blank);
      await new Promise(r => setTimeout(r, 300));
      await reach(blank.contentWindow.navigator.serviceWorker, "pageBlankFrame", out);
      document.documentElement.dataset.reach = JSON.stringify(out);
    })();
  }
  // A same-site frame, which fetches as the page does.
  const frame = document.createElement("iframe");
  frame.src = "/sw-frame" + location.search;
  document.body.append(frame);
  setInterval(() => { try { const v = frame.contentDocument?.documentElement?.dataset.viaSw; if (v) document.documentElement.dataset.frame = JSON.stringify(v); } catch {} }, 500);
`;
const page = (title, body) => `<!doctype html><meta charset=utf-8><title>${title}</title><body>${body}<script>${STATE_SCRIPT}</script></body>`;
const SW = `
  self.addEventListener("install", () => self.skipWaiting());
  // A later claim, when the user's tab asks for one.
  self.addEventListener("message", e => {
    if (e.data === "claim") e.waitUntil(self.clients.claim());
    else if (typeof e.data === "string" && e.data.startsWith("ping:")) e.waitUntil(fetch("/sw-log?u=" + encodeURIComponent(e.data)).catch(() => {}));
    else if (e.data === "offer") {
      // Every client it sees, the uncontrolled included, gets a port it
      // listens on; it stays up a while for the answers.
      e.waitUntil((async () => {
        const all = await self.clients.matchAll({ includeUncontrolled: true, type: "all" });
        for (const c of all) {
          const ch = new MessageChannel();
          ch.port1.onmessage = m => fetch("/sw-log?u=" + encodeURIComponent("port:" + m.data)).catch(() => {});
          c.postMessage({ offer: true }, [ch.port2]);
        }
        await fetch("/sw-log?u=" + encodeURIComponent("offered:" + all.map(c => c.type + " " + new URL(c.url).search).join(" | "))).catch(() => {});
        await new Promise(r => setTimeout(r, 4000));
      })());
    }
  });
  self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
  self.addEventListener("fetch", e => {
    const u = new URL(e.request.url);
    if (u.pathname === "/sw-log") return;
    fetch("/sw-log?u=" + encodeURIComponent(u.pathname + u.search) + "&mode=" + e.request.mode).catch(() => {});
    if (u.pathname === "/sw-marked") e.respondWith(new Response("FROM_SW"));
    else if (u.pathname === "/sw-nav") e.respondWith(new Response("<!doctype html><title>SW_NAV</title><p>SW_NAV", { headers: { "content-type": "text/html" } }));
  });
`;
// From inside a worker: its own navigator.serviceWorker (zen-observe's find,
// 2026-11-21: a task page's workers still had it). label names the pings.
const WORKER_REACH = (label, prelude = "") => `(async () => {
  ${prelude}
  const out = { exposed: typeof navigator.serviceWorker !== "undefined" };
  // A blob worker's own URL is blob:, so every URL here is absolute.
  const base = self.origin && self.origin !== "null" ? self.origin : "";
  try {
    if (out.exposed) {
      const sw = navigator.serviceWorker;
      const reg = await Promise.race([sw.getRegistration(base + "/"), new Promise(r => setTimeout(() => r("timeout"), 1500))]);
      out.reg = reg === "timeout" ? "timeout" : reg ? "reg" : "none";
      if (reg && reg !== "timeout" && reg.active) { reg.active.postMessage("ping:${label}"); out.posted = true; }
      out.controller = !!sw.controller;
    }
    out.viaSw = await fetch(base + "/sw-marked?from=${label}").then(r => r.text(), () => "error");
  } catch (e) {
    out.error = e.name;
  }
  return out;
})()`;
// The site's worker reaching out (the offer): a client that hears it answers
// through the port it was sent ("<label>") and through its source
// ("ping:<label-source>"). Each label says whose the client is.
const OFFER_LISTEN = label => `
  { const c = self.navigator && navigator.serviceWorker;
    if (c) {
      c.addEventListener("message", e => {
        const p = e.ports && e.ports[0];
        if (p) p.postMessage(${label});
        try { if (e.source) e.source.postMessage("ping:source-" + ${label}); } catch (x) {}
      });
      if (c.startMessages) c.startMessages();
    } }
`;
const SHARED = `
  const id = Math.random().toString(36).slice(2, 10);
  let n = 0;
  const whose = new Set();
  // The task's shared worker is only the task's pages' (agentSharedNotUsers).
  const tag = () => ([...whose].some(s => s.includes("agent")) ? "agent" : "user");
  const viaSw = () => fetch("/sw-marked?from=shared-" + tag()).then(r => r.text(), () => "error");
  // Workers it starts, one from the site's script and one from a blob, each
  // fetching once: e333c7c marks the first; the second, after a claim, is
  // zen-observe's documented bound.
  const nested = src => new Promise(resolve => {
    try {
      const w = new Worker(src);
      w.onmessage = e => { resolve(e.data); w.terminate(); };
      w.onerror = e => { resolve("error: " + (e.message || "worker error")); if (e.preventDefault) e.preventDefault(); };
      setTimeout(() => { resolve("no answer"); w.terminate(); }, 3000);
    } catch (e) { resolve("error: " + e.name); }
  });
  const nests = async () => ({
    url: await nested("/dw.js?nest-" + tag()),
    blob: await nested(URL.createObjectURL(new Blob(['fetch("' + location.origin + '/sw-marked?from=blob-nest-' + tag() + '").then(r => r.text()).then(t => postMessage(t), () => postMessage("error"));'], { type: "text/javascript" }))),
  });
  ${OFFER_LISTEN('"shared-" + tag()')}
  onconnect = async e => {
    n++;
    const port = e.ports[0];
    port.onmessage = async m => {
      if (typeof m.data === "string" && m.data.startsWith("hello")) whose.add(m.data.slice(5));
      else if (m.data === "fetch") port.postMessage({ id, n, viaSw: await viaSw(), nest: await nests(), at: Date.now() });
      else if (m.data === "reach") port.postMessage({ reach: await ${WORKER_REACH("shared")} });
    };
    port.postMessage({ id, n, viaSw: await viaSw() });
  };
`;
const DW = `${OFFER_LISTEN('"dw" + location.search')}
  fetch("/sw-marked?from=dw" + encodeURIComponent(location.search)).then(r => r.text()).then(t => postMessage(t), () => postMessage("error"));`;
const DW_REACH = `${WORKER_REACH("dw-site")}.then(o => postMessage(o));`;
const FRAME = `<!doctype html><meta charset=utf-8><title>sw frame</title><p>frame</p><script>fetch("/sw-marked?from=frame" + encodeURIComponent(location.search)).then(r => r.text(), () => "error").then(t => { document.documentElement.dataset.viaSw = t; });${OFFER_LISTEN('"frame" + location.search')}</script>`;

const server = await new Promise((ok, fail) => {
  const s = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (type, body) => {
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (u.pathname === "/sw-page") return send("text/html; charset=utf-8", page("sw page", "<p>SW_PAGE</p>"));
    if (u.pathname === "/sw-nav") return send("text/html; charset=utf-8", page("NET_NAV", "<p>NET_NAV</p>"));
    if (u.pathname === "/sw-marked") return send("text/plain", "FROM_NETWORK");
    if (u.pathname === "/sw.js") return send("text/javascript", SW);
    if (u.pathname === "/shared.js") return send("text/javascript", SHARED);
    if (u.pathname === "/dw.js") return send("text/javascript", DW);
    if (u.pathname === "/dw-reach.js") return send("text/javascript", DW_REACH);
    if (u.pathname === "/sw-frame") return send("text/html; charset=utf-8", FRAME);
    if (u.pathname === "/sw-log") {
      swLog.push(u.searchParams.get("u"));
      return send("text/plain", "ok");
    }
    res.writeHead(404);
    res.end("no");
  });
  s.once("error", fail);
  s.listen(PORT, "127.0.0.1", () => ok(s));
});

const { connect } = await import(join(here, "../../../scripts/lib/rpc.mjs"));
const instance = process.env.ZENIUS_INSTANCE;
if (!instance) {
  console.error("ZENIUS_INSTANCE is not set");
  process.exit(2);
}
const client = await connect(instance, { callTimeout: 60000 });
const step = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = (code, arg) => client.call("dev.evalChrome", { code: PRE + code, arg });
const PRE = `
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { let v; try { v = await fn(); } catch {} if (v || Date.now() > end) return v; await sleep(100); } };
  const tabOf = url => win.gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec === url);
  const read = async (t, key) => {
    const v = await ctx.content(t.linkedBrowser.browsingContext, "dev#evalContent", { privileged: false, code: "return document.documentElement.dataset[" + JSON.stringify(key) + "] ?? null" });
    return v ? JSON.parse(v) : null;
  };
`;
// What the agent's own world reads: the same checks, run by page.evaluate.
const AGENT_STATE = `async () => {
  const sw = navigator.serviceWorker;
  const ready = await Promise.race([sw.ready.then(r => "ready:" + (r && r.active ? "active" : "none")), new Promise(r => setTimeout(() => r("pending"), 1500))]);
  const reg = await sw.getRegistration().then(r => (r ? "reg" : "none"), e => "error:" + e.name);
  const regs = await sw.getRegistrations().then(l => l.length, e => "error:" + e.name);
  const viaSw = await fetch("/sw-marked?from=agent-world").then(r => r.text(), () => "error");
  return { controller: !!sw.controller, ready, reg, regs, viaSw };
}`;
const AGENT_SHARED = `async () => {
  try {
    const shared = new SharedWorker("/shared.js", "zs");
    return await new Promise(resolve => {
      shared.port.onmessage = e => resolve(e.data);
      shared.port.start();
      setTimeout(() => resolve("no answer"), 3000);
    });
  } catch (e) {
    return { error: e.name };
  }
}`;
const AGENT_REACH = `async () => {
  const out = {};
  const reach = async (container, label) => {
    try {
      const reg = await Promise.race([container.getRegistration(), new Promise(r => setTimeout(() => r("timeout"), 1500))]);
      out[label + "Reg"] = reg === "timeout" ? "timeout" : reg ? "reg" : "none";
      if (reg && reg !== "timeout" && reg.active) reg.active.postMessage("ping:" + label);
      out[label + "Ready"] = await Promise.race([container.ready.then(r => { if (r && r.active) r.active.postMessage("ping:" + label + "-ready"); return "ready"; }), new Promise(r => setTimeout(() => r("pending"), 1500))]);
    } catch (e) {
      out[label + "Error"] = e.name;
    }
  };
  await reach(navigator.serviceWorker, "world");
  const blank = document.createElement("iframe");
  document.body.append(blank);
  await new Promise(r => setTimeout(r, 300));
  await reach(blank.contentWindow.navigator.serviceWorker, "worldBlankFrame");
  blank.remove();
  return out;
}`;
const AGENT_WORKERS = `async () => {
  const ask = (w, label) => new Promise(resolve => {
    w.onmessage = e => resolve(e.data);
    w.onerror = e => resolve({ error: String(e.message || "worker error") });
    setTimeout(() => resolve("no answer"), 5000);
  });
  const out = {};
  try {
    const code = ${JSON.stringify(`${WORKER_REACH("dw-agent-blob")}.then(o => postMessage(o));`)};
    out.blob = await ask(new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" }))));
  } catch (e) { out.blob = { error: e.name }; }
  try { out.siteScript = await ask(new Worker("/dw-reach.js")); } catch (e) { out.siteScript = { error: e.name }; }
  const blobOf = (code, scope = self) => scope.URL.createObjectURL(new scope.Blob([code], { type: "text/javascript" }));
  // A worker the agent's worker starts (a nested worker).
  try {
    const inner = ${JSON.stringify(`${WORKER_REACH("dw-nested")}.then(o => postMessage(o));`)};
    const outer = "const w = new Worker(URL.createObjectURL(new Blob([" + JSON.stringify(inner) + "], { type: 'text/javascript' }))); w.onmessage = e => postMessage(e.data); w.onerror = e => postMessage({ error: 'nested: ' + (e.message || 'error') });";
    out.nested = await ask(new Worker(blobOf(outer)));
  } catch (e) { out.nested = { error: e.name }; }
  // A module worker.
  try {
    out.module = await ask(new Worker(blobOf(${JSON.stringify(`${WORKER_REACH("dw-module")}.then(o => postMessage(o));`)}), { type: "module" }));
  } catch (e) { out.module = { error: e.name }; }
  // A worker that a same-site frame of the page starts.
  try {
    const f = document.createElement("iframe");
    f.src = "/sw-frame?fw" + Math.random().toString(36).slice(2, 6);
    document.body.append(f);
    await new Promise(r => { f.onload = r; setTimeout(r, 3000); });
    const fw = f.contentWindow;
    out.frame = await ask(new fw.Worker(blobOf(${JSON.stringify(`${WORKER_REACH("dw-frame")}.then(o => postMessage(o));`)}, fw)));
    f.remove();
  } catch (e) { out.frame = { error: e.name + " " + String(e.message).slice(0, 80) }; }
  // A worker whose code first deletes the members the guard replaced, to see
  // whether a native one shows through.
  try {
    const prelude = "const P = self.ServiceWorkerContainer && ServiceWorkerContainer.prototype; const deleted = []; for (const n of ['getRegistration', 'getRegistrations', 'ready', 'controller']) { if (P && delete P[n]) deleted.push(n); } if (self.ServiceWorker && delete ServiceWorker.prototype.postMessage) deleted.push('postMessage'); const left = P ? Object.getOwnPropertyNames(P) : [];";
    const code = ${JSON.stringify(WORKER_REACH("dw-deleted", "__PRELUDE__"))}.replace("__PRELUDE__", prelude).replace("return out;", "out.deleted = deleted; out.left = left; return out;");
    out.deleted = await ask(new Worker(blobOf(code + ".then(o => postMessage(o));")));
  } catch (e) { out.deleted = { error: e.name }; }
  try {
    const shared = new SharedWorker("/shared.js", "zs");
    out.shared = await new Promise(resolve => {
      shared.port.onmessage = e => { if (e.data && e.data.reach) resolve(e.data.reach); };
      shared.port.start();
      shared.port.postMessage("reach");
      setTimeout(() => resolve("no answer"), 5000);
    });
  } catch (e) { out.shared = { error: e.name }; }
  return out;
}`;
const AGENT_OFFER_LISTEN = `async () => {
  const w = window;
  w.__zsOffers = [];
  w.__zsWorkerOffers = [];
  navigator.serviceWorker.addEventListener("message", e => {
    const p = e.ports && e.ports[0];
    if (p) p.postMessage("world");
    try { if (e.source) e.source.postMessage("ping:world-source"); } catch {}
    w.__zsOffers.push({ port: !!p, source: !!e.source });
  });
  if (navigator.serviceWorker.startMessages) navigator.serviceWorker.startMessages();
  const code = "const c = navigator.serviceWorker; if (c) { c.addEventListener('message', e => { const p = e.ports && e.ports[0]; if (p) p.postMessage('worker'); try { if (e.source) e.source.postMessage('ping:worker-source'); } catch (x) {} postMessage({ port: !!p, source: !!e.source }); }); if (c.startMessages) c.startMessages(); } postMessage('listening');";
  const worker = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
  worker.onmessage = e => w.__zsWorkerOffers.push(e.data);
  w.__zsOfferWorker = worker;
  await new Promise(r => setTimeout(r, 800));
  return { worker: w.__zsWorkerOffers.slice() };
}`;
const AGENT_OFFER_READ = `() => ({ world: window.__zsOffers || null, worker: window.__zsWorkerOffers || null })`;
const outcome = p => p.then(r => r?.result ?? r?.value ?? r, e => ({ error: `${e.code ?? ""} ${String(e.message).slice(0, 200)}` }));
// The worker a report names: "... a worker the page started (<url>) ...".
// zen-observe resolves it to an absolute URL after e333c7c (the debugger's
// url was the string passed to new Worker()).
const reportUrl = e => (/started \(([^)]*)\)/.exec(e.message ?? "") ?? [])[1] ?? null;
const absolute = u => /^(https?:|blob:)/.test(u ?? "");

const out = {};
let space = null;
try {
  // The user's tab registers the site's worker, which claims it.
  step("user registers");
  out.user1 = await chrome(`
    const url = arg + "/sw-page?register&u1";
    const t = win.gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    win.gBrowser.selectedTab = t;
    const s = await until(async () => { const v = await read(t, "swstate"); return v?.controller && v.viaSw === "FROM_SW" ? v : null; }, 15000);
    await sleep(1200);
    return { state: s ?? (await read(t, "swstate")), shared: await read(t, "shared") };
  `, A);
  step("user1", JSON.stringify(out.user1));
  // A second user tab: controlled at load, and the same shared worker (the control).
  out.user2 = await chrome(`
    const url = arg + "/sw-page?u2";
    const t = win.gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    await until(async () => (await read(t, "shared")) && (await read(t, "swstate")), 10000);
    await sleep(1200);
    return { state: await read(t, "swstate"), shared: await read(t, "shared") };
  `, A);
  step("user2", JSON.stringify(out.user2));

  // The agent's page on the same site.
  step("agent");
  ({ id: space } = await client.call("spaces.create", { name: `zs-sw-${Date.now().toString(36).slice(-5)}` }));
  await client.call("page.goto", { space, page: "p1", url: `${A}/sw-page?agent&reach`, options: {} });
  await sleep(2500);
  // The shared worker's report with its nested workers comes every 2 s.
  const AGENT_PAGE = `
    const t = ctx.resolvePage({ space: arg, page: "p1" }).tab;
    await until(async () => (await read(t, "shared"))?.nest, 8000);
    return { state: await read(t, "swstate"), shared: await read(t, "shared"), dw: await read(t, "dw"), frame: await read(t, "frame"), reach: await read(t, "reach") };
  `;
  out.agentPage = await chrome(AGENT_PAGE, space);
  out.agentWorld = await outcome(client.call("page.evaluate", { space, page: "p1", fn: AGENT_STATE }));
  out.agentWorldShared = await outcome(client.call("page.evaluate", { space, page: "p1", fn: AGENT_SHARED }));
  out.agentWorldReach = await outcome(client.call("page.evaluate", { space, page: "p1", fn: AGENT_REACH }));
  out.agentWorkers = await outcome(client.call("page.evaluate", { space, page: "p1", fn: AGENT_WORKERS }));
  // The user's tab asks the worker to claim every client again: does it take
  // the task's page, or its shared worker (90cc19f's residual)?
  out.claimAgain = await chrome(`
    const t = tabOf(arg + "/sw-page?register&u1");
    return ctx.content(t.linkedBrowser.browsingContext, "dev#evalContent", { privileged: false, code: "navigator.serviceWorker.controller.postMessage('claim'); return true" });
  `, A).catch(e => ({ error: e.message }));
  await sleep(4500);
  out.agentPageAfterClaim = await chrome(AGENT_PAGE, space);
  out.agentWorldAfterClaim = await outcome(client.call("page.evaluate", { space, page: "p1", fn: AGENT_STATE }));
  out.agentWorkersAfterClaim = await outcome(client.call("page.evaluate", { space, page: "p1", fn: AGENT_WORKERS }));
  await sleep(500);
  const events = await outcome(client.call("page.events", { space, page: "p1" }));
  const refused = Array.isArray(events) ? events.filter(e => e.method === "Zenius.refused").map(e => ({ kind: e.params?.kind, message: String(e.params?.message ?? "").slice(0, 200) })) : [{ error: JSON.stringify(events).slice(0, 200) }];
  out.workerReports = refused.filter(e => /^A worker the page started/.test(e.message));
  out.pageReports = refused.filter(e => !/^A worker the page started/.test(e.message)).map(e => e.kind + ": " + e.message.slice(0, 90));
  // A navigation the worker would answer itself.
  await client.call("page.goto", { space, page: "p1", url: `${A}/sw-nav?agent`, options: {} });
  await sleep(800);
  out.agentNavTitle = await outcome(client.call("page.evaluate", { space, page: "p1", fn: "() => document.title" }));
  step("agent", JSON.stringify({ page: out.agentPage, world: out.agentWorld, worldShared: out.agentWorldShared, nav: out.agentNavTitle }));

  // The user's tab still uses the worker, before and after a reload.
  out.user1After = await chrome(`
    const t = tabOf(arg + "/sw-page?register&u1");
    const before = await read(t, "swstate");
    t.linkedBrowser.reload();
    await sleep(2500);
    return { before, afterReload: await read(t, "swstate"), shared: await read(t, "shared") };
  `, A);
  out.swSaw = [...swLog];
  // A blob worker that the task's claimed shared worker starts after the
  // claim inherits the site's worker: zen-observe's documented bound.
  const isBound = u => /from=blob-nest-agent/.test(u ?? "");
  out.swSawAgent = swLog.filter(u => /agent/.test(u ?? "") && !isBound(u));
  out.boundSeen = swLog.filter(isBound);

  // The verdicts.
  const sharedId = x => (x && typeof x === "object" && "id" in x ? x.id : null);
  const u1 = out.user1?.state;
  const pageState = out.agentPage?.state;
  const world = out.agentWorld;
  const pageReach = out.agentPageAfterClaim?.reach ?? out.agentPage?.reach;
  const workerSeesNone = w => w && typeof w === "object" && !w.posted && w.reg !== "reg" && !w.controller;
  out.verdict = {
    userControlled: !!u1?.controller && u1.viaSw === "FROM_SW",
    usersShareTheirWorker: !!sharedId(out.user1?.shared) && sharedId(out.user1?.shared) === sharedId(out.user2?.shared),
    agentPageUncontrolled: pageState ? !pageState.controller && pageState.viaSw === "FROM_NETWORK" : null,
    agentNavFromNetwork: out.agentNavTitle === "NET_NAV",
    agentFrameFromNetwork: out.agentPage?.frame === "FROM_NETWORK",
    agentDedicatedFromNetwork: out.agentPage?.dw === "FROM_NETWORK",
    agentSharedFromNetwork: out.agentPage?.shared?.viaSw === "FROM_NETWORK",
    agentPageUncontrolledAfterClaim: out.agentPageAfterClaim?.state ? !out.agentPageAfterClaim.state.controller && out.agentPageAfterClaim.state.viaSw === "FROM_NETWORK" : null,
    agentSharedFromNetworkAfterClaim: out.agentPageAfterClaim?.shared?.viaSw === "FROM_NETWORK",
    // e333c7c: a worker the task's shared worker starts from a URL skips the
    // site's worker, before and after the claim; a blob one before it.
    sharedNestUrlFromNetwork: out.agentPage?.shared?.nest?.url === "FROM_NETWORK" && out.agentPageAfterClaim?.shared?.nest?.url === "FROM_NETWORK",
    sharedNestBlobFromNetworkBeforeClaim: out.agentPage?.shared?.nest?.blob === "FROM_NETWORK",
    boundBlobNestAfterClaim: out.agentPageAfterClaim?.shared?.nest?.blob ?? null,
    worldAgreesAfterClaim: !!out.agentPageAfterClaim?.state && !!out.agentWorldAfterClaim && !out.agentWorldAfterClaim.error && ["controller", "ready", "reg", "regs"].every(k => JSON.stringify(out.agentWorldAfterClaim[k]) === JSON.stringify(out.agentPageAfterClaim.state[k])),
    workerSawNoAgentRequest: out.swSawAgent.length === 0,
    noMessageReachedWorker: !swLog.some(u => /^ping:/.test(u ?? "")),
    workersSeeNoWorker: [out.agentWorkers, out.agentWorkersAfterClaim].every(w => w && !w.error && ["blob", "siteScript", "shared"].every(k => workerSeesNone(w[k]))),
    // The extra workers each ran and saw none (an answer that never came, or
    // an error without having looked, isn't a pass).
    extraWorkersSeeNoWorker: [out.agentWorkers, out.agentWorkersAfterClaim].every(w => w && !w.error && ["nested", "module", "frame", "deleted"].every(k => workerSeesNone(w[k]) && w[k].exposed !== undefined)),
    workerReports: (out.workerReports ?? []).length,
    workerReportUrlsAbsolute: (out.workerReports ?? []).every(e => absolute(reportUrl(e))),
    workersFetchFromNetwork: [out.agentWorkers, out.agentWorkersAfterClaim].every(w => w && !w.error && ["blob", "siteScript", "shared"].every(k => w[k]?.viaSw === "FROM_NETWORK")),
    pings: swLog.filter(u => /^ping:/.test(u ?? "")),
    pageCantReach: pageReach ? Object.entries(pageReach).every(([k, v]) => !/Reg$/.test(k) || v === "none") : null,
    worldCantReach: out.agentWorldReach && !out.agentWorldReach.error ? Object.entries(out.agentWorldReach).every(([k, v]) => !/Reg$/.test(k) || v === "none") : null,
    userStillControlled: !!out.user1After?.afterReload?.controller && out.user1After.afterReload.viaSw === "FROM_SW",
    worldAgreesWithPage: !!pageState && !!world && !world.error && ["controller", "ready", "reg", "regs"].every(k => JSON.stringify(world[k]) === JSON.stringify(pageState[k])),
    agentSharedNotUsers: sharedId(out.agentPage?.shared) !== null ? sharedId(out.agentPage.shared) !== sharedId(out.user1?.shared) : out.agentPage?.shared ?? null,
    agentWorldSharedNotUsers: sharedId(out.agentWorldShared) !== null ? sharedId(out.agentWorldShared) !== sharedId(out.user1?.shared) : out.agentWorldShared ?? null,
  };

  // The site's worker reaching out first: on "offer" it hands every client
  // it sees, the uncontrolled included, a port it listens on. Does the
  // task's page, the agent's world or a worker of the task answer through it?
  step("offer");
  await client.call("page.goto", { space, page: "p1", url: `${A}/sw-page?agent&offer`, options: {} });
  await sleep(1500);
  out.offerListen = await outcome(client.call("page.evaluate", { space, page: "p1", fn: AGENT_OFFER_LISTEN }));
  // What the new page reported as it loaded goes; the offer's reports follow.
  const drainRefused = async () => {
    const ev = await outcome(client.call("page.events", { space, page: "p1" }));
    return Array.isArray(ev) ? ev.filter(e => e.method === "Zenius.refused").map(e => ({ kind: e.params?.kind, message: String(e.params?.message ?? "").slice(0, 240) })) : [{ error: JSON.stringify(ev).slice(0, 200) }];
  };
  await drainRefused();
  const logBefore = swLog.length;
  // Twice: each client should still report once.
  out.offerSent = [];
  for (let i = 0; i < 2; i++) {
    out.offerSent.push(await chrome(`
      const t = tabOf(arg + "/sw-page?register&u1");
      return ctx.content(t.linkedBrowser.browsingContext, "dev#evalContent", { privileged: false, code: "navigator.serviceWorker.controller.postMessage('offer'); return true" });
    `, A).catch(e => ({ error: e.message })));
    await sleep(2500);
  }
  await sleep(1000);
  out.offerWorld = await outcome(client.call("page.evaluate", { space, page: "p1", fn: AGENT_OFFER_READ }));
  out.offerPage = await chrome(`const t = ctx.resolvePage({ space: arg, page: "p1" }).tab; return await read(t, "offer");`, space).catch(e => ({ error: e.message }));
  out.offerLog = swLog.slice(logBefore);
  out.offerReports = (await drainRefused()).filter(e => e.error || /sent (the page|a worker)/.test(e.message));
  const answers = out.offerLog.filter(u => /^port:/.test(u ?? ""));
  const sourcePings = out.offerLog.filter(u => /^ping:/.test(u ?? "") && /source/.test(u));
  // The task's clients: its page and frame (?agent), its dedicated worker
  // (dw?agent), its shared worker (shared-agent), the agent's world and the
  // agent's worker. The user's tab's are the control.
  const isTask = u => /agent|world|worker/.test(u ?? "");
  out.verdict.offerClientsSeen = out.offerLog.filter(u => /^offered:/.test(u ?? ""));
  out.verdict.usersAnsweredOffer = out.offerLog.some(u => /^port:page\?register/.test(u ?? ""));
  out.verdict.usersEveryKindAnswered = ["page?register", "frame?register", "dw?register", "shared-user"].every(l => answers.some(u => u.startsWith("port:" + l)));
  out.verdict.noAnswerFromTask = !answers.some(isTask);
  out.verdict.usersSourceReached = sourcePings.some(u => /\?register/.test(u));
  out.verdict.noSourceMessageFromTask = !sourcePings.some(isTask);
  out.verdict.offerNoTaskRequest = !out.offerLog.some(u => !/^(port|ping|offered):/.test(u ?? "") && /agent/.test(u ?? "") && !isBound(u));
  out.verdict.offerReports = {
    documents: out.offerReports.filter(e => /sent the page a message/.test(e.message)).length,
    workers: out.offerReports.filter(e => /sent a worker the page started/.test(e.message)).length,
    kinds: [...new Set(out.offerReports.map(e => e.kind))],
    urlsAbsolute: out.offerReports.filter(e => /sent a worker the page started/.test(e.message)).every(e => absolute(reportUrl(e))),
  };
} finally {
  // Put the site back as it was: the worker unregistered, the user's tabs closed.
  await chrome(`
    const t = tabOf(arg + "/sw-page?register&u1");
    if (t) await ctx.content(t.linkedBrowser.browsingContext, "dev#evalContent", { privileged: false, code: "const r = await navigator.serviceWorker.getRegistration(); return r ? await r.unregister() : false" }).catch(() => {});
    for (const x of [...win.gBrowser.tabs]) if (x.linkedBrowser.currentURI.spec.startsWith(arg + "/sw-page?") && !ctx.service.lookup(x)) win.gBrowser.removeTab(x, { animate: false });
    return true;
  `, A).catch(() => {});
  if (space) await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
  console.log(JSON.stringify(out, null, 1));
  client.close?.();
  server.closeAllConnections?.();
  server.close();
}
