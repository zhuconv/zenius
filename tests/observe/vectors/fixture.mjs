// The I1/I4 sweep's pages (zen-observe): one trigger per way a page could
// reach past its agent tab. Each vector is a button (#v-<id>) whose click
// handler fires it, and window.__vectors[id]() fires it from page script.
// Outcomes the page can see land in window.__vectorResults[id].
import { createServer } from "node:http";

// A short silent WAV (8 kHz, 0.2 s), for the audio vector.
const wav = (() => {
  const samples = 1600;
  const b = Buffer.alloc(44 + samples);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + samples, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(8000, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples, 40);
  b.fill(128, 44);
  return b.toString("base64");
})();

/**
 * A cross-site frame the page allows the devices and location (Permissions
 * Policy): its own requests, in its own process. `message` is "devices",
 * "devices no-midi" to leave MIDI out, or "media" for the camera and
 * microphone alone.
 */
function crossDevicesFrame(message) {
  return `const f = document.createElement("iframe");
    f.allow = "camera; microphone; display-capture; geolocation; midi";
    f.src = new URL(document.getElementById("cross").src).origin + "/devices-frame";
    addEventListener("message", e => { if (typeof e.data === "string" && e.data.startsWith("devices ")) note(e.data.slice(8)); });
    f.onload = () => f.contentWindow.postMessage(${JSON.stringify(message)}, "*");
    document.body.append(f);`;
}

