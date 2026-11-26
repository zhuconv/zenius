// Parent backstops, for the observe layer. For each
// vector, the parent-side hook that sees which tab asked, can deny before
// anything reaches the device or the OS, and fails closed:
// - gum, gdm: getUserMedia and getDisplayMedia, at WebRTCParent's
//   receiveMessage("webrtc:Request"), before prompt(), which also grants a
//   site's stored permission without asking;
// - pc: a peer connection, at webrtcUI.addPeerConnectionBlocker (asked at
//   createOffer, createAnswer and set*Description, before ICE gathers);
// - notify: the Notification permission prompt, at Integration's
//   contentPermission.createPermissionPrompt, which ContentPermissionPrompt
//   calls for each prompt; notifyShow: a site with a stored grant shows a
//   notification without asking;
// - sw: a service worker's registration, at the service-worker manager's
//   onRegister and at the parent's http-on-opening-request for its script.
// Each hook runs in three modes: observe (it records what it sees and lets
// the request on), deny (for the probe's tab only), and throws (for the
// probe's tab: does the request go on?). The result also counts what got
// further: webrtc:Allow, checkOSPermission (where macOS asks), doorhangers,
// device events, prompt-service calls, alert windows, and the service
// worker's script fetch, first run and install.
//
// A plain tab asks, not a task's: in a task's tab zenius's content refusal
// answers first, and a backstop is for when that is bypassed. "granted"
// cases first store the site's permission, as a site the user uses may have.
//
// zenius:<device>:<tab> cases test zenius's own backstops, with no hook of
// the probe's. The site holds the user's stored grant for the device, and
// the request comes past zenius's content refusal: the probe's sandbox has
// the page's principal and Xray vision, as the agent's world has, so it calls
// the native API, as the world would if its mirror of the guards failed. In
// a task's tab, on screen (where a stored camera grant applies at once), the
// request must stop in the parent: no OS check, Allow, doorhanger, alert or
// location provider start. In a plain tab of the user's it must go on as in
// Gecko.
//
// Fake devices only, headless on the Linux server, in a profile of its own; never on the
// Mac (the probe refuses there, and without fake streams):
//   ZENIUS_DEV_PREFS=tests/snapshot/tools/backstops-prefs.js scripts/zen-dev.sh zen-snapshot-backstops start
//   ZENIUS_INSTANCE=zen-snapshot-backstops node tests/snapshot/tools/backstops-probe.mjs [vector[:state][:mode] ...]
//   ZENIUS_INSTANCE=zen-snapshot-backstops node tests/snapshot/tools/backstops-probe.mjs zenius[:device[:tab]] ...
import { openKit } from "./owntab-kit.mjs";
import { netHits } from "./owntab-site.mjs";

if (process.platform === "darwin") {
  console.error("backstops-probe: headless on the Linux server only, never on the Mac");
  process.exit(2);
}

const kit = await openKit();
const { chrome, A, sleep } = kit;
const step = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const brief = e => String(e?.message ?? e).slice(0, 240);

const fake = await chrome(`return Services.prefs.getBoolPref("media.navigator.streams.fake", false);`);
if (!fake) {
  console.error("backstops-probe: this instance has no fake streams (start it with backstops-prefs.js)");
  kit.close();
  process.exit(2);
}

/** Chrome-side helpers, after the kit's. */
const C = `
  const { WebRTCParent } = ChromeUtils.importESModule("resource:///actors/WebRTCParent.sys.mjs");
  const { webrtcUI } = ChromeUtils.importESModule("resource:///modules/webrtcUI.sys.mjs");
  const { Integration } = ChromeUtils.importESModule("resource://gre/modules/Integration.sys.mjs");
  const { ContentPermissionPrompt } = ChromeUtils.importESModule("moz-src:///browser/components/permissions/ContentPermissionPrompt.sys.mjs");
  const P = WebRTCParent.prototype;
  const swm = Cc["@mozilla.org/serviceworkers/manager;1"].getService(Ci.nsIServiceWorkerManager);
  const who = browser => {
    try {
      if (!browser) return "no browser";
      const tab = browser.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser(browser) ?? all().find(t => t.linkedBrowser === browser);
      if (!tab) return "no tab";
      const hit = ctx.service.lookup(tab);
      return hit ? "task tab (" + hit.rec.ownership + ")" : "user tab";
    } catch (e) {
      return "? " + e.message;
    }
  };
  const tabById = id => all().find(t => t.linkedBrowser?.browserId === id) ?? null;
`;

