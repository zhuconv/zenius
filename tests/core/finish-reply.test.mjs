// The reply after a finish (modules/service.sys.mjs resumeFinishedTask,
// docs/SPI.md "The reply after a finish"): a reply in a finished task's
// Work chat hands the task back to its agent with the pages its finish kept
// that the user left alone. A page the user closed, moved out of the Agents
// Space, navigated, or clicked or typed in stays theirs and leaves the
// task. The agent sidebar calls it in process for a send in the chat; these
// tests call it the same way, with chat ids of their own.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
before(async () => {
  h = await setup();
});
after(() => h?.close());

/** Conversation ids in the form the sidebar gives them (ZENIUS_SIDEBAR_TASK). */
const CHAT = "5e1f0c3a-7b2d-4c19-9a8e-2f6d4b1c0a01";
const OTHER_CHAT = "5e1f0c3a-7b2d-4c19-9a8e-2f6d4b1c0a02";
const page = name => `${h.base}/zoo/${name}.html`;

/** A task a Work chat drives (none with chat null), with a page per URL: p1, p2, ... */
async function chatTask(prefix, urls, chat = CHAT) {
  const task = await h.call("spaces.create", { name: h.unique(prefix), source: { agent: "zen-core test", ...(chat ? { sidebar: chat } : {}) } });
  const labels = [];
  for (const [i, url] of urls.entries()) {
    const label = i === 0 ? (task.pages?.[0]?.label ?? "p1") : (await h.call("pages.new", { space: task.id })).label;
    await h.call("page.goto", { space: task.id, page: label, url });
    labels.push(label);
  }
  // Each page's <browser> id, read while it's still a page: the tests find its tab by it after the finish.
  const ids = await h.chrome(
    `const rec = ctx.spaces.get(arg.space);
     return arg.labels.map(l => ctx.pages.tabFor(ctx.pages.get(rec, l)).linkedBrowser.browserId);`,
    { space: task.id, labels }
  );
  return { id: task.id, labels, ids };
}

/**
 * In chrome code: the tab and <browser> whose browserId is arg.id, or null.
 * dev.evalChrome's sandbox has no ownerGlobal: a node's window is its
 * ownerDocument's defaultView.
 */
const TAB = `const top = BrowsingContext.getCurrentTopByBrowserId(arg.id);
  const browser = top?.embedderElement ?? null;
  const tab = browser?.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser?.(browser) ?? null;`;

const resume = (space, chat = CHAT) => h.chrome(`return await ctx.service.resumeFinishedTask(arg.space, { sidebar: arg.chat });`, { space, chat });
/** The kept pages once their baselines are taken, and why each can't come back. */
const kept = space => h.chrome(`return await ctx.service.keptPagesOf(arg);`, space);
const tabValue = id =>
  h.chrome(`${TAB} if (!tab) return "no tab"; const v = win.SessionStore.getCustomTabValue(tab, "zenius"); return v ? JSON.parse(v) : null;`, { id });
const keptIds = () => h.chrome(`return [...(Services.ppmm.sharedData.get("zenius:keptBrowserIds") ?? [])];`);
/**
 * The user starts the camera in a kept page, by backstops.test.mjs's
 * startStream (its comment says why): a fake device; no prompt for the
 * call, since a stored grant applies only when the doorhanger shows, which
 * it doesn't in a tab in the background; and media.navigator.permission.fake
 * while the stream lives, or MediaManager doesn't report the fake device as
 * capturing. The stream stays in the page as window.__zoStream.
 */
const startCamera = id =>
  h.chrome(
    `${TAB}
     Services.prefs.setBoolPref("media.navigator.streams.fake", true);
     Services.prefs.setBoolPref("media.navigator.permission.disabled", true);
     Services.prefs.setBoolPref("media.navigator.permission.fake", true);
     try {
       return await ctx.content(browser.browsingContext, "dev#evalContent", { privileged: true, code: \`
         const S = Components.utils.Sandbox(window, { sandboxPrototype: window, wantXrays: true, sameZoneAs: window, sandboxName: "zenius finish-reply test" });
         const stream = await Components.utils.evalInSandbox("navigator.mediaDevices.getUserMedia({ video: true })", S);
         window.wrappedJSObject.__zoStream = Components.utils.waiveXrays(stream);
         return stream.getTracks().map(t => t.readyState).join(" ");\` });
     } finally {
       Services.prefs.clearUserPref("media.navigator.permission.disabled");
     }`,
    { id }
  );
