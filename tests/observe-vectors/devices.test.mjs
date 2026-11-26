// The user's devices and location in an agent task's pages
// (content/refusals.sys.mjs). While the agent
// drives a task's page, getUserMedia, mozGetUserMedia, getDisplayMedia,
// selectAudioOutput and speech recognition get the answer a page gets when
// the user says no, and enumerateDevices() lists none, in every document of
// the page (fresh frames, cross-site frames, a popup from its first
// document): the agent never uses the user's devices. Location and MIDI go
// on to the prompt layer, as on any site. On evidence of danger
// (content/evidence.sys.mjs) every one of them is refused, the user's hold
// included. During the hold, without evidence, the page asks as a tab of the
// user's does. No refused request leaves the page.
//
// Two counters, for the file's duration:
// - every WebRTC request MediaManager sends the parent, counted and denied
//   at once in WebRTCParent, before its prompt and its OS check;
// - every request that reaches the geolocation provider (its watch() calls):
//   the network provider, pointed at the fixture. On Linux the fixture's
//   site may use location, so a request that got past the page would reach
//   it.
// Fake devices keep a leak off the real camera and microphone. The test
// that calls the real APIs on purpose, in a tab of the user's and in a page
// the task kept, shows the counters count. It skips on macOS, where it
// would be Zen.app asking the system.
//
// Then notifications, WebRTC and the local network, on the fixture's
// /vectors-net: notifications are refused in a task's pages on evidence, and
// in their workers for the task's whole life; while the agent drives, new
// RTCPeerConnection() throws, and WebRTC's own list of the browser's peer
// connections shows none was made; requests to
// private and link-local addresses and .local names are cancelled in the
// parent before they look anything up. lan.local and lan-ok.local resolve
// to 127.0.0.1 here (network.dns.localDomains), so a request the refusal
// missed reaches the fixture, which counts it; lan-ok.local is on the
// user's list (zenius.agentTabs.allowPrivateNetworks). Every other request
// goes to a recorder on loopback, the profile's proxy with no failover, so
// a private literal the refusal missed lands there and fails the test,
// never reaching a real network (the preflight checks the routing before
// any private address is tried).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setup } from "../observe/lib.mjs";
import { NETWORK_VECTORS, startVectorServer, startRecorder, recorderProxyPrefs, privateRequests } from "../observe/vectors/fixture.mjs";

const MAC = process.platform === "darwin";

let env;
let vectors;
let recorder;
let savedPrefs = null;

const SET_PREFS = `
  const saved = {};
  for (const [name, value] of Object.entries(arg)) {
    const type = typeof value;
    saved[name] = !Services.prefs.prefHasUserValue(name) ? null
      : type === "boolean" ? Services.prefs.getBoolPref(name)
      : type === "number" ? Services.prefs.getIntPref(name)
      : Services.prefs.getStringPref(name);
    if (type === "boolean") Services.prefs.setBoolPref(name, value);
    else if (type === "number") Services.prefs.setIntPref(name, value);
    else Services.prefs.setStringPref(name, value);
  }
  return saved;`;
const RESTORE_PREFS = `
  for (const [name, value] of Object.entries(arg)) {
    if (value === null) Services.prefs.clearUserPref(name);
    else if (typeof value === "boolean") Services.prefs.setBoolPref(name, value);
    else if (typeof value === "number") Services.prefs.setIntPref(name, value);
    else Services.prefs.setStringPref(name, value);
  }
  return true;`;

/** How the profile's proxy settings send each URL: "direct", or {type, host, port, failover}. */
const RESOLVE_PROXY = `
  const pps = Cc["@mozilla.org/network/protocol-proxy-service;1"].getService(Ci.nsIProtocolProxyService);
  const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
  const one = spec => new Promise(resolve => {
    const channel = NetUtil.newChannel({ uri: spec, loadUsingSystemPrincipal: true });
    pps.asyncResolve(channel, 0, { onProxyAvailable(_req, _ch, pi) { resolve(pi ? { type: pi.type, host: pi.host, port: pi.port, failover: !!pi.failoverProxy } : "direct"); } });
  });
  const out = {};
  for (const spec of arg) out[spec] = await one(spec);
  return out;`;

/**
 * The rule: the private and link-local literals the
 * vectors use must never reach a real network, least of all the user's LAN
 * on the Mac, where a miss could also raise macOS's Local Network alert.
 * So before any of them, check that every form goes to the recorder with no
 * failover and that loopback and the .local names go direct; then that a
 * control request to a documentation address, which the refusal lets
 * through, lands on the recorder.
 */
async function proxyPreflight() {
  const port = new URL(vectors.base).port;
  const proxied = [
    "http://172.31.254.1/",
    "http://[::ffff:172.31.254.1]/",
    "http://0xac1ffe01/",
    "http://192.168.254.254./",
    "http://[fd00::1]/",
    "http://169.254.169.254/",
    "https://172.31.254.1/",
    "http://192.0.2.1/",
  ];
  const direct = [`${vectors.base}/`, `http://localhost:${port}/`, `http://lan.local:${port}/`, `http://lan-ok.local:${port}/`];
  const resolved = await env.chrome(RESOLVE_PROXY, [...proxied, ...direct]);
  for (const spec of proxied) {
    // An https URL goes through the same HTTP proxy, by CONNECT.
    assert.deepEqual(resolved[spec], { type: "http", host: "127.0.0.1", port: recorder.port, failover: false }, spec);
  }
  for (const spec of direct) {
    assert.equal(resolved[spec], "direct", spec);
  }
  const before = recorder.requests.length;
  const control = await env.chrome(`try { return "status " + (await win.fetch(arg)).status; } catch (e) { return e.name; }`, "http://192.0.2.1/zenius-control");
  assert.equal(control, "status 200");
  assert.ok(
    recorder.requests.slice(before).some(r => r.target === "http://192.0.2.1/zenius-control"),
    `the control request didn't land on the recorder: ${JSON.stringify(recorder.requests.slice(before))}`
  );
}

const WEBRTC = `const proto = ChromeUtils.importESModule("resource:///actors/WebRTCParent.sys.mjs").WebRTCParent.prototype;`;
/** Count each request (by its tab's browserId) and deny it before WebRTCParent's prompt and OS check. */
const COUNT_WEBRTC = `${WEBRTC}
  if (!Object.hasOwn(proto, "zeniusTestRequests")) {
    const receive = proto.receiveMessage;
    proto.zeniusTestReceive = receive;
    proto.zeniusTestRequests = [];
    proto.receiveMessage = function (message) {
      if (message.name !== "webrtc:Request") return receive.call(this, message);
      let browserId = null;
      try { browserId = this.browsingContext.top.browserId; } catch {}
      proto.zeniusTestRequests.push(browserId);
      this.denyRequest(message.data);
      return undefined;
    };
  }
  return true;`;
const UNCOUNT_WEBRTC = `${WEBRTC}
  if (Object.hasOwn(proto, "zeniusTestRequests")) {
    proto.receiveMessage = proto.zeniusTestReceive;
    delete proto.zeniusTestReceive;
    delete proto.zeniusTestRequests;
  }
  return true;`;
const PROVIDER = `const proto = ChromeUtils.importESModule("moz-src:///dom/system/NetworkGeolocationProvider.sys.mjs").NetworkGeolocationProvider.prototype;`;
/** The parent's geolocation service calls watch() for each request it starts the provider for. */
const COUNT_PROVIDER = `${PROVIDER}
  if (!Object.hasOwn(proto, "zeniusTestWatches")) {
    const watch = proto.watch;
    proto.zeniusTestWatch = watch;
    proto.zeniusTestWatches = 0;
    proto.watch = function (...args) {
      proto.zeniusTestWatches++;
      return watch.apply(this, args);
    };
  }
  return true;`;
const UNCOUNT_PROVIDER = `${PROVIDER}
  if (Object.hasOwn(proto, "zeniusTestWatches")) {
    proto.watch = proto.zeniusTestWatch;
    delete proto.zeniusTestWatch;
    delete proto.zeniusTestWatches;
  }
  return true;`;
const GEO = (verb, origin) =>
  env.chrome(
    `const p = Services.scriptSecurityManager.createContentPrincipalFromOrigin(arg);
     if (${JSON.stringify(verb)} === "allow") Services.perms.addFromPrincipal(p, "geo", Services.perms.ALLOW_ACTION, Services.perms.EXPIRE_SESSION);
     else Services.perms.removeFromPrincipal(p, "geo");
     return true;`,
    origin
  );

