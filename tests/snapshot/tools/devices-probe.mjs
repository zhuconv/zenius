// Bypass probes for zen-observe's refusal of the camera, microphone, screen
// capture, location and MIDI in agent tabs (content/refusals.sys.mjs). A
// hidden agent tab's getUserMedia raised macOS's camera prompt for Zen.app.
// In Gecko 160 that prompt comes from WebRTCParent.checkOSPermission, which
// runs on a webrtc:Request: at once for a site the user already allowed,
// else after the user allows Firefox's prompt.
//
// The refusal answers in the page, before any request leaves it. So for each
// vector the probe counts what reached the parent:
// - webrtc:Request messages: getUserMedia, getDisplayMedia,
//   selectAudioOutput and speech recognition, once the page's media manager
//   asks for a device;
// - checkOSPermission calls, where macOS would ask;
// - webrtc:Allow messages, which start the devices;
// - content permission requests (location, MIDI, notifications);
// - doorhangers (PopupNotifications.show);
// - location provider starts ("geolocation-device-events" "starting");
// - requests to the fixture's /geo, the location provider's server;
// - requests to /hub/, the speech model's server;
// - notifications shown.
// It also records what the page got back: a stream or a position is a pass
// through. A vector with all zeros passes.
//
// Never on the Mac, and never with real devices or a location service: the
// probe refuses to run on macOS or without devices-prefs.js. Run it headless
// on the Linux server, on its own dev profile:
//
//   ZENIUS_DEV_PREFS=tests/snapshot/tools/devices-prefs.js scripts/zen-dev.sh zen-snapshot-devices start
//   ZENIUS_INSTANCE=zen-snapshot-devices node tests/snapshot/tools/devices-probe.mjs granted prompt hidden visible
//   ZENIUS_INSTANCE=zen-snapshot-devices node tests/snapshot/tools/devices-probe.mjs granted visible gumTop popupGrab
//
// "granted" first gives both fixture sites the camera, microphone, speakers,
// location, MIDI and notifications, as a site the user uses may have them.
// "prompt" leaves them unset, so a pass-through raises Firefox's prompt and
// hands the task to the user. "hidden" keeps the agent's tab in the
// background while the user works in their own Space; "visible" has the user
// watching it. Gecko grants a stored camera permission only to a tab on
// screen, so "granted visible" reaches macOS's prompt at once, and "granted
// hidden" when the user opens the tab after the handoff (userOpens). The
// probe never starts WebRTC ICE gathering, whose mDNS would reach the LAN.
//
// Results and the bypass this found: docs/research/device-bypass.md.
import { openKit } from "./owntab-kit.mjs";
import { geoHits, hubHits } from "./owntab-site.mjs";

const kit = await openKit();
const { call, chrome, ev, A, B, sleep, newTask, cleanUp } = kit;
const step = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const js = v => JSON.stringify(v).replace(/</g, "\\u003c");

/** Page helpers each vector's code starts with. */
const H = `
  const describe = v => {
    if (v == null) return String(v);
    if (typeof v.getTracks === "function") { const k = v.getTracks().map(t => t.kind).join(","); v.getTracks().forEach(t => t.stop()); return "stream (" + k + ")"; }
    if (v.coords) return "position";
    if (Array.isArray(v)) return v.length + " devices (" + v.map(d => d.kind).join(",") + "; labels " + v.filter(d => d.label).length + ")";
    if (typeof v.inputs === "object" && typeof v.outputs === "object") return "midi access";
    if (typeof v.deviceId === "string") return "device " + v.kind;
    return typeof v === "object" ? (v.constructor?.name ?? "object") : String(v);
  };
  const settle = (p, ms = 3000) => Promise.race([
    Promise.resolve(p).then(v => "resolved: " + describe(v), e => "rejected: " + (e?.name ?? "?") + ": " + String(e?.message ?? e).slice(0, 90)),
    new Promise(r => setTimeout(() => r("pending"), ms)),
  ]);
  const attempt = f => { try { return f(); } catch (e) { return Promise.reject(e); } };
  const AV = { video: true, audio: true };
  const position = (g, gcp = g.getCurrentPosition) => new Promise((res, rej) =>
    gcp.call(g, res, e => rej(Object.assign(new Error(e.message), { name: "PositionError" + e.code })), { timeout: 4000, maximumAge: 0 }));
  const both = (md, g, gum = md.getUserMedia, gcp = g.getCurrentPosition) => Promise.all([
    settle(attempt(() => gum.call(md, AV))), settle(attempt(() => position(g, gcp)), 5000),
  ]).then(([gum, geo]) => JSON.stringify({ gum, geo }));
  const tick = ms => new Promise(r => setTimeout(r, ms));
  const frame = (attrs = {}, tag = "iframe") => { const f = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) f.setAttribute(k, v); document.body.append(f); return f; };
  // What a frame or popup's own code reported (owntab-site.mjs's /gum-onload, ASKS).
  const reports = (source, ms = 5000) => new Promise(r => {
    const got = {};
    const done = () => r(JSON.stringify(Object.keys(got).length ? got : "nothing"));
    const t = setTimeout(done, ms);
    addEventListener("message", e => {
      const m = e.data?.zsOnLoad;
      if (!m || e.source !== source()) return;
      got[m.kind] = m.v;
      if (got.gum && got.geo) { clearTimeout(t); done(); }
    });
  });
`;

/** A document whose own script asks for the camera, microphone and location, and reports to its parent or opener. */
const ASKS = `<script>
  ${H}
  const send = (kind, v) => { for (const to of [parent !== window ? parent : null, opener]) { try { to?.postMessage({ zsOnLoad: { kind, v } }, "*"); } catch {} } };
  settle(attempt(() => navigator.mediaDevices.getUserMedia(AV))).then(v => send("gum", v));
  settle(attempt(() => position(navigator.geolocation)), 5000).then(v => send("geo", v));
</script>`;

/**
 * The vectors. Each is one of:
 * - { run }: the body of an async function in the agent's p1, run through
 *   page.evaluate; it returns the outcome;
 * - { click }: page code installed as #go's click handler, which zenius then
 *   clicks (window.open and some device APIs need a gesture); it stores its
 *   outcome promise in window.__p;
 * - { custom }: a function of the task's space.
 * `setup` lists prompt and permission types the vector raises on purpose,
 * which don't count against it.
 */
