// The parent backstops (modules/backstops.sys.mjs). A task page's device
// and peer requests are refused while the agent drives it, or when it shows evidence; its
// permission prompts only on evidence. During the user's hold the page asks
// the user, as any site does, and a stream started then stops when the agent
// has the page again. Each request comes from a sandbox with the page's
// principal and Xrays, made by privileged code in the tab: it reaches the
// native API past zen-observe's page refusals, as the agent's world would if
// its mirror of them failed.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
let port = 0;
let port2 = 0;
const html = { "content-type": "text/html" };
const serve = (req, res) => {
  const url = new URL(req.url, "http://x");
  res.writeHead(200, html);
  if (url.pathname === "/framed") {
    // Another site's frame: its own process, its own WebRTCParent.
    res.end(`<!doctype html><title>framed</title><iframe src="http://localhost:${port}/frame" allow="camera; microphone; display-capture; geolocation"></iframe>`);
    return;
  }
  res.end(`<!doctype html><title>${url.pathname.slice(1)}</title><p>${url.pathname}`);
};
const http1 = http.createServer(serve);
const http2 = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
  res.end("loopback");
});
const site = path => `http://127.0.0.1:${port}${path}`;
const other = path => `http://localhost:${port}${path}`;

/** Chrome-side helpers for each h.chrome call. */
const C = `
  const B = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/backstops.sys.mjs");
  const E = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/evidence.sys.mjs");
  const { webrtcUI } = ChromeUtils.importESModule("resource:///modules/webrtcUI.sys.mjs");
  const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
  const { WebRTCParent } = ChromeUtils.importESModule("resource:///actors/WebRTCParent.sys.mjs");
  const P = WebRTCParent.prototype;
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const until = async (f, ms = 8000) => { const end = Date.now() + ms; let v; while (!(v = await f()) && Date.now() < end) await sleep(25); return v; };
  const tabById = id => [...W.allTabs()].find(t => t.linkedBrowser?.browserId === id);
  const isGate = () => String(P.receiveMessage).includes("a device request");
  const doorhanger = (id, which) => tabById(id).ownerDocument.defaultView.PopupNotifications.getNotification(which, tabById(id).linkedBrowser);
  /** A call from a sandbox with Xrays in the tab (or its frame); what the page got, and what got further in the parent. */
  const ask = async (id, call, { activate = false, frame = false } = {}) => {
    const L = { os: 0, sent: [] };
    const os = P.checkOSPermission;
    P.checkOSPermission = function (...a) { L.os++; return os.apply(this, a); };
    P.sendAsyncMessage = function (name, ...a) { L.sent.push(name); return Object.getPrototypeOf(P).sendAsyncMessage.call(this, name, ...a); };
    try {
      let bc = tabById(id).linkedBrowser.browsingContext;
      if (frame) {
        await until(() => bc.children[0]?.currentWindowGlobal?.documentURI?.spec.endsWith("/frame"));
        bc = bc.children[0];
      }
      L.page = await ctx.content(bc, "dev#evalContent", { privileged: true, code: \`
        if (\${activate}) window.document.notifyUserGestureActivation();
        const S = Components.utils.Sandbox(window, { sandboxPrototype: window, wantXrays: true, sameZoneAs: window, sandboxName: "zenius backstops test" });
        try {
          const p = Components.utils.evalInSandbox(\${JSON.stringify(call)}, S);
          return await Promise.race([
            Promise.resolve(p).then(v => String(v), e => "rejected " + (e && e.name)),
            new Promise(r => window.setTimeout(() => r("pending"), 4000)),
          ]);
        } catch (e) {
          return "threw " + (e && e.name);
        }\` });
      await sleep(200);
    } finally {
      P.checkOSPermission = os;
      delete P.sendAsyncMessage;
    }
    return L;
  };
`;
const CALLS = {
  camera: `navigator.mediaDevices.getUserMedia({ video: true }).then(s => { s.getTracks().forEach(t => t.stop()); return "stream"; })`,
  cameraMic: `navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(s => { s.getTracks().forEach(t => t.stop()); return "stream"; })`,
  screen: `navigator.mediaDevices.getDisplayMedia({ video: true }).then(s => { s.getTracks().forEach(t => t.stop()); return "stream"; })`,
  speaker: `navigator.mediaDevices.selectAudioOutput().then(d => "device")`,
  peer: `(async () => { const pc = new RTCPeerConnection(); try { pc.createDataChannel("x"); await pc.createOffer(); return "offer"; } finally { pc.close(); } })()`,
  notify: `Notification.requestPermission()`,
  geo: `new Promise(res => navigator.geolocation.getCurrentPosition(() => res("position"), e => res("error " + e.code), { timeout: 3000 }))`,
  persist: `navigator.storage.persist().then(v => "persist " + v)`,
};
const DENIED = "rejected NotAllowedError";
// The Mac's screen is real: no screen request there, even one the gate denies.
const MAC = process.platform === "darwin";
const FAKE_DEVICES = {
  "media.navigator.streams.fake": true,
  "media.cubeb.force_mock_context": true,
  "media.audio_loopback_dev": "",
  "media.video_loopback_dev": "",
};