/** The kept stream's track ("live", "ended"), and whether WebRTC still lists a stream in the tab. */
const cameraState = id =>
  h.chrome(
    `${TAB}
     const { webrtcUI } = ChromeUtils.importESModule("resource:///modules/webrtcUI.sys.mjs");
     const tracks = await ctx.content(browser.browsingContext, "dev#evalContent", { privileged: true, code: "return window.wrappedJSObject.__zoStream?.getTracks().map(t => t.readyState).join(' ') ?? null;" });
     return { tracks, listed: webrtcUI.browserHasStreams(browser) };`,
    { id }
  );
const stopCamera = id =>
  h.chrome(
    `${TAB}
     try {
       if (browser) await ctx.content(browser.browsingContext, "dev#evalContent", { privileged: true, code: "window.wrappedJSObject.__zoStream?.getTracks().forEach(t => t.stop()); return true;" });
     } finally {
       Services.prefs.clearUserPref("media.navigator.permission.fake");
       Services.prefs.clearUserPref("media.navigator.streams.fake");
     }
     return true;`,
    { id }
  );
/** Mark each page's top document hooked, as the agent's world does when its code leaves something there. */
const markHooked = ids =>
  h.chrome(
    `const EV = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/evidence.sys.mjs");
     for (const id of arg) {
       const b = BrowsingContext.getCurrentTopByBrowserId(id)?.embedderElement;
       if (!b) throw new Error("no tab for " + id);
       EV.markEvident(b, "hooked", "a script element");
     }
     return true;`,
    ids
  );
/** A page's top document now: its id, its address, and its nickname field's value. */
const docOf = id =>
  h.chrome(
    `${TAB} const wg = browser.browsingContext.currentWindowGlobal;
     const nickname = await ctx.content(browser.browsingContext, "dev#evalContent", { privileged: false, code: "return document.querySelector('input[name=nickname]')?.value ?? null;" }).catch(() => null);
     return { doc: wg?.innerWindowId ?? null, url: wg?.documentURI?.spec ?? "", nickname };`,
    { id }
  );
/** The user's own load of `url` in a page, as from the address bar: no input event in the page. */
const userLoad = (id, url) =>
  h.chrome(`${TAB} browser.loadURI(Services.io.newURI(arg.url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); return true;`, { id, url });
/** Close the tabs a test left to the user: later files share this Zen. */
const closeTheirs = ids =>
  h.chrome(
    `for (const id of arg) {
       const b = BrowsingContext.getCurrentTopByBrowserId(id)?.embedderElement;
       const g = b?.ownerDocument?.defaultView?.gBrowser;
       const t = g?.getTabForBrowser?.(b);
       if (t) g.removeTab(t);
     }
     return true;`,
    ids
  );

test("a reply hands the task back with the kept pages the user left alone, under their labels", async () => {
  const urls = [page("forms"), page("aria")];
  const { id, labels, ids } = await chatTask("finish reply back", urls);
  try {
    await h.call("spaces.finish", { space: id, keep: labels });
    assert.equal(await h.ownership(id), "user");
    assert.deepEqual(await kept(id), [{ page: "p1", why: null }, { page: "p2", why: null }]);
    assert.deepEqual((await keptIds()).filter(k => ids.includes(k)).sort(), [...ids].sort(), "the typing sense watches them");
    assert.equal(await resume(id, OTHER_CHAT), null, "another chat's reply takes up nothing");
    const back = await resume(id);
    assert.equal(back.space, id);
    assert.deepEqual(back.notBack, []);
    assert.deepEqual(
      back.pages.map(p => [p.page, p.url, p.reloaded, p.stopped, p.cleared]),
      [["p1", urls[0], false, [], 0], ["p2", urls[1], false, [], 0]]
    );
    assert.equal(await h.ownership(id), "agent");
    assert.equal(await h.call("page.evaluate", { space: id, page: "p2", fn: "location.pathname", isFunction: false }), "/zoo/aria.html");
    assert.equal((await tabValue(ids[0])).label, "p1", "the tab is the task's page again, as a restart reads it");
    assert.deepEqual((await keptIds()).filter(k => ids.includes(k)), []);
    assert.equal(await resume(id), null, "once is all");
    assert.equal(await kept(id), null);
  } finally {
    await h.remove(id);
  }
});

