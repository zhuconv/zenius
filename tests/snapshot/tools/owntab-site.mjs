// The fixture site for zen-snapshot's probes, first written for the own
// tab, which zen-ux removed. Loopback
// only: 127.0.0.1 is the site, 127.0.0.2 a second site.
import http from "node:http";

const JS = "text/javascript";

/**
 * What planted keyloggers sent, from any origin (opaque ones included):
 * {probe, v} per GET /caught?probe=&v=, in order.
 */
export const caught = [];

/** Requests to /geo, the dev profile's network location provider (devices-probe.mjs). */
export const geoHits = [];
/** Requests to /hub/, the dev profile's ML model hub (devices-probe.mjs): a speech model download. */
export const hubHits = [];
/** Requests to /hit?<tag> (localnet-probe.mjs's controls). */
export const netHits = [];

// localnet-probe.mjs's pages. The site's page (/net), and the user's own page
// on the site (/net-user), which names its window and opens a popup that
// keeps it as its opener, as a site's "open in a new window" does.
const netPage = `<!doctype html><meta charset=utf-8><title>Site net</title>
<button id=go>Go</button> <a id=lnk href="/net">link</a>
<form id=frm method=post action="/hit?form"><button id=sub>Send</button></form>
<p id=text>Some text of the site.</p>
<script>window.__out = {};</script>`;
// A page whose own script fetches ?to= as it loads (a site that looks at the
// local network, which a page can send the user to).
const netLanPage = `<!doctype html><meta charset=utf-8><title>Site scan</title>
<script>fetch(new URLSearchParams(location.search).get("to")).catch(() => {});</script>`;
const netUserPage = `<!doctype html><meta charset=utf-8><title>Site home</title>
<button id=pop onclick="window.__pop = window.open('/net', 'zsPop')">Open the tool</button>
<script>window.name = "zsUserTab"; window.__out = {};</script>`;

// reach-probe.mjs's page, one per role:
// the user's windows (W, U, Q, R, frames F1 and F2), the task's (P, T) and
// tabs opened from a task page (H1-H5). ?a= and ?b= are the two sites. Each
// page notes the probe's tags posted to it (__got) and, as a site that syncs
// with its popups does, posts to the windows it holds every 300 ms.
const reachPage = `<!doctype html><meta charset=utf-8><title>reach</title>
<p id=text>A page of the site.</p>
<button id=openU>U</button> <button id=openP>P</button> <button id=openPB>P on B</button>
<button id=openQ>Q</button> <button id=openR>R on B</button>
<p><a id=blank target=_blank>blank</a> <a id=blankOpener target=_blank rel=opener>blank opener</a>
<a id=named target=zsH>named</a> <a id=plain>plain</a> <a id=blankOpenerB target=_blank rel=opener>blank opener B</a></p>
<div id=frames></div>
<div id=zsEd contenteditable>edit</div>
<script>
const q = new URLSearchParams(location.search);
const role = q.get("role"), A = q.get("a"), B = q.get("b");
const url = (base, r) => base + "/reach?role=" + r + "&a=" + encodeURIComponent(A) + "&b=" + encodeURIComponent(B);
document.title = "reach " + role;
window.__role = role;
window.__got = [];
addEventListener("message", e => { if (e.data && e.data.zs) __got.push(e.data.zs); });
if (q.get("name") && !window.name) window.name = q.get("name");
const opens = { openU: [A, "U", "zsU"], openP: [A, "P", "zsP"], openPB: [B, "P", "zsP"], openQ: [A, "Q", "zsQ"], openR: [B, "R", "zsR"] };
for (const [id, [base, r, name]] of Object.entries(opens)) {
  document.getElementById(id).onclick = () => { window["__" + r.toLowerCase()] = window.open(url(base, r), name); };
}
const links = { blank: [A, "H1"], blankOpener: [A, "H2"], named: [A, "H3"], plain: [A, "H4"], blankOpenerB: [B, "H5"] };
for (const [id, [base, r]] of Object.entries(links)) document.getElementById(id).href = url(base, r);
if (role === "U") {
  document.getElementById("frames").innerHTML = '<iframe name=zsF1 src="' + url(A, "F1") + '"></iframe><iframe name=zsF2 src="' + url(B, "F2") + '"></iframe>';
}
setInterval(() => {
  for (const w of [window.opener, window.__u, window.__p, window.__q, window.__r]) {
    try { if (w && !w.closed) w.postMessage({ sync: role }, "*"); } catch (e) {}
  }
}, 300);
</script>`;