/** The site's stored grants, as a site the user uses may have them. */
const grant = (origins, perms, on = true) =>
  h.chrome(
    `for (const o of arg.origins) {
       const pr = Services.scriptSecurityManager.createContentPrincipalFromOrigin(o);
       for (const p of arg.perms) {
         if (arg.on) Services.perms.addFromPrincipal(pr, p, Services.perms.ALLOW_ACTION);
         else Services.perms.removeFromPrincipal(pr, p);
       }
     }
     return true;`,
    { origins, perms, on }
  );

/** A task's page, loaded; its space, label and browserId. */
async function task(prefix, url) {
  const space = await h.space(prefix);
  const { label } = await h.call("pages.new", { space, url });
  const id = await h.chrome(
    `${C}
     const t = ctx.pages.tabFor(ctx.pages.get(ctx.spaces.get(arg.space), arg.label));
     const b = t.linkedBrowser;
     await until(() => b.currentURI.spec === arg.url && !b.webProgress?.isLoadingDocument && b.browsingContext?.currentWindowGlobal);
     return b.browserId;`,
    { space, label, url }
  );
  return { space, label, id };
}

/** The user's own tab, in a Space of theirs; its browserId. */
async function userTab(prefix, url) {
  const space = await h.userSpace(prefix, url);
  return h.chrome(
    `${C}
     const rec = ctx.spaces.get(arg.space);
     const t = await until(() => [...W.allTabs()].find(t => t.getAttribute("zen-workspace-id") === rec.uuid && t.linkedBrowser?.currentURI?.spec === arg.url));
     await until(() => !t.linkedBrowser.webProgress?.isLoadingDocument && t.linkedBrowser.browsingContext?.currentWindowGlobal);
     return t.linkedBrowser.browserId;`,
    { space, url }
  );
}

/** Every prompt type the override may see, Gecko's later ones included. */
const PROMPT_TYPES = ["desktop-notification", "geolocation", "persistent-storage", "midi", "serial", "xr", "speech-recognition-model-download", "storage-access", "local-network", "loopback-network", "a-type-gecko-adds-later"];

/** Mark the tab's page with evidence, as zen-core's flag tool does. */
const flag = (id, detail) => h.chrome(`${C} return E.markEvident(tabById(arg.id).linkedBrowser, "flagged", arg.detail);`, { id, detail });

/** The user's Resume: the agent has the task again. */
const resume = space =>
  h.chrome(`const rec = ctx.spaces.get(arg); if (rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" }); return true;`, space);

/**
 * The page starts the camera and microphone, as the user's call on a site
 * does, and keeps the stream (window.__zoStream). Firefox's prompt is off for
 * the call: a stored grant applies only when the doorhanger shows, which it
 * doesn't in a tab in the background. MediaManager reports a fake device as
 * capturing only with media.navigator.permission.fake, so that one stays on
 * while the stream lives (stopStream clears it).
 */