const VECTORS = {
  // The camera and microphone, from the agent's own page.
  gumTop: { run: `return settle(navigator.mediaDevices.getUserMedia(AV));` },
  gumScreenSource: { click: `window.__p = settle(attempt(() => navigator.mediaDevices.getUserMedia({ video: { mediaSource: "screen" } })));` },
  legacyMoz: {
    run: `if (typeof navigator.mozGetUserMedia !== "function") return "absent";
      return settle(new Promise((res, rej) => navigator.mozGetUserMedia(AV, res, rej)));`,
  },
  enumerate: { run: `return settle(navigator.mediaDevices.enumerateDevices());` },
  displayMedia: { click: `window.__p = settle(attempt(() => navigator.mediaDevices.getDisplayMedia({ video: true })));` },
  selectAudioOutput: {
    click: `window.__p = typeof navigator.mediaDevices.selectAudioOutput !== "function" ? Promise.resolve("absent") : settle(attempt(() => navigator.mediaDevices.selectAudioOutput()));`,
  },
  setSinkId: {
    run: `if (typeof HTMLMediaElement.prototype.setSinkId !== "function") return "absent";
      return settle(attempt(() => new Audio().setSinkId("zs-no-such-sink")));`,
  },
  // Gecko 160's speech recognition takes the microphone itself, not through
  // MediaDevices, and runs an on-device model it installs at start().
  speech: {
    run: `const R = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (typeof R !== "function") return "absent";
      const r = new R(); const seen = [];
      for (const type of ["start", "audiostart", "soundstart", "speechstart", "result", "nomatch", "end"]) r.addEventListener(type, () => seen.push(type));
      r.addEventListener("error", e => seen.push("error " + e.error + (e.message ? " (" + e.message.slice(0, 60) + ")" : "")));
      try { r.start(); } catch (e) { seen.push("threw " + e.name); }
      await tick(4000);
      try { r.abort(); } catch {}
      await tick(300);
      return seen.join(",") || "nothing";`,
  },
  // The prefixed name, in case it is its own interface with its own prototype.
  speechWebkit: {
    run: `const R = window.webkitSpeechRecognition;
      if (typeof R !== "function") return "absent";
      const same = R === window.SpeechRecognition && R.prototype === window.SpeechRecognition?.prototype;
      const r = new R(); const seen = [];
      for (const type of ["start", "audiostart", "end"]) r.addEventListener(type, () => seen.push(type));
      r.addEventListener("error", e => seen.push("error " + e.error));
      try { r.start(); } catch (e) { seen.push("threw " + e.name); }
      await tick(4000);
      try { r.abort(); } catch {}
      await tick(300);
      return (same ? "same interface: " : "its own interface: ") + (seen.join(",") || "nothing");`,
  },
  // Location, from the agent's own page.
  geoTop: { run: `return settle(position(navigator.geolocation), 5000);` },
  geoWatch: {
    run: `const seen = [];
      const id = navigator.geolocation.watchPosition(() => seen.push("position"), e => seen.push("error " + e.code));
      await tick(4500);
      navigator.geolocation.clearWatch(id);
      return seen.join(",") || "nothing";`,
  },
  // Other realms: each asks for both the camera and the location.
  blankNow: { run: `const f = frame(); return both(f.contentWindow.navigator.mediaDevices, f.contentWindow.navigator.geolocation);` },
  blankGrab: {
    // The fresh frame's methods, taken before its guards could go in, then
    // called later on the agent page's own objects.
    run: `const fw = frame().contentWindow;
      const gum = fw.MediaDevices.prototype.getUserMedia, gcp = fw.Geolocation.prototype.getCurrentPosition;
      await tick(400);
      return both(navigator.mediaDevices, navigator.geolocation, gum, gcp);`,
  },
  crossRealm: {
    run: `const fw = frame().contentWindow;
      await tick(400);
      const a = await both(navigator.mediaDevices, navigator.geolocation, fw.MediaDevices.prototype.getUserMedia, fw.Geolocation.prototype.getCurrentPosition);
      const b = await both(fw.navigator.mediaDevices, fw.navigator.geolocation, MediaDevices.prototype.getUserMedia, Geolocation.prototype.getCurrentPosition);
      return JSON.stringify({ frameMethodsOnTop: JSON.parse(a), topMethodsOnFrame: JSON.parse(b) });`,
  },
  srcdocFrame: { run: `const f = frame({ srcdoc: ${js(ASKS)} }); return reports(() => f.contentWindow);` },
  sandboxSameOrigin: { run: `const f = frame({ sandbox: "allow-scripts allow-same-origin", srcdoc: ${js(ASKS)} }); return reports(() => f.contentWindow);` },
  sandboxOpaque: { run: `const f = frame({ sandbox: "allow-scripts", srcdoc: ${js(ASKS)} }); return reports(() => f.contentWindow);` },
  dataFrame: { run: `const f = frame({ src: "data:text/html," + encodeURIComponent(${js(ASKS)}) }); return reports(() => f.contentWindow);` },
  blobFrame: {
    run: `const f = frame({ src: URL.createObjectURL(new Blob([${js(ASKS)}], { type: "text/html" })) }); return reports(() => f.contentWindow);`,
  },
  objectFrame: {
    run: `const o = frame({ data: "/devices", type: "text/html" }, "object");
      await new Promise(r => { o.addEventListener("load", r); setTimeout(r, 3000); });
      const w = o.contentWindow;
      return w ? both(w.navigator.mediaDevices, w.navigator.geolocation) : "no window";`,
  },
  crossSiteFrame: {
    run: `const f = frame({ src: ${js(`${B.base}/gum-onload`)}, allow: "camera; microphone; geolocation; display-capture; speaker-selection" });
      return reports(() => f.contentWindow, 7000);`,
  },
  // Popups: a new tab, which joins the task only once the parent hears of it.
  popupNow: { click: `const w = window.open("", "zsNow"); window.__p = both(w.navigator.mediaDevices, w.navigator.geolocation);` },
  popupGrab: {
    click: `const w = window.open("", "zsGrab");
      const gum = w.MediaDevices.prototype.getUserMedia, gcp = w.Geolocation.prototype.getCurrentPosition;
      window.__p = tick(400).then(() => both(navigator.mediaDevices, navigator.geolocation, gum, gcp));`,
  },
  popupWrite: {
    click: `let w; window.__p = reports(() => w, 6000); w = window.open("", "zsWrite"); w.document.write(${js(ASKS)}); w.document.close();`,
  },
  blobPopup: {
    click: `let w; window.__p = reports(() => w, 6000); w = window.open(URL.createObjectURL(new Blob([${js(ASKS)}], { type: "text/html" })), "zsBlob");`,
  },
  sitePopup: { click: `let w; window.__p = reports(() => w, 7000); w = window.open(${js(`${B.base}/gum-onload`)}, "zsSite");` },
  noopenerPopup: {
    custom: async s => {
      const opened = await clickWith(s, `window.open(${js(`${A.base}/gum-onload?noopener`)}, "_blank", "noopener"); window.__p = Promise.resolve("opened");`);
      await sleep(6000);
      return { opened, tabs: await onLoadReports("noopener") };
    },
  },
  // The site's own code in an agent tab, with no agent code on the page.
  siteOnLoad: {
    custom: async s => {
      await call("page.goto", { space: s, page: "p1", url: `${A.base}/gum-onload?site` });
      await sleep(6000);
      return onLoadReports("site");
    },
  },
  // Agent code that runs once the task isn't the agent's to drive.
  userHold: {
    custom: async s => {
      await ev(
        s,
        "p1",
        `() => { ${H} window.__out = {}; setTimeout(async () => { Object.assign(__out, JSON.parse(await both(navigator.mediaDevices, navigator.geolocation))); }, 1500); return true; }`
      );
      await call("spaces.handOff", { space: s });
      await sleep(8000);
      return readP1(s);
    },
  },
  persistThenAsk: {
    // persist() raises a real doorhanger with no gesture, which hands the
    // task to the user without them doing anything (zen-ux's automatic
    // handoff); guards that check per call whether the agent drives then
    // stand down.
    setup: ["persistent-storage"],
    custom: async s => {
      // The handoff stops this evaluate (ZEN_TASK_SPACE_USER_IN_CONTROL); the timer still runs.
      const planted = await ev(
        s,
        "p1",
        `() => { ${H} window.__out = {}; navigator.storage.persist(); setTimeout(async () => { Object.assign(__out, JSON.parse(await both(navigator.mediaDevices, navigator.geolocation))); }, 1500); return true; }`
      ).catch(e => e.code);
      await sleep(8000);
      return { planted, ...(await readP1(s)) };
    },
  },
  // A tab of the user's that the agent adopts after the user allows its
  // claim of their Space. zen-core guards the documents the tab has when it
  // joins the task ("installGuards"); its first page waits in the bfcache,
  // and a page coming back from there gets no new DOMWindowCreated.
  adoptBack: {
    custom: async () => {
      const made = await chrome(
        `
        const agents = ctx.spaces.agentsSpace.uuid;
        const mine = gZenWorkspaces.getWorkspaces().find(ws => ws.uuid !== agents);
        if (gZenWorkspaces.activeWorkspace !== mine.uuid) await gZenWorkspaces.changeWorkspaceWithID(mine.uuid);
        const t = gBrowser.addTrustedTab(arg.first, { inBackground: false });
        gBrowser.selectedTab = t;
        await until(() => t.linkedBrowser.currentURI.spec === arg.first && loaded(t), 10000);
        await loadEnded(t);
        const firstBc = t.linkedBrowser.browsingContext.id;
        t.linkedBrowser.loadURI(Services.io.newURI(arg.second), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
        await until(() => t.linkedBrowser.currentURI.spec === arg.second && loaded(t), 10000);
        await sleep(300);
        return { ws: mine.uuid, space: ctx.spaces.peekUuid(mine.uuid).id, tab: ctx.service.pages.tabId(t), firstInBFCache: !!BrowsingContext.get(firstBc)?.isInBFCache };
      `,
        { first: `${A.base}/bf?first`, second: `${A.base}/bf?second` }
      );
      const claim = call("spaces.claim", { space: made.space, client: "red team", timeout: 20000 });
      claim.catch(() => {});
      await call("dev.answerClaim", { space: made.space, timeout: 10000 });
      await claim;
      try {
        const adopted = await call("pages.adopt", { space: made.space, tab: made.tab });
        return { firstInBFCache: made.firstInBFCache, ...(await nowAndBack(made.space, adopted.label)) };
      } finally {
        await call("spaces.finish", { space: made.space, keep: [] }).catch(() => {});
      }
    },
  },
  // The same with no claim: a tab the user opens from the task's page while
  // they hold it joins the task unmanaged (noteOpenedTab), and the agent
  // may adopt it.
  userTabBack: {
    custom: async s => {
      await call("spaces.handOff", { space: s });
      const made = await chrome(
        `
        const p1 = ctx.resolvePage({ space: arg.s, page: "p1" }).tab;
        const g = p1.ownerDocument.defaultView.gBrowser;
        const system = Services.scriptSecurityManager.getSystemPrincipal();
        const t = g.addTab(arg.first, { openerBrowser: p1.linkedBrowser, triggeringPrincipal: system, inBackground: true });
        await until(() => t.linkedBrowser.currentURI.spec === arg.first && loaded(t), 10000);
        await loadEnded(t);
        const firstBc = t.linkedBrowser.browsingContext.id;
        t.linkedBrowser.loadURI(Services.io.newURI(arg.second), { triggeringPrincipal: system });
        await until(() => t.linkedBrowser.currentURI.spec === arg.second && loaded(t), 10000);
        await sleep(300);
        return { tab: ctx.service.pages.tabId(t), firstInBFCache: !!BrowsingContext.get(firstBc)?.isInBFCache };
      `,
        { s, first: `${A.base}/bf?first`, second: `${A.base}/bf?second` }
      );
      const takeOver = await call("spaces.takeOver", { space: s }).then(() => "ok", e => e.code);
      const listed = (await call("tabs.list", { space: s })).find(t => t.tab === made.tab) ?? null;
      const adopted = await call("pages.adopt", { space: s, tab: made.tab }).then(r => r, e => ({ error: e.code }));
      if (!adopted.label) {
        return { made, takeOver, listed, adopted };
      }
      return { firstInBFCache: made.firstInBFCache, takeOver, listedBy: listed?.openedBy, ...(await nowAndBack(s, adopted.label)) };
    },
  },
  // A page the user keeps is theirs once the task ends, and the refusals
  // end with the task. The agent's code planted there runs at the user's
  // first click in it.
  keptPage: {
    custom: async s => {
      await ev(
        s,
        "p1",
        `() => { ${H} window.__out = {}; addEventListener("click", async () => { Object.assign(__out, JSON.parse(await both(navigator.mediaDevices, navigator.geolocation))); }, { once: true }); return true; }`
      );
      const finished = await call("spaces.finish", { space: s, keep: ["p1"] }).then(r => ({ kept: r.keptManagedLabels }), e => e.code);
      const clicked = await chrome(
        `
        const t = all().find(x => x.linkedBrowser.currentURI.spec === arg && !ctx.service.lookup(x));
        if (!t) return "no kept tab";
        await gZenWorkspaces.changeWorkspaceWithID(t.getAttribute("zen-workspace-id"));
        gBrowser.selectedTab = t;
        await until(() => gBrowser.selectedTab === t, 3000).catch(() => {});
        await sleep(300);
        const r = t.linkedBrowser.getBoundingClientRect();
        const send = (type, buttons = 0) => win.synthesizeMouseEvent(type, r.left + 300, r.top + 200,
          { identifier: 0, button: 0, buttons, clickCount: 1, modifiers: 0, inputSource: 1 },
          { isDOMEventSynthesized: false, isWidgetEventSynthesized: false, isAsyncEnabled: false });
        send("mousemove"); await sleep(30); send("mousedown", 1); await sleep(40); send("mouseup"); await sleep(5500);
        return { out: await inContent(t, "return JSON.stringify(window.__out ?? null)") };
      `,
        `${A.base}/devices`
      );
      return { finished, clicked };
    },
  },
  // The agent's code ran in an earlier page of a tab the task then lets go
  // (kept at the finish, or released). zen-core empties the tab's bfcache
  // as it leaves, so the user's Back loads that page afresh.
  backAfterKeep: { custom: s => plantedThenBack(s, "keep") },
  backAfterRelease: { custom: s => plantedThenBack(s, "release") },
  // The kept page through the user's own bfcache, after the task: they go
  // elsewhere from the address bar and come Back to the same document, the
  // agent's code still in it. Its refusals stay until the document is replaced.
  keptBackForward: {
    custom: async s => {
      const first = `${A.base}/bf?first`;
      await call("page.goto", { space: s, page: "p1", url: first });
      await ev(s, "p1", plant("page"));
      const finished = await call("spaces.finish", { space: s, keep: ["p1"] }).then(() => "kept", e => e.code);
      return { finished, ...(await userInTab({ url: first, away: `${A.base}/bf?user`, back: first })) };
    },
  },
  // The planted code asks at the user's click from a frame, or a popup, that
  // it makes only then, after the task.
  keptFrame: { custom: s => keptWith(s, "frame") },
  keptPopup: { custom: s => keptWith(s, "popup") },
  // Other devices and prompts.
  midi: { run: `if (typeof navigator.requestMIDIAccess !== "function") return "absent"; return settle(attempt(() => navigator.requestMIDIAccess()));` },
  midiSysex: {
    run: `if (typeof navigator.requestMIDIAccess !== "function") return "absent"; return settle(attempt(() => navigator.requestMIDIAccess({ sysex: true })));`,
  },
  // What reaches past the tab is a desktop notification, which the alert
  // counter sees. requestPermission()'s doorhanger is a page's ordinary
  // permission prompt (zen-ux hands the task to the user), and zen-ux gives
  // a page the agent drives a quiet Notification that fires show without
  // showing anything (ZeniusSystemUiChild), so neither counts.
  notification: {
    setup: ["desktop-notification", "web-notifications"],
    click: `window.__p = (async () => {
        const perm = await settle(attempt(() => Notification.requestPermission()), 2500);
        let event = "not tried";
        if (Notification.permission === "granted") {
          event = await new Promise(r => { const n = new Notification("zenius probe", { body: "from an agent page" }); n.onshow = () => r("show"); n.onerror = () => r("error"); setTimeout(() => r("pending"), 2500); });
        }
        return JSON.stringify({ perm, permission: Notification.permission, event });
      })();`,
  },
  // The control: the same notification from a tab of the user's on the
  // site, with no agent code, must show on the desktop (granted runs).
  notificationControl: {
    custom: async () =>
      chrome(
        `
        const t = gBrowser.addTrustedTab(arg, { inBackground: true });
        try {
          await until(() => t.linkedBrowser.currentURI.spec === arg && loaded(t), 10000);
          return await inContent(t, "if (Notification.permission !== 'granted') return Notification.permission; return await new Promise(r => { const n = new Notification('zenius control', { body: 'from a tab of the user' }); n.onshow = () => r('show'); n.onerror = () => r('error'); setTimeout(() => r('pending'), 2500); });");
        } finally {
          gBrowser.removeTab(t, { animate: false });
        }
      `,
        `${A.base}/devices`
      ),
  },
  permissionsQuery: {
    run: `const out = {};
      for (const name of ["camera", "microphone", "geolocation", "midi", "notifications"]) out[name] = await settle(attempt(() => navigator.permissions.query({ name })).then(s => s.state));
      return JSON.stringify(out);`,
  },
};