const login = other => `<!doctype html><meta charset=utf-8><title>Site login</title>
<form onsubmit="return false"><input name=user id=user><input type=password name=pw id=pw></form>
<button id=pop onclick="window.__pop = window.open('/login', 'pop')">Pop login</button>
<button id=help onclick="window.__help = window.open('/help', 'help')">Help</button>
<button id=named onclick="window.__named = window.open('', 'own-window')">Named</button>
<button id=popB onclick="window.__popB = window.open('${other}/login', 'popB')">Other site</button>
<button id=popBlank onclick="window.__pb = window.open('', 'pb')">Blank</button>
<script>
  // The site's own cross-tab sync, as many apps have.
  const bc = new BroadcastChannel("site");
  const user = document.getElementById("user");
  let port = null;
  try { const w = new SharedWorker("/shared.js", "sync"); w.port.start(); port = w.port; } catch (e) {}
  user.addEventListener("input", () => {
    bc.postMessage({ user: user.value });
    localStorage.setItem("draft", user.value);
    port?.postMessage({ user: user.value });
  });
</script>`;

// A page of site A that frames site B's login, as a shop frames its payment
// or sign-in provider; its button opens a popup on site B.
const framed = other => `<!doctype html><meta charset=utf-8><title>Site checkout</title>
<iframe id=provider src="${other}/login" width=400 height=200></iframe>
<button id=popB onclick="window.__popB = window.open('${other}/help', 'popB2')">Provider help</button>`;

// The same, with the provider's frame added only when the user asks for it.
const framedLater = other => `<!doctype html><meta charset=utf-8><title>Site checkout</title>
<p id=hello>Checkout</p>
<button id=addB onclick="const f = document.createElement('iframe'); f.id = 'provider'; f.src = '${other}/login'; document.body.append(f)">Sign in with the provider</button>
<button id=popB onclick="window.__popB = window.open('${other}/help', 'popB3')">Provider help</button>`;

// A page whose own worker writes to Cache Storage for it, on request: a worker
// that exists before any agent code runs, and that takes its writes by message.
const app2 = `<!doctype html><meta charset=utf-8><title>Site app 2</title><input type=password id=pw>
<button id=probe>Probe</button>
<script>window.siteWorker = new Worker("/cache-helper.js");</script>`;

const cacheHelper = `
onmessage = async e => {
  try {
    const c = await caches.open(e.data.cache);
    await c.put(e.data.url, new Response(e.data.body, { headers: { "content-type": e.data.type } }));
    postMessage("stored");
  } catch (err) {
    postMessage("refused: " + err.name);
  }
};`;

// The site's shared worker, doing the same for any of the site's tabs.
const sharedCache = `
onconnect = e => {
  const p = e.ports[0];
  p.onmessage = async m => {
    try {
      const c = await caches.open(m.data.cache);
      await c.put(m.data.url, new Response(m.data.body, { headers: { "content-type": m.data.type } }));
      p.postMessage("stored");
    } catch (err) {
      p.postMessage("refused: " + err.name);
    }
  };
};`;

const app = `<!doctype html><meta charset=utf-8><title>Site app</title><input type=password name=pw id=pw>
<script>navigator.serviceWorker.register("/site-sw.js");</script>
<script src="/app.js"></script>`;

// The site's own service worker: /app.js cache-first, as a PWA's precache.
const siteSw = `
self.addEventListener("install", e => e.waitUntil(caches.open("site-v1").then(c => c.addAll(["/app.js"])).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => {
  if (new URL(e.request.url).pathname === "/app.js") e.respondWith(caches.match("/app.js").then(r => r || fetch(e.request)));
});`;

const shared = `
const ports = [];
onconnect = e => { const p = e.ports[0]; ports.push(p); p.onmessage = m => { for (const q of ports) if (q !== p) q.postMessage(m.data); }; };`;