/** id → page-side trigger (the body of a function with `note(text)`). */
export const VECTORS = {
  print: `window.onbeforeprint = () => note("beforeprint"); window.print(); note("print() returned");`,
  "auth-nav": `location.href = "/auth";`,
  "auth-fetch": `fetch("/auth").then(r => note("fetch " + r.status), e => note("fetch " + e.name));`,
  mailto: `location.href = "mailto:zenius@example.invalid";`,
  zoommtg: `location.href = "zoommtg://zoom.us/join?confno=1234567890";`,
  slack: `location.href = "slack://open";`,
  tel: `location.href = "tel:+15555550100";`,
  fullscreen: `document.documentElement.requestFullscreen().then(() => note("fullscreen"), e => note("rejected " + e.name));`,
  pointerlock: `document.onpointerlockchange = () => note("locked " + !!document.pointerLockElement);
    document.onpointerlockerror = () => note("pointerlock error"); document.body.requestPointerLock();`,
  "notify-permission": `Notification.requestPermission().then(p => note("permission " + p), e => note(e.name));`,
  "notify-show": `const n = new Notification("zenius vector"); n.onshow = () => note("shown"); n.onerror = () => note("error");
    note("permission " + Notification.permission);`,
  camera: `navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(s => { note("granted"); s.getTracks().forEach(t => t.stop()); }, e => note(e.name));`,
  screen: `navigator.mediaDevices.getDisplayMedia({ video: true }).then(s => { note("granted"); s.getTracks().forEach(t => t.stop()); }, e => note(e.name));`,
  geolocation: `navigator.geolocation.getCurrentPosition(() => note("position"), e => note("error " + e.code), { timeout: 4000 });`,
  "webauthn-create": `navigator.credentials.create({ publicKey: { challenge: new Uint8Array(32), rp: { name: "zenius" },
    user: { id: new Uint8Array(16), name: "agent", displayName: "agent" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], timeout: 4000 } })
    .then(() => note("created"), e => note(e.name));`,
  "webauthn-get": `navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), timeout: 4000 } }).then(() => note("got"), e => note(e.name));`,
  share: `if (!navigator.share) { note("unsupported"); } else { navigator.share({ title: "zenius", url: location.href }).then(() => note("shared"), e => note(e.name)); }`,
  "clipboard-read": `navigator.clipboard.readText().then(() => note("read"), e => note(e.name));`,
  "popup-window": `const w = window.open("/plain?popup-window", "_blank", "popup,width=420,height=320"); note(w ? "opened" : "blocked");`,
  focus: `window.focus(); note("focus() returned");`,
  audio: `const a = new Audio("data:audio/wav;base64,${wav}"); a.loop = true; window.__audio = a; a.play().then(() => note("playing"), e => note(e.name));`,
  // An audible tone, quiet and short (window.__toneMs lengthens it).
  tone: `const ctx = new AudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain(); g.gain.value = 0.05;
    o.connect(g).connect(ctx.destination); o.start(); window.__tone = ctx; note("tone " + ctx.state);
    setTimeout(() => ctx.close(), window.__toneMs ?? 3000);`,
  speech: `if (!window.speechSynthesis) { note("unsupported"); } else { const u = new SpeechSynthesisUtterance("zenius");
    u.onstart = () => note("speaking"); u.onerror = e => note("error " + e.error); speechSynthesis.speak(u); }`,
  xpi: `location.href = "/addon.xpi";`,
  "protocol-handler": `try { navigator.registerProtocolHandler("web+zenius", location.origin + "/plain?u=%s"); note("registered"); } catch (e) { note(e.name); }`,
  persist: `navigator.storage.persist().then(r => note("persist " + r), e => note(e.name));`,
  midi: `if (!navigator.requestMIDIAccess) { note("unsupported"); } else { navigator.requestMIDIAccess().then(() => note("granted"), e => note(e.name)); }`,
  "color-picker": `document.getElementById("color").showPicker(); note("showPicker returned");`,
  "date-picker": `document.getElementById("date").showPicker(); note("showPicker returned");`,
  select: `document.getElementById("select").showPicker(); note("showPicker returned");`,
  "clipboard-write": `navigator.clipboard.writeText("zenius vector " + Date.now()).then(() => note("written"), e => note(e.name));`,
  "file-input": `document.getElementById("file").showPicker(); note("showPicker returned");`,
  "wake-lock": `if (!navigator.wakeLock) { note("unsupported"); } else { navigator.wakeLock.request("screen").then(l => { note("locked"); window.__lock = l; }, e => note(e.name)); }`,
  "auth-url": `const u = new URL(location.href); u.username = "agent"; u.password = "secret"; u.pathname = "/plain"; location.href = u.href;`,
  "storage-access": `document.getElementById("cross").contentWindow.postMessage("storage-access", "*");`,
  "download-attachment": `location.href = "/download";`,
  "download-unknown": `location.href = "/unknown";`,
  "dialog-iframe-same": `document.getElementById("same").contentWindow.postMessage("alert", "*");`,
  "dialog-iframe-cross": `document.getElementById("cross").contentWindow.postMessage("alert", "*");`,
  beforeunload: `window.onbeforeunload = e => { e.preventDefault(); e.returnValue = ""; }; note("handler set");`,
  // The site's storage that outlives the task (own-tab.md, item 3). Each
  // notes one outcome per try: "registered", "put" and so on, or the error.
  "sw-register": `navigator.serviceWorker.register("/sw.js").then(r => r.unregister().then(() => note("registered")), e => note(e.name));`,
  "cache-write": `caches.open("zenius-vectors").then(async c => {
      for (const [n, f] of [["put", () => c.put("/plain?put", new Response("planted"))], ["add", () => c.add("/plain?add")], ["addAll", () => c.addAll(["/plain?addAll"])]]) {
        try { await f(); note(n); } catch (e) { note(e.name); }
      }
    }, e => note("open " + e.name));`,
  // A fresh frame's prototypes, called on this document's objects.
  "storage-fresh-frame": `const f = document.createElement("iframe"); document.body.append(f); const w = f.contentWindow;
    w.ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, "/sw.js").then(r => r.unregister().then(() => "registered"), e => e.name)
      .then(note).then(() => caches.open("zenius-vectors")).then(c => w.Cache.prototype.put.call(c, "/plain?frame", new Response("planted")))
      .then(() => note("put"), e => note(e.name)).finally(() => f.remove());`,
  "worker-storage": `const w = new Worker(blobScript(workerStorage("worker") + ".then(out => postMessage(out));"));
    w.onmessage = e => { e.data.forEach(note); w.terminate(); }; w.onerror = e => note("error " + e.message);`,
  "nested-worker-storage": `const inner = blobScript(workerStorage("nested") + ".then(out => postMessage(out));");
    const w = new Worker(blobScript("const n = new Worker(" + JSON.stringify(inner) + "); n.onmessage = e => postMessage(e.data);"));
    w.onmessage = e => { e.data.forEach(note); w.terminate(); }; w.onerror = e => note("error " + e.message);`,
  // A popup's first document, reached before the parent routes the popup:
  // its natives, grabbed at once, and a worker it owns. Needs a click.
  "popup-storage": `const p = window.open("about:blank", "_blank");
    if (!p) { note("blocked"); } else {
      const reg = p.ServiceWorkerContainer.prototype.register, put = p.Cache.prototype.put;
      const w = new p.Worker(blobScript(workerStorage("popup") + ".then(out => postMessage(out));"));
      w.onmessage = e => { e.data.forEach(note); w.terminate(); };
      reg.call(navigator.serviceWorker, "/sw.js").then(r => r.unregister().then(() => "registered"), e => e.name).then(note)
        .then(() => caches.open("zenius-vectors")).then(c => put.call(c, "/plain?popup", new Response("planted")))
        .then(() => note("put"), e => note(e.name)).finally(() => setTimeout(() => p.close(), 1500));
    }`,
  // A frame made inside a fresh popup, before the parent routes the popup.
  // Needs a click.
  "popup-frame-storage": `const p = window.open("about:blank", "_blank");
    if (!p) { note("blocked"); } else {
      const f = p.document.createElement("iframe"); p.document.body.append(f); const w = f.contentWindow;
      const reg = w.ServiceWorkerContainer.prototype.register, put = w.Cache.prototype.put;
      reg.call(navigator.serviceWorker, "/sw.js").then(r => r.unregister().then(() => "registered"), e => e.name).then(note)
        .then(() => caches.open("zenius-vectors")).then(c => put.call(c, "/plain?popup-frame", new Response("planted")))
        .then(() => note("put"), e => note(e.name)).finally(() => setTimeout(() => p.close(), 1500));
    }`,
  // A fresh popup whose opener the page clears first. Needs a click.
  "popup-opener-null": `const p = window.open("about:blank", "_blank");
    if (!p) { note("blocked"); } else {
      p.opener = null;
      const reg = p.ServiceWorkerContainer.prototype.register, put = p.Cache.prototype.put;
      reg.call(navigator.serviceWorker, "/sw.js").then(r => r.unregister().then(() => "registered"), e => e.name).then(note)
        .then(() => caches.open("zenius-vectors")).then(c => put.call(c, "/plain?popup-opener-null", new Response("planted")))
        .then(() => note("put"), e => note(e.name)).finally(() => setTimeout(() => p.close(), 1500));
    }`,
  // The native constructor, reached through the prototype.
  "shared-constructor-storage": `const w = new SharedWorker.prototype.constructor(blobScript("onconnect = e => { const port = e.ports[0]; " + workerStorage("shared-ctor") + ".then(out => port.postMessage(out)); };"));
    w.port.onmessage = e => e.data.forEach(note);`,
  // The site's shared worker that writes to the cache on request, which a
  // tab of the user's may run already (cache-sync).
  "user-shared-worker": `const w = new SharedWorker("/shared-cache.js", "cache-sync");
    w.port.onmessage = e => note(e.data);
    w.port.postMessage({ cache: "zenius-vectors", url: location.origin + "/plain?user-shared", body: "planted" });`,
  "shared-worker-storage": `const w = new SharedWorker(blobScript("onconnect = e => { const port = e.ports[0]; " + workerStorage("shared") + ".then(out => port.postMessage(out)); };"));
    w.port.onmessage = e => e.data.forEach(note); w.onerror = () => note("error");`,
  // The user's devices and location (content/refusals.sys.mjs), besides
  // camera, screen, geolocation and midi above.
  microphone: `navigator.mediaDevices.getUserMedia({ audio: true }).then(s => { note("granted"); s.getTracks().forEach(t => t.stop()); }, e => note(e.name));`,
  "moz-get-user-media": `navigator.mozGetUserMedia({ video: true }, s => { note("granted"); s.getTracks().forEach(t => t.stop()); }, e => note(e.name));`,
  "enumerate-devices": `navigator.mediaDevices.enumerateDevices().then(d => note("devices " + d.length), e => note(e.name));`,
  "select-audio-output": `navigator.mediaDevices.selectAudioOutput().then(() => note("chosen"), e => note(e.name));`,
  "geolocation-watch": `const id = navigator.geolocation.watchPosition(() => note("position"), e => { note("error " + e.code); navigator.geolocation.clearWatch(id); }, { timeout: 4000 });
    note("watch " + typeof id);`,
  "speech-recognition": `const R = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!R) { note("unsupported"); } else { const r = new R(); r.onstart = () => note("started"); r.onerror = e => note("error " + e.error); r.onend = () => note("end"); r.start(); }`,
  // A fresh frame's natives on this document's objects, then the frame's own.
  "devices-fresh-frame": `const f = document.createElement("iframe"); document.body.append(f); const w = f.contentWindow;
    w.MediaDevices.prototype.getUserMedia.call(navigator.mediaDevices, { video: true }).then(() => "granted", e => e.name).then(note)
      .then(() => w.navigator.mediaDevices.getUserMedia({ audio: true })).then(() => note("granted"), e => note(e.name))
      .then(() => new Promise(r => w.navigator.geolocation.getCurrentPosition(() => r("position"), e => r("error " + e.code)))).then(note)
      .finally(() => f.remove());`,
  "devices-cross-frame": crossDevicesFrame("devices"),
  // The same without MIDI, which has no fake device: for the Mac, where only
  // fake devices may run (the user's rule, 2026-11-20).
  "devices-cross-frame-no-midi": crossDevicesFrame("devices no-midi"),
  // A popup's first document, before the parent routes the popup: its
  // natives, grabbed at once. Needs a click.
  "devices-popup": `const p = window.open("about:blank", "_blank");
    if (!p) { note("blocked"); } else {
      const gum = p.MediaDevices.prototype.getUserMedia, where = p.Geolocation.prototype.getCurrentPosition;
      gum.call(p.navigator.mediaDevices, { video: true }).then(() => "granted", e => e.name).then(note)
        .then(() => new Promise(r => where.call(p.navigator.geolocation, () => r("position"), e => r("error " + e.code)))).then(note)
        .finally(() => setTimeout(() => p.close(), 1500));
    }`,
  // The camera and microphone alone, where location would go on to the
  // prompt layer and wait: a fresh frame, a cross-site frame, a popup's first
  // document (needs a click).
  "media-fresh-frame": `const f = document.createElement("iframe"); document.body.append(f); const w = f.contentWindow;
    w.MediaDevices.prototype.getUserMedia.call(navigator.mediaDevices, { video: true }).then(() => "granted", e => e.name).then(note)
      .then(() => w.navigator.mediaDevices.getUserMedia({ audio: true })).then(() => note("granted"), e => note(e.name))
      .finally(() => f.remove());`,
  "media-cross-frame": crossDevicesFrame("media"),
  "media-popup": `const p = window.open("about:blank", "_blank");
    if (!p) { note("blocked"); } else {
      p.MediaDevices.prototype.getUserMedia.call(p.navigator.mediaDevices, { video: true }).then(() => "granted", e => e.name).then(note)
        .finally(() => setTimeout(() => p.close(), 1500));
    }`,
};