/**
 * In an adopted tab: the devices, a service worker and a Cache write, at
 * once in the page it shows, then in the page history.back() brings from
 * the bfcache. The storage writes show whether item 3's refusals are there
 * too (own-tab.md); cleanTabs clears both sites' data after.
 */
async function nowAndBack(space, label) {
  const ask = `async () => { ${H}
    const sw = await settle(attempt(() => navigator.serviceWorker.register("/sw-runtime.js", { scope: "/rt/" })));
    const cache = await settle(attempt(() => caches.open("zs-adopt").then(c => c.put("/rt/zs", new Response("x")))));
    return JSON.stringify({ page: location.search, persisted: window.__shows ?? null, sw, cache, ...JSON.parse(await both(navigator.mediaDevices, navigator.geolocation)) }); }`;
  const now = await ev(space, label, ask).catch(e => e.code);
  await ev(space, label, "() => { history.back(); return true; }").catch(e => e.code);
  await sleep(2000);
  const back = await ev(space, label, ask).catch(e => e.code);
  return { now, back };
}

/**
 * The agent's code, left in p1: at the user's first click there it asks for
 * the camera and location, from the page, from a frame it makes then, or
 * from a popup it opens then. It also marks the page as planted.
 */
const plant = where => `async () => { ${H}
  window.__planted = true;
  window.__out = {};
  addEventListener("click", async () => {
    let md = navigator.mediaDevices, g = navigator.geolocation;
    if (${js(where)} === "frame") {
      const f = frame();
      md = f.contentWindow.navigator.mediaDevices;
      g = f.contentWindow.navigator.geolocation;
    } else if (${js(where)} === "popup") {
      const w = window.open("/devices?kept-popup", "zsKeptPop");
      await new Promise(r => {
        const iv = setInterval(() => { try { if (w.location.search === "?kept-popup" && w.document.readyState === "complete") { clearInterval(iv); r(); } } catch {} }, 50);
        setTimeout(r, 4000);
      });
      md = w.navigator.mediaDevices;
      g = w.navigator.geolocation;
    }
    Object.assign(__out, JSON.parse(await both(md, g)));
  }, { once: true });
  return true; }`;

