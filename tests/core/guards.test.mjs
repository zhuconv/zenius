// The page guards go into every page of an agent task, before the page's
// scripts (DOMWindowCreated), and check per call whether the agent drives the
// tab. A tab that becomes a task's page has documents from before, which get
// them on the parent's request (ZeniusService.installGuards): an adopted tab,
// a task claimed again after the user's Stop, a new page's first document.
// Before this, such a document ran without guards until its next navigation
// (found during I4). Nor does a document that
// Back brings from the tab's back-forward cache, so a tab's bfcache is
// emptied when it joins a task, and when it leaves one.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { setup, sleep } from "./lib.mjs";

let h;
before(async () => {
  h = await setup();
});
after(() => h?.close());

// Pages Gecko keeps in the back-forward cache, which never keeps the suite
// fixture's (no-store). Each lists its pageshows: persisted is true when
// the page came back from the bfcache.
const BF_PAGE = `<!doctype html><meta charset=utf-8><title>bf</title><p>A page.</p>
<script>window.__shows = []; addEventListener("pageshow", e => __shows.push(e.persisted));</script>`;
let bfServer;
before(async () => {
  bfServer = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(BF_PAGE);
  });
  await new Promise(resolve => bfServer.listen(0, "127.0.0.1", resolve));
});
after(() => {
  bfServer?.closeAllConnections();
  bfServer?.close();
});
const bf = name => `http://127.0.0.1:${bfServer.address().port}/bf?${name}`;

const url = path => `${h.base}${path}`;
const TAB = "const t = ctx.pages.findTab(ctx.spaces.get(arg.space), arg.tab);";

/** Whether each document of the tab has the page guards, the top one first. */
const guarded = (space, tab) =>
  h.chrome(
    `${TAB}
     return Promise.all(
       t.linkedBrowser.browsingContext.getAllBrowsingContextsInSubtree().map(bc => ctx.content(bc, "guards#installed", {}))
     );`,
    { space, tab }
  );

/** Run code as the tab's own page, as the user's tab would. */
const asPage = (space, tab, code) =>
  h.chrome(
    `${TAB}
     return ctx.content(t.linkedBrowser.browsingContext, "dev#evalContent", { code: arg.code, privileged: false });`,
    { space, tab, code }
  );

const topURL = (space, tab) =>
  h.chrome(`${TAB} return t.linkedBrowser.browsingContext.currentWindowGlobal?.documentURI?.spec ?? "";`, {
    space,
    tab,
  });

/** Wait until the tab shows the page at this path, fully loaded. */
async function loaded(space, tab, path) {
  await h.until(
    async () =>
      (await topURL(space, tab)).endsWith(path) && (await asPage(space, tab, "return document.readyState")) === "complete"
  );
}

const spaceClipboard = space =>
  h.chrome(
    `const { SpaceClipboard } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/clipboard/store.sys.mjs");
     return SpaceClipboard.read(arg) ?? null;`,
    space
  );

test("an adopted tab's documents get the guards, its frames' too", async () => {
  const space = await h.userSpace("guards adopt", url("/api/text"));
  await h.claim(space);
  const [{ tab }] = await h.call("tabs.list", { space });
  await loaded(space, tab, "/api/text");
  // The user's page has a cross-site frame, which runs in its own process.
  const crossSite = h.base.replace("127.0.0.1", "localhost");
  await asPage(
    space,
    tab,
    `document.body.innerHTML = ${JSON.stringify(`<iframe src="${crossSite}/api/text?frame=1"></iframe>`)}; true`
  );
  await h.until(() =>
    h.chrome(
      `${TAB}
       const top = t.linkedBrowser.browsingContext;
       const frame = top.children[0]?.currentWindowGlobal;
       return !!frame?.documentURI?.spec.includes("frame=1") && frame.osPid !== top.currentWindowGlobal.osPid;`,
      { space, tab }
    )
  );
  assert.deepEqual(await guarded(space, tab), [false, false], "the user's documents have no guards");

  await h.call("pages.adopt", { space, tab, as: "home" });
  assert.deepEqual(await guarded(space, tab), [true, true], "adopt returns once its documents are guarded");

  // The clipboard guard (the UI's actor) went into the same document: the
  // page's own clipboard call, from the agent's click, fills the Space's
  // clipboard instead of the system one.
  await asPage(
    space,
    tab,
    `document.body.innerHTML = '<button id="copy" style="display:block;height:30px" onclick="navigator.clipboard.writeText(\\'ADOPTED\\')">copy</button>'; true`
  );
  await h.call("page.click", { space, page: "home", target: "#copy" });
  await h.until(async () => (await spaceClipboard(space))?.["text/plain"] === "ADOPTED");
  await h.remove(space);
});