test("a page the user navigated, closed, moved or clicked in stays theirs and leaves the task", async () => {
  const urls = [page("forms"), page("aria"), page("semantics"), page("long"), page("shadow")];
  const { id, labels, ids } = await chatTask("finish reply taken", urls);
  const theirs = await h.userSpace("finish reply theirs");
  try {
    await h.call("spaces.finish", { space: id, keep: labels });
    await kept(id);
    // p2: the user's own load, elsewhere.
    const elsewhere = `${page("bench")}?q=the-users-own`;
    await h.chrome(`${TAB} browser.loadURI(Services.io.newURI(arg.url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); return true;`, { id: ids[1], url: elsewhere });
    await h.until(() => h.chrome(`${TAB} return browser.currentURI.spec === arg.url && !browser.webProgress.isLoadingDocument;`, { id: ids[1], url: elsewhere }));
    // p3: closed.
    await h.chrome(`${TAB} tab.ownerDocument.defaultView.gBrowser.removeTab(tab); return true;`, { id: ids[2] });
    // p4: the user's click, as zen-ui's takeover listener notes it.
    assert.equal(await h.chrome(`${TAB} const rec = ctx.service.finishedTaskOf(tab); ctx.service.noteKeptInput(rec, browser, "clicked"); return rec?.id;`, { id: ids[3] }), id);
    // p5: into a Space of the user's.
    const uuid = await h.chrome(`return ctx.spaces.get(arg).uuid;`, theirs);
    await h.chrome(`${TAB} tab.ownerDocument.defaultView.gZenWorkspaces.moveTabToWorkspace(tab, arg.uuid); return true;`, { id: ids[4], uuid });
    assert.deepEqual(await kept(id), [
      { page: "p1", why: null },
      { page: "p2", why: "navigated" },
      { page: "p3", why: "closed" },
      { page: "p4", why: "clicked" },
      { page: "p5", why: "moved" },
    ]);
    const back = await resume(id);
    assert.deepEqual(back.pages.map(p => p.page), ["p1"]);
    // Each by the address it had at the finish: never where the user took it.
    assert.deepEqual(back.notBack, [
      { page: "p2", url: urls[1], why: "navigated" },
      { page: "p3", url: urls[2], why: "closed" },
      { page: "p4", url: urls[3], why: "clicked" },
      { page: "p5", url: urls[4], why: "moved" },
    ]);
    // They left the task: no session value, not its tabs, and a call naming one hears it was released.
    for (const i of [1, 3, 4]) {
      assert.equal(await tabValue(ids[i]), null, `${labels[i]}'s tab is the user's`);
    }
    assert.deepEqual((await h.call("pages.list", { space: id })).map(p => p.label), ["p1"]);
    assert.equal((await h.call("tabs.list", { space: id })).length, 1);
    await assert.rejects(h.call("page.evaluate", { space: id, page: "p2", fn: "1", isFunction: false }), e => e.code === "ZEN_PAGE_NOT_FOUND" && /was released/.test(e.message));
    // A new page gets a label of its own.
    assert.equal((await h.call("pages.new", { space: id })).label, "p6");
  } finally {
    await closeTheirs([ids[1], ids[3]]);
    await h.remove(id);
  }
});

test("with no kept page left to hand back, the task stays the user's, and the agent hears why", async () => {
  const urls = [page("forms")];
  const { id, labels, ids } = await chatTask("finish reply none", urls);
  try {
    await h.call("spaces.finish", { space: id, keep: labels });
    await kept(id);
    await h.chrome(`${TAB} ctx.service.noteKeptInput(ctx.service.finishedTaskOf(tab), browser, "typed"); return true;`, { id: ids[0] });
    const back = await resume(id);
    assert.deepEqual(back.pages, []);
    assert.deepEqual(back.notBack, [{ page: "p1", url: urls[0], why: "typed" }]);
    assert.equal(await h.ownership(id), "user");
    assert.equal(await resume(id), null);
  } finally {
    await closeTheirs(ids);
    await h.remove(id);
  }
});