/**
 * The user, in the tab at `url`: they go elsewhere from the address bar
 * (`away`) and press Back (`back`), each when asked, then click in the page.
 * Before leaving a page it waits for its load to end: Gecko keeps a page in
 * the bfcache only once its load group is idle.
 */
function userInTab(arg) {
  return chrome(
    `
    const out = {};
    const t = all().find(x => x.linkedBrowser.currentURI.spec === arg.url && (arg.anyTab || !ctx.service.lookup(x)));
    if (!t) return { error: "no such tab: " + arg.url };
    out.tabInTask = !!ctx.service.lookup(t);
    await gZenWorkspaces.changeWorkspaceWithID(t.getAttribute("zen-workspace-id"));
    gBrowser.selectedTab = t;
    await until(() => gBrowser.selectedTab === t, 3000).catch(() => {});
    if (arg.away) {
      await loadEnded(t);
      const bc = t.linkedBrowser.browsingContext.id;
      t.linkedBrowser.loadURI(Services.io.newURI(arg.away), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      await until(() => t.linkedBrowser.currentURI.spec === arg.away && loaded(t), 10000);
      await sleep(300);
      out.cachedByUser = !!BrowsingContext.get(bc)?.isInBFCache;
    }
    if (arg.back) {
      // The Back button skips pages the user never interacted with (Gecko's
      // back-button intervention): out.canGoBack. Its menu still lists them,
      // so the user picks the page there.
      out.canGoBack = t.linkedBrowser.canGoBack;
      const sh = t.linkedBrowser.browsingContext.sessionHistory;
      let i = sh.index - 1;
      while (i >= 0 && sh.getEntryAtIndex(i).URI.spec !== arg.back) i--;
      if (i < 0) return { ...out, error: "no history entry for " + arg.back };
      t.linkedBrowser.gotoIndex(i);
      await until(() => t.linkedBrowser.currentURI.spec === arg.back && loaded(t), 10000);
      await sleep(500);
    }
    out.page = JSON.parse(await inContent(t, "return JSON.stringify({ url: location.href, shows: window.__shows ?? null, planted: window.__planted ?? false })"));
    const r = t.linkedBrowser.getBoundingClientRect();
    const send = (type, buttons = 0) => win.synthesizeMouseEvent(type, r.left + 300, r.top + 200,
      { identifier: 0, button: 0, buttons, clickCount: 1, modifiers: 0, inputSource: 1 },
      { isDOMEventSynthesized: false, isWidgetEventSynthesized: false, isAsyncEnabled: false });
    send("mousemove"); await sleep(30); send("mousedown", 1); await sleep(40); send("mouseup"); await sleep(5500);
    out.out = await inContent(t, "return JSON.stringify(window.__out ?? null)");
    for (const p of all().filter(x => x.linkedBrowser.currentURI.spec.includes("?kept-popup"))) p.ownerDocument.defaultView.gBrowser.removeTab(p, { animate: false });
    return out;
  `,
    arg
  );
}