/** Install the counters and the vector's hook in its mode, for the target browser. */
function install(vector, mode, target) {
  return chrome(
    C +
      `
    if (P.__zsBS) { for (const undo of P.__zsBS.undo.reverse()) { try { undo(); } catch {} } delete P.__zsBS; }
    const L = (P.__zsBS = { hook: [], os: [], sent: [], shows: [], events: [], prompts: 0, windows: [], undo: [] });
    const { vector, mode, target } = arg;
    const mine = b => !!b && b.browserId === target;
    const wrap = (obj, name, make) => {
      const own = Object.prototype.hasOwnProperty.call(obj, name);
      const orig = obj[name];
      obj[name] = make(orig);
      L.undo.push(() => { if (own) obj[name] = orig; else delete obj[name]; });
    };
    const safely = f => { try { f(); } catch {} };
    // Counters.
    wrap(P, "checkOSPermission", orig => function (cam, mic, scr) {
      safely(() => L.os.push({ cam: !!cam, mic: !!mic, scr: !!scr }));
      return orig.apply(this, arguments);
    });
    wrap(P, "sendAsyncMessage", orig => function (name) {
      safely(() => L.sent.push(name));
      return orig.apply(this, arguments);
    });
    wrap(ContentPermissionPrompt.prototype, "prompt", orig => function () {
      L.prompts++;
      return orig.apply(this, arguments);
    });
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      if (w.PopupNotifications) {
        wrap(w.PopupNotifications, "show", orig => function (browser, id) {
          safely(() => L.shows.push(id));
          return orig.apply(this, arguments);
        });
      }
    }
    const ww = { observe: (subject, topic) => { if (topic === "domwindowopened") L.windows.push(subject); } };
    Services.ww.registerNotification(ww);
    L.undo.push(() => Services.ww.unregisterNotification(ww));
    const events = { observe: (s, topic, data) => L.events.push(topic + ":" + String(data ?? "")) };
    for (const topic of ["recording-device-events", "geolocation-device-events"]) {
      Services.obs.addObserver(events, topic);
      L.undo.push(() => Services.obs.removeObserver(events, topic));
    }

    if (vector === "gum" || vector === "gdm") {
      wrap(P, "receiveMessage", orig => function (msg) {
        if (msg.name !== "webrtc:Request") return orig.apply(this, arguments);
        let b = null;
        try { b = this.getBrowser(); } catch {}
        safely(() => L.hook.push({
          at: "WebRTCParent.receiveMessage(webrtc:Request)",
          isTarget: mine(b), who: who(b),
          browserId: b?.browserId ?? null,
          origin: this.manager?.documentPrincipal?.origin,
          top: this.manager?.topWindowContext?.documentPrincipal?.origin,
          innerWindowId: this.manager?.innerWindowId,
          windowID: msg.data?.windowID,
          types: msg.data?.requestTypes,
          screen: !!msg.data?.sharingScreen,
          userInput: msg.data?.isHandlingUserInput,
          secure: msg.data?.secure,
          devices: (msg.data?.videoInputDevices?.length ?? 0) + " video, " + (msg.data?.audioInputDevices?.length ?? 0) + " audio",
        }));
        if (mine(b) && mode === "throws") throw new Error("zs backstop throws");
        if (mine(b) && mode === "deny") { this.denyRequest(msg.data); return undefined; }
        return orig.apply(this, arguments);
      });
    } else if (vector === "pc") {
      const blocker = params => {
        let b = null;
        try { b = WindowGlobalParent.getByInnerWindowId(params.innerWindowID)?.browsingContext?.top?.embedderElement ?? null; } catch {}
        L.hook.push({
          at: "webrtcUI peer-connection blocker",
          isTarget: mine(b), who: who(b), browserId: b?.browserId ?? null,
          params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 60) : v])),
        });
        if (mine(b) && mode === "throws") throw new Error("zs blocker throws");
        return mine(b) && mode === "deny" ? "deny" : "allow";
      };
      webrtcUI.addPeerConnectionBlocker(blocker);
      L.undo.push(() => webrtcUI.removePeerConnectionBlocker(blocker));
    } else if (vector === "notify") {
      const factory = base => ({
        __proto__: base,
        createPermissionPrompt(type, request) {
          const b = request.element;
          L.hook.push({
            at: "Integration.contentPermission.createPermissionPrompt",
            isTarget: mine(b), who: who(b), browserId: b?.browserId ?? null, type,
            origin: request.principal?.origin, top: request.topLevelPrincipal?.origin,
            userInput: request.isHandlingUserInput,
          });
          if (mine(b) && type === "desktop-notification") {
            if (mode === "throws") throw new Error("zs prompt throws");
            if (mode === "deny") return { prompt() { request.cancel(); } };
          }
          return super.createPermissionPrompt(type, request);
        },
      });
      Integration.contentPermission.register(factory);
      L.undo.push(() => Integration.contentPermission.unregister(factory));
    } else if (vector === "sw") {
      const listener = {
        QueryInterface: ChromeUtils.generateQI(["nsIServiceWorkerManagerListener"]),
        onRegister(info) {
          const rec = { at: "swm onRegister", t: Date.now(), scope: info.scope.replace(/^http:\\/\\/[^/]+/, ""), script: info.scriptSpec.replace(/^http:\\/\\/[^/]+/, ""), origin: info.principal.origin };
          L.hook.push(rec);
          if (mode === "throws") throw new Error("zs listener throws");
          if (mode === "denySwm" && rec.scope.startsWith("/bs-scope/")) {
            try { swm.unregister(info.principal, null, info.scope); rec.unregistered = true; } catch (e) { rec.unregistered = "threw " + e.message; }
          }
        },
        onUnregister(info) { L.hook.push({ at: "swm onUnregister", t: Date.now(), scope: info.scope.replace(/^http:\\/\\/[^/]+/, "") }); },
        onQuotaUsageCheckFinish() {},
      };
      swm.addListener(listener);
      L.undo.push(() => swm.removeListener(listener));
      const net = {
        observe(subject) {
          let ch;
          try { ch = subject.QueryInterface(Ci.nsIChannel); } catch { return; }
          if (!ch.URI.spec.includes("/bs-sw.js")) return;
          const li = ch.loadInfo;
          const bcOf = id => { try { return id ? BrowsingContext.get(id) : null; } catch { return null; } };
          const bc = bcOf(li.browsingContextID) ?? bcOf(li.workerAssociatedBrowsingContextID);
          const b = bc?.top?.embedderElement ?? null;
          const rec = {
            at: "http-on-opening-request (the script)", t: Date.now(),
            type: li.internalContentPolicyType === Ci.nsIContentPolicy.TYPE_INTERNAL_SERVICE_WORKER ? "TYPE_INTERNAL_SERVICE_WORKER" : li.internalContentPolicyType,
            browsingContextID: li.browsingContextID, workerAssociatedBrowsingContextID: li.workerAssociatedBrowsingContextID,
            isTarget: mine(b), who: who(b), loading: li.loadingPrincipal?.origin ?? null, triggering: li.triggeringPrincipal?.origin ?? null,
          };
          L.hook.push(rec);
          if (mode === "throws") throw new Error("zs observer throws");
          if (mode === "denyNet") { ch.cancel(Cr.NS_ERROR_ABORT); rec.cancelled = true; }
        },
      };
      Services.obs.addObserver(net, "http-on-opening-request");
      L.undo.push(() => Services.obs.removeObserver(net, "http-on-opening-request"));
    }
    return "installed";
  `,
    { vector, mode, target }
  );
}