const startStream = id =>
  h.chrome(
    `${C}
     Services.prefs.setBoolPref("media.navigator.permission.disabled", true);
     Services.prefs.setBoolPref("media.navigator.permission.fake", true);
     try {
       return await ctx.content(tabById(arg).linkedBrowser.browsingContext, "dev#evalContent", { privileged: true, code: \`
         const S = Components.utils.Sandbox(window, { sandboxPrototype: window, wantXrays: true, sameZoneAs: window, sandboxName: "zenius backstops test" });
         const stream = await Components.utils.evalInSandbox("navigator.mediaDevices.getUserMedia({ video: true, audio: true })", S);
         window.wrappedJSObject.__zoStream = Components.utils.waiveXrays(stream);
         return stream.getTracks().map(t => t.readyState).join(" ");\` });
     } finally {
       Services.prefs.clearUserPref("media.navigator.permission.disabled");
     }`,
    id
  );
/** The kept stream's tracks ("live live", "ended ended"), and whether WebRTC still lists a stream in the tab. */
const streamState = id =>
  h.chrome(
    `${C}
     const b = tabById(arg).linkedBrowser;
     const tracks = await ctx.content(b.browsingContext, "dev#evalContent", { privileged: true, code: "return window.wrappedJSObject.__zoStream?.getTracks().map(t => t.readyState).join(' ') ?? null;" });
     return { tracks, listed: webrtcUI.browserHasStreams(b) };`,
    id
  );
const stopStream = id =>
  h.chrome(
    `${C}
     try {
       const t = tabById(arg);
       if (t) await ctx.content(t.linkedBrowser.browsingContext, "dev#evalContent", { privileged: true, code: "window.wrappedJSObject.__zoStream?.getTracks().forEach(t => t.stop()); return true;" });
     } finally {
       Services.prefs.clearUserPref("media.navigator.permission.fake");
     }
     return true;`,
    id
  );

const refusedEvents = async (space, label, kind) =>
  (await h.call("page.events", { space, page: label })).filter(e => e.method === "Zenius.refused" && e.params.kind === kind).map(e => e.params);
const finish = space => h.call("spaces.finish", { space, keep: [] }).catch(() => {});
const state = () => h.chrome(`${C} return { ...B.backstopState(), gate: isGate() };`);

before(async () => {
  await new Promise(resolve => http1.listen(0, "127.0.0.1", resolve));
  port = http1.address().port;
  await new Promise(resolve => http2.listen(0, "127.0.0.1", resolve));
  port2 = http2.address().port;
  h = await setup();
  // Fake cameras and mock speakers exist only when these are in at
  // startup; after() clears them for the files that follow.
  await h.restart(FAKE_DEVICES);
});
after(async () => {
  await h?.chrome(`for (const name of arg) Services.prefs.clearUserPref(name); return true;`, [...Object.keys(FAKE_DEVICES), "media.navigator.permission.fake"]).catch(() => {});
  await grant([site(""), other("")], ["camera", "microphone", "screen", "speaker", "geo", "desktop-notification"], false).catch(() => {});
  await h?.close();
  http1.close();
  http2.close();
});

test("the backstops are in only while a task has pages, and Gecko's own code is back after (I4)", async () => {
  const live = () => h.chrome(`return Services.ppmm.sharedData.get("zenius:taskBrowserIds")?.size ?? 0;`);
  assert.equal(await live(), 0, "no task page is left from another file");
  const off = await state();
  assert.deepEqual([off.on, off.gate, off.peers, off.prompts], [false, false, "off", false]);
  const counts = `const { webrtcUI } = ChromeUtils.importESModule("resource:///modules/webrtcUI.sys.mjs");
    const { Integration } = ChromeUtils.importESModule("resource://gre/modules/Integration.sys.mjs");
    return { blockers: webrtcUI.peerConnectionBlockers.size, overrides: Integration.contentPermission._overrideFns.size };`;
  const before = await h.chrome(counts);
  const { space } = await task("backstops life", site("/life"));
  try {
    const on = await state();
    assert.deepEqual([on.on, on.devices, on.gate, on.peers, on.prompts], [true, "parent", true, "blocker", true]);
    const during = await h.chrome(counts);
    assert.deepEqual(during, { blockers: before.blockers + 1, overrides: before.overrides + 1 });
  } finally {
    await finish(space);
  }
  const after = await state();
  assert.deepEqual([after.on, after.devices, after.gate, after.peers, after.prompts], [false, "off", false, "off", false]);
  assert.deepEqual(await h.chrome(counts), before, "the blocker and the override are gone");
});