test("a page the user loads during a takeover has the guards when they hand back", async () => {
  const space = await h.space("guards hand back");
  await h.call("page.goto", { space, page: "p1", url: url("/api/text") });
  const { tab } = (await h.call("pages.list", { space })).find(p => p.label === "p1");
  await h.userTakesOver(space);
  await asPage(space, tab, `location.href = ${JSON.stringify(url("/api/text?user=1"))}; true`);
  await loaded(space, tab, "/api/text?user=1");
  // In place while the user holds the task, but they check per call, so the
  // user's page behaves natively until the hand back.
  await h.until(async () => (await guarded(space, tab))[0] === true);
  await h.chrome(`ctx.spaces.setOwnership(ctx.spaces.get(arg), "agent", { source: "user" })`, space);

  // The agent's click: a popup with size features becomes a tab, not a window.
  const windows = () => h.chrome(`return [...Services.wm.getEnumerator("navigator:browser")].length`);
  const before = await windows();
  await asPage(
    space,
    tab,
    `document.body.innerHTML = ${JSON.stringify(
      `<button id="go" style="display:block;height:30px" onclick="window.open('/api/text?via=features', 'x', 'width=400,height=300')">go</button>`
    )}; true`
  );
  await h.agentClick(space, "p1", "#go");
  await h.until(async () => (await h.call("pages.list", { space })).some(p => p.label === "p2"));
  assert.equal(await windows(), before, "no new window");
  await h.call("spaces.finish", { space, keep: [] });
});

test("a page the user loads after a Stop gets the guards when the agent claims the task", async () => {
  const space = await h.space("guards claim");
  await h.call("page.goto", { space, page: "p1", url: url("/api/text") });
  const { tab } = (await h.call("pages.list", { space })).find(p => p.label === "p1");
  // The panel's Stop: the task ends, and its labels stay for a later claim.
  await h.chrome(`ctx.spaces.setOwnership(ctx.spaces.get(arg), "user", { source: "user" })`, space);
  await asPage(space, tab, `location.href = ${JSON.stringify(url("/api/text?user=1"))}; true`);
  await loaded(space, tab, "/api/text?user=1");
  await h.until(async () => (await guarded(space, tab)).length === 1);
  assert.deepEqual(await guarded(space, tab), [false], "the user's page, after the Stop, has none");

  await h.claim(space);
  await h.until(async () => (await guarded(space, tab))[0] === true);
  await h.remove(space);
});

/**
 * Whether the tab's history entry for this URL keeps its document in the
 * bfcache, where Back would restore it from. Its browsing context reports
 * isInBFCache until Gecko has torn it down; the entry knows at once.
 */
const cached = (browserId, url) =>
  h.chrome(
    `const sh = BrowsingContext.getCurrentTopByBrowserId(arg.browserId).sessionHistory;
     for (let i = 0; i < sh.count; i++) {
       const entry = sh.getEntryAtIndex(i);
       if (entry.URI.spec === arg.url && entry.isInBFCache) return true;
     }
     return false;`,
    { browserId, url }
  );
/** A page's tab's browserId. */
const browserIdOf = (space, page) =>
  h.chrome(`return ctx.resolvePage(arg).tab.linkedBrowser.browserId;`, { space, page });