function take() {
  return chrome(
    C +
      `
    const L = P.__zsBS;
    const out = { hook: L.hook.splice(0), os: L.os.splice(0), sent: L.sent.splice(0), shows: L.shows.splice(0), events: L.events.splice(0), prompts: L.prompts };
    out.alerts = 0;
    for (const w of L.windows.splice(0)) { try { if (/alert/i.test(String(w.document?.documentURI ?? ""))) out.alerts++; } catch {} }
    for (const w of Services.wm.getEnumerator("alert:alert")) { try { w.close(); } catch {} }
    return JSON.parse(JSON.stringify(out));
  `
  );
}

function uninstall() {
  return chrome(
    C +
      `
    const L = P.__zsBS;
    for (const undo of (L?.undo ?? []).reverse()) { try { undo(); } catch {} }
    delete P.__zsBS;
    return true;
  `
  );
}

/** A plain tab on the fixture's /bs page, selected so a stored grant applies. */
function openTab() {
  return chrome(
    C +
      `
    const w = Services.wm.getMostRecentWindow("navigator:browser");
    const t = w.gBrowser.addTab(arg, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    w.gBrowser.selectedTab = t;
    await until(() => loaded(t), 10000);
    await until(async () => (await inContent(t, "return !!window.__bs").catch(() => false)) === true, 8000);
    return t.linkedBrowser.browserId;
  `,
    `${A.base}/bs`
  );
}

function closeTab(id) {
  return chrome(C + `const t = tabById(arg); if (t) t.ownerDocument.defaultView.gBrowser.removeTab(t, { animate: false }); return true;`, id);
}