test("devices: while the agent drives, a task's page and its frame are refused before any prompt or OS check, a stored grant or not; the user's tab still gets Firefox's prompt", async () => {
  await grant([site(""), other("")], ["camera", "microphone", "screen", "speaker"]);
  const { space, label, id } = await task("backstops devices", site("/framed"));
  try {
    const before = await state();
    const out = await h.chrome(
      `${C}
       const out = {};
       for (const [name, call, opts] of arg.cases) out[name] = await ask(arg.id, call, opts);
       out.doorhanger = !!doorhanger(arg.id, "webRTC-shareDevices");
       return out;`,
      {
        id,
        cases: [
          ["camera", CALLS.camera],
          ["cameraMic", CALLS.cameraMic],
          ...(MAC ? [] : [["screen", CALLS.screen, { activate: true }]]),
          ["speaker", CALLS.speaker, { activate: true }],
          ["frameCamera", CALLS.camera, { frame: true }],
        ],
      }
    );
    // Headless Linux has no screen to share, and may have no speakers to
    // choose: such a request ends in the content process (NotFoundError)
    // and never reaches the parent, so it has nothing to stop. Every one
    // that does reach it is denied there, before any prompt or OS check.
    const reached = [];
    for (const name of ["camera", "cameraMic", ...(MAC ? [] : ["screen"]), "speaker", "frameCamera"]) {
      const noSource = (name === "screen" || name === "speaker") && out[name].page === "rejected NotFoundError";
      assert.deepEqual(out[name], noSource ? { os: 0, sent: [], page: "rejected NotFoundError" } : { os: 0, sent: ["webrtc:Deny"], page: DENIED }, name);
      if (!noSource) {
        reached.push(name);
      }
    }
    assert.ok(reached.includes("camera") && reached.includes("frameCamera"), "the cameras reached the gate");
    assert.equal(out.doorhanger, false, "no doorhanger in the task's tab");
    assert.equal((await state()).refused.devices, before.refused.devices + reached.length);
    const told = await refusedEvents(space, label, "deviceAccess");
    // Once per document and API (pages retry): the frame's document counts apart.
    const expected = ["getUserMedia camera", "getUserMedia camera"];
    if (reached.includes("screen")) {
      expected.push("getDisplayMedia screen");
    }
    if (reached.includes("speaker")) {
      expected.push("selectAudioOutput speakers");
    }
    assert.deepEqual(told.map(e => `${e.api} ${e.asked}`).sort(), expected.sort(), JSON.stringify(told));
  } finally {
    await finish(space);
  }
  // The user's own tab, while a task is live: the request reaches prompt(),
  // whose doorhanger waits, as the tab is in the background.
  const keep = await task("backstops devices keep", site("/keep"));
  try {
    const mine = await userTab("backstops devices user", site("/mine"));
    const out = await h.chrome(
      `${C}
       const before = B.backstopState().refused.devices;
       const L = await ask(arg.id, arg.call);
       const n = await until(() => doorhanger(arg.id, "webRTC-shareDevices"), 3000);
       if (n) n.owner.remove(n);
       return { ...L, doorhanger: !!n, refused: B.backstopState().refused.devices - before };`,
      { id: mine, call: CALLS.camera }
    );
    assert.deepEqual(out, { os: 0, sent: [], page: "pending", doorhanger: true, refused: 0 });
  } finally {
    await finish(keep.space);
  }
});

test("peer connections: while the agent drives, a task's page and its frame are refused before ICE; the user's tab makes its offer", async () => {
  const { space, label, id } = await task("backstops peers", site("/framed"));
  try {
    const mine = await userTab("backstops peers user", site("/mine-peer"));
    const out = await h.chrome(
      `${C}
       return { task: await ask(arg.id, arg.call), frame: await ask(arg.id, arg.call, { frame: true }), user: await ask(arg.mine, arg.call) };`,
      { id, mine, call: CALLS.peer }
    );
    assert.deepEqual(out.task, { os: 0, sent: ["rtcpeer:Deny"], page: DENIED });
    assert.deepEqual(out.frame, { os: 0, sent: ["rtcpeer:Deny"], page: DENIED });
    assert.deepEqual(out.user, { os: 0, sent: ["rtcpeer:Allow"], page: "offer" });
    assert.equal((await refusedEvents(space, label, "localNetwork")).length, 2, "told once per document: the page's and its frame's");
  } finally {
    await finish(space);
  }
});