/**
 * The agent's code runs in /bf?first, the agent goes on to /bf?second once
 * the first page's load has ended, and the task lets the tab go. The user
 * then presses Back and clicks in the page that comes back.
 */
async function plantedThenBack(s, leave) {
  const first = `${A.base}/bf?first`;
  const second = `${A.base}/bf?second`;
  let space = s;
  let label = "p1";
  if (leave === "release") {
    // Only a page the agent didn't open can be released: a tab of the
    // user's that it adopted, after the user allowed its claim.
    const made = await chrome(
      `
      const agents = ctx.spaces.agentsSpace.uuid;
      const mine = gZenWorkspaces.getWorkspaces().find(ws => ws.uuid !== agents);
      if (gZenWorkspaces.activeWorkspace !== mine.uuid) await gZenWorkspaces.changeWorkspaceWithID(mine.uuid);
      const t = gBrowser.addTrustedTab(arg, { inBackground: false });
      await until(() => t.linkedBrowser.currentURI.spec === arg && loaded(t), 10000);
      return { space: ctx.spaces.peekUuid(mine.uuid).id, tab: ctx.service.pages.tabId(t) };
    `,
      `${A.base}/devices?user`
    );
    const claim = call("spaces.claim", { space: made.space, client: "red team", timeout: 20000 });
    claim.catch(() => {});
    await call("dev.answerClaim", { space: made.space, timeout: 10000 });
    await claim;
    space = made.space;
    label = (await call("pages.adopt", { space, tab: made.tab })).label;
  }
  try {
    await call("page.goto", { space, page: label, url: first });
    await ev(space, label, plant("page"));
    const firstBc = await chrome(
      `const t = ctx.resolvePage({ space: arg.space, page: arg.label }).tab; await loadEnded(t); return t.linkedBrowser.browsingContext.id;`,
      { space, label }
    );
    await call("page.goto", { space, page: label, url: second });
    const cachedInTask = await chrome(`await sleep(300); return !!BrowsingContext.get(arg)?.isInBFCache;`, firstBc);
    const left =
      leave === "keep"
        ? await call("spaces.finish", { space, keep: [label] }).then(() => "kept", e => e.code)
        : await call("pages.release", { space, page: label }).then(() => "released", e => e.code);
    const cachedAfterLeave = await chrome(`await sleep(300); return !!BrowsingContext.get(arg)?.isInBFCache;`, firstBc);
    return { cachedInTask, left, cachedAfterLeave, ...(await userInTab({ url: second, back: first, anyTab: leave === "release" })) };
  } finally {
    if (space !== s) {
      await call("spaces.finish", { space, keep: [] }).catch(() => {});
    }
  }
}