/** The user's click on a button of the tab: a trusted event from the parent. */
function click(id, sel) {
  return chrome(
    C +
      `
    const t = tabById(arg.id);
    const w = t.ownerDocument.defaultView;
    w.gBrowser.selectedTab = t;
    await sleep(200);
    const at = await inContent(t, "const r = document.querySelector(" + JSON.stringify(arg.sel) + ").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2];");
    const r = t.linkedBrowser.getBoundingClientRect();
    const send = (type, buttons = 0) => w.synthesizeMouseEvent(type, r.left + at[0], r.top + at[1],
      { identifier: 0, button: 0, buttons, clickCount: 1, modifiers: 0, inputSource: 1 },
      { isDOMEventSynthesized: false, isWidgetEventSynthesized: false, isAsyncEnabled: false });
    send("mousemove"); await sleep(30); send("mousedown", 1); await sleep(40); send("mouseup");
    return true;
  `,
    { id, sel }
  );
}

async function outcome(id, v, ms = 4000) {
  const end = Date.now() + ms;
  let got = null;
  while (Date.now() < end) {
    got = await chrome(C + `const t = tabById(arg.id); return t ? inContent(t, "return window.__bs?.[" + JSON.stringify(arg.v) + "] ?? null") : "no tab";`, { id, v });
    if (got !== null && got !== "pending") return got;
    await sleep(150);
  }
  return got ?? "nothing";
}

const PERMS = { gum: ["camera", "microphone"], notify: ["desktop-notification"], notifyShow: ["desktop-notification"] };
function setPerms(vector, on) {
  return setPermsList(PERMS[vector] ?? [], on);
}
function setPermsList(perms, on) {
  return chrome(
    `
    const pr = Services.scriptSecurityManager.createContentPrincipalFromOrigin(arg.origin);
    for (const p of arg.perms) {
      if (arg.on) Services.perms.addFromPrincipal(pr, p, Services.perms.ALLOW_ACTION);
      else Services.perms.removeFromPrincipal(pr, p);
    }
    return true;
  `,
    { origin: A.base, perms, on }
  );
}

const stream = c => `navigator.mediaDevices.getUserMedia(${c}).then(s => { s.getTracks().forEach(t => t.stop()); return "stream"; })`;
/** Each device type: the stored grant, whether the call needs the user's activation, and the call. */
const DEVICES = {
  camera: { perms: ["camera"], call: stream("{ video: true }") },
  microphone: { perms: ["microphone"], call: stream("{ audio: true }") },
  cameraMic: { perms: ["camera", "microphone"], call: stream("{ video: true, audio: true }") },
  screen: { perms: ["screen"], activate: true, call: `navigator.mediaDevices.getDisplayMedia({ video: true }).then(s => { s.getTracks().forEach(t => t.stop()); return "stream"; })` },
  speaker: { perms: ["speaker"], activate: true, call: `navigator.mediaDevices.selectAudioOutput().then(d => "device " + d.kind)` },
  peer: { perms: [], call: `(async () => { const pc = new RTCPeerConnection(); try { pc.createDataChannel("x"); await pc.createOffer(); return "offer"; } finally { pc.close(); } })()` },
  notifyPrompt: { perms: ["desktop-notification"], call: `Notification.requestPermission()` },
  notifyShow: { perms: ["desktop-notification"], call: `(() => { new Notification("zs backstops"); return "shown, permission " + Notification.permission; })()` },
  geo: { perms: ["geo"], call: `new Promise(res => navigator.geolocation.getCurrentPosition(() => res("position"), e => res("error " + e.code), { timeout: 3000 }))` },
  midi: { perms: ["midi"], call: `navigator.requestMIDIAccess().then(() => "midi access")` },
};

/** A task's page on the fixture's /bs, its tab on screen, as when the user watches the agent. */
async function openTaskTab(device) {
  const space = await kit.newTask(`bs ${device}`, `${A.base}/bs`);
  const id = await chrome(
    C +
      `
    const rec = ctx.spaces.peek(arg);
    const t = ctx.service.pages.tabsOf(rec)[0];
    const w = t.ownerDocument.defaultView;
    Pages.landOn(t);
    await w.gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
    w.gBrowser.selectedTab = t;
    await until(() => w.gBrowser.selectedTab === t, 5000);
    await until(async () => (await inContent(t, "return !!window.__bs").catch(() => false)) === true, 8000);
    return t.linkedBrowser.browserId;
  `,
    space
  );
  return { space, id };
}