test("prompts: a task's page's go on to Firefox's own, while the agent drives (zen-ux hands the task to the user) and during the hold; the user's tab is untouched", async () => {
  const { space, label, id } = await task("backstops prompts", site("/prompts"));
  try {
    const mine = await userTab("backstops prompts user", site("/mine-prompt"));
    const rules = await h.chrome(
      `${C}
       const browser = tabById(arg.id).linkedBrowser;
       const user = tabById(arg.mine).linkedBrowser;
       const out = {};
       for (const type of arg.types) out[type] = B.promptRule(type, browser) + "/" + B.promptRule(type, user);
       return out;`,
      { id, mine, types: PROMPT_TYPES }
    );
    assert.deepEqual(rules, Object.fromEntries(PROMPT_TYPES.map(type => [type, "pass/pass"])));
    // During the hold, a real one reaches PermissionUI, where the user answers it.
    await h.call("spaces.handOff", { space });
    const held = await h.chrome(
      `${C}
       const s = B.backstopState();
       const asked = ask(arg.id, arg.notify, { activate: true });
       await until(() => B.backstopState().kept > s.kept, 3000);
       const n = doorhanger(arg.id, "web-notifications");
       if (n) n.owner.remove(n);
       await asked;
       return { kept: B.backstopState().kept - s.kept, cancelled: B.backstopState().refused.prompts - s.refused.prompts };`,
      { id, notify: CALLS.notify }
    );
    assert.deepEqual(held, { kept: 1, cancelled: 0 });
    await resume(space);
    // For real: a page Gecko takes for public reaches loopback, and
    // Firefox's own local-network prompt shows in the task's tab.
    // A document's address space is fixed when it loads: the override, then a load.
    await h.chrome(`Services.prefs.setStringPref("network.lna.address_space.public.override", "127.0.0.1:" + arg); return true;`, port);
    let lna;
    try {
      await h.call("page.goto", { space, page: label, url: site("/prompts?lna") });
      lna = await h.chrome(
        `${C}
         const kept = B.backstopState().kept;
         const asked = ask(arg.id, "fetch(" + JSON.stringify(arg.target) + ").then(r => r.text())");
         const n = await until(() => doorhanger(arg.id, "loopback-network"), 5000);
         if (n) n.owner.remove(n, true);
         await asked;
         return { shown: !!n, kept: B.backstopState().kept - kept };`,
        { id, target: `http://127.0.0.1:${port2}/lna?${Date.now()}` }
      );
    } finally {
      await h.chrome(
        `Services.prefs.clearUserPref("network.lna.address_space.public.override");
         const rec = ctx.spaces.get(arg);
         if (rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" });
         return true;`,
        space
      );
    }
    assert.deepEqual(lna, { shown: true, kept: 1 });
  } finally {
    await finish(space);
  }
});