// The residuals of the storage refusal (bypass-probe.mjs residual*):
// - a site's own service worker, from the user's earlier visit, that caches
//   what its pages fetch, and caches the URLs a page asks it to save;
// - a site that keeps its own code in localStorage and runs it on each
//   visit (the lscache pattern).
const rtPage = `<!doctype html><meta charset=utf-8><title>Site offline app</title>
<script>navigator.serviceWorker.register("/sw-runtime.js", { scope: "/rt/" }).catch(() => {});</script>`;

const swRuntime = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => {
  if (!new URL(e.request.url).pathname.startsWith("/rt/item")) return;
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone();
    e.waitUntil(caches.open("rt").then(c => c.put(e.request, copy)));
    return r;
  }));
});
self.addEventListener("message", e => {
  if (e.data && e.data.saveForOffline) e.waitUntil(caches.open("rt").then(c => c.addAll(e.data.saveForOffline)));
});`;

const lsCode = `<!doctype html><meta charset=utf-8><title>Site app (stored code)</title>
<form onsubmit="return false"><input type=password id=pw></form>
<script>
const code = localStorage.getItem("app-code");
if (code) { (0, eval)(code); } else { localStorage.setItem("app-code", "document.title = 'Site app (stored code)';"); }
</script>`;

// The device pages for devices-probe.mjs: a page the agent's code works in
// (#go for gestures), and a page whose own code asks for the camera, the
// microphone and the location as it loads, reporting to __out and to its
// parent frame.
const devicesPage = `<!doctype html><meta charset=utf-8><title>Site devices</title>
<button id=go>Go</button><input id=f>
<script>window.__out = {};</script>`;

// A page the bfcache may keep (no no-store), which records its pageshows.
const bfPage = `<!doctype html><meta charset=utf-8><title>Site page</title><p>A page of the site.</p>
<script>window.__shows = []; addEventListener("pageshow", e => __shows.push(e.persisted));</script>`;

const gumOnLoad = `<!doctype html><meta charset=utf-8><title>Site call</title>
<script>
window.__out = {};
const report = (kind, v) => {
  __out[kind] = v;
  for (const to of [parent !== window ? parent : null, opener]) {
    try { to?.postMessage({ zsOnLoad: { kind, v } }, "*"); } catch {}
  }
};
try {
  navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(
    s => { report("gum", "resolved: stream (" + s.getTracks().map(t => t.kind).join(",") + ")"); s.getTracks().forEach(t => t.stop()); },
    e => report("gum", "rejected: " + e.name + ": " + e.message));
} catch (e) { report("gum", "threw: " + e.name); }
try {
  navigator.geolocation.getCurrentPosition(
    () => report("geo", "resolved: position"),
    e => report("geo", "rejected: PositionError" + e.code + ": " + e.message), { timeout: 4000, maximumAge: 0 });
} catch (e) { report("geo", "threw: " + e.name); }
</script>`;

// The input lab for process-input-probe.mjs:
// controls at fixed places, and a log of every input event the page sees.
// __log.splice(0) reads and clears it; __state() reads focus, selection and
// the :active, :hover and pointer-capture states.
const lab = `<!doctype html><meta charset=utf-8><title>Input lab</title>
<style>
body { margin: 0; font: 16px/20px monospace; }
#btn { position: absolute; left: 20px; top: 20px; width: 160px; height: 40px; }
#pad { position: absolute; left: 20px; top: 80px; width: 300px; height: 120px; background: #ddd; touch-action: none; }
#text { position: absolute; left: 20px; top: 220px; width: 700px; margin: 0; }
#field { position: absolute; left: 20px; top: 300px; width: 300px; height: 24px; }
#src { position: absolute; left: 400px; top: 20px; width: 80px; height: 40px; background: #cfc; }
#dst { position: absolute; left: 520px; top: 20px; width: 80px; height: 40px; background: #ccf; }
</style>
<button id=btn>Press</button>
<div id=pad></div>
<p id=text>alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike</p>
<input id=field>
<div id=src draggable=true>drag</div><div id=dst>drop</div>
<script>
window.__log = [];
const t0 = performance.now();
// The log's t is per page; this puts two pages' events on one clock.
window.__t0 = performance.timeOrigin + t0;
const types = ["pointerdown", "pointermove", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture",
  "mousedown", "mousemove", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "mouseover", "mouseout",
  "focus", "blur", "focusin", "focusout", "keydown", "keyup", "beforeinput", "input",
  "compositionstart", "compositionupdate", "compositionend",
  "dragstart", "dragenter", "dragover", "dragleave", "drop", "dragend", "wheel", "selectstart"];