/** The tab with this browserId, page or not: what it shows, its pageshows, and its guards. */
const tabState = browserId =>
  h.chrome(
    `const top = BrowsingContext.getCurrentTopByBrowserId(arg);
     const wg = top?.currentWindowGlobal;
     if (!wg || wg.isClosed || wg.isInitialDocument) return null;
     const page = code => ctx.content(top, "dev#evalContent", { code, privileged: false });
     return {
       url: wg.documentURI?.spec ?? "",
       loaded: await page('return performance.getEntriesByType("navigation")[0]?.loadEventEnd > 0'),
       shows: JSON.parse(await page("return JSON.stringify(window.__shows ?? null)")),
       guarded: await ctx.content(top, "guards#installed", {}),
     };`,
    browserId
  );
/**
 * Wait until the tab with this browserId shows this URL, its load event
 * over; returns its state. Gecko doesn't cache a page left while its load
 * group still holds a request: right after the load event, and its news
 * reaches the parent a moment later (MOZ_LOG=SHIPBFCache:5, "requests in
 * the loadgroup").
 */
async function showing(browserId, url) {
  let state = null;
  await h.until(async () => {
    state = await tabState(browserId).catch(() => null);
    return state?.url === url && state.loaded;
  }, 10000);
  await sleep(250);
  return state;
}
/** Load a URL in the tab with this browserId as the user's own load. */
const userLoads = (browserId, url) =>
  h.chrome(
    `BrowsingContext.getCurrentTopByBrowserId(arg.browserId).embedderElement.loadURI(Services.io.newURI(arg.url), {
       triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
     });
     return true;`,
    { browserId, url }
  );
/**
 * Load `<a>-<n>`, then `<b>-<n>`, in the tab through `load`, until the
 * first waits in the tab's bfcache; returns the two URLs. Gecko doesn't
 * cache a page left while the parent still counts a request in its load
 * group (MOZ_LOG=SHIPBFCache:5, "requests in the loadgroup"): right after
 * its load event, and for longer on a loaded machine. Waiting after the
 * leave can't help, so each try waits longer before it. Without a cached
 * page these tests would pass with or without the eviction.
 */
async function cachedPair(browserId, load, a, b) {
  for (let n = 1, settle = 250; n <= 4; n++, settle *= 2) {
    const first = bf(`${a}-${n}`);
    const second = bf(`${b}-${n}`);
    await load(first);
    await showing(browserId, first);
    await sleep(settle);
    await load(second);
    await showing(browserId, second);
    if (await h.until(() => cached(browserId, first), 2000).then(() => true, () => false)) {
      return { first, second };
    }
  }
  throw new Error("Gecko cached none of four pages in the tab");
}
/** The agent's history.back() or history.forward() in its page. */
const agentGoes = (space, page, where) =>
  h.call("page.evaluate", { space, page, fn: `() => { history.${where}(); return true; }`, isFunction: true });
/** The page's own Cache write, as a site would make it: "stored", or the error's name. */
const cacheWrite = (space, page) =>
  h.call("page.evaluate", {
    space,
    page,
    fn: `async () => {
      try {
        await (await caches.open("zenius-bf")).put("/zenius-bf", new Response("x"));
        return "stored";
      } catch (e) {
        return e.name;
      }
    }`,
    isFunction: true,
  });
/** Close the tab with this browserId, as the user does. */
const closeTab = browserId =>
  h.chrome(
    `const b = BrowsingContext.getCurrentTopByBrowserId(arg).embedderElement;
     const g = b.ownerDocument.defaultView.gBrowser;
     g.removeTab(g.getTabForBrowser(b), { animate: false });
     return true;`,
    browserId
  );
/** A user's Space whose tab went from one page to another: the first waits in its bfcache. */
async function userTabWithHistory(prefix) {
  const space = await h.userSpace(prefix, bf("start"));
  const browserId = await h.chrome(
    `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     return W.tabsInWorkspace(ctx.spaces.get(arg).uuid)[0].linkedBrowser.browserId;`,
    space
  );
  // userSpace returns once the URL shows, before the load ends.
  await showing(browserId, bf("start"));
  const pages = await cachedPair(browserId, url => userLoads(browserId, url), "first", "second");
  return { space, browserId, ...pages };
}
/** A task page that went from one page to another, both the agent's loads: the first waits in its bfcache. */
async function agentPageWithHistory(space, page) {
  const browserId = await browserIdOf(space, page);
  return { browserId, ...(await cachedPair(browserId, url => h.call("page.goto", { space, page, url }), "a", "b")) };
}