before(async () => {
  env = await setup();
  vectors = await startVectorServer();
  recorder = await startRecorder();
  // The names the dev profile maps to this machine stay mapped, with this file's added.
  const localDomains = await env.chrome(`return Services.prefs.getStringPref("network.dns.localDomains", "");`);
  savedPrefs = await env.chrome(SET_PREFS, {
    ...recorderProxyPrefs(recorder.port),
    "media.navigator.streams.fake": true,
    // So the device list answers in a tab of the user's in the background.
    "media.devices.unfocused.enabled": true,
    // Read when the parent's geolocation service starts: before any other
    // test of this instance uses location.
    "geo.provider.testing": true,
    "geo.provider.network.url": `${vectors.base}/geo-provider`,
    "geo.provider.network.scan": false,
    "geo.provider.use_corelocation": false,
    "geo.provider.use_geoclue": false,
    "geo.provider.use_gpsd": false,
    "network.dns.localDomains": [localDomains, "lan.local", "lan-ok.local"].filter(Boolean).join(","),
    "zenius.agentTabs.allowPrivateNetworks": "lan-ok.local",
    // Code planted before a hand-off stays in the page: these tests check the refusals it meets during the hold (the core's glue).
    "zenius.handoff.quietReload": false,
  });
  await proxyPreflight();
  await env.chrome(COUNT_WEBRTC);
  await env.chrome(COUNT_PROVIDER);
  if (!MAC) {
    await GEO("allow", vectors.base);
  }
});
after(async () => {
  if (vectors) {
    await GEO("remove", vectors.base).catch(() => {});
  }
  await env?.chrome(UNCOUNT_WEBRTC).catch(() => {});
  await env?.chrome(UNCOUNT_PROVIDER).catch(() => {});
  if (savedPrefs) {
    await env.chrome(RESTORE_PREFS, savedPrefs).catch(() => {});
  }
  vectors?.server.close();
  recorder?.server.close();
  await env?.close();
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
// The fixture's vectors are the page's own code (window.__vectors), and keep
// their outcomes in the page (window.__vectorResults): the agent's code,
// which runs in its isolated world, sees neither, so these go through
// dev.evalContent, in the page's own JavaScript.
const results = (page, id) =>
  env.call("dev.evalContent", { ...page.P, code: `JSON.stringify(window.__vectorResults[${JSON.stringify(id)}] ?? null)` }).then(JSON.parse);
/** Run the page's vectors after an agent call, as the agent's code once started them in the page itself. */
const runVectors = async (page, code) => {
  await page.evaluate("1");
  return env.call("dev.evalContent", { ...page.P, code });
};
const refusedEvents = async page => (await page.call("page.events")).filter(e => e.method === "Zenius.refused").map(e => e.params);
const webrtcRequests = () => env.chrome(`${WEBRTC} return proto.zeniusTestRequests.slice();`);
const counters = async () => ({ webrtc: (await webrtcRequests()).length, geo: await env.chrome(`${PROVIDER} return proto.zeniusTestWatches;`) });

async function until(what, fn, ms = 8000) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    last = await fn();
    if (last) {
      return last;
    }
  }
  throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
}

/** Each vector's outcomes once it has as many as `counts` says. */
async function outcomes(page, counts) {
  const out = {};
  for (const [id, count] of Object.entries(counts)) {
    out[id] = await until(id, async () => {
      const r = await results(page, id);
      return r?.length >= count ? r : null;
    });
  }
  return out;
}
const counts = expected => Object.fromEntries(Object.entries(expected).map(([id, r]) => [id, r.length]));

/** The API a refusal names, and which document reported it. */
const apiOf = e => / \(([\w.]+)\)\. The (?:agent|page) /.exec(e.message)?.[1] ?? e.message;
const whereOf = e =>
  e.url === `${vectors.base}/vectors` || e.url === `${vectors.base}/vectors-net` ? "page" : e.url === "about:blank" ? "frame" : e.url.startsWith(vectors.crossBase) ? "cross" : e.url;

// Zen on the Mac holds the user's camera, microphone and screen-recording
// grants, so a refusal that failed there
// would reach the real device with no macOS prompt. Only fake devices run
// there. The camera and microphone are fake (media.navigator.streams.fake),
// but Firefox has no fake screen, speaker picker or MIDI device, and speech
// recognition's microphone isn't confirmed fake on the Mac. So on the Mac
// those vectors aren't tried at all, and the Linux server runs them.
const NOT_ON_MAC = {
  screen: ["NotAllowedError"],
  "select-audio-output": ["NotAllowedError"],
  midi: ["NotAllowedError"],
  "speech-recognition": ["error not-allowed", "end"],
};
const ALL = {
  camera: ["NotAllowedError"],
  microphone: ["NotAllowedError"],
  "moz-get-user-media": ["NotAllowedError"],
  "enumerate-devices": ["devices 0"],
  geolocation: ["error 1"],
  "geolocation-watch": ["watch number", "error 1"],
  "devices-fresh-frame": ["NotAllowedError", "NotAllowedError", "error 1"],
  ...(MAC
    ? { "devices-cross-frame-no-midi": ["NotAllowedError", "error 1"] }
    : { ...NOT_ON_MAC, "devices-cross-frame": ["NotAllowedError", "error 1", "NotAllowedError"] }),
};

/** The devices alone: while the agent drives, these are refused; location and MIDI go on. */
const MEDIA = {
  camera: ["NotAllowedError"],
  microphone: ["NotAllowedError"],
  "moz-get-user-media": ["NotAllowedError"],
  "enumerate-devices": ["devices 0"],
  "media-fresh-frame": ["NotAllowedError", "NotAllowedError"],
  "media-cross-frame": ["NotAllowedError"],
  ...(MAC ? {} : { screen: ["NotAllowedError"], "select-audio-output": ["NotAllowedError"], "speech-recognition": ["error not-allowed", "end"] }),
};
// The UI's card reads what was asked from these, not from the message.
const MEDIA_WORDS = { "the camera and microphone": "camera microphone", "the camera": "camera", "the microphone": "microphone", "the screen": "screen", "the camera or microphone": "camera microphone" };
const ASKED = {
  enumerateDevices: "device list",
  "geolocation.getCurrentPosition": "location",
  "geolocation.watchPosition": "location",
  getDisplayMedia: "screen",
  selectAudioOutput: "speakers",
  requestMIDIAccess: "midi",
  "SpeechRecognition.start": "microphone",
};
function checkWhat(events) {
  const media = e => MEDIA_WORDS[/^The page asked for (.*?) \((?:moz)?getUserMedia\)/i.exec(e.message)?.[1]];
  for (const e of events) {
    assert.equal(e.api, apiOf(e), JSON.stringify(e));
    assert.equal(e.asked, /getUserMedia$/i.test(e.api) ? media(e) : ASKED[e.api], JSON.stringify(e));
  }
}
/** The agent's code leaves a style sheet in the page: evidence (hooked) for it and its frames. */
const hook = async page => {
  await page.evaluate(() => {
    document.head.append(Object.assign(document.createElement("style"), { textContent: "#zo-hooked {}" }));
    return 1;
  });
  const reasons = await env.chrome(
    `return ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/evidence.sys.mjs").evidenceOf(ctx.resolvePage(arg).browser);`,
    page.P
  );
  assert.deepEqual(reasons, { hooked: "a style sheet" });
};

test("while the agent drives, a task's pages get a user's no from the camera, microphone, screen, speakers and speech recognition, and an empty device list: no request reaches MediaManager", () =>
  env.inSpace("devices", async page => {
    await page.goto(`${vectors.base}/vectors`);
    await page.call("page.events");
    const before = await counters();
    await runVectors(page, `setTimeout(() => { for (const id of ${JSON.stringify(Object.keys(MEDIA))}) window.__vectors[id](); }, 0); 1`);
    assert.deepEqual(await outcomes(page, counts(MEDIA)), MEDIA);
    await sleep(300);
    assert.deepEqual(await counters(), before, "no WebRTC request reached the parent");

    const events = await refusedEvents(page);
    assert.ok(events.every(e => e.kind === "deviceAccess"), JSON.stringify(events));
    checkWhat(events);
    // Once per document and API: the page, its fresh frame, its cross-site frame.
    assert.deepEqual(
      events.map(e => `${whereOf(e)} ${apiOf(e)}`).sort(),
      [
        "page getUserMedia",
        "page mozGetUserMedia",
        "page enumerateDevices",
        "frame getUserMedia",
        "cross getUserMedia",
        ...(MAC ? [] : ["page getDisplayMedia", "page selectAudioOutput", "page SpeechRecognition.start"]),
      ].sort(),
      JSON.stringify(events)
    );
    assert.ok(
      events.some(e => e.message.startsWith("The page asked for the camera and microphone (getUserMedia). The agent never uses the user's devices, so zenius refused it before any prompt (NotAllowedError).")),
      JSON.stringify(events)
    );
  }));

test("on evidence (here the agent's code left a style sheet), every device, location and MIDI request in a task's page and its frames is refused, and none reaches MediaManager or the geolocation provider", () =>
  env.inSpace("devices evidence", async page => {
    await page.goto(`${vectors.base}/vectors`);
    await hook(page);
    await page.call("page.events");
    const before = await counters();
    await runVectors(page, `setTimeout(() => { for (const id of ${JSON.stringify(Object.keys(ALL))}) window.__vectors[id](); }, 0); 1`);
    assert.deepEqual(await outcomes(page, counts(ALL)), ALL);
    await sleep(300);
    assert.deepEqual(await counters(), before, "no WebRTC request reached the parent, and the geolocation provider got none");

    const events = await refusedEvents(page);
    assert.ok(events.every(e => e.kind === "deviceAccess"), JSON.stringify(events));
    checkWhat(events);
    assert.deepEqual(
      events.map(e => `${whereOf(e)} ${apiOf(e)}`).sort(),
      [
        "page getUserMedia",
        "page mozGetUserMedia",
        "page enumerateDevices",
        "page geolocation.getCurrentPosition",
        "page geolocation.watchPosition",
        "frame getUserMedia",
        "frame geolocation.getCurrentPosition",
        "cross getUserMedia",
        "cross geolocation.getCurrentPosition",
        ...(MAC
          ? []
          : ["page getDisplayMedia", "page selectAudioOutput", "page requestMIDIAccess", "page SpeechRecognition.start", "cross requestMIDIAccess"]),
      ].sort(),
      JSON.stringify(events)
    );
    assert.ok(
      events.some(e => e.message.startsWith("The page asked for the user's location (geolocation.getCurrentPosition). The page shows evidence of danger (hooked: a style sheet), so zenius refused it before any prompt (PERMISSION_DENIED), during the user's hold too.")),
      JSON.stringify(events)
    );
  }));