/**
 * Notifications, WebRTC and the local network (content/refusals.sys.mjs,
 * observe/localnet.sys.mjs), on their own page (/vectors-net), outside the
 * sweep. lan.local and lan-ok.local resolve to 127.0.0.1 where the test sets
 * network.dns.localDomains, so a request the refusal missed reaches /hit,
 * which counts it. The IP literals go to the recorder (startRecorder), the
 * test's proxy, never to a real network.
 */
export const NETWORK_VECTORS = {
  "notify-show": VECTORS["notify-show"],
  "notify-prototype": `const n = new Notification.prototype.constructor("zenius vector"); n.onshow = () => note("shown"); n.onerror = () => note("error");`,
  "notify-registration": `ServiceWorkerRegistration.prototype.showNotification.call(null, "zenius vector").then(() => note("shown"), e => note(e.name + ": " + e.message));`,
  "notify-fresh-frame": `const f = document.createElement("iframe"); document.body.append(f);
    const n = new f.contentWindow.Notification("zenius vector"); n.onshow = () => note("shown"); n.onerror = () => note("error"); setTimeout(() => f.remove(), 500);`,
  "notify-worker": `const w = new Worker(blobScript("try { const n = new Notification('zenius vector'); n.onshow = () => postMessage('shown'); n.onerror = () => postMessage('error'); } catch (e) { postMessage('threw ' + e.name); }"));
    w.onmessage = e => { note(e.data); w.terminate(); };`,
  rtc: `try { const pc = new RTCPeerConnection(); note("made"); pc.close(); } catch (e) { note(e.name); }`,
  "rtc-prototype": `try { const pc = new RTCPeerConnection.prototype.constructor(); note("made"); pc.close(); } catch (e) { note(e.name); }`,
  "rtc-fresh-frame": `const f = document.createElement("iframe"); document.body.append(f);
    try { const pc = new f.contentWindow.RTCPeerConnection(); note("made"); pc.close(); } catch (e) { note(e.name); } f.remove();`,
  "lan-fetch": `fetch("http://172.31.254.1/").then(r => note("status " + r.status), e => note(e.name));`,
  "lan-fetch-forms": `Promise.all(["http://[::ffff:172.31.254.1]/", "http://0xac1ffe01/", "http://192.168.254.254./", "http://[fd00::1]/", "http://169.254.169.254/"]
      .map(u => fetch(u).then(r => "status " + r.status, e => e.name))).then(r => r.forEach(note));`,
  "lan-name": `fetch("http://lan.local:" + location.port + "/hit?fetch").then(r => note("status " + r.status), e => note(e.name));`,
  "lan-image": `const i = new Image(); i.onload = () => note("load"); i.onerror = () => note("error"); i.src = "http://lan.local:" + location.port + "/hit?image";`,
  "lan-frame": `const f = document.createElement("iframe"); f.src = "http://lan.local:" + location.port + "/hit?frame"; document.body.append(f);
    setTimeout(() => { note("done"); f.remove(); }, 800);`,
  "lan-websocket": `const w = new WebSocket("ws://lan.local:" + location.port + "/ws"); w.onopen = () => { note("open"); w.close(); }; w.onerror = () => note("error");`,
  "lan-event-source": `const s = new EventSource("http://lan.local:" + location.port + "/hit?event-source"); s.onopen = () => note("open"); s.onerror = () => { note("error"); s.close(); };`,
  "lan-beacon": `note("queued " + navigator.sendBeacon("http://lan.local:" + location.port + "/hit?beacon", "x"));`,
  "lan-redirect": `fetch("/redirect?to=" + encodeURIComponent("http://lan.local:" + location.port + "/hit?redirect")).then(r => note("status " + r.status), e => note(e.name));`,
  "lan-worker": `const w = new Worker(blobScript("fetch('http://lan.local:" + location.port + "/hit?worker').then(r => postMessage('status ' + r.status), e => postMessage(e.name));"));
    w.onmessage = e => { note(e.data); w.terminate(); };`,
  "lan-allowed": `fetch("http://lan-ok.local:" + location.port + "/hit?allowed").then(r => note("status " + r.status), e => note(e.name));`,
  "lan-loopback": `fetch("http://localhost:" + location.port + "/hit?loopback").then(r => note("status " + r.status), e => note(e.name));`,
  // A popup's first load, before the parent routes the popup. Needs a click.
  "lan-popup": `const p = window.open("http://lan.local:" + location.port + "/hit?popup", "_blank"); note(p ? "opened" : "blocked"); setTimeout(() => p?.close(), 1500);`,
};