/** The agent's code asks from a frame or popup it makes at the user's first click in the kept page. */
async function keptWith(s, where) {
  await ev(s, "p1", plant(where));
  const finished = await call("spaces.finish", { space: s, keep: ["p1"] }).then(() => "kept", e => e.code);
  return { finished, ...(await userInTab({ url: `${A.base}/devices` })) };
}

/** Install a click handler from agent code, have zenius click it, and return its outcome. */
async function clickWith(s, code) {
  await ev(s, "p1", `() => { ${H} document.getElementById("go").onclick = () => { ${code} }; return true; }`);
  const click = await call("page.click", { space: s, page: "p1", target: "#go", options: {} }).catch(e => ({ error: `${e.code}: ${e.message}` }));
  if (click?.error) {
    return `click failed: ${click.error}`;
  }
  return ev(s, "p1", `async () => (await window.__p) ?? "the click handler never ran"`).catch(e => `evaluate failed: ${e.code}: ${String(e.message).slice(0, 120)}`);
}

/** p1's window.__out, read without running agent code. */
function readP1(s) {
  return chrome(
    `
    const t = ctx.resolvePage({ space: arg, page: "p1" }).tab;
    return { ownership: ctx.spaces.peek(arg)?.ownership ?? null, out: await inContent(t, "return JSON.stringify(window.__out ?? null)") };
  `,
    s
  );
}

/** What each tab showing /gum-onload?<tag> reported, read without running agent code. */
function onLoadReports(tag) {
  return chrome(
    `
    const out = [];
    for (const t of all()) {
      if (!t.linkedBrowser.currentURI.spec.includes("/gum-onload?" + arg)) continue;
      const hit = ctx.service.lookup(t);
      out.push({
        task: hit ? hit.rec.ownership : "none (a user tab)",
        out: await inContent(t, "return JSON.stringify(window.__out ?? null)").catch(e => "unreadable: " + e.message),
      });
    }
    return out.length ? out : "no such tab";
  `,
    tag
  );
}

/** Counters in the parent. They stay installed until removeCounters. */
function installCounters() {
  return chrome(`
    const svc = ctx.service;
    const { WebRTCParent } = ChromeUtils.importESModule("resource:///actors/WebRTCParent.sys.mjs");
    const { ContentPermissionPrompt } = ChromeUtils.importESModule("moz-src:///browser/components/permissions/ContentPermissionPrompt.sys.mjs");
    const P = WebRTCParent.prototype;
    if (P.__zsDevices) return "already";
    const L = (P.__zsDevices = { webrtc: [], os: [], allow: [], perm: [], shows: [], events: [], windows: [], undo: [] });
    // Desktop notifications: Gecko's own alerts (alerts.useSystemBackend off) open a window.
    const ww = { observe: (subject, topic) => { if (topic === "domwindowopened") L.windows.push(subject); } };
    Services.ww.registerNotification(ww);
    L.undo.push(() => Services.ww.unregisterNotification(ww));
    // Not ownerGlobal: this scope doesn't see it (as zen-ux's holdForUser notes).
    const who = browser => {
      try {
        const tab = browser?.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser(browser) ?? all().find(t => t.linkedBrowser === browser);
        if (!tab) return "no tab";
        const hit = svc.lookup(tab);
        return hit ? hit.rec.ownership : "user tab";
      } catch (e) { return "? " + e.message; }
    };
    const wrap = (obj, name, make) => {
      const own = Object.prototype.hasOwnProperty.call(obj, name);
      const orig = obj[name];
      obj[name] = make(orig);
      L.undo.push(() => { if (own) obj[name] = orig; else delete obj[name]; });
    };
    const safely = f => { try { f(); } catch {} };
    wrap(P, "receiveMessage", orig => function (m) {
      safely(() => { if (m.name === "webrtc:Request") L.webrtc.push({ who: who(this.getBrowser()), types: (m.data?.requestTypes ?? []).join("+") || "?" }); });
      return orig.apply(this, arguments);
    });
    wrap(P, "checkOSPermission", orig => function (cam, mic, scr) {
      safely(() => L.os.push({ who: who(this.getBrowser()), cam: !!cam, mic: !!mic, scr: !!scr }));
      return orig.apply(this, arguments);
    });
    wrap(P, "sendAsyncMessage", orig => function (name) {
      safely(() => { if (name === "webrtc:Allow") L.allow.push({ who: who(this.getBrowser()) }); });
      return orig.apply(this, arguments);
    });
    wrap(ContentPermissionPrompt.prototype, "prompt", orig => function (request) {
      safely(() => L.perm.push({ who: who(request.element), type: request.types.queryElementAt(0, Ci.nsIContentPermissionType).type }));
      return orig.apply(this, arguments);
    });
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      if (w.PopupNotifications) {
        wrap(w.PopupNotifications, "show", orig => function (browser, id) {
          safely(() => L.shows.push({ who: who(browser), id }));
          return orig.apply(this, arguments);
        });
      }
    }
    const observer = { observe: (s, topic, data) => L.events.push({ topic, data: String(data ?? "") }) };
    for (const topic of ["recording-device-events", "geolocation-device-events"]) {
      Services.obs.addObserver(observer, topic);
      L.undo.push(() => Services.obs.removeObserver(observer, topic));
    }
    return "installed";
  `);
}

function removeCounters() {
  return chrome(`
    const { WebRTCParent } = ChromeUtils.importESModule("resource:///actors/WebRTCParent.sys.mjs");
    const L = WebRTCParent.prototype.__zsDevices;
    for (const undo of (L?.undo ?? []).reverse()) { try { undo(); } catch {} }
    delete WebRTCParent.prototype.__zsDevices;
    return true;
  `);
}

/** Read and clear the counters, and close any notification. */
function takeCounts() {
  return chrome(`
    const { WebRTCParent } = ChromeUtils.importESModule("resource:///actors/WebRTCParent.sys.mjs");
    const L = WebRTCParent.prototype.__zsDevices;
    const out = {};
    for (const k of ["webrtc", "os", "allow", "perm", "shows", "events"]) out[k] = L[k].splice(0);
    out.alerts = 0;
    for (const w of L.windows.splice(0)) {
      try { if (/alert/i.test(String(w.document?.documentURI ?? ""))) out.alerts++; } catch {}
    }
    for (const w of Services.wm.getEnumerator("alert:alert")) { try { w.close(); } catch {} }
    return JSON.parse(JSON.stringify(out));
  `);
}