for (const type of types) {
  window.addEventListener(type, e => {
    if (__log.length > 3000) return;
    __log.push({
      type, trusted: e.isTrusted, t: Math.round(performance.now() - t0),
      target: e.target?.id || e.target?.nodeName || String(e.target),
      x: e.clientX, y: e.clientY, mx: e.movementX, my: e.movementY,
      button: e.button, buttons: e.buttons, detail: e.detail, pointerId: e.pointerId,
      key: e.key, data: e.data, hasFocus: document.hasFocus(),
      mods: (e.shiftKey ? "S" : "") + (e.ctrlKey ? "C" : "") + (e.altKey ? "A" : "") + (e.metaKey ? "M" : "") || undefined,
    });
  }, true);
}
document.getElementById("dst").addEventListener("dragover", e => e.preventDefault());
// A drop nothing handles would load its text as a link (Gecko's DropLinks).
window.addEventListener("drop", e => e.preventDefault());
document.getElementById("src").addEventListener("dragstart", e => e.dataTransfer.setData("text/plain", "lab-drag"));
window.__state = () => {
  const $ = id => document.getElementById(id);
  return {
    active: document.activeElement?.id || document.activeElement?.nodeName,
    hasFocus: document.hasFocus(),
    hidden: document.hidden,
    selection: String(getSelection()),
    btnActive: $("btn").matches(":active"),
    btnHover: $("btn").matches(":hover"),
    padHover: $("pad").matches(":hover"),
    field: $("field").value,
    padCapture: $("pad").hasPointerCapture(0),
  };
};
</script>`;

// channels-probe.mjs: the site's same-origin channels that need no window
// handle. Each page joins a BroadcastChannel, hears storage events, and
// connects to one SharedWorker, which sends each message it gets to every
// port with the number of ports. __send(tag) speaks on all of them and sets
// localStorage and a cookie; __chan lists what this page heard.
const chanPage = `<!doctype html><meta charset=utf-8><title>Channels</title>
<p>channels</p>
<script>
window.__chan = [];
const bc = new BroadcastChannel("zs-chan");
bc.onmessage = e => __chan.push({ via: "broadcast", data: e.data });
addEventListener("storage", e => __chan.push({ via: "storage", key: e.key, value: e.newValue }));
let port = null;
try {
  const w = new SharedWorker("/chan-worker.js", "zs-chan");
  port = w.port;
  port.onmessage = e => __chan.push({ via: "worker", data: e.data });
  port.start();
} catch (e) {
  __chan.push({ via: "worker", error: String(e) });
}
window.__send = tag => {
  bc.postMessage(tag);
  localStorage.setItem("zs-chan", tag + " " + Date.now());
  document.cookie = "zschan=" + tag + "; path=/; SameSite=Lax";
  port?.postMessage(tag);
  return true;
};
window.__peek = () => ({ local: localStorage.getItem("zs-chan"), cookie: document.cookie });
window.__chanReady = true;
</script>`;
// A sign-in page for the hold map (hold-probe.mjs): a visible field and a
// password field, a frame of its own site, a button that opens a popup, and
// the site's own cross-tab sync, opened at load as many apps do (a
// BroadcastChannel, storage events, a shared worker). The sync carries what
// the user types in the visible field. __holdSend speaks on the load-time
// channels, __holdNew on a channel made at the call.
const holdPage = `<!doctype html><meta charset=utf-8><title>hold</title>
<form id=f onsubmit="return false"><input id=user name=user><input type=password id=secret name=secret></form>
<button id=pop>Pop</button>
<iframe id=hf name=zsHF src="/hold-frame" width=200 height=60></iframe>
<script>
const q = new URLSearchParams(location.search);
const role = q.get("role") || "H";
document.title = "hold " + role;
if (q.get("name") && !window.name) window.name = q.get("name");
window.__hold = [];
// A sign-in page's own message handling (a popup's report to its opener, an opener's reply).
addEventListener("message", e => { if (typeof e.data === "string" && e.data.startsWith("from-")) __hold.push({ via: "message", data: e.data }); });
const sync = new BroadcastChannel("zs-hold");
sync.onmessage = e => __hold.push({ via: "broadcast", data: e.data });
addEventListener("storage", e => { if (e.key === "zs-hold") __hold.push({ via: "storage", data: e.newValue }); });
let port = null;
try {
  const w = new SharedWorker("/chan-worker.js", "zs-hold");
  port = w.port;
  port.onmessage = e => __hold.push({ via: "worker", data: e.data });
  port.start();
} catch (e) {
  __hold.push({ via: "worker", error: String(e) });
}
document.getElementById("user").addEventListener("input", e => {
  sync.postMessage({ typed: e.target.value });
  localStorage.setItem("zs-hold", "typed " + e.target.value);
  port?.postMessage({ typed: e.target.value });
});
document.getElementById("pop").onclick = () => { window.__pop = window.open("/hold?role=" + role + "pop&name=zsHP", "zsHP"); };
window.__holdSend = tag => { sync.postMessage(tag); localStorage.setItem("zs-hold", tag + " " + Date.now()); port?.postMessage(tag); return true; };
window.__holdNew = tag => {
  const c = new BroadcastChannel("zs-hold");
  c.onmessage = e => __hold.push({ via: "new broadcast", data: e.data });
  window.__holdChan = c;
  c.postMessage(tag);
  return true;
};
window.__holdReady = true;
</script>`;
const holdFrame = `<!doctype html><meta charset=utf-8><title>hold frame</title><p>frame</p>`;
// The sandbox probe's page (sandbox-probe.mjs): the site's own globals, a
// function and a click handler of its own, a field pair, a same-site frame
// and one of the other site (?other=<base>). window.__esc is where code
// that reached the page's own world says so.
const sbPage = `<!doctype html><meta charset=utf-8><title>sb</title>
<form onsubmit="return false"><input id=user><input type=password id=secret></form>
<style id=siteStyle>body { margin: 8px; }</style>
<button id=siteBtn>site</button>
<button id=siteInline onclick="window.__siteInline = (window.__siteInline || 0) + 1">inline</button>
<button id=sitePop>popup</button>
<button id=more>more</button>
<button id=siteGo>go</button>
<template id=tpl><p>more</p></template>
<div id=ed contenteditable style="min-height:20px;border:1px solid">edit</div>
<iframe id=sf name=zsSF src="/sb-frame" width=200 height=60></iframe>
<iframe id=xf name=zsXF width=200 height=60></iframe>
<script>
window.__siteSecret = "s3cret";
window.__site = { token: "t0k" };
window.siteHello = () => "hello";
window.__siteClicks = 0;
document.getElementById("siteBtn").onclick = () => { window.__siteClicks++; };
window.__siteInputs = 0;
// A framework's controlled input: it counts inputs and mirrors the value into the attribute, as React does.
document.getElementById("user").addEventListener("input", e => { window.__siteInputs++; e.target.setAttribute("value", e.target.value); });
// A single-page site's router: Go shows the path typed in the field, with
// pushState, as a site's search or its "next" after a sign-in pushes a path
// built from what the user typed. Its own code, not the agent's.
document.getElementById("siteGo").onclick = () => { history.pushState(null, "", document.getElementById("user").value || "/sb"); };
// A site that renders from a DOM template on demand.
document.getElementById("more").onclick = () => { document.body.append(document.getElementById("tpl").content.cloneNode(true)); };
// A site's own popup, same origin, which the agent's code may later find by name.
document.getElementById("sitePop").onclick = () => { window.open("/sb-frame", "zsSbSitePop"); };
// A rich-text editor's paste handler, which inserts the pasted html as is.
document.getElementById("ed").addEventListener("paste", e => {
  const html = e.clipboardData.getData("text/html");
  if (html) { e.preventDefault(); document.getElementById("ed").innerHTML += html; }
});
const other = new URLSearchParams(location.search).get("other");
if (other) document.getElementById("xf").src = other + "/sb-frame";
history.replaceState({ st: "state1" }, "");
localStorage.setItem("zs-sb", "ls1");
window.__esc = [];
window.__sbReady = true;
</script>`;
const sbFrame = `<!doctype html><meta charset=utf-8><title>sb frame</title><p>frame</p><script>window.__frameSecret = "f5ecret";</script>`;
// backstops-probe.mjs's page: one button per vector, each asking from a
// trusted click and keeping what it got in window.__bs. Its service worker
// reports, by /hit, that its script ran and that it installed.
const bsPage = `<!doctype html><meta charset=utf-8><title>bs</title>
<button id=gum>gum</button> <button id=gdm>gdm</button> <button id=pc>pc</button>
<button id=notify>notify</button> <button id=notifyShow>notifyShow</button> <button id=sw>sw</button>
<script>
window.__bs = {};
const run = (v, f) => document.getElementById(v).onclick = () => {
  __bs[v] = "pending";
  Promise.resolve().then(f).then(r => { __bs[v] = r; }, e => { __bs[v] = "rejected " + (e && e.name) + ": " + String(e && e.message).slice(0, 80); });
};
run("gum", () => navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(s => { s.getTracks().forEach(t => t.stop()); return "stream"; }));
run("gdm", () => navigator.mediaDevices.getDisplayMedia({ video: true }).then(s => { s.getTracks().forEach(t => t.stop()); return "stream"; }));
// createOffer only: permission is asked there, and ICE gathering, which
// would touch the network, starts only at setLocalDescription.
run("pc", async () => { const pc = new RTCPeerConnection(); try { pc.createDataChannel("x"); await pc.createOffer(); return "offer"; } finally { pc.close(); } });
run("notify", async () => { const r = await Notification.requestPermission(); if (r === "granted") new Notification("zs backstops"); return r; });
// A site the user already allowed needn't ask: it shows at once.
run("notifyShow", () => { new Notification("zs backstops, unasked"); return "shown with permission " + Notification.permission; });
run("sw", () => { const n = Date.now(); return navigator.serviceWorker.register("/bs-sw.js?n=" + n, { scope: "/bs-scope/" + n + "/" }).then(() => "registered"); });
</script>`;
const bsSw = `fetch("/hit?w=swEval&n=" + new URL(location.href).searchParams.get("n"));
self.addEventListener("install", () => fetch("/hit?w=swInstall&n=" + new URL(location.href).searchParams.get("n")));`;
const chanWorker = `const ports = [];
onconnect = e => {
  const p = e.ports[0];
  ports.push(p);
  p.onmessage = m => { for (const q of ports) q.postMessage({ from: m.data, ports: ports.length }); };
  p.start();
};`;

export function startServer(host, other = "") {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (type, body) => {
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (url.pathname.startsWith("/hub/")) {
      hubHits.push({ host, path: url.pathname, t: Date.now() });
      req.resume();
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("no models here");
    }
    switch (url.pathname) {
      // The site's home page is its login, so the own tab, which opens at the
      // home page, can sign in.
      case "/":
      case "/login":
        return send("text/html", login(other));
      case "/lab":
        return send("text/html", lab);
      case "/devices":
        return send("text/html", devicesPage);
      case "/net":
        return send("text/html", netPage);
      case "/net-user":
        return send("text/html", netUserPage);
      case "/reach":
        return send("text/html", reachPage);
      case "/chan":
        return send("text/html", chanPage);
      case "/chan-worker.js":
        return send(JS, chanWorker);
      case "/hold":
        return send("text/html", holdPage);
      case "/hold-frame":
        return send("text/html", holdFrame);
      case "/bs":
        return send("text/html", bsPage);
      case "/bs-sw.js":
        netHits.push({ host, q: "w=swScript&" + url.search.slice(1), method: req.method, t: Date.now() });
        return send(JS, bsSw);
      case "/sb":
        return send("text/html", sbPage);
      case "/sb-frame":
        return send("text/html", sbFrame);
      case "/net-lan":
        return send("text/html", netLanPage);
      // The site's page under a CSP that reports to ?report= (the site's own
      // reporting endpoint: the page's header, which the agent doesn't set).
      case "/net-csp": {
        const report = url.searchParams.get("report") ?? "/hit?csp";
        res.writeHead(200, {
          "content-type": "text/html",
          "cache-control": "no-store",
          "content-security-policy": `default-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; report-uri ${report}`,
        });
        return res.end(netPage);
      }
      // 103 Early Hints that preload ?to=, then the page.
      case "/early": {
        const to = url.searchParams.get("to");
        if (to) {
          res.writeEarlyHints({ link: `<${to}>; rel=preload; as=image` });
        }
        setTimeout(() => send("text/html", netPage), 400);
        return;
      }
      case "/hit":
        netHits.push({ host, q: url.search.slice(1), method: req.method, t: Date.now() });
        req.resume();
        res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*", "cache-control": "no-store" });
        return res.end("hit");
      case "/gum-onload":
        return send("text/html", gumOnLoad);
      case "/bf":
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(bfPage);
      case "/geo":
        geoHits.push({ host, method: req.method, t: Date.now() });
        req.resume();
        return send("application/json", JSON.stringify({ location: { lat: 1.5, lng: 2.5 }, accuracy: 20 }));
      case "/rt/page":
        return send("text/html", rtPage);
      case "/rt/item":
        return send("text/plain", "server item");
      case "/sw-runtime.js":
        return send(JS, swRuntime);
      case "/lscode":
        return send("text/html", lsCode);
      case "/framed":
        return send("text/html", framed(other));
      case "/framedLater":
        return send("text/html", framedLater(other));
      case "/shared-cache.js":
        return send(JS, sharedCache);
      case "/sw-noop.js":
        return send(JS, 'self.addEventListener("fetch", () => {});');
      case "/app2":
        return send("text/html", app2);
      case "/cache-helper.js":
        return send(JS, cacheHelper);
      case "/caught": {
        const entry = { probe: url.searchParams.get("probe"), v: url.searchParams.get("v") };
        if (!caught.some(c => c.probe === entry.probe && c.v === entry.v)) caught.push(entry);
        res.writeHead(204, { "access-control-allow-origin": "*" });
        return res.end();
      }
      // An open redirect, as many sites' ?next= and /url?q= handlers are.
      case "/redirect":
        res.writeHead(302, { location: url.searchParams.get("to") ?? "/", "cache-control": "no-store" });
        return res.end();
      // The same open redirect done by the page's own script, as a site's
      // "continue" or "next" page does: at once, or `delay` ms after its load.
      case "/jsnext":
        return send(
          "text/html",
          `<!doctype html><meta charset=utf-8><title>next</title><input id=user>
