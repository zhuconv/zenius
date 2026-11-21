// The parent backstops (modules/backstops.sys.mjs; zen-snapshot's
// docs/research/parent-backstops.md, the manager's list of 2026-11-20). Each
// request comes from a sandbox with the page's principal and Xrays, made by
// privileged code in the tab: it reaches the native API past zen-observe's
// page refusals, as the agent's world would if its mirror of them failed.
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
  await h?.chrome(`for (const name of arg) Services.prefs.clearUserPref(name); return true;`, Object.keys(FAKE_DEVICES)).catch(() => {});
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

test("devices: a task's page and its frame are refused before any prompt or OS check, a stored grant or not; the user's tab still gets Firefox's prompt", async () => {
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

test("peer connections: a task's page and its frame are refused before ICE; the user's tab makes its offer", async () => {
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

test("prompts: a task's page's are cancelled before PermissionUI shows them, but the local-network ones and storage access go on to Firefox's own; the user's tab is untouched", async () => {
  await grant([site("")], ["geo"]);
  const { space, label, id } = await task("backstops prompts", site("/prompts"));
  try {
    const mine = await userTab("backstops prompts user", site("/mine-prompt"));
    const before = await state();
    const out = await h.chrome(
      `${C}
       const out = {};
       for (const [name, call] of Object.entries(arg.calls)) out[name] = (await ask(arg.id, call, { activate: true })).page;
       out.doorhangers = ["web-notifications", "geolocation", "persistent-storage"].filter(w => doorhanger(arg.id, w));
       const browser = tabById(arg.id).linkedBrowser;
       const user = tabById(arg.mine).linkedBrowser;
       out.rules = {};
       for (const type of ["desktop-notification", "geolocation", "persistent-storage", "midi", "serial", "xr", "speech-recognition-model-download", "storage-access", "local-network", "loopback-network", "a-type-gecko-adds-later"]) {
         out.rules[type] = B.promptRule(type, browser) + "/" + B.promptRule(type, user);
       }
       // The user's tab gets Firefox's own prompt.
       const L = ask(arg.mine, arg.calls.notify, { activate: true });
       const n = await until(() => doorhanger(arg.mine, "web-notifications"), 3000);
       out.userDoorhanger = !!n;
       if (n) n.owner.remove(n);
       await L;
       return out;`,
      { id, mine, calls: { notify: CALLS.notify, geo: CALLS.geo, persist: CALLS.persist } }
    );
    assert.deepEqual([out.notify, out.geo, out.persist], ["default", "error 1", "persist false"], JSON.stringify(out));
    assert.deepEqual(out.doorhangers, [], "nothing showed in the task's tab");
    assert.equal(out.userDoorhanger, true, "the user's tab got Firefox's prompt");
    const cancel = "cancel/pass";
    assert.deepEqual(out.rules, {
      "desktop-notification": cancel,
      geolocation: cancel,
      "persistent-storage": cancel,
      midi: cancel,
      serial: cancel,
      xr: cancel,
      "speech-recognition-model-download": cancel,
      "storage-access": "pass/pass",
      "local-network": "pass/pass",
      "loopback-network": "pass/pass",
      "a-type-gecko-adds-later": cancel,
    });
    assert.equal((await state()).refused.prompts, before.refused.prompts + 3);
    const told = await refusedEvents(space, label, "promptDenied");
    assert.deepEqual(told.map(e => e.asked).sort(), ["location", "notifications", "persistent storage"]);
    assert.match(told.find(e => e.asked === "location").message, /^http:\/\/127\.0\.0\.1:\d+ asked for your location, which a task's pages never get, so the prompt was cancelled without asking the user\. If the task needs a place, type it/);
    // A kept type for real: a page Gecko takes for public reaches loopback,
    // and Firefox's own local-network prompt shows in the task's tab.
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
         // at once, as a deny (its DENIED set, since 7ef325e). So by the time
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

test("a held page: devices stay refused, and the user's own passkey still works (a virtual authenticator)", async () => {
  await grant([other("")], ["camera"]);
  const { space, label, id } = await task("backstops held", other("/held"));
  const view = await h.call("dev.viewState");
  try {
    await h.call("spaces.handOff", { space });
    const out = await h.chrome(
      `${C}
       const out = { held: ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/hold.sys.mjs").holdOf(tabById(arg.id).linkedBrowser) !== undefined };
       out.camera = (await ask(arg.id, arg.camera)).page;
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
        create: `navigator.credentials.create({ publicKey: { rp: { id: "localhost", name: "zenius test" }, user: { id: new Uint8Array([1, 2, 3]), name: "user", displayName: "User" }, challenge: new Uint8Array(32), pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { residentKey: "required", userVerification: "required" }, timeout: 8000 } }).then(c => { window.__passkey = "created " + c.type; }, e => { window.__passkey = "create rejected " + e.name; });`,
        get: `navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: "localhost", userVerification: "required", timeout: 8000 } }).then(c => { window.__passkey = "signed in " + (c.response.signature.byteLength > 0); }, e => { window.__passkey = "get rejected " + e.name; });`,
      }
    );
    assert.deepEqual(out, { held: true, camera: DENIED, create: "created public-key", get: "signed in true", on: true, promptsRefused: 0 });
    assert.deepEqual(await h.call("dev.viewState"), view, "the user's view is as it was");
  } finally {
    await h.chrome(`const rec = ctx.spaces.get(arg); if (rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" }); return true;`, space).catch(() => {});
    await finish(space);
    await grant([other("")], ["camera"], false);
  }
});