test("nothing to take up: a task with no Work chat, one still running, one the user stopped, an unknown id", async () => {
  const urls = [page("forms")];
  const none = await chatTask("finish reply no chat", urls, null);
  const running = await chatTask("finish reply running", urls);
  try {
    await h.call("spaces.finish", { space: none.id, keep: none.labels });
    assert.equal(await kept(none.id), null, "no kept pages to watch without a Work chat");
    assert.equal(await resume(none.id), null);
    assert.equal(await resume(running.id), null);
    await h.chrome(`ctx.spaces.setOwnership(ctx.spaces.get(arg), "user", { source: "user" }); return true;`, running.id);
    assert.equal(await resume(running.id), null, "a Stop isn't a finish");
    assert.equal(await resume(987654), null);
  } finally {
    await closeTheirs(none.ids);
    await h.remove(none.id);
    await closeTheirs(running.ids);
    await h.remove(running.id);
  }
});

test("a secret field the page filled after the finish is empty before the agent has the page again", async () => {
  const urls = [page("forms")];
  const { id, labels, ids } = await chatTask("finish reply secret", urls);
  try {
    await h.call("spaces.finish", { space: id, keep: labels });
    // The baselines, the secret fields' snapshot among them.
    await kept(id);
    // The page's own script: no input event, so the typing sense hears nothing.
    await h.chrome(
      `${TAB} return await ctx.service.content(browser.browsingContext, "dev#evalContent", { code: "document.querySelector('input[type=password]').value = 'set-by-the-page'; return true;", privileged: false });`,
      { id: ids[0] }
    );
    const back = await resume(id);
    assert.deepEqual(back.pages.map(p => [p.page, p.reloaded, p.cleared]), [["p1", false, 1]]);
    assert.equal(await h.call("page.evaluate", { space: id, page: "p1", fn: "document.querySelector('input[type=password]').value", isFunction: false }), "");
  } finally {
    await h.remove(id);
  }
});

test("the user's input in a kept page keeps it theirs: the typing sense hears it", async () => {
  const urls = [page("forms")];
  const { id, labels, ids } = await chatTask("finish reply typed", urls);
  try {
    await h.call("spaces.finish", { space: id, keep: labels });
    await kept(id);
    // A fill, as Firefox's autofill makes one: setUserInput's input events
    // are trusted, as the user's typing's are (an event a page's own Event
    // constructor makes never is, whoever calls it). Again until the sense
    // is armed in the page's process: a document is reported once.
    await h.until(async () => {
      await h.chrome(
        `${TAB} return await ctx.service.content(browser.browsingContext, "dev#evalContent", { code: "document.querySelector('input[name=nickname]').setUserInput('a fill ' + Date.now()); return true;", privileged: true });`,
        { id: ids[0] }
      );
      return (await kept(id))?.[0]?.why === "typed";
    }, 10000);
    const back = await resume(id);
    assert.deepEqual(back.notBack, [{ page: "p1", url: urls[0], why: "typed" }]);
  } finally {
    await closeTheirs(ids);
    await h.remove(id);
  }
});

test("the finish's clean copy of a hooked kept page carries the agent's field over, and that's no input of the user's", async () => {
  const { id, labels, ids } = await chatTask("finish reply carried", [page("forms")]);
  try {
    // A field the agent filled, and what its code left hooked in the page:
    // the finish loads the page afresh, its form carried over.
    await h.call("page.evaluate", { space: id, page: "p1", fn: "document.querySelector('input[name=nickname]').value = 'the agent typed this'", isFunction: false });
    await markHooked(ids);
    const before = await docOf(ids[0]);
    await h.call("spaces.finish", { space: id, keep: labels });
    assert.deepEqual(await kept(id), [{ page: "p1", why: null }], "the carry-over is zenius's input, not the user's");
    const after = await docOf(ids[0]);
    assert.notEqual(after.doc, before.doc, "the finish loaded it afresh");
    assert.equal(after.nickname, "the agent typed this", "its field came over");
    const back = await resume(id);
    assert.deepEqual([back.pages.map(p => p.page), back.notBack], [["p1"], []]);
  } finally {
    await h.remove(id);
  }
});