test(
  "while the agent drives, a task's page asks for the location as any site does: with the site's grant, the provider is asked",
  { skip: MAC && "it would be Zen.app asking macOS for the location" },
  () =>
    env.inSpace("location", async page => {
      await page.goto(`${vectors.base}/vectors`);
      await page.call("page.events");
      const before = await counters();
      await runVectors(page, `window.__vectors.geolocation(); 1`);
      // A hidden document gets no position: the request times out once the provider was asked.
      const { geolocation } = await outcomes(page, { geolocation: 1 });
      assert.match(geolocation[0], /^(?:position|error 3)$/);
      assert.ok((await counters()).geo > before.geo, "the geolocation provider was asked");
      assert.deepEqual((await refusedEvents(page)).filter(e => e.kind === "deviceAccess"), []);
    })
);

test("workers have none of these APIs", () =>
  env.inSpace("devices workers", async page => {
    await page.goto(`${vectors.base}/vectors`);
    const probe = `[typeof navigator.mediaDevices, typeof navigator.geolocation, typeof navigator.requestMIDIAccess, typeof self.SpeechRecognition].join(" ")`;
    const seen = await page.evaluate(`(async () => {
      const src = URL.createObjectURL(new Blob(["postMessage(" + ${JSON.stringify(probe)} + ")"], { type: "text/javascript" }));
      const dedicated = await new Promise(r => { const w = new Worker(src); w.onmessage = e => { r(e.data); w.terminate(); }; });
      const shared = URL.createObjectURL(new Blob(["onconnect = e => e.ports[0].postMessage(" + ${JSON.stringify(probe)} + ")"], { type: "text/javascript" }));
      const sharedSeen = await new Promise(r => { const w = new SharedWorker(shared); w.port.onmessage = e => r(e.data); });
      return JSON.stringify([dedicated, sharedSeen]);
    })()`);
    assert.deepEqual(JSON.parse(seen), ["undefined undefined undefined undefined", "undefined undefined undefined undefined"]);
  }));

test("a popup an agent-driven page opens is refused the camera from its first document, before the popup is the task's", () =>
  env.inSpace("devices popup", async page => {
    await page.goto(`${vectors.base}/vectors`);
    const before = await counters();
    await page.call("page.click", { target: "#v-media-popup" });
    assert.deepEqual(await outcomes(page, { "media-popup": 1 }), { "media-popup": ["NotAllowedError"] });
    await sleep(300);
    assert.deepEqual(await counters(), before);
  }));

test("during the user's hold, a task's page uses the camera, the device list and the location as a tab of the user's does: its requests reach MediaManager and the provider", () =>
  env.inSpace("devices hold", async page => {
    await page.goto(`${vectors.base}/vectors`);
    await page.call("page.events");
    const browserId = await env.chrome(`return ctx.resolvePage(arg).browser.browserId;`, page.P);
    const before = await counters();
    // Location only where the site has a grant: elsewhere it waits for the user's answer.
    const ids = ["camera", "enumerate-devices", ...(MAC ? [] : ["geolocation"])];
    await runVectors(page, `setTimeout(() => { for (const id of ${JSON.stringify(ids)}) window.__vectors[id](); }, 600); 1`);
    await page.call("spaces.handOff", { reason: "manual_takeover" });
    await sleep(2000);
    await page.call("spaces.takeOver");
    const out = await outcomes(page, Object.fromEntries(ids.map(id => [id, 1])));
    // The counter's no, standing for the user's answer to Firefox's prompt.
    assert.deepEqual(out.camera, ["NotAllowedError"]);
    assert.match(out["enumerate-devices"][0], /^devices [1-9]\d*$/, "the fake devices listed");
    assert.deepEqual((await webrtcRequests()).slice(before.webrtc), [browserId], "the camera request reached the parent");
    if (!MAC) {
      assert.match(out.geolocation[0], /^(?:position|error 3)$/);
      assert.ok((await counters()).geo > before.geo, "the geolocation provider was asked");
    }
    assert.deepEqual((await refusedEvents(page)).filter(e => e.kind === "deviceAccess"), []);
  }));

/**
 * The real APIs, as page script: gUM (denied by the counter), the device
 * list, and a position. Gecko gives a hidden document no position, so a
 * tab in the background times out (3) once the provider was asked.
 */
const NATIVE = `
  const out = {};
  out.gum = await navigator.mediaDevices.getUserMedia({ video: true }).then(() => "granted", e => e.name);
  out.devices = (await navigator.mediaDevices.enumerateDevices()).length > 0;
  out.geo = await new Promise(r => navigator.geolocation.getCurrentPosition(p => r("position " + p.coords.latitude), e => r("error " + e.code), { timeout: 2000 }));
  return out;`;
const tabRun = (mark, code) =>
  env.chrome(
    `const tab = [...(win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs)].find(t => t.hasAttribute(arg.mark));
     if (!tab) throw new Error("the tab is gone");
     return { browserId: tab.linkedBrowser.browserId, out: await ctx.content(tab.linkedBrowser.browsingContext, "dev#evalContent", { code: arg.code }) };`,
    { mark, code }
  );
const removeTabs = mark =>
  env.chrome(
    `for (const t of [...(win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs)].filter(t => t.hasAttribute(arg))) win.gBrowser.removeTab(t);
     return true;`,
    mark
  );

/** Run NATIVE in the tab marked `mark`: it reaches MediaManager once and the provider at least once. */
async function reachesBoth(mark) {
  const before = await counters();
  const { browserId, out } = await tabRun(mark, NATIVE);
  assert.equal(out.gum, "NotAllowedError", "denied by the counter");
  assert.equal(out.devices, true, "the fake devices listed");
  assert.match(out.geo, /^(?:position 30\.2849|error 3)$/);
  const requests = await webrtcRequests();
  assert.deepEqual(requests.slice(before.webrtc), [browserId], "one WebRTC request, from this tab");
  assert.ok((await counters()).geo > before.geo, "the geolocation provider was asked");
}

test(
  "a tab of the user's, and a page the task kept, reach MediaManager and the geolocation provider as usual: the counters count",
  { skip: MAC && "it would be Zen.app asking macOS for the camera and location" },
  async () => {
    const mark = `zo-devices-${Date.now()}`;
    try {
      await env.chrome(
        `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
         const { setTimeout: later } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
         const ws = win.gZenWorkspaces.getWorkspaces().find(w => !ctx.spaces.isAgentsSpace(w.uuid))?.uuid;
         const t = W.addBackgroundTab(win, ws);
         t.setAttribute(arg.mark, "user");
         const uri = Services.io.newURI(arg.url);
         t.linkedBrowser.loadURI(uri, { triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(uri, {}) });
         for (const end = Date.now() + 10000; ; await new Promise(r => later(r, 50))) {
           const b = t.linkedBrowser;
           if (b.currentURI?.spec === arg.url && !b.webProgress?.isLoadingDocument) return true;
           if (Date.now() > end) throw new Error("the user's tab didn't load");
         }`,
        { url: `${vectors.base}/plain?user`, mark }
      );
      await reachesBoth(mark);
      await removeTabs(mark);

      const space = await env.call("spaces.create", { name: `devices kept ${Date.now() % 100000}` });
      const P = { space: space.id, page: "p1" };
      let finished = false;
      try {
        await env.call("page.goto", { ...P, url: `${vectors.base}/plain?kept` });
        await env.chrome(`ctx.resolvePage(arg.P).tab.setAttribute(arg.mark, "kept"); return true;`, { P, mark });
        await env.call("spaces.finish", { space: space.id, keep: ["p1"] });
        finished = true;
        await reachesBoth(mark);
      } finally {
        if (!finished) {
          await env.call("spaces.finish", { space: space.id, keep: [] }).catch(() => {});
        }
      }
    } finally {
      await removeTabs(mark).catch(() => {});
    }
  }
);

// ---------------------------------------------------------------------------
// Notifications, WebRTC and the local network.

const NOTIFY = {
  "notify-show": ["permission default", "error"],
  "notify-prototype": ["error"],
  "notify-registration": ["TypeError: Permission to show Notification denied."],
  "notify-fresh-frame": ["error"],
  "notify-worker": ["error"],
};
const RTC = { rtc: ["NotAllowedError"], "rtc-prototype": ["NotAllowedError"], "rtc-fresh-frame": ["NotAllowedError"] };
const LAN = {
  "lan-fetch": ["TypeError"],
  "lan-fetch-forms": ["TypeError", "TypeError", "TypeError", "TypeError", "TypeError"],
  "lan-name": ["TypeError"],
  "lan-image": ["error"],
  "lan-frame": ["done"],
  "lan-websocket": ["error"],
  "lan-event-source": ["error"],
  "lan-beacon": ["queued true"],
  "lan-redirect": ["TypeError"],
  "lan-worker": ["TypeError"],
  "lan-allowed": ["status 200"],
  "lan-loopback": ["status 200"],
};