test("prompts on evidence: every type is cancelled before PermissionUI shows it, while the agent drives and during the hold, a stored grant or not; the user's tab is untouched", async () => {
  await grant([site("")], ["geo"]);
  const { space, label, id } = await task("backstops prompts evidence", site("/prompts-evident"));
  try {
    const mine = await userTab("backstops prompts evidence user", site("/mine-evident"));
    assert.equal(await flag(id, "a test's flag"), true);
    const before = await state();
    const out = await h.chrome(
      `${C}
       const out = {};
       for (const [name, call] of Object.entries(arg.calls)) out[name] = (await ask(arg.id, call, { activate: true })).page;
       out.doorhangers = ["web-notifications", "geolocation", "persistent-storage"].filter(w => doorhanger(arg.id, w));
       const browser = tabById(arg.id).linkedBrowser;
       const user = tabById(arg.mine).linkedBrowser;
       out.rules = {};
       for (const type of arg.types) out.rules[type] = B.promptRule(type, browser) + "/" + B.promptRule(type, user);
       // The user's tab gets Firefox's own prompt.
       const asked = ask(arg.mine, arg.calls.notify, { activate: true });
       const n = await until(() => doorhanger(arg.mine, "web-notifications"), 3000);
       out.userDoorhanger = !!n;
       if (n) n.owner.remove(n);
       await asked;
       return out;`,
      { id, mine, types: PROMPT_TYPES, calls: { notify: CALLS.notify, geo: CALLS.geo, persist: CALLS.persist } }
    );
    assert.deepEqual([out.notify, out.geo, out.persist], ["default", "error 1", "persist false"], JSON.stringify(out));
    assert.deepEqual(out.doorhangers, [], "nothing showed in the task's tab");
    assert.equal(out.userDoorhanger, true, "the user's tab got Firefox's prompt");
    assert.deepEqual(out.rules, Object.fromEntries(PROMPT_TYPES.map(type => [type, "cancel/pass"])));
    assert.equal((await state()).refused.prompts, before.refused.prompts + 3);
    const told = await refusedEvents(space, label, "promptDenied");
    assert.deepEqual(told.map(e => e.asked).sort(), ["location", "notifications", "persistent storage"]);
    assert.match(
      told.find(e => e.asked === "location").message,
      /^http:\/\/127\.0\.0\.1:\d+ asked for your location\. The page shows evidence of danger \(flagged: a test's flag\), so zenius cancelled the prompt without asking the user\. If the task needs a place, type it/
    );
    // The user's hold changes nothing on evidence.
    await h.call("spaces.handOff", { space });
    const held = await h.chrome(
      `${C}
       const s = B.backstopState().refused.prompts;
       const page = (await ask(arg.id, arg.notify, { activate: true })).page;
       return { page, cancelled: B.backstopState().refused.prompts - s };`,
      { id, notify: CALLS.notify }
    );
    assert.deepEqual(held, { page: "default", cancelled: 1 });
  } finally {
    await resume(space).catch(() => {});
    await finish(space);
    await grant([site("")], ["geo"], false);
  }
});

test("a check that throws refuses, the user's own tab's requests included, while a task is live", async () => {
  const { space } = await task("backstops errors", site("/errors"));
  try {
    const mine = await userTab("backstops errors user", site("/mine-errors"));
    const out = await h.chrome(
      `${C}
       const errors = B.backstopState().errors;
       ctx.service.isTaskBrowserId = () => { throw new Error("a test's broken check"); };
       try {
         const out = {};
         for (const [name, call] of Object.entries(arg.calls)) out[name] = (await ask(arg.mine, call, { activate: true })).page;
         out.notifyDoorhanger = !!doorhanger(arg.mine, "web-notifications");
         out.errors = B.backstopState().errors - errors;
         return out;
       } finally {
         delete ctx.service.isTaskBrowserId;
       }`,
      { mine, calls: { camera: CALLS.camera, peer: CALLS.peer, notify: CALLS.notify } }
    );
    assert.deepEqual(out, { camera: DENIED, peer: DENIED, notify: "default", notifyDoorhanger: false, errors: 3 });
  } finally {
    await finish(space);
  }
});

test("fail closed: with the WebRTCParent patch refused at its startup check, a task's page refuses devices in its content process; the user's tab doesn't", async () => {
  await grant([site("")], ["camera"]);
  const { space, id } = await task("backstops fallback", site("/fallback"));
  try {
    const mine = await userTab("backstops fallback user", site("/mine-fallback"));
    const out = await h.chrome(
      `${C}
       B.refusePatchForTest(ctx.service, true);
       try {
         const s = B.backstopState();
         const out = { devices: s.devices, problem: s.devicesProblem, gate: isGate() };
         out.task = (await ask(arg.id, arg.call)).page;
         const L = ask(arg.mine, arg.call);
         const n = await until(() => doorhanger(arg.mine, "webRTC-shareDevices"), 3000);
         out.userDoorhanger = !!n;
         // WebRTCChild still sent the parent the task's request, before the
         // user's. zen-ux's watcher removes that doorhanger in a task's page
         // at once, as a deny (its DENIED set). So by the time
         // the user's shows, none waits in the task's tab, and the task is
         // still the agent's.
         out.taskDoorhanger = !!doorhanger(arg.id, "webRTC-shareDevices");
         out.ownership = ctx.spaces.get(arg.space).ownership;
         if (n) n.owner.remove(n);
         await L;
         return out;
       } finally {
         B.refusePatchForTest(ctx.service, false);
       }`,
      { id, mine, space, call: CALLS.camera }
    );
    assert.deepEqual(out, { devices: "content", problem: "refused for a test", gate: false, task: DENIED, userDoorhanger: true, taskDoorhanger: false, ownership: "agent" });
    assert.equal((await state()).devices, "parent", "the patch is back");
  } finally {
    await finish(space);
    await grant([site("")], ["camera"], false);
  }
});

test("a held page: the camera goes to the user's own prompt, the page makes its peer connection, and the user's own passkey still works (a virtual authenticator)", async () => {
  await grant([other("")], ["camera"]);
  const { space, id } = await task("backstops held", other("/held"));
  const view = await h.call("dev.viewState");
  try {
    await h.call("spaces.handOff", { space });
    const out = await h.chrome(
      `${C}
       const out = { held: ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/hold.sys.mjs").holdOf(tabById(arg.id).linkedBrowser) !== undefined };
       // The request goes on to Firefox's own prompt (its show()), where the
       // user answers: zen-ux's watcher decides what a prompt in a task's
       // page does from there. The tab is in the background, so the stored
       // grant applies only once the doorhanger shows.
       const devices = B.backstopState().refused.devices;
       const PN = tabById(arg.id).ownerDocument.defaultView.PopupNotifications;
       const show = PN.show;
       const own = Object.hasOwn(PN, "show");
       const shown = [];
       PN.show = function (browser, id, ...rest) {
         if (browser === tabById(arg.id).linkedBrowser) shown.push(id);
         return show.call(this, browser, id, ...rest);
       };
       let camera;
       try {
         camera = await ask(arg.id, arg.camera);
       } finally {
         if (own) PN.show = show;
         else delete PN.show;
       }
       const n = doorhanger(arg.id, "webRTC-shareDevices");
       if (n) n.owner.remove(n);
       out.camera = { os: camera.os, shown, refused: B.backstopState().refused.devices - devices };
       out.peer = await ask(arg.id, arg.peer);
       const ws = Cc["@mozilla.org/webauthn/service;1"].getService(Ci.nsIWebAuthnService);
       Services.prefs.setBoolPref("security.webauth.webauthn_enable_softtoken", true);
       Services.prefs.setBoolPref("security.webauth.webauthn_enable_usbtoken", false);
       const auth = ws.addVirtualAuthenticator("ctap2", "internal", true, true, true, true);
       const userWs = gZenWorkspaces.activeWorkspace;
       const Pages = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
       const tab = tabById(arg.id);
       const prompts = B.backstopState().refused.prompts;
       try {
         // The user opens the Space and uses the page's own sign-in.
         Pages.landOn(tab);
         await gZenWorkspaces.changeWorkspaceWithID(ctx.spaces.get(arg.space).uuid);
         await until(() => gBrowser.selectedTab === tab);
         // WebAuthn answers only in the active tab of the active window.
         win.focus();
         tab.linkedBrowser.focus();
         await until(() => tab.linkedBrowser.browsingContext?.isActive && Services.focus.activeWindow === win);
         const run = code => ctx.content(tab.linkedBrowser.browsingContext, "dev#evalContent", { privileged: true, code: \`
           window.document.notifyUserGestureActivation();
           const s = document.createElement("script");
           s.textContent = \${JSON.stringify(code)};
           document.documentElement.append(s);
           s.remove();
           const end = Date.now() + 8000;
           while (window.wrappedJSObject.__passkey === undefined && Date.now() < end) await new Promise(r => window.setTimeout(r, 50));
           const v = window.wrappedJSObject.__passkey;
           window.wrappedJSObject.__passkey = undefined;
           return v ?? "pending";\` });
         out.create = await run(arg.create);
         out.get = await run(arg.get);
       } finally {
         if (gZenWorkspaces.activeWorkspace !== userWs) await gZenWorkspaces.changeWorkspaceWithID(userWs);
         ws.removeVirtualAuthenticator(auth);
         Services.prefs.clearUserPref("security.webauth.webauthn_enable_softtoken");
         Services.prefs.clearUserPref("security.webauth.webauthn_enable_usbtoken");
       }
       out.on = B.backstopState().on;
       out.promptsRefused = B.backstopState().refused.prompts - prompts;
       return out;`,
      {
        id,
        space,
        camera: CALLS.camera,
        peer: CALLS.peer,
        create: `navigator.credentials.create({ publicKey: { rp: { id: "localhost", name: "zenius test" }, user: { id: new Uint8Array([1, 2, 3]), name: "user", displayName: "User" }, challenge: new Uint8Array(32), pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { residentKey: "required", userVerification: "required" }, timeout: 8000 } }).then(c => { window.__passkey = "created " + c.type; }, e => { window.__passkey = "create rejected " + e.name; });`,
        get: `navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: "localhost", userVerification: "required", timeout: 8000 } }).then(c => { window.__passkey = "signed in " + (c.response.signature.byteLength > 0); }, e => { window.__passkey = "get rejected " + e.name; });`,
      }
    );
    assert.deepEqual(out, {
      held: true,
      camera: { os: 0, shown: ["webRTC-shareDevices"], refused: 0 },
      peer: { os: 0, sent: ["rtcpeer:Allow"], page: "offer" },
      create: "created public-key",
      get: "signed in true",
      on: true,
      promptsRefused: 0,
    });
    assert.deepEqual(await h.call("dev.viewState"), view, "the user's view is as it was");
  } finally {
    await resume(space).catch(() => {});
    await finish(space);
    await grant([other("")], ["camera"], false);
  }
});

test("a stream the user starts in a held page stops when the agent has the page again, the agent hears of it, and the site's stored grants stay", async () => {
  await grant([other("")], ["camera", "microphone"]);
  const { space, label, id } = await task("backstops stream", other("/stream"));
  try {
    await h.call("spaces.handOff", { space });
    assert.equal(await startStream(id), "live live");
    assert.deepEqual(await streamState(id), { tracks: "live live", listed: true });
    await resume(space);
    // The tracks end in content, and webrtcUI drops the stream when content
    // reports it: a read between the two sees one done and not the other
    // (a flake zen-core once saw), so wait for both.
    const end = Date.now() + 5000;
    let now;
    while (!((now = await streamState(id)).tracks === "ended ended" && !now.listed) && Date.now() < end) {
      await new Promise(r => setTimeout(r, 50));
    }
    assert.deepEqual(now, { tracks: "ended ended", listed: false }, "the stream stopped");
    const told = await refusedEvents(space, label, "deviceAccess");
    assert.equal(told.length, 1, JSON.stringify(told));
    assert.match(told[0].message, /^zenius stopped the camera and microphone the page used while the user held it: the agent never uses the user's devices\./);
    assert.equal(told[0].asked, "camera microphone");
    const stored = await h.chrome(
      `const pr = Services.scriptSecurityManager.createContentPrincipalFromOrigin(arg);
       return ["camera", "microphone"].map(p => Services.perms.testExactPermissionFromPrincipal(pr, p) === Services.perms.ALLOW_ACTION);`,
      other("")
    );
    assert.deepEqual(stored, [true, true], "the site's grants stay");
    // The agent drives: a new request is refused before any prompt again.
    const again = await h.chrome(`${C} return ask(arg.id, arg.call);`, { id, call: CALLS.camera });
    assert.deepEqual(again, { os: 0, sent: ["webrtc:Deny"], page: DENIED });
  } finally {
    await stopStream(id).catch(() => {});
    await resume(space).catch(() => {});
    await finish(space);
    await grant([other("")], ["camera", "microphone"], false);
  }
});

test("a stream the user starts during the hold goes on when the task ends: the tab they keep is theirs", async () => {
  const { space, id } = await task("backstops stream kept", other("/stream-kept"));
  try {
    await h.call("spaces.handOff", { space });
    assert.equal(await startStream(id), "live live");
    // The user's Stop in the panel.
    await h.chrome(`const rec = ctx.spaces.get(arg); ctx.spaces.setOwnership(rec, "user", { source: "user" }); return true;`, space);
    await new Promise(r => setTimeout(r, 1000));
    assert.deepEqual(await streamState(id), { tracks: "live live", listed: true });
  } finally {
    await stopStream(id).catch(() => {});
    await h.chrome(`${C} const t = tabById(arg); if (t) win.gBrowser.removeTab(t); return true;`, id).catch(() => {});
    await finish(space);
  }
});