/** Linux, fake devices, and Gecko's own fetches kept on loopback (devices-prefs.js). */
async function checkSafe() {
  if (process.platform === "darwin") {
    throw new Error("devices-probe never runs on macOS: it would reach the Mac's real devices");
  }
  const env = await chrome(`
    const p = Services.prefs;
    const b = (n, d) => p.getBoolPref(n, d);
    const s = n => p.getStringPref(n, "");
    return {
      os: Services.appinfo.OS,
      fake: b("media.navigator.streams.fake", false),
      loopbackDevices: s("media.audio_loopback_dev") + s("media.video_loopback_dev"),
      permissionDisabled: b("media.navigator.permission.disabled", false),
      geoTesting: b("geo.provider.testing", false),
      geoUrl: s("geo.provider.network.url"),
      geoScan: b("geo.provider.network.scan", true),
      geoSystem: b("geo.provider.use_geoclue", false) || b("geo.provider.use_gpsd", false),
      midiTesting: b("midi.testing", false),
      systemAlerts: b("alerts.useSystemBackend", true),
      modelHub: s("browser.ml.modelHubRootUrl"),
      remoteSettings: s("services.settings.server"),
      regionUrl: s("browser.region.network.url"),
      mockAudio: b("media.cubeb.force_mock_context", false),
    };
  `);
  const loop = u => /^http:\/\/127\.0\.0\.1[:/]/.test(u);
  const bad = Object.entries({
    os: env.os !== "Darwin",
    fake: env.fake,
    loopbackDevices: !env.loopbackDevices,
    permissionDisabled: !env.permissionDisabled,
    geoTesting: env.geoTesting,
    geoUrl: loop(env.geoUrl),
    geoScan: !env.geoScan,
    geoSystem: !env.geoSystem,
    midiTesting: env.midiTesting,
    systemAlerts: !env.systemAlerts,
    modelHub: loop(env.modelHub),
    remoteSettings: loop(env.remoteSettings),
    regionUrl: !env.regionUrl,
    mockAudio: env.mockAudio,
  })
    .filter(([, ok]) => !ok)
    .map(([k]) => k);
  if (bad.length) {
    throw new Error(`devices-probe needs devices-prefs.js and Linux; not so: ${bad.join(", ")}: ${JSON.stringify(env)}`);
  }
  return env;
}

const GRANTS = ["camera", "microphone", "speaker", "geo", "midi", "midi-sysex", "desktop-notification"];

/** Give both fixture sites the permissions a site the user uses may have. */
function grant() {
  return chrome(
    `
    for (const origin of arg.origins) {
      const p = Services.scriptSecurityManager.createContentPrincipalFromOrigin(origin);
      for (const type of arg.types) Services.perms.addFromPrincipal(p, type, Services.perms.ALLOW_ACTION);
    }
    return true;
  `,
    { origins: [A.base, B.base], types: GRANTS }
  );
}

/**
 * End the task. A prompt that handed it to the user is removed, as an
 * unanswered prompt, which gives it back (zen-ux's #onPermissionGone); a
 * handOff is handed back on the pill. cleanTabs also clears both sites' data
 * and permissions.
 */
async function finish(s) {
  const ownership = await chrome(
    `
    const rec = ctx.spaces.peek(arg);
    if (rec?.ownership === "agentDelegatedToUser") {
      for (const t of taskTabs(arg)) {
        const pn = t.ownerDocument.defaultView.PopupNotifications;
        for (const n of [...(pn.getNotificationsForBrowser(t.linkedBrowser) ?? [])]) pn.remove(n, true);
      }
      await until(() => rec.ownership === "agent", 3000).catch(() => {});
    }
    return rec?.ownership ?? null;
  `,
    s
  ).catch(e => `unreadable: ${e.message}`);
  if (ownership && ownership !== "agent") {
    await kit.handBack(s).catch(e => step("hand back failed:", ownership, e.message));
  }
  await cleanUp([s]);
  const left = await chrome(`return ctx.spaces.peek(arg)?.ownership ?? null;`, s).catch(() => null);
  if (left) {
    // Close its tabs, so the next vectors run without it.
    const closed = await chrome(`let n = 0; for (const t of taskTabs(arg)) { t.ownerDocument.defaultView.gBrowser.removeTab(t, { animate: false }); n++; } return n;`, s).catch(e => e.message);
    step(`task ${s} stayed open (${left}); closed its ${closed} tabs`);
  }
}

/**
 * Granted mode: Gecko grants a stored camera or microphone permission only
 * when the doorhanger is about to show, never in a background tab
 * (WebRTCParent's "showing" handler). The user who follows zen-ux's handoff
 * opens the task's tab, and the grant then runs checkOSPermission, where
 * macOS asks. So the user opens the tab with the pending camera prompt.
 */
function userOpens(s) {
  return chrome(
    `
    const rec = ctx.spaces.peek(arg);
    if (rec?.ownership !== "agentDelegatedToUser") return "no handoff";
    const t = taskTabs(arg).find(x => x.ownerDocument.defaultView.PopupNotifications.getNotification("webRTC-shareDevices", x.linkedBrowser));
    if (!t) return "no camera prompt";
    const prev = gZenWorkspaces.activeWorkspace;
    await gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
    gBrowser.selectedTab = t;
    await until(() => gBrowser.selectedTab === t).catch(() => {});
    await sleep(2500);
    // Back to the user's Space, so the next task's tab stays in the background.
    await gZenWorkspaces.changeWorkspaceWithID(prev);
    return "opened";
  `,
    s
  );
}