/** Every peer connection the browser made (WebRTC's own history, as about:webrtc lists them). */
const peerConnections = () => env.chrome(`return (await new Promise(r => WebrtcGlobalInformation.getStatsHistoryPcIds(r))).length;`);
const hits = () => ({ ...vectors.stats.hits });
const newHits = before => Object.fromEntries(Object.entries(vectors.stats.hits).filter(([k, n]) => n !== (before[k] ?? 0)).map(([k, n]) => [k, n - (before[k] ?? 0)]));
const run = (page, ids, delay = 0) =>
  runVectors(page, `setTimeout(() => { for (const id of ${JSON.stringify(ids)}) window.__vectors[id](); }, ${delay}); 1`);
/** Firefox's own notification windows open now (with alerts.useSystemBackend off). */
const alertWindows = () => env.chrome(`return [...Services.wm.getEnumerator("alert:alert")].length;`);
/** Close them, and give the browser window back the focus an alert window took. */
const closeAlerts = () =>
  env.chrome(`
    for (const w of Services.wm.getEnumerator("alert:alert")) { try { w.close(); } catch {} }
    const browserActive = () => Services.focus.activeWindow?.document?.documentElement?.getAttribute("windowtype") === "navigator:browser";
    for (let i = 0; i < 40 && !browserActive(); i++) await new Promise(r => setTimeout(r, 50));
    if (!browserActive()) Services.wm.getMostRecentWindow("navigator:browser")?.focus();
    for (let i = 0; i < 40 && !browserActive(); i++) await new Promise(r => setTimeout(r, 50));
    return browserActive();`);
const NOTIFICATION_GRANT = verb =>
  env.chrome(
    `const p = Services.scriptSecurityManager.createContentPrincipalFromOrigin(arg);
     if (${JSON.stringify(verb)} === "allow") Services.perms.addFromPrincipal(p, "desktop-notification", Services.perms.ALLOW_ACTION, Services.perms.EXPIRE_SESSION);
     else Services.perms.removeFromPrincipal(p, "desktop-notification");
     return true;`,
    new URL(vectors.base).origin
  );