<script>
const q = new URLSearchParams(location.search);
const go = () => location.replace(q.get("to") || "/");
const delay = Number(q.get("delay") || 0);
if (delay) addEventListener("load", () => setTimeout(go, delay)); else go();
</script>`
        );
      // A page on the real site that grants something to whoever asks for
      // it: an OAuth consent, a device code, a recovery address.
      case "/consent":
        return send(
          "text/html",
          `<!doctype html><meta charset=utf-8><title>Site consent</title><p id=ask>Allow ${String(url.searchParams.get("client")).replace(/[^\w-]/g, "")} to use your account?</p><input type=password id=pw><button id=allow>Allow</button>`
        );
      case "/help":
        return send("text/html", "<!doctype html><title>Site help</title><p>help</p>");
      case "/app":
        return send("text/html", app);
      case "/app.js":
        return send(JS, 'document.documentElement.dataset.app = "genuine";');
      case "/site-sw.js":
        return send(JS, siteSw);
      case "/shared.js":
        return send(JS, shared);
      // A same-origin script endpoint that echoes its callback unfiltered:
      // a JSONP endpoint of the kind that lets a page register any code as a
      // service worker.
      case "/jsonp":
        return send(JS, `${url.searchParams.get("cb") ?? "cb"}({"ok":true})`);
      default:
        res.writeHead(404);
        res.end();
    }
  });
  return new Promise(resolve =>
    server.listen(0, host, () => resolve({ server, base: `http://${host}:${server.address().port}` }))
  );
}