test("a tab that joins a task leaves its back-forward cache behind: Back loads the page afresh, guarded", async () => {
  const { space, browserId, first } = await userTabWithHistory("bf join");
  await h.claim(space);
  const [{ tab }] = await h.call("tabs.list", { space });
  await h.call("pages.adopt", { space, tab, as: "home" });
  assert.equal(await cached(browserId, first), false, "adopt emptied the tab's bfcache");

  // The agent goes back at once: the first page loads afresh, and gets the
  // guards at DOMWindowCreated like any page of the task.
  await agentGoes(space, "home", "back");
  const back = await showing(browserId, first);
  assert.deepEqual(back.shows, [false], "a fresh load, not one from the bfcache");
  assert.equal(back.guarded, true);
  assert.equal(await cacheWrite(space, "home"), "SecurityError", "the page's Cache write is refused");
  await h.remove(space);
});

test("within a task, Back comes from the back-forward cache as usual, guarded", async () => {
  const space = await h.space("bf within");
  const { browserId, first } = await agentPageWithHistory(space, "p1");
  // Those documents got the guards when they were made.
  await agentGoes(space, "p1", "back");
  const back = await showing(browserId, first);
  assert.deepEqual(back.shows, [false, true], "restored from the bfcache");
  assert.equal(back.guarded, true);
  await h.call("spaces.finish", { space, keep: [] });
});

test("a task's tab leaves its back-forward cache behind at the finish: the user's Back loads afresh", async () => {
  const space = await h.space("bf finish");
  const { browserId, first } = await agentPageWithHistory(space, "p1");
  // The user keeps the page. The documents it had in the task don't come
  // back into the user's session: Back loads the page afresh, as theirs.
  await h.call("spaces.finish", { space, keep: ["p1"] });
  assert.equal(await cached(browserId, first), false, "the finish emptied the kept tab's bfcache");
  await h.chrome(`BrowsingContext.getCurrentTopByBrowserId(arg).embedderElement.goBack(false); return true;`, browserId);
  const back = await showing(browserId, first);
  assert.deepEqual(back.shows, [false], "a fresh load, not one from the bfcache");
  assert.equal(back.guarded, false, "the user's page now");
  await closeTab(browserId);
  await h.chrome(`ctx.spaces.maybeRemoveAgentsSpace(); return true;`);
});

test("a tab that leaves a task by release or by the user's Stop leaves its back-forward cache behind", async () => {
  // Release: a page of the user's own tab, which the agent then browsed in.
  const user = await userTabWithHistory("bf release");
  await h.claim(user.space);
  const [{ tab }] = await h.call("tabs.list", { space: user.space });
  await h.call("pages.adopt", { space: user.space, tab, as: "home" });
  const browsed = await agentPageWithHistory(user.space, "home");
  await h.call("pages.release", { space: user.space, page: "home" });
  assert.equal(await cached(user.browserId, browsed.first), false, "release emptied the tab's bfcache");
  await h.remove(user.space);

  // The panel's Stop: the task ends, and its tabs stay.
  const space = await h.space("bf stop");
  const { browserId, first } = await agentPageWithHistory(space, "p1");
  await h.chrome(`ctx.spaces.setOwnership(ctx.spaces.get(arg), "user", { source: "user" }); return true;`, space);
  assert.equal(await cached(browserId, first), false, "the Stop emptied the tab's bfcache");
  await h.remove(space);
});

test("a new page's first document has the guards", async () => {
  const space = await h.space("guards new page");
  const { label } = await h.call("pages.new", { space });
  const { tab } = (await h.call("pages.list", { space })).find(p => p.label === label);
  await h.until(async () => (await guarded(space, tab))[0] === true);
  await h.call("spaces.finish", { space, keep: [] });
});