test("the workers' fake Notification has the fields the pages' has (one made in chrome, one in the worker's text)", () => {
  // fakeNotification's `fields`, in order: each `key:`, or a line that is a key alone.
  const fields = file => {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    const body = /function fakeNotification\([\s\S]*?const fields = \{([\s\S]*?)\n  \};/.exec(text)?.[1];
    return body ? [...body.matchAll(/^\s*(\w+),\s*$|(\w+)\s*:/gm)].map(m => m[1] ?? m[2]) : null;
  };
  const page = fields("../../runtime/JS/zenius/content/refusals.sys.mjs");
  assert.ok(page?.length > 10, "content/refusals.sys.mjs has them");
  assert.deepEqual(fields("../../runtime/JS/zenius/content/workerguard.js"), page);
});

/** A notification without the site's grant, as Firefox answers it: it errs, and nothing shows. */
const NOTIFY_NATIVE = {
  "notify-show": ["permission default", "error"],
  "notify-prototype": ["error"],
  "notify-fresh-frame": ["error"],
  "notify-worker": ["error"],
};

test("without evidence, a task's pages make their notifications as any site does; their workers' are refused for the task's whole life", () =>
  env.inSpace("notifications", async page => {
    await page.goto(`${vectors.base}/vectors-net`);
    await page.call("page.events");
    await run(page, Object.keys(NOTIFY_NATIVE));
    assert.deepEqual(await outcomes(page, counts(NOTIFY_NATIVE)), NOTIFY_NATIVE);
    const events = (await refusedEvents(page)).filter(e => e.kind === "notification");
    assert.deepEqual(events.map(e => `${whereOf(e)} ${/^A worker the page started/.test(e.message) ? "worker" : "document"}`), ["page worker"], JSON.stringify(events));
  }));

test("on evidence, notifications are refused in a task's pages, their fresh frames and their workers", () =>
  env.inSpace("notifications evidence", async page => {
    await page.goto(`${vectors.base}/vectors-net`);
    await hook(page);
    await run(page, Object.keys(NOTIFY));
    assert.deepEqual(await outcomes(page, counts(NOTIFY)), NOTIFY);
    const events = (await refusedEvents(page)).filter(e => e.kind === "notification");
    assert.deepEqual(
      events.map(e => `${whereOf(e)} ${/^A worker the page started/.test(e.message) ? "worker" : /\((new Notification|showNotification)\)/.exec(e.message)?.[1]}`).sort(),
      ["frame new Notification", "page new Notification", "page showNotification", "page worker"].sort(),
      JSON.stringify(events)
    );
    for (const e of events) {
      assert.equal(e.asked, "notifications", JSON.stringify(e));
      const api = /^A worker the page started/.test(e.message) ? ["Notification", "showNotification"] : [/\(new Notification\)/.test(e.message) ? "Notification" : "showNotification"];
      assert.ok(api.includes(e.api), JSON.stringify(e));
    }
  }));

test(
  "where the site may show notifications: zen-ux's quiet one while the agent drives and a refusal in workers; during the user's hold the page's own goes on",
  { skip: MAC && "a miss would be a real notification on the Mac's screen" },
  async () => {
    // Firefox's own alert window: the Linux server has no notification daemon, where the
    // system backend fails and the page would hear "error".
    const saved = await env.chrome(SET_PREFS, { "alerts.useSystemBackend": false });
    await NOTIFICATION_GRANT("allow");
    try {
      await env.inSpace("notifications granted", async page => {
        const shown = await alertWindows();
        await page.goto(`${vectors.base}/vectors-net`);
        await run(page, ["notify-show", "notify-worker"]);
        assert.deepEqual(await outcomes(page, { "notify-show": 2, "notify-worker": 1 }), {
          "notify-show": ["permission granted", "shown"],
          "notify-worker": ["error"],
        });
        const events = await page.call("page.events");
        assert.ok(events.some(e => e.method === "Zenius.notification" && e.params.title === "zenius vector"), "zen-ux's guard told the agent");
        assert.ok(events.some(e => e.method === "Zenius.refused" && e.params.kind === "notification" && /^A worker the page started/.test(e.params.message)));
        assert.equal(await alertWindows(), shown, "zen-ux's quiet one shows nothing");
      });
      await env.inSpace("notifications granted hold", async page => {
        const shown = await alertWindows();
        await page.goto(`${vectors.base}/vectors-net`);
        await page.call("page.events");
        await run(page, ["notify-show"], 600);
        await page.call("spaces.handOff", { reason: "manual_takeover" });
        await sleep(2000);
        await page.call("spaces.takeOver");
        assert.deepEqual(await outcomes(page, { "notify-show": 2 }), { "notify-show": ["permission granted", "shown"] });
        assert.equal(await alertWindows(), shown + 1, "Firefox showed the page's own");
        // Headless gives the alert window focus, which a system notification
        // never takes: close it and give the browser window its focus back,
        // so the I1 check sees what the user would.
        await closeAlerts();
        const events = await page.call("page.events");
        assert.deepEqual(events.filter(e => e.method === "Zenius.notification"), [], "not zen-ux's quiet one");
        assert.deepEqual(events.filter(e => e.method === "Zenius.refused" && e.params.kind === "notification"), []);
      });
    } finally {
      await NOTIFICATION_GRANT("remove");
      await closeAlerts().catch(() => {});
      await env.chrome(RESTORE_PREFS, saved).catch(() => {});
    }
  }
);

test(
  "the agent's own code is refused its notifications, where the site may show them too: NotAllowedError, as for its passkeys, for each way to make one, and nothing shows",
  { skip: MAC && "a miss would be a real notification on the Mac's screen" },
  async () => {
    const saved = await env.chrome(SET_PREFS, { "alerts.useSystemBackend": false });
    await NOTIFICATION_GRANT("allow");
    try {
      await env.inSpace("notifications agent", async page => {
        const shown = await alertWindows();
        await page.goto(`${vectors.base}/vectors-net`);
        await page.call("page.events");
        const out = await page.evaluate(async () => {
          // A JS error from the page's realm has a message the world can't read.
          const said = e => {
            try {
              return `${e.name}: ${e.message}`;
            } catch {
              return `${e.name}: (unreadable)`;
            }
          };
          const out = { permission: Notification.permission };
          const made = {
            new: () => new Notification("zenius agent"),
            prototype: () => new Notification.prototype.constructor("zenius agent"),
            reflect: () => Reflect.construct(Notification, ["zenius agent"]),
          };
          for (const [key, make] of Object.entries(made)) {
            try {
              make().close();
              out[key] = "made";
            } catch (e) {
              out[key] = said(e);
            }
          }
          try {
            await ServiceWorkerRegistration.prototype.showNotification.call(null, "zenius agent");
            out.registration = "shown";
          } catch (e) {
            out.registration = said(e);
          }
          return out;
        });
        const denied = "NotAllowedError: The request is not allowed by the user agent or the platform in the current context.";
        assert.deepEqual(out, { permission: "granted", new: denied, prototype: denied, reflect: denied, registration: denied });
        await sleep(500);
        assert.equal(await alertWindows(), shown, "nothing showed");
        const events = await page.call("page.events");
        assert.deepEqual(events.filter(e => e.method === "Zenius.notification"), [], "not zen-ux's quiet one: the agent's code gets a no");
        const refused = events.filter(e => e.method === "Zenius.refused" && e.params.kind === "notification");
        assert.deepEqual(
          refused.map(e => `${e.params.api} ${e.params.asked}`).sort(),
          ["Notification notifications", "showNotification notifications"],
          JSON.stringify(refused)
        );
        for (const e of refused) {
          assert.match(e.params.message, /^The agent's code tried to show a notification/, JSON.stringify(e));
        }
      });
    } finally {
      await NOTIFICATION_GRANT("remove");
      await closeAlerts().catch(() => {});
      await env.chrome(RESTORE_PREFS, saved).catch(() => {});
    }
  }
);

test("while the agent drives, WebRTC is refused in a task's pages and their fresh frames: the browser made no peer connection; during the user's hold the page makes its own", () =>
  env.inSpace("webrtc", async page => {
    await page.goto(`${vectors.base}/vectors-net`);
    const before = await peerConnections();
    await run(page, Object.keys(RTC));
    assert.deepEqual(await outcomes(page, counts(RTC)), RTC);
    assert.equal(await peerConnections(), before);
    const events = (await refusedEvents(page)).filter(e => e.kind === "localNetwork");
    assert.deepEqual(events.map(whereOf).sort(), ["frame", "page"], JSON.stringify(events));
    assert.ok(events.every(e => e.message.startsWith("The page tried to open a WebRTC connection (new RTCPeerConnection).")));

    await runVectors(page, `window.__vectorResults.rtc = []; setTimeout(() => window.__vectors.rtc(), 600); 1`);
    await page.call("spaces.handOff", { reason: "manual_takeover" });
    await sleep(1500);
    await page.call("spaces.takeOver");
    assert.deepEqual(await outcomes(page, { rtc: 1 }), { rtc: ["made"] });
    assert.ok((await peerConnections()) > before, "the browser lists the page's peer connection");
  }));

test("a task's pages never reach a private or link-local address or a .local name; loopback and the user's list stay open", () =>
  env.inSpace("local network", async page => {
    await page.goto(`${vectors.base}/vectors-net`);
    const before = hits();
    await run(page, Object.keys(LAN));
    assert.deepEqual(await outcomes(page, counts(LAN)), LAN);
    await sleep(500);
    assert.deepEqual(newHits(before), { allowed: 1, loopback: 1 }, "only the listed name and loopback were reached");
    assert.deepEqual(privateRequests(recorder), [], "a private address reached the recorder");
    const port = new URL(vectors.base).port;
    const events = (await refusedEvents(page)).filter(e => e.kind === "localNetwork");
    // Once per host and port for a while: the many requests to lan.local are one.
    assert.deepEqual(
      events.map(e => /^The page tried to reach (\S+), /.exec(e.message)?.[1]).sort(),
      ["http://172.31.254.1", "http://[::ffff:ac1f:fe01]", "http://192.168.254.254", "http://[fd00::1]", "http://169.254.169.254", `http://lan.local:${port}`].sort(),
      JSON.stringify(events)
    );
    assert.ok(events.every(e => e.message.endsWith("If the task needs this host, ask the user to do that step in their own tab.")));
    assert.ok(events.some(e => e.message.includes("a link-local address on the local network")));
  }));

test("a popup's first load is refused before the popup is the task's", () =>
  env.inSpace("local network popup", async page => {
    await page.goto(`${vectors.base}/vectors-net`);
    const before = hits();
    await page.call("page.click", { target: "#v-lan-popup" });
    assert.deepEqual(await outcomes(page, { "lan-popup": 1 }), { "lan-popup": ["opened"] });
    await sleep(1000);
    assert.deepEqual(newHits(before), {});
  }));

test("page.goto refuses the local network before loading, and says so when a redirect or the page leads there", () =>
  env.inSpace("local network goto", async page => {
    const port = new URL(vectors.base).port;
    const before = hits();
    const direct = await page.fail("page.goto", { url: "http://172.31.254.1/" });
    assert.equal(direct.code, "ZEN_NAVIGATION_FAILED");
    assert.match(direct.message, /^page\.goto failed: net::ERR_ACCESS_DENIED\. http:\/\/172\.31\.254\.1 is a private address on the local network\. /);
    assert.match(direct.message, /If the task needs this host, hand off and ask the user to open it in this tab \(task\.handOff\(\{ message \}\)\), or ask them to do that step in their own tab\./);
    assert.deepEqual(privateRequests(recorder), [], "the private address reached the recorder");

    await page.goto(`${vectors.base}/vectors-net`);
    const redirected = await page.fail("page.goto", { url: `${vectors.base}/redirect?to=${encodeURIComponent(`http://lan.local:${port}/hit?goto`)}` });
    assert.equal(redirected.code, "ZEN_NAVIGATION_FAILED");
    assert.match(redirected.message, new RegExp(`^page\\.goto failed: The page tried to reach http://lan\\.local:${port}, a \\.local name on the local network \\(a page load\\)\\.`));
    assert.equal(await page.call("page.url"), `${vectors.base}/vectors-net`);

    // The page's own navigation: cancelled, and the page stays.
    await page.evaluate(`setTimeout(() => { location.href = "http://lan.local:${port}/hit?navigate"; }, 0); 1`);
    await sleep(1000);
    assert.equal(await page.call("page.url"), `${vectors.base}/vectors-net`);
    assert.deepEqual(newHits(before), {});

    await page.goto(`http://lan-ok.local:${port}/hit?goto-allowed`);
    assert.deepEqual(newHits(before), { "goto-allowed": 1 });
  }));

test("the local network stays refused while the user holds the task; WebRTC is the user's then, as the devices are", () =>
  env.inSpace("local network hold", async page => {
    await page.goto(`${vectors.base}/vectors-net`);
    const before = hits();
    await run(page, ["lan-name", "rtc"], 600);
    await page.call("spaces.handOff", { reason: "manual_takeover" });
    await sleep(2000);
    await page.call("spaces.takeOver");
    assert.deepEqual(await outcomes(page, { "lan-name": 1, rtc: 1 }), { "lan-name": ["TypeError"], rtc: ["made"] });
    assert.deepEqual(newHits(before), {});
  }));

test("the user's list takes hosts, addresses and CIDR ranges; IP literals count in every form Gecko writes", async () => {
  const hosts = {
    "10.0.0.1": "a private address",
    "10.255.255.255": "a private address",
    "11.0.0.1": null,
    "172.16.0.1": "a private address",
    "172.31.255.255": "a private address",
    "172.32.0.1": null,
    "192.168.1.1": "a private address",
    "192.169.0.1": null,
    "169.254.1.1": "a link-local address",
    "127.0.0.1": null,
    "0.0.0.0": null,
    "100.64.0.1": null,
    "fc00::1": "a private address",
    "fdff:ffff::1": "a private address",
    "fe80::1": "a link-local address",
    "fe80::1%en0": "a link-local address",
    "febf::1": "a link-local address",
    "fec0::1": null,
    "::1": null,
    "::ffff:a00:1": "a private address",
    "::ffff:7f00:1": null,
    "printer.local": "a .local name",
    "printer.local.": "a .local name",
    "local": "a .local name",
    localhost: null,
    "example.com": null,
    "10.0.0.1.nip.io": null,
  };
  const cases = [
    ["10.20.3.4", "10.20.0.0/16", null],
    ["10.21.0.1", "10.20.0.0/16", "a private address"],
    ["10.20.3.4", "10.20.3.4", null],
    ["::ffff:a14:304", "10.20.0.0/16", null],
    ["fd12::1", "fd00::/8", null],
    ["fe80::1", "fd00::/8", "a link-local address"],
    ["printer.local", " Printer.Local , 10.0.0.0/8", null],
    ["scanner.local", "printer.local", "a .local name"],
    ["10.0.0.1", "10.0.0.0/33, bogus/8, 10.0.0.1:80", "a private address"],
    ["192.168.1.1", "0.0.0.0/0", null],
    ["192.168.1.1", "", "a private address"],
  ];
  const got = await env.chrome(
    `const L = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/localnet.sys.mjs");
     return {
       hosts: Object.fromEntries(arg.hosts.map(h => [h, L.privateReason(h)])),
       cases: arg.cases.map(([host, list]) => L.refusedReason(host, list)),
       uris: arg.uris.map(u => L.privateReason(Services.io.newURI(u).host)),
     };`,
    { hosts: Object.keys(hosts), cases: cases.map(([h, l]) => [h, l]), uris: ["http://3232235777/", "http://0xC0A80101/", "http://0300.0250.1.1/", "http://10.1/", "http://[::ffff:192.168.1.1]/", "http://PRINTER.LOCAL/"] }
  );
  assert.deepEqual(got.hosts, hosts);
  assert.deepEqual(got.cases, cases.map(c => c[2]));
  assert.deepEqual(got.uris, ["a private address", "a private address", "a private address", "a private address", "a private address", "a .local name"]);
});

test("a tab of the user's, and a page the task kept, reach the local network as usual, with their own Notification and WebRTC", async () => {
  const mark = `zo-lan-${Date.now()}`;
  const port = new URL(vectors.base).port;
  const probe = `
    const out = {};
    out.lan = await fetch("http://lan.local:${port}/hit?" + ${JSON.stringify(mark)}).then(r => "status " + r.status, e => e.name);
    out.notification = Function.prototype.toString.call(Notification).startsWith("function Notification(");
    out.rtc = ${MAC ? `"skipped"` : `(() => { try { new RTCPeerConnection().close(); return "made"; } catch (e) { return e.name; } })()`};
    return out;`;
  try {
    await env.chrome(
      `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
       const { setTimeout: later } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
       const ws = win.gZenWorkspaces.getWorkspaces().find(w => !ctx.spaces.isAgentsSpace(w.uuid))?.uuid;
       const t = W.addBackgroundTab(win, ws);
       t.setAttribute(arg.mark, "user");
       const uri = Services.io.newURI(arg.url);
       t.linkedBrowser.loadURI(uri, { triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(uri, {}) });
       for (const end = Date.now() + 10000; ; await new Promise(r => later(r, 50))) {
         const b = t.linkedBrowser;
         if (b.currentURI?.spec === arg.url && !b.webProgress?.isLoadingDocument) return true;
         if (Date.now() > end) throw new Error("the user's tab didn't load");
       }`,
      { url: `${vectors.base}/plain?user`, mark }
    );
    const connections = await peerConnections();
    const user = await tabRun(mark, probe);
    assert.deepEqual(user.out, { lan: "status 200", notification: true, rtc: MAC ? "skipped" : "made" });
    if (!MAC) {
      assert.equal(await peerConnections(), connections + 1, "the counter counts");
    }
    await removeTabs(mark);

    const space = await env.call("spaces.create", { name: `lan kept ${Date.now() % 100000}` });
    const P = { space: space.id, page: "p1" };
    let finished = false;
    try {
      await env.call("page.goto", { ...P, url: `${vectors.base}/plain?kept` });
      await env.chrome(`ctx.resolvePage(arg.P).tab.setAttribute(arg.mark, "kept"); return true;`, { P, mark });
      await env.call("spaces.finish", { space: space.id, keep: ["p1"] });
      finished = true;
      const kept = await tabRun(mark, probe);
      assert.equal(kept.out.lan, "status 200");
      assert.equal(vectors.stats.hits[mark], 2, "the user's tab and the kept page each reached it");
    } finally {
      if (!finished) {
        await env.call("spaces.finish", { space: space.id, keep: [] }).catch(() => {});
      }
    }
  } finally {
    await removeTabs(mark).catch(() => {});
  }
});

test("a task's shared worker, and the workers it starts, never reach the local network either; the user's shared worker does", async () => {
  const mark = `zo-lan-shared-${Date.now()}`;
  const port = new URL(vectors.base).port;
  const lan = what => `http://lan.local:${port}/hit?${mark}-${what}`;
  try {
    await env.chrome(
      `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
       const { setTimeout: later } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
       const ws = win.gZenWorkspaces.getWorkspaces().find(w => !ctx.spaces.isAgentsSpace(w.uuid))?.uuid;
       const t = W.addBackgroundTab(win, ws);
       t.setAttribute(arg.mark, "user");
       const uri = Services.io.newURI(arg.url);
       t.linkedBrowser.loadURI(uri, { triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(uri, {}) });
       for (const end = Date.now() + 10000; ; await new Promise(r => later(r, 50))) {
         const b = t.linkedBrowser;
         if (b.currentURI?.spec === arg.url && !b.webProgress?.isLoadingDocument) return true;
         if (Date.now() > end) throw new Error("the user's tab didn't load");
       }`,
      { url: `${vectors.base}/plain?lan-user-shared`, mark }
    );
    const user = await tabRun(
      mark,
      `const s = new SharedWorker("/shared-fetch.js", "lan-user");
       return await new Promise(r => { s.port.onmessage = e => r(e.data); s.port.postMessage(${JSON.stringify(lan("user"))}); });`
    );
    assert.match(user.out, /^200 /, "the user's shared worker reached lan.local");
    await env.inSpace("local network shared worker", async page => {
      await page.goto(`${vectors.base}/plain?lan-task-shared`);
      // Its requests name no tab: the mark in their principal places them.
      const out = JSON.parse(
        await page.evaluate(`(async () => {
          const within = (p, what) => Promise.race([p, new Promise(r => setTimeout(() => r("no answer: " + what), 5000))]);
          const s = new SharedWorker("/shared-nest.js", "lan-nest");
          const ask = m => within(new Promise(r => { s.port.onmessage = e => r(e.data); s.port.postMessage(m); }), JSON.stringify(m));
          return JSON.stringify({
            shared: await ask({ fetch: ${JSON.stringify(lan("shared"))} }),
            sharedPrivate: await ask({ fetch: "http://172.31.254.1/" }),
            nested: await ask({ nested: "site", url: ${JSON.stringify(lan("nested"))} }),
          });
        })()`)
      );
      assert.deepEqual(out, { shared: "TypeError", sharedPrivate: "TypeError", nested: "TypeError" });
      await sleep(500);
      assert.deepEqual(
        Object.keys(vectors.stats.hits).filter(k => k.startsWith(mark)),
        [`${mark}-user`],
        "only the user's shared worker reached lan.local"
      );
      assert.deepEqual(privateRequests(recorder), [], "a private address reached the recorder");
      // Told on the task's page, once per host for a while.
      const events = (await refusedEvents(page)).filter(e => e.kind === "localNetwork");
      assert.deepEqual(
        events.map(e => /^The page tried to reach (\S+), /.exec(e.message)?.[1]).sort(),
        ["http://172.31.254.1", `http://lan.local:${port}`].sort(),
        JSON.stringify(events)
      );
      assert.ok(events.every(e => e.message.includes(" on the local network (a request of a worker it started).")), JSON.stringify(events));
    });
  } finally {
    await removeTabs(mark).catch(() => {});
  }
});

test("while a task's page shows a site, that site's blob shared workers never reach the local network, the user's own included; a task's data: shared worker is refused", async () => {
  const mark = `zo-lan-blob-${Date.now()}`;
  const port = new URL(vectors.base).port;
  const lan = what => `http://lan.local:${port}/hit?${mark}-${what}`;
  // A blob shared worker that fetches what it's asked, and its answer.
  const blobShared = url => `new Promise(r => {
    const code = "onconnect = e => { const p = e.ports[0]; p.onmessage = m => fetch(m.data).then(r => p.postMessage('status ' + r.status), err => p.postMessage(err.name)); };";
    const w = new SharedWorker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
    setTimeout(() => r("no answer"), 5000);
    w.port.onmessage = e => r(e.data);
    w.port.postMessage(${JSON.stringify(url)});
  })`;
  const openUserTab = (url, which) =>
    env.chrome(
      `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
       const { setTimeout: later } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
       const ws = win.gZenWorkspaces.getWorkspaces().find(w => !ctx.spaces.isAgentsSpace(w.uuid))?.uuid;
       const t = W.addBackgroundTab(win, ws);
       t.setAttribute(arg.mark, "1");
       const uri = Services.io.newURI(arg.url);
       t.linkedBrowser.loadURI(uri, { triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(uri, {}) });
       for (const end = Date.now() + 10000; ; await new Promise(r => later(r, 50))) {
         const b = t.linkedBrowser;
         if (b.currentURI?.spec === arg.url && !b.webProgress?.isLoadingDocument) return true;
         if (Date.now() > end) throw new Error("the user's tab didn't load");
       }`,
      { url, mark: `${mark}-${which}` }
    );
  const asUser = (which, code) => tabRun(`${mark}-${which}`, `return await ${code};`).then(r => r.out);
  try {
    await openUserTab(`${vectors.base}/plain?lan-blob-user`, "same");
    await openUserTab(`${vectors.crossBase}/plain?lan-blob-user`, "other");
    await env.inSpace("local network blob shared worker", async page => {
      await page.goto(`${vectors.base}/plain?lan-blob-task`);
      const out = {
        world: await page.evaluate(blobShared(lan("world"))),
        worldPrivate: await page.evaluate(blobShared("http://172.31.254.1/")),
        main: await env.call("dev.evalContent", { ...page.P, code: blobShared(lan("main")) }),
        data: await page.evaluate(`(() => { try { new SharedWorker("data:text/javascript,onconnect=e=>e.ports[0].postMessage(1)"); return "made"; } catch (e) { return e.name; } })()`),
        // The accepted cost: the user's own, on the site the task shows.
        userSame: await asUser("same", blobShared(lan("user-same"))),
        userOther: await asUser("other", blobShared(lan("user-other"))),
      };
      assert.deepEqual(out, { world: "TypeError", worldPrivate: "TypeError", main: "TypeError", data: "SecurityError", userSame: "TypeError", userOther: "status 200" });
      const events = (await refusedEvents(page)).filter(e => e.kind === "localNetwork");
      const reached = events.map(e => /^A blob shared worker of this site tried to reach (\S+), /.exec(e.message)?.[1]).filter(Boolean);
      assert.deepEqual(reached.sort(), ["http://172.31.254.1", `http://lan.local:${port}`].sort(), JSON.stringify(events));
      assert.deepEqual(
        events.filter(e => e.message.startsWith("The page tried to start a shared worker from a data: URL.")).length,
        1,
        JSON.stringify(events)
      );
    });
    // With no task on the site, the user's blob shared worker reaches it again.
    assert.equal(await asUser("same", blobShared(lan("user-after"))), "status 200");
    await sleep(300);
    assert.deepEqual(
      Object.keys(vectors.stats.hits).filter(k => k.startsWith(mark)).sort(),
      [`${mark}-user-after`, `${mark}-user-other`],
      "only the other site's and the after-task blob shared workers reached lan.local"
    );
    assert.deepEqual(privateRequests(recorder), [], "a private address reached the recorder");
  } finally {
    await removeTabs(`${mark}-same`).catch(() => {});
    await removeTabs(`${mark}-other`).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// A page that holds the agent's code keeps the task's refusals until its
// document is replaced. In the world, what the agent leaves in a page after
// the task can only be what its world wrote there: markup such as an onclick
// attribute, which runs as the page's own code at the user's click. Code the
// world only ran goes with the world.

/** Code an agent leaves in a page: at the user's first click, every kind refused for a task's whole life. */
const PLANT_HANDLER = `
  if (window.__planted) return;
  window.__planted = [];
  const note = t => window.__planted.push(t);
    navigator.mediaDevices.getUserMedia({ video: true }).then(s => { note("gum granted"); s.getTracks().forEach(t => t.stop()); }, e => note("gum " + e.name));
    navigator.geolocation.getCurrentPosition(() => note("geo position"), e => note("geo " + e.code), { timeout: 2000 });
    try { new RTCPeerConnection().close(); note("rtc made"); } catch (e) { note("rtc " + e.name); }
    const n = new Notification("planted"); n.onerror = () => note("notify error"); n.onshow = () => note("notify shown");
    fetch("http://lan.local:" + location.port + "/hit?planted").then(r => note("lan " + r.status), e => note("lan " + e.name));
    navigator.serviceWorker.register("/sw.js").then(r => { note("sw registered"); r.unregister(); }, e => note("sw " + e.name));
    caches.open("zenius-kept").then(c => c.put("/plain?kept-cache", new Response("planted"))).then(() => note("cache put"), e => note("cache " + e.name));
    const f = document.createElement("iframe"); document.body.append(f);
    f.contentWindow.navigator.mediaDevices.getUserMedia({ audio: true }).then(s => { note("frame gum granted"); s.getTracks().forEach(t => t.stop()); }, e => note("frame gum " + e.name));`;
/** The agent's world writes it into the page as markup: an onclick attribute, which runs as the page's own code. */
const PLANT = `document.body.setAttribute("onclick", ${JSON.stringify(PLANT_HANDLER)}); return 1;`;
const PLANTED = [
  "cache SecurityError",
  "frame gum NotAllowedError",
  "geo 1",
  "gum NotAllowedError",
  "lan TypeError",
  "notify error",
  "rtc NotAllowedError",
  "sw SecurityError",
];

/** A task whose page p1 ran PLANT and was kept, marked `mark` for tabRun. */
async function keptWithPlantedCode(mark) {
  const space = await env.call("spaces.create", { name: `kept code ${Date.now() % 100000}` });
  const P = { space: space.id, page: "p1" };
  let finished = false;
  try {
    await env.call("page.goto", { ...P, url: `${vectors.base}/plain?kept` });
    await env.call("page.evaluate", { ...P, fn: `() => { ${PLANT} }`, isFunction: true });
    await env.chrome(`ctx.resolvePage(arg.P).tab.setAttribute(arg.mark, "kept"); return true;`, { P, mark });
    await env.chrome(`Services.prefs.setBoolPref("zenius.handoff.quietReload", false); return true;`); // stays written: a failed clean reload
    await env.call("spaces.finish", { space: space.id, keep: ["p1"] });
    finished = true;
  } finally {
    if (!finished) {
      await env.call("spaces.finish", { space: space.id, keep: [] }).catch(() => {});
    }
  }
}

/** Reload the tab marked `mark` as the user would, and wait for its new document. */
async function userReload(mark) {
  const find = `[...(win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs)].find(t => t.hasAttribute(arg))`;
  const before = await env.chrome(`const tab = ${find}; const id = tab.linkedBrowser.browsingContext.currentWindowGlobal.innerWindowId; win.gBrowser.reloadTab(tab); return id;`, mark);
  await until("the reload", () =>
    env.chrome(
      `const b = ${find}.linkedBrowser; const id = b.browsingContext.currentWindowGlobal?.innerWindowId ?? 0;
       return id && id !== ${before} && !b.webProgress?.isLoadingDocument;`,
      mark
    )
  );
}

test("a kept page where the agent's code ran keeps the task's refusals at the user's first click, until a reload replaces it", async () => {
  const mark = `zo-kept-code-${Date.now()}`;
  try {
    await keptWithPlantedCode(mark);
    const before = { ...(await counters()), connections: await peerConnections(), hits: hits() };
    // The user's first click in their kept page.
    await tabRun(mark, `document.body.click(); return 1;`);
    const planted = await until("the planted code's outcomes", async () => {
      const r = (await tabRun(mark, `return window.__planted;`)).out;
      return r?.length >= PLANTED.length ? r : null;
    });
    assert.deepEqual([...planted].sort(), PLANTED);
    await sleep(300);
    assert.deepEqual(await counters(), { webrtc: before.webrtc, geo: before.geo });
    assert.equal(await peerConnections(), before.connections);
    assert.deepEqual(newHits(before.hits), {});

    await userReload(mark);
    const after = (
      await tabRun(
        mark,
        `return {
           lan: await fetch("http://lan.local:" + location.port + "/hit?reloaded").then(r => "status " + r.status, e => e.name),
           notification: Function.prototype.toString.call(Notification).startsWith("function Notification("),
           planted: window.__planted ?? null,
         };`
      )
    ).out;
    assert.deepEqual(after, { lan: "status 200", notification: true, planted: null });
    if (!MAC) {
      // The real APIs reach MediaManager and the provider again.
      await reachesBoth(mark);
    }
  } finally {
    await env.chrome(`Services.prefs.clearUserPref("zenius.handoff.quietReload"); return true;`).catch(() => {});
    await removeTabs(mark).catch(() => {});
  }
});

test("in a kept page where the agent's code ran, the user's own navigation goes through; the code's doesn't", async () => {
  const mark = `zo-kept-nav-${Date.now()}`;
  const port = new URL(vectors.base).port;
  try {
    await keptWithPlantedCode(mark);
    const before = hits();
    await tabRun(mark, `setTimeout(() => { location.href = "http://lan.local:${port}/hit?code-navigation"; }, 0); return 1;`);
    await sleep(1000);
    assert.deepEqual(newHits(before), {}, "the code's navigation was refused");
    await env.chrome(
      `const tab = [...(win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs)].find(t => t.hasAttribute(arg.mark));
       tab.linkedBrowser.loadURI(Services.io.newURI(arg.url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
       return true;`,
      { mark, url: `http://lan.local:${port}/hit?typed` }
    );
    await until("the user's load", () => newHits(before).typed === 1);
  } finally {
    await env.chrome(`Services.prefs.clearUserPref("zenius.handoff.quietReload"); return true;`).catch(() => {});
    await removeTabs(mark).catch(() => {});
  }
});

test("a load the user starts in a task's tab during their hold is refused, and zen-ux's notice hears of it", () =>
  env.inSpace("local network typed", async page => {
    const port = new URL(vectors.base).port;
    await page.goto(`${vectors.base}/plain?typed`);
    await env.chrome(
      `win.__zoNotices = [];
       const L = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/localnet.sys.mjs");
       win.__zoUnlisten = L.onUserLoadRefused(n => win.__zoNotices.push({ url: n.url, origin: n.origin, reason: n.reason, typed: n.typed, scope: n.scope, same: n.browser === ctx.resolvePage(arg).browser }));
       return true;`,
      page.P
    );
    const before = hits();
    try {
      await page.call("spaces.handOff", { reason: "manual_takeover" });
      await env.chrome(
        `ctx.resolvePage(arg.P).browser.loadURI(Services.io.newURI(arg.url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
         return true;`,
        { P: page.P, url: `http://lan.local:${port}/hit?typed-hold` }
      );
      const notices = await until("the notice", () => env.chrome(`return win.__zoNotices.length ? win.__zoNotices : null;`));
      assert.deepEqual(notices, [
        { url: `http://lan.local:${port}/hit?typed-hold`, origin: `http://lan.local:${port}`, reason: "a .local name", typed: true, scope: "task", same: true },
      ]);
      await page.call("spaces.takeOver");
      assert.deepEqual(newHits(before), {});
    } finally {
      await env.chrome(`win.__zoUnlisten?.(); delete win.__zoUnlisten; delete win.__zoNotices; return true;`).catch(() => {});
    }
  }));

test("a kept page on a site where the agent's code ran elsewhere is the user's: with no evidence, its camera request reaches MediaManager", async () => {
  const mark = `zo-kept-site-${Date.now()}`;
  const space = await env.call("spaces.create", { name: `kept site ${Date.now() % 100000}` });
  let finished = false;
  try {
    // The agent's code runs in p1 only; p2 is another page of the same site.
    await env.call("page.goto", { space: space.id, page: "p1", url: `${vectors.base}/plain?code` });
    await env.call("page.evaluate", { space: space.id, page: "p1", fn: "() => 1", isFunction: true });
    const { label } = await env.call("pages.new", { space: space.id, url: `${vectors.base}/plain?same-site` });
    await env.chrome(`ctx.resolvePage(arg.P).tab.setAttribute(arg.mark, "kept"); return true;`, { P: { space: space.id, page: label }, mark });
    await env.call("spaces.finish", { space: space.id, keep: ["p1", label] });
    finished = true;
    const before = await counters();
    const { browserId, out } = await tabRun(mark, `return await navigator.mediaDevices.getUserMedia({ video: true }).then(() => "granted", e => e.name);`);
    assert.equal(out, "NotAllowedError", "the counter's no");
    assert.deepEqual((await webrtcRequests()).slice(before.webrtc), [browserId], "the request reached the parent");
  } finally {
    if (!finished) {
      await env.call("spaces.finish", { space: space.id, keep: [] }).catch(() => {});
    }
    await removeTabs(mark).catch(() => {});
    await env.chrome(
      `for (const t of [...(win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs)].filter(t => /plain\\?code$/.test(t.linkedBrowser.currentURI?.spec ?? ""))) win.gBrowser.removeTab(t); return true;`
    ).catch(() => {});
  }
});

test("a link the user clicks in a kept page the agent's code wrote: the press loads a clean copy first, so the agent's link is gone and nothing reaches the local network", async () => {
  const mark = `zo-kept-link-${Date.now()}`;
  const port = new URL(vectors.base).port;
  const space = await env.call("spaces.create", { name: `kept link ${Date.now() % 100000}` });
  const P = { space: space.id, page: "p1" };
  let finished = false;
  await env.chrome(
    `win.__zoNotices = [];
     const L = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/localnet.sys.mjs");
     win.__zoUnlisten = L.onUserLoadRefused(n => win.__zoNotices.push({ url: n.url, typed: n.typed, scope: n.scope }));
     return true;`
  );
  try {
    await env.call("page.goto", { ...P, url: `${vectors.base}/plain?kept-link` });
    // The agent's code adds the link: the page ran it. And a style sheet,
    // so the page is hooked: a link alone is no evidence, and the typing
    // guard holds the user's press only in a hooked page (the input layer's glue).
    await env.call("page.evaluate", {
      ...P,
      fn: `() => { const a = document.createElement("a"); a.id = "lan"; a.href = "http://lan.local:${port}/hit?kept-link"; a.textContent = "the printer"; document.body.append(a); document.head.append(document.createElement("style")); }`,
      isFunction: true,
    });
    await env.chrome(`ctx.resolvePage(arg.P).tab.setAttribute(arg.mark, "kept"); return true;`, { P, mark });
    await env.chrome(`Services.prefs.setBoolPref("zenius.handoff.quietReload", false); return true;`); // stays written: a failed clean reload
    await env.call("spaces.finish", { space: space.id, keep: ["p1"] });
    finished = true;
    const before = hits();
    const find = `[...(win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs)].find(t => t.hasAttribute(arg.mark))`;
    const beforeId = await env.chrome(`return ${find}.linkedBrowser.browsingContext.currentWindowGlobal.innerWindowId;`, { mark });
    // The user clicks it, as a user does: with user activation.
    await env.chrome(
      `const tab = [...(win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs)].find(t => t.hasAttribute(arg));
       return await ctx.content(tab.linkedBrowser.browsingContext, "dev#evalContent", {
         privileged: true,
         code: \`const el = actor.document.querySelector("#lan");
           const r = el.getBoundingClientRect(); const w = actor.contentWindow;
           w.synthesizeMouseEvent("mousedown", r.x + r.width / 2, r.y + r.height / 2, { button: 0, buttons: 1, clickCount: 1 }, {});
           w.synthesizeMouseEvent("mouseup", r.x + r.width / 2, r.y + r.height / 2, { button: 0, buttons: 0, clickCount: 1 }, {});
           return true\`,
       });`,
      mark
    );
    // The page holds the agent's writes, so the user's press waits for a
    // clean copy (the core's cleanOnDemand): the link the agent
    // added is gone before the press could follow it.
    await until("the clean copy", () =>
      env.chrome(
        `const b = ${find}.linkedBrowser;
         const id = b.browsingContext.currentWindowGlobal?.innerWindowId ?? 0;
         return id && id !== arg.beforeId && !b.webProgress?.isLoadingDocument;`,
        { mark, beforeId }
      )
    );
    assert.equal((await tabRun(mark, `return !!document.querySelector("#lan");`)).out, false, "the agent's link is gone");
    await sleep(300);
    assert.deepEqual(await env.chrome(`return win.__zoNotices;`), [], "no load was refused");
    assert.deepEqual(newHits(before), {});
  } finally {
    await env.chrome(`Services.prefs.clearUserPref("zenius.handoff.quietReload"); return true;`).catch(() => {});
    await env.chrome(`win.__zoUnlisten?.(); delete win.__zoUnlisten; delete win.__zoNotices; return true;`).catch(() => {});
    if (!finished) {
      await env.call("spaces.finish", { space: space.id, keep: [] }).catch(() => {});
    }
    await removeTabs(mark).catch(() => {});
  }
});

test("a plain link the agent's code wrote in a kept page is no evidence, so the user's click follows it with no clean copy first; the local network stays refused there, since the agent wrote into the page, and zen-ux's notice hears of it", async () => {
  const mark = `zo-kept-plain-link-${Date.now()}`;
  const port = new URL(vectors.base).port;
  const space = await env.call("spaces.create", { name: `kept plain link ${Date.now() % 100000}` });
  const P = { space: space.id, page: "p1" };
  let finished = false;
  await env.chrome(
    `win.__zoNotices = [];
     const L = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/localnet.sys.mjs");
     win.__zoUnlisten = L.onUserLoadRefused(n => win.__zoNotices.push({ url: n.url, typed: n.typed, scope: n.scope }));
     return true;`
  );
  try {
    await env.call("page.goto", { ...P, url: `${vectors.base}/plain?kept-plain-link` });
    await env.call("page.evaluate", {
      ...P,
      fn: `() => { const a = document.createElement("a"); a.id = "lan"; a.href = "http://lan.local:${port}/hit?kept-plain-link"; a.textContent = "the printer"; document.body.append(a); }`,
      isFunction: true,
    });
    assert.deepEqual(
      await env.chrome(
        `const EV = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/evidence.sys.mjs");
         return EV.evidenceOf(ctx.resolvePage(arg.P).browser);`,
        { P }
      ),
      {},
      "a plain link is no evidence"
    );
    await env.chrome(`ctx.resolvePage(arg.P).tab.setAttribute(arg.mark, "kept"); return true;`, { P, mark });
    await env.call("spaces.finish", { space: space.id, keep: ["p1"] });
    finished = true;
    const before = hits();
    const find = `[...(win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs)].find(t => t.hasAttribute(arg.mark))`;
    // The user clicks it, as a user does: with user activation.
    await env.chrome(
      `const tab = [...(win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs)].find(t => t.hasAttribute(arg));
       return await ctx.content(tab.linkedBrowser.browsingContext, "dev#evalContent", {
         privileged: true,
         code: \`const el = actor.document.querySelector("#lan");
           const r = el.getBoundingClientRect(); const w = actor.contentWindow;
           w.synthesizeMouseEvent("mousedown", r.x + r.width / 2, r.y + r.height / 2, { button: 0, buttons: 1, clickCount: 1 }, {});
           w.synthesizeMouseEvent("mouseup", r.x + r.width / 2, r.y + r.height / 2, { button: 0, buttons: 0, clickCount: 1 }, {});
           return true\`,
       });`,
      mark
    );
    // No evidence, so no clean copy: the press follows the agent's link. The
    // agent's code wrote into the page, though, so the task's refusals stay
    // in it (observe/agentcode.sys.mjs keeps a written page's mark), the
    // local network's among them; the user's own typed load would go.
    await until("the refused load", async () => (await env.chrome(`return win.__zoNotices.length;`)) > 0);
    await sleep(300);
    assert.deepEqual(await env.chrome(`return win.__zoNotices;`), [{ url: `http://lan.local:${port}/hit?kept-plain-link`, typed: false, scope: "agentCode" }]);
    assert.deepEqual(newHits(before), {});
    assert.equal(await env.chrome(`return ${find}.linkedBrowser.currentURI.spec;`, { mark }), `${vectors.base}/plain?kept-plain-link`);
    assert.equal((await tabRun(mark, `return !!document.querySelector("#lan");`)).out, true, "the agent's link is still there: no clean copy");
  } finally {
    await env.chrome(`win.__zoUnlisten?.(); delete win.__zoUnlisten; delete win.__zoNotices; return true;`).catch(() => {});
    if (!finished) {
      await env.call("spaces.finish", { space: space.id, keep: [] }).catch(() => {});
    }
    await removeTabs(mark).catch(() => {});
  }
});