// Page-side helpers for the storage vectors' workers.
const STORAGE_HELPERS = `
function blobScript(src) { return URL.createObjectURL(new Blob([src], { type: "text/javascript" })); }
// A worker's tries, as an expression: a promise of its outcomes. Blob
// workers resolve relative URLs against blob:, so the URLs are absolute.
function workerStorage(tag) {
  return "(async () => { const o = " + JSON.stringify(location.origin) + "; const out = [];" +
    " try { const r = await navigator.serviceWorker.register(o + '/sw.js'); await r.unregister(); out.push('registered'); } catch (e) { out.push(e.name); }" +
    " try { const c = await caches.open('zenius-vectors'); await c.put(o + '/plain?" + tag + "', new Response('planted')); out.push('put'); } catch (e) { out.push(e.name); }" +
    " return out; })()";
}`;

function vectorsPage(crossBase, vectors = VECTORS) {
  const buttons = Object.keys(vectors)
    .map(id => `<button id="v-${id}" data-vector="${id}">${id}</button>`)
    .join("\n");
  const fns = Object.entries(vectors)
    .map(([id, body]) => `${JSON.stringify(id)}: () => { const note = t => (window.__vectorResults[${JSON.stringify(id)}] ??= []).push(t); try { ${body} } catch (e) { note("threw " + e.name + ": " + e.message); } }`)
    .join(",\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>zenius vectors</title>
<style>button{display:inline-block;margin:2px;font-size:13px} iframe{width:160px;height:60px}</style></head>
<body><h1>vectors</h1>
<div id="buttons">${buttons}</div>
<input type="color" id="color"> <input type="date" id="date"> <input type="file" id="file">
<select id="select"><option>one</option><option>two</option></select>
<form id="login" method="post" action="/login"><input name="username" id="username" autocomplete="username">
<input type="password" name="password" id="password" autocomplete="current-password"><button type="submit" id="submit">Sign in</button></form>
<iframe id="same" src="/frame"></iframe><iframe id="cross" src="${crossBase}/frame"></iframe>
<script>${STORAGE_HELPERS}
window.__vectorResults = {}; window.__vectors = {${fns}};
addEventListener("message", e => (window.__vectorResults.frames ??= []).push(String(e.data)));
document.getElementById("buttons").addEventListener("click", e => { const id = e.target.dataset?.vector; if (id) window.__vectors[id](); });</script>
</body></html>`;
}

/** A worker's code that fetches what its owner asks and answers with the status and the start of the body, or with its URL when asked "location". */
const WORKER_FETCHER = `onmessage = m => m.data === "location" ? postMessage(location.href) : fetch(m.data).then(async r => postMessage(r.status + " " + (await r.text()).slice(0, 20)), err => postMessage(err.name));`;

/** The site's own service worker (/sw-site.js), as a site the user visits might have. */
const SITE_SW = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(clients.claim()));
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  e.waitUntil(fetch("/hit?sw-saw-" + encodeURIComponent(u.pathname.slice(1) + u.search)).catch(() => {}));
  if (u.pathname === "/sw-intercept") {
    e.respondWith(new Response("from-sw"));
  } else if (e.request.mode === "navigate" && u.searchParams.has("sw-nav")) {
    e.respondWith(new Response("<title>from-sw</title><p>from the service worker</p>", { headers: { "content-type": "text/html" } }));
  }
});
self.addEventListener("message", e => {
  const m = e.data ?? {};
  if (m.claim) e.waitUntil(clients.claim());
  if (m.fetch) e.waitUntil(fetch(m.fetch).then(() => {}, () => {}));
  if (m.cache) e.waitUntil(caches.open("zenius-sw").then(c => c.put("/sw-cached", new Response(String(m.cache)))));
  // It reaches out first: a port to every client of the site, controlled or
  // not, and it fetches /hit?sw-offer-answer-<what the client answers>.
  if (m.offer) {
    e.waitUntil(
      clients.matchAll({ includeUncontrolled: true, type: "all" }).then(list => {
        for (const c of list) {
          const ch = new MessageChannel();
          ch.port1.onmessage = a => fetch("/hit?sw-offer-answer-" + encodeURIComponent(String(a.data))).catch(() => {});
          c.postMessage({ offer: m.offer }, [ch.port2]);
        }
        return new Promise(r => setTimeout(r, 2000));
      })
    );
  }
});
`;

const FRAME = `<!doctype html><html><body>frame<script>
addEventListener("message", e => {
  if (e.data === "alert") { const r = confirm("frame confirm"); parent.postMessage("confirm " + r, "*"); }
  if (e.data === "storage-access") document.requestStorageAccess().then(() => parent.postMessage("storage granted", "*"), err => parent.postMessage("storage " + err.name, "*"));
});
</script></body></html>`;

/** A cross-site frame's own device and location requests, on its parent's message. */
const DEVICES_FRAME = `<!doctype html><html><body>devices frame<script>
addEventListener("message", async e => {
  if (e.data !== "devices" && e.data !== "devices no-midi" && e.data !== "media") return;
  const say = t => parent.postMessage("devices " + t, "*");
  await navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(() => say("granted"), err => say(err.name));
  if (e.data === "media") return;
  await new Promise(r => navigator.geolocation.getCurrentPosition(() => r("position"), err => r("error " + err.code))).then(say);
  if (e.data === "devices") await navigator.requestMIDIAccess().then(() => say("granted"), err => say(err.name));
});
</script></body></html>`;

/**
 * Start the sweep's server on 127.0.0.1; `localhost` on the same port is a
 * second site. `stats.geoRequests` counts requests to /geo-provider, the
 * network geolocation provider's endpoint for tests that point
 * geo.provider.network.url there; `stats.hits` counts requests to /hit by
 * their query, and WebSocket upgrades as "ws".
 */
/**
 * The recorder for the local-network vectors (the user's rule, 2026-11-20).
 * Tests make it the profile's HTTP proxy for everything but loopback
 * (recorderProxyPrefs), so a request the refusal missed lands here and
 * never on a real network: on the Mac, the user's LAN. It answers every
 * request itself and never forwards or tunnels. `requests` lists
 * {kind, method, target}, target being the absolute URL a proxy is sent
 * (or host:port for a CONNECT).
 */
export async function startRecorder() {
  const requests = [];
  const server = createServer((req, res) => {
    const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(req.url);
    requests.push({ kind: absolute ? "proxied" : "direct", method: req.method, target: absolute ? req.url : `${req.headers.host ?? "?"}${req.url}` });
    req.resume();
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end("zenius recorder");
  });
  server.on("connect", (req, socket) => {
    requests.push({ kind: "connect", method: "CONNECT", target: req.url });
    socket.on("error", () => {});
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  server.on("upgrade", (req, socket) => {
    requests.push({ kind: "upgrade", method: req.method, target: req.url });
    socket.on("error", () => {});
    socket.destroy();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, requests };
}

/**
 * Prefs that send every request but loopback to the recorder on `port`,
 * with no failover to a direct connection. lan.local and lan-ok.local go
 * direct, to 127.0.0.1 (network.dns.localDomains), where the fixture counts
 * them.
 */
export function recorderProxyPrefs(port) {
  return {
    "network.proxy.type": 1,
    "network.proxy.http": "127.0.0.1",
    "network.proxy.http_port": port,
    "network.proxy.ssl": "127.0.0.1",
    "network.proxy.ssl_port": port,
    "network.proxy.socks": "",
    "network.proxy.share_proxy_settings": false,
    "network.proxy.no_proxies_on": "lan.local, lan-ok.local",
    "network.proxy.allow_hijacking_localhost": false,
    "network.proxy.failover_direct": false,
  };
}

/** The private and link-local hosts the vectors use, as a proxied URL's hostname reads. */
const PRIVATE_HOSTS = new Set(["172.31.254.1", "[::ffff:ac1f:fe01]", "192.168.254.254", "[fd00::1]", "169.254.169.254"]);

/** The recorder's requests for a private host: each one a refusal that missed. */
export function privateRequests(recorder) {
  return recorder.requests.filter(r => {
    let host = "";
    try {
      host = r.kind === "connect" ? new URL(`http://${r.target}`).hostname : new URL(r.target).hostname;
    } catch {}
    return PRIVATE_HOSTS.has(host.replace(/\.$/, ""));
  });
}

export async function startVectorServer() {
  let crossBase = "";
  const stats = { geoRequests: 0, hits: {} };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const html = body => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
    };
    switch (url.pathname) {
      case "/vectors":
        return html(vectorsPage(crossBase));
      case "/vectors-net":
        return html(vectorsPage(crossBase, NETWORK_VECTORS));
      case "/hit": {
        const key = url.search.slice(1) || "-";
        stats.hits[key] = (stats.hits[key] ?? 0) + 1;
        req.resume();
        res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*", "cache-control": "no-store" });
        return res.end("hit");
      }
      case "/redirect":
        res.writeHead(302, { location: url.searchParams.get("to") ?? "/plain", "cache-control": "no-store" });
        return res.end();
      case "/frame":
        return html(FRAME);
      case "/devices-frame":
        return html(DEVICES_FRAME);
      case "/geo-provider":
        // Google's geolocation API answer, which Gecko's network provider reads.
        stats.geoRequests++;
        req.resume();
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify({ location: { lat: 30.2849, lng: -97.7341 }, accuracy: 20 }));
      case "/plain":
        return html(`<!doctype html><title>plain</title><p>plain page</p>`);
      case "/cacheable":
        // Without no-store, which keeps a page out of the bfcache.
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(`<!doctype html><title>cacheable</title><p>cacheable page</p>`);
      case "/auth":
        if (req.headers.authorization) {
          return html(`<!doctype html><title>authorized</title><p>authorized</p>`);
        }
        res.writeHead(401, { "www-authenticate": 'Basic realm="zenius vectors"', "content-type": "text/html" });
        return res.end(`<!doctype html><title>401</title><p>auth required</p>`);
      case "/download":
        res.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="vector.txt"' });
        return res.end("vector download\n");
      case "/unknown":
        res.writeHead(200, { "content-type": "application/x-zenius-unknown" });
        return res.end(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
      case "/addon.xpi":
        res.writeHead(200, { "content-type": "application/x-xpinstall" });
        return res.end(Buffer.from("PK\x05\x06" + "\0".repeat(18), "binary"));
      case "/writes-popup":
        // The site's own popups, on a click: one filled through the DOM (it
        // stays at about:blank), one with document.write (it takes this
        // page's URL).
        return html(`<!doctype html><title>writes popups</title><button id="dom">dom</button><button id="write">write</button>
<script>document.getElementById("dom").onclick = () => { open("").document.body.innerHTML = "<input type=password>"; };
document.getElementById("write").onclick = () => { const d = open("").document; d.write("<title>written</title><input type=password>"); d.close(); };</script>`);
      case "/sandboxed":
        // A sandboxed frame (opaque: a null principal) of the 127.0.0.1 site,
        // for pages on the other site (crossBase).
        return html(`<!doctype html><title>sandboxed</title><iframe id="opaque" sandbox="allow-scripts" src="http://127.0.0.1:${server.address().port}/plain"></iframe>`);
      case "/login":
        return html(`<!doctype html><title>signed in</title><p>signed in</p>`);
      case "/shared-fetch.js":
        // A site's shared worker that fetches what a page asks and answers
        // with the status and the start of the body.
        res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
        return res.end(
          `onconnect = e => { const p = e.ports[0]; p.onmessage = m => fetch(m.data).then(async r => p.postMessage(r.status + " " + (await r.text()).slice(0, 20)), err => p.postMessage(err.name)); };`
        );
      case "/shared-nest.js":
        // A site's shared worker that fetches what a page asks ({fetch}), or
        // has a worker of its own do it ({nested: "blob" or "site", url}):
        // the one it keeps for that kind, or with `fresh` a new one. It
        // answers as /shared-fetch.js does, or with the error's name when
        // the worker can't start; {where} and a url of "location" answer
        // with the worker's URL.
        res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
        return res.end(`const FETCHER = ${JSON.stringify(WORKER_FETCHER)};
const kept = {};
onconnect = e => {
  const p = e.ports[0];
  p.onmessage = m => {
    const d = m.data;
    if (d.where) return p.postMessage(location.href);
    if (d.fetch) return fetch(d.fetch).then(async r => p.postMessage(r.status + " " + (await r.text()).slice(0, 20)), err => p.postMessage(err.name));
    let w = d.fresh ? null : kept[d.nested];
    if (!w) {
      try {
        w = new Worker(d.nested === "blob" ? URL.createObjectURL(new Blob([FETCHER], { type: "text/javascript" })) : "/worker-fetch.js");
      } catch (err) {
        return p.postMessage(err.name);
      }
      if (!d.fresh) kept[d.nested] = w;
    }
    w.onmessage = r => { p.postMessage(r.data); if (d.fresh) w.terminate(); };
    w.onerror = err => p.postMessage("error " + err.message);
    w.postMessage(d.url);
  };
};`);
      case "/worker-fetch.js":
        // A site's worker that fetches what its owner asks.
        res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
        return res.end(WORKER_FETCHER);
      case "/shared-cache.js":
        // A site's shared worker that writes to Cache Storage on request.
        res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
        return res.end(
          "onconnect = e => { const port = e.ports[0]; port.onmessage = async m => { try { const c = await caches.open(m.data.cache); await c.put(m.data.url, new Response(m.data.body)); port.postMessage('stored'); } catch (err) { port.postMessage(err.name); } }; };"
        );
      case "/sw.js":
        res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
        return res.end("self.addEventListener('fetch', () => {});");
      case "/sw-site.js":
        // A site's own service worker, registered from the user's tab: it
        // takes every page of the site at once, answers /sw-intercept and
        // ?sw-nav navigations itself, counts each request it sees on /hit,
        // and on a message fetches what it's told or writes its cache.
        res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
        return res.end(SITE_SW);
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  server.on("upgrade", (_req, socket) => {
    stats.hits.ws = (stats.hits.ws ?? 0) + 1;
    socket.destroy();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  crossBase = `http://localhost:${port}`;
  return { server, base: `http://127.0.0.1:${port}`, crossBase, stats };
}
