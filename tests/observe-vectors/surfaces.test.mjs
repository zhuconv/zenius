// Surfaces an agent page may not open over the user's view (I1) or outside
// the browser (I4), from the I1/I4 sweep (docs/research/observe.md §10):
// print, HTTP sign-in, dialogs in frames, downloads under the user's "always
// ask" settings, beforeunload. Each runs in a hidden agent tab and in one
// the user is watching; env.inSpace checks the user's view around it.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "../observe/lib.mjs";
import { startVectorServer } from "../observe/vectors/fixture.mjs";

let env;
let vectors;
before(async () => {
  env = await setup();
  vectors = await startVectorServer();
});
after(async () => {
  vectors?.server.close();
  await env?.close();
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Everything outside the page that could show: dialogs, windows,
 * doorhangers, notification bars, fullscreen, focus, and the pop-up
 * blocker's count (which would show its bar when the user opens the tab).
 * Also which tab shows and whether the window is active: Firefox clears
 * focus when a tab switch starts, so a change in `focused` alone points at
 * neither.
 */
const outside = page =>
  env.chrome(
    `const { browser: b, tab } = ctx.resolvePage(arg);
     const w = win; // the dev sandbox doesn't see b.ownerGlobal; tests have one window
     const box = w.gBrowser.getTabDialogBox(b);
     const el = Services.focus.focusedElement;
     const bars = n => [...(n?.allNotifications ?? [])].map(x => x.getAttribute("value"));
     return {
       tabDialogs: box.getTabDialogManager()._dialogs.length + box.getContentDialogManager()._dialogs.length,
       windowDialog: !!w.gDialogBox?.isOpen,
       windows: [...Services.wm.getEnumerator(null)].length,
       doorhangers: w.PopupNotifications._currentNotifications.filter(n => n.browser === b).map(n => n.id),
       bars: [...bars(w.gBrowser.readNotificationBox(b)), ...bars(w.gNotificationBox)],
       fullscreen: !!w.fullScreen || !!w.document.fullscreenElement,
       blockedPopups: Cu.waiveXrays(b).popupAndRedirectBlocker.getBlockedPopupCount(),
       focused: el ? el.localName + (el.id ? "#" + el.id : "") : null,
       selected: w.gBrowser.selectedTab === tab,
       active: Services.focus.activeWindow === w,
     };`,
    page.P
  );

/** Play the user: open the agent's Space so its page shows. Returns a function that goes back. */
async function watch(page) {
  const userWs = await env.chrome(
    `const { tab, space: rec } = ctx.resolvePage(arg);
     const userWs = win.gZenWorkspaces.activeWorkspace;
     await win.gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
     // A Space shared by tasks (the Agents Space) opens on its last tab, which
     // can be another task's.
     win.gBrowser.selectedTab = tab;
     for (const end = Date.now() + 3000; win.gBrowser.selectedTab !== tab; ) {
       if (Date.now() > end) throw new Error("the agent's tab wasn't selected");
       await new Promise(r => win.setTimeout(r, 25));
     }
     return userWs;`,
    page.P
  );
  return () => env.chrome(`await win.gZenWorkspaces.changeWorkspaceWithID(arg);`, userWs);
}

/** Run `fn(page, how)` hidden, then with the user watching. */
async function bothViews(name, fn) {
  await env.inSpace(`${name} (hidden)`, page => fn(page, "hidden"));
  await env.inSpace(`${name} (watched)`, async page => {
    await page.goto(`${vectors.base}/plain`);
    const back = await watch(page);
    try {
      await fn(page, "watched");
    } finally {
      await back();
    }
  });
}

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

test("window.print() opens no print dialog; the agent hears of it", () =>
  bothViews("print", async (page, how) => {
    await page.goto(`${vectors.base}/vectors`);
    const before = await outside(page);
    await page.call("page.events");
    // By the agent (a trusted click, with user activation) …
    const receipt = await page.call("page.click", { target: "#v-print" });
    // … and by the page's own script.
    await runVectors(page, `setTimeout(() => window.__vectors.print(), 0); 1`);
    await sleep(500);
    assert.deepEqual(await outside(page), before, `${how}: nothing opened and focus stayed`);
    assert.deepEqual(await results(page, "print"), ["beforeprint", "print() returned", "beforeprint", "print() returned"]);
    const events = await refusedEvents(page);
    assert.equal(events.length, 2, JSON.stringify(events));
    assert.equal(events[0].kind, "print");
    assert.match(events[0].message, /window\.print\(\)/);
    assert.equal(events[0].url, `${vectors.base}/vectors`);
    assert.deepEqual(receipt.refused?.map(r => r.kind), ["print"], JSON.stringify(receipt));
  }));

test("an HTTP sign-in request shows no dialog: the 401 page loads, and the receipt says why", () =>
  bothViews("http auth", async (page, how) => {
    await page.goto(`${vectors.base}/vectors`);
    const before = await outside(page);
    await page.call("page.events");
    const receipt = await page.goto(`${vectors.base}/auth`);
    assert.deepEqual(receipt.refused?.map(r => r.kind), ["httpAuth"], JSON.stringify(receipt));
    assert.match(receipt.refused[0].message, /realm "zenius vectors"/);
    assert.equal(await page.call("page.title"), "401");
    // A fetch from the page gets the 401 response, without a dialog either.
    await page.goto(`${vectors.base}/vectors`);
    await runVectors(page, `setTimeout(() => window.__vectors["auth-fetch"](), 0); 1`);
    await sleep(500);
    assert.deepEqual(await results(page, "auth-fetch"), ["fetch 401"]);
    assert.deepEqual(await outside(page), before, `${how}: nothing opened and focus stayed`);
    const kinds = (await refusedEvents(page)).map(e => e.kind);
    assert.deepEqual(kinds, ["httpAuth", "httpAuth"]);
  }));

test("dialogs in same- and cross-origin frames are held for the agent", () =>
  bothViews("frame dialogs", async (page, how) => {
    await page.goto(`${vectors.base}/vectors`);
    const before = await outside(page);
    for (const id of ["dialog-iframe-same", "dialog-iframe-cross"]) {
      const receipt = await page.call("page.click", { target: `#v-${id}` });
      // The click posts a message; the frame's confirm() opens a moment later.
      const info = receipt.dialog ? receipt : await waitForDialog(page);
      assert.equal(info.dialog.type, "confirm", `${how} ${id}: ${JSON.stringify(info)}`);
      assert.equal(info.dialog.message, "frame confirm");
      assert.deepEqual(await outside(page), before, `${how} ${id}: no dialog UI`);
      assert.equal(await page.call("page.dismissDialog"), true);
    }
    await sleep(200);
    assert.deepEqual(await results(page, "frames"), ["confirm false", "confirm false"]);
  }));

async function waitForDialog(page) {
  for (let end = Date.now() + 3000; Date.now() < end; await sleep(50)) {
    const info = await page.call("page.info");
    if (info.dialog) {
      return info;
    }
  }
  return {};
}

test("a link to another app (mailto:) opens no dialog and no app; the agent hears of it", () =>
  bothViews("external app", async (page, how) => {
    await page.goto(`${vectors.base}/vectors`);
    const before = await outside(page);
    await page.call("page.events");
    // the Linux server has a mailto: handler, so Firefox would ask in a tab-modal dialog.
    await page.call("page.click", { target: "#v-mailto" });
    await runVectors(page, `setTimeout(() => window.__vectors.mailto(), 0); 1`);
    await sleep(800);
    assert.deepEqual(await outside(page), before, `${how}: nothing opened and focus stayed`);
    const events = await refusedEvents(page);
    assert.deepEqual(events.map(e => e.kind), ["externalApp", "externalApp"], JSON.stringify(events));
    assert.equal(events[0].url, "mailto:zenius@example.invalid");
    assert.match(events[0].message, /never leave the browser/);
    assert.equal(await page.call("page.url"), `${vectors.base}/vectors`);
  }));


// The user's daily profile may say "always ask where to save" and "always
// ask what to do with new types": agent downloads still never ask.
test("downloads under the user's 'always ask' settings open no picker and no dialog", () =>
  bothViews("downloads always ask", async (page, how) => {
    const prefs = {
      "browser.download.useDownloadDir": false,
      "browser.download.always_ask_before_handling_new_types": true,
    };
    const old = await env.chrome(
      `const old = {};
       for (const [name, value] of Object.entries(arg)) {
         old[name] = Services.prefs.prefHasUserValue(name) ? Services.prefs.getBoolPref(name) : null;
         Services.prefs.setBoolPref(name, value);
       }
       return old;`,
      prefs
    );
    try {
      await page.goto(`${vectors.base}/vectors`);
      const before = await outside(page);
      for (const [id, name] of [["download-attachment", "vector.txt"], ["download-unknown", "unknown"]]) {
        const waiting = page.call("page.waitForEvent", { event: "download", options: { timeout: 5000 } });
        await page.call("page.click", { target: `#v-${id}` });
        const d = await waiting;
        assert.equal(d.suggestedFilename, name, `${how} ${id}`);
        assert.equal(await env.call("download.failure", { download: d.download }), null);
        assert.deepEqual(await outside(page), before, `${how} ${id}: no picker, no dialog, focus stayed`);
        await env.call("download.delete", { download: d.download });
      }
    } finally {
      await env.chrome(
        `for (const [name, value] of Object.entries(arg)) {
           if (value === null) Services.prefs.clearUserPref(name); else Services.prefs.setBoolPref(name, value);
         }`,
        old
      );
    }
  }));

// Ego's requirement (native-javascript-dialog-requirement.md): after a
// trusted click, beforeunload is the agent's dialog, reported before it
// chooses whether the navigation may go on.
test("beforeunload after an agent click is the agent's dialog, with no UI", () =>
  bothViews("beforeunload", async (page, how) => {
    await page.goto(`${vectors.base}/vectors`);
    const before = await outside(page);
    await page.call("page.click", { target: "#v-beforeunload" });
    await page.call("page.events");
    const leave = await page.goto(`${vectors.base}/plain`, { timeout: 5000 });
    assert.deepEqual(leave, { dialog: { type: "beforeunload", message: "", url: `${vectors.base}/vectors` } }, how);
    assert.ok((await page.call("page.events")).some(e => e.method === "Page.javascriptDialogOpening" && e.params.type === "beforeunload"));
    assert.deepEqual(await outside(page), before, `${how}: no dialog UI, focus stayed`);
    // Stay, then leave.
    assert.equal(await page.call("page.dismissDialog"), true);
    assert.equal(await page.call("page.url"), `${vectors.base}/vectors`);
    const again = await page.goto(`${vectors.base}/plain`, { timeout: 5000 });
    assert.equal(again.dialog?.type, "beforeunload");
    assert.equal(await page.call("page.acceptDialog"), true);
    await page.call("page.waitForURL", { matcher: { type: "regex", value: "/plain$", flags: "" }, options: { timeout: 5000 } });
  }));

// The refusals that need no UI (§10): the page gets the denial it already
// handles, the agent a Zenius.refused event, and the user nothing.

/** Set prefs for the duration of `fn`, then restore them. */
async function withPrefs(prefs, fn) {
  const old = await env.chrome(
    `const old = {};
     for (const [name, value] of Object.entries(arg)) {
       old[name] = Services.prefs.prefHasUserValue(name) ? Services.prefs.getBoolPref(name) : null;
       Services.prefs.setBoolPref(name, value);
     }
     return old;`,
    prefs
  );
  try {
    return await fn();
  } finally {
    await env.chrome(
      `for (const [name, value] of Object.entries(arg)) {
         if (value === null) Services.prefs.clearUserPref(name); else Services.prefs.setBoolPref(name, value);
       }`,
      old
    );
  }
}

/** Fire `ids` by agent clicks, then the same from page script; return the first click's receipt. */
async function fireBoth(page, ids) {
  let first;
  for (const id of ids) {
    const receipt = await page.call("page.click", { target: `#v-${id}` });
    first ??= receipt;
  }
  await runVectors(page, `setTimeout(() => { for (const id of ${JSON.stringify(ids)}) window.__vectors[id](); }, 0); 1`);
  await sleep(600);
  return first;
}

test("fullscreen and pointer lock are denied: the window and the pointer stay the user's", () =>
  bothViews("fullscreen", async (page, how) => {
    await page.goto(`${vectors.base}/vectors`);
    await runVectors(page, `document.addEventListener("fullscreenerror", () => (window.__vectorResults.fsError = (window.__vectorResults.fsError ?? 0) + 1)); 1`);
    const before = await outside(page);
    await page.call("page.events");
    const receipt = await fireBoth(page, ["fullscreen", "pointerlock"]);
    assert.deepEqual(await outside(page), before, `${how}: no fullscreen, nothing opened, focus stayed`);
    assert.deepEqual(await results(page, "fullscreen"), ["rejected TypeError", "rejected TypeError"]);
    assert.equal(await results(page, "fsError"), 2);
    assert.deepEqual(await results(page, "pointerlock"), ["pointerlock error", "pointerlock error"]);
    assert.equal(await page.evaluate(`String(!!document.fullscreenElement) + " " + String(!!document.pointerLockElement)`), "false false");
    const events = await refusedEvents(page);
    assert.deepEqual(events.map(e => e.kind).sort(), ["fullscreen", "fullscreen", "pointerLock", "pointerLock"], JSON.stringify(events));
    assert.equal(events[0].url, `${vectors.base}/vectors`);
    assert.deepEqual(receipt.refused?.map(r => r.kind), ["fullscreen"], JSON.stringify(receipt));
  }));

test("wake lock, speech and navigator.share are refused in agent tabs", () =>
  // navigator.share exists where the OS has a share sheet (macOS, Windows);
  // the pref adds it on Linux. It applies to documents created after it.
  withPrefs({ "dom.webshare.enabled": true }, () =>
    bothViews("wake lock, speech, share", async (page, how) => {
      await page.goto(`${vectors.base}/vectors`);
      const before = await outside(page);
      await page.call("page.events");
      const receipt = await fireBoth(page, ["wake-lock", "speech", "share"]);
      assert.deepEqual(await outside(page), before, `${how}: nothing opened and focus stayed`);
      assert.deepEqual(await results(page, "wake-lock"), ["NotAllowedError", "NotAllowedError"]);
      assert.deepEqual(await results(page, "speech"), ["error synthesis-unavailable", "error synthesis-unavailable"]);
      assert.deepEqual(await results(page, "share"), ["AbortError", "AbortError"]);
      assert.equal(await page.evaluate(`String(speechSynthesis.speaking || speechSynthesis.pending)`), "false");
      const kinds = (await refusedEvents(page)).map(e => e.kind);
      assert.deepEqual(kinds, ["wakeLock", "speech", "share", "wakeLock", "speech", "share"]);
      assert.deepEqual(receipt.refused?.map(r => r.kind), ["wakeLock"], JSON.stringify(receipt));
    })
  ));

test("a page's add-on (.xpi) is refused before any prompt, and nothing is installed", () =>
  bothViews("add-on install", async (page, how) => {
    await page.goto(`${vectors.base}/vectors`);
    const before = await outside(page);
    await page.call("page.events");
    // The click returns before the response arrives, so the refusal comes
    // as an event only.
    await fireBoth(page, ["xpi"]);
    assert.deepEqual(await outside(page), before, `${how}: no doorhanger, nothing opened, focus stayed`);
    const events = await refusedEvents(page);
    assert.deepEqual(events.map(e => e.kind), ["addonInstall", "addonInstall"], JSON.stringify(events));
    assert.equal(events[0].url, `${vectors.base}/addon.xpi`);
    assert.match(events[0].message, /never install add-ons/);
    assert.equal(await page.call("page.url"), `${vectors.base}/vectors`);
    const installs = await env.chrome(
      `const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
       return (await AddonManager.getAllInstalls()).length;`
    );
    assert.equal(installs, 0);
    // goto() an .xpi fails as for a download, and says why.
    const went = await env.fail("page.goto", { ...page.P, url: `${vectors.base}/addon.xpi` });
    assert.equal(went.code, "ZEN_NAVIGATION_FAILED");
    assert.match(went.message, /^page\.goto failed: The navigation led to a browser add-on/);
    assert.deepEqual(went.data.refused?.map(r => r.kind), ["addonInstall"], JSON.stringify(went));
    assert.equal(await page.call("page.url"), `${vectors.base}/vectors`);
    assert.deepEqual(await outside(page), before);
  }));

test("a pop-up the browser blocks shows no bar; the agent hears which one", () =>
  bothViews("popup blocked", async (page, how) => {
    await page.goto(`${vectors.base}/vectors`);
    const before = await outside(page);
    await page.call("page.events");
    // Page script, without user activation: the blocker stops it.
    await runVectors(page, `setTimeout(() => window.__vectors["popup-window"](), 0); 1`);
    await sleep(600);
    assert.deepEqual(await outside(page), before, `${how}: no bar, no count for later, nothing opened`);
    assert.deepEqual(await results(page, "popup-window"), ["blocked"]);
    const events = await refusedEvents(page);
    assert.deepEqual(events.map(e => e.kind), ["popupBlocked"], JSON.stringify(events));
    assert.equal(events[0].url, `${vectors.base}/plain?popup-window`);
    assert.match(events[0].message, /page\.click/);
    assert.deepEqual((await page.call("pages.list")).map(p => p.label ?? p.page), ["p1"]);
  }));

test("registerProtocolHandler is refused with no bar; the user's handlers don't change", () =>
  bothViews("protocol handler", async (page, how) => {
    await page.goto(`${vectors.base}/vectors`);
    const before = await outside(page);
    await page.call("page.events");
    const receipt = await fireBoth(page, ["protocol-handler"]);
    assert.deepEqual(await outside(page), before, `${how}: no bar, nothing opened, focus stayed`);
    // The call returns nothing either way, so the page sees no difference.
    assert.deepEqual(await results(page, "protocol-handler"), ["registered", "registered"]);
    const events = await refusedEvents(page);
    assert.deepEqual(events.map(e => e.kind), ["protocolHandler", "protocolHandler"], JSON.stringify(events));
    assert.match(events[0].message, /web\+zenius/);
    assert.deepEqual(receipt.refused?.map(r => r.kind), ["protocolHandler"], JSON.stringify(receipt));
    const handlers = await env.chrome(
      `const info = Cc["@mozilla.org/uriloader/external-protocol-service;1"]
         .getService(Ci.nsIExternalProtocolService).getProtocolHandlerInfo("web+zenius");
       return info.possibleApplicationHandlers.length;`
    );
    assert.equal(handlers, 0);
  }));

/** The tab's sound: muted (by anyone), muted by zenius, and Gecko's "audible" attribute. */
const sound = page =>
  env.chrome(
    `const { browser, tab } = ctx.resolvePage(arg);
     return {
       muted: browser.browsingContext.mediaController.isMuted,
       zenius: tab.hasAttribute("zenius-muted"),
       heard: tab.hasAttribute("zenius-muted-sound"),
       audible: browser.browsingContext.mediaController.isAudible,
     };`,
    page.P
  );

async function until(what, fn, ms = 3000) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    last = await fn();
    if (last) {
      return last;
    }
  }
  assert.fail(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
}

// An <audio> never put in the document (new Audio()) sends its events to
// itself only: the media guard hears it when the page plays it.
test("a new Audio() never put in the document is heard too: muted, and the agent told", () =>
  env.inSpace("audio detached", async page => {
    await page.goto(`${vectors.base}/plain`);
    await page.evaluate(`(() => {
      const rate = 8000, n = rate, buf = new ArrayBuffer(44 + n * 2), d = new DataView(buf);
      const w = (o, s) => [...s].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
      w(0, "RIFF"); d.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); d.setUint32(16, 16, true);
      d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, rate, true); d.setUint32(28, rate * 2, true);
      d.setUint16(32, 2, true); d.setUint16(34, 16, true); w(36, "data"); d.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) d.setInt16(44 + i * 2, Math.sin(i / 3) * 8000, true);
      const wav = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
      const b = document.createElement("button");
      b.id = "detached"; b.textContent = "detached"; b.style.cssText = "display:block;font-size:30px";
      b.onclick = () => { window.__detached = new Audio(wav); window.__detached.loop = true; window.__detached.play(); };
      document.body.prepend(b);
      return 1;
    })()`);
    await page.call("page.events");
    await page.call("page.click", { target: "#detached" });
    await until("heard", async () => (await sound(page)).heard);
    assert.deepEqual(await sound(page), { muted: true, zenius: true, heard: true, audible: false });
    assert.equal(await page.evaluate("String(window.__detached.paused)"), "false");
    assert.deepEqual((await refusedEvents(page)).map(e => e.kind), ["audio"]);
    await page.evaluate("window.__detached.pause(); 1");
  }));

test("agent tabs make sound only while the user can see them; the page plays on silently", async () => {
  await env.inSpace("audio (hidden)", async page => {
    await page.goto(`${vectors.base}/vectors`);
    const before = await outside(page);
    assert.deepEqual(await sound(page), { muted: true, zenius: true, heard: false, audible: false });
    await page.call("page.events");
    await runVectors(page, `window.__toneMs = 60000; 1`);
    const receipt = await page.call("page.click", { target: "#v-tone" });
    await page.call("page.click", { target: "#v-audio" });
    await sleep(600);
    // The page plays: its clock runs and its media plays.
    assert.equal(await env.call("dev.evalContent", { ...page.P, code: `window.__tone.state` }), "running");
    assert.deepEqual(await results(page, "audio"), ["playing"]);
    assert.equal(await env.call("dev.evalContent", { ...page.P, code: `String(window.__audio.paused)` }), "false");
    // The user hears nothing, and the agent hears why, once per muted spell.
    assert.deepEqual(await sound(page), { muted: true, zenius: true, heard: true, audible: false });
    const events = await refusedEvents(page);
    assert.deepEqual(events.map(e => e.kind), ["audio"], JSON.stringify(events));
    assert.match(events[0].message, /can't see this tab/);
    assert.deepEqual(receipt.refused?.map(r => r.kind), ["audio"], JSON.stringify(receipt));
    assert.deepEqual(await outside(page), before);
    // The user opens the tab: the sound comes back. They leave: muted again,
    // and the agent hears of it, since the tone still plays.
    const back = await watch(page);
    try {
      await until("the sound back", async () => {
        const s = await sound(page);
        return !s.muted && !s.zenius && s.audible && s;
      });
    } finally {
      await back();
    }
    await until("muted again", async () => (await sound(page)).zenius);
    assert.deepEqual(await sound(page), { muted: true, zenius: true, heard: true, audible: false });
    assert.deepEqual((await refusedEvents(page)).map(e => e.kind), ["audio"]);
    await env.call("dev.evalContent", { ...page.P, code: `window.__tone.close(); 1` });
    // A cross-site page (another process) stays muted, and the agent hears
    // when it, too, plays.
    await page.goto(`${vectors.crossBase}/vectors`);
    assert.deepEqual(await sound(page), { muted: true, zenius: true, heard: true, audible: false });
    await page.call("page.events");
    await page.call("page.click", { target: "#v-tone" });
    // page.events() hands each event out once.
    const kinds = await until("the new page's event", async () => {
      const k = (await refusedEvents(page)).map(e => e.kind);
      return k.length && k;
    });
    assert.deepEqual(kinds, ["audio"]);
    assert.deepEqual(await sound(page), { muted: true, zenius: true, heard: true, audible: false });
  });

  await env.inSpace("audio (watched)", async page => {
    await page.goto(`${vectors.base}/plain`);
    const back = await watch(page);
    try {
      await page.goto(`${vectors.base}/vectors`);
      await page.call("page.events");
      await runVectors(page, `window.__toneMs = 60000; 1`);
      await page.call("page.click", { target: "#v-tone" });
      await until("audible", async () => (await sound(page)).audible);
      assert.deepEqual(await sound(page), { muted: false, zenius: false, heard: false, audible: true });
      assert.deepEqual(await refusedEvents(page), []);
    } finally {
      await back();
    }
    await until("muted when the user left", async () => (await sound(page)).zenius);
    assert.deepEqual((await refusedEvents(page)).map(e => e.kind), ["audio"]);
    await env.call("dev.evalContent", { ...page.P, code: `window.__tone.close(); 1` });
  });

  // The user's own mute button wins: a tab they unmuted stays audible, hidden or not.
  await env.inSpace("audio (the user's choice)", async page => {
    await page.goto(`${vectors.base}/vectors`);
    assert.equal((await sound(page)).zenius, true);
    await env.chrome(`const { tab } = ctx.resolvePage(arg); tab.toggleMuteAudio();`, page.P);
    assert.deepEqual(await sound(page), { muted: false, zenius: false, heard: false, audible: false });
    await page.goto(`${vectors.base}/vectors?again`);
    const back = await watch(page);
    await back();
    assert.equal((await sound(page)).muted, false);
  });
});

/** Gecko's wake locks: video-playing keeps the user's display awake, audio-playing the Mac. */
const wakeLocks = () =>
  env.chrome(
    `const pm = Cc["@mozilla.org/power/powermanagerservice;1"].getService(Ci.nsIPowerManagerService);
     return { video: pm.getWakeLockState("video-playing"), audio: pm.getWakeLockState("audio-playing") };`
  );

/**
 * Seven players, started by a button (#players), on files the page records
 * first. They hold the display's wake lock: a video with an audio track
 * (window.__players.video), the same muted (mutedVideo), a MediaStream video
 * (streamVideo), and a muted video with an audio track in a closed shadow
 * tree, started by its autoplay attribute (shadowVideo). They don't: a video
 * without an audio track (silentVideo), a <video> playing sound only
 * (audioVideo), and an <audio> never put in the document (audio).
 */
const PLAYERS = `(async () => {
  const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32; document.body.append(canvas);
  const g = canvas.getContext("2d"); let k = 0;
  setInterval(() => { g.fillStyle = k++ % 2 ? "red" : "blue"; g.fillRect(0, 0, 32, 32); }, 30);
  const record = async stream => {
    const rec = new MediaRecorder(stream, { mimeType: "video/webm" }), parts = [];
    rec.ondataavailable = e => parts.push(e.data);
    const done = new Promise(r => (rec.onstop = r));
    rec.start(); await new Promise(r => setTimeout(r, 1200)); rec.stop(); await done;
    return URL.createObjectURL(new Blob(parts, { type: "video/webm" }));
  };
  // The context stays suspended (no click yet): the audio track is silent, and there.
  const ac = new AudioContext(), dest = ac.createMediaStreamDestination(), osc = ac.createOscillator();
  osc.connect(dest); osc.start();
  const withAudio = canvas.captureStream(30); withAudio.addTrack(dest.stream.getAudioTracks()[0]);
  const [sound, silent] = await Promise.all([record(withAudio), record(canvas.captureStream(30))]);
  ac.close();
  const rate = 8000, n = rate, buf = new ArrayBuffer(44 + n * 2), d = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); d.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); d.setUint32(16, 16, true);
  d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, rate, true); d.setUint32(28, rate * 2, true);
  d.setUint16(32, 2, true); d.setUint16(34, 16, true); w(36, "data"); d.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) d.setInt16(44 + i * 2, Math.sin(i / 3) * 8000, true);
  const wav = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  const b = document.createElement("button");
  b.id = "players"; b.textContent = "players"; b.style.cssText = "display:block;font-size:30px";
  b.onclick = () => {
    const video = document.createElement("video"); video.src = sound; video.loop = true;
    const mutedVideo = document.createElement("video"); mutedVideo.src = sound; mutedVideo.loop = true; mutedVideo.muted = true;
    const streamVideo = document.createElement("video"); streamVideo.muted = true; streamVideo.srcObject = canvas.captureStream(30);
    const silentVideo = document.createElement("video"); silentVideo.src = silent; silentVideo.loop = true;
    const audioVideo = document.createElement("video"); audioVideo.src = wav; audioVideo.loop = true;
    document.body.append(video, mutedVideo, streamVideo, silentVideo, audioVideo);
    const audio = new Audio(wav); audio.loop = true;
    const host = document.createElement("div"); document.body.append(host);
    const shadowVideo = document.createElement("video"); shadowVideo.src = sound; shadowVideo.loop = true; shadowVideo.muted = true;
    shadowVideo.autoplay = true; shadowVideo.onplaying = () => (window.__shadowPlayed = true);
    host.attachShadow({ mode: "closed" }).append(shadowVideo);
    const played = { video, mutedVideo, streamVideo, silentVideo, audioVideo, audio };
    window.__players = { ...played, shadowVideo };
    window.__played = {};
    for (const [name, el] of Object.entries(played)) {
      el.play().then(() => (window.__played[name] = "resolved"), e => (window.__played[name] = e.name));
    }
  };
  document.body.prepend(b);
  return true;
})()`;

const paused = page =>
  page.evaluate(`Object.fromEntries(Object.entries(window.__players).map(([k, el]) => [k, el.paused]))`);

/** rAF callbacks and setTimeout(0) runs in a second of the page's time. */
const RATES = `new Promise(resolve => {
  let raf = 0, tmo = 0; const t0 = performance.now();
  const f = () => { raf++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); }; requestAnimationFrame(f);
  const g = () => { tmo++; if (performance.now() - t0 < 1000) setTimeout(g, 0); }; setTimeout(g, 0);
  setTimeout(() => resolve({ raf, tmo, hidden: document.hidden }), 1100);
})`;

const mediaEvents = async page =>
  (await page.call("page.events")).filter(e => e.method === "Zenius.mediaPaused" || e.method === "Zenius.mediaResumed").map(e => [e.method, e.params.reason, e.params.count]);

test("a hidden agent tab's media that holds a wake lock pauses: none held, full-speed timers and rAF, and it resumes when the user looks", async () => {
  // Gecko keeps the audio lock 10 s after a player's sound stops; shortened
  // so the test needn't wait that long.
  await env.chrome(`Services.prefs.setIntPref("media.wakelock.audio.delay-releasing.ms", 100);`);
  try {
    await env.inSpace("media (hidden)", async page => {
      await page.goto(`${vectors.base}/plain`);
      await page.evaluate(PLAYERS);
      await page.call("page.events");
      await page.call("page.click", { target: "#players" });
      // What holds the display's lock pauses; the rest plays on, silently.
      const all = await until(
        "the lock holders paused",
        async () => {
          const p = await paused(page);
          const shadowPlayed = await page.evaluate("!!window.__shadowPlayed");
          return p.video && p.mutedVideo && p.streamVideo && p.shadowVideo && shadowPlayed && p;
        },
        5000
      );
      assert.deepEqual(all, {
        video: true,
        mutedVideo: true,
        streamVideo: true,
        shadowVideo: true,
        silentVideo: false,
        audioVideo: false,
        audio: false,
      });
      // The page's own play() calls succeeded: zenius paused after them.
      assert.deepEqual(await page.evaluate("window.__played"), {
        video: "resolved",
        mutedVideo: "resolved",
        streamVideo: "resolved",
        silentVideo: "resolved",
        audioVideo: "resolved",
        audio: "resolved",
      });
      // Gecko releases a paused player's lock through the parent, a moment later.
      await until("no wake lock", async () => {
        const l = await wakeLocks();
        return l.video === "unlocked" && l.audio === "unlocked" && l;
      });
      const rates = await page.evaluate(RATES);
      assert.equal(rates.hidden, false);
      assert.ok(rates.raf > 30 && rates.tmo > 100, JSON.stringify(rates));
      // The agent hears of each pause (gathered into few events).
      const told = [];
      await until(
        "the agent told",
        async () => {
          told.push(...(await mediaEvents(page)));
          return told.reduce((n, [, , count]) => n + count, 0) >= 4;
        },
        5000
      );
      assert.ok(told.every(([method, reason]) => method === "Zenius.mediaPaused" && reason === "hidden"), JSON.stringify(told));
      assert.equal(told.reduce((n, [, , count]) => n + count, 0), 4);

      // The agent pauses one itself: zenius won't resume that one.
      await page.evaluate("window.__players.mutedVideo.pause(); 1");
      const back = await watch(page);
      try {
        const shown = await until("resumed", async () => {
          const p = await paused(page);
          return !p.video && !p.streamVideo && !p.shadowVideo && p;
        });
        assert.deepEqual(shown, {
          video: false,
          mutedVideo: true,
          streamVideo: false,
          shadowVideo: false,
          silentVideo: false,
          audioVideo: false,
          audio: false,
        });
        assert.deepEqual(await mediaEvents(page), [["Zenius.mediaResumed", "hidden", 3]]);
        // While watched, playing is the user's business.
        assert.equal((await wakeLocks()).video, "locked-foreground");
      } finally {
        await back();
      }
      // Out of sight again: paused again, and the locks go.
      await until("paused again", async () => {
        const p = await paused(page);
        return p.video && p.streamVideo && p.shadowVideo && p;
      });
      assert.deepEqual(await mediaEvents(page), [["Zenius.mediaPaused", "hidden", 3]]);
      await until("no wake lock again", async () => {
        const l = await wakeLocks();
        return l.video === "unlocked" && l.audio === "unlocked" && l;
      });
      await page.evaluate("Object.values(window.__players).forEach(el => el.pause()); 1");
    });
  } finally {
    await env.chrome(`Services.prefs.clearUserPref("media.wakelock.audio.delay-releasing.ms");`);
  }
});

// Gecko keeps a page with an unload listener out of the bfcache, so the
// guards add none (zen-snapshot's bfcache test caught one). Under load a
// page can miss the bfcache once (zen-ux saw it), so it gets three tries: a
// listener like that blocks every one.
test("agent pages with the guards in still go to the bfcache", () =>
  env.inSpace("bfcache", async page => {
    const topId = () => env.chrome(`return ctx.resolvePage(arg).browser.browsingContext.id;`, page.P);
    const missed = [];
    for (let i = 0; i < 3; i++) {
      await page.goto(`${vectors.base}/cacheable?try=${i}`);
      // Why a try missed, should all three: the page's load and its group.
      const state = await env
        .call("dev.evalContent", {
          ...page.P,
          privileged: true,
          code: `const doc = actor.contentWindow.document;
                 return { ready: doc.readyState, loading: actor.docShell.isLoadingDocument, requests: doc.documentLoadGroup?.activeCount ?? null };`,
        })
        .catch(e => ({ error: e.message }));
      const toplevels = await env
        .chrome(`return ctx.resolvePage(arg).browser.browsingContext.group.getToplevels().length;`, page.P)
        .catch(e => e.message);
      const before = await topId();
      await page.goto(`${vectors.base}/cacheable?try=${i}&after=1`);
      const after = await topId();
      if (after !== before && (await env.chrome(`return !!BrowsingContext.get(arg)?.isInBFCache;`, before))) {
        return;
      }
      missed.push({ swapped: after !== before, state, toplevels });
    }
    assert.fail(`the page never went to the bfcache: ${JSON.stringify(missed)}`);
  }));

// A page loaded while the user had the Space (or a tab the agent adopts)
// was created without the agent's guards: they arrive when the tab
// becomes the agent's.
test("a page loaded while the user had the Space gets the refusals when the agent takes it back", () =>
  env.inSpace("taken back", async page => {
    await page.goto(`${vectors.base}/plain`);
    await page.call("spaces.handOff", { reason: "manual_takeover" });
    await env.chrome(
      `const { browser } = ctx.resolvePage(arg.P);
       browser.fixupAndLoadURIString(arg.url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`,
      { P: page.P, url: `${vectors.base}/vectors` }
    );
    await until("the user's page", async () => (await env.chrome(`return ctx.resolvePage(arg).browser.currentURI.spec;`, page.P)).endsWith("/vectors"));
    await sleep(300);
    await page.call("spaces.takeOver");
    await page.call("page.events");
    await page.call("page.click", { target: "#v-wake-lock" });
    await sleep(300);
    assert.deepEqual(await results(page, "wake-lock"), ["NotAllowedError"]);
    assert.deepEqual((await refusedEvents(page)).map(e => e.kind), ["wakeLock"]);
    assert.equal((await sound(page)).zenius, true);
  }));

// A request that got past the page guards reaches the parent's actors:
// they drop it there, before the window or the pointer is touched.
test("the parent's backstops drop fullscreen and pointer lock from agent tabs", () =>
  env.inSpace("backstops", async page => {
    await page.goto(`${vectors.base}/vectors`);
    const before = await outside(page);
    await page.call("page.events");
    await env.chrome(
      `const { browser } = ctx.resolvePage(arg);
       const wg = browser.browsingContext.currentWindowGlobal;
       wg.getActor("DOMFullscreen").receiveMessage({ name: "DOMFullscreen:Request", data: {} });
       wg.getActor("PointerLock").receiveMessage({ name: "PointerLock:Entered", data: { originNoSuffix: "${vectors.base}" } });`,
      page.P
    );
    await sleep(200);
    assert.deepEqual(await outside(page), before);
    assert.deepEqual((await refusedEvents(page)).map(e => e.kind), ["fullscreen", "pointerLock"]);
  }));