function verdictOf(c, hits, outcome, setup = []) {
  const counted = list => list.filter(r => !setup.includes(r.type ?? r.id));
  const perm = counted(c.perm);
  const shows = counted(c.shows);
  const starts = c.events.filter(e => e.topic === "geolocation-device-events" && e.data === "starting");
  const reached = [];
  if (c.webrtc.length) reached.push(`media requests ${c.webrtc.length} (${c.webrtc.map(r => `${r.types} from ${r.who}`).join(", ")})`);
  if (c.os.length) reached.push(`OS permission checks ${c.os.length}`);
  if (c.allow.length) reached.push(`devices started ${c.allow.length}`);
  if (perm.length) reached.push(`permission requests ${perm.length} (${perm.map(r => `${r.type} from ${r.who}`).join(", ")})`);
  if (shows.length) reached.push(`doorhangers ${shows.length} (${shows.map(r => r.id).join(", ")})`);
  if (starts.length) reached.push(`location provider starts ${starts.length}`);
  if (hits.geo) reached.push(`location server requests ${hits.geo}`);
  if (hits.hub) reached.push(`model hub requests ${hits.hub}`);
  if (c.alerts) reached.push(`notifications shown ${c.alerts}`);
  // Not a notification's show: zen-ux's quiet one fires it too. The alert counter decides there.
  if (/stream \(|position|midi access|audiostart|labels [1-9]/.test(JSON.stringify(outcome ?? ""))) {
    reached.push("the page got it");
  }
  return reached.length ? `REACHED: ${reached.join("; ")}` : "refused in the page";
}

/**
 * Where the user is: "hidden", working in a Space of their own, so the
 * agent's tab is in the background; or "visible", watching the agent's tab,
 * where Firefox shows a doorhanger, and grants a stored permission, at once.
 * Returns the agent page's document.hidden.
 */
function place(s, where) {
  return chrome(
    `
    const agents = ctx.spaces.agentsSpace.uuid;
    const t = ctx.resolvePage({ space: arg.s, page: "p1" }).tab;
    if (arg.where === "visible") {
      if (gZenWorkspaces.activeWorkspace !== agents) await gZenWorkspaces.changeWorkspaceWithID(agents);
      gBrowser.selectedTab = t;
      await until(() => gBrowser.selectedTab === t, 3000).catch(() => {});
    } else {
      const mine = gZenWorkspaces.getWorkspaces().find(ws => ws.uuid !== agents);
      if (gZenWorkspaces.activeWorkspace !== mine.uuid) await gZenWorkspaces.changeWorkspaceWithID(mine.uuid);
    }
    await sleep(200);
    // document.hidden stays false in an agent tab either way: zenius keeps it active.
    return gBrowser.selectedTab === t ? "selected" : "in the background";
  `,
    { s, where }
  );
}

async function runVector(name, v, mode, placement) {
  const s = await newTask(`devices ${name}`, `${A.base}/devices`);
  try {
    if (mode === "granted") {
      await grant();
    }
    const hidden = await place(s, placement).catch(e => `unplaced: ${e.message}`);
    await takeCounts();
    const hits0 = { geo: geoHits.length, hub: hubHits.length };
    let outcome;
    if (v.custom) {
      outcome = await v.custom(s);
    } else if (v.click) {
      outcome = await clickWith(s, v.click);
    } else {
      outcome = await ev(s, "p1", `async () => { ${H} ${v.run} }`).catch(e => `evaluate failed: ${e.code}: ${String(e.message).slice(0, 120)}`);
    }
    await sleep(1000);
    const c = await takeCounts();
    const hits = { geo: geoHits.length - hits0.geo, hub: hubHits.length - hits0.hub };
    const result = { hidden, outcome, verdict: verdictOf(c, hits, outcome, v.setup), events: c.events.map(e => `${e.topic.split("-")[0]}:${e.data}`) };
    if (mode === "granted" && placement === "hidden") {
      const opened = await userOpens(s).catch(e => `failed: ${e.message}`);
      if (opened === "opened") {
        const o = await takeCounts();
        result.userOpens = { os: o.os, devicesStarted: o.allow.length, events: o.events.map(e => `${e.topic.split("-")[0]}:${e.data}`) };
      }
    }
    return result;
  } finally {
    await finish(s);
  }
}

const args = process.argv.slice(2);
const MODES = ["granted", "prompt"];
const PLACEMENTS = ["hidden", "visible"];
const modes = args.filter(a => MODES.includes(a));
const placements = args.filter(a => PLACEMENTS.includes(a));
const names = args.filter(a => VECTORS[a]);
const unknown = args.filter(a => !VECTORS[a] && !MODES.includes(a) && !PLACEMENTS.includes(a));
const runs = (modes.length ? modes : ["granted"]).flatMap(mode => (placements.length ? placements : ["hidden"]).map(placement => ({ mode, placement })));
const results = {};
try {
  if (unknown.length) {
    throw new Error(`unknown vectors: ${unknown.join(", ")}; known: ${Object.keys(VECTORS).join(", ")}`);
  }
  results.env = await checkSafe();
  await chrome(
    `Services.prefs.setStringPref("geo.provider.network.url", arg.geo); Services.prefs.setStringPref("browser.ml.modelHubRootUrl", arg.hub); return true;`,
    { geo: `${A.base}/geo`, hub: `${A.base}/hub/` }
  );
  step("counters", await installCounters());
  for (const { mode, placement } of runs) {
    const key = `${mode} ${placement}`;
    results[key] = {};
    for (const name of names.length ? names : Object.keys(VECTORS)) {
      step(key, name);
      try {
        results[key][name] = await runVector(name, VECTORS[name], mode, placement);
      } catch (e) {
        results[key][name] = { error: String(e?.message ?? e).slice(0, 300) };
      }
      step(key, name, "->", results[key][name].verdict ?? results[key][name].error);
    }
  }
} catch (e) {
  results.error = String(e?.message ?? e);
} finally {
  await removeCounters().catch(() => {});
  await chrome(
    `Services.prefs.setStringPref("geo.provider.network.url", "http://127.0.0.1:9/geo"); Services.prefs.setStringPref("browser.ml.modelHubRootUrl", "http://127.0.0.1:9/hub/"); return true;`
  ).catch(() => {});
  const summary = {};
  for (const { mode, placement } of runs) {
    const key = `${mode} ${placement}`;
    if (!results[key]) {
      continue;
    }
    const rows = Object.entries(results[key]);
    summary[key] = {
      reached: rows.filter(([, r]) => r.verdict?.startsWith("REACHED")).map(([n]) => n),
      refused: rows.filter(([, r]) => r.verdict && !r.verdict.startsWith("REACHED")).map(([n]) => n),
      errors: rows.filter(([, r]) => r.error).map(([n]) => n),
    };
  }
  results.summary = summary;
  console.log(JSON.stringify(results, null, 1));
  kit.close();
}