/**
 * The device's call from a sandbox with the page's principal and Xrays, made
 * from privileged code in the tab: it reaches the native API, not the page
 * guards. Its answer within `ms`, or "pending".
 */
function viaXrays(id, device, ms = 4000) {
  const d = DEVICES[device];
  const code = `
    const Cu = Components.utils;
    const S = Cu.Sandbox(window, { sandboxPrototype: window, wantXrays: true, sameZoneAs: window, sandboxName: "zs backstops: a world without the mirror" });
    if (${!!d.activate}) window.document.notifyUserGestureActivation();
    try {
      const p = Cu.evalInSandbox(${JSON.stringify(d.call)}, S);
      return await Promise.race([
        Promise.resolve(p).then(v => String(v), e => "rejected " + (e && e.name) + ": " + String(e && e.message).slice(0, 80)),
        new Promise(r => setTimeout(() => r("pending"), ${ms})),
      ]);
    } catch (e) {
      return "threw " + (e && e.name) + ": " + String(e && e.message).slice(0, 80);
    }
  `;
  return chrome(C + `const t = tabById(arg.id); return t ? inContent(t, arg.code, true) : "no tab";`, { id, code });
}

async function zeniusCase([, device, tab]) {
  const d = DEVICES[device];
  const out = { mode: "zenius", device, tab, grants: d.perms.join("+") || "none" };
  let id = null;
  let space = null;
  try {
    await setPermsList(d.perms, true);
    if (tab === "task") ({ space, id } = await openTaskTab(device));
    else id = await openTab();
    await install("none", "observe", id);
    // A stored camera grant applies only to a tab on screen (WebRTCParent's doorhanger, as it shows).
    out.onScreen = await chrome(C + `const t = tabById(arg); return !!t && t.ownerDocument.defaultView.gBrowser.selectedTab === t;`, id);
    out.page = await viaXrays(id, device);
    await sleep(500);
    Object.assign(out, await take());
    delete out.hook;
  } catch (e) {
    out.error = brief(e);
  } finally {
    await uninstall().catch(() => {});
    if (space) await kit.call("spaces.finish", { space, keep: [] }).catch(() => {});
    else if (id) await closeTab(id).catch(() => {});
    await setPermsList(d.perms, false).catch(() => {});
  }
  return out;
}

const CASES = [
  ...["prompt", "granted"].flatMap(state => ["observe", "deny", "throws"].map(mode => ["gum", state, mode])),
  ...["observe", "deny", "throws"].map(mode => ["gdm", "prompt", mode]),
  ...["observe", "deny", "throws"].map(mode => ["pc", "prompt", mode]),
  ...["observe", "deny", "throws"].map(mode => ["notify", "prompt", mode]),
  ["notify", "granted", "observe"],
  ["notifyShow", "granted", "observe"],
  ...["observe", "denyNet", "denySwm", "throws"].map(mode => ["sw", "prompt", mode]),
  ...Object.keys(DEVICES).flatMap(device => ["task", "user"].map(tab => ["zenius", device, tab])),
];

async function runCase([vector, state, mode]) {
  if (vector === "zenius") return zeniusCase([vector, state, mode]);
  const out = { vector, state, mode };
  let id = null;
  try {
    if (state === "granted") await setPerms(vector, true);
    id = await openTab();
    await install(vector === "notifyShow" ? "notify" : vector, mode, id);
    const h0 = netHits.length;
    await click(id, "#" + vector);
    out.page = await outcome(id, vector, vector === "sw" ? 5000 : 4000);
    await sleep(vector === "sw" ? 1500 : 500);
    Object.assign(out, await take());
    if (vector === "sw") {
      const mine = netHits.slice(h0).map(h => new URLSearchParams(h.q).get("w")).filter(w => /^sw/.test(w ?? ""));
      out.worker = { script: mine.filter(w => w === "swScript").length, ran: mine.filter(w => w === "swEval").length, installed: mine.filter(w => w === "swInstall").length };
    }
  } catch (e) {
    out.error = brief(e);
  } finally {
    await uninstall().catch(() => {});
    if (id) await closeTab(id).catch(() => {});
    if (state === "granted") await setPerms(vector, false).catch(() => {});
  }
  return out;
}

const wanted = process.argv.slice(2);
const pick = c => !wanted.length || wanted.some(w => c.join(":").startsWith(w));
const results = [];
try {
  for (const c of CASES.filter(pick)) {
    step(c.join(":"));
    results.push(await runCase(c));
  }
} finally {
  await kit.cleanTabs().catch(() => {});
  console.log(JSON.stringify(results, null, 1));
  kit.close();
}