test("the reply's own clean copy carries a field over, and that's no input of the user's: the page comes back loaded afresh", async () => {
  const { id, labels, ids } = await chatTask("finish reply reloads", [page("forms")]);
  try {
    await h.call("spaces.finish", { space: id, keep: labels });
    await kept(id);
    // The page's own script, which the typing sense never hears: a field
    // the carry-over takes along, and a secret field that changed. With
    // evidence a clean copy clears, as a page keeps it when its load at the
    // finish fails, the reply loads the page afresh first.
    await h.chrome(
      `${TAB} return await ctx.service.content(browser.browsingContext, "dev#evalContent", { code: "document.querySelector('input[name=nickname]').value = 'carried'; document.querySelector('input[type=password]').value = 'set-by-the-page'; return true;", privileged: false });`,
      { id: ids[0] }
    );
    await markHooked(ids);
    const before = await docOf(ids[0]);
    const back = await resume(id);
    assert.deepEqual(back.notBack, [], "the carry-over is zenius's input, not the user's");
    assert.deepEqual(back.pages.map(p => [p.page, p.reloaded]), [["p1", true]]);
    const after = await docOf(ids[0]);
    assert.notEqual(after.doc, before.doc);
    assert.equal(after.nickname, "carried");
    assert.equal(await h.call("page.evaluate", { space: id, page: "p1", fn: "document.querySelector('input[type=password]').value", isFunction: false }), "");
  } finally {
    await closeTheirs(ids);
    await h.remove(id);
  }
});

test("a page the user loads while another kept page's clean copy still runs stays theirs, and the agent hears only its address at the finish", async () => {
  // p2 answers 4 s late, so its clean copy at the finish does too.
  const urls = [page("forms"), `${h.base}/api/slow?ms=4000`];
  const { id, labels, ids } = await chatTask("finish reply slow copy", urls);
  try {
    await markHooked(ids);
    const before = await docOf(ids[0]);
    await h.call("spaces.finish", { space: id, keep: labels });
    // p1's own clean copy is done well before p2's, and the user then loads another page in it.
    await h.until(async () => (await docOf(ids[0])).doc !== before.doc, 5000);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await userLoad(ids[0], page("aria"));
    await h.until(async () => (await docOf(ids[0])).url.endsWith("/zoo/aria.html"), 5000);
    assert.deepEqual(await kept(id), [{ page: "p1", why: "navigated" }, { page: "p2", why: null }]);
    const back = await resume(id);
    assert.deepEqual(back.notBack, [{ page: "p1", url: urls[0], why: "navigated" }], "the address at the finish, never the user's own");
    assert.deepEqual(back.pages.map(p => p.page), ["p2"]);
  } finally {
    await closeTheirs(ids);
    await h.remove(id);
  }
});

test("a camera the user started in a kept page after the finish stops as the page comes back, and the reply names it", async () => {
  const { id, labels, ids } = await chatTask("finish reply camera", [page("forms")]);
  try {
    await h.call("spaces.finish", { space: id, keep: labels });
    assert.deepEqual(await kept(id), [{ page: "p1", why: null }]);
    assert.equal(await startCamera(ids[0]), "live");
    assert.deepEqual(await cameraState(ids[0]), { tracks: "live", listed: true }, "the user's page has the camera");
    assert.deepEqual(await kept(id), [{ page: "p1", why: null }], "a stream isn't a touch of the page");
    const back = await resume(id);
    assert.deepEqual(back.pages.map(p => [p.page, p.stopped]), [["p1", ["camera"]]]);
    // The track ends in content, and webrtcUI drops the stream when content
    // reports it: wait for both, as backstops.test.mjs does.
    const end = Date.now() + 5000;
    let now;
    while (!((now = await cameraState(ids[0])).tracks === "ended" && !now.listed) && Date.now() < end) {
      await new Promise(r => setTimeout(r, 50));
    }
    assert.deepEqual(now, { tracks: "ended", listed: false }, "the stream stopped");
  } finally {
    await stopCamera(ids[0]).catch(() => {});
    await h.remove(id);
  }
});
